/**
 * MinimapMarkerOverlay - Draws NPC sprite markers at target locations on the minimap
 *
 * Used when player is close to target (< 20 tiles). Shows actual NPC sprite
 * or falls back to colored dot when sprite unavailable.
 *
 * Approach (following Skillbert's pattern):
 * 1. Tracking overlay captures uInvViewProjMatrix from backing texture renders
 * 2. Actual overlay uses minimap's geometry with template replacement
 * 3. Vertex shader transforms UV to world position using uInvViewProjMatrix
 * 4. Fragment shader compares world position to target - marker stays static on terrain
 */

import * as patchrs from "./injection/util/patchrs_napi";
import { UniformSnapshotBuilder } from "@injection/overlays/index";
import { spriteCache } from "../api/spriteApi";

/** Minimap info passed from MinimapDirectionOverlay */
export interface MinimapInfo {
  minimapFboTex: number;
  minimapBackingTex: number;
  minimapProgramId: number;
  /** Reference to minimap program for getting attribute locations and uniforms */
  minimapProg?: patchrs.GlProgram;
  /** Program that has uInvViewProjMatrix (terrain render program) - for direct sourcing */
  terrainProg?: patchrs.GlProgram;
  /** Tracking program with uViewMatrix for camera yaw (from MinimapDirectionOverlay) */
  viewMatrixTrackingProg?: patchrs.GlProgram;
}

/** Target with optional sprite info */
export interface MarkerTarget {
  /** X position in tiles (lng in Leaflet convention) */
  x: number;
  /** Z position in tiles (lat in Leaflet convention) */
  z: number;
  /** Color for fallback dot [r,g,b,a] 0-1 range */
  color?: [number, number, number, number];
  /** NPC ID for sprite lookup */
  npcId?: number;
  /** NPC name for sprite lookup */
  npcName?: string;
  /** Sprite variant */
  spriteVariant?: string;
}

// No shader code needed for tracking - Skillbert uses empty strings for passive capture

// Vertex shader template - uses minimap's geometry and transforms UV to world position
// Template placeholders {{attr}} are replaced with actual attribute locations from minimap program
const markerVertShaderTemplate = `#version 330 core

layout (location = {{aVertexPosition2D}}) in vec2 aVertexPosition2D;
layout (location = {{aTextureUV}}) in vec2 aTextureUV;

out vec3 vWorldPos;
out vec2 vScreenPos;  // Screen-space UV for sprite rendering

uniform mat4 uProjectionMatrix;
uniform mat4 uInvViewProjMatrix;

void main() {
    // Transform UV to world position using inverse view-projection matrix
    // This is the key to making the marker static in world space
    vec4 projected = uInvViewProjMatrix * vec4(aTextureUV * 2.0 - 1.0, 0.0, 1.0);
    vWorldPos = projected.xyz / projected.w;

    // Pass screen-space UV for sprite rendering (avoids perspective warping)
    vScreenPos = aTextureUV;

    gl_Position = uProjectionMatrix * vec4(aVertexPosition2D, 1.0, 1.0);
}
`;

