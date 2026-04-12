/**
 * TileOverlayManager - Tile overlay system
 *
 * Uses programId trigger with custom model matrix:
 * - Triggers when any floor program draws
 * - Copies uViewProjMatrix from program (camera)
 * - Uses custom uModelMatrix from uniformBuffer (world position)
 * - Mesh in absolute world coordinates
 */

import * as patchrs from "../util/patchrs_napi";
import { captureWithStreamPause } from "../util/SharedRenderStream";
import {
    CHUNK_SIZE,
    TILE_SIZE,
    HEIGHT_SCALING,
    fetchHeightData,
    getHeightAtTile
} from "./heightData";
import {
    GL_FLOAT,
    GL_UNSIGNED_BYTE,
    UniformSnapshotBuilder,
    positionMatrix
} from "./index";
import { FreeTypeRenderer } from "../../QuestStepOverlay/FreeTypeRenderer";

// Fragment shader with flat normals (from tilemarkers.ts)
const fragshader = `
    #version 330 core
    in vec3 FragPos;
    in vec4 ourColor;
    uniform mat4 uSunlightViewMatrix;
    uniform vec3 uSunColour;
    uniform vec3 uAmbientColour;
    out vec4 FragColor;
    void main() {
        vec3 dx = dFdx(FragPos);
        vec3 dy = dFdy(FragPos);
        vec3 norm = normalize(cross(dx, dy));
        norm.z = -norm.z;
        vec3 lightDir = normalize(-uSunlightViewMatrix[2].xyz);
        float diff = max(dot(norm, lightDir), 0.0);
        vec3 diffuse = diff * uSunColour;
        vec3 lighting = diffuse + uAmbientColour;
        vec3 finalColor = ourColor.rgb * lighting;
        FragColor = vec4(finalColor * 0.5, ourColor.a);
    }`;

const vertshader = `
    #version 330 core
    layout (location = 0) in vec3 aPos;
    layout (location = 6) in vec3 aColor;
    uniform highp mat4 uModelMatrix;
    uniform highp mat4 uViewProjMatrix;
    uniform highp vec2 uMouse;
    out vec4 ourColor;
    out vec3 FragPos;
    void main() {
        vec4 worldpos = uModelMatrix * vec4(aPos, 1.);
        gl_Position = uViewProjMatrix * worldpos;
        FragPos = worldpos.xyz / worldpos.w;
        ourColor = vec4(aColor, 1.0);
    }`;

// ============================================================================
// Barrier Vertex Shader - Vertical wave wall effect like RS3 barriers
// ============================================================================
// Water Path Vertex Shader - Animated waves for water surface effect
// aColor.rgba encodes: RGB = base color, A = progress (0=start, 1=end)
// Creates gentle wave displacement for flowing water appearance
// ============================================================================
// ============================================================================
// Tube Path Vertex Shader - Simple, clean geometry with no displacement
// ============================================================================
const pathVertShader = `
    #version 330 core
    layout (location = 0) in vec3 aPos;
    layout (location = 6) in vec4 aColor;  // RGBA where A = progress (0-255)
    uniform highp mat4 uModelMatrix;
    uniform highp mat4 uViewProjMatrix;
    uniform highp float uTime;
    out vec4 ourColor;
    out vec3 FragPos;
    out vec3 vNormal;
    out float vProgress;  // 0 = start of path, 1 = end/destination
    out vec2 vWorldXZ;

    void main() {
        vProgress = aColor.a / 255.0;  // Decode from byte
        vec4 worldpos = uModelMatrix * vec4(aPos, 1.0);

        // No displacement - keep tube shape intact
        gl_Position = uViewProjMatrix * worldpos;
        FragPos = worldpos.xyz;
        vWorldXZ = worldpos.xz;
        ourColor = aColor;

        // Approximate normal from position (radial from tube center)
        // This works because tube vertices are offset from center
        vNormal = normalize(vec3(aPos.x, aPos.y, aPos.z));
    }`;

// ============================================================================
// Tube Path Fragment Shader - Clean glowing tube with gradient
// Cyan at start -> Gold at destination, with subtle glow and flow animation
// ============================================================================
const pathFragShader = `
    #version 330 core
    in vec3 FragPos;
    in vec4 ourColor;
    in vec3 vNormal;
    in float vProgress;
    in vec2 vWorldXZ;
    uniform mat4 uSunlightViewMatrix;
    uniform vec3 uSunColour;
    uniform vec3 uAmbientColour;
    uniform float uTime;
    out vec4 FragColor;

    void main() {
        // Gradient colors: Cyan at start (player) -> Gold at destination
        vec3 startColor = vec3(0.0, 0.9, 1.0);   // Bright cyan
        vec3 endColor = vec3(1.0, 0.85, 0.2);    // Gold/yellow

        // Interpolate color based on progress
        vec3 baseColor = mix(startColor, endColor, vProgress);

        // Simple directional lighting
        vec3 lightDir = normalize(vec3(0.3, 1.0, 0.5));  // Sun direction
        vec3 normal = normalize(vNormal);

        // Ambient + Diffuse lighting
        float ambient = 0.4;
        float diffuse = max(dot(normal, lightDir), 0.0) * 0.6;
        float lighting = ambient + diffuse;

        // Apply lighting to base color
        vec3 litColor = baseColor * lighting;

        // Add flowing glow effect along the path
        // Creates animated "pulses" traveling toward the destination
        float flowSpeed = 3.0;
        float flowFreq = 0.015;
        float flowPhase = (vWorldXZ.x + vWorldXZ.y) * flowFreq - uTime * flowSpeed;
        float flowPulse = sin(flowPhase) * 0.5 + 0.5;
        flowPulse = pow(flowPulse, 3.0);  // Sharpen the pulse

        // Glow intensity - brighter pulses
        float glowIntensity = 0.3 + flowPulse * 0.4;
        litColor += baseColor * glowIntensity;

        // Edge glow for tube (rim lighting effect)
        vec3 viewDir = normalize(-FragPos);
        float rimFactor = 1.0 - max(dot(normal, viewDir), 0.0);
        rimFactor = pow(rimFactor, 2.0);
        litColor += baseColor * rimFactor * 0.3;

        // Subtle pulsing brightness
        float pulse = 0.95 + 0.05 * sin(uTime * 2.0 + vProgress * 6.28);
        litColor *= pulse;

        // Semi-transparent tube
        float alpha = 0.85;

        FragColor = vec4(litColor, alpha);
    }`;

// Alternative: Textured path shader (for when we add texture support)
const pathFragShaderTextured = `
    #version 330 core
    in vec3 FragPos;
    in vec4 ourColor;
    in float vProgress;
    in vec2 vWorldXZ;
    uniform mat4 uSunlightViewMatrix;
    uniform vec3 uSunColour;
    uniform vec3 uAmbientColour;
    uniform float uTime;
    uniform sampler2D uPathTexture;  // Arrow/chevron texture
    out vec4 FragColor;

    void main() {
        // Generate UV from world position
        vec2 uv = vWorldXZ * 0.01;  // Scale
        uv.x -= uTime * 0.5;  // Scroll animation

        // Sample texture
        vec4 texColor = texture(uPathTexture, uv);

        // Gradient tint
        vec3 startColor = vec3(0.0, 1.0, 1.0);
        vec3 endColor = vec3(1.0, 0.8, 0.0);
        vec3 tint = mix(startColor, endColor, vProgress);

        vec3 finalColor = texColor.rgb * tint;
        float alpha = texColor.a * 0.9;

        FragColor = vec4(finalColor, alpha);
    }`;

// Mask for filtering non-floor programs
const wrongProgramMask = 1 << 5;

// Deduplicate "chunk not found" warnings — only log once per chunk per session
const _objectTileWarnedChunks = new Set<string>();

// ============================================================================
// Text Label Vertex Shader - Billboard effect (always faces camera)
// Rotates text around Y axis to face the camera
// ============================================================================

// Billboard text vertex shader — positions a textured quad in world space, Y-axis billboard
const textVertShader = `
    #version 330 core
    layout (location = 0) in vec2 aPos;   // quad corner (-0.5 to 0.5)
    layout (location = 1) in vec2 aUV;
    uniform highp mat4 uModelMatrix;
    uniform highp mat4 uViewProjMatrix;
    uniform highp vec3 uTextCenter;   // center in local coords
    uniform highp vec2 uTextSize;     // width, height in world units
    out vec2 vUV;

    void main() {
        vec4 worldCenter = uModelMatrix * vec4(uTextCenter, 1.0);

        // Y-axis billboard: derive camera right/up from ViewProj
        vec3 camForward = normalize(vec3(
            uViewProjMatrix[0][2], uViewProjMatrix[1][2], uViewProjMatrix[2][2]));
        vec3 camUp = vec3(0.0, 1.0, 0.0);
        vec3 flatForward = normalize(vec3(camForward.x, 0.0, camForward.z));
        vec3 camRight = cross(camUp, flatForward);

        // Scale quad to world size, billboard-rotate
        vec3 offset = camRight * aPos.x * uTextSize.x
                    + camUp    * aPos.y * uTextSize.y;
        vec3 finalPos = worldCenter.xyz + offset;

        gl_Position = uViewProjMatrix * vec4(finalPos, 1.0);
        vUV = aUV;
    }`;

// Billboard text fragment shader — textured with alpha
const textFragShader = `
    #version 330 core
    in vec2 vUV;
    out vec4 FragColor;
    uniform sampler2D uTexture;
    void main() {
        vec4 t = texture(uTexture, vUV);
        if (t.a < 0.01) discard;
        FragColor = t;
    }`;

// ============================================================================
// Text Label Geometry - Block letters rendered as 3D geometry
// Each character is made of horizontal/vertical bars (7-segment style)
// Text is oriented to face SOUTH (readable when looking from south to north)
// ============================================================================

/**
 * Render a text label to a canvas (FreeType when available, Canvas2D fallback).
 * Returns ImageData for texture creation and pixel dimensions.
 */
