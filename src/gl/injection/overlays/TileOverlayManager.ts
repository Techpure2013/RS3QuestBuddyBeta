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
// Creates flowing energy wall effect with horizontal distortion based on height
// aColor.a encodes the normalized height (0=bottom, 1=top)
// ============================================================================
const barrierVertShader = `
    #version 330 core
    layout (location = 0) in vec3 aPos;
    layout (location = 6) in vec4 aColor;  // RGBA where A = height factor (0-1)
    uniform highp mat4 uModelMatrix;
    uniform highp mat4 uViewProjMatrix;
    uniform highp float uTime;
    out vec4 ourColor;
    out vec3 FragPos;
    out float vHeight;

    void main() {
        // Height is encoded in alpha channel (0=bottom, 1=top)
        vHeight = aColor.a;

        // Simple transform - no wave animation for now
        vec4 worldpos = uModelMatrix * vec4(aPos, 1.0);

        gl_Position = uViewProjMatrix * worldpos;
        FragPos = worldpos.xyz / worldpos.w;
        ourColor = aColor;
    }`;

// Barrier Fragment Shader - Volumetric flame effect inspired by Shadertoy MdX3zr
// Uses FBM noise for realistic fire with color gradient
const barrierFragShader = `
    #version 330 core
    in vec3 FragPos;
    in vec4 ourColor;
    in float vHeight;
    uniform mat4 uSunlightViewMatrix;
    uniform vec3 uSunColour;
    uniform vec3 uAmbientColour;
    uniform float uTime;
    out vec4 FragColor;

    // Hash function for noise
    float hash(vec3 p) {
        p = fract(p * 0.3183099 + 0.1);
        p *= 17.0;
        return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
    }

    // 3D noise
    float noise(vec3 p) {
        vec3 i = floor(p);
        vec3 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);

        return mix(
            mix(mix(hash(i + vec3(0,0,0)), hash(i + vec3(1,0,0)), f.x),
                mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
            mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
                mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y),
            f.z
        );
    }

    // Fractal Brownian Motion - creates realistic fire turbulence
    float fbm(vec3 p) {
        float value = 0.0;
        float amplitude = 0.5;
        float frequency = 1.0;
        for (int i = 0; i < 5; i++) {
            value += amplitude * noise(p * frequency);
            amplitude *= 0.5;
            frequency *= 2.0;
        }
        return value;
    }

    void main() {
        // World-space coordinates for consistent fire pattern
        vec3 p = FragPos * 0.015;

        // Rising fire motion - flames move upward over time
        float t = uTime * 0.7;
        p.y -= t * 0.8;  // Upward flow

        // Multiple noise octaves for fire turbulence
        float n = fbm(p * 3.0 + vec3(0, -t * 2.0, 0));
        float n2 = fbm(p * 5.0 + vec3(100, -t * 3.0, 50));

        // Fire shape - denser at bottom, sparse at top
        float fireShape = n * 0.7 + n2 * 0.3;
        fireShape = fireShape * (1.0 - vHeight * 0.6);  // Fade toward top

        // Add some horizontal flicker
        float flicker = sin(FragPos.x * 0.1 + t * 5.0) * 0.1;
        fireShape += flicker * (1.0 - vHeight);

        // Threshold for flame visibility - creates holes in the fire
        // Lower threshold means more visible flame
        float threshold = vHeight * 0.3 + 0.1;
        if (fireShape < threshold) {
            discard;
        }

        // Fire color gradient: yellow core -> orange -> red -> dark at edges
        // Base color from vertex (allows customization via marker.color)
        vec3 baseColor = ourColor.rgb;

        // Fire intensity based on noise and height
        float intensity = smoothstep(threshold, threshold + 0.3, fireShape);
        intensity *= (1.0 - vHeight * 0.3);  // Dimmer at top

        // Color temperature - hotter (brighter) at core, cooler at edges
        vec3 hotColor = vec3(1.0, 0.9, 0.3);   // Yellow-white core
        vec3 warmColor = vec3(1.0, 0.5, 0.0);  // Orange mid
        vec3 coolColor = baseColor;             // User color (cyan default) at edge

        // Blend colors based on intensity
        vec3 fireColor;
        if (intensity > 0.7) {
            fireColor = mix(warmColor, hotColor, (intensity - 0.7) / 0.3);
        } else if (intensity > 0.4) {
            fireColor = mix(coolColor, warmColor, (intensity - 0.4) / 0.3);
        } else {
            fireColor = coolColor * (intensity / 0.4);
        }

        // Add glow effect
        float glow = smoothstep(0.0, 0.5, intensity) * 0.3;
        fireColor += vec3(glow * 0.5, glow * 0.3, glow * 0.1);

        // Alpha based on intensity - more transparent at edges
        float alpha = smoothstep(threshold, threshold + 0.2, fireShape);
        alpha = min(alpha, 0.95);  // Never fully opaque

        FragColor = vec4(fireColor, alpha);
    }`;

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

// ============================================================================
// Text Label Vertex Shader - Billboard effect (always faces camera)
// Rotates text around Y axis to face the camera
// ============================================================================

const textVertShader = `
    #version 330 core
    layout (location = 0) in vec3 aPos;
    layout (location = 6) in vec3 aColor;
    uniform highp mat4 uModelMatrix;
    uniform highp mat4 uViewProjMatrix;
    uniform highp vec3 uTextCenter;  // Center of the text in local coords
    out vec4 ourColor;
    out vec3 FragPos;

    void main() {
        // First transform everything to world space
        vec4 worldCenter = uModelMatrix * vec4(uTextCenter, 1.0);
        vec4 worldPos = uModelMatrix * vec4(aPos, 1.0);

        // Get offset from center in world space
        vec3 offset = worldPos.xyz - worldCenter.xyz;

        // Extract camera forward from ViewProj matrix (third column)
        // This points from camera towards scene
        vec3 camForward = normalize(vec3(uViewProjMatrix[0][2], uViewProjMatrix[1][2], uViewProjMatrix[2][2]));

        // For Y-axis billboard, project forward onto XZ plane and compute right
        vec3 camUp = vec3(0.0, 1.0, 0.0);
        vec3 flatForward = normalize(vec3(camForward.x, 0.0, camForward.z));
        vec3 camRight = cross(camUp, flatForward);

        // Rotate the offset: local X becomes camera right, local Z becomes flat forward
        // Y (height) stays unchanged
        vec3 rotatedOffset = camRight * offset.x + camUp * offset.y + flatForward * offset.z;

        // Final world position
        vec3 finalWorldPos = worldCenter.xyz + rotatedOffset;

        gl_Position = uViewProjMatrix * vec4(finalWorldPos, 1.0);
        FragPos = finalWorldPos;
        ourColor = vec4(aColor, 1.0);
    }`;

// ============================================================================
// Text Label Geometry - Block letters rendered as 3D geometry
// Each character is made of horizontal/vertical bars (7-segment style)
// Text is oriented to face SOUTH (readable when looking from south to north)
// ============================================================================

