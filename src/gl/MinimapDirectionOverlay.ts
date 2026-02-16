/**
 * MinimapDirectionOverlay - Draws direction indicators on the minimap pointing toward quest objectives
 *
 * Based on alt1gl chunkoverlay's minimap overlay pattern:
 * 1. Find minimap framebuffer by detecting UI renders that sample their own FBO texture
 * 2. Create minimap overlay that draws arrow pointing toward target
 * 3. Uses PlayerPositionTracker for player position updates
 */

import * as patchrs from "./injection/util/patchrs_napi";
import { getProgramMeta } from "./injection/render/renderprogram";
import { GL_FLOAT, UniformSnapshotBuilder } from "@injection/overlays/index";
import { startPlayerTracking, getPlayerPosition, isTeleportSuppressed } from "./PlayerPositionTracker";
import { MinimapMarkerOverlay, getMinimapMarkerOverlay } from "./MinimapMarkerOverlay";

// Skipmask bit for non-UI programs (filtered at native level after first detection)
const NON_UI_PROGRAM_MASK = 0x1000;

/** Target coordinates to point toward (using Leaflet/map lat/lng format) */
export interface MinimapTarget {
  /** Latitude = game Z coordinate (north-south, increases going north) */
  lat: number;
  /** Longitude = game X coordinate (east-west, increases going east) */
  lng: number;
  /** Optional color for this target's indicator [r,g,b,a] 0-255 */
  color?: [number, number, number, number];
  /** Optional label for debugging */
  label?: string;
  /** NPC ID for sprite lookup (close-range marker) */
  npcId?: number;
  /** NPC name for sprite lookup */
  npcName?: string;
  /** Sprite variant (e.g., 'default', 'chat') */
  spriteVariant?: string;
}

/** Minimap framebuffer detection result */
interface MinimapInfo {
  /** Framebuffer texture where minimap content is rendered */
  minimapFboTex: number;
  /** Backing texture that gets sampled */
  minimapBackingTex: number;
  /** Program that renders to the minimap */
  minimapProg: patchrs.GlProgram;
  /** Program with uViewMatrix (3D world render) for passive camera yaw capture */
  viewMatrixProg: patchrs.GlProgram | null;
}

/**
 * Fullscreen quad vertex shader - passes UV coordinates for fragment shader processing
 */
const minimapVertShader = `#version 330 core

layout (location = 0) in vec2 aPosition;
layout (location = 1) in vec2 aUV;

out vec2 vUV;

void main() {
    vUV = aUV;
    gl_Position = vec4(aPosition, 0.0, 1.0);
}
`;

/**
 * Fragment shader that draws a styled arrow on the minimap edge
 * Arrow shape: pointed head with shaft, outline, and glow
 *
 * Receives player position from PlayerPositionTracker via uniform
 * Camera yaw is extracted from uViewMatrix (passively captured from 3D render)
 */