function renderLabelToCanvas(
    text: string,
    color: [number, number, number]
): { imageData: ImageData; width: number; height: number } {
    const ft = FreeTypeRenderer.getInstance();
    const fontSize = 28;
    const padding = 8;
    const borderRadius = 6;
    const fontFamily = "'Segoe UI', Arial, sans-serif";

    // Measure text width
    const measureCanvas = document.createElement("canvas");
    const measureCtx = measureCanvas.getContext("2d")!;
    let textWidth: number;
    if (ft.isReady) {
        textWidth = ft.measureTextBold(text, fontSize);
    } else {
        measureCtx.font = `bold ${fontSize}px ${fontFamily}`;
        textWidth = measureCtx.measureText(text).width;
    }

    const canvasWidth = Math.ceil(textWidth + padding * 2);
    const canvasHeight = Math.ceil(fontSize * 1.3 + padding * 2);

    const canvas = document.createElement("canvas");
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    const ctx = canvas.getContext("2d", { alpha: true })!;

    // Dark semi-transparent rounded background
    ctx.beginPath();
    ctx.moveTo(borderRadius, 0);
    ctx.lineTo(canvasWidth - borderRadius, 0);
    ctx.quadraticCurveTo(canvasWidth, 0, canvasWidth, borderRadius);
    ctx.lineTo(canvasWidth, canvasHeight - borderRadius);
    ctx.quadraticCurveTo(canvasWidth, canvasHeight, canvasWidth - borderRadius, canvasHeight);
    ctx.lineTo(borderRadius, canvasHeight);
    ctx.quadraticCurveTo(0, canvasHeight, 0, canvasHeight - borderRadius);
    ctx.lineTo(0, borderRadius);
    ctx.quadraticCurveTo(0, 0, borderRadius, 0);
    ctx.closePath();
    ctx.fillStyle = "rgba(10, 12, 18, 0.82)";
    ctx.fill();

    // Subtle border
    ctx.strokeStyle = `rgba(${color[0]}, ${color[1]}, ${color[2]}, 0.5)`;
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Draw text (shadow first for depth)
    const colorStr = `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
    const textY = padding + fontSize;

    // Shadow pass
    if (ft.isReady) {
        ft.drawTextBold(ctx, text, padding + 1, textY + 1, fontSize, "rgba(0,0,0,0.6)");
        ft.drawTextBold(ctx, text, padding, textY, fontSize, colorStr);
    } else {
        ctx.font = `bold ${fontSize}px ${fontFamily}`;
        ctx.fillStyle = "rgba(0,0,0,0.6)";
        ctx.fillText(text, padding + 1, textY + 1);
        ctx.fillStyle = colorStr;
        ctx.fillText(text, padding, textY);
    }

    return {
        imageData: ctx.getImageData(0, 0, canvasWidth, canvasHeight),
        width: canvasWidth,
        height: canvasHeight,
    };
}

export interface TileMarker {
    lat: number;
    lng: number;
    color: [number, number, number, number];
    size?: number;
    filled?: boolean;      // Draw all 4 borders for each tile (grid pattern)
    solidFill?: boolean;   // Fill tile interior with solid color (2 triangles)
    thickness?: number;
    floor?: number;
    numberLabel?: string;  // Optional text label for the tile
    skipIfNotVisible?: boolean;  // Return null immediately if chunk not visible (for path tiles)
}

// Object tile for batched rendering with islanding
export interface ObjectTile {
    lat: number;
    lng: number;
    color?: string;         // Hex color (e.g., "#FF0000" or "#FF0000FF")
    numberLabel?: string;   // Optional text label
}

// Batched object tiles for efficient rendering with islanding effect
export interface ObjectTileGroup {
    name: string;
    tiles: ObjectTile[];
    defaultColor: [number, number, number, number];
    floor?: number;
    thickness?: number;
}

// Path tile for batched path rendering
export interface PathTile {
    lat: number;
    lng: number;
    color: [number, number, number, number];
    floor: number;
    progress?: number;  // 0 = start of path, 1 = end/destination (for animated gradient)
}

// Batched path tiles for efficient single-draw-call rendering
export interface PathTileGroup {
    tiles: PathTile[];
    floor: number;
    thickness?: number;
    skipIfNotVisible?: boolean;
    animated?: boolean;  // Use animated shaders with flowing effect
}

export interface RectMarker {
    minLat: number;
    minLng: number;
    maxLat: number;
    maxLng: number;
    color: [number, number, number, number];
    filled?: boolean;      // Draw all 4 borders for each tile (grid pattern)
    solidFill?: boolean;   // Fill tile interior with solid color (2 triangles per tile)
    thickness?: number;
    floor?: number;
    skipIfNotVisible?: boolean;  // Return null immediately if chunk not visible (for path tiles)
}

export interface RadiusMarker {
    lat: number;      // Center lat (NPC position)
    lng: number;      // Center lng (NPC position)
    radius: number;   // Radius in tiles
    color: [number, number, number, number];
    filled?: boolean; // If true, draw all tile borders; if false, just outer border
    thickness?: number;
    floor?: number;
}

export interface NPCWanderMarker {
    npcLocation: { lat: number; lng: number };
    wanderRadius: {
        topRight: { lat: number; lng: number };
        bottomLeft: { lat: number; lng: number };
    };
    color: [number, number, number, number];
    npcColor?: [number, number, number, number];  // Optional separate color for NPC tile
    filled?: boolean;
    thickness?: number;
    floor?: number;
    skipIfNotVisible?: boolean;  // Return null immediately if chunk not visible
}

// Active overlays - keyed by GlOverlay object, tracks associated GL resources for disposal
interface OverlayEntry {
    description: string;
    resources?: {
        program?: patchrs.GlProgram;
        texture?: patchrs.TrackedTexture;
        vertexArray?: patchrs.VertexArraySnapshot;
    };
}
const activeOverlays = new Map<patchrs.GlOverlay, OverlayEntry>();

// Floor program ID (cached)
let floorProgramId: number | null = null;

// Chunk floor cache — persists across step switches so we don't need fresh captures
// Key: "chunkX,chunkZ:floorIndex", Value: { vertexObjectId, modelY }
interface CachedChunkFloor {
    vertexObjectId: number;
    modelY: number;
}
const chunkFloorCache = new Map<string, CachedChunkFloor>();

function getChunkFloorCacheKey(chunkX: number, chunkZ: number, floor: number): string {
    return `${chunkX},${chunkZ}:${floor}`;
}

function cacheChunkFloor(chunkX: number, chunkZ: number, floorIndex: number, vertexObjectId: number, modelY: number): void {
    const key = getChunkFloorCacheKey(chunkX, chunkZ, floorIndex);
    chunkFloorCache.set(key, { vertexObjectId, modelY });
}

function getCachedChunkFloor(chunkX: number, chunkZ: number, floorIndex: number): CachedChunkFloor | null {
    return chunkFloorCache.get(getChunkFloorCacheKey(chunkX, chunkZ, floorIndex)) ?? null;
}

/** Extract CachedChunkFloor from a live RenderInvocation and cache it */
function cacheFromRender(render: patchrs.RenderInvocation, chunkX: number, chunkZ: number, floorIndex: number): CachedChunkFloor {
    const chunkInfo = getChunkFromRender(render);
    const info: CachedChunkFloor = {
        vertexObjectId: render.vertexObjectId,
        modelY: chunkInfo?.modelY ?? 0
    };
    cacheChunkFloor(chunkX, chunkZ, floorIndex, info.vertexObjectId, info.modelY);
    return info;
}

/**
 * Parse a hex color string into RGBA tuple
 * Supports formats: #RGB, #RGBA, #RRGGBB, #RRGGBBAA
 */
function parseHexColor(hex: string): [number, number, number, number] | null {
    if (!hex || typeof hex !== "string") return null;

    // Remove # prefix if present
    const cleaned = hex.startsWith("#") ? hex.slice(1) : hex;

    let r: number, g: number, b: number, a: number = 255;

    if (cleaned.length === 3) {
        r = parseInt(cleaned[0] + cleaned[0], 16);
        g = parseInt(cleaned[1] + cleaned[1], 16);
        b = parseInt(cleaned[2] + cleaned[2], 16);
    } else if (cleaned.length === 4) {
        r = parseInt(cleaned[0] + cleaned[0], 16);
        g = parseInt(cleaned[1] + cleaned[1], 16);
        b = parseInt(cleaned[2] + cleaned[2], 16);
        a = parseInt(cleaned[3] + cleaned[3], 16);
    } else if (cleaned.length === 6) {
        r = parseInt(cleaned.slice(0, 2), 16);
        g = parseInt(cleaned.slice(2, 4), 16);
        b = parseInt(cleaned.slice(4, 6), 16);
    } else if (cleaned.length === 8) {
        r = parseInt(cleaned.slice(0, 2), 16);
        g = parseInt(cleaned.slice(2, 4), 16);
        b = parseInt(cleaned.slice(4, 6), 16);
        a = parseInt(cleaned.slice(6, 8), 16);
    } else {
        return null;
    }

    if (isNaN(r) || isNaN(g) || isNaN(b) || isNaN(a)) {
        return null;
    }

    return [r, g, b, a];
}

/**
 * Identity matrix (no transformation - mesh is already in world coordinates)
 */
function identityMatrix(): number[] {
    return [
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1
    ];
}

/**
 * Find the floor program ID
 */
async function findFloorProgram(): Promise<number | null> {
    if (floorProgramId !== null) return floorProgramId;

    // Retry up to 3 times — first capture can miss floor geometry during
    // loading screens, camera transitions, or frame cache timing issues
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const renders = await patchrs.native.recordRenderCalls({ maxframes: 1,
                framecooldown: 100,
                features: [], // Minimal - program info is always included
                skipProgramMask: wrongProgramMask,
                hasInput: "aMaterialSettingsSlotXY3"
            });

            for (const render of renders) {
                if (render.program.inputs.find(q => q.name === "aMaterialSettingsSlotXY3")) {
                    floorProgramId = render.program.programId;
                    return floorProgramId;
                } else {
                    render.program.skipmask |= wrongProgramMask;
                }
            }

            if (attempt < 2) {
                console.log(`[TileOverlay] No floor program found, retrying in 500ms (attempt ${attempt + 1}/3)...`);
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        } catch (e) {
            console.error("[TileOverlay] Error finding floor program:", e);
            if (attempt < 2) {
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }
    }
    return null;
}

/**
 * Create the overlay program
 * Uses custom uModelMatrix from buffer, copies other uniforms from floor program
 */
function createProgram() {
    const uniforms = new UniformSnapshotBuilder({
        uModelMatrix: "mat4",
        uViewProjMatrix: "mat4",
        uAmbientColour: "vec3",
        uSunlightViewMatrix: "mat4",
        uSunColour: "vec3",
        uMouse: "vec2"
    });

    // Copy camera/lighting from floor program, but NOT uModelMatrix
    // uModelMatrix will come from our uniformBuffer
    const uniformsources: patchrs.OverlayUniformSource[] = [
        { type: "program", name: "uViewProjMatrix", sourceName: "uViewProjMatrix" },
        { type: "program", name: "uAmbientColour", sourceName: "uAmbientColour" },
        { type: "program", name: "uSunlightViewMatrix", sourceName: "uSunlightViewMatrix" },
        { type: "program", name: "uSunColour", sourceName: "uSunColour" },
        { type: "builtin", name: "uMouse", sourceName: "mouse" }
    ];

    const program = patchrs.native.createProgram(vertshader, fragshader, [
        { location: 0, name: "aPos", type: GL_FLOAT, length: 3 },
        { location: 6, name: "aColor", type: GL_UNSIGNED_BYTE, length: 3 }
    ], uniforms.args);

    return { uniforms, program, uniformsources };
}

/**
 * Get terrain height at a tile position within chunk data
 */
function getTerrainHeight(heightData: Uint16Array, localTileX: number, localTileZ: number, dx: number = 0.5, dz: number = 0.5): number {
    const clampedX = Math.max(0, Math.min(CHUNK_SIZE - 1, Math.floor(localTileX)));
    const clampedZ = Math.max(0, Math.min(CHUNK_SIZE - 1, Math.floor(localTileZ)));
    const tileIndex = (clampedX + clampedZ * CHUNK_SIZE) * 5;

    if (tileIndex < 0 || tileIndex + 4 >= heightData.length) {
        return TILE_SIZE / 32;
    }

    // Bilinear interpolation of 4 corner heights
    const y00 = heightData[tileIndex + 0] * HEIGHT_SCALING * (1 - dx) * (1 - dz);
    const y01 = heightData[tileIndex + 1] * HEIGHT_SCALING * dx * (1 - dz);
    const y10 = heightData[tileIndex + 2] * HEIGHT_SCALING * (1 - dx) * dz;
    const y11 = heightData[tileIndex + 3] * HEIGHT_SCALING * dx * dz;

    return y00 + y01 + y10 + y11 + TILE_SIZE / 32; // Small offset above terrain
}

/**
 * Create rectangle mesh in ABSOLUTE WORLD coordinates
 * This is key - vertices are in world space, not chunk-local space
 */
function createRectMeshAbsolute(
    heightData: Uint16Array,
    chunkX: number,
    chunkZ: number,
    minLng: number,
    minLat: number,
    maxLng: number,
    maxLat: number,
    color: [number, number, number, number],
    thickness: number = 0.1
): { pos: Uint8Array; color: Uint8Array; index: Uint8Array } {
    const pos: number[] = [];
    const colors: number[] = [];
    const index: number[] = [];

    const rgba = [color[0], color[1], color[2], color[3] ?? 255];

    let vertexIndex = 0;

    // Write vertex at absolute world coordinates
    const writeVertex = (worldLng: number, worldLat: number): number => {
        // Convert to local tile within chunk for height lookup
        const localTileX = worldLng - chunkX * CHUNK_SIZE;
        const localTileZ = worldLat - chunkZ * CHUNK_SIZE;
        const dx = worldLng - Math.floor(worldLng);
        const dz = worldLat - Math.floor(worldLat);

        // Get terrain height
        const y = getTerrainHeight(heightData, localTileX, localTileZ, dx, dz);

        // Absolute world position
        const worldX = worldLng * TILE_SIZE;
        const worldZ = worldLat * TILE_SIZE;

        pos.push(worldX, y, worldZ);
        colors.push(...rgba);
        return vertexIndex++;
    };

    const t = thickness; // In tile units

    // Bottom edge (south)
    let v0 = writeVertex(minLng, minLat);
    let v1 = writeVertex(maxLng, minLat);
    let v2 = writeVertex(maxLng, minLat + t);
    let v3 = writeVertex(minLng, minLat + t);
    index.push(v0, v1, v2, v0, v2, v3);

    // Top edge (north)
    v0 = writeVertex(minLng, maxLat - t);
    v1 = writeVertex(maxLng, maxLat - t);
    v2 = writeVertex(maxLng, maxLat);
    v3 = writeVertex(minLng, maxLat);
    index.push(v0, v1, v2, v0, v2, v3);

    // Left edge (west)
    v0 = writeVertex(minLng, minLat + t);
    v1 = writeVertex(minLng + t, minLat + t);
    v2 = writeVertex(minLng + t, maxLat - t);
    v3 = writeVertex(minLng, maxLat - t);
    index.push(v0, v1, v2, v0, v2, v3);

    // Right edge (east)
    v0 = writeVertex(maxLng - t, minLat + t);
    v1 = writeVertex(maxLng, minLat + t);
    v2 = writeVertex(maxLng, maxLat - t);
    v3 = writeVertex(maxLng - t, maxLat - t);
    index.push(v0, v1, v2, v0, v2, v3);


    return {
        pos: new Uint8Array(Float32Array.from(pos).buffer),
        color: new Uint8Array(Uint8Array.from(colors).buffer),
        index: new Uint8Array(Uint16Array.from(index).buffer)
    };
}

/**
 * Shaders EXACTLY matching alt1gl tilemarkers.ts vertshadermouse/fragshaderflatnormals
 */
const VERT_SHADER_LIGHTING = `
    #version 330 core
    layout (location = 0) in vec3 aPos;
    layout (location = 6) in vec3 aColor;
    uniform highp mat4 uModelMatrix;
    uniform highp mat4 uViewProjMatrix;
    uniform highp vec2 uMouse;
    out vec4 ourColor;
    out vec3 FragPos;
    void main() {
        vec4 worldpos = uModelMatrix * vec4(aPos, 1.);
        gl_Position = uViewProjMatrix * worldpos;
        FragPos = worldpos.xyz/worldpos.w;
        ourColor = vec4(aColor,1.0);
    }`;

const FRAG_SHADER_LIGHTING = `
    #version 330 core
    in vec3 FragPos;
    in vec4 ourColor;
    uniform mat4 uSunlightViewMatrix;
    uniform vec3 uSunColour;
    uniform vec3 uAmbientColour;
    out vec4 FragColor;
    void main() {
        vec3 dx = dFdx(FragPos);
        vec3 dy = dFdy(FragPos);
        vec3 norm = normalize(cross(dx, dy));
        norm.z = -norm.z;
        vec3 lightDir = normalize(-uSunlightViewMatrix[2].xyz);
        float diff = max(dot(norm, lightDir), 0.0);
        vec3 diffuse = diff * uSunColour;
        vec3 lighting = diffuse + uAmbientColour;
        vec3 finalColor = ourColor.rgb * lighting;
        FragColor = vec4(finalColor * 0.5, ourColor.a);
    }`;

// Pending markers waiting for their chunk to become visible
const pendingMarkers: Map<string, { marker: RectMarker; resolve: (id: patchrs.GlOverlay | null) => void }> = new Map();

// Polling timer for pending markers (replaces unreliable stream approach)
let markerPollTimer: ReturnType<typeof setInterval> | null = null;
let pollInFlight = false;
// Use programId (stable integer) instead of object reference for caching.
// WeakMap<GlProgram> broke under IPC proxy because each frame delivers new
// deserialized program objects (different JS identity, same programId).
let knownFloorProgs = new Set<number>();
let knownWrongProgs = new Set<number>();

/**
 * Get chunk key for a marker
 */
function getMarkerChunkKey(marker: RectMarker): string {
    const centerLng = (marker.minLng + marker.maxLng) / 2;
    const centerLat = (marker.minLat + marker.maxLat) / 2;
    const chunkX = Math.floor(centerLng / CHUNK_SIZE);
    const chunkZ = Math.floor(centerLat / CHUNK_SIZE);
    return `${chunkX},${chunkZ}`;
}

/**
 * Extract chunk coordinates and Y position from a floor render's uModelMatrix
 */
function getChunkFromRender(render: patchrs.RenderInvocation): { chunkX: number; chunkZ: number; modelY: number } | null {
    const modelMatrixUniform = render.program.uniforms.find(u => u.name === "uModelMatrix");
    if (!modelMatrixUniform || !render.uniformState) return null;

    const offset = modelMatrixUniform.snapshotOffset;
    const view = new DataView(render.uniformState.buffer, render.uniformState.byteOffset + offset);
    const chunkX = Math.floor(view.getFloat32(12 * 4, true) / CHUNK_SIZE / TILE_SIZE);
    const modelY = view.getFloat32(13 * 4, true);
    const chunkZ = Math.floor(view.getFloat32(14 * 4, true) / CHUNK_SIZE / TILE_SIZE);
    return { chunkX, chunkZ, modelY };
}

/**
 * Find the best floor render for a chunk - picks the Nth lowest Y based on floor level
 * floor 0 = lowest Y (ground), floor 1 = next lowest, etc.
 */
function findBestFloorRender(
    renders: patchrs.RenderInvocation[],
    targetChunkX: number,
    targetChunkZ: number,
    targetFloor: number
): { render: patchrs.RenderInvocation; chunkX: number; chunkZ: number } | null {
    // Collect all renders for this chunk with their Y values
    const chunkRenders: Array<{ render: patchrs.RenderInvocation; chunkX: number; chunkZ: number; modelY: number }> = [];

    for (const render of renders) {
        if (!render.program.inputs.find(q => q.name === "aMaterialSettingsSlotXY3")) {
            continue;
        }
        const chunkInfo = getChunkFromRender(render);
        if (chunkInfo && chunkInfo.chunkX === targetChunkX && chunkInfo.chunkZ === targetChunkZ) {
            chunkRenders.push({ render, ...chunkInfo });
        }
    }

    if (chunkRenders.length === 0) return null;

    // Sort by Y ascending (lowest = floor 0)
    chunkRenders.sort((a, b) => a.modelY - b.modelY);

    // Pick the floor matching targetFloor (clamped to available floors)
    const floorIndex = Math.min(targetFloor, chunkRenders.length - 1);
    const selected = chunkRenders[floorIndex];

    return { render: selected.render, chunkX: selected.chunkX, chunkZ: selected.chunkZ };
}

/**
 * Create overlay for a marker on a specific floor render
 * MATCHES tilemarkers.ts EXACTLY
 */
async function createMarkerOverlay(marker: RectMarker, floorInfo: CachedChunkFloor, chunkX: number, chunkZ: number): Promise<patchrs.GlOverlay | null> {
    const floorModelY = floorInfo.modelY;

    // Fetch height data for this chunk
    const heightData = await fetchHeightData(chunkX, chunkZ, marker.floor ?? 0);
    if (!heightData) {
        console.warn("[TileOverlay] Height data unavailable, using flat fallback");
    }

    // Build mesh data - EXACTLY like tilemarkers.ts loadWalkmeshBlocking
    const pos: number[] = [];
    const colorData: number[] = [];
    const indices: number[] = [];

    const [r, g, b, a] = marker.color;
    const borderSize = marker.thickness ?? 0.035;  // Thinner, cleaner lines
    const heightScaling = TILE_SIZE / 32;

    // Root position (chunk-local, centered) - EXACTLY like tilemarkers.ts
    const rootx = -CHUNK_SIZE / 2 * TILE_SIZE;
    const rootz = -CHUNK_SIZE / 2 * TILE_SIZE;

    let vertexindex = 0;

    // Helper to safely get height values (returns 0 if heightData unavailable)
    const getHeight = (index: number): number => heightData ? heightData[index] : 0;

    // EXACT copy of tilemarkers.ts writevertex function
    const writevertex = (tilex: number, tilez: number, subx: number, subz: number, dy: number, vertcol: number[], rotation: number): number => {
        // Rotation transform - EXACTLY like tilemarkers.ts
        if (rotation % 2 === 1) {
            [subx, subz] = [-subz, subx];
        }
        if (rotation >= 2) {
            subx = -subx;
            subz = -subz;
        }

        const dx = 0.5 + subx;
        const dz = 0.5 + subz;
        dy += 1 / 32; // Small height offset

        // Clamp tile coords to valid range
        const clampedTileX = Math.max(0, Math.min(CHUNK_SIZE - 1, tilex));
        const clampedTileZ = Math.max(0, Math.min(CHUNK_SIZE - 1, tilez));

        const tileindex = (clampedTileX + clampedTileZ * CHUNK_SIZE) * 5;

        // Bilinear interpolation - EXACTLY like tilemarkers.ts
        const y00 = getHeight(tileindex + 0) * heightScaling * (1 - dx) * (1 - dz);
        const y01 = getHeight(tileindex + 1) * heightScaling * dx * (1 - dz);
        const y10 = getHeight(tileindex + 2) * heightScaling * (1 - dx) * dz;
        const y11 = getHeight(tileindex + 3) * heightScaling * dx * dz;

        pos.push(
            (tilex + dx) * TILE_SIZE + rootx,
            y00 + y01 + y10 + y11 + dy * TILE_SIZE,
            (tilez + dz) * TILE_SIZE + rootz
        );
        colorData.push(...vertcol);
        return vertexindex++;
    };

    // Based on tilemarkers.ts writeline function
    // Double-sided: both CCW and CW winding to prevent backface culling at certain camera angles
    const writeline = (x: number, z: number, size: number, vertcol: number[], leftcut: boolean, rightcut: boolean, dir: number): void => {
        const diagcut = 0.2;
        const left = leftcut ? -diagcut : -0.5;
        const right = rightcut ? diagcut : 0.5;

        const v0 = writevertex(x, z, left, -0.5, 0, vertcol, dir);
        const v1 = writevertex(x, z, right, -0.5, 0, vertcol, dir);
        const v2 = writevertex(x, z, right - size, -0.5 + size, 0, vertcol, dir);
        const v3 = writevertex(x, z, left + size, -0.5 + size, 0, vertcol, dir);

        // Front faces (CCW)
        indices.push(v0, v2, v1);
        indices.push(v0, v3, v2);
        // Back faces (CW) - double-sided rendering
        indices.push(v0, v1, v2);
        indices.push(v0, v2, v3);
    };

    // Write a solid filled quad (2 triangles covering the entire tile)
    // Double-sided: both CCW and CW winding to prevent backface culling at certain camera angles
    const writeSolidTile = (x: number, z: number, vertcol: number[]): void => {
        // 4 corners of the tile, small height offset to render above terrain
        const heightOffset = 2 / 32;
        const v0 = writevertex(x, z, -0.5, -0.5, heightOffset, vertcol, 0); // SW
        const v1 = writevertex(x, z, 0.5, -0.5, heightOffset, vertcol, 0);  // SE
        const v2 = writevertex(x, z, 0.5, 0.5, heightOffset, vertcol, 0);   // NE
        const v3 = writevertex(x, z, -0.5, 0.5, heightOffset, vertcol, 0);  // NW

        // Front faces (CCW)
        indices.push(v0, v2, v1);
        indices.push(v0, v3, v2);
        // Back faces (CW) - double-sided rendering
        indices.push(v0, v1, v2);
        indices.push(v0, v2, v3);
    };

    // Convert marker lat/lng to INTEGER tile coordinates within chunk
    // +1 offset to X to correct for coordinate system alignment (shift east)
    const minTileX = Math.floor(marker.minLng - chunkX * CHUNK_SIZE) + 1;
    const minTileZ = Math.floor(marker.minLat - chunkZ * CHUNK_SIZE);
    const maxTileX = Math.floor(marker.maxLng - chunkX * CHUNK_SIZE) + 1;
    const maxTileZ = Math.floor(marker.maxLat - chunkZ * CHUNK_SIZE);

    const col = [r, g, b, a];

    if (marker.solidFill) {
        // Solid fill: draw 2 triangles per tile to fill the entire surface
        for (let z = minTileZ; z <= maxTileZ; z++) {
            for (let x = minTileX; x <= maxTileX; x++) {
                writeSolidTile(x, z, col);
            }
        }
    } else if (marker.filled === false) {
        // Draw border around each tile on the edges of the rectangle
        // Like tilemarkers.ts - iterate tile by tile
        // Parameters: writeline(x, z, size, color, leftcut, rightcut, dir)

        // South edge tiles (draw south border)
        for (let x = minTileX; x <= maxTileX; x++) {
            writeline(x, minTileZ, borderSize, col, false, false, 0); // South
        }

        // North edge tiles (draw north border)
        for (let x = minTileX; x <= maxTileX; x++) {
            writeline(x, maxTileZ, borderSize, col, false, false, 2); // North
        }

        // West edge tiles (draw west border)
        for (let z = minTileZ; z <= maxTileZ; z++) {
            writeline(minTileX, z, borderSize, col, false, false, 3); // West
        }

        // East edge tiles (draw east border)
        for (let z = minTileZ; z <= maxTileZ; z++) {
            writeline(maxTileX, z, borderSize, col, false, false, 1); // East
        }
    } else {
        // Filled: draw all 4 borders for each tile in the rectangle
        for (let z = minTileZ; z <= maxTileZ; z++) {
            for (let x = minTileX; x <= maxTileX; x++) {
                // Draw all 4 edges for each tile
                writeline(x, z, borderSize, col, false, false, 0); // South
                writeline(x, z, borderSize, col, false, false, 1); // East
                writeline(x, z, borderSize, col, false, false, 2); // North
                writeline(x, z, borderSize, col, false, false, 3); // West
            }
        }
    }

    // Create program with lighting - EXACTLY like tilemarkers.ts floorOverlayProgram
    const uniforms = new UniformSnapshotBuilder({
        uModelMatrix: "mat4",
        uViewProjMatrix: "mat4",
        uAmbientColour: "vec3",
        uSunlightViewMatrix: "mat4",
        uSunColour: "vec3",
        uMouse: "vec2"
    });

    const uniformSources: patchrs.OverlayUniformSource[] = [
        { type: "program", name: "uViewProjMatrix", sourceName: "uViewProjMatrix" },
        { type: "program", name: "uAmbientColour", sourceName: "uAmbientColour" },
        { type: "program", name: "uSunlightViewMatrix", sourceName: "uSunlightViewMatrix" },
        { type: "program", name: "uSunColour", sourceName: "uSunColour" },
        { type: "builtin", name: "uMouse", sourceName: "mouse" }
    ];

    const program = patchrs.native.createProgram(VERT_SHADER_LIGHTING, FRAG_SHADER_LIGHTING, [
        { location: 0, name: "aPos", type: GL_FLOAT, length: 3 },
        { location: 6, name: "aColor", type: GL_UNSIGNED_BYTE, length: 3 }
    ], uniforms.args);

    // Position matrix - place at chunk center
    // With height data: vertex Y values are absolute world heights, baseY is just HEIGHT_SCALING offset
    // Without height data: vertices are flat, so baseY must match the floor's modelY
    const baseY = heightData ? HEIGHT_SCALING : floorModelY;
    uniforms.mappings.uModelMatrix.write(positionMatrix(
        (chunkX + 0.5) * TILE_SIZE * CHUNK_SIZE,
        baseY,
        (chunkZ + 0.5) * TILE_SIZE * CHUNK_SIZE
    ));

    // Create vertex array with UNSIGNED_BYTE colors (like tilemarkers.ts)
    const indexBuffer = new Uint8Array(new Uint16Array(indices).buffer);
    const posBuffer = new Uint8Array(Float32Array.from(pos).buffer);
    const colBuffer = new Uint8Array(Uint8Array.from(colorData).buffer);

    const vertex = patchrs.native.createVertexArray(indexBuffer, [
        { location: 0, buffer: posBuffer, enabled: true, normalized: false, offset: 0, scalartype: GL_FLOAT, stride: 3 * 4, vectorlength: 3 },
        { location: 6, buffer: colBuffer, enabled: true, normalized: true, offset: 0, scalartype: GL_UNSIGNED_BYTE, stride: 4, vectorlength: 3 }
    ]);

    // Create overlay using vertexObjectId trigger (like tilemarkers.ts)
    // IMPORTANT: Must specify ranges - length is number of INDICES, not triangles
    const renderRanges = [{ start: 0, length: indices.length }];

    let overlayId: patchrs.GlOverlay;
    try {
        overlayId = await patchrs.native.beginOverlay(
            { skipProgramMask: wrongProgramMask, vertexObjectId: floorInfo.vertexObjectId },
            program,
            vertex,
            {
                uniformSources: uniformSources,
                uniformBuffer: new Uint8Array(uniforms.buffer.buffer),
                ranges: renderRanges,
                alphaBlend: true
            }
        );
    } catch (e) {
        console.error(`[TileOverlay] beginOverlay FAILED for chunk ${chunkX},${chunkZ} vaoId=${floorInfo.vertexObjectId}:`, e);
        return null;
    }

    activeOverlays.set(overlayId, {
        description: `Rect (${marker.minLng.toFixed(1)},${marker.minLat.toFixed(1)}) to (${marker.maxLng.toFixed(1)},${marker.maxLat.toFixed(1)})`,
        resources: { program, vertexArray: vertex },
    });

    return overlayId;
}

/**
 * Start polling for pending marker chunks via recordRenderCalls.
 * Uses one-shot captures (lighter on shared memory than continuous streams)
 * and leverages the launcher's frame cache for efficiency.
 */
let pollCount = 0;
function startMarkerPolling(): void {
    if (markerPollTimer || !patchrs.native) return;
    pollCount = 0;

    markerPollTimer = setInterval(() => {
        if (pendingMarkers.size === 0) {
            stopMarkerPolling();
            return;
        }
        if (pollInFlight) return; // skip if previous poll hasn't finished
        pollInFlight = true;
        pollCount++;

        captureWithStreamPause(() => patchrs.native.recordRenderCalls({
            maxframes: 1,
            features: ["uniforms"],
            skipProgramMask: wrongProgramMask,
            hasInput: "aMaterialSettingsSlotXY3" // IPC optimization
        })).then(renders => {
            if (pendingMarkers.size === 0) return;

            // Classify programs
            for (const render of renders) {
                const pid = render.program.programId;
                if (knownWrongProgs.has(pid) || knownFloorProgs.has(pid)) continue;
                if (render.program.inputs.find(q => q.name === "aMaterialSettingsSlotXY3")) {
                    knownFloorProgs.add(pid);
                } else {
                    knownWrongProgs.add(pid);
                }
            }

            // Collect visible chunk keys
            const visibleChunks = new Set<string>();
            for (const render of renders) {
                if (knownWrongProgs.has(render.program.programId)) continue;
                if (!render.uniformState) continue;
                const chunkInfo = getChunkFromRender(render);
                if (chunkInfo) {
                    visibleChunks.add(`${chunkInfo.chunkX},${chunkInfo.chunkZ}`);
                }
            }

            if (pollCount % 5 === 1) {
                const pendingKeys = [...pendingMarkers.keys()].join(", ");
                const visibleKeys = [...visibleChunks].join(", ");
                console.log(`[TilePoll] poll=${pollCount} renders=${renders.length} visible=[${visibleKeys}] pending=[${pendingKeys}]`);
            }

            // Resolve pending markers
            for (const chunkKey of visibleChunks) {
                const pending = pendingMarkers.get(chunkKey);
                if (pending) {
                    const [cx, cz] = chunkKey.split(",").map(Number);
                    const targetFloor = pending.marker.floor ?? 0;
                    const bestRender = findBestFloorRender(renders, cx, cz, targetFloor);
                    if (bestRender) {
                        pendingMarkers.delete(chunkKey);
                        const info = cacheFromRender(bestRender.render, bestRender.chunkX, bestRender.chunkZ, targetFloor);
                        createMarkerOverlay(pending.marker, info, bestRender.chunkX, bestRender.chunkZ)
                            .then(overlayId => pending.resolve(overlayId));
                    }
                }
            }
        }).catch(e => {
            console.warn("[TilePoll] Error:", e);
        }).finally(() => {
            pollInFlight = false;
        });
    }, 1500); // Poll every 1.5 seconds
}

/**
 * Stop polling for pending markers
 */
function stopMarkerPolling(): void {
    if (markerPollTimer) {
        clearInterval(markerPollTimer);
        markerPollTimer = null;
        pollInFlight = false;
    }
}

/**
 * Add a terrain-conforming rectangle marker overlay
 * Uses streaming approach like tilemarkers.ts floorTracker
 */
export async function addRectMarker(marker: RectMarker): Promise<patchrs.GlOverlay | null> {
    if (!patchrs.native) {
        console.warn("[TileOverlay] Native addon not available");
        return null;
    }

    const chunkKey = getMarkerChunkKey(marker);
    const centerLng = (marker.minLng + marker.maxLng) / 2;
    const centerLat = (marker.minLat + marker.maxLat) / 2;
    const targetChunkX = Math.floor(centerLng / CHUNK_SIZE);
    const targetChunkZ = Math.floor(centerLat / CHUNK_SIZE);
    const targetFloor = marker.floor ?? 0;

    // Check chunk floor cache first — avoids expensive capture when data persists from prior step
    const cached = getCachedChunkFloor(targetChunkX, targetChunkZ, targetFloor);
    if (cached) {
        console.log(`[TileOverlay] Cache hit for chunk ${targetChunkX},${targetChunkZ}:${targetFloor} vaoId=${cached.vertexObjectId}`);
        return await createMarkerOverlay(marker, cached, targetChunkX, targetChunkZ);
    }

    // Cache miss — try to find the chunk via capture
    try {
        const renders = await patchrs.native.recordRenderCalls({ maxframes: 1,
            features: ["uniforms"],
            skipProgramMask: wrongProgramMask,
            hasInput: "aMaterialSettingsSlotXY3" // IPC optimization: filter server-side when available
        });

        const bestRender = findBestFloorRender(renders, targetChunkX, targetChunkZ, targetFloor);
        if (bestRender) {
            const info = cacheFromRender(bestRender.render, bestRender.chunkX, bestRender.chunkZ, targetFloor);
            return await createMarkerOverlay(marker, info, bestRender.chunkX, bestRender.chunkZ);
        }
    } catch (e) {
        console.warn("[TileOverlay] Error checking immediate renders:", e);
    }

    // Chunk not visible yet
    // If skipIfNotVisible is set, return null immediately (for path tiles)
    if (marker.skipIfNotVisible) {
        return null;
    }

    // Add to pending and start streaming

    return new Promise((resolve) => {
        pendingMarkers.set(chunkKey, { marker, resolve });
        startMarkerPolling();

        // Timeout after 30 seconds
        setTimeout(() => {
            if (pendingMarkers.has(chunkKey)) {
                console.warn(`[TileOverlay] Timeout waiting for chunk ${chunkKey}`);
                pendingMarkers.delete(chunkKey);
                resolve(null);

                // Stop polling if no more pending markers
                if (pendingMarkers.size === 0) {
                    stopMarkerPolling();
                }
            }
        }, 30000);
    });
}

/**
 * Add a tile marker overlay
 */
export async function addTileMarker(marker: TileMarker): Promise<patchrs.GlOverlay | null> {
    // For a single tile, minLat/maxLat and minLng/maxLng should be the same
    // The size parameter extends the tile grid (size=1 means 1x1, size=2 means 2x2, etc.)
    const tileLat = Math.floor(marker.lat);
    const tileLng = Math.floor(marker.lng);
    const size = marker.size ?? 1;

    return addRectMarker({
        minLat: tileLat,
        minLng: tileLng,
        // For size=1: max == min (single tile)
        // For size=2: max = min + 1 (2x2 grid)
        maxLat: tileLat + size - 1,
        maxLng: tileLng + size - 1,
        color: marker.color,
        filled: marker.filled,
        solidFill: marker.solidFill,
        thickness: marker.thickness ?? 0.035,  // Thin, clean lines
        floor: marker.floor,
        skipIfNotVisible: marker.skipIfNotVisible
    });
}

/**
 * Add a radius marker overlay centered on a point (e.g., NPC wander area)
 * The marker is centered on the given lat/lng with tiles extending radius tiles in each direction
 */
export async function addRadiusMarker(marker: RadiusMarker): Promise<patchrs.GlOverlay | null> {
    const r = marker.radius;
    // Center the marker on the tile containing the point
    // Floor to get the tile coordinate, then offset by radius
    const centerTileLat = Math.floor(marker.lat);
    const centerTileLng = Math.floor(marker.lng);

    return addRectMarker({
        // Extend radius tiles in each direction from center tile
        minLat: centerTileLat - r,
        minLng: centerTileLng - r,
        maxLat: centerTileLat + r,  // +r means r tiles above center
        maxLng: centerTileLng + r,  // +r means r tiles to the right of center
        color: marker.color,
        filled: marker.filled ?? true,  // Default to filled (show all tile borders)
        thickness: marker.thickness ?? 0.06,
        floor: marker.floor
    });
}

/**
 * Add an NPC wander area marker — simple blue outlined square
 */
export async function addNPCWanderMarker(marker: NPCWanderMarker): Promise<patchrs.GlOverlay | null> {
    const { bottomLeft, topRight } = marker.wanderRadius;

    return addRectMarker({
        minLat: bottomLeft.lat,
        minLng: bottomLeft.lng,
        maxLat: topRight.lat,
        maxLng: topRight.lng,
        color: marker.color,
        filled: false,
        thickness: marker.thickness ?? 0.06,
        floor: marker.floor,
        skipIfNotVisible: marker.skipIfNotVisible,
    });
}


/**
 * Create a batched overlay for multiple object tiles with islanding effect
 * - Solid fills for all tiles
 * - Borders only on outer edges (no border between adjacent tiles)
 * - Supports per-tile colors via hex strings
 */
async function createObjectTilesBatchedOverlay(
    group: ObjectTileGroup,
    floorInfo: CachedChunkFloor,
    chunkX: number,
    chunkZ: number
): Promise<patchrs.GlOverlay | null> {

    const heightData = await fetchHeightData(chunkX, chunkZ, group.floor ?? 0);
    if (!heightData) {
        console.warn("[TileOverlay] Could not load height data for batched object tiles");
        return null;
    }

    const pos: number[] = [];
    const colorData: number[] = [];
    const indices: number[] = [];

    const borderSize = group.thickness ?? 0.035;
    const heightScaling = TILE_SIZE / 32;
    const rootx = -CHUNK_SIZE / 2 * TILE_SIZE;
    const rootz = -CHUNK_SIZE / 2 * TILE_SIZE;

    let vertexindex = 0;

    // Build a set of all tile coordinates for adjacency checking (islanding)
    const tileSet = new Set<string>();
    const tileColors = new Map<string, [number, number, number, number]>();

    for (const tile of group.tiles) {
        const tileLat = Math.floor(tile.lat);
        const tileLng = Math.floor(tile.lng);
        const key = `${tileLng},${tileLat}`;
        tileSet.add(key);

        // Parse tile color or use default
        let color = group.defaultColor;
        if (tile.color) {
            const parsed = parseHexColor(tile.color);
            if (parsed) {
                color = parsed;
            }
        }
        tileColors.set(key, color);
    }

    // Writevertex function
    const writevertex = (tilex: number, tilez: number, subx: number, subz: number, dy: number, vertcol: number[], rotation: number): number => {
        if (rotation % 2 === 1) {
            [subx, subz] = [-subz, subx];
        }
        if (rotation >= 2) {
            subx = -subx;
            subz = -subz;
        }

        const dx = 0.5 + subx;
        const dz = 0.5 + subz;
        dy += 1 / 32;

        const clampedTileX = Math.max(0, Math.min(CHUNK_SIZE - 1, tilex));
        const clampedTileZ = Math.max(0, Math.min(CHUNK_SIZE - 1, tilez));
        const tileindex = (clampedTileX + clampedTileZ * CHUNK_SIZE) * 5;

        const y00 = heightData[tileindex + 0] * heightScaling * (1 - dx) * (1 - dz);
        const y01 = heightData[tileindex + 1] * heightScaling * dx * (1 - dz);
        const y10 = heightData[tileindex + 2] * heightScaling * (1 - dx) * dz;
        const y11 = heightData[tileindex + 3] * heightScaling * dx * dz;

        pos.push(
            (tilex + dx) * TILE_SIZE + rootx,
            y00 + y01 + y10 + y11 + dy * TILE_SIZE,
            (tilez + dz) * TILE_SIZE + rootz
        );
        colorData.push(...vertcol);
        return vertexindex++;
    };

    // Write solid filled tile (lowest layer)
    // Double-sided: both CCW and CW winding to prevent backface culling at certain camera angles
    const writeSolidTile = (x: number, z: number, vertcol: number[]): void => {
        const heightOffset = 2 / 32;
        const v0 = writevertex(x, z, -0.5, -0.5, heightOffset, vertcol, 0);
        const v1 = writevertex(x, z, 0.5, -0.5, heightOffset, vertcol, 0);
        const v2 = writevertex(x, z, 0.5, 0.5, heightOffset, vertcol, 0);
        const v3 = writevertex(x, z, -0.5, 0.5, heightOffset, vertcol, 0);
        // Front faces (CCW)
        indices.push(v0, v2, v1);
        indices.push(v0, v3, v2);
        // Back faces (CW) - double-sided rendering
        indices.push(v0, v1, v2);
        indices.push(v0, v2, v3);
    };

    // Border colors - dark casing for contrast
    const blackCasing = [0, 0, 0, 200];

    // Writeline for border casing (dark outline) - middle layer
    // Double-sided: both CCW and CW winding to prevent backface culling at certain camera angles
    const writeBorderCasing = (x: number, z: number, size: number, dir: number): void => {
        const heightOffset = 3 / 32; // Above fill
        const v0 = writevertex(x, z, -0.5, -0.5, heightOffset, blackCasing, dir);
        const v1 = writevertex(x, z, 0.5, -0.5, heightOffset, blackCasing, dir);
        const v2 = writevertex(x, z, 0.5 - size, -0.5 + size, heightOffset, blackCasing, dir);
        const v3 = writevertex(x, z, -0.5 + size, -0.5 + size, heightOffset, blackCasing, dir);
        // Front faces (CCW)
        indices.push(v0, v2, v1);
        indices.push(v0, v3, v2);
        // Back faces (CW) - double-sided rendering
        indices.push(v0, v1, v2);
        indices.push(v0, v2, v3);
    };

    // Writeline for colored border inline - top layer
    // Double-sided: both CCW and CW winding to prevent backface culling at certain camera angles
    const writeBorderInline = (x: number, z: number, size: number, vertcol: number[], dir: number): void => {
        const heightOffset = 4 / 32; // Above casing
        const inset = size * 0.3; // Smaller than casing
        const v0 = writevertex(x, z, -0.5 + inset, -0.5, heightOffset, vertcol, dir);
        const v1 = writevertex(x, z, 0.5 - inset, -0.5, heightOffset, vertcol, dir);
        const v2 = writevertex(x, z, 0.5 - size, -0.5 + size - inset, heightOffset, vertcol, dir);
        const v3 = writevertex(x, z, -0.5 + size, -0.5 + size - inset, heightOffset, vertcol, dir);
        // Front faces (CCW)
        indices.push(v0, v2, v1);
        indices.push(v0, v3, v2);
        // Back faces (CW) - double-sided rendering
        indices.push(v0, v1, v2);
        indices.push(v0, v2, v3);
    };

    // Process each tile
    for (const tile of group.tiles) {
        const tileLat = Math.floor(tile.lat);
        const tileLng = Math.floor(tile.lng);
        const key = `${tileLng},${tileLat}`;

        // Convert to chunk-local coordinates (+1 offset for coordinate alignment)
        const localX = tileLng - chunkX * CHUNK_SIZE + 1;
        const localZ = tileLat - chunkZ * CHUNK_SIZE;

        const col = tileColors.get(key) ?? group.defaultColor;

        // Draw solid fill
        writeSolidTile(localX, localZ, [...col]);

        // Draw borders only on outer edges (islanding effect)
        // Check each direction for adjacent tiles
        const hasNorth = tileSet.has(`${tileLng},${tileLat + 1}`);
        const hasSouth = tileSet.has(`${tileLng},${tileLat - 1}`);
        const hasEast = tileSet.has(`${tileLng + 1},${tileLat}`);
        const hasWest = tileSet.has(`${tileLng - 1},${tileLat}`);

        // Only draw border if no adjacent tile in that direction
        // Draw both casing (dark) and inline (colored) for each edge
        if (!hasSouth) {
            writeBorderCasing(localX, localZ, borderSize * 1.5, 0);
            writeBorderInline(localX, localZ, borderSize, [...col], 0);
        }
        if (!hasEast) {
            writeBorderCasing(localX, localZ, borderSize * 1.5, 1);
            writeBorderInline(localX, localZ, borderSize, [...col], 1);
        }
        if (!hasNorth) {
            writeBorderCasing(localX, localZ, borderSize * 1.5, 2);
            writeBorderInline(localX, localZ, borderSize, [...col], 2);
        }
        if (!hasWest) {
            writeBorderCasing(localX, localZ, borderSize * 1.5, 3);
            writeBorderInline(localX, localZ, borderSize, [...col], 3);
        }
    }

    // Create program with lighting
    const uniforms = new UniformSnapshotBuilder({
        uModelMatrix: "mat4",
        uViewProjMatrix: "mat4",
        uAmbientColour: "vec3",
        uSunlightViewMatrix: "mat4",
        uSunColour: "vec3",
        uMouse: "vec2"
    });

    const uniformSources: patchrs.OverlayUniformSource[] = [
        { type: "program", name: "uViewProjMatrix", sourceName: "uViewProjMatrix" },
        { type: "program", name: "uAmbientColour", sourceName: "uAmbientColour" },
        { type: "program", name: "uSunlightViewMatrix", sourceName: "uSunlightViewMatrix" },
        { type: "program", name: "uSunColour", sourceName: "uSunColour" },
        { type: "builtin", name: "uMouse", sourceName: "mouse" }
    ];

    const program = patchrs.native.createProgram(VERT_SHADER_LIGHTING, FRAG_SHADER_LIGHTING, [
        { location: 0, name: "aPos", type: GL_FLOAT, length: 3 },
        { location: 6, name: "aColor", type: GL_UNSIGNED_BYTE, length: 3 }
    ], uniforms.args);

    // Height data always available (early return if null)
    uniforms.mappings.uModelMatrix.write(positionMatrix(
        (chunkX + 0.5) * TILE_SIZE * CHUNK_SIZE,
        HEIGHT_SCALING,
        (chunkZ + 0.5) * TILE_SIZE * CHUNK_SIZE
    ));

    const indexBuffer = new Uint8Array(new Uint16Array(indices).buffer);
    const posBuffer = new Uint8Array(Float32Array.from(pos).buffer);
    const colBuffer = new Uint8Array(Uint8Array.from(colorData).buffer);

    const vertex = patchrs.native.createVertexArray(indexBuffer, [
        { location: 0, buffer: posBuffer, enabled: true, normalized: false, offset: 0, scalartype: GL_FLOAT, stride: 3 * 4, vectorlength: 3 },
        { location: 6, buffer: colBuffer, enabled: true, normalized: true, offset: 0, scalartype: GL_UNSIGNED_BYTE, stride: 4, vectorlength: 3 }
    ]);

    const renderRanges = [{ start: 0, length: indices.length }];

    const overlayId = await patchrs.native.beginOverlay(
        { skipProgramMask: wrongProgramMask, vertexObjectId: floorInfo.vertexObjectId },
        program,
        vertex,
        {
            uniformSources: uniformSources,
            uniformBuffer: new Uint8Array(uniforms.buffer.buffer),
            ranges: renderRanges,
            alphaBlend: true
        }
    );

    activeOverlays.set(overlayId, {
        description: `ObjectTileGroup "${group.name}" (${group.tiles.length} tiles)`,
        resources: { program, vertexArray: vertex },
    });

    return overlayId;
}

/**
 * Create a text label overlay at a specific position (supports floating point centers)
 * @param text - The text to display
 * @param centerLat - Center latitude (can be fractional for centering between tiles)
 * @param centerLng - Center longitude (can be fractional for centering between tiles)
 */
async function createTextLabelOverlay(
    text: string,
    centerLat: number,
    centerLng: number,
    floorInfo: CachedChunkFloor,
    chunkX: number,
    chunkZ: number,
    floorLevel: number = 0
): Promise<patchrs.GlOverlay | null> {

    const heightData = await fetchHeightData(chunkX, chunkZ, floorLevel);
    if (!heightData) {
        console.warn("[TileOverlay] Could not load height data for text label");
        return null;
    }

    // Calculate position in chunk-local coordinates
    const localX = centerLng - chunkX * CHUNK_SIZE + 1;
    const localZ = centerLat - chunkZ * CHUNK_SIZE;
    const heightScaling = TILE_SIZE / 32;
    const rootx = -CHUNK_SIZE / 2 * TILE_SIZE;
    const rootz = -CHUNK_SIZE / 2 * TILE_SIZE;

    // Get height at the center position (sample from nearest tile)
    const sampleTileX = Math.max(0, Math.min(CHUNK_SIZE - 1, Math.floor(localX)));
    const sampleTileZ = Math.max(0, Math.min(CHUNK_SIZE - 1, Math.floor(localZ)));
    const tileIndex = (sampleTileX + sampleTileZ * CHUNK_SIZE) * 5;
    const centerHeight = (
        heightData[tileIndex + 0] * 0.25 +
        heightData[tileIndex + 1] * 0.25 +
        heightData[tileIndex + 2] * 0.25 +
        heightData[tileIndex + 3] * 0.25
    ) * heightScaling;

    // Calculate world position for text
    const centerX = localX * TILE_SIZE + rootx;
    const centerZ = localZ * TILE_SIZE + rootz;
    const textHeight = centerHeight + TILE_SIZE * 2;  // 2 tiles above terrain

    // Render text to a canvas (FreeType if ready, Canvas2D fallback)
    const labelColor: [number, number, number] = [255, 255, 80];  // Warm yellow
    const label = renderLabelToCanvas(text, labelColor);

    // Map canvas pixels to world units — target height ≈ 0.55 tiles (easy to read)
    const worldHeight = TILE_SIZE * 0.55;
    const pixelToWorld = worldHeight / label.height;
    const worldWidth = label.width * pixelToWorld;

    // Create texture from rendered label
    const texture = patchrs.native.createTexture(label.imageData);

    // Billboard quad: 4 vertices (pos + UV), 2 triangles
    const quadVerts = new Float32Array([
        // pos (x, y)    UV (u, v)
        -0.5,  0.5,      0, 0,   // top-left
         0.5,  0.5,      1, 0,   // top-right
         0.5, -0.5,      1, 1,   // bottom-right
        -0.5, -0.5,      0, 1,   // bottom-left
    ]);
    const quadIndices = new Uint16Array([0, 1, 2, 0, 2, 3]);

    const uniforms = new UniformSnapshotBuilder({
        uModelMatrix: "mat4",
        uViewProjMatrix: "mat4",
        uTextCenter: "vec3",
        uTextSize: "vec2",
        uTexture: "sampler2d",
    });

    const uniformSources: patchrs.OverlayUniformSource[] = [
        { type: "program", name: "uViewProjMatrix", sourceName: "uViewProjMatrix" },
    ];

    const program = patchrs.native.createProgram(textVertShader, textFragShader, [
        { location: 0, name: "aPos", type: GL_FLOAT, length: 2 },
        { location: 1, name: "aUV", type: GL_FLOAT, length: 2 },
    ], uniforms.args);

    uniforms.mappings.uModelMatrix.write(positionMatrix(
        (chunkX + 0.5) * TILE_SIZE * CHUNK_SIZE,
        HEIGHT_SCALING,
        (chunkZ + 0.5) * TILE_SIZE * CHUNK_SIZE
    ));
    uniforms.mappings.uTextCenter.write([centerX, textHeight + worldHeight / 2, centerZ]);
    uniforms.mappings.uTextSize.write([worldWidth, worldHeight]);
    uniforms.mappings.uTexture.write([0]);

    const vertBuffer = new Uint8Array(quadVerts.buffer);
    const vertex = patchrs.native.createVertexArray(
        new Uint8Array(quadIndices.buffer),
        [
            { location: 0, buffer: vertBuffer, enabled: true, normalized: false, offset: 0, scalartype: GL_FLOAT, stride: 16, vectorlength: 2 },
            { location: 1, buffer: vertBuffer, enabled: true, normalized: false, offset: 8, scalartype: GL_FLOAT, stride: 16, vectorlength: 2 },
        ]
    );

    const overlayId = await patchrs.native.beginOverlay(
        { skipProgramMask: wrongProgramMask, vertexObjectId: floorInfo.vertexObjectId },
        program,
        vertex,
        {
            uniformSources,
            uniformBuffer: new Uint8Array(uniforms.buffer.buffer),
            samplers: { "0": texture },
            alphaBlend: true,
        }
    );

    activeOverlays.set(overlayId, {
        description: `TextLabel "${text}" at (${centerLat.toFixed(1)}, ${centerLng.toFixed(1)})`,
        resources: { program, texture, vertexArray: vertex },
    });

    return overlayId;
}

/**
 * Add a batched group of object tiles with islanding effect
 * All tiles in the group are rendered in a single draw call
 * Borders are only drawn on outer edges (no borders between adjacent tiles)
 */
export async function addObjectTilesBatched(group: ObjectTileGroup): Promise<patchrs.GlOverlay | null> {
    if (!patchrs.native) {
        console.warn("[TileOverlay] Native addon not available");
        return null;
    }

    if (group.tiles.length === 0) {
        console.warn("[TileOverlay] Empty tile group");
        return null;
    }

    // Find the center of all tiles to determine target chunk
    let sumLat = 0, sumLng = 0;
    for (const tile of group.tiles) {
        sumLat += tile.lat;
        sumLng += tile.lng;
    }
    const centerLat = sumLat / group.tiles.length;
    const centerLng = sumLng / group.tiles.length;
    const targetChunkX = Math.floor(centerLng / CHUNK_SIZE);
    const targetChunkZ = Math.floor(centerLat / CHUNK_SIZE);
    const targetFloor = group.floor ?? 0;

    // Check chunk floor cache first
    const cached = getCachedChunkFloor(targetChunkX, targetChunkZ, targetFloor);
    if (cached) {
        console.log(`[TileOverlay] Object tiles cache hit for chunk ${targetChunkX},${targetChunkZ}:${targetFloor}`);
        return await createObjectTilesFromFloorInfo(group, cached, targetChunkX, targetChunkZ, targetFloor);
    }

    // Cache miss — try to find the chunk via capture
    try {
        const renders = await patchrs.native.recordRenderCalls({ maxframes: 1,
            features: ["uniforms"],
            skipProgramMask: wrongProgramMask,
            hasInput: "aMaterialSettingsSlotXY3" // IPC optimization: filter server-side when available
        });

        // Collect visible chunks for diagnostics
        const visibleChunks: string[] = [];
        for (const render of renders) {
            if (render.program.inputs.find((q: any) => q.name === "aMaterialSettingsSlotXY3")) {
                const chunkInfo = getChunkFromRender(render);
                if (chunkInfo) {
                    visibleChunks.push(`${chunkInfo.chunkX},${chunkInfo.chunkZ}`);
                    if (chunkInfo.chunkX === targetChunkX && chunkInfo.chunkZ === targetChunkZ) {
                        const info = cacheFromRender(render, chunkInfo.chunkX, chunkInfo.chunkZ, targetFloor);
                        return await createObjectTilesFromFloorInfo(group, info, chunkInfo.chunkX, chunkInfo.chunkZ, targetFloor);
                    }
                }
            }
        }

        // Log once per unique target to help diagnose mismatches
        if (!_objectTileWarnedChunks.has(`${targetChunkX},${targetChunkZ}`)) {
            _objectTileWarnedChunks.add(`${targetChunkX},${targetChunkZ}`);
            console.warn(`[TileOverlay] Chunk ${targetChunkX},${targetChunkZ} not found in ${renders.length} renders. ` +
                `Visible floor chunks: [${[...new Set(visibleChunks)].join('; ')}]`);
        }
    } catch (e) {
        console.warn("[TileOverlay] Error finding chunk for object tiles:", e);
    }

    return null;
}

/** Shared logic for creating object tiles + text labels from cached floor info */
async function createObjectTilesFromFloorInfo(
    group: ObjectTileGroup,
    floorInfo: CachedChunkFloor,
    chunkX: number,
    chunkZ: number,
    floorLevel: number
): Promise<patchrs.GlOverlay | null> {
    const tileOverlayId = await createObjectTilesBatchedOverlay(group, floorInfo, chunkX, chunkZ);

    // Create text labels - group tiles with same label and center text
    const tilesWithLabels = group.tiles.filter(t => t.numberLabel);
    if (tilesWithLabels.length > 0) {
        const labelGroups = new Map<string, { lat: number; lng: number }[]>();
        for (const tile of tilesWithLabels) {
            const label = tile.numberLabel!;
            if (!labelGroups.has(label)) {
                labelGroups.set(label, []);
            }
            labelGroups.get(label)!.push({ lat: tile.lat, lng: tile.lng });
        }

        for (const [labelText, tiles] of labelGroups) {
            try {
                const minLat = Math.min(...tiles.map(t => Math.floor(t.lat)));
                const maxLat = Math.max(...tiles.map(t => Math.floor(t.lat)));
                const minLng = Math.min(...tiles.map(t => Math.floor(t.lng)));
                const maxLng = Math.max(...tiles.map(t => Math.floor(t.lng)));

                const centerLat = (minLat + maxLat + 1) / 2;
                const centerLng = (minLng + maxLng + 1) / 2;

                await createTextLabelOverlay(
                    labelText,
                    centerLat,
                    centerLng,
                    floorInfo,
                    chunkX,
                    chunkZ,
                    floorLevel
                );
            } catch (e) {
                console.warn(`[TileOverlay] Failed to create text label "${labelText}":`, e);
            }
        }
    }

    return tileOverlayId;
}

/**
 * Create batched path overlay for a single chunk as a 3D cylindrical tube
 * All tiles should be in the same chunk
 * @param animated If true, uses animated shaders with flowing effect and gradient
 */
async function createPathTilesBatchedOverlay(
    tiles: PathTile[],
    floorInfo: CachedChunkFloor,
    chunkX: number,
    chunkZ: number,
    thickness: number,
    animated: boolean = false
): Promise<patchrs.GlOverlay | null> {
    if (tiles.length < 2 || !patchrs.native) return null;

    const floorLevel = tiles[0].floor;
    const heightData = await fetchHeightData(chunkX, chunkZ, floorLevel);
    if (!heightData) {
        console.warn("[TileOverlay] Could not load height data for path tiles");
        return null;
    }

    const pos: number[] = [];
    const colorData: number[] = [];
    const indices: number[] = [];

    const heightScaling = TILE_SIZE / 32;
    const rootx = -CHUNK_SIZE / 2 * TILE_SIZE;
    const rootz = -CHUNK_SIZE / 2 * TILE_SIZE;

    let vertexindex = 0;

    // Tube parameters - thin tube close to the ground, attached to player level
    const tubeRadius = 0.06;  // Radius in tiles (thin tube)
    const tubeSegments = 8;   // Segments for tube shape
    const tubeHeight = 0.15;  // Very low - almost on the ground, at player feet level

    // Get height at a specific position
    const getHeight = (tilex: number, tilez: number, subx: number, subz: number): number => {
        const dx = 0.5 + subx;
        const dz = 0.5 + subz;
        const clampedTileX = Math.max(0, Math.min(CHUNK_SIZE - 1, Math.floor(tilex)));
        const clampedTileZ = Math.max(0, Math.min(CHUNK_SIZE - 1, Math.floor(tilez)));
        const tileindex = (clampedTileX + clampedTileZ * CHUNK_SIZE) * 5;

        const y00 = heightData[tileindex + 0] * heightScaling * (1 - dx) * (1 - dz);
        const y01 = heightData[tileindex + 1] * heightScaling * dx * (1 - dz);
        const y10 = heightData[tileindex + 2] * heightScaling * (1 - dx) * dz;
        const y11 = heightData[tileindex + 3] * heightScaling * dx * dz;
        return y00 + y01 + y10 + y11;
    };

    // Add a vertex with position and color (alpha encodes progress for animation)
    const addVertex3D = (worldX: number, worldY: number, worldZ: number, col: number[]): number => {
        pos.push(worldX, worldY, worldZ);
        colorData.push(...col);
        return vertexindex++;
    };

    // Sort tiles by progress to ensure correct order
    const sortedTiles = [...tiles].sort((a, b) => (a.progress ?? 0) - (b.progress ?? 0));

    // Pre-calculate path data with directions for tube orientation
    const pathPoints: Array<{
        x: number; z: number; y: number;  // Position in tile coords relative to chunk
        dirX: number; dirZ: number;        // Direction along path (normalized)
        progress: number;
        color: number[];
        inChunk: boolean;
    }> = [];

    for (let i = 0; i < sortedTiles.length; i++) {
        const tile = sortedTiles[i];
        const x = tile.lng - chunkX * CHUNK_SIZE;
        const z = tile.lat - chunkZ * CHUNK_SIZE;
        const inChunk = x >= -1 && x < CHUNK_SIZE + 1 && z >= -1 && z < CHUNK_SIZE + 1;

        // Get ground height and add tube height offset
        const groundHeight = getHeight(Math.floor(x), Math.floor(z), x - Math.floor(x) - 0.5, z - Math.floor(z) - 0.5);
        const y = groundHeight + tubeHeight * TILE_SIZE;

        // Get previous and next points for direction calculation
        const prev = i > 0 ? sortedTiles[i - 1] : null;
        const next = i < sortedTiles.length - 1 ? sortedTiles[i + 1] : null;

        let dirX = 0, dirZ = 1;  // Default direction (north)

        if (prev && next) {
            // Middle point: use direction from prev to next (Catmull-Rom style)
            const prevX = prev.lng - chunkX * CHUNK_SIZE;
            const prevZ = prev.lat - chunkZ * CHUNK_SIZE;
            const nextX = next.lng - chunkX * CHUNK_SIZE;
            const nextZ = next.lat - chunkZ * CHUNK_SIZE;

            const dx = nextX - prevX;
            const dz = nextZ - prevZ;
            const len = Math.sqrt(dx * dx + dz * dz) || 1;
            dirX = dx / len;
            dirZ = dz / len;
        } else if (next) {
            const nextX = next.lng - chunkX * CHUNK_SIZE;
            const nextZ = next.lat - chunkZ * CHUNK_SIZE;
            const dx = nextX - x, dz = nextZ - z;
            const len = Math.sqrt(dx * dx + dz * dz) || 1;
            dirX = dx / len;
            dirZ = dz / len;
        } else if (prev) {
            const prevX = prev.lng - chunkX * CHUNK_SIZE;
            const prevZ = prev.lat - chunkZ * CHUNK_SIZE;
            const dx = x - prevX, dz = z - prevZ;
            const len = Math.sqrt(dx * dx + dz * dz) || 1;
            dirX = dx / len;
            dirZ = dz / len;
        }

        const progress = tile.progress !== undefined ? Math.floor(tile.progress * 255) : 128;
        pathPoints.push({
            x, z, y, dirX, dirZ, progress,
            color: [tile.color[0], tile.color[1], tile.color[2], progress],
            inChunk
        });
    }

    // Build 3D tube mesh using Frenet frame for proper orientation
    // For a path in XZ plane:
    // - Tangent T = (dirX, 0, dirZ)
    // - Normal N = T × Up = (-dirZ, 0, dirX)  (horizontal perpendicular)
    // - Binormal B = T × N = (0, -1, 0)       (down vector)
    // Ring vertex = center + cos(θ) * r * N + sin(θ) * r * B

    const ringVertexIndices: number[][] = [];

    for (let i = 0; i < pathPoints.length; i++) {
        const pt = pathPoints[i];
        if (!pt.inChunk) {
            ringVertexIndices.push([]);
            continue;
        }

        // Frenet frame perpendicular vectors
        // N = (-dirZ, 0, dirX) - horizontal perpendicular to path
        // B = (0, -1, 0) - downward (so sin(0) = top, sin(π) = bottom)
        const Nx = -pt.dirZ;
        const Nz = pt.dirX;
        // B is just (0, -1, 0)

        // Convert to world coordinates
        const centerX = (pt.x + 0.5) * TILE_SIZE + rootx;
        const centerY = pt.y;
        const centerZ = (pt.z + 0.5) * TILE_SIZE + rootz;

        const ringIndices: number[] = [];
        const radiusWorld = tubeRadius * TILE_SIZE;

        // Create ring vertices
        for (let seg = 0; seg < tubeSegments; seg++) {
            const angle = (seg / tubeSegments) * Math.PI * 2;
            const cosA = Math.cos(angle);
            const sinA = Math.sin(angle);

            // offset = cos(θ) * r * N + sin(θ) * r * B
            // = (cos * r * Nx, sin * r * (-1), cos * r * Nz)
            const offsetX = cosA * radiusWorld * Nx;
            const offsetY = -sinA * radiusWorld;  // B is down, so negative
            const offsetZ = cosA * radiusWorld * Nz;

            const vx = centerX + offsetX;
            const vy = centerY + offsetY;
            const vz = centerZ + offsetZ;

            const idx = addVertex3D(vx, vy, vz, pt.color);
            ringIndices.push(idx);
        }

        ringVertexIndices.push(ringIndices);
    }

    // Connect adjacent rings with triangle strips
    // Double-sided rendering: add both CCW and CW triangles to avoid face culling issues
    for (let i = 0; i < pathPoints.length - 1; i++) {
        const currRing = ringVertexIndices[i];
        const nextRing = ringVertexIndices[i + 1];

        if (currRing.length === 0 || nextRing.length === 0) continue;

        for (let seg = 0; seg < tubeSegments; seg++) {
            const nextSeg = (seg + 1) % tubeSegments;

            const v0 = currRing[seg];       // Current ring, current segment
            const v1 = currRing[nextSeg];   // Current ring, next segment
            const v2 = nextRing[nextSeg];   // Next ring, next segment
            const v3 = nextRing[seg];       // Next ring, current segment

            // Front faces (CCW winding)
            indices.push(v0, v1, v2);
            indices.push(v0, v2, v3);
            // Back faces (CW winding) - for double-sided rendering
            indices.push(v0, v2, v1);
            indices.push(v0, v3, v2);
        }
    }

    // Start cap (fan from center) - double-sided
    const firstValidRing = ringVertexIndices.find(r => r.length > 0);
    const firstValidIdx = ringVertexIndices.indexOf(firstValidRing!);
    if (firstValidRing && firstValidIdx >= 0) {
        const pt = pathPoints[firstValidIdx];
        const centerX = (pt.x + 0.5) * TILE_SIZE + rootx;
        const centerY = pt.y;
        const centerZ = (pt.z + 0.5) * TILE_SIZE + rootz;
        const centerIdx = addVertex3D(centerX, centerY, centerZ, pt.color);

        for (let seg = 0; seg < tubeSegments; seg++) {
            const nextSeg = (seg + 1) % tubeSegments;
            // Both windings for double-sided
            indices.push(centerIdx, firstValidRing[seg], firstValidRing[nextSeg]);
            indices.push(centerIdx, firstValidRing[nextSeg], firstValidRing[seg]);
        }
    }

    // End cap (fan from center) - double-sided
    const lastValidRing = [...ringVertexIndices].reverse().find(r => r.length > 0);
    const lastValidIdx = ringVertexIndices.lastIndexOf(lastValidRing!);
    if (lastValidRing && lastValidIdx >= 0) {
        const pt = pathPoints[lastValidIdx];
        const centerX = (pt.x + 0.5) * TILE_SIZE + rootx;
        const centerY = pt.y;
        const centerZ = (pt.z + 0.5) * TILE_SIZE + rootz;
        const centerIdx = addVertex3D(centerX, centerY, centerZ, pt.color);

        for (let seg = 0; seg < tubeSegments; seg++) {
            const nextSeg = (seg + 1) % tubeSegments;
            // Both windings for double-sided
            indices.push(centerIdx, lastValidRing[nextSeg], lastValidRing[seg]);
            indices.push(centerIdx, lastValidRing[seg], lastValidRing[nextSeg]);
        }
    }

    if (indices.length === 0) {
        return null;
    }

    // Create uniforms - animated paths need uTime for animation
    const uniformSchema = animated ? {
        uModelMatrix: "mat4" as const,
        uViewProjMatrix: "mat4" as const,
        uAmbientColour: "vec3" as const,
        uSunlightViewMatrix: "mat4" as const,
        uSunColour: "vec3" as const,
        uTime: "float" as const
    } : {
        uModelMatrix: "mat4" as const,
        uViewProjMatrix: "mat4" as const,
        uAmbientColour: "vec3" as const,
        uSunlightViewMatrix: "mat4" as const,
        uSunColour: "vec3" as const,
        uMouse: "vec2" as const
    };

    const uniforms = new UniformSnapshotBuilder(uniformSchema);

    const uniformSources: patchrs.OverlayUniformSource[] = animated ? [
        { type: "program", name: "uViewProjMatrix", sourceName: "uViewProjMatrix" },
        { type: "program", name: "uAmbientColour", sourceName: "uAmbientColour" },
        { type: "program", name: "uSunlightViewMatrix", sourceName: "uSunlightViewMatrix" },
        { type: "program", name: "uSunColour", sourceName: "uSunColour" },
        { type: "builtin", name: "uTime", sourceName: "timestamp" }
    ] : [
        { type: "program", name: "uViewProjMatrix", sourceName: "uViewProjMatrix" },
        { type: "program", name: "uAmbientColour", sourceName: "uAmbientColour" },
        { type: "program", name: "uSunlightViewMatrix", sourceName: "uSunlightViewMatrix" },
        { type: "program", name: "uSunColour", sourceName: "uSunColour" },
        { type: "builtin", name: "uMouse", sourceName: "mouse" }
    ];

    // Choose shaders based on animation mode
    const program = animated
        ? patchrs.native.createProgram(pathVertShader, pathFragShader, [
            { location: 0, name: "aPos", type: GL_FLOAT, length: 3 },
            { location: 6, name: "aColor", type: GL_UNSIGNED_BYTE, length: 4 }  // RGBA for progress
        ], uniforms.args)
        : patchrs.native.createProgram(VERT_SHADER_LIGHTING, FRAG_SHADER_LIGHTING, [
            { location: 0, name: "aPos", type: GL_FLOAT, length: 3 },
            { location: 6, name: "aColor", type: GL_UNSIGNED_BYTE, length: 3 }
        ], uniforms.args);

    // Position matrix - place at chunk center, matching floor render's Y elevation
    // Height data always available (early return if null) — use HEIGHT_SCALING, not floorModelY
    uniforms.mappings.uModelMatrix.write(positionMatrix(
        (chunkX + 0.5) * TILE_SIZE * CHUNK_SIZE,
        HEIGHT_SCALING,
        (chunkZ + 0.5) * TILE_SIZE * CHUNK_SIZE
    ));

    // Create vertex array - animated uses 4-component color, non-animated uses 3
    const indexBuffer = new Uint8Array(new Uint16Array(indices).buffer);
    const posBuffer = new Uint8Array(Float32Array.from(pos).buffer);
    const colBuffer = new Uint8Array(Uint8Array.from(colorData).buffer);

    const colorStride = animated ? 4 : 4;  // Both use 4 bytes per vertex for color
    const colorLength = animated ? 4 : 3;  // But animated interprets all 4, non-animated only 3

    const vertex = patchrs.native.createVertexArray(indexBuffer, [
        { location: 0, buffer: posBuffer, enabled: true, normalized: false, offset: 0, scalartype: GL_FLOAT, stride: 3 * 4, vectorlength: 3 },
        { location: 6, buffer: colBuffer, enabled: true, normalized: true, offset: 0, scalartype: GL_UNSIGNED_BYTE, stride: colorStride, vectorlength: colorLength }
    ]);

    const renderRanges = [{ start: 0, length: indices.length }];

    const overlayId = await patchrs.native.beginOverlay(
        { skipProgramMask: wrongProgramMask, vertexObjectId: floorInfo.vertexObjectId },
        program,
        vertex,
        {
            uniformSources: uniformSources,
            uniformBuffer: new Uint8Array(uniforms.buffer.buffer),
            ranges: renderRanges,
            alphaBlend: animated  // Enable alpha blending for animated paths
        }
    );

    activeOverlays.set(overlayId, {
        description: `Path tiles${animated ? ' (animated)' : ''} (${tiles.length} tiles)`,
        resources: { program, vertexArray: vertex },
    });
    return overlayId;
}

/**
 * Add path tiles in a single batched draw call
 * Groups tiles by chunk and creates one overlay per visible chunk
 * Skips non-visible chunks if skipIfNotVisible is true
 */
export async function addPathTilesBatched(group: PathTileGroup): Promise<patchrs.GlOverlay[]> {
    const overlayIds: patchrs.GlOverlay[] = [];

    if (!patchrs.native) {
        console.warn("[TileOverlay] Native addon not available");
        return overlayIds;
    }

    if (group.tiles.length === 0) {
        return overlayIds;
    }

    // Sort all tiles by progress first
    const sortedTiles = [...group.tiles]
        .filter(t => t.floor === group.floor)
        .sort((a, b) => (a.progress ?? 0) - (b.progress ?? 0));

    // Group tiles by chunk, but include neighboring tiles for smooth connections
    // Each chunk gets its tiles PLUS adjacent tiles from neighboring segments
    const tilesByChunk = new Map<string, PathTile[]>();

    for (let i = 0; i < sortedTiles.length; i++) {
        const tile = sortedTiles[i];
        const chunkX = Math.floor(tile.lng / CHUNK_SIZE);
        const chunkZ = Math.floor(tile.lat / CHUNK_SIZE);
        const key = `${chunkX},${chunkZ}`;

        if (!tilesByChunk.has(key)) {
            tilesByChunk.set(key, []);
        }
        tilesByChunk.get(key)!.push(tile);

        // Also add this tile to neighboring chunk if it's near the edge
        // This ensures ribbon segments connect across chunk boundaries
        const localX = tile.lng - chunkX * CHUNK_SIZE;
        const localZ = tile.lat - chunkZ * CHUNK_SIZE;

        // If near chunk edge, add to adjacent chunk too
        if (localX < 2) {
            const neighborKey = `${chunkX - 1},${chunkZ}`;
            if (!tilesByChunk.has(neighborKey)) tilesByChunk.set(neighborKey, []);
            if (!tilesByChunk.get(neighborKey)!.includes(tile)) {
                tilesByChunk.get(neighborKey)!.push(tile);
            }
        }
        if (localX > CHUNK_SIZE - 2) {
            const neighborKey = `${chunkX + 1},${chunkZ}`;
            if (!tilesByChunk.has(neighborKey)) tilesByChunk.set(neighborKey, []);
            if (!tilesByChunk.get(neighborKey)!.includes(tile)) {
                tilesByChunk.get(neighborKey)!.push(tile);
            }
        }
        if (localZ < 2) {
            const neighborKey = `${chunkX},${chunkZ - 1}`;
            if (!tilesByChunk.has(neighborKey)) tilesByChunk.set(neighborKey, []);
            if (!tilesByChunk.get(neighborKey)!.includes(tile)) {
                tilesByChunk.get(neighborKey)!.push(tile);
            }
        }
        if (localZ > CHUNK_SIZE - 2) {
            const neighborKey = `${chunkX},${chunkZ + 1}`;
            if (!tilesByChunk.has(neighborKey)) tilesByChunk.set(neighborKey, []);
            if (!tilesByChunk.get(neighborKey)!.includes(tile)) {
                tilesByChunk.get(neighborKey)!.push(tile);
            }
        }
    }

    // Get current render calls to find visible chunks
    try {
        const renders = await patchrs.native.recordRenderCalls({ maxframes: 1,
            features: ["uniforms"],
            skipProgramMask: wrongProgramMask,
            hasInput: "aMaterialSettingsSlotXY3" // IPC optimization: filter server-side when available
        });

        // Build set of visible chunks and cache their floor info
        const visibleChunkInfos = new Map<string, { info: CachedChunkFloor; chunkX: number; chunkZ: number }>();
        for (const render of renders) {
            if (render.program.inputs.find((q: any) => q.name === "aMaterialSettingsSlotXY3")) {
                const chunkInfo = getChunkFromRender(render);
                if (chunkInfo) {
                    const key = `${chunkInfo.chunkX},${chunkInfo.chunkZ}`;
                    const info = cacheFromRender(render, chunkInfo.chunkX, chunkInfo.chunkZ, group.floor ?? 0);
                    visibleChunkInfos.set(key, { info, chunkX: chunkInfo.chunkX, chunkZ: chunkInfo.chunkZ });
                }
            } else {
                render.program.skipmask |= wrongProgramMask;
            }
        }

        // Create overlay for each chunk that has tiles and is visible (or cached)
        for (const [chunkKey, tiles] of tilesByChunk) {
            const visible = visibleChunkInfos.get(chunkKey);
            // Try cache if not in current capture
            const [cx, cz] = chunkKey.split(",").map(Number);
            const floorInfo = visible?.info ?? getCachedChunkFloor(cx, cz, group.floor ?? 0);
            if (floorInfo) {
                const overlayId = await createPathTilesBatchedOverlay(
                    tiles,
                    floorInfo,
                    visible?.chunkX ?? cx,
                    visible?.chunkZ ?? cz,
                    group.thickness ?? 0.05,
                    group.animated ?? false
                );
                if (overlayId !== null) {
                    overlayIds.push(overlayId);
                }
            }
        }
    } catch (e) {
        console.warn("[TileOverlay] Error checking renders for path tiles:", e);
    }

    return overlayIds;
}

/**
 * Remove an overlay
 */
export async function removeOverlay(overlay: patchrs.GlOverlay): Promise<void> {
    const entry = activeOverlays.get(overlay);
    if (entry) {
        try {
            overlay.stop();
        } catch (e) {
            console.warn("[TileOverlay] Error removing overlay:", e);
        }
        // Dispose associated GL resource handles to release native shared memory
        try { overlay.dispose?.(); } catch (_) {}
        if (entry.resources) {
            try { entry.resources.program?.dispose?.(); } catch (_) {}
            try { entry.resources.texture?.dispose?.(); } catch (_) {}
            try { entry.resources.vertexArray?.dispose?.(); } catch (_) {}
        }
        activeOverlays.delete(overlay);
    }
}

/**
 * Clear all overlays and pending markers.
 * Stops all overlays in parallel to avoid sequential IPC round-trips.
 */
export async function clearAllOverlays(): Promise<void> {
    // Clear pending markers first — prevents the stream callback from
    // creating new overlays for the old step while we're tearing down.
    for (const [, entry] of pendingMarkers) {
        entry.resolve(null);
    }
    pendingMarkers.clear();

    // Stop the marker polling — will restart when new markers are added
    stopMarkerPolling();

    // Stop all overlays and dispose their resources to release native shared memory
    const entries = [...activeOverlays.entries()];
    activeOverlays.clear();
    await Promise.all(entries.map(([overlay, entry]) => {
        try { overlay.stop(); } catch (_) {}
        try { overlay.dispose?.(); } catch (_) {}
        if (entry.resources) {
            try { entry.resources.program?.dispose?.(); } catch (_) {}
            try { entry.resources.texture?.dispose?.(); } catch (_) {}
            try { entry.resources.vertexArray?.dispose?.(); } catch (_) {}
        }
        return Promise.resolve();
    }));
}

/**
 * Get count of active overlays
 */
export function getActiveOverlayCount(): number {
    return activeOverlays.size;
}

/**
 * Initialize
 */
export function startFloorTracking(): { close: () => void } {
    return { close: stopFloorTracking };
}

/**
 * Invalidate ALL caches including floor program ID.
 * Call after resetOpenGlState() which destroys all DLL-side programs.
 */
export function invalidateFloorCache(): void {
    floorProgramId = null;
    chunkFloorCache.clear();
}

/**
 * Invalidate only chunk VAO cache (floor program survives scene transitions).
 * Call after floor changes (ladders, teleports) where VAOs change but programs don't.
 */
export function invalidateChunkCache(): void {
    chunkFloorCache.clear();
}

/**
 * Cleanup
 */
export function stopFloorTracking(): void {
    clearAllOverlays();
    invalidateFloorCache();
}

/**
 * Test function - creates a simple overlay at the current view
 */
export async function testOverlay(): Promise<{ stop: () => void; overlayid: patchrs.GlOverlay } | null> {
    try {
        if (!patchrs.native) {
            console.error("[testOverlay] Native addon not available");
            return null;
        }

        // Find floor program
        const programId = await findFloorProgram();
        if (!programId) {
            console.error("[testOverlay] Floor program not found");
            return null;
        }

        // Get a floor render to find where the player is
        // Only need uniforms for matrix data - program.inputs is always included
        const renders = await patchrs.native.recordRenderCalls({ maxframes: 1,
            framecooldown: 100,
            features: ["uniforms"], // Only uniforms, no textures
            hasInput: "aMaterialSettingsSlotXY3" // IPC optimization: filter server-side when available
        });

        let playerChunkX = 50, playerChunkZ = 50; // Default
        for (const render of renders) {
            if (render.program.inputs.find(q => q.name === "aMaterialSettingsSlotXY3")) {
                const modelUniform = render.program.uniforms.find(q => q.name === "uModelMatrix");
                if (modelUniform) {
                    const view = new DataView(render.uniformState.buffer, render.uniformState.byteOffset);
                    const worldX = view.getFloat32(modelUniform.snapshotOffset + 12 * 4, true);
                    const worldZ = view.getFloat32(modelUniform.snapshotOffset + 14 * 4, true);
                    playerChunkX = Math.floor(worldX / CHUNK_SIZE / TILE_SIZE);
                    playerChunkZ = Math.floor(worldZ / CHUNK_SIZE / TILE_SIZE);
                    console.log(`[testOverlay] Player near chunk (${playerChunkX}, ${playerChunkZ})`);
                    break;
                }
            }
        }

        // Create a 5x5 tile marker near the player
        const centerLng = playerChunkX * CHUNK_SIZE + CHUNK_SIZE / 2;
        const centerLat = playerChunkZ * CHUNK_SIZE + CHUNK_SIZE / 2;

        const overlayid = await addRectMarker({
            minLng: centerLng - 2.5,
            minLat: centerLat - 2.5,
            maxLng: centerLng + 2.5,
            maxLat: centerLat + 2.5,
            color: [255, 0, 0, 200],
            thickness: 0.2,
            floor: 0
        });

        if (overlayid === null) {
            console.error("[testOverlay] Failed to create overlay");
            return null;
        }

        console.log(`[testOverlay] Created test overlay ${overlayid} near chunk (${playerChunkX}, ${playerChunkZ})`);

        const stop = () => {
            removeOverlay(overlayid);
            console.log("[testOverlay] Stopped");
        };

        return { stop, overlayid };
    } catch (e) {
        console.error("[testOverlay] Error:", e);
        return null;
    }
}

/**
 * Test overlay at specific coordinates
 */
export async function testOverlayAt(lat: number, lng: number): Promise<{ stop: () => void; overlayid: patchrs.GlOverlay } | null> {
    const overlayid = await addRectMarker({
        minLng: lng - 2,
        minLat: lat - 2,
        maxLng: lng + 2,
        maxLat: lat + 2,
        color: [0, 255, 0, 200],
        thickness: 0.15,
        floor: 0
    });

    if (overlayid === null) {
        console.error("[testOverlayAt] Failed to create overlay");
        return null;
    }

    console.log(`[testOverlayAt] Created overlay at (${lat}, ${lng})`);

    return {
        stop: () => removeOverlay(overlayid),
        overlayid
    };
}

/**
 * Debug: show floor matrix info
 */
export async function debugFloorMatrix(): Promise<void> {
    try {
        logMemory("before debugFloorMatrix");

        // Only need uniforms for matrix data - program.inputs is always included
        const renders = await patchrs.native.recordRenderCalls({ maxframes: 1,
            framecooldown: 100,
            features: ["uniforms"], // Only uniforms, no textures
            hasInput: "aMaterialSettingsSlotXY3" // IPC optimization: filter server-side when available
        });

        logMemory("after recordRenderCalls");
        console.log(`[debugFloorMatrix] Captured ${renders.length} render calls`);

        let floorCount = 0;
        for (const render of renders) {
            if (!render.program.inputs.some(q => q.name === "aMaterialSettingsSlotXY3")) continue;
            floorCount++;

            const modelMatrixUniform = render.program.uniforms.find(q => q.name === "uModelMatrix");
            if (!modelMatrixUniform) continue;

            const view = new DataView(render.uniformState.buffer, render.uniformState.byteOffset);
            const x = view.getFloat32(modelMatrixUniform.snapshotOffset + 12 * 4, true);
            const y = view.getFloat32(modelMatrixUniform.snapshotOffset + 13 * 4, true);
            const z = view.getFloat32(modelMatrixUniform.snapshotOffset + 14 * 4, true);

            const chunkX = Math.floor(x / CHUNK_SIZE / TILE_SIZE);
            const chunkZ = Math.floor(z / CHUNK_SIZE / TILE_SIZE);

            console.log(`  Floor chunk (${chunkX}, ${chunkZ}) at world (${x.toFixed(0)}, ${y.toFixed(0)}, ${z.toFixed(0)})`);
            console.log(`    programId: ${render.program.programId}, vertexObjectId: ${render.vertexObjectId}`);
        }
        console.log(`[debugFloorMatrix] Found ${floorCount} floor renders`);
    } catch (e) {
        console.error("[debugFloorMatrix] Error:", e);
    }
}

/**
 * Simple test - mirrors alt1gl test4() EXACTLY
 * This copies both uModelMatrix and uViewProjMatrix from floor
 * so overlay appears at every floor chunk in local coordinates
 */
export async function testSimple(): Promise<{ stop: () => void; overlayid: patchrs.GlOverlay } | null> {
    try {
        if (!patchrs.native) {
            console.error("[testSimple] Native addon not available");
            return null;
        }

        logMemory("before testSimple");

        // Find a floor render - minimal capture
        // program.inputs metadata is always included without "vertexarray" feature
        const renders = await patchrs.native.recordRenderCalls({ maxframes: 1,
            framecooldown: 100,
            features: [], // Minimal - no extra data needed
            hasInput: "aMaterialSettingsSlotXY3" // IPC optimization: filter server-side when available
        });

        logMemory("after recordRenderCalls");

        let floorProgId: number | null = null;
        for (const render of renders) {
            if (render.program.inputs.find(q => q.name === "aMaterialSettingsSlotXY3")) {
                floorProgId = render.program.programId;
                break;
            }
        }

        if (!floorProgId) {
            console.error("[testSimple] Floor program not found");
            return null;
        }

        console.log(`[testSimple] Using floor programId: ${floorProgId}`);

        const GL_FLOAT_MAT4 = 0x8B5C;

        // Simple shader - just position and color
        const prog = patchrs.native.createProgram(
            `#version 330 core
            layout (location = 0) in vec3 aPos;
            layout (location = 6) in vec3 aColor;
            uniform highp mat4 uModelMatrix;
            uniform highp mat4 uViewProjMatrix;
            out vec3 ourColor;
            void main() {
                vec4 worldpos = uModelMatrix * vec4(aPos, 1.);
                gl_Position = uViewProjMatrix * worldpos;
                ourColor = aColor;
            }`,
            `#version 330 core
            in vec3 ourColor;
            out vec4 FragColor;
            void main() {
                FragColor = vec4(ourColor, 1.0);
            }`,
            [
                { location: 0, name: "aPos", type: GL_FLOAT, length: 3 },
                { location: 6, name: "aColor", type: GL_FLOAT, length: 3 }
            ],
            [
                { name: "uModelMatrix", length: 1, type: GL_FLOAT_MAT4, snapshotOffset: 0, snapshotSize: 4 * 16 },
                { name: "uViewProjMatrix", length: 1, type: GL_FLOAT_MAT4, snapshotOffset: 4 * 16, snapshotSize: 4 * 16 }
            ]
        );

        // Simple quad in local coordinates (relative to each floor chunk)
        // EXACT copy of test4() values
        const y = -30;
        const x1 = -3000, x2 = 1000;
        const z1 = -2500, z2 = 1500;
        // Double-sided triangles (front + back faces)
        const indexbuffer = new Uint8Array(new Uint16Array([0, 1, 2, 1, 2, 3, 0, 2, 1, 1, 3, 2]).buffer);
        const vertexbuffer = new Uint8Array(new Float32Array([
            x1, y, z1, 1, 0, 0,  // red
            x1, y, z2, 0, 0, 1,  // blue
            x2, y, z1, 0, 0, 1,  // blue
            x2, y, z2, 0, 1, 0   // green
        ]).buffer);

        const vertex = patchrs.native.createVertexArray(indexbuffer, [
            { location: 0, buffer: vertexbuffer, enabled: true, normalized: false, offset: 0, stride: 6 * 4, scalartype: GL_FLOAT, vectorlength: 3 },
            { location: 6, buffer: vertexbuffer, enabled: true, normalized: false, offset: 3 * 4, stride: 6 * 4, scalartype: GL_FLOAT, vectorlength: 3 }
        ]);

        // KEY: Copy BOTH matrices from floor program - this is what test4() does!
        // Explicitly set trigger: "after" to render after the floor
        // IMPORTANT: Must specify render ranges to tell how many triangles to draw
        // 12 indices = 4 triangles (double-sided quad)
        const renderRanges = [{ start: 0, length: 4 }]; // 4 triangles

        const overlayid = await patchrs.native.beginOverlay(
            { programId: floorProgId },
            prog,
            vertex,
            {
                trigger: "after",
                ranges: renderRanges,
                uniformSources: [
                    { name: "uModelMatrix", sourceName: "uModelMatrix", type: "program" },
                    { name: "uViewProjMatrix", sourceName: "uViewProjMatrix", type: "program" }
                ]
            }
        );

        console.log(`[testSimple] beginOverlay returned: ${overlayid}, ranges: ${JSON.stringify(renderRanges)}`);

        console.log(`[testSimple] Created overlay ${overlayid} - should appear on ALL visible floor chunks`);
        logMemory("after overlay created");

        return {
            stop: () => {
                overlayid.stop();
                console.log("[testSimple] Stopped");
                logMemory("after stop");
            },
            overlayid
        };
    } catch (e) {
        console.error("[testSimple] Error:", e);
        return null;
    }
}

/**
 * Log memory state for debugging
 */
function logMemory(label: string): void {
    try {
        const mem = patchrs.native.debug.memoryState();
        if (mem) {
            const usedMB = (mem.used / 1024 / 1024).toFixed(2);
            const freeMB = (mem.free / 1024 / 1024).toFixed(2);
            const totalMB = (mem.size / 1024 / 1024).toFixed(2);
            console.log(`[Memory ${label}] Used: ${usedMB}MB / ${totalMB}MB (${freeMB}MB free), allocs: ${mem.allocs}, objects: ${mem.namedobjects}`);
        }
    } catch (e) {
        console.warn("[Memory] Could not get memory state:", e);
    }
}

/**
 * Log GL object stats for debugging
 */
function logGlObjects(label: string): void {
    try {
        const stats = patchrs.native.debug.getGlObjectStats();
        if (stats) {
            console.log(`[GlObjects ${label}] Total: ${stats.count}, size: ${(stats.size / 1024 / 1024).toFixed(2)}MB`);
            // Log high-count objects
            const highCounts = Object.entries(stats.counts)
                .filter(([_, count]) => count > 10)
                .sort((a, b) => b[1] - a[1]);
            if (highCounts.length > 0) {
                console.log("  High count objects:", highCounts.map(([k, v]) => `${k}: ${v}`).join(", "));
            }
            // Log high-size objects
            const highSizes = Object.entries(stats.subsizes)
                .filter(([_, size]) => size > 100000)
                .sort((a, b) => b[1] - a[1]);
            if (highSizes.length > 0) {
                console.log("  High size objects:", highSizes.map(([k, v]) => `${k}: ${(v / 1024).toFixed(1)}KB`).join(", "));
            }
        }
    } catch (e) {
        console.warn("[GlObjects] Could not get stats:", e);
    }
}

/**
 * EXACT copy of test4() from alt1gl/ts/overlays/index.ts
 * No modifications at all - just to verify the base API works
 */
export async function testExact(): Promise<{ stop: () => void; overlayid: patchrs.GlOverlay } | null> {
    try {
        if (!patchrs.native) {
            console.log("[testExact] Native not available");
            return null;
        }

        logMemory("before testExact");

        // Capture inputs and uniforms - we need program.inputs to find floor render
        // and uniforms to read the floor Y position from uModelMatrix
        const renders = await patchrs.native.recordRenderCalls({ maxframes: 1,
            features: ["vertexarray", "uniforms"],
            hasInput: "aMaterialSettingsSlotXY3" // IPC optimization: filter server-side when available
        });

        logMemory("after recordRenderCalls");

        let floor: patchrs.RenderInvocation | null = null;
        for (const render of renders) {
            if (render.program.inputs.find(q => q.name === "aMaterialSettingsSlotXY3")) {
                floor = render;
                break;
            }
        }

        if (!floor) {
            console.log("[testExact] Floor program not found");
            return null;
        }

        console.log(`[testExact] Found floor program: ${floor.program.programId}`);

        // Extract floor Y from uModelMatrix uniform
        // Matrix is column-major, translation is at indices 12,13,14 (x,y,z)
        let floorY = 5; // Default fallback - small offset above floor
        const modelMatrixUniform = floor.program.uniforms.find(u => u.name === "uModelMatrix");
        if (modelMatrixUniform && floor.uniformState) {
            const offset = modelMatrixUniform.snapshotOffset;
            const view = new DataView(floor.uniformState.buffer, floor.uniformState.byteOffset + offset);
            const matrixY = view.getFloat32(13 * 4, true); // Index 13 = Y translation (column-major)
            console.log(`[testExact] Floor uModelMatrix Y translation: ${matrixY}`);
            // Use just a small offset above the floor (5 units)
            floorY = matrixY + 5;
        } else {
            console.log("[testExact] Could not read floor Y, using default");
        }

        const GL_FLOAT_LOCAL = 0x1406;
        const GL_FLOAT_MAT4_LOCAL = 0x8B5C;

        // EXACT shader from test4()
        const vertshader = `
            #version 330 core
            layout (location = 0) in vec3 aPos;
            layout (location = 6) in vec3 aColor;
            uniform highp mat4 uModelMatrix;
            uniform highp mat4 uViewProjMatrix;
            out vec3 ourColor;
            void main() {
                vec4 worldpos = uModelMatrix * vec4(aPos, 1.);
                gl_Position = uViewProjMatrix * worldpos;
                ourColor = aColor;
            }`;
        const fragshader = `
            #version 330 core
            in vec3 ourColor;
            out vec4 FragColor;
            void main() {
                FragColor = vec4(ourColor, 1.0);
            }`;

        const prog = patchrs.native.createProgram(vertshader, fragshader, [
            { location: 0, name: "aPos", type: GL_FLOAT_LOCAL, length: 3 },
            { location: 6, name: "aColor", type: GL_FLOAT_LOCAL, length: 3 }
        ], [
            { name: "uModelMatrix", length: 1, type: GL_FLOAT_MAT4_LOCAL, snapshotOffset: 0, snapshotSize: 4 * 16 },
            { name: "uViewProjMatrix", length: 1, type: GL_FLOAT_MAT4_LOCAL, snapshotOffset: 4 * 16, snapshotSize: 4 * 16 }
        ]);

        // Geometry - use floorY extracted from uniform
        const indexbuffer = new Uint8Array(new Uint16Array([0, 1, 2, 1, 2, 3, 0, 2, 1, 1, 3, 2]).buffer);
        const x1 = -3000, x2 = 1000;
        const z1 = -2500, z2 = 1500;
        const vertexbuffer = new Uint8Array(new Float32Array([
            x1, floorY, z1, 1, 0, 0,
            x1, floorY, z2, 0, 0, 1,
            x2, floorY, z1, 0, 0, 1,
            x2, floorY, z2, 0, 1, 0
        ]).buffer);

        const vertex = patchrs.native.createVertexArray(indexbuffer, [
            { location: 0, buffer: vertexbuffer, enabled: true, normalized: false, offset: 0 * 4, stride: 6 * 4, scalartype: GL_FLOAT_LOCAL, vectorlength: 3 },
            { location: 6, buffer: vertexbuffer, enabled: true, normalized: false, offset: 3 * 4, stride: 6 * 4, scalartype: GL_FLOAT_LOCAL, vectorlength: 3 },
        ]);

        // EXACT beginOverlay call from test4() - no trigger, no ranges
        const overlayid = await patchrs.native.beginOverlay({ programId: floor.program.programId }, prog, vertex, {
            uniformSources: [
                { name: "uModelMatrix", sourceName: "uModelMatrix", type: "program" },
                { name: "uViewProjMatrix", sourceName: "uViewProjMatrix", type: "program" },
            ]
        });

        console.log(`[testExact] Created overlay ${overlayid}`);
        logMemory("after overlay created");
        logGlObjects("after overlay");

        const stop = () => {
            overlayid.stop();
            console.log("[testExact] Stopped");
            logMemory("after stop");
        };

        return { stop, overlayid };
    } catch (e) {
        console.error("[testExact] Error:", e);
        return null;
    }
}

/**
 * Most basic test possible - just triangle vertices with no transformation
 * This tests if the overlay system works AT ALL
 */
export async function testBasic(): Promise<{ stop: () => void; overlayid: patchrs.GlOverlay } | null> {
    try {
        if (!patchrs.native) {
            console.error("[testBasic] Native addon not available");
            return null;
        }

        logMemory("before testBasic");

        // Find floor program - only request uniforms for matrix debugging
        const renders = await patchrs.native.recordRenderCalls({ maxframes: 1,
            framecooldown: 100,
            features: ["uniforms"], // Only uniforms for debugging, no textures/inputs
            hasInput: "aMaterialSettingsSlotXY3" // IPC optimization: filter server-side when available
        });

        logMemory("after recordRenderCalls");

        let floor: patchrs.RenderInvocation | null = null;
        for (const render of renders) {
            if (render.program.inputs.find(q => q.name === "aMaterialSettingsSlotXY3")) {
                floor = render;
                break;
            }
        }

        if (!floor) {
            console.error("[testBasic] Floor program not found");
            return null;
        }

        // Print floor's model matrix for debugging
        const modelUniform = floor.program.uniforms.find(q => q.name === "uModelMatrix");
        if (modelUniform) {
            const view = new DataView(floor.uniformState.buffer, floor.uniformState.byteOffset);
            console.log("[testBasic] Floor model matrix:");
            for (let row = 0; row < 4; row++) {
                const vals = [];
                for (let col = 0; col < 4; col++) {
                    vals.push(view.getFloat32(modelUniform.snapshotOffset + (col * 4 + row) * 4, true).toFixed(1));
                }
                console.log(`  [${vals.join(", ")}]`);
            }
            const modelY = view.getFloat32(modelUniform.snapshotOffset + 13 * 4, true);
            console.log(`[testBasic] Floor model Y translation: ${modelY}`);
        }

        console.log(`[testBasic] Using floor programId: ${floor.program.programId}`);

        const GL_FLOAT_MAT4 = 0x8B5C;

        // Minimal shader
        const prog = patchrs.native.createProgram(
            `#version 330 core
            layout (location = 0) in vec3 aPos;
            uniform highp mat4 uModelMatrix;
            uniform highp mat4 uViewProjMatrix;
            void main() {
                vec4 worldpos = uModelMatrix * vec4(aPos, 1.);
                gl_Position = uViewProjMatrix * worldpos;
            }`,
            `#version 330 core
            out vec4 FragColor;
            void main() {
                FragColor = vec4(1.0, 0.0, 0.0, 1.0);
            }`,
            [
                { location: 0, name: "aPos", type: GL_FLOAT, length: 3 }
            ],
            [
                { name: "uModelMatrix", length: 1, type: GL_FLOAT_MAT4, snapshotOffset: 0, snapshotSize: 64 },
                { name: "uViewProjMatrix", length: 1, type: GL_FLOAT_MAT4, snapshotOffset: 64, snapshotSize: 64 }
            ]
        );

        // Very simple triangle at origin
        const indexbuffer = new Uint8Array(new Uint16Array([0, 1, 2]).buffer);
        const vertexbuffer = new Uint8Array(new Float32Array([
            0, 0, 0,
            1000, 0, 0,
            0, 0, 1000
        ]).buffer);

        const vertex = patchrs.native.createVertexArray(indexbuffer, [
            { location: 0, buffer: vertexbuffer, enabled: true, normalized: false, offset: 0, stride: 12, scalartype: GL_FLOAT, vectorlength: 3 }
        ]);

        // Must specify render ranges - 1 triangle (3 indices)
        const renderRanges = [{ start: 0, length: 1 }];

        const overlayid = await patchrs.native.beginOverlay(
            { programId: floor.program.programId },
            prog,
            vertex,
            {
                trigger: "after",
                ranges: renderRanges,
                uniformSources: [
                    { name: "uModelMatrix", sourceName: "uModelMatrix", type: "program" },
                    { name: "uViewProjMatrix", sourceName: "uViewProjMatrix", type: "program" }
                ]
            }
        );

        console.log(`[testBasic] Created overlay ${overlayid}, ranges: ${JSON.stringify(renderRanges)}`);
        logMemory("after overlay created");

        return {
            stop: () => {
                overlayid.stop();
                console.log("[testBasic] Stopped");
                logMemory("after stop");
            },
            overlayid
        };
    } catch (e) {
        console.error("[testBasic] Error:", e);
        return null;
    }
}

/**
 * Check memory status - exposed for console debugging
 */
export function checkMemory(): void {
    logMemory("current");
    logGlObjects("current");
}

/**
 * Debug program creation - logs everything about the created program
 * to help diagnose why overlays might not be visible
 */
export async function debugProgram(): Promise<void> {
    try {
        if (!patchrs.native) {
            console.error("[debugProgram] Native addon not available");
            return;
        }

        console.log("=== Debug Program Creation ===");
        logMemory("start");

        // Check renderer info
        const renderer = patchrs.native.getRenderer();
        console.log("[debugProgram] Renderer info:", renderer);

        // Find floor render
        const renders = await patchrs.native.recordRenderCalls({ maxframes: 1, features: [],
            hasInput: "aMaterialSettingsSlotXY3" // IPC optimization: filter server-side when available
        });
        console.log(`[debugProgram] Got ${renders.length} render calls`);

        let floor: patchrs.RenderInvocation | null = null;
        for (const render of renders) {
            if (render.program.inputs.find(q => q.name === "aMaterialSettingsSlotXY3")) {
                floor = render;
                break;
            }
        }

        if (!floor) {
            console.error("[debugProgram] Floor program not found!");
            return;
        }

        console.log("[debugProgram] Floor program found:");
        console.log("  programId:", floor.program.programId);
        console.log("  uniforms:", floor.program.uniforms.map(u => u.name).join(", "));
        console.log("  inputs:", floor.program.inputs.map(i => `${i.name}@${i.location}`).join(", "));
        console.log("  uniformBufferSize:", floor.program.uniformBufferSize);
        console.log("  skipmask:", floor.program.skipmask);

        // Check floor vertex shader
        console.log("[debugProgram] Floor vertex shader ID:", floor.program.vertexShader.id);
        console.log("[debugProgram] Floor fragment shader ID:", floor.program.fragmentShader.id);

        // Now create our overlay program
        const GL_FLOAT_LOCAL = 0x1406;
        const GL_FLOAT_MAT4_LOCAL = 0x8B5C;

        const vertshader = `
            #version 330 core
            layout (location = 0) in vec3 aPos;
            layout (location = 6) in vec3 aColor;
            uniform highp mat4 uModelMatrix;
            uniform highp mat4 uViewProjMatrix;
            out vec3 ourColor;
            void main() {
                vec4 worldpos = uModelMatrix * vec4(aPos, 1.);
                gl_Position = uViewProjMatrix * worldpos;
                ourColor = aColor;
            }`;
        const fragshader = `
            #version 330 core
            in vec3 ourColor;
            out vec4 FragColor;
            void main() {
                FragColor = vec4(ourColor, 1.0);
            }`;

        console.log("[debugProgram] Creating overlay program...");

        const prog = patchrs.native.createProgram(vertshader, fragshader, [
            { location: 0, name: "aPos", type: GL_FLOAT_LOCAL, length: 3 },
            { location: 6, name: "aColor", type: GL_FLOAT_LOCAL, length: 3 }
        ], [
            { name: "uModelMatrix", length: 1, type: GL_FLOAT_MAT4_LOCAL, snapshotOffset: 0, snapshotSize: 4 * 16 },
            { name: "uViewProjMatrix", length: 1, type: GL_FLOAT_MAT4_LOCAL, snapshotOffset: 4 * 16, snapshotSize: 4 * 16 }
        ]);

        console.log("[debugProgram] Created program:", prog);
        console.log("  programId:", prog.programId);
        console.log("  vertexShader.id:", prog.vertexShader.id);
        console.log("  fragmentShader.id:", prog.fragmentShader.id);
        console.log("  uniforms:", prog.uniforms);
        console.log("  inputs:", prog.inputs);
        console.log("  uniformBufferSize:", prog.uniformBufferSize);
        console.log("  skipmask:", prog.skipmask);

        // Check if shaders compiled (they should have valid IDs > 0)
        if (prog.programId === 0) {
            console.error("[debugProgram] Program ID is 0 - shader compilation likely failed!");
        }
        if (prog.vertexShader.id === 0) {
            console.error("[debugProgram] Vertex shader ID is 0 - compilation failed!");
        }
        if (prog.fragmentShader.id === 0) {
            console.error("[debugProgram] Fragment shader ID is 0 - compilation failed!");
        }

        // Create vertex array
        const indexbuffer = new Uint8Array(new Uint16Array([0, 1, 2, 1, 2, 3, 0, 2, 1, 1, 3, 2]).buffer);
        const y = -30;
        const x1 = -3000, x2 = 1000;
        const z1 = -2500, z2 = 1500;
        const vertexbuffer = new Uint8Array(new Float32Array([
            x1, y, z1, 1, 0, 0,
            x1, y, z2, 0, 0, 1,
            x2, y, z1, 0, 0, 1,
            x2, y, z2, 0, 1, 0
        ]).buffer);

        const vertex = patchrs.native.createVertexArray(indexbuffer, [
            { location: 0, buffer: vertexbuffer, enabled: true, normalized: false, offset: 0, stride: 6 * 4, scalartype: GL_FLOAT_LOCAL, vectorlength: 3 },
            { location: 6, buffer: vertexbuffer, enabled: true, normalized: false, offset: 3 * 4, stride: 6 * 4, scalartype: GL_FLOAT_LOCAL, vectorlength: 3 },
        ]);

        console.log("[debugProgram] Created vertex array:", vertex);
        console.log("  base.skipmask:", vertex.base.skipmask);
        console.log("  indexBuffer length:", vertex.indexBuffer.length);
        console.log("  attributes count:", vertex.attributes.length);

        // Try to start overlay
        console.log("[debugProgram] Starting overlay with programId:", floor.program.programId);

        const overlayid = await patchrs.native.beginOverlay({ programId: floor.program.programId }, prog, vertex, {
            uniformSources: [
                { name: "uModelMatrix", sourceName: "uModelMatrix", type: "program" },
                { name: "uViewProjMatrix", sourceName: "uViewProjMatrix", type: "program" },
            ]
        });

        console.log("[debugProgram] beginOverlay returned overlay ID:", overlayid);
        logMemory("after overlay");

        console.log("=== Done ===");
        console.log("To stop overlay, call overlayid.stop() on the returned object");
    } catch (e) {
        console.error("[debugProgram] Error:", e);
    }
}

/**
 * Test if overlays work at all by creating one with frameend trigger
 * (renders at end of frame, not attached to any specific draw call)
 */
export async function testFrameEnd(): Promise<{ stop: () => void; overlayid: patchrs.GlOverlay } | null> {
    try {
        if (!patchrs.native) {
            console.error("[testFrameEnd] Native addon not available");
            return null;
        }

        logMemory("before testFrameEnd");

        const GL_FLOAT_LOCAL = 0x1406;
        const GL_FLOAT_MAT4_LOCAL = 0x8B5C;

        // Super simple passthrough shader - just output clip space coords directly
        const prog = patchrs.native.createProgram(
            `#version 330 core
            layout (location = 0) in vec3 aPos;
            void main() {
                // Output directly in clip space (-1 to 1)
                gl_Position = vec4(aPos, 1.0);
            }`,
            `#version 330 core
            out vec4 FragColor;
            void main() {
                FragColor = vec4(1.0, 0.0, 0.0, 1.0);
            }`,
            [
                { location: 0, name: "aPos", type: GL_FLOAT_LOCAL, length: 3 }
            ],
            []  // No uniforms needed
        );

        console.log("[testFrameEnd] Created program:", prog.programId);

        // Triangle in clip space - should appear in center of screen
        const indexbuffer = new Uint8Array(new Uint16Array([0, 1, 2]).buffer);
        const vertexbuffer = new Uint8Array(new Float32Array([
            -0.5, -0.5, 0,  // bottom left
             0.5, -0.5, 0,  // bottom right
             0.0,  0.5, 0   // top center
        ]).buffer);

        const vertex = patchrs.native.createVertexArray(indexbuffer, [
            { location: 0, buffer: vertexbuffer, enabled: true, normalized: false, offset: 0, stride: 12, scalartype: GL_FLOAT_LOCAL, vectorlength: 3 }
        ]);

        // Use frameend trigger - should render at end of every frame
        const overlayid = await patchrs.native.beginOverlay(
            {},  // Empty trigger = match all
            prog,
            vertex,
            {
                trigger: "frameend",
                ranges: [{ start: 0, length: 1 }]  // 1 triangle
            }
        );

        console.log(`[testFrameEnd] Created overlay ${overlayid} with frameend trigger - should show red triangle in center`);
        logMemory("after overlay");

        return {
            stop: () => {
                overlayid.stop();
                console.log("[testFrameEnd] Stopped");
            },
            overlayid
        };
    } catch (e) {
        console.error("[testFrameEnd] Error:", e);
        return null;
    }
}

/**
 * Diagnostic function to check native addon state
 */
export function checkNative(): void {
    console.log("=== Native Addon Diagnostics ===");

    console.log("1. patchrs module:", typeof patchrs);
    console.log("2. patchrs.native:", typeof patchrs.native);

    if (!patchrs.native) {
        console.error("Native addon is NULL!");
        return;
    }

    console.log("3. Native object keys:", Object.keys(patchrs.native));

    // Check each critical function
    const criticalFunctions = [
        'createProgram',
        'createVertexArray',
        'createTexture',
        'beginOverlay',
        'stopOverlay',
        'recordRenderCalls',
        'getRenderer',
        'getOpenGlState'
    ];

    for (const fn of criticalFunctions) {
        const func = (patchrs.native as any)[fn];
        console.log(`4. native.${fn}:`, typeof func, func ? '✓' : '✗');
    }

    console.log("5. native.debug:", typeof patchrs.native.debug);
    if (patchrs.native.debug) {
        console.log("6. debug object keys:", Object.keys(patchrs.native.debug));
    }

    // Try to get memory state
    try {
        const mem = patchrs.native.debug.memoryState();
        console.log("7. memoryState():", mem ? '✓ connected' : '✗ null (not connected?)');
        if (mem) {
            console.log("   - size:", mem.size, "used:", mem.used, "sanity:", mem.sanity);
        }
    } catch (e) {
        console.error("7. memoryState() error:", e);
    }

    // Try to get renderer
    try {
        const renderer = patchrs.native.getRenderer();
        console.log("8. getRenderer():", renderer ? '✓' : '✗ null');
        if (renderer) {
            console.log("   - GL version:", renderer.glVersion);
        }
    } catch (e) {
        console.error("8. getRenderer() error:", e);
    }

    // Try a simple createProgram with minimal shader
    console.log("9. Testing createProgram...");
    try {
        const result = patchrs.native.createProgram(
            "#version 330 core\nvoid main() { gl_Position = vec4(0.0); }",
            "#version 330 core\nout vec4 c;\nvoid main() { c = vec4(1.0); }",
            [],
            []
        );
        console.log("   Result:", result);
        console.log("   programId:", result.programId);
        console.log("   vertexShader:", result.vertexShader);
        console.log("   fragmentShader:", result.fragmentShader);

        if (result.programId === 0) {
            console.error("   ⚠️ programId is 0 - shaders not compiling in GL context!");
        }
    } catch (e) {
        console.error("   createProgram error:", e);
    }

    // Try createVertexArray
    console.log("10. Testing createVertexArray...");
    try {
        const indexBuf = new Uint8Array([0, 1, 2]);
        const result = patchrs.native.createVertexArray(indexBuf, []);
        console.log("   Result:", result);
        console.log("   base:", result.base);
        console.log("   indexBuffer:", result.indexBuffer);

        if (result.base === undefined) {
            console.error("   ⚠️ base is undefined - vertex array not created properly!");
        }
    } catch (e) {
        console.error("   createVertexArray error:", e);
    }

    console.log("=== End Diagnostics ===");
}

/**
 * Test terrain-conforming overlay
 * Creates a mesh that follows the terrain heightmap
 */
export async function testTerrainConforming(): Promise<{ stop: () => void; overlayid: patchrs.GlOverlay } | null> {
    try {
        if (!patchrs.native) {
            console.log("[testTerrainConforming] Native not available");
            return null;
        }

        logMemory("before testTerrainConforming");

        // Find floor render to get current position
        const renders = await patchrs.native.recordRenderCalls({ maxframes: 1,
            features: ["vertexarray", "uniforms"],
            hasInput: "aMaterialSettingsSlotXY3" // IPC optimization: filter server-side when available
        });

        let floor: patchrs.RenderInvocation | null = null;
        for (const render of renders) {
            if (render.program.inputs.find(q => q.name === "aMaterialSettingsSlotXY3")) {
                floor = render;
                break;
            }
        }

        if (!floor) {
            console.log("[testTerrainConforming] Floor program not found");
            return null;
        }

        // Extract chunk position and base Y from uModelMatrix
        const modelMatrixUniform = floor.program.uniforms.find(u => u.name === "uModelMatrix");
        let chunkWorldX = 0;
        let chunkWorldY = 0;
        let chunkWorldZ = 0;
        if (modelMatrixUniform && floor.uniformState) {
            const offset = modelMatrixUniform.snapshotOffset;
            const view = new DataView(floor.uniformState.buffer, floor.uniformState.byteOffset + offset);
            chunkWorldX = view.getFloat32(12 * 4, true); // Matrix[12] = X translation
            chunkWorldY = view.getFloat32(13 * 4, true); // Matrix[13] = Y translation (chunk base height)
            chunkWorldZ = view.getFloat32(14 * 4, true); // Matrix[14] = Z translation
        }

        console.log(`[testTerrainConforming] Chunk position: X=${chunkWorldX}, Y=${chunkWorldY}, Z=${chunkWorldZ}`);

        // Convert to chunk coords
        const chunkX = Math.floor(chunkWorldX / CHUNK_SIZE / TILE_SIZE);
        const chunkZ = Math.floor(chunkWorldZ / CHUNK_SIZE / TILE_SIZE);

        console.log(`[testTerrainConforming] Fetching height data for chunk ${chunkX}, ${chunkZ}`);

        // Fetch height data
        const heightData = await fetchHeightData(chunkX, chunkZ, 0);
        if (!heightData) {
            console.log("[testTerrainConforming] No height data available, falling back to flat");
            return null;
        }

        // Create terrain-conforming mesh
        // Center around the chunk origin, create a grid of vertices
        const gridSize = 16; // 16x16 grid
        const tileSpan = 8; // Span 8 tiles in each direction from center

        const pos: number[] = [];
        const color: number[] = [];
        const indices: number[] = [];

        const rootX = -tileSpan * TILE_SIZE;
        const rootZ = -tileSpan * TILE_SIZE;

        console.log(`[testTerrainConforming] chunkWorldY: ${chunkWorldY}`);

        // Create vertices with terrain-conforming heights
        for (let gz = 0; gz <= gridSize; gz++) {
            for (let gx = 0; gx <= gridSize; gx++) {
                // Local tile position within chunk (0-63)
                const tileX = Math.floor(CHUNK_SIZE / 2) - tileSpan + gx;
                const tileZ = Math.floor(CHUNK_SIZE / 2) - tileSpan + gz;

                // Clamp to valid range
                const clampedTileX = Math.max(0, Math.min(CHUNK_SIZE - 1, tileX));
                const clampedTileZ = Math.max(0, Math.min(CHUNK_SIZE - 1, tileZ));

                // Get height at this tile (interpolated from 4 corners)
                const rawHeight = getHeightAtTile(heightData, clampedTileX, clampedTileZ, 0.5, 0.5);
                // Log first and last vertex heights to see variation
                if (gx === 0 && gz === 0) {
                    console.log(`[testTerrainConforming] Height at (${clampedTileX},${clampedTileZ}): ${rawHeight}`);
                }
                if (gx === gridSize && gz === gridSize) {
                    console.log(`[testTerrainConforming] Height at (${clampedTileX},${clampedTileZ}): ${rawHeight}`);
                }
                // Use absolute height from heightmap, offset by chunk Y
                // This is what worked before - gives actual terrain variation
                const y = rawHeight - chunkWorldY + 5;

                // World position relative to chunk center
                const worldX = rootX + gx * (2 * tileSpan * TILE_SIZE / gridSize);
                const worldZ = rootZ + gz * (2 * tileSpan * TILE_SIZE / gridSize);

                pos.push(worldX, y, worldZ);

                // Color gradient based on position
                const r = Math.floor((gx / gridSize) * 255);
                const g = Math.floor((gz / gridSize) * 255);
                const b = 128;

                // Calculate edge fade - distance from center (0-1), fade at edges
                const centerDistX = Math.abs(gx - gridSize / 2) / (gridSize / 2); // 0 at center, 1 at edge
                const centerDistZ = Math.abs(gz - gridSize / 2) / (gridSize / 2);
                const edgeDist = Math.max(centerDistX, centerDistZ); // Use max for square falloff
                // Fade starts at 70% from center, fully faded at edge
                const fade = edgeDist > 0.7 ? Math.max(0, 1 - (edgeDist - 0.7) / 0.3) : 1;

                // Apply fade to RGB values (darker at edges)
                color.push(Math.floor(r * fade), Math.floor(g * fade), Math.floor(b * fade));
            }
        }

        // Create triangle indices
        const gridWidth = gridSize + 1;
        for (let gz = 0; gz < gridSize; gz++) {
            for (let gx = 0; gx < gridSize; gx++) {
                const topLeft = gz * gridWidth + gx;
                const topRight = topLeft + 1;
                const bottomLeft = (gz + 1) * gridWidth + gx;
                const bottomRight = bottomLeft + 1;

                // Two triangles per quad
                indices.push(topLeft, bottomLeft, topRight);
                indices.push(topRight, bottomLeft, bottomRight);
            }
        }

        console.log(`[testTerrainConforming] Created mesh: ${pos.length / 3} vertices, ${indices.length / 3} triangles`);

        const GL_FLOAT_LOCAL = 0x1406;
        const GL_FLOAT_MAT4_LOCAL = 0x8B5C;

        // Shader that passes color through
        const prog = patchrs.native.createProgram(
            `#version 330 core
            layout (location = 0) in vec3 aPos;
            layout (location = 6) in vec3 aColor;
            uniform highp mat4 uModelMatrix;
            uniform highp mat4 uViewProjMatrix;
            out vec3 ourColor;
            void main() {
                vec4 worldpos = uModelMatrix * vec4(aPos, 1.);
                gl_Position = uViewProjMatrix * worldpos;
                ourColor = aColor;
            }`,
            `#version 330 core
            in vec3 ourColor;
            out vec4 FragColor;
            void main() {
                FragColor = vec4(ourColor, 0.7);
            }`,
            [
                { location: 0, name: "aPos", type: GL_FLOAT_LOCAL, length: 3 },
                { location: 6, name: "aColor", type: GL_FLOAT_LOCAL, length: 3 }
            ],
            [
                { name: "uModelMatrix", length: 1, type: GL_FLOAT_MAT4_LOCAL, snapshotOffset: 0, snapshotSize: 4 * 16 },
                { name: "uViewProjMatrix", length: 1, type: GL_FLOAT_MAT4_LOCAL, snapshotOffset: 4 * 16, snapshotSize: 4 * 16 }
            ]
        );

        // Convert to typed arrays with correct format
        const indexBuffer = new Uint8Array(new Uint16Array(indices).buffer);

        // Interleave position and color (as floats normalized from 0-255)
        const vertexData: number[] = [];
        for (let i = 0; i < pos.length / 3; i++) {
            vertexData.push(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
            vertexData.push(color[i * 3] / 255, color[i * 3 + 1] / 255, color[i * 3 + 2] / 255);
        }
        const vertexBuffer = new Uint8Array(new Float32Array(vertexData).buffer);

        const vertex = patchrs.native.createVertexArray(indexBuffer, [
            { location: 0, buffer: vertexBuffer, enabled: true, normalized: false, offset: 0, stride: 6 * 4, scalartype: GL_FLOAT_LOCAL, vectorlength: 3 },
            { location: 6, buffer: vertexBuffer, enabled: true, normalized: false, offset: 3 * 4, stride: 6 * 4, scalartype: GL_FLOAT_LOCAL, vectorlength: 3 },
        ]);

        const overlayid = await patchrs.native.beginOverlay({ programId: floor.program.programId }, prog, vertex, {
            uniformSources: [
                { name: "uModelMatrix", sourceName: "uModelMatrix", type: "program" },
                { name: "uViewProjMatrix", sourceName: "uViewProjMatrix", type: "program" },
            ]
        });

        console.log(`[testTerrainConforming] Created terrain overlay ${overlayid}`);
        logMemory("after terrain overlay");

        return {
            stop: () => {
                overlayid.stop();
                console.log("[testTerrainConforming] Stopped");
            },
            overlayid
        };
    } catch (e) {
        console.error("[testTerrainConforming] Error:", e);
        return null;
    }
}

// ============================================================================
// Floor Visualization — renders all visible floor chunks color-coded by level
// ============================================================================

const FLOOR_COLORS: [number, number, number, number][] = [
    [40, 200, 80, 140],    // Floor 0 (ground) — green
    [60, 130, 230, 140],   // Floor 1 — blue
    [180, 60, 220, 140],   // Floor 2 — purple
    [230, 160, 40, 140],   // Floor 3 — orange
    [220, 60, 60, 140],    // Floor 4 — red
    [60, 220, 220, 140],   // Floor 5 — cyan
];

let floorVizOverlays: patchrs.GlOverlay[] = [];

/**
 * Visualize all visible floor chunks as color-coded overlays.
 * Each floor level gets a distinct color. Shows chunk boundaries,
 * floor level, and world Y position.
 *
 * Call `stopFloorViz()` (or `clearFloorViz()`) to remove.
 */
export async function visualizeFloors(): Promise<{ chunkCount: number; stop: () => void }> {
    // Clean up previous visualization
    stopFloorViz();

    if (!patchrs.native) {
        console.error("[FloorViz] Native addon not available");
        return { chunkCount: 0, stop: stopFloorViz };
    }

    // Capture renders and filter for floor programs client-side.
    // No timeout (causes native addon to return 0), no hasInput (filter locally).
    let renders: patchrs.RenderInvocation[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
        const allRenders = await patchrs.native.recordRenderCalls({
            maxframes: 1,
            features: ["uniforms"],
        });
        renders = allRenders.filter((r: any) => r.program?.inputs?.find((q: any) => q.name === "aMaterialSettingsSlotXY3"));
        console.log(`[FloorViz] Attempt ${attempt + 1}: ${allRenders.length} total, ${renders.length} floor renders`);
        if (renders.length > 0) break;
        if (attempt < 2) {
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
    if (renders.length === 0) {
        console.error("[FloorViz] No floor renders found after 3 attempts");
        return { chunkCount: 0, stop: stopFloorViz };
    }

    // Group by chunk, collect unique floors (deduplicate by vaoId)
    const chunkMap = new Map<string, { chunkX: number; chunkZ: number; floors: { modelY: number; vaoId: number }[] }>();

    for (const render of renders) {
        if (!render.program.inputs.find((q: any) => q.name === "aMaterialSettingsSlotXY3")) continue;
        const info = getChunkFromRender(render);
        if (!info) continue;

        const key = `${info.chunkX},${info.chunkZ}`;
        if (!chunkMap.has(key)) {
            chunkMap.set(key, { chunkX: info.chunkX, chunkZ: info.chunkZ, floors: [] });
        }
        const chunk = chunkMap.get(key)!;
        // Deduplicate: skip if we already have this vaoId (same geometry drawn in multiple passes)
        if (!chunk.floors.some(f => f.vaoId === render.vertexObjectId)) {
            chunk.floors.push({ modelY: info.modelY, vaoId: render.vertexObjectId });
        }
    }

    console.log(`[FloorViz] Found ${chunkMap.size} chunks with ${renders.length} render calls (deduplicated to unique VAOs)`);
    console.log(`[FloorViz] Color key: 🟢 Floor 0  🔵 Floor 1  🟣 Floor 2  🟠 Floor 3  🔴 Floor 4  🩵 Floor 5`);

    // Sort floors within each chunk by Y ascending (lowest = floor 0)
    for (const chunk of chunkMap.values()) {
        chunk.floors.sort((a, b) => a.modelY - b.modelY);
    }

    // Create overlays — one border-only rect per chunk per floor level
    const overlays: patchrs.GlOverlay[] = [];

    for (const [key, chunk] of chunkMap) {
        for (let floorIdx = 0; floorIdx < chunk.floors.length; floorIdx++) {
            const floor = chunk.floors[floorIdx];
            const color = FLOOR_COLORS[floorIdx % FLOOR_COLORS.length];

            // Cache this floor data
            cacheChunkFloor(chunk.chunkX, chunk.chunkZ, floorIdx, floor.vaoId, floor.modelY);

            // Inset each floor level slightly so stacked floors are visible
            const inset = floorIdx * 2; // tiles inward per level

            const minLng = chunk.chunkX * CHUNK_SIZE + inset;
            const maxLng = (chunk.chunkX + 1) * CHUNK_SIZE - 1 - inset;
            const minLat = chunk.chunkZ * CHUNK_SIZE + inset;
            const maxLat = (chunk.chunkZ + 1) * CHUNK_SIZE - 1 - inset;

            // Skip if inset consumed the entire chunk
            if (minLng > maxLng || minLat > maxLat) continue;

            try {
                const overlay = await addRectMarker({
                    minLat, maxLat, minLng, maxLng,
                    color,
                    filled: false,     // Border only — shows chunk boundary
                    thickness: 0.08,
                    floor: floorIdx,
                    skipIfNotVisible: true
                });

                if (overlay) {
                    overlays.push(overlay);
                    console.log(
                        `  Chunk (${chunk.chunkX}, ${chunk.chunkZ}) floor ${floorIdx}: ` +
                        `Y=${floor.modelY.toFixed(0)} vaoId=${floor.vaoId} ` +
                        `[${maxLng - minLng + 1}x${maxLat - minLat + 1} tiles]`
                    );
                }
            } catch (e) {
                console.warn(`[FloorViz] Failed overlay for chunk ${key} floor ${floorIdx}:`, e);
            }
        }
    }

    floorVizOverlays = overlays;
    console.log(`[FloorViz] Created ${overlays.length} overlays across ${chunkMap.size} chunks`);

    return { chunkCount: chunkMap.size, stop: stopFloorViz };
}

/**
 * Remove all floor visualization overlays.
 */
export function stopFloorViz(): void {
    for (const overlay of floorVizOverlays) {
        try { overlay.stop(); } catch (_) {}
    }
    if (floorVizOverlays.length > 0) {
        console.log(`[FloorViz] Cleared ${floorVizOverlays.length} overlays`);
    }
    floorVizOverlays = [];
}

// ============================================================================
// Height Data Heatmap Visualization
// ============================================================================

let heightmapVizOverlays: patchrs.GlOverlay[] = [];

/**
 * Map a normalized value (0-1) to a heatmap color.
 * Blue (low) → Cyan → Green → Yellow → Red (high)
 */
function heatmapColor(t: number): [number, number, number, number] {
    t = Math.max(0, Math.min(1, t));
    let r: number, g: number, b: number;
    if (t < 0.25) {
        const s = t / 0.25;
        r = 0; g = Math.floor(255 * s); b = 255;
    } else if (t < 0.5) {
        const s = (t - 0.25) / 0.25;
        r = 0; g = 255; b = Math.floor(255 * (1 - s));
    } else if (t < 0.75) {
        const s = (t - 0.5) / 0.25;
        r = Math.floor(255 * s); g = 255; b = 0;
    } else {
        const s = (t - 0.75) / 0.25;
        r = 255; g = Math.floor(255 * (1 - s)); b = 0;
    }
    return [r, g, b, 255];
}

/**
 * Visualize height data as a colored heatmap over visible chunks.
 * Each tile is colored based on its terrain height — blue (low) through red (high).
 * Heights are normalized per-chunk for maximum contrast.
 *
 * @param level - Height data level (0-3, default 0 = ground floor)
 * @param resolution - Tile step (1 = every tile, 2 = every other, etc.)
 *
 * Call `stopHeightmapViz()` to remove.
 */
export async function visualizeHeightmap(level: number = 0, resolution: number = 1): Promise<{ chunkCount: number; stop: () => void }> {
    stopHeightmapViz();

    if (!patchrs.native) {
        console.error("[HeightmapViz] Native addon not available");
        return { chunkCount: 0, stop: stopHeightmapViz };
    }

    // Capture WITHOUT hasInput to bypass IPC-level filtering entirely.
    // The hasInput filter in ipc-handlers.ts runs on native objects before
    // serialization — if it fails silently, we get 0 renders.
    let renders: patchrs.RenderInvocation[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
        const allRenders = await patchrs.native.recordRenderCalls({
            maxframes: 1,
            features: ["uniforms"],
        });
        console.log(`[HeightmapViz] Attempt ${attempt + 1}: ${allRenders.length} total renders from capture`);

        // Client-side filter for floor programs
        renders = allRenders.filter((r: any) => {
            const inputs = r.program?.inputs;
            if (!inputs) return false;
            return inputs.find((q: any) => q.name === "aMaterialSettingsSlotXY3");
        });
        console.log(`[HeightmapViz]   Floor renders after client filter: ${renders.length}`);

        if (renders.length === 0 && allRenders.length > 0) {
            // Log sample program input names to diagnose
            const samples = allRenders.slice(0, 5).map((r: any) => ({
                progId: r.program?.programId,
                inputCount: r.program?.inputs?.length ?? 0,
                inputNames: r.program?.inputs?.map?.((i: any) => i.name)?.slice?.(0, 3) ?? [],
            }));
            console.log(`[HeightmapViz]   Sample programs:`, JSON.stringify(samples));
        }

        if (renders.length > 0) break;
        if (attempt < 2) {
            console.log(`[HeightmapViz] Retrying in 500ms...`);
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
    if (renders.length === 0) {
        console.error("[HeightmapViz] No floor renders found after 3 attempts");
        return { chunkCount: 0, stop: stopHeightmapViz };
    }

    // Get unique chunks (first vaoId per chunk is enough for triggering)
    const chunkMap = new Map<string, { chunkX: number; chunkZ: number; vaoId: number; modelY: number }>();
    for (const render of renders) {
        if (!render.program.inputs.find((q: any) => q.name === "aMaterialSettingsSlotXY3")) continue;
        const info = getChunkFromRender(render);
        if (!info) continue;
        const key = `${info.chunkX},${info.chunkZ}`;
        if (!chunkMap.has(key)) {
            chunkMap.set(key, { chunkX: info.chunkX, chunkZ: info.chunkZ, vaoId: render.vertexObjectId, modelY: info.modelY });
        }
    }

    console.log(`[HeightmapViz] Found ${chunkMap.size} visible chunks, fetching height data for level ${level}...`);

    const overlays: patchrs.GlOverlay[] = [];
    const heightScaling = TILE_SIZE / 32;
    const rootx = -CHUNK_SIZE / 2 * TILE_SIZE;
    const rootz = -CHUNK_SIZE / 2 * TILE_SIZE;

    for (const [key, chunk] of chunkMap) {
        const heightData = await fetchHeightData(chunk.chunkX, chunk.chunkZ, level);
        if (!heightData) {
            console.log(`[HeightmapViz] No height data for chunk ${key} level ${level}`);
            continue;
        }

        // Find min/max heights for per-chunk normalization
        let minH = Infinity, maxH = -Infinity;
        for (let z = 0; z < CHUNK_SIZE; z += resolution) {
            for (let x = 0; x < CHUNK_SIZE; x += resolution) {
                const idx = (x + z * CHUNK_SIZE) * 5;
                const avg = (heightData[idx] + heightData[idx + 1] + heightData[idx + 2] + heightData[idx + 3]) / 4;
                if (avg > 0) {
                    minH = Math.min(minH, avg);
                    maxH = Math.max(maxH, avg);
                }
            }
        }

        if (minH === Infinity) {
            console.log(`[HeightmapViz] No valid height data in chunk ${key}`);
            continue;
        }
        const range = maxH - minH || 1;

        // Build per-tile solid quads with height-based colors
        const pos: number[] = [];
        const colorData: number[] = [];
        const indices: number[] = [];
        let vertexIndex = 0;

        for (let tz = 0; tz < CHUNK_SIZE; tz += resolution) {
            for (let tx = 0; tx < CHUNK_SIZE; tx += resolution) {
                const tileIdx = (tx + tz * CHUNK_SIZE) * 5;
                const avg = (heightData[tileIdx] + heightData[tileIdx + 1] + heightData[tileIdx + 2] + heightData[tileIdx + 3]) / 4;
                if (avg === 0) continue;

                const t = (avg - minH) / range;
                const col = heatmapColor(t);
                const heightOffset = 2 / 32;

                // Add vertex at sub-tile corner with bilinear height interpolation
                const addVert = (subx: number, subz: number): number => {
                    const dx = 0.5 + subx;
                    const dz = 0.5 + subz;
                    const y00 = heightData[tileIdx + 0] * heightScaling * (1 - dx) * (1 - dz);
                    const y01 = heightData[tileIdx + 1] * heightScaling * dx * (1 - dz);
                    const y10 = heightData[tileIdx + 2] * heightScaling * (1 - dx) * dz;
                    const y11 = heightData[tileIdx + 3] * heightScaling * dx * dz;

                    pos.push(
                        (tx + dx) * TILE_SIZE + rootx,
                        y00 + y01 + y10 + y11 + heightOffset * TILE_SIZE,
                        (tz + dz) * TILE_SIZE + rootz
                    );
                    colorData.push(col[0], col[1], col[2], 255);
                    return vertexIndex++;
                };

                const v0 = addVert(-0.5, -0.5); // SW
                const v1 = addVert(0.5, -0.5);  // SE
                const v2 = addVert(0.5, 0.5);   // NE
                const v3 = addVert(-0.5, 0.5);  // NW

                indices.push(v0, v2, v1);
                indices.push(v0, v3, v2);
            }
        }

        if (indices.length === 0) continue;

        // Create overlay program and buffers (same pattern as createMarkerOverlay)
        const uniforms = new UniformSnapshotBuilder({
            uModelMatrix: "mat4",
            uViewProjMatrix: "mat4",
            uAmbientColour: "vec3",
            uSunlightViewMatrix: "mat4",
            uSunColour: "vec3",
            uMouse: "vec2"
        });

        const uniformSources: patchrs.OverlayUniformSource[] = [
            { type: "program", name: "uViewProjMatrix", sourceName: "uViewProjMatrix" },
            { type: "program", name: "uAmbientColour", sourceName: "uAmbientColour" },
            { type: "program", name: "uSunlightViewMatrix", sourceName: "uSunlightViewMatrix" },
            { type: "program", name: "uSunColour", sourceName: "uSunColour" },
            { type: "builtin", name: "uMouse", sourceName: "mouse" }
        ];

        const program = patchrs.native.createProgram(VERT_SHADER_LIGHTING, FRAG_SHADER_LIGHTING, [
            { location: 0, name: "aPos", type: GL_FLOAT, length: 3 },
            { location: 6, name: "aColor", type: GL_UNSIGNED_BYTE, length: 3 }
        ], uniforms.args);

        uniforms.mappings.uModelMatrix.write(positionMatrix(
            (chunk.chunkX + 0.5) * TILE_SIZE * CHUNK_SIZE,
            HEIGHT_SCALING,
            (chunk.chunkZ + 0.5) * TILE_SIZE * CHUNK_SIZE
        ));

        const indexBuffer = new Uint8Array(new Uint16Array(indices).buffer);
        const posBuffer = new Uint8Array(Float32Array.from(pos).buffer);
        const colBuffer = new Uint8Array(Uint8Array.from(colorData).buffer);

        const vertex = patchrs.native.createVertexArray(indexBuffer, [
            { location: 0, buffer: posBuffer, enabled: true, normalized: false, offset: 0, scalartype: GL_FLOAT, stride: 3 * 4, vectorlength: 3 },
            { location: 6, buffer: colBuffer, enabled: true, normalized: true, offset: 0, scalartype: GL_UNSIGNED_BYTE, stride: 4, vectorlength: 3 }
        ]);

        try {
            const overlay = await patchrs.native.beginOverlay(
                { skipProgramMask: wrongProgramMask, vertexObjectId: chunk.vaoId },
                program,
                vertex,
                { uniformSources, uniformBuffer: new Uint8Array(uniforms.buffer.buffer), ranges: [{ start: 0, length: indices.length }] }
            );
            overlays.push(overlay);
            console.log(
                `  Chunk (${chunk.chunkX},${chunk.chunkZ}): ` +
                `${indices.length / 3} triangles, height ${minH.toFixed(0)}\u2013${maxH.toFixed(0)} (range ${range.toFixed(0)})`
            );
        } catch (e) {
            console.warn(`[HeightmapViz] Failed overlay for chunk ${key}:`, e);
        }
    }

    heightmapVizOverlays = overlays;
    console.log(`[HeightmapViz] Created ${overlays.length} heatmap overlays (blue=low, green=mid, red=high)`);
    return { chunkCount: chunkMap.size, stop: stopHeightmapViz };
}

/**
 * Remove all heightmap visualization overlays.
 */
export function stopHeightmapViz(): void {
    for (const overlay of heightmapVizOverlays) {
        try { overlay.stop(); } catch (_) {}
    }
    if (heightmapVizOverlays.length > 0) {
        console.log(`[HeightmapViz] Cleared ${heightmapVizOverlays.length} overlays`);
    }
    heightmapVizOverlays = [];
}

// Expose for console debugging
if (typeof globalThis !== 'undefined') {
    (globalThis as any).testExact = testExact;
    (globalThis as any).testSimple = testSimple;
    (globalThis as any).testBasic = testBasic;
    (globalThis as any).testOverlay = testOverlay;
    (globalThis as any).testOverlayAt = testOverlayAt;
    (globalThis as any).debugFloorMatrix = debugFloorMatrix;
    (globalThis as any).addRectMarker = addRectMarker;
    (globalThis as any).addRadiusMarker = addRadiusMarker;
    (globalThis as any).addTileMarker = addTileMarker;
    (globalThis as any).addNPCWanderMarker = addNPCWanderMarker;
    (globalThis as any).addObjectTilesBatched = addObjectTilesBatched;
    (globalThis as any).clearAllOverlays = clearAllOverlays;
    (globalThis as any).checkMemory = checkMemory;
    (globalThis as any).debugProgram = debugProgram;
    (globalThis as any).testFrameEnd = testFrameEnd;
    (globalThis as any).checkNative = checkNative;
    (globalThis as any).testTerrainConforming = testTerrainConforming;
    (globalThis as any).visualizeFloors = visualizeFloors;
    (globalThis as any).stopFloorViz = stopFloorViz;
    (globalThis as any).visualizeHeightmap = visualizeHeightmap;
    (globalThis as any).stopHeightmapViz = stopHeightmapViz;
    // Also use ov4 like alt1gl does
    (globalThis as any).ov4 = testExact;
}