// Character definitions: array of segments where each segment is [x1, y1, x2, y2] (0-1 range)
// x=0 is left, x=1 is right; y=0 is top, y=1 is bottom
const CHAR_SEGMENTS: { [char: string]: number[][] } = {
    // Digits (7-segment style)
    '0': [[0,0,1,0], [0,0,0,1], [1,0,1,1], [0,1,1,1]],
    '1': [[0.4,0,0.4,1]],
    '2': [[0,0,1,0], [1,0,1,0.5], [0,0.5,1,0.5], [0,0.5,0,1], [0,1,1,1]],
    '3': [[0,0,1,0], [1,0,1,1], [0,0.5,1,0.5], [0,1,1,1]],
    '4': [[0,0,0,0.5], [1,0,1,1], [0,0.5,1,0.5]],
    '5': [[0,0,1,0], [0,0,0,0.5], [0,0.5,1,0.5], [1,0.5,1,1], [0,1,1,1]],
    '6': [[0,0,1,0], [0,0,0,1], [0,0.5,1,0.5], [1,0.5,1,1], [0,1,1,1]],
    '7': [[0,0,1,0], [1,0,1,1]],
    '8': [[0,0,1,0], [0,0,0,1], [1,0,1,1], [0,0.5,1,0.5], [0,1,1,1]],
    '9': [[0,0,1,0], [0,0,0,0.5], [1,0,1,1], [0,0.5,1,0.5], [0,1,1,1]],
    // Letters (block style - horizontal and vertical segments only)
    'A': [[0,0,1,0], [0,0,0,1], [1,0,1,1], [0,0.5,1,0.5]],
    'B': [[0,0,1,0], [0,0,0,1], [1,0,1,0.5], [0,0.5,1,0.5], [1,0.5,1,1], [0,1,1,1]],
    'C': [[0,0,1,0], [0,0,0,1], [0,1,1,1]],
    'D': [[0,0,0.8,0], [0,0,0,1], [0.8,0,0.8,1], [0,1,0.8,1]],
    'E': [[0,0,1,0], [0,0,0,1], [0,0.5,0.7,0.5], [0,1,1,1]],
    'F': [[0,0,1,0], [0,0,0,1], [0,0.5,0.7,0.5]],
    'G': [[0,0,1,0], [0,0,0,1], [0,1,1,1], [1,0.5,1,1], [0.5,0.5,1,0.5]],
    'H': [[0,0,0,1], [1,0,1,1], [0,0.5,1,0.5]],
    'I': [[0,0,1,0], [0.5,0,0.5,1], [0,1,1,1]],
    'J': [[0,0,1,0], [0.6,0,0.6,1], [0,0.8,0.6,1]],
    'K': [[0,0,0,1], [0,0.5,1,0.5], [1,0,1,0.5], [1,0.5,1,1]],
    'L': [[0,0,0,1], [0,1,1,1]],
    'M': [[0,0,0,1], [0,0,0.5,0], [0.5,0,1,0], [1,0,1,1]],
    'N': [[0,0,0,1], [0,0,1,0], [1,0,1,1]],
    'O': [[0,0,1,0], [0,0,0,1], [1,0,1,1], [0,1,1,1]],
    'P': [[0,0,1,0], [0,0,0,1], [1,0,1,0.5], [0,0.5,1,0.5]],
    'Q': [[0,0,1,0], [0,0,0,1], [1,0,1,1], [0,1,1,1]],
    'R': [[0,0,1,0], [0,0,0,1], [1,0,1,0.5], [0,0.5,1,0.5], [0.5,0.5,0.5,0.75], [0.75,0.75,0.75,1]],
    'S': [[0,0,1,0], [0,0,0,0.5], [0,0.5,1,0.5], [1,0.5,1,1], [0,1,1,1]],
    'T': [[0,0,1,0], [0.5,0,0.5,1]],
    'U': [[0,0,0,1], [1,0,1,1], [0,1,1,1]],
    'V': [[0,0,0,0.4], [0.2,0.4,0.2,0.7], [0.4,0.7,0.4,1], [1,0,1,0.4], [0.8,0.4,0.8,0.7], [0.6,0.7,0.6,1], [0.4,1,0.6,1]],
    'W': [[0,0,0,1], [0.25,0.5,0.25,1], [0.5,0.5,0.5,1], [0.75,0.5,0.75,1], [1,0,1,1]],
    'X': [[0,0,0,0.4], [0.3,0.4,0.3,0.6], [0.7,0.4,0.7,0.6], [0,0.6,0,1], [1,0,1,0.4], [1,0.6,1,1]],
    'Y': [[0,0,0,0.5], [1,0,1,0.5], [0,0.5,1,0.5], [0.5,0.5,0.5,1]],
    'Z': [[0,0,1,0], [1,0,1,0.5], [0,0.5,1,0.5], [0,0.5,0,1], [0,1,1,1]],
    // Space - no segments (just advances position)
    ' ': [],
};

/**
 * Generate 3D geometry for a text string
 * Creates UPRIGHT extruded block letters that stand vertically
 * Text is centered at (centerX, centerZ) and stands up from baseHeight
 */
function generateTextGeometry(
    text: string,
    centerX: number,
    centerZ: number,
    baseHeight: number,
    charSize: number,
    color: [number, number, number]
): { pos: number[], colors: number[], indices: number[] } {
    const pos: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];

    const charWidth = charSize * 0.6;    // Character width (along X)
    const charHeight = charSize;          // Character height (along Y - up!)
    const charSpacing = charSize * 0.2;   // Space between characters
    const barThickness = charSize * 0.12; // Thickness of each bar
    const extrudeDepth = charSize * 0.1;  // Depth of text (along Z)

    // Calculate total width for centering
    const totalWidth = text.length * charWidth + (text.length - 1) * charSpacing;

    // Text runs along X axis, characters stand up along Y axis
    let charStartX = centerX - totalWidth / 2;

    let vertexOffset = 0;

    for (const char of text.toUpperCase()) {
        const segments = CHAR_SEGMENTS[char];
        if (!segments) {
            charStartX += charWidth + charSpacing;
            continue;
        }

        for (const seg of segments) {
            // Convert segment coordinates to world space
            // seg X (0=left, 1=right) -> world X
            // seg Y (0=top, 1=bottom) -> world Y (flipped: 0=top means high Y)
            const worldX1 = charStartX + seg[0] * charWidth;
            const worldX2 = charStartX + seg[2] * charWidth;
            // Character Y maps to world Y (height) - flip so top of char is higher
            const worldY1 = baseHeight + (1 - seg[1]) * charHeight;
            const worldY2 = baseHeight + (1 - seg[3]) * charHeight;

            const isHorizontal = Math.abs(seg[1] - seg[3]) < 0.1;
            const isVertical = Math.abs(seg[0] - seg[2]) < 0.1;

            let minX: number, maxX: number, minY: number, maxY: number;

            if (isHorizontal) {
                // Horizontal bar - extends along X
                minX = Math.min(worldX1, worldX2);
                maxX = Math.max(worldX1, worldX2);
                minY = worldY1 - barThickness / 2;
                maxY = worldY1 + barThickness / 2;
            } else if (isVertical) {
                // Vertical bar - extends along Y (up)
                minX = worldX1 - barThickness / 2;
                maxX = worldX1 + barThickness / 2;
                minY = Math.min(worldY1, worldY2);
                maxY = Math.max(worldY1, worldY2);
            } else {
                continue;
            }

            // Create box: X is width, Y is height, Z is depth
            const v0 = vertexOffset;
            const halfDepth = extrudeDepth / 2;

            // Front face (z = centerZ + halfDepth)
            pos.push(minX, minY, centerZ + halfDepth);
            pos.push(maxX, minY, centerZ + halfDepth);
            pos.push(maxX, maxY, centerZ + halfDepth);
            pos.push(minX, maxY, centerZ + halfDepth);

            // Back face (z = centerZ - halfDepth)
            pos.push(minX, minY, centerZ - halfDepth);
            pos.push(maxX, minY, centerZ - halfDepth);
            pos.push(maxX, maxY, centerZ - halfDepth);
            pos.push(minX, maxY, centerZ - halfDepth);

            for (let i = 0; i < 8; i++) {
                colors.push(...color, 255);
            }

            // Front face
            indices.push(v0+0, v0+1, v0+2, v0+0, v0+2, v0+3);
            // Back face
            indices.push(v0+4, v0+6, v0+5, v0+4, v0+7, v0+6);
            // Top face
            indices.push(v0+3, v0+2, v0+6, v0+3, v0+6, v0+7);
            // Bottom face
            indices.push(v0+0, v0+5, v0+1, v0+0, v0+4, v0+5);
            // Left face
            indices.push(v0+0, v0+3, v0+7, v0+0, v0+7, v0+4);
            // Right face
            indices.push(v0+1, v0+5, v0+6, v0+1, v0+6, v0+2);

            vertexOffset += 8;
        }

        charStartX += charWidth + charSpacing;
    }

    return { pos, colors, indices };
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