const minimapFragShader = `#version 330 core

in vec2 vUV;
out vec4 FragColor;

// Player position in tiles (from PlayerPositionTracker)
uniform vec2 uPlayerPos;
// Target position in tiles
uniform vec2 uTargetPos;
// Arrow color
uniform vec4 uArrowColor;
// View matrix from 3D render (passively captured via uniformSources)
// Camera yaw is extracted as atan2(-v[2], -v[10]) in shader
uniform mat4 uViewMatrix;

// Arrow positioning - medium RS3-style arrow
const float ARROW_DISTANCE = 0.09;     // Distance from center to arrow tip (on top of player)
const float HEAD_LENGTH = 0.055;       // Arrow head length
const float HEAD_WIDTH = 0.04;         // Arrow head half-width
const float SHAFT_LENGTH = 0.07;       // Shaft length
const float SHAFT_WIDTH = 0.015;       // Shaft half-width
const float OUTLINE_WIDTH = 0.005;     // Dark outline thickness
const float GLOW_SIZE = 0.015;         // Outer glow size

// Distance scaling thresholds (in tiles)
const float NEAR_DIST = 5.0;
const float FAR_DIST = 30.0;
const float MIN_SCALE = 0.4;

// Signed distance to arrow shape (negative = inside)
float sdArrow(vec2 p, float headLen, float headW, float shaftLen, float shaftW) {
    // Arrow points up (+Y direction)
    // Head is at top, shaft extends down

    // Arrow head (triangle) - tip at y=0, base at y=-headLen
    float headDist = 1000.0;
    if (p.y > -headLen) {
        // Inside head region
        float t = (p.y + headLen) / headLen; // 0 at base, 1 at tip
        float widthAtY = headW * (1.0 - t);
        headDist = abs(p.x) - widthAtY;
    }

    // Shaft (rectangle) - from y=-headLen to y=-(headLen+shaftLen)
    float shaftTop = -headLen + 0.01; // Slight overlap
    float shaftBot = -headLen - shaftLen;
    float shaftDist = 1000.0;
    if (p.y <= shaftTop && p.y >= shaftBot) {
        shaftDist = abs(p.x) - shaftW;
    }

    // Combine: minimum distance to either shape
    return min(headDist, shaftDist);
}

// Extract camera yaw from view matrix
// Forward direction is -third column: fwdX = -v[0][2], fwdZ = -v[2][2]
// Yaw is angle from north (Z+) on XZ plane
float getCameraYaw() {
    float fwdX = -uViewMatrix[0][2];
    float fwdZ = -uViewMatrix[2][2];
    return atan(fwdX, fwdZ);
}

void main() {
    vec2 uvFromCenter = vUV - vec2(0.5);

    // Direction from player to target
    vec2 toTarget = uTargetPos - uPlayerPos;
    float targetDist = length(toTarget);

    // Don't draw if very close
    if (targetDist < 2.0) {
        discard;
    }

    // Scale based on distance
    float distFactor = smoothstep(NEAR_DIST, FAR_DIST, targetDist);
    float scale = mix(MIN_SCALE, 1.0, distFactor);

    // Calculate angle to target, applying camera yaw from view matrix
    float cameraYaw = getCameraYaw();
    float targetAngle = atan(-toTarget.x, toTarget.y);
    targetAngle = targetAngle + cameraYaw + 3.14159265;

    // Rotate UV
    float cosA = cos(-targetAngle);
    float sinA = sin(-targetAngle);
    vec2 rotatedUV = vec2(
        uvFromCenter.x * cosA - uvFromCenter.y * sinA,
        uvFromCenter.x * sinA + uvFromCenter.y * cosA
    );

    // Translate so arrow tip is at ARROW_DISTANCE from center
    vec2 arrowUV = rotatedUV - vec2(0.0, ARROW_DISTANCE * scale);

    // Scale the UV for arrow size
    arrowUV /= scale;

    // Get signed distance to arrow
    float dist = sdArrow(arrowUV, HEAD_LENGTH, HEAD_WIDTH, SHAFT_LENGTH, SHAFT_WIDTH);

    // Discard if too far from arrow
    float maxDist = (OUTLINE_WIDTH + GLOW_SIZE) / scale;
    if (dist > maxDist) {
        discard;
    }

    // Layer 1: Outer glow (cyan tinted)
    float glowAlpha = smoothstep(GLOW_SIZE, 0.0, dist) * 0.4;
    vec3 glowColor = uArrowColor.rgb * 1.2;

    // Layer 2: Dark outline (black for contrast)
    float outlineAlpha = smoothstep(OUTLINE_WIDTH, OUTLINE_WIDTH * 0.3, dist);
    vec3 outlineColor = vec3(0.0, 0.0, 0.0);

    // Layer 3: Main arrow fill with gradient
    float fillAlpha = smoothstep(0.002, -0.002, dist);
    // Gradient from bright at tip to slightly darker at base
    float gradientT = clamp((arrowUV.y + HEAD_LENGTH + SHAFT_LENGTH) / (HEAD_LENGTH + SHAFT_LENGTH), 0.0, 1.0);
    vec3 fillColor = mix(uArrowColor.rgb * 0.8, uArrowColor.rgb * 1.1, gradientT);

    // Layer 4: Highlight on edges (specular-like)
    float edgeHighlight = smoothstep(0.008, 0.0, abs(dist + 0.004)) * 0.5;
    vec3 highlightColor = vec3(1.0);

    // Composite layers
    vec3 finalColor = glowColor;
    float finalAlpha = glowAlpha;

    // Add outline
    finalColor = mix(finalColor, outlineColor, outlineAlpha);
    finalAlpha = max(finalAlpha, outlineAlpha * 0.9);

    // Add fill
    finalColor = mix(finalColor, fillColor, fillAlpha);
    finalAlpha = max(finalAlpha, fillAlpha);

    // Add highlight
    finalColor = mix(finalColor, highlightColor, edgeHighlight * fillAlpha);

    FragColor = vec4(finalColor, finalAlpha * uArrowColor.a);
}
`;