// Fragment shader - renders marker sprite in world space (static on terrain)
// Sprite uses world-space offset with uniform scaling for minimal warping
const markerFragShader = `#version 330 core
in vec3 vWorldPos;
in vec2 vScreenPos;  // Minimap UV coordinates (unused)

uniform vec2 uMarkerWorldPos;  // Target position in world units
uniform vec2 uMarkerUV;        // Unused - kept for compatibility
uniform mat4 uViewMatrix;      // Unused - kept for compatibility
uniform float uTime;
uniform float uMarkerSize;     // Marker/sprite size in tiles
uniform float uSpriteSize;     // Unused - using uMarkerSize instead
uniform vec4 uMarkerColor;
uniform float uUseSprite;
uniform sampler2D uSprite;

void main() {
    // Distance from this fragment's world position to marker world position
    vec2 worldOffset = vWorldPos.xz - uMarkerWorldPos;
    float worldDist = length(worldOffset);

    // Marker size in world units (512 units = 1 tile)
    float worldSize = uMarkerSize * 512.0;

    // Check if we're in the marker's world-space region
    bool inMarkerRegion = worldDist < worldSize * 2.5;

    if (!inMarkerRegion) {
        discard;
    }

    // Pulsing animation
    float pulse = 0.5 + 0.5 * sin(uTime * 3.0);

    // Glow ring in WORLD space (follows terrain correctly)
    float ringRadius = worldSize * 1.4;
    float ringWidth = worldSize * 0.12;
    float ringAlpha = smoothstep(ringRadius + ringWidth, ringRadius, worldDist) *
                      smoothstep(ringRadius - ringWidth * 2.0, ringRadius - ringWidth, worldDist);
    ringAlpha *= 0.5 + 0.3 * pulse;

    // Outer glow
    float glowRadius = worldSize * 2.0;
    float glowAlpha = smoothstep(glowRadius, worldSize, worldDist) * 0.25 * pulse;

    if (uUseSprite > 0.5) {
        float spriteWorldSize = worldSize * 0.5;  // Smaller sprite

        if (worldDist < spriteWorldSize) {
            // Convert world offset to sprite UV
            // Normalize by sprite size and center at 0.5
            vec2 spriteUV = (worldOffset / spriteWorldSize) * 0.5 + vec2(0.5);
            // Flip Y for correct texture orientation
            spriteUV.y = 1.0 - spriteUV.y;

            if (spriteUV.x >= 0.0 && spriteUV.x <= 1.0 && spriteUV.y >= 0.0 && spriteUV.y <= 1.0) {
                vec4 spriteColor = texture(uSprite, spriteUV);

                if (spriteColor.a > 0.05) {
                    // Brighten the sprite colors (boost by 20%)
                    vec3 brightened = spriteColor.rgb * 1.2;
                    gl_FragColor = vec4(brightened, spriteColor.a);
                    return;
                }
            }
        }

        // Outside sprite or transparent - draw ring/glow effects
        float totalAlpha = max(ringAlpha, glowAlpha);
        if (totalAlpha > 0.01) {
            gl_FragColor = vec4(uMarkerColor.rgb, totalAlpha);
            return;
        }
        discard;
    } else {
        // DOT MODE (fallback) - world space
        float dotRadius = worldSize * 0.5;
        float edgeSmooth = worldSize * 0.1;

        if (worldDist <= dotRadius) {
            float alpha = smoothstep(dotRadius, dotRadius - edgeSmooth, worldDist);
            gl_FragColor = vec4(uMarkerColor.rgb, uMarkerColor.a * alpha);
            return;
        }

        float totalAlpha = max(ringAlpha, glowAlpha);
        if (totalAlpha > 0.01) {
            gl_FragColor = vec4(uMarkerColor.rgb, totalAlpha);
            return;
        }
        discard;
    }
}
`;

/**
 * Minimap marker overlay for close-range target visualization
 *
 * Uses Skillbert's pattern: tracking overlay captures matrix, main overlay uses it
 */
export class MinimapMarkerOverlay {
  private minimapInfo: MinimapInfo | null = null;

  // Tracking overlay - captures uInvViewProjMatrix from backing texture
  private trackingProgram: patchrs.GlProgram | null = null;
  private trackingOverlay: patchrs.GlOverlay | null = null;
  private trackingStarted = false;
  /** Distance at which to start tracking (pre-warm before marker is needed) */
  private static readonly TRACKING_START_DISTANCE = 64; // 1 chunk