// Active overlays - keyed by GlOverlay object
const activeOverlays = new Map<patchrs.GlOverlay, { description: string }>();

// Floor program ID (cached)
let floorProgramId: number | null = null;

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

    try {
        // MINIMAL capture - no textures, uniforms, or input data
        // Program info (including inputs metadata) is always included
        const renders = await patchrs.native.recordRenderCalls({ maxframes: 1,
            framecooldown: 100,
            features: [], // Minimal - program info is always included
            skipProgramMask: wrongProgramMask
        });

        for (const render of renders) {
            if (render.program.inputs.find(q => q.name === "aMaterialSettingsSlotXY3")) {
                floorProgramId = render.program.programId;
                console.log(`[TileOverlay] Found floor program ID: ${floorProgramId}`);
                return floorProgramId;
            } else {
                // Mark non-floor programs to skip
                render.program.skipmask |= wrongProgramMask;
            }
        }
        console.warn("[TileOverlay] Floor program not found");
        return null;
    } catch (e) {
        console.error("[TileOverlay] Error finding floor program:", e);
        return null;
    }
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

    console.log(`[TileOverlay] Created rect mesh: ${pos.length / 3} vertices, ${index.length / 3} triangles`);
    console.log(`[TileOverlay] World bounds: X [${minLng * TILE_SIZE}, ${maxLng * TILE_SIZE}], Z [${minLat * TILE_SIZE}, ${maxLat * TILE_SIZE}]`);

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

// Active marker stream
let markerStream: { close: () => void } | null = null;
let knownProgs = new WeakMap<patchrs.GlProgram, {}>();

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

    // Log ALL floor Y values for debugging
    console.log(`[TileOverlay] Chunk (${targetChunkX}, ${targetChunkZ}) all floor Y values: [${chunkRenders.map(f => f.modelY.toFixed(0)).join(", ")}]`);
    console.log(`[TileOverlay] Target floor requested: ${targetFloor}`);

    // Pick the floor matching targetFloor (clamped to available floors)
    const floorIndex = Math.min(targetFloor, chunkRenders.length - 1);
    const selected = chunkRenders[floorIndex];

    console.log(`[TileOverlay] Selected floor index ${floorIndex} with modelY=${selected.modelY.toFixed(0)}`);

    return { render: selected.render, chunkX: selected.chunkX, chunkZ: selected.chunkZ };
}

/**
 * Create overlay for a marker on a specific floor render
 * MATCHES tilemarkers.ts EXACTLY
 */