/**
 * Find minimap framebuffer using the chunkoverlay pattern.
 *
 * The minimap is detected by finding UI renders that sample their own FBO texture.
 * Pattern: UI renders to FBO X, then another UI render samples FBO X's texture.
 */
async function findMinimapRequirements(): Promise<MinimapInfo | null> {
  let allRenders: any[] = [];
  try {
    // Record UI renders with texture data, skipping programs already marked as non-UI
    allRenders = await patchrs.native.recordRenderCalls({
      features: ["textures", "uniforms"],
      skipProgramMask: NON_UI_PROGRAM_MASK,
    });

    // Filter to UI renders only, tagging non-UI programs for future skip
    const uiRenders: patchrs.RenderInvocation[] = [];
    for (const r of allRenders) {
      if (!r.program) continue;
      const meta = getProgramMeta(r.program);
      if (meta.isUi) {
        uiRenders.push(r);
      } else {
        // Tag non-UI program so native layer skips it next time
        r.program.skipmask = (r.program.skipmask || 0) | NON_UI_PROGRAM_MASK;
      }
    }

    // Use chunkoverlay pattern: find UI render that samples its previous FBO
    let lastFboTex = 0;
    let lastFirstTex: patchrs.TrackedTexture | null = null;
    let minimapProg: patchrs.GlProgram | null = null;
    let minimapFboTex = 0;
    let minimapBackingTex = 0;
    let groupSize = 0;

    for (const render of uiRenders) {
      const currentFbo = render.framebufferColorTextureId;

      if (currentFbo === lastFboTex) {
        groupSize++;
      } else {
        // FBO changed - check if this render uses the previous FBO as a texture
        // Use render.textures (not render.samplers) when using "textures" feature
        // textures is an object {[location: number]: TrackedTexture}, convert to array
        const texturesObj = render.textures || {};
        const textures = Object.values(texturesObj) as patchrs.TrackedTexture[];

        const matchingTex = textures.find(t => t && t.texid === lastFboTex);

        if (matchingTex && groupSize >= 2) {
          minimapFboTex = lastFboTex;
          minimapProg = render.program;
          minimapBackingTex = lastFirstTex?.texid ?? 0;
          break;
        }

        // Track first texture of new group
        const firstTex = textures[0];
        lastFirstTex = firstTex ?? null;
        lastFboTex = currentFbo;
        groupSize = 1;
      }
    }

    // Fallback if not found
    if (minimapFboTex === 0) {
      // Fallback: find FBOs with uInvViewProjMatrix (indicates 3D minimap render)
      // The minimap FBO is typically SMALLER than the main world FBO

      const fboHasInvViewProj: Map<number, { count: number; render: any; width: number; height: number }> = new Map();

      for (const render of allRenders) {
        if (!render.program) continue;
        const fboTex = render.framebufferColorTextureId;
        if (fboTex === 0) continue;

        const hasInvViewProj = render.program.uniforms?.some(
          (u: any) => u.name === "uInvViewProjMatrix"
        );

        if (hasInvViewProj) {
          const existing = fboHasInvViewProj.get(fboTex);
          if (existing) {
            existing.count++;
          } else {
            // Get FBO dimensions from viewport if available (cast to any for optional props)
            const r = render as any;
            const width = r.viewportWidth ?? r.viewport?.[2] ?? 0;
            const height = r.viewportHeight ?? r.viewport?.[3] ?? 0;
            fboHasInvViewProj.set(fboTex, { count: 1, render, width, height });
          }
        }
      }

      // Sort by count descending
      const candidates = Array.from(fboHasInvViewProj.entries())
        .map(([fbo, data]) => ({ fbo, ...data }))
        .filter(c => c.count >= 10)
        .sort((a, b) => b.count - a.count);

      // Find the SMALLEST FBO (minimap is ~150-250px, main world is full screen)
      // Filter to FBOs with reasonable minimap size (100-500px)
      const minimapCandidates = candidates.filter(c => {
        const size = Math.max(c.width, c.height);
        return size > 100 && size < 500;
      });

      if (minimapCandidates.length > 0) {
        // Pick the smallest one
        minimapCandidates.sort((a, b) => Math.max(a.width, a.height) - Math.max(b.width, b.height));
        const best = minimapCandidates[0];
        minimapFboTex = best.fbo;
        minimapBackingTex = best.fbo;
        minimapProg = best.render.program;
      } else if (candidates.length >= 2) {
        // Fallback to second-largest if size detection didn't work
        minimapFboTex = candidates[1].fbo;
        minimapBackingTex = candidates[1].fbo;
        minimapProg = candidates[1].render.program;
      }
    }

    if (minimapFboTex === 0 || !minimapProg) {
      return null;
    }

    // Find a program with uViewMatrix for passive camera yaw capture
    // This is typically the 3D world render program
    let viewMatrixProg: patchrs.GlProgram | null = null;
    for (const render of allRenders) {
      if (!render.program) continue;
      const hasViewMatrix = render.program.uniforms?.some(
        (u: { name: string }) => u.name === "uViewMatrix"
      );
      if (hasViewMatrix) {
        viewMatrixProg = render.program;
        break;
      }
    }

    return {
      minimapFboTex,
      minimapBackingTex,
      minimapProg,
      viewMatrixProg
    };
  } catch (e) {
    console.error("[MinimapDirection] Error finding minimap:", e);
    return null;
  } finally {
    for (const r of allRenders) {
      try { r.dispose?.(); } catch (_) {}
    }
  }
}