  // Marker overlay
  private overlayHandle: patchrs.GlOverlay | null = null;
  private overlayProgram: patchrs.GlProgram | null = null;
  private uniformBuilder: UniformSnapshotBuilder<{
    uProjectionMatrix: "mat4";
    uInvViewProjMatrix: "mat4";
    uViewMatrix: "mat4";       // For camera yaw extraction (sourced from tracking program)
    uMarkerWorldPos: "vec2";   // Target position in world units (for glow ring)
    uMarkerUV: "vec2";         // Marker position in minimap UV space (computed on CPU)
    uTime: "float";
    uMarkerSize: "float";      // Marker size in tiles (world space effects)
    uSpriteSize: "float";      // Sprite size in UV units
    uMarkerColor: "vec4";
    uUseSprite: "float";
    uSprite: "sampler2d";
  }> | null = null;

  private spriteTexture: patchrs.TrackedTexture | null = null;
  private fallbackTexture: patchrs.TrackedTexture | null = null;
  private visible = false;
  private initialized = false;

  // Current state
  private target: MarkerTarget | null = null;

  /**
   * Initialize the marker overlay - creates tracking overlay for uInvViewProjMatrix
   */
  async init(minimapInfo: MinimapInfo): Promise<void> {
    if (this.initialized) return;

    this.minimapInfo = minimapInfo;

    // Need the minimap program to get attribute locations
    if (!minimapInfo.minimapProg) {
      console.error("[MinimapMarker] minimapProg required for attribute locations");
      return;
    }

    try {
      // === STEP 1: Create tracking overlay for uInvViewProjMatrix ===
      // This runs on backing texture renders to capture the matrix (Skillbert's pattern)
      const trackingBuilder = new UniformSnapshotBuilder({
        uInvViewProjMatrix: "mat4",
        uLastMatched: "int", 
      });
      const identity = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
      trackingBuilder.mappings.uInvViewProjMatrix.write(identity);
      trackingBuilder.mappings.uLastMatched.write([0]);

      // Create tracking program with empty shaders - just stores uniforms (Skillbert's pattern)
      this.trackingProgram = patchrs.native.createProgram(
        "", // Empty vertex shader
        "", // Empty fragment shader
        [],
        trackingBuilder.args
      );

      // NOTE: The minimap's 3D terrain is only rendered to backing texture once every ~5 seconds
      // (confirmed by Skillbert). We start tracking lazily when player is within 64 tiles,
      // giving ~5 seconds for the matrix to be captured before the marker is actually needed.

      // === STEP 2: Template replacement for vertex shader ===
      const usedAttributes = ["aVertexPosition2D", "aTextureUV"];
      let vertSource = markerVertShaderTemplate;

      for (const attr of usedAttributes) {
        const match = minimapInfo.minimapProg.inputs.find((q: { name: string }) => q.name === attr);
        if (!match) {
          console.error(`[MinimapMarker] Failed to find minimap attribute: ${attr}`);
          return;
        }
        vertSource = vertSource.replaceAll(`{{${attr}}}`, String(match.location));
      }

      // === STEP 3: Create uniform builder ===
      this.uniformBuilder = new UniformSnapshotBuilder({
        uProjectionMatrix: "mat4",
        uInvViewProjMatrix: "mat4",
        uViewMatrix: "mat4",
        uMarkerWorldPos: "vec2",
        uMarkerUV: "vec2",
        uTime: "float",
        uMarkerSize: "float",
        uSpriteSize: "float",
        uMarkerColor: "vec4",
        uUseSprite: "float",
        uSprite: "sampler2d",
      });

      // Set default values
      this.uniformBuilder.mappings.uProjectionMatrix.write(identity);
      this.uniformBuilder.mappings.uInvViewProjMatrix.write(identity);
      this.uniformBuilder.mappings.uViewMatrix.write(identity); // Sourced from tracking program
      this.uniformBuilder.mappings.uMarkerWorldPos.write([0, 0]);
      this.uniformBuilder.mappings.uMarkerUV.write([0.5, 0.5]); // Center of minimap
      this.uniformBuilder.mappings.uTime.write([0]);
      this.uniformBuilder.mappings.uMarkerSize.write([2.0]); // 2 tiles size (world space effects)
      this.uniformBuilder.mappings.uSpriteSize.write([0.12]); // Sprite size in UV (12% of minimap)
      this.uniformBuilder.mappings.uMarkerColor.write([1.0, 0.8, 0.0, 0.9]); // Golden yellow
      this.uniformBuilder.mappings.uUseSprite.write([0]);
      this.uniformBuilder.mappings.uSprite.write([0]);

      // === STEP 4: Create shader program ===
      this.overlayProgram = patchrs.native.createProgram(
        vertSource,
        markerFragShader,
        [], // No attributes - uses minimap's geometry
        this.uniformBuilder.args
      );

      // Create fallback texture
      const fallbackData = new ImageData(new Uint8ClampedArray([255, 255, 255, 255]), 1, 1);
      this.fallbackTexture = patchrs.native.createTexture(fallbackData);

      this.initialized = true;
    } catch (e) {
      console.error("[MinimapMarker] Init error:", e);
      throw e;
    }
  }