async function createMarkerOverlay(marker: RectMarker, floor: patchrs.RenderInvocation, chunkX: number, chunkZ: number): Promise<patchrs.GlOverlay | null> {
    // Fetch height data for this chunk
    const heightData = await fetchHeightData(chunkX, chunkZ, marker.floor ?? 0);
    if (!heightData) {
        console.warn("[TileOverlay] Could not load height data");
        return null;
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

    // EXACT copy of tilemarkers.ts writeline function
    const writeline = (x: number, z: number, size: number, vertcol: number[], leftcut: boolean, rightcut: boolean, dir: number): void => {
        const diagcut = 0.2;
        const left = leftcut ? -diagcut : -0.5;
        const right = rightcut ? diagcut : 0.5;

        const v0 = writevertex(x, z, left, -0.5, 0, vertcol, dir);
        const v1 = writevertex(x, z, right, -0.5, 0, vertcol, dir);
        const v2 = writevertex(x, z, right - size, -0.5 + size, 0, vertcol, dir);
        const v3 = writevertex(x, z, left + size, -0.5 + size, 0, vertcol, dir);

        // EXACT index order from tilemarkers.ts (counterclockwise winding)
        indices.push(v0, v2, v1);
        indices.push(v0, v3, v2);
    };

    // Write a solid filled quad (2 triangles covering the entire tile)
    const writeSolidTile = (x: number, z: number, vertcol: number[]): void => {
        // 4 corners of the tile, small height offset to render above terrain
        const heightOffset = 2 / 32;
        const v0 = writevertex(x, z, -0.5, -0.5, heightOffset, vertcol, 0); // SW
        const v1 = writevertex(x, z, 0.5, -0.5, heightOffset, vertcol, 0);  // SE
        const v2 = writevertex(x, z, 0.5, 0.5, heightOffset, vertcol, 0);   // NE
        const v3 = writevertex(x, z, -0.5, 0.5, heightOffset, vertcol, 0);  // NW

        // Two triangles to fill the quad (counterclockwise winding)
        indices.push(v0, v2, v1); // SE triangle
        indices.push(v0, v3, v2); // NW triangle
    };

    // Convert marker lat/lng to INTEGER tile coordinates within chunk
    // +1 offset to X to correct for coordinate system alignment (shift east)
    const minTileX = Math.floor(marker.minLng - chunkX * CHUNK_SIZE) + 1;
    const minTileZ = Math.floor(marker.minLat - chunkZ * CHUNK_SIZE);
    const maxTileX = Math.floor(marker.maxLng - chunkX * CHUNK_SIZE) + 1;
    const maxTileZ = Math.floor(marker.maxLat - chunkZ * CHUNK_SIZE);

    const col = [r, g, b, a];

    console.log(`[TileOverlay] Drawing tiles from (${minTileX}, ${minTileZ}) to (${maxTileX}, ${maxTileZ}), solidFill=${marker.solidFill}`);

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

    console.log(`[TileOverlay] Created mesh: ${pos.length / 3} vertices, ${indices.length / 3} triangles`);

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

    // Position matrix - place at chunk center (like tilemarkers.ts)
    uniforms.mappings.uModelMatrix.write(positionMatrix(
        (chunkX + 0.5) * TILE_SIZE * CHUNK_SIZE,
        TILE_SIZE / 32,
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

    const overlayId = await patchrs.native.beginOverlay(
        { skipProgramMask: wrongProgramMask, vertexObjectId: floor.vertexObjectId },
        program,
        vertex,
        {
            uniformSources: uniformSources,
            uniformBuffer: new Uint8Array(uniforms.buffer.buffer),
            ranges: renderRanges
        }
    );

    activeOverlays.set(overlayId, {
        description: `Rect (${marker.minLng.toFixed(1)},${marker.minLat.toFixed(1)}) to (${marker.maxLng.toFixed(1)},${marker.maxLat.toFixed(1)})`
    });
    console.log(`[TileOverlay] Created overlay ${overlayId} on chunk (${chunkX}, ${chunkZ}), vertexObjectId ${floor.vertexObjectId}`);

    return overlayId;
}

/**
 * Start the marker stream (like floorTracker)
 */
function ensureMarkerStream(): void {
    if (markerStream || !patchrs.native) return;

    console.log("[TileOverlay] Starting marker stream");

    markerStream = patchrs.native.streamRenderCalls({
        features: ["uniforms"],
        framecooldown: 500,
        skipProgramMask: wrongProgramMask
    }, async (renders) => {
        if (pendingMarkers.size === 0) return;

        for (const render of renders) {
            // Check if this is a floor program
            if (!knownProgs.has(render.program)) {
                if (render.program.inputs.find(q => q.name === "aMaterialSettingsSlotXY3")) {
                    knownProgs.set(render.program, {});
                } else {
                    render.program.skipmask |= wrongProgramMask;
                    continue;
                }
            }

            // Get chunk from this render
            const chunkInfo = getChunkFromRender(render);
            if (!chunkInfo) continue;

            const chunkKey = `${chunkInfo.chunkX},${chunkInfo.chunkZ}`;

            // Check if any pending marker is waiting for this chunk
            const pending = pendingMarkers.get(chunkKey);
            if (pending) {
                console.log(`[TileOverlay] Chunk ${chunkKey} visible, creating overlay`);
                pendingMarkers.delete(chunkKey);

                const overlayId = await createMarkerOverlay(pending.marker, render, chunkInfo.chunkX, chunkInfo.chunkZ);
                pending.resolve(overlayId);
            }
        }
    });
}

/**
 * Stop the marker stream
 */
function stopMarkerStream(): void {
    if (markerStream) {
        markerStream.close();
        markerStream = null;
        console.log("[TileOverlay] Stopped marker stream");
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

    console.log(`[TileOverlay] Adding rect at (${marker.minLng.toFixed(1)}, ${marker.minLat.toFixed(1)}) to (${marker.maxLng.toFixed(1)}, ${marker.maxLat.toFixed(1)})`);
    console.log(`[TileOverlay] Target chunk: ${chunkKey}`);

    // First, try to find the chunk immediately
    try {
        const renders = await patchrs.native.recordRenderCalls({ maxframes: 1,
            features: ["uniforms"],
            skipProgramMask: wrongProgramMask
        });

        for (const render of renders) {
            if (render.program.inputs.find(q => q.name === "aMaterialSettingsSlotXY3")) {
                const chunkInfo = getChunkFromRender(render);
                if (chunkInfo && chunkInfo.chunkX === targetChunkX && chunkInfo.chunkZ === targetChunkZ) {
                    console.log(`[TileOverlay] Found chunk immediately`);
                    return await createMarkerOverlay(marker, render, chunkInfo.chunkX, chunkInfo.chunkZ);
                }
            } else {
                render.program.skipmask |= wrongProgramMask;
            }
        }
    } catch (e) {
        console.warn("[TileOverlay] Error checking immediate renders:", e);
    }

    // Chunk not visible yet
    // If skipIfNotVisible is set, return null immediately (for path tiles)
    if (marker.skipIfNotVisible) {
        console.log(`[TileOverlay] Chunk ${chunkKey} not visible, skipping (skipIfNotVisible=true)`);
        return null;
    }

    // Add to pending and start streaming
    console.log(`[TileOverlay] Chunk ${chunkKey} not visible, waiting...`);

    return new Promise((resolve) => {
        pendingMarkers.set(chunkKey, { marker, resolve });
        ensureMarkerStream();

        // Timeout after 30 seconds
        setTimeout(() => {
            if (pendingMarkers.has(chunkKey)) {
                console.warn(`[TileOverlay] Timeout waiting for chunk ${chunkKey}`);
                pendingMarkers.delete(chunkKey);
                resolve(null);

                // Stop stream if no more pending markers
                if (pendingMarkers.size === 0) {
                    stopMarkerStream();
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
 * Create a combined NPC wander overlay with both wander tiles and NPC tile in one mesh
 * This is more efficient (1 draw call) and avoids timing issues
 */
async function createNPCWanderOverlay(
    marker: NPCWanderMarker,
    floor: patchrs.RenderInvocation,
    chunkX: number,
    chunkZ: number
): Promise<patchrs.GlOverlay | null> {
    const heightData = await fetchHeightData(chunkX, chunkZ, marker.floor ?? 0);
    if (!heightData) {
        console.warn("[TileOverlay] Could not load height data for NPC wander overlay");
        return null;
    }

    const pos: number[] = [];
    const colorData: number[] = [];
    const indices: number[] = [];

    const heightScaling = TILE_SIZE / 32;
    const rootx = -CHUNK_SIZE / 2 * TILE_SIZE;
    const rootz = -CHUNK_SIZE / 2 * TILE_SIZE;

    let vertexindex = 0;

    // Barrier wall height in tile units (1 tile = TILE_SIZE world units)
    const barrierHeight = 0.6;  // Tall wall - more visible
    const wallThickness = 0.15; // Width/depth of the wall in tile units

    // Write a 3D wall segment (box shape) for barrier effect
    // Creates a box from ground level up to barrierHeight with wallThickness depth
    const writeBarrierWall = (x: number, z: number, vertcol: number[], dir: number): void => {
        // dir: 0=south, 1=east, 2=north, 3=west
        // Each wall is a 3D box along the tile edge

        // Get base height at the tile corners
        const clampedX = Math.max(0, Math.min(CHUNK_SIZE - 1, x));
        const clampedZ = Math.max(0, Math.min(CHUNK_SIZE - 1, z));
        const tileindex = (clampedX + clampedZ * CHUNK_SIZE) * 5;
        const baseHeight = heightData[tileindex + 0] * heightScaling;

        const thickness = wallThickness * TILE_SIZE;

        // Wall edge endpoints and normal direction for thickness
        let x1: number, z1: number, x2: number, z2: number;
        let nx: number, nz: number; // Normal direction (outward from wander area)

        if (dir === 0) {        // South edge - wall extends in -Z
            x1 = (x + 0) * TILE_SIZE + rootx;
            z1 = (z + 0) * TILE_SIZE + rootz;
            x2 = (x + 1) * TILE_SIZE + rootx;
            z2 = (z + 0) * TILE_SIZE + rootz;
            nx = 0; nz = -1;
        } else if (dir === 1) { // East edge - wall extends in +X
            x1 = (x + 1) * TILE_SIZE + rootx;
            z1 = (z + 0) * TILE_SIZE + rootz;
            x2 = (x + 1) * TILE_SIZE + rootx;
            z2 = (z + 1) * TILE_SIZE + rootz;
            nx = 1; nz = 0;
        } else if (dir === 2) { // North edge - wall extends in +Z
            x1 = (x + 1) * TILE_SIZE + rootx;
            z1 = (z + 1) * TILE_SIZE + rootz;
            x2 = (x + 0) * TILE_SIZE + rootx;
            z2 = (z + 1) * TILE_SIZE + rootz;
            nx = 0; nz = 1;
        } else {                // West edge - wall extends in -X
            x1 = (x + 0) * TILE_SIZE + rootx;
            z1 = (z + 1) * TILE_SIZE + rootz;
            x2 = (x + 0) * TILE_SIZE + rootx;
            z2 = (z + 0) * TILE_SIZE + rootz;
            nx = -1; nz = 0;
        }

        const y0 = baseHeight;                           // Ground level
        const y1 = baseHeight + barrierHeight * TILE_SIZE; // Top of barrier

        // Inner edge (on tile boundary)
        const ix1 = x1, iz1 = z1;
        const ix2 = x2, iz2 = z2;
        // Outer edge (offset by thickness in normal direction)
        const ox1 = x1 + nx * thickness, oz1 = z1 + nz * thickness;
        const ox2 = x2 + nx * thickness, oz2 = z2 + nz * thickness;

        // Color with height encoded in alpha: 0=bottom, 255=top
        const bottomCol = [vertcol[0], vertcol[1], vertcol[2], 0];
        const topCol = [vertcol[0], vertcol[1], vertcol[2], 255];

        // Helper to add a quad (4 vertices, 2 triangles)
        const addQuad = (
            ax: number, ay: number, az: number, acol: number[],
            bx: number, by: number, bz: number, bcol: number[],
            cx: number, cy: number, cz: number, ccol: number[],
            dx: number, dy: number, dz: number, dcol: number[]
        ) => {
            const v0 = vertexindex++;
            pos.push(ax, ay, az); colorData.push(...acol);
            const v1 = vertexindex++;
            pos.push(bx, by, bz); colorData.push(...bcol);
            const v2 = vertexindex++;
            pos.push(cx, cy, cz); colorData.push(...ccol);
            const v3 = vertexindex++;
            pos.push(dx, dy, dz); colorData.push(...dcol);
            // Front face
            indices.push(v0, v1, v2);
            indices.push(v0, v2, v3);
            // Back face
            indices.push(v0, v2, v1);
            indices.push(v0, v3, v2);
        };

        // Outer face (facing outward)
        addQuad(
            ox1, y0, oz1, bottomCol,
            ox2, y0, oz2, bottomCol,
            ox2, y1, oz2, topCol,
            ox1, y1, oz1, topCol
        );

        // Inner face (facing inward toward wander area)
        addQuad(
            ix2, y0, iz2, bottomCol,
            ix1, y0, iz1, bottomCol,
            ix1, y1, iz1, topCol,
            ix2, y1, iz2, topCol
        );

        // Top face
        addQuad(
            ix1, y1, iz1, topCol,
            ix2, y1, iz2, topCol,
            ox2, y1, oz2, topCol,
            ox1, y1, oz1, topCol
        );

        // Bottom face
        addQuad(
            ix1, y0, iz1, bottomCol,
            ox1, y0, oz1, bottomCol,
            ox2, y0, oz2, bottomCol,
            ix2, y0, iz2, bottomCol
        );

        // Left end cap
        addQuad(
            ix1, y0, iz1, bottomCol,
            ox1, y0, oz1, bottomCol,
            ox1, y1, oz1, topCol,
            ix1, y1, iz1, topCol
        );

        // Right end cap
        addQuad(
            ox2, y0, oz2, bottomCol,
            ix2, y0, iz2, bottomCol,
            ix2, y1, iz2, topCol,
            ox2, y1, oz2, topCol
        );
    };
    
    const { bottomLeft, topRight } = marker.wanderRadius;
    const npcTileX = Math.floor(marker.npcLocation.lng - chunkX * CHUNK_SIZE) + 1;
    const npcTileZ = Math.floor(marker.npcLocation.lat - chunkZ * CHUNK_SIZE);

    const minTileX = Math.floor(bottomLeft.lng - chunkX * CHUNK_SIZE) + 1;
    const minTileZ = Math.floor(bottomLeft.lat - chunkZ * CHUNK_SIZE);
    const maxTileX = Math.floor(topRight.lng - chunkX * CHUNK_SIZE) + 1;
    const maxTileZ = Math.floor(topRight.lat - chunkZ * CHUNK_SIZE);

    const wanderCol = [...marker.color];
    // NPC tile: bright red - very noticeable
    const npcCol = marker.npcColor ?? [255, 50, 50, 255];

    const numTilesX = maxTileX - minTileX + 1;
    const numTilesZ = maxTileZ - minTileZ + 1;
    console.log(`[TileOverlay] NPC wander: ${numTilesX}x${numTilesZ} tiles, NPC at (${npcTileX},${npcTileZ})`);

    // Helper to check if a tile is in the wander area
    const isWanderTile = (x: number, z: number): boolean => {
        return x >= minTileX && x <= maxTileX && z >= minTileZ && z <= maxTileZ;
    };

    // Write a corner fill piece where two walls meet
    // corner: 0=SW, 1=SE, 2=NE, 3=NW
    const writeCornerFill = (x: number, z: number, vertcol: number[], corner: number): void => {
        const clampedX = Math.max(0, Math.min(CHUNK_SIZE - 1, x));
        const clampedZ = Math.max(0, Math.min(CHUNK_SIZE - 1, z));
        const tileindex = (clampedX + clampedZ * CHUNK_SIZE) * 5;
        const baseHeight = heightData[tileindex + 0] * heightScaling;

        const thickness = wallThickness * TILE_SIZE;
        const y0 = baseHeight;
        const y1 = baseHeight + barrierHeight * TILE_SIZE;

        // Corner position and offsets based on which corner
        let cx: number, cz: number;
        let ox1: number, oz1: number, ox2: number, oz2: number;

        if (corner === 0) {        // SW corner - south and west walls meet
            cx = (x + 0) * TILE_SIZE + rootx;
            cz = (z + 0) * TILE_SIZE + rootz;
            ox1 = cx - thickness; oz1 = cz;           // West wall outer
            ox2 = cx; oz2 = cz - thickness;           // South wall outer
        } else if (corner === 1) { // SE corner - south and east walls meet
            cx = (x + 1) * TILE_SIZE + rootx;
            cz = (z + 0) * TILE_SIZE + rootz;
            ox1 = cx; oz1 = cz - thickness;           // South wall outer
            ox2 = cx + thickness; oz2 = cz;           // East wall outer
        } else if (corner === 2) { // NE corner - north and east walls meet
            cx = (x + 1) * TILE_SIZE + rootx;
            cz = (z + 1) * TILE_SIZE + rootz;
            ox1 = cx + thickness; oz1 = cz;           // East wall outer
            ox2 = cx; oz2 = cz + thickness;           // North wall outer
        } else {                   // NW corner - north and west walls meet
            cx = (x + 0) * TILE_SIZE + rootx;
            cz = (z + 1) * TILE_SIZE + rootz;
            ox1 = cx; oz1 = cz + thickness;           // North wall outer
            ox2 = cx - thickness; oz2 = cz;           // West wall outer
        }

        // Diagonal outer corner
        const diagX = (corner === 0 || corner === 3) ? cx - thickness : cx + thickness;
        const diagZ = (corner === 0 || corner === 1) ? cz - thickness : cz + thickness;

        const bottomCol = [vertcol[0], vertcol[1], vertcol[2], 0];
        const topCol = [vertcol[0], vertcol[1], vertcol[2], 255];

        // Helper to add a quad
        const addQuad = (
            ax: number, ay: number, az: number, acol: number[],
            bx: number, by: number, bz: number, bcol: number[],
            cx: number, cy: number, cz: number, ccol: number[],
            dx: number, dy: number, dz: number, dcol: number[]
        ) => {
            const v0 = vertexindex++;
            pos.push(ax, ay, az); colorData.push(...acol);
            const v1 = vertexindex++;
            pos.push(bx, by, bz); colorData.push(...bcol);
            const v2 = vertexindex++;
            pos.push(cx, cy, cz); colorData.push(...ccol);
            const v3 = vertexindex++;
            pos.push(dx, dy, dz); colorData.push(...dcol);
            indices.push(v0, v1, v2);
            indices.push(v0, v2, v3);
            indices.push(v0, v2, v1);
            indices.push(v0, v3, v2);
        };

        // Top face of corner fill (square)
        addQuad(
            cx, y1, cz, topCol,
            ox1, y1, oz1, topCol,
            diagX, y1, diagZ, topCol,
            ox2, y1, oz2, topCol
        );

        // Bottom face
        addQuad(
            cx, y0, cz, bottomCol,
            ox2, y0, oz2, bottomCol,
            diagX, y0, diagZ, bottomCol,
            ox1, y0, oz1, bottomCol
        );

        // Outer diagonal faces (the two faces facing outward)
        addQuad(
            ox1, y0, oz1, bottomCol,
            diagX, y0, diagZ, bottomCol,
            diagX, y1, diagZ, topCol,
            ox1, y1, oz1, topCol
        );
        addQuad(
            diagX, y0, diagZ, bottomCol,
            ox2, y0, oz2, bottomCol,
            ox2, y1, oz2, topCol,
            diagX, y1, diagZ, topCol
        );

        // Inner faces (the two faces connecting to wall inner edges)
        addQuad(
            cx, y0, cz, bottomCol,
            ox1, y0, oz1, bottomCol,
            ox1, y1, oz1, topCol,
            cx, y1, cz, topCol
        );
        addQuad(
            ox2, y0, oz2, bottomCol,
            cx, y0, cz, bottomCol,
            cx, y1, cz, topCol,
            ox2, y1, oz2, topCol
        );
    };

    // Draw barrier walls only on outer perimeter edges (islanding effect)
    // Only draw wall if there's no adjacent wander tile on that side
    for (let z = minTileZ; z <= maxTileZ; z++) {
        for (let x = minTileX; x <= maxTileX; x++) {
            const isNpcTile = (x === npcTileX && z === npcTileZ);
            const tileColor = isNpcTile ? npcCol : wanderCol;

            const hasSouth = !isWanderTile(x, z - 1);
            const hasEast = !isWanderTile(x + 1, z);
            const hasNorth = !isWanderTile(x, z + 1);
            const hasWest = !isWanderTile(x - 1, z);

            // Draw edges
            if (hasSouth) writeBarrierWall(x, z, tileColor, 0);
            if (hasEast) writeBarrierWall(x, z, tileColor, 1);
            if (hasNorth) writeBarrierWall(x, z, tileColor, 2);
            if (hasWest) writeBarrierWall(x, z, tileColor, 3);

            // Draw corner fills where two walls meet
            if (hasSouth && hasWest) writeCornerFill(x, z, tileColor, 0);  // SW
            if (hasSouth && hasEast) writeCornerFill(x, z, tileColor, 1);  // SE
            if (hasNorth && hasEast) writeCornerFill(x, z, tileColor, 2);  // NE
            if (hasNorth && hasWest) writeCornerFill(x, z, tileColor, 3);  // NW
        }
    }

    console.log(`[TileOverlay] NPC wander barrier: ${pos.length / 3} vertices, ${indices.length / 3} triangles`);

    // Barrier shader with uTime for animated vertical wave effect
    const uniforms = new UniformSnapshotBuilder({
        uModelMatrix: "mat4",
        uViewProjMatrix: "mat4",
        uAmbientColour: "vec3",
        uSunlightViewMatrix: "mat4",
        uSunColour: "vec3",
        uTime: "float"
    });

    const uniformSources: patchrs.OverlayUniformSource[] = [
        { type: "program", name: "uViewProjMatrix", sourceName: "uViewProjMatrix" },
        { type: "program", name: "uAmbientColour", sourceName: "uAmbientColour" },
        { type: "program", name: "uSunlightViewMatrix", sourceName: "uSunlightViewMatrix" },
        { type: "program", name: "uSunColour", sourceName: "uSunColour" },
        { type: "builtin", name: "uTime", sourceName: "timestamp" }
    ];

    // Use barrier shaders for animated vertical wave wall effect
    // aColor is RGBA where alpha encodes height (0=bottom, 1=top)
    const program = patchrs.native.createProgram(barrierVertShader, barrierFragShader, [
        { location: 0, name: "aPos", type: GL_FLOAT, length: 3 },
        { location: 6, name: "aColor", type: GL_UNSIGNED_BYTE, length: 4 }  // RGBA
    ], uniforms.args);

    // Position matrix - place at chunk center
    uniforms.mappings.uModelMatrix.write(positionMatrix(
        (chunkX + 0.5) * TILE_SIZE * CHUNK_SIZE,
        TILE_SIZE / 32,
        (chunkZ + 0.5) * TILE_SIZE * CHUNK_SIZE
    ));

    // Create vertex array buffers
    const indexBuffer = new Uint8Array(new Uint16Array(indices).buffer);
    const posBuffer = new Uint8Array(new Float32Array(pos).buffer);
    const colBuffer = Uint8Array.from(colorData);  // Like arrow does - direct conversion

    // Debug: Log first few color values to verify they're correct
    console.log(`[TileOverlay] Color data sample (first 8 values): [${colorData.slice(0, 8).join(', ')}]`);
    console.log(`[TileOverlay] colBuffer sample: [${Array.from(colBuffer.slice(0, 8)).join(', ')}]`);
    console.log(`[TileOverlay] marker.color: [${marker.color.join(', ')}]`);

    const vertex = patchrs.native.createVertexArray(indexBuffer, [
        { location: 0, buffer: posBuffer, enabled: true, normalized: false, offset: 0, scalartype: GL_FLOAT, stride: 3 * 4, vectorlength: 3 },
        { location: 6, buffer: colBuffer, enabled: true, normalized: true, offset: 0, scalartype: GL_UNSIGNED_BYTE, stride: 4, vectorlength: 4 }  // RGBA
    ]);

    // Create overlay - ranges length must be INDEX count, not triangle count
    const renderRanges = [{ start: 0, length: indices.length }];

    // Use vertexObjectId like working tile overlays (not programId)
    // Enable alpha blending for translucent flame effect
    const overlayId = await patchrs.native.beginOverlay(
        { skipProgramMask: wrongProgramMask, vertexObjectId: floor.vertexObjectId },
        program,
        vertex,
        {
            uniformSources: uniformSources,
            uniformBuffer: new Uint8Array(uniforms.buffer.buffer),
            ranges: renderRanges,
            alphaBlend: true  // Enable alpha blending for flame transparency
        }
    );

    activeOverlays.set(overlayId, { description: `NPC wander barrier` });
    console.log(`[TileOverlay] Created NPC wander overlay ${overlayId} on chunk (${chunkX}, ${chunkZ})`);

    return overlayId;
}

/**
 * Add an NPC wander area marker using the bundle's wanderRadius format
 * Creates a single mesh with both wander tiles (cyan) and NPC tile (bright green)
 * This is 1 draw call instead of multiple
 */
export async function addNPCWanderMarker(marker: NPCWanderMarker): Promise<patchrs.GlOverlay | null> {
    if (!patchrs.native) {
        console.warn("[TileOverlay] Native addon not available");
        return null;
    }

    const { bottomLeft, topRight } = marker.wanderRadius;
    const centerLng = (bottomLeft.lng + topRight.lng) / 2;
    const centerLat = (bottomLeft.lat + topRight.lat) / 2;
    const targetChunkX = Math.floor(centerLng / CHUNK_SIZE);
    const targetChunkZ = Math.floor(centerLat / CHUNK_SIZE);
    const chunkKey = `${targetChunkX},${targetChunkZ}`;

    console.log(`[TileOverlay] NPC wander area: bottomLeft(${bottomLeft.lat}, ${bottomLeft.lng}) to topRight(${topRight.lat}, ${topRight.lng})`);
    console.log(`[TileOverlay] Target chunk: ${chunkKey}`);

    // Try to find the chunk immediately - use floor selection to pick ground level
    try {
        const renders = await patchrs.native.recordRenderCalls({ maxframes: 1,
            features: ["uniforms"],
            skipProgramMask: wrongProgramMask
        });

        // Mark non-floor programs
        for (const render of renders) {
            if (!render.program.inputs.find(q => q.name === "aMaterialSettingsSlotXY3")) {
                render.program.skipmask |= wrongProgramMask;
            }
        }

        // Find best floor render (lowest Y for floor 0)
        const targetFloor = marker.floor ?? 0;
        const bestRender = findBestFloorRender(renders, targetChunkX, targetChunkZ, targetFloor);
        if (bestRender) {
            console.log(`[TileOverlay] Found chunk immediately for NPC wander`);
            return await createNPCWanderOverlay(marker, bestRender.render, bestRender.chunkX, bestRender.chunkZ);
        }

        // Log what chunks ARE visible for debugging
        const visibleChunks = new Set<string>();
        for (const render of renders) {
            if (!render.program.inputs.find(q => q.name === "aMaterialSettingsSlotXY3")) continue;
            const chunkInfo = getChunkFromRender(render);
            if (chunkInfo) {
                visibleChunks.add(`${chunkInfo.chunkX},${chunkInfo.chunkZ}`);
            }
        }
        console.log(`[TileOverlay] Target chunk ${chunkKey} NOT found. Visible chunks: [${Array.from(visibleChunks).join(", ")}]`);
    } catch (e) {
        console.warn("[TileOverlay] Error checking immediate renders for NPC wander:", e);
    }

    // If skipIfNotVisible is set, return null instead of waiting
    if (marker.skipIfNotVisible) {
        console.log(`[TileOverlay] Chunk not visible for NPC wander, skipping (skipIfNotVisible=true)`);
        return null;
    }

    // Fall back to simple rect marker if chunk not found immediately
    console.log(`[TileOverlay] Chunk not visible, falling back to rect marker`);
    return addRectMarker({
        minLat: bottomLeft.lat,
        minLng: bottomLeft.lng,
        maxLat: topRight.lat,
        maxLng: topRight.lng,
        color: marker.color,
        filled: marker.filled ?? true,
        thickness: marker.thickness ?? 0.06,
        floor: marker.floor
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
    floor: patchrs.RenderInvocation,
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
                console.log(`[TileOverlay] Parsed hex color "${tile.color}" -> [${parsed.join(', ')}]`);
            } else {
                console.log(`[TileOverlay] Failed to parse hex color "${tile.color}", using default`);
            }
        }
        tileColors.set(key, color);
    }

    console.log(`[TileOverlay] Tile group "${group.name}": ${group.tiles.length} tiles, defaultColor=[${group.defaultColor.join(', ')}]`);

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
    const writeSolidTile = (x: number, z: number, vertcol: number[]): void => {
        const heightOffset = 2 / 32;
        const v0 = writevertex(x, z, -0.5, -0.5, heightOffset, vertcol, 0);
        const v1 = writevertex(x, z, 0.5, -0.5, heightOffset, vertcol, 0);
        const v2 = writevertex(x, z, 0.5, 0.5, heightOffset, vertcol, 0);
        const v3 = writevertex(x, z, -0.5, 0.5, heightOffset, vertcol, 0);
        indices.push(v0, v2, v1);
        indices.push(v0, v3, v2);
    };

    // Border colors - dark casing for contrast
    const blackCasing = [0, 0, 0, 200];

    // Writeline for border casing (dark outline) - middle layer
    const writeBorderCasing = (x: number, z: number, size: number, dir: number): void => {
        const heightOffset = 3 / 32; // Above fill
        const v0 = writevertex(x, z, -0.5, -0.5, heightOffset, blackCasing, dir);
        const v1 = writevertex(x, z, 0.5, -0.5, heightOffset, blackCasing, dir);
        const v2 = writevertex(x, z, 0.5 - size, -0.5 + size, heightOffset, blackCasing, dir);
        const v3 = writevertex(x, z, -0.5 + size, -0.5 + size, heightOffset, blackCasing, dir);
        indices.push(v0, v2, v1);
        indices.push(v0, v3, v2);
    };

    // Writeline for colored border inline - top layer
    const writeBorderInline = (x: number, z: number, size: number, vertcol: number[], dir: number): void => {
        const heightOffset = 4 / 32; // Above casing
        const inset = size * 0.3; // Smaller than casing
        const v0 = writevertex(x, z, -0.5 + inset, -0.5, heightOffset, vertcol, dir);
        const v1 = writevertex(x, z, 0.5 - inset, -0.5, heightOffset, vertcol, dir);
        const v2 = writevertex(x, z, 0.5 - size, -0.5 + size - inset, heightOffset, vertcol, dir);
        const v3 = writevertex(x, z, -0.5 + size, -0.5 + size - inset, heightOffset, vertcol, dir);
        indices.push(v0, v2, v1);
        indices.push(v0, v3, v2);
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

    console.log(`[TileOverlay] Created batched object tiles: ${group.tiles.length} tiles, ${pos.length / 3} vertices, ${indices.length / 3} triangles`);

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

    uniforms.mappings.uModelMatrix.write(positionMatrix(
        (chunkX + 0.5) * TILE_SIZE * CHUNK_SIZE,
        TILE_SIZE / 32,
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
        { skipProgramMask: wrongProgramMask, vertexObjectId: floor.vertexObjectId },
        program,
        vertex,
        {
            uniformSources: uniformSources,
            uniformBuffer: new Uint8Array(uniforms.buffer.buffer),
            ranges: renderRanges
        }
    );

    activeOverlays.set(overlayId, {
        description: `ObjectTileGroup "${group.name}" (${group.tiles.length} tiles)`
    });
    console.log(`[TileOverlay] Created batched overlay ${overlayId} for "${group.name}"`);

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
    floor: patchrs.RenderInvocation,
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

    // Generate 3D text geometry - yellow color for visibility
    const charSize = TILE_SIZE * 0.25;  // Character size (smaller for readability)
    const textColor: [number, number, number] = [255, 255, 0];  // Yellow
    const textGeo = generateTextGeometry(text, centerX, centerZ, textHeight, charSize, textColor);

    if (textGeo.indices.length === 0) {
        console.warn(`[TileOverlay] No geometry generated for text "${text}"`);
        return null;
    }

    console.log(`[TileOverlay] Creating text label "${text}" at (${centerLat.toFixed(1)}, ${centerLng.toFixed(1)}) with ${textGeo.indices.length / 3} triangles`);

    // Use billboard shader for text - rotates to face camera
    const uniforms = new UniformSnapshotBuilder({
        uModelMatrix: "mat4",
        uViewProjMatrix: "mat4",
        uTextCenter: "vec3",  // Center of text for billboard rotation
        uSunlightViewMatrix: "mat4",
        uSunColour: "vec3",
        uAmbientColour: "vec3"
    });

    const uniformSources: patchrs.OverlayUniformSource[] = [
        { type: "program", name: "uViewProjMatrix", sourceName: "uViewProjMatrix" },
        { type: "program", name: "uSunlightViewMatrix", sourceName: "uSunlightViewMatrix" },
        { type: "program", name: "uSunColour", sourceName: "uSunColour" },
        { type: "program", name: "uAmbientColour", sourceName: "uAmbientColour" }
    ];

    // Use billboard text shader that rotates to face camera
    const program = patchrs.native.createProgram(textVertShader, fragshader, [
        { location: 0, name: "aPos", type: GL_FLOAT, length: 3 },
        { location: 6, name: "aColor", type: GL_UNSIGNED_BYTE, length: 3 }
    ], uniforms.args);

    uniforms.mappings.uModelMatrix.write(positionMatrix(
        (chunkX + 0.5) * TILE_SIZE * CHUNK_SIZE,
        TILE_SIZE / 32,
        (chunkZ + 0.5) * TILE_SIZE * CHUNK_SIZE
    ));

    // Set text center for billboard rotation (center of text in local coords)
    // X, Y (height + half char size for vertical center), Z
    uniforms.mappings.uTextCenter.write([centerX, textHeight + charSize / 2, centerZ]);

    const indexBuffer = new Uint8Array(new Uint16Array(textGeo.indices).buffer);
    const posBuffer = new Uint8Array(new Float32Array(textGeo.pos).buffer);
    const colBuffer = new Uint8Array(new Uint8Array(textGeo.colors).buffer);

    const vertex = patchrs.native.createVertexArray(indexBuffer, [
        { location: 0, buffer: posBuffer, enabled: true, normalized: false, offset: 0, scalartype: GL_FLOAT, stride: 3 * 4, vectorlength: 3 },
        { location: 6, buffer: colBuffer, enabled: true, normalized: true, offset: 0, scalartype: GL_UNSIGNED_BYTE, stride: 4, vectorlength: 3 }
    ]);

    const overlayId = await patchrs.native.beginOverlay(
        { skipProgramMask: wrongProgramMask, vertexObjectId: floor.vertexObjectId },
        program,
        vertex,
        {
            uniformSources: uniformSources,
            uniformBuffer: new Uint8Array(uniforms.buffer.buffer),
            ranges: [{ start: 0, length: textGeo.indices.length }]
        }
    );

    activeOverlays.set(overlayId, {
        description: `TextLabel "${text}" at (${centerLat.toFixed(1)}, ${centerLng.toFixed(1)})`
    });
    console.log(`[TileOverlay] Created text label overlay ${overlayId} for "${text}"`);

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

    console.log(`[TileOverlay] Adding batched object tiles "${group.name}": ${group.tiles.length} tiles, target chunk (${targetChunkX}, ${targetChunkZ})`);

    // Try to find the chunk immediately
    try {
        const renders = await patchrs.native.recordRenderCalls({ maxframes: 1,
            features: ["uniforms"],
            skipProgramMask: wrongProgramMask
        });

        for (const render of renders) {
            if (render.program.inputs.find(q => q.name === "aMaterialSettingsSlotXY3")) {
                const chunkInfo = getChunkFromRender(render);
                if (chunkInfo && chunkInfo.chunkX === targetChunkX && chunkInfo.chunkZ === targetChunkZ) {
                    console.log(`[TileOverlay] Found chunk immediately for batched tiles`);
                    const tileOverlayId = await createObjectTilesBatchedOverlay(group, render, chunkInfo.chunkX, chunkInfo.chunkZ);

                    // Create text labels - group tiles with same label and center text
                    const tilesWithLabels = group.tiles.filter(t => t.numberLabel);
                    if (tilesWithLabels.length > 0) {
                        // Group tiles by their label text
                        const labelGroups = new Map<string, { lat: number; lng: number }[]>();
                        for (const tile of tilesWithLabels) {
                            const label = tile.numberLabel!;
                            if (!labelGroups.has(label)) {
                                labelGroups.set(label, []);
                            }
                            labelGroups.get(label)!.push({ lat: tile.lat, lng: tile.lng });
                        }

                        console.log(`[TileOverlay] Creating ${labelGroups.size} unique text labels`);

                        // Create one label per unique text, centered on all tiles with that label
                        for (const [labelText, tiles] of labelGroups) {
                            try {
                                // Calculate bounding box center of all tiles with this label
                                const minLat = Math.min(...tiles.map(t => Math.floor(t.lat)));
                                const maxLat = Math.max(...tiles.map(t => Math.floor(t.lat)));
                                const minLng = Math.min(...tiles.map(t => Math.floor(t.lng)));
                                const maxLng = Math.max(...tiles.map(t => Math.floor(t.lng)));

                                // Center of bounding box (tiles span from coord to coord+1)
                                const centerLat = (minLat + maxLat + 1) / 2;
                                const centerLng = (minLng + maxLng + 1) / 2;

                                console.log(`[TileOverlay] Label "${labelText}": ${tiles.length} tiles, center at (${centerLat.toFixed(1)}, ${centerLng.toFixed(1)})`);

                                await createTextLabelOverlay(
                                    labelText,
                                    centerLat,
                                    centerLng,
                                    render,
                                    chunkInfo.chunkX,
                                    chunkInfo.chunkZ,
                                    group.floor ?? 0
                                );
                            } catch (e) {
                                console.warn(`[TileOverlay] Failed to create text label "${labelText}":`, e);
                            }
                        }
                    }

                    return tileOverlayId;
                }
            } else {
                render.program.skipmask |= wrongProgramMask;
            }
        }
    } catch (e) {
        console.warn("[TileOverlay] Error checking immediate renders for batched tiles:", e);
    }

    // Chunk not visible - fall back to individual tile markers
    console.log(`[TileOverlay] Chunk not visible for batched tiles, falling back to individual markers`);

    // Create individual markers (less efficient but works)
    for (const tile of group.tiles) {
        const color = tile.color ? (parseHexColor(tile.color) ?? group.defaultColor) : group.defaultColor;
        await addTileMarker({
            lat: tile.lat,
            lng: tile.lng,
            color: color,
            solidFill: true,
            floor: group.floor,
            thickness: group.thickness
        });
    }

    return null; // Individual markers don't have a single ID
}

/**
 * Create batched path overlay for a single chunk as a 3D cylindrical tube
 * All tiles should be in the same chunk
 * @param animated If true, uses animated shaders with flowing effect and gradient
 */
async function createPathTilesBatchedOverlay(
    tiles: PathTile[],
    floor: patchrs.RenderInvocation,
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

    // Position matrix - place at chunk center
    uniforms.mappings.uModelMatrix.write(positionMatrix(
        (chunkX + 0.5) * TILE_SIZE * CHUNK_SIZE,
        TILE_SIZE / 32,
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
        { skipProgramMask: wrongProgramMask, vertexObjectId: floor.vertexObjectId },
        program,
        vertex,
        {
            uniformSources: uniformSources,
            uniformBuffer: new Uint8Array(uniforms.buffer.buffer),
            ranges: renderRanges,
            alphaBlend: animated  // Enable alpha blending for animated paths
        }
    );

    activeOverlays.set(overlayId, { description: `Path tiles${animated ? ' (animated)' : ''} (${tiles.length} tiles)` });
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

    console.log(`[TileOverlay] Path tiles: ${group.tiles.length} tiles across ${tilesByChunk.size} chunks`);

    // Get current render calls to find visible chunks
    try {
        const renders = await patchrs.native.recordRenderCalls({ maxframes: 1,
            features: ["uniforms"],
            skipProgramMask: wrongProgramMask
        });

        // Build set of visible chunks
        const visibleChunks = new Map<string, { render: patchrs.RenderInvocation; chunkX: number; chunkZ: number }>();
        for (const render of renders) {
            if (render.program.inputs.find(q => q.name === "aMaterialSettingsSlotXY3")) {
                const chunkInfo = getChunkFromRender(render);
                if (chunkInfo) {
                    const key = `${chunkInfo.chunkX},${chunkInfo.chunkZ}`;
                    visibleChunks.set(key, { render, chunkX: chunkInfo.chunkX, chunkZ: chunkInfo.chunkZ });
                }
            } else {
                render.program.skipmask |= wrongProgramMask;
            }
        }

        console.log(`[TileOverlay] Found ${visibleChunks.size} visible chunks`);

        // Create overlay for each chunk that has tiles and is visible
        for (const [chunkKey, tiles] of tilesByChunk) {
            const visible = visibleChunks.get(chunkKey);
            if (visible) {
                const overlayId = await createPathTilesBatchedOverlay(
                    tiles,
                    visible.render,
                    visible.chunkX,
                    visible.chunkZ,
                    group.thickness ?? 0.05,
                    group.animated ?? false
                );
                if (overlayId !== null) {
                    overlayIds.push(overlayId);
                }
            } else if (!group.skipIfNotVisible) {
                console.log(`[TileOverlay] Chunk ${chunkKey} not visible, skipping ${tiles.length} path tiles`);
            }
        }
    } catch (e) {
        console.warn("[TileOverlay] Error checking renders for path tiles:", e);
    }

    console.log(`[TileOverlay] Created ${overlayIds.length} path tile overlays`);
    return overlayIds;
}

/**
 * Remove an overlay
 */
export async function removeOverlay(overlay: patchrs.GlOverlay): Promise<void> {
    if (activeOverlays.has(overlay)) {
        try {
            overlay.stop();
            activeOverlays.delete(overlay);
            console.log(`[TileOverlay] Removed overlay`);
        } catch (e) {
            console.warn("[TileOverlay] Error removing overlay:", e);
        }
    }
}

/**
 * Clear all overlays
 */
export async function clearAllOverlays(): Promise<void> {
    for (const overlay of activeOverlays.keys()) {
        await removeOverlay(overlay);
    }
    console.log("[TileOverlay] Cleared all overlays");
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
    console.log("[TileOverlay] Initialized (programId trigger mode)");
    return { close: stopFloorTracking };
}

/**
 * Cleanup
 */
export function stopFloorTracking(): void {
    clearAllOverlays();
    floorProgramId = null;
    console.log("[TileOverlay] Stopped");
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
            features: ["uniforms"] // Only uniforms, no textures
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
            features: ["uniforms"] // Only uniforms, no textures
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
            features: [] // Minimal - no extra data needed
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
            features: ["vertexarray", "uniforms"]
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
            features: ["uniforms"] // Only uniforms for debugging, no textures/inputs
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
        const renders = await patchrs.native.recordRenderCalls({ maxframes: 1, features: [] });
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
            features: ["vertexarray", "uniforms"]
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
    // Also use ov4 like alt1gl does
    (globalThis as any).ov4 = testExact;
}