/**
 * MinimapDirectionOverlay
 *
 * Uses PlayerPositionTracker for player position and draws arrow on minimap:
 * 1. Subscribes to PlayerPositionTracker for position updates
 * 2. Minimap overlay draws arrow pointing toward target
 * 3. Arrow updates when player or target position changes
 */
export class MinimapDirectionOverlay {
  private initialized = false;
  private minimapInfo: MinimapInfo | null = null;

  /** Tracking overlay - passively captures uViewMatrix from 3D world render */
  private trackingProgram: patchrs.GlProgram | null = null;
  private trackingOverlay: patchrs.GlOverlay | null = null;

  /** Main minimap overlay */
  private minimapOverlay: patchrs.GlOverlay | null = null;
  private overlayProgram: patchrs.GlProgram | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private uniformBuilder: any = null;
  /** Cached vertex array - reused */
  private vertexArray: patchrs.VertexArraySnapshot | null = null;

  /** Current targets */
  private targets: MinimapTarget[] = [];

  /** Counter for reducing log frequency */
  private logCounter = 0;

  /** Last positions for change detection */
  private lastTargetX = 0;
  private lastTargetZ = 0;
  private lastPlayerX = 0;
  private lastPlayerZ = 0;

  /** Whether we're subscribed to player tracking */
  private isTrackingPlayer = false;

  /** Marker overlay for close-range sprite display */
  private markerOverlay: MinimapMarkerOverlay | null = null;

  /** Distance threshold for switching between arrow and marker (tiles) */
  private static readonly SWITCH_DISTANCE = 20;
  /** Squared distance for comparisons (avoids sqrt) */
  private static readonly SWITCH_DISTANCE_SQ = 20 * 20; // 400
  private static readonly TRACKING_START_DISTANCE_SQ = 64 * 64; // 4096

  /** Whether arrow is currently visible (vs marker) */
  private arrowVisible = true;

  /** Whether arrow feature is enabled by user (very taxing) */
  private arrowEnabled = true;
  /** Whether marker feature is enabled by user (light) */
  private markerEnabled = true;

  /** Dirty flag for batched updates - only recreate overlay once per frame */
  private uniformsDirty = false;
  private frameUpdateScheduled = false;

  constructor() {}

  /**
   * Schedule a batched overlay update for next animation frame.
   * Multiple uniform changes in the same frame will only trigger one recreation.
   */
  private scheduleOverlayUpdate(): void {
    if (this.frameUpdateScheduled || !this.arrowVisible) return;
    this.frameUpdateScheduled = true;

    requestAnimationFrame(() => {
      this.frameUpdateScheduled = false;
      if (this.uniformsDirty && this.arrowVisible) {
        this.uniformsDirty = false;
        this.recreateOverlayInternal();
      }
    });
  }

  /**
   * Mark uniforms as dirty - will trigger recreation on next frame.
   * This batches multiple updates into a single overlay recreation per frame.
   */
  private recreateOverlay(): void {
    this.uniformsDirty = true;
    this.scheduleOverlayUpdate();
  }