  /**
   * Set the target to mark
   */
  async setTarget(target: MarkerTarget | null): Promise<void> {
    this.target = target;

    if (!target) {
      this.setVisible(false);
      return;
    }

    if (this.uniformBuilder) {
      // Convert tile position to world units (1 tile = 512 units)
      const worldX = target.x * 512;
      const worldZ = target.z * 512;
      this.uniformBuilder.mappings.uMarkerWorldPos.write([worldX, worldZ]);

      if (target.color) {
        this.uniformBuilder.mappings.uMarkerColor.write(target.color);
      }
    }

    // Show immediately with fallback, load sprite in background
    this.spriteTexture = null;
    if (this.uniformBuilder) {
      this.uniformBuilder.mappings.uUseSprite.write([0]);
    }

    // Create overlay immediately with fallback
    if (this.visible) {
      this.recreateOverlay();
    }

    // Load sprite in background (non-blocking)
    if (target.npcId || target.npcName) {
      this.loadSprite(target).then(() => {
        // Re-create overlay with sprite once loaded
        if (this.visible && this.target === target) {
          this.recreateOverlay();
        }
      });
    }
  }

  /**
   * Load sprite texture for target
   */
  private async loadSprite(target: MarkerTarget): Promise<void> {
    try {
      const imageData = await spriteCache.get({
        npcId: target.npcId,
        name: target.npcName,
        variant: target.spriteVariant,
      });

      this.spriteTexture = patchrs.native.createTexture(imageData);

      if (this.uniformBuilder) {
        this.uniformBuilder.mappings.uUseSprite.write([1]);
        this.uniformBuilder.mappings.uMarkerSize.write([5.0]); // Larger for sprite (tiles)
      }
    } catch (e) {
      this.spriteTexture = null;
      if (this.uniformBuilder) {
        this.uniformBuilder.mappings.uUseSprite.write([0]);
        this.uniformBuilder.mappings.uMarkerSize.write([3.0]); // Dot size (tiles)
      }
    }
  }

  /**
   * Start the passive tracking overlay to capture uInvViewProjMatrix.
   * Call this when player is within ~64 tiles of target to pre-warm before marker is needed.
   */
  startTracking(): void {
    if (this.trackingStarted || !this.minimapInfo || !this.trackingProgram) {
      return;
    }

    // Start PASSIVE tracking overlay on backing texture to capture uInvViewProjMatrix
    // trigger: "passive" means it captures uniforms without rendering
    this.trackingOverlay = patchrs.native.beginOverlay(
      {
        maxPerFrame: 1,
        framebufferTexture: this.minimapInfo.minimapBackingTex,
      },
      this.trackingProgram,
      undefined,
      {
        ranges: [], // No geometry to draw
        uniformSources: [
          { type: "program", name: "uInvViewProjMatrix", sourceName: "uInvViewProjMatrix" },
          { type: "builtin", name: "uLastMatched", sourceName: "framenr" },
        ],
        trigger: "passive",
      }
    );
    this.trackingStarted = true;
  }