  async init(): Promise<boolean> {
    if (this.initialized) return true;

    try {
      // Give game time to render UI - minimap detection needs UI renders
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Find minimap
      this.minimapInfo = await findMinimapRequirements();
      if (this.minimapInfo) {
        await this.setupOverlays();
      }

      this.initialized = true;
      return true;
    } catch (e) {
      console.error("[MinimapDirection] Init failed:", e);
      return false;
    }
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Enable or disable the arrow feature (very taxing)
   * When disabled, arrow will never show even when far from target
   */
  setArrowEnabled(enabled: boolean): void {
    this.arrowEnabled = enabled;

    if (!enabled && this.arrowVisible) {
      // Hide arrow immediately if it's currently visible
      this.setArrowVisible(false);
    } else if (enabled && !this.arrowVisible && !this.isCloseToTarget()) {
      // Show arrow if we're far from target and marker would be hidden
      this.setArrowVisible(true);
    }
  }

  /**
   * Enable or disable the marker feature (light resource usage)
   * When disabled, marker sprite will never show even when close to target
   */
  setMarkerEnabled(enabled: boolean): void {
    this.markerEnabled = enabled;

    if (!enabled && this.markerOverlay) {
      this.markerOverlay.setVisible(false);
    } else if (enabled && this.markerOverlay && this.isCloseToTarget()) {
      this.markerOverlay.setVisible(true);
    }
  }

  /**
   * Check if player is close to target (within switch distance)
   */
  private isCloseToTarget(): boolean {
    const dx = this.lastTargetX - this.lastPlayerX;
    const dz = this.lastTargetZ - this.lastPlayerZ;
    const distSq = dx * dx + dz * dz;
    return distSq <= MinimapDirectionOverlay.SWITCH_DISTANCE_SQ;
  }

  /**
   * Set up overlays - simplified version using PlayerPositionTracker
   * Uses Skillbert's tracking overlay pattern to passively capture uViewMatrix
   */
  private async setupOverlays(): Promise<void> {
    if (!this.minimapInfo) return;

    try {
      // === STEP 1: Create tracking overlay for uViewMatrix (Skillbert's pattern) ===
      // This passively captures uViewMatrix from the 3D world render program
      const trackingBuilder = new UniformSnapshotBuilder({
        uViewMatrix: "mat4",
        uLastMatched: "int",
      });
      const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
      trackingBuilder.mappings.uViewMatrix.write(identity);
      trackingBuilder.mappings.uLastMatched.write([0]);

      // Create tracking program with empty shaders - just stores uniforms
      this.trackingProgram = patchrs.native.createProgram(
        "", // Empty vertex shader
        "", // Empty fragment shader
        [],
        trackingBuilder.args
      );

      // Start the passive tracking overlay on framebuffer 0 (screen)
      // This triggers on 3D world renders and captures their uViewMatrix
      if (this.minimapInfo.viewMatrixProg) {
        this.trackingOverlay = patchrs.native.beginOverlay(
          {
            maxPerFrame: 1,
            framebufferTexture: 0, // Screen/world framebuffer
          },
          this.trackingProgram,
          undefined,
          {
            ranges: [], // No geometry to draw
            uniformSources: [
              { type: "program" as const, name: "uViewMatrix", sourceName: "uViewMatrix" },
              { type: "builtin" as const, name: "uLastMatched", sourceName: "framenr" },
            ],
            trigger: "passive",
          }
        );
      }

      // === STEP 2: Create main arrow overlay ===
      // Create uniform builder with player position, target, color, and view matrix placeholder
      this.uniformBuilder = new UniformSnapshotBuilder({
        uPlayerPos: "vec2",     // Player position in tiles (from PlayerPositionTracker)
        uTargetPos: "vec2",     // Target position in tiles
        uArrowColor: "vec4",    // Arrow color
        uViewMatrix: "mat4",    // View matrix (sourced from tracking program)
      });

      // Set default values
      this.uniformBuilder.mappings.uPlayerPos.write([0, 0]);
      this.uniformBuilder.mappings.uTargetPos.write([100, 100]);
      this.uniformBuilder.mappings.uArrowColor.write([1.0, 0.4, 0.35, 1.0]); // Coral/salmon red like RS3
      // Initialize uViewMatrix to identity (will be overwritten by uniformSources from tracking program)
      this.uniformBuilder.mappings.uViewMatrix.write(identity);

      // Create the overlay program with our shaders
      this.overlayProgram = patchrs.native.createProgram(
        minimapVertShader,
        minimapFragShader,
        [
          { name: "aPosition", type: GL_FLOAT, length: 2, location: 0 },
          { name: "aUV", type: GL_FLOAT, length: 2, location: 1 },
        ],
        this.uniformBuilder.args
      );

      // Create fullscreen quad vertex array
      if (!this.vertexArray) {
        const quadVerts = new Float32Array([
          // x, y, u, v
          -1, -1, 0, 0,  // bottom-left
           1, -1, 1, 0,  // bottom-right
           1,  1, 1, 1,  // top-right
          -1,  1, 0, 1,  // top-left
        ]);
        const quadIndices = new Uint16Array([0, 1, 2, 0, 2, 3]);

        const vertexBuffer = new Uint8Array(quadVerts.buffer);
        const indexBuffer = new Uint8Array(quadIndices.buffer);

        this.vertexArray = patchrs.native.createVertexArray(indexBuffer, [
          { location: 0, buffer: vertexBuffer, enabled: true, normalized: false, offset: 0, stride: 16, scalartype: GL_FLOAT, vectorlength: 2 },
          { location: 1, buffer: vertexBuffer, enabled: true, normalized: false, offset: 8, stride: 16, scalartype: GL_FLOAT, vectorlength: 2 },
        ]);
      }

      // Create the overlay
      this.recreateOverlay();

      // Initialize marker overlay for close-range sprite display
      this.markerOverlay = getMinimapMarkerOverlay();
      await this.markerOverlay.init({
        minimapFboTex: this.minimapInfo.minimapFboTex,
        minimapBackingTex: this.minimapInfo.minimapBackingTex,
        minimapProgramId: this.minimapInfo.minimapProg.programId,
        // Pass the actual program object for attribute locations
        minimapProg: this.minimapInfo.minimapProg,
        // Pass as terrain program for direct uInvViewProjMatrix sourcing (same program renders backing texture)
        terrainProg: this.minimapInfo.minimapProg,
        // Pass our tracking program so marker can source uViewMatrix for camera yaw
        viewMatrixTrackingProg: this.trackingProgram ?? undefined,
      });
    } catch (e) {
      console.error("[MinimapDirection] Failed to setup overlays:", e);
    }
  }

  /**
   * Internal overlay recreation - actually stops and creates the overlay.
   * Called by the frame batching system.
   * Uses uniformSources to passively capture uViewMatrix from the 3D render program.
   */
  private recreateOverlayInternal(): void {
    if (!this.minimapInfo || !this.overlayProgram || !this.vertexArray || !this.uniformBuilder) {
      return;
    }

    // Stop existing overlay
    if (this.minimapOverlay) {
      try {
        this.minimapOverlay.stop();
      } catch {
        // Ignore
      }
      this.minimapOverlay = null;
    }

    // Build uniformSources to get uViewMatrix from tracking program
    const uniformSources: patchrs.OverlayUniformSource[] = [];

    // Source uViewMatrix from tracking program (which passively captures it from 3D world render)
    // This is Skillbert's pattern: tracking overlay captures, main overlay sources from it
    if (this.trackingProgram) {
      uniformSources.push({
        type: "program" as const,
        name: "uViewMatrix",
        sourceName: "uViewMatrix",
        program: this.trackingProgram,
      });
    }

    // Create new overlay with updated uniform buffer and uniformSources
    try {
      this.minimapOverlay = patchrs.native.beginOverlay(
        {
          maxPerFrame: 1,
          framebufferTexture: this.minimapInfo.minimapFboTex,
        },
        this.overlayProgram,
        this.vertexArray,
        {
          ranges: [{ start: 0, length: 6 }],
          uniformBuffer: new Uint8Array(this.uniformBuilder.buffer.buffer.slice(0)),
          uniformSources,
          trigger: "after",
          alphaBlend: true,
        }
      );
    } catch (e) {
      console.error("[MinimapDirection] Failed to recreate overlay:", e);
    }
  }

  /**
   * Set arrow visibility (used for mode switching)
   */
  private setArrowVisible(visible: boolean): void {
    if (this.arrowVisible === visible) return;
    this.arrowVisible = visible;

    if (visible) {
      // Show arrow - recreate immediately (not batched) for responsiveness
      this.recreateOverlayInternal();
    } else {
      // Hide arrow - stop overlay
      if (this.minimapOverlay) {
        try {
          this.minimapOverlay.stop();
        } catch {
          // Ignore
        }
        this.minimapOverlay = null;
      }
    }
  }

  /**
   * Handle player position update from PlayerPositionTracker
   * Camera yaw is now passively captured via uniformSources - no async calls needed!
   */
  private onPlayerPositionUpdate = (position: { location: { lat: number; lng: number }; floor: number }): void => {
    if (!this.uniformBuilder) {
      return;
    }

    // lat = Z (north-south), lng = X (east-west) in Leaflet convention
    // Round to whole tiles using bitwise OR (faster than Math.round for positive numbers)
    const playerX = (position.location.lng + 0.5) | 0;
    const playerZ = (position.location.lat + 0.5) | 0;

    // Camera yaw is now passively captured via uniformSources from uViewMatrix
    // No need for async getCameraInfo() calls anymore!

    // Check if position changed
    const dx = playerX - this.lastPlayerX;
    const dz = playerZ - this.lastPlayerZ;

    // Quick exit if no position change (bitwise OR combines both checks)
    if ((dx | dz) === 0) {
      return; // No change
    }

    this.lastPlayerX = playerX;
    this.lastPlayerZ = playerZ;

    // Calculate squared distance to target (avoids expensive sqrt)
    const toTargetX = playerX - this.lastTargetX;
    const toTargetZ = playerZ - this.lastTargetZ;
    const targetDistSq = toTargetX * toTargetX + toTargetZ * toTargetZ;

    // Pre-warm tracking when within 64 tiles
    if (targetDistSq <= MinimapDirectionOverlay.TRACKING_START_DISTANCE_SQ && this.lastTargetX !== 0 && this.markerOverlay) {
      if (!this.markerOverlay.isTrackingStarted()) {
        this.markerOverlay.startTracking();
      }
    }

    // Mode switching: arrow (far) vs marker (close) - respects enabled settings
    const isClose = targetDistSq <= MinimapDirectionOverlay.SWITCH_DISTANCE_SQ && this.lastTargetX !== 0;
    if (isClose) {
      // Close range: show sprite marker (if enabled), hide arrow
      if (this.arrowEnabled) {
        this.setArrowVisible(false);
      }
      if (this.markerOverlay && this.markerEnabled) {
        this.markerOverlay.setVisible(true);
        // Marker still needs camera yaw for its own positioning (uses different approach)
        this.markerOverlay.updatePosition(playerX, playerZ, 0);
      }
    } else {
      // Far range: show arrow (if enabled), hide marker
      if (this.arrowEnabled) {
        this.setArrowVisible(true);
      }
      if (this.markerOverlay) {
        this.markerOverlay.setVisible(false);
      }
    }

    // Update arrow uniforms (even if hidden, for when it becomes visible)
    // Note: uViewMatrix is sourced passively via uniformSources, not written here
    this.uniformBuilder.mappings.uPlayerPos.write([playerX, playerZ]);

    // Only recreate arrow overlay if it's visible
    if (this.arrowVisible) {
      this.recreateOverlay();
    }
  };

  setTargets(targets: MinimapTarget[]): void {
    this.targets = targets;

    // If no targets, hide overlays
    if (targets.length === 0) {
      this.clearTargets();
      return;
    }

    this.updateUniforms();
  }

  addTarget(target: MinimapTarget): void {
    this.targets.push(target);
    this.updateUniforms();
  }

  clearTargets(): void {
    this.targets = [];

    // Reset last target position so overlay knows there's no target
    this.lastTargetX = 0;
    this.lastTargetZ = 0;

    // Hide both arrow and marker overlays
    this.setArrowVisible(false);
    if (this.markerOverlay) {
      this.markerOverlay.setVisible(false);
    }
  }

  setTargetsFromQuestStep(
    npcs: Array<{ npcLocation: { lat: number; lng: number }; npcName?: string; npcId?: number }>,
    objects: Array<{ objectLocation: Array<{ lat: number; lng: number }> }>
  ): void {
    this.clearTargets();

    for (const npc of npcs) {
      if (npc.npcLocation) {
        this.addTarget({
          lat: npc.npcLocation.lat,
          lng: npc.npcLocation.lng,
          color: [255, 100, 100, 255],
          label: "NPC",
          npcName: npc.npcName,
          npcId: npc.npcId,
        });
      }
    }

    for (const obj of objects) {
      if (obj.objectLocation) {
        for (const loc of obj.objectLocation) {
          this.addTarget({
            lat: loc.lat,
            lng: loc.lng,
            color: [100, 200, 255, 255],
            label: "Object",
          });
        }
      }
    }
    this.updateUniforms();
  }

  /**
   * Update the shader uniforms when target position changes.
   */
  private updateUniforms(): void {
    if (!this.uniformBuilder) return;

    const target = this.targets[0];
    if (!target) return;

    // Target position in tiles - Leaflet convention: lat=Z (north-south), lng=X (east-west)
    const targetX = target.lng;  // East-west (longitude)
    const targetZ = target.lat;  // North-south (latitude)

    // Check if target actually changed
    if (targetX === this.lastTargetX && targetZ === this.lastTargetZ) {
      return; // No change, skip recreation
    }

    this.lastTargetX = targetX;
    this.lastTargetZ = targetZ;

    // Write target position to uniform buffer
    this.uniformBuilder.mappings.uTargetPos.write([targetX, targetZ]);

    // Arrow color (normalize from 0-255 to 0-1)
    const color = target.color || [255, 200, 0, 230];
    this.uniformBuilder.mappings.uArrowColor.write([
      color[0] / 255,
      color[1] / 255,
      color[2] / 255,
      color[3] / 255
    ]);

    // Update marker overlay target (for close-range mode)
    if (this.markerOverlay) {
      this.markerOverlay.setTarget({
        x: targetX,
        z: targetZ,
        color: [color[0] / 255, color[1] / 255, color[2] / 255, color[3] / 255],
        npcId: target.npcId,
        npcName: target.npcName,
        spriteVariant: target.spriteVariant,
      });
    }

    // Recreate overlay with new target position
    this.recreateOverlay();
  }

  /**
   * Start the overlay - subscribes to PlayerPositionTracker for position updates.
   */
  start(_intervalMs: number = 500): void {
    if (this.isTrackingPlayer) return;

    // Subscribe to player position updates (33ms = ~30fps for smooth arrow tracking)
    // Use named callback "minimap" so it doesn't overwrite other subscribers
    startPlayerTracking(this.onPlayerPositionUpdate, 33, "minimap");
    this.isTrackingPlayer = true;

    // Apply current position if available
    const currentPos = getPlayerPosition();
    if (currentPos) {
      this.onPlayerPositionUpdate(currentPos);
    }
  }

  /**
   * Stop the overlay - unsubscribes from PlayerPositionTracker.
   */
  stop(): void {
    if (!this.isTrackingPlayer) return;

    // Note: stopPlayerTracking with preserveTracker=true keeps the underlying tracker running
    // for other consumers, we just stop receiving updates
    this.isTrackingPlayer = false;
  }

  /**
   * Retry finding minimap if not found during init.
   */
  async update(): Promise<void> {
    if (!this.initialized) return;

    try {
      // Try to find minimap if not found yet
      if (!this.minimapInfo) {
        this.minimapInfo = await findMinimapRequirements();
        if (!this.minimapInfo) return;

        await this.setupOverlays();

        // Re-apply target if we have one
        if (this.targets.length > 0) {
          this.lastTargetX = 0; // Force recreation
          this.lastTargetZ = 0;
          this.updateUniforms();
        }
      }
    } catch (e) {
      console.error("[MinimapDirection] Update error:", e);
    }
  }

  isRunning(): boolean {
    return this.minimapOverlay !== null;
  }

  async dispose(): Promise<void> {
    // Stop tracking
    this.stop();

    // Stop tracking overlay (uViewMatrix capture)
    if (this.trackingOverlay) {
      try {
        this.trackingOverlay.stop();
      } catch {
        // Ignore
      }
      this.trackingOverlay = null;
    }
    this.trackingProgram = null;

    // Stop main overlay
    if (this.minimapOverlay) {
      try {
        this.minimapOverlay.stop();
      } catch {
        // Ignore
      }
      this.minimapOverlay = null;
    }

    // Stop marker overlay
    if (this.markerOverlay) {
      try {
        this.markerOverlay.stop();
      } catch {
        // Ignore
      }
      this.markerOverlay = null;
    }

    // Clear references
    this.overlayProgram = null;
    this.vertexArray = null;
    this.uniformBuilder = null;

    this.clearTargets();
    this.minimapInfo = null;
    this.initialized = false;
  }
}

// Singleton
let instance: MinimapDirectionOverlay | null = null;

export function getMinimapDirectionOverlay(): MinimapDirectionOverlay {
  if (!instance) {
    instance = new MinimapDirectionOverlay();
  }
  return instance;
}

export async function initMinimapDirectionOverlay(): Promise<MinimapDirectionOverlay> {
  const overlay = getMinimapDirectionOverlay();
  if (!overlay.isInitialized()) {
    await overlay.init();
  }
  return overlay;
}