  /**
   * Check if tracking has started
   */
  isTrackingStarted(): boolean {
    return this.trackingStarted;
  }

  /**
   * Get the distance threshold for starting tracking
   */
  static getTrackingStartDistance(): number {
    return MinimapMarkerOverlay.TRACKING_START_DISTANCE;
  }

  /**
   * Update position - triggers overlay recreation if visible
   * The shader uses world-space positioning so no CPU-side position calculation needed.
   *
   * @param _playerX Player X position in tiles (unused - shader uses world coords)
   * @param _playerZ Player Z position in tiles (unused - shader uses world coords)
   * @param _cameraYaw Camera yaw (unused - shader uses world-space positioning)
   */
  updatePosition(_playerX: number, _playerZ: number, _cameraYaw: number): void {
    // Recreate overlay to update uniforms (time, etc.)
    if (this.visible && this.uniformBuilder) {
      this.recreateOverlay();
    }
  }

  /**
   * Show or hide the marker
   */
  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;

    if (visible && this.target) {
      this.recreateOverlay();
    } else if (!visible) {
      if (this.overlayHandle) {
        this.overlayHandle.stop();
        this.overlayHandle = null;
      }
    }
  }

  /**
   * Check if marker is visible
   */
  isVisible(): boolean {
    return this.visible;
  }

  /**
   * Recreate the overlay with current uniforms
   */
  private recreateOverlay(): void {
    if (this.overlayHandle) {
      this.overlayHandle.stop();
      this.overlayHandle = null;
    }

    if (!this.visible || !this.minimapInfo || !this.overlayProgram || !this.uniformBuilder || !this.trackingProgram) {
      return;
    }

    const texture = this.spriteTexture || this.fallbackTexture;
    if (!texture) return;

    try {
      // Build uniform sources
      const uniformSources: patchrs.OverlayUniformSource[] = [
        // Source uInvViewProjMatrix from tracking program (captured from backing texture)
        { type: "program", name: "uInvViewProjMatrix", sourceName: "uInvViewProjMatrix", program: this.trackingProgram },
        { type: "program", name: "uProjectionMatrix", sourceName: "uProjectionMatrix" },
        { type: "builtin", name: "uTime", sourceName: "timestamp" },
      ];

      // Source uViewMatrix from arrow's tracking program (for camera yaw in sprite positioning)
      if (this.minimapInfo.viewMatrixTrackingProg) {
        uniformSources.push({
          type: "program",
          name: "uViewMatrix",
          sourceName: "uViewMatrix",
          program: this.minimapInfo.viewMatrixTrackingProg,
        });
      }

      // Create overlay on FBO texture, sourcing matrices from tracking programs
      this.overlayHandle = patchrs.native.beginOverlay(
        {
          maxPerFrame: 1,
          framebufferTexture: this.minimapInfo.minimapFboTex,
        },
        this.overlayProgram,
        undefined, // Uses minimap's geometry
        {
          uniformBuffer: new Uint8Array(this.uniformBuilder.buffer.buffer),
          samplers: { "0": texture },
          uniformSources,
          trigger: "after",
          alphaBlend: true,
        }
      );
    } catch (e) {
      console.error("[MinimapMarker] Failed to create overlay:", e);
    }
  }

  /**
   * Stop the overlay
   */
  stop(): void {
    if (this.overlayHandle) {
      this.overlayHandle.stop();
      this.overlayHandle = null;
    }

    if (this.trackingOverlay) {
      this.trackingOverlay.stop();
      this.trackingOverlay = null;
    }

    this.trackingStarted = false;
    this.visible = false;
  }

  /**
   * Check if initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }
}

// Singleton instance
let _markerOverlay: MinimapMarkerOverlay | null = null;

export function getMinimapMarkerOverlay(): MinimapMarkerOverlay {
  if (!_markerOverlay) {
    _markerOverlay = new MinimapMarkerOverlay();
  }
  return _markerOverlay;
}
