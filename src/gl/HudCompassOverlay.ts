/**
 * HudCompassOverlay - 2D screen-space compass HUD that glows toward quest objectives
 *
 * Features:
 * - 8-blade compass rose rendered in screen space
 * - Blade pointing toward target glows gold/amber
 * - All blades glow when player reaches destination
 * - Supports 1920x1080 and 4K via UIScaleManager
 * - User-draggable position with per-resolution persistence
 */

import * as patchrs from "./injection/util/patchrs_napi";
import { GL_FLOAT, UniformSnapshotBuilder } from "./injection/overlays/index";
import { onResolutionChange, getUIScaleInfo, UIScaleInfo } from "./UIScaleManager";
import { startPlayerTracking, stopPlayerTracking, getPlayerPosition, onTeleportStateChange, offTeleportStateChange } from "./PlayerPositionTracker";
import { getProgramMeta } from "./injection/render/renderprogram";
import { hudCompassVertShader, hudCompassFragShader } from "./shaders";

// Storage key prefix for overlay position (per-resolution)
const POSITION_STORAGE_KEY_PREFIX = "hudCompassOverlay:position:";

// Default overlay size in UI pixels (increased for better visibility)
const DEFAULT_SIZE = 140;

// Distance threshold for "arrived at destination" (tiles)
const ARRIVAL_DISTANCE = 3;

export interface HudCompassPosition {
  x: number;
  y: number;
}

export class HudCompassOverlay {
  private overlayHandle: patchrs.GlOverlay | null = null;
  private program: patchrs.GlProgram | null = null;
  private vertexArray: patchrs.VertexArraySnapshot | null = null;
  private uniformBuilder: UniformSnapshotBuilder<{
    uScreenSize: "vec2";
    uPosition: "vec2";
    uSize: "vec2";
    uFlipY: "float";
    uTime: "float";
    uBladeGlow1: "vec4";
    uBladeGlow2: "vec4";
    uBaseColor: "vec4";
    uGlowColor: "vec4";
  }> | null = null;

  // State
  private position: HudCompassPosition;
  private size = { width: DEFAULT_SIZE, height: DEFAULT_SIZE };
  private uiSize: { width: number; height: number } | null = null;
  private visible = false;
  private initialized = false;

  // Target tracking
  private targetX = 0;
  private targetZ = 0;
  private hasTarget = false;
  private atDestination = false;

  // Blade glow state (0-7: N, NE, E, SE, S, SW, W, NW)
  private bladeGlow = [0, 0, 0, 0, 0, 0, 0, 0];

  // Animation
  private animationTime = 0;
  private animationFrame: number | null = null;
  private lastFrameTime = 0;

  // Player tracking
  private isTrackingPlayer = false;

  // Resolution change subscription
  private unsubscribeResolution: (() => void) | null = null;

  // Cached UI framebuffer info for 4K rendering
  private uiFramebufferInfo: { framebufferId: number; width: number; height: number } | null = null;

  // Teleport suppression
  private teleportCallbackId: string | null = null;
  private hiddenForTeleport = false;

  constructor() {
    // Load saved position or use default (bottom-right area)
    this.position = this.loadPosition();
  }

  /**
   * Initialize the overlay system
   */
  async init(): Promise<boolean> {
    if (this.initialized) return true;

    try {
      if (!patchrs.native) {
        console.warn("[HudCompass] Native addon not available");
        return false;
      }

      // Get initial UI dimensions
      const scaleInfo = getUIScaleInfo();
      this.uiSize = { width: scaleInfo.uiWidth, height: scaleInfo.uiHeight };

      // Subscribe to resolution changes
      this.unsubscribeResolution = onResolutionChange(this.handleResolutionChange);

      // Create uniform builder
      this.uniformBuilder = new UniformSnapshotBuilder({
        uScreenSize: "vec2",
        uPosition: "vec2",
        uSize: "vec2",
        uFlipY: "float",
        uTime: "float",
        uBladeGlow1: "vec4",  // N, NE, E, SE
        uBladeGlow2: "vec4",  // S, SW, W, NW
        uBaseColor: "vec4",
        uGlowColor: "vec4",
      });

      // Set default values
      this.uniformBuilder.mappings.uScreenSize.write([scaleInfo.uiWidth, scaleInfo.uiHeight]);
      this.uniformBuilder.mappings.uPosition.write([this.position.x, this.position.y]);
      this.uniformBuilder.mappings.uSize.write([this.size.width, this.size.height]);
      this.uniformBuilder.mappings.uFlipY.write([1.0]);  // Default to frameend mode
      this.uniformBuilder.mappings.uTime.write([0.0]);
      this.uniformBuilder.mappings.uBladeGlow1.write([0, 0, 0, 0]);
      this.uniformBuilder.mappings.uBladeGlow2.write([0, 0, 0, 0]);
      // Deep blue-black base (more saturated, darker)
      this.uniformBuilder.mappings.uBaseColor.write([0.05, 0.08, 0.18, 1.0]);
      // Bright gold/amber glow (more saturated and vibrant)
      this.uniformBuilder.mappings.uGlowColor.write([1.0, 0.8, 0.1, 1.0]);

      // Create shader program
      this.program = patchrs.native.createProgram(
        hudCompassVertShader,
        hudCompassFragShader,
        [
          { location: 0, name: "aPos", type: GL_FLOAT, length: 2 },
          { location: 1, name: "aUV", type: GL_FLOAT, length: 2 },
        ],
        this.uniformBuilder.args
      );

      // Create vertex array (unit quad)
      this.vertexArray = this.createVertexArray();

      // Subscribe to teleport events to hide during teleports
      this.teleportCallbackId = onTeleportStateChange((isTeleporting) => {
        if (isTeleporting) {
          // Teleport started - hide the overlay to prevent distortion
          if (this.visible && this.overlayHandle) {
            this.hiddenForTeleport = true;
            this.stopOverlay();
            console.log("[HudCompass] Hidden for teleport");
          }
        } else {
          // Teleport ended - restore overlay if it was hidden
          if (this.hiddenForTeleport && this.visible) {
            this.hiddenForTeleport = false;
            this.recreateOverlay();
            console.log("[HudCompass] Restored after teleport");
          }
        }
      }, "hudCompassOverlay");

      this.initialized = true;
      console.log("[HudCompass] Initialized");
      return true;
    } catch (e) {
      console.error("[HudCompass] Failed to initialize:", e);
      return false;
    }
  }

  /**
   * Create vertex array for a unit quad
   */
  private createVertexArray(): patchrs.VertexArraySnapshot {
    // Quad vertices: position (0-1) and UV (0-1)
    const vertices = new Float32Array([
      // Position   UV
      0, 0,        0, 0,  // bottom-left
      1, 0,        1, 0,  // bottom-right
      1, 1,        1, 1,  // top-right
      0, 1,        0, 1,  // top-left
    ]);

    // CCW winding after Y-flip (matches QuestStepOverlay)
    const indices = new Uint16Array([
      0, 3, 2,
      0, 2, 1,
    ]);

    const posBuffer = new Uint8Array(vertices.buffer);

    return patchrs.native!.createVertexArray(
      new Uint8Array(indices.buffer),
      [
        {
          location: 0,
          buffer: posBuffer,
          enabled: true,
          normalized: false,
          offset: 0,
          scalartype: GL_FLOAT,
          stride: 16,
          vectorlength: 2,
        },
        {
          location: 1,
          buffer: posBuffer,
          enabled: true,
          normalized: false,
          offset: 8,
          scalartype: GL_FLOAT,
          stride: 16,
          vectorlength: 2,
        },
      ]
    );
  }

  /**
   * Handle resolution changes from UIScaleManager
   */
  private handleResolutionChange = (info: UIScaleInfo): void => {
    const newWidth = info.uiWidth;
    const newHeight = info.uiHeight;

    // Ignore small/invalid dimensions (window minimized)
    if (newWidth < 100 || newHeight < 100) return;

    const oldWidth = this.uiSize?.width ?? 0;
    const oldHeight = this.uiSize?.height ?? 0;

    // Invalidate cached framebuffer info
    this.uiFramebufferInfo = null;

    if (newWidth !== oldWidth || newHeight !== oldHeight) {
      console.log(`[HudCompass] Resolution changed: ${oldWidth}x${oldHeight} -> ${newWidth}x${newHeight}`);
      this.uiSize = { width: newWidth, height: newHeight };

      // Load position for this resolution
      const savedPosition = this.loadPositionForResolution(newWidth, newHeight);

      // Clamp to screen bounds
      const maxX = Math.max(0, newWidth - this.size.width);
      const maxY = Math.max(0, newHeight - this.size.height);
      this.position = {
        x: Math.max(0, Math.min(savedPosition.x, maxX)),
        y: Math.max(0, Math.min(savedPosition.y, maxY)),
      };

      if (this.visible) {
        this.recreateOverlay();
      }
    }
  };

  /**
   * Get storage key for current resolution
   */
  private getPositionStorageKey(): string {
    const width = this.uiSize?.width ?? 1920;
    const height = this.uiSize?.height ?? 1080;
    return `${POSITION_STORAGE_KEY_PREFIX}${width}x${height}`;
  }

  /**
   * Load position from localStorage
   */
  private loadPosition(): HudCompassPosition {
    try {
      const saved = localStorage.getItem(this.getPositionStorageKey());
      if (saved) {
        const pos = JSON.parse(saved);
        if (typeof pos.x === "number" && typeof pos.y === "number") {
          return pos;
        }
      }
    } catch {
      // Ignore
    }
    // Default: bottom-right area
    return { x: 1700, y: 900 };
  }

  /**
   * Load position for a specific resolution
   */
  private loadPositionForResolution(width: number, height: number): HudCompassPosition {
    try {
      const key = `${POSITION_STORAGE_KEY_PREFIX}${width}x${height}`;
      const saved = localStorage.getItem(key);
      if (saved) {
        const pos = JSON.parse(saved);
        if (typeof pos.x === "number" && typeof pos.y === "number") {
          return pos;
        }
      }
    } catch {
      // Ignore
    }
    // Default: bottom-right area, scaled for resolution
    return { x: width - 220, y: height - 200 };
  }

  /**
   * Save position to localStorage
   */
  private savePosition(): void {
    try {
      localStorage.setItem(this.getPositionStorageKey(), JSON.stringify(this.position));
    } catch {
      // Ignore
    }
  }

  /**
   * Set target position to point toward
   */
  setTarget(lat: number, lng: number): void {
    this.targetX = lng;  // East-West
    this.targetZ = lat;  // North-South
    this.hasTarget = true;
    this.atDestination = false;

    console.log(`[HudCompass] Target set to (${lng}, ${lat})`);

    // If we have player position, update glow immediately
    const playerPos = getPlayerPosition();
    if (playerPos) {
      this.updateGlow(playerPos.location.lng, playerPos.location.lat);
    }
  }

  /**
   * Clear target
   */
  clearTarget(): void {
    this.hasTarget = false;
    this.targetX = 0;
    this.targetZ = 0;
    this.atDestination = false;
    this.bladeGlow.fill(0);

    if (this.visible) {
      this.updateBladeGlowUniforms();
      // Use live update instead of recreating
      this.updateBladeGlowLive();
    }

    console.log("[HudCompass] Target cleared");
  }

  /**
   * Set overlay position
   */
  setPosition(x: number, y: number): void {
    // Clamp to UI bounds
    const maxX = (this.uiSize?.width ?? 1920) - this.size.width;
    const maxY = (this.uiSize?.height ?? 1080) - this.size.height;
    this.position = {
      x: Math.max(0, Math.min(x, maxX)),
      y: Math.max(0, Math.min(y, maxY)),
    };
    this.savePosition();

    if (this.visible) {
      this.recreateOverlay();
    }
  }

  /**
   * Get current position
   */
  getPosition(): HudCompassPosition {
    return { ...this.position };
  }

  /**
   * Get overlay size
   */
  getSize(): { width: number; height: number } {
    return { ...this.size };
  }

  /**
   * Set overlay visible
   */
  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;

    if (visible) {
      this.startTracking();
      this.startAnimation();

      // If we have a target, immediately update glow with current player position
      // This ensures direction shows immediately when compass becomes visible
      if (this.hasTarget) {
        const playerPos = getPlayerPosition();
        if (playerPos) {
          this.updateGlow(playerPos.location.lng, playerPos.location.lat);
          this.updateBladeGlowUniforms();
        }
      }

      this.recreateOverlay();
    } else {
      this.stopTracking();
      this.stopAnimation();
      this.stopOverlay();
    }

    console.log(`[HudCompass] Visible: ${visible}`);
  }

  /**
   * Check if visible
   */
  isVisible(): boolean {
    return this.visible;
  }

  /**
   * Check if initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Start player position tracking
   */
  private startTracking(): void {
    if (this.isTrackingPlayer) return;

    startPlayerTracking(this.onPlayerPositionUpdate, 100, "hudcompass");
    this.isTrackingPlayer = true;
    console.log("[HudCompass] Started player tracking");
  }

  /**
   * Stop player position tracking
   */
  private stopTracking(): void {
    if (!this.isTrackingPlayer) return;

    stopPlayerTracking(true, "hudcompass");
    this.isTrackingPlayer = false;
    console.log("[HudCompass] Stopped player tracking");
  }

  /**
   * Handle player position update
   */
  private onPlayerPositionUpdate = (position: { location: { lat: number; lng: number }; floor: number }): void => {
    const playerX = position.location.lng;  // East-West
    const playerZ = position.location.lat;  // North-South
    this.updateGlow(playerX, playerZ);
  };

  /**
   * Update blade glow based on player position relative to target
   */
  private updateGlow(playerX: number, playerZ: number): void {
    if (!this.hasTarget) {
      // No target - clear all glow
      const changed = this.bladeGlow.some(g => g !== 0);
      if (changed) {
        this.bladeGlow.fill(0);
        this.updateBladeGlowUniforms();
        this.recreateOverlay();
      }
      return;
    }

    const dx = this.targetX - playerX;
    const dz = this.targetZ - playerZ;
    const distance = Math.sqrt(dx * dx + dz * dz);

    const prevAtDest = this.atDestination;
    const prevGlow = [...this.bladeGlow];

    if (distance < ARRIVAL_DISTANCE) {
      // At destination - all blades glow
      this.bladeGlow.fill(1.0);
      this.atDestination = true;
    } else {
      // Calculate direction to target
      // atan2(dx, dz) gives angle where 0 = North, positive = clockwise
      const angle = Math.atan2(dx, dz);
      const normalizedAngle = (angle + 2 * Math.PI) % (2 * Math.PI);
      const bladeAngle = Math.PI / 4;  // 45 degrees per blade

      // Map to blade index (0-7: N, NE, E, SE, S, SW, W, NW)
      const rawBlade = Math.round(normalizedAngle / bladeAngle) % 8;
      // Only swap E (2) ↔ W (6), leave other blades unchanged
      const primaryBlade = rawBlade === 2 ? 6 : rawBlade === 6 ? 2 : rawBlade;

      // Set glow with adjacent falloff
      for (let i = 0; i < 8; i++) {
        if (i === primaryBlade) {
          this.bladeGlow[i] = 1.0;
        } else if (i === (primaryBlade + 1) % 8 || i === (primaryBlade + 7) % 8) {
          this.bladeGlow[i] = 0.3;  // Adjacent blades partial glow
        } else {
          this.bladeGlow[i] = 0;
        }
      }
      this.atDestination = false;
    }

    // Only update if glow changed
    const glowChanged = prevAtDest !== this.atDestination ||
      this.bladeGlow.some((g, i) => g !== prevGlow[i]);

    if (glowChanged && this.visible) {
      this.updateBladeGlowUniforms();
      // Use live update instead of recreating overlay
      this.updateBladeGlowLive();
    }
  }

  /**
   * Update blade glow uniforms via live update (no overlay recreation)
   */
  private updateBladeGlowLive(): void {
    if (!this.overlayHandle || !this.uniformBuilder) return;

    try {
      const uniformState = this.overlayHandle.getUniformState();
      const view = new DataView(uniformState.buffer, uniformState.byteOffset, uniformState.byteLength);

      // Calculate offsets:
      // uScreenSize: vec2 = 8 bytes (offset 0)
      // uPosition: vec2 = 8 bytes (offset 8)
      // uSize: vec2 = 8 bytes (offset 16)
      // uFlipY: float = 4 bytes (offset 24)
      // uTime: float = 4 bytes (offset 28)
      // uBladeGlow1: vec4 = 16 bytes (offset 32)
      // uBladeGlow2: vec4 = 16 bytes (offset 48)
      const glowOffset1 = 32;
      const glowOffset2 = 48;

      // Write uBladeGlow1 (N, NE, E, SE)
      view.setFloat32(glowOffset1, this.bladeGlow[0], true);
      view.setFloat32(glowOffset1 + 4, this.bladeGlow[1], true);
      view.setFloat32(glowOffset1 + 8, this.bladeGlow[2], true);
      view.setFloat32(glowOffset1 + 12, this.bladeGlow[3], true);

      // Write uBladeGlow2 (S, SW, W, NW)
      view.setFloat32(glowOffset2, this.bladeGlow[4], true);
      view.setFloat32(glowOffset2 + 4, this.bladeGlow[5], true);
      view.setFloat32(glowOffset2 + 8, this.bladeGlow[6], true);
      view.setFloat32(glowOffset2 + 12, this.bladeGlow[7], true);

      this.overlayHandle.setUniformState(uniformState);
    } catch (e) {
      // If live update fails, fall back to recreating overlay
      console.warn("[HudCompass] Live glow update failed, recreating overlay:", e);
      this.recreateOverlay();
    }
  }

  /**
   * Update blade glow uniforms
   */
  private updateBladeGlowUniforms(): void {
    if (!this.uniformBuilder) return;

    // Pack into two vec4s: [N, NE, E, SE] and [S, SW, W, NW]
    this.uniformBuilder.mappings.uBladeGlow1.write([
      this.bladeGlow[0], this.bladeGlow[1], this.bladeGlow[2], this.bladeGlow[3]
    ]);
    this.uniformBuilder.mappings.uBladeGlow2.write([
      this.bladeGlow[4], this.bladeGlow[5], this.bladeGlow[6], this.bladeGlow[7]
    ]);
  }

  /**
   * Start animation loop for time uniform
   * Uses live uniform updates instead of recreating overlay every frame
   */
  private startAnimation(): void {
    if (this.animationFrame !== null) return;

    this.lastFrameTime = performance.now();
    const animate = () => {
      const now = performance.now();
      const dt = (now - this.lastFrameTime) / 1000;
      this.lastFrameTime = now;

      this.animationTime += dt;

      // Update time uniform via live update (no overlay recreation!)
      if (this.overlayHandle && this.visible) {
        this.updateTimeLive();
      }

      if (this.visible) {
        this.animationFrame = requestAnimationFrame(animate);
      }
    };

    this.animationFrame = requestAnimationFrame(animate);
  }

  /**
   * Update time uniform without recreating overlay (for smooth animation)
   */
  private updateTimeLive(): void {
    if (!this.overlayHandle || !this.uniformBuilder) return;

    try {
      const uniformState = this.overlayHandle.getUniformState();
      const view = new DataView(uniformState.buffer, uniformState.byteOffset, uniformState.byteLength);

      // uTime is at offset 20 (after uScreenSize:8 + uPosition:8 + uSize:8 + uFlipY:4 = 28)
      // Wait, let's calculate properly:
      // uScreenSize: vec2 = 8 bytes (offset 0)
      // uPosition: vec2 = 8 bytes (offset 8)
      // uSize: vec2 = 8 bytes (offset 16)
      // uFlipY: float = 4 bytes (offset 24)
      // uTime: float = 4 bytes (offset 28)
      view.setFloat32(28, this.animationTime, true);

      this.overlayHandle.setUniformState(uniformState);
    } catch (e) {
      // If live update fails, don't spam errors
      console.warn("[HudCompass] Live time update failed:", e);
    }
  }

  /**
   * Stop animation loop
   */
  private stopAnimation(): void {
    if (this.animationFrame !== null) {
      cancelAnimationFrame(this.animationFrame);
      this.animationFrame = null;
    }
  }

  /**
   * Find UI framebuffer for 4K rendering
   */
  private async findUIFramebuffer(): Promise<{ framebufferId: number; width: number; height: number } | null> {
    if (this.uiFramebufferInfo) {
      return this.uiFramebufferInfo;
    }

    if (!patchrs.native) return null;

    try {
      // Record from screen to find Lanczos scaler
      const screenRenders = await patchrs.native.recordRenderCalls({
        maxframes: 1,
        features: ["texturesnapshot"],
        framebufferId: 0,
      });

      let scalingTextureId = 0;
      for (const render of screenRenders) {
        if (!render.program) continue;
        const meta = getProgramMeta(render.program);
        if (meta.isUiScaler) {
          const textureData = render.samplers || render.textures || {};
          const sampler = Object.values(textureData)[0] as patchrs.TextureSnapshot | patchrs.TrackedTexture | undefined;
          if (sampler) {
            scalingTextureId = sampler.texid;
            break;
          }
        }
      }

      if (scalingTextureId > 0) {
        const uiRenders = await patchrs.native.recordRenderCalls({
          maxframes: 1,
          features: [],
          framebufferTexture: scalingTextureId,
        });

        const uiRender = uiRenders.find(r => r.viewport);
        if (uiRender && uiRender.viewport) {
          this.uiFramebufferInfo = {
            framebufferId: uiRender.framebufferId,
            width: uiRender.viewport.width,
            height: uiRender.viewport.height,
          };
          return this.uiFramebufferInfo;
        }
      }

      return null;
    } catch (e) {
      console.warn("[HudCompass] Error finding UI framebuffer:", e);
      return null;
    }
  }

  /**
   * Recreate the overlay with current state
   */
  private async recreateOverlay(): Promise<void> {
    if (!this.initialized || !this.uniformBuilder || !this.program || !this.vertexArray) {
      return;
    }

    // Stop existing overlay
    this.stopOverlay();

    if (!this.visible) return;

    const scaleInfo = getUIScaleInfo();
    const isScaled = scaleInfo.isScaled;

    try {
      if (isScaled) {
        // 4K mode: render to UI framebuffer
        const uiFb = await this.findUIFramebuffer();

        if (uiFb) {
          // Convert screen Y to OpenGL Y (flip)
          const glPositionY = uiFb.height - this.position.y - this.size.height;

          this.uniformBuilder.mappings.uScreenSize.write([uiFb.width, uiFb.height]);
          this.uniformBuilder.mappings.uPosition.write([this.position.x, glPositionY]);
          this.uniformBuilder.mappings.uSize.write([this.size.width, this.size.height]);
          this.uniformBuilder.mappings.uFlipY.write([0.0]);  // No Y flip for framebuffer

          this.overlayHandle = patchrs.native!.beginOverlay(
            { framebufferId: uiFb.framebufferId },
            this.program,
            this.vertexArray,
            {
              uniformBuffer: new Uint8Array(this.uniformBuilder.buffer.buffer.slice(0)),
              renderMode: "triangles",
              trigger: "after",  // 4K uses "after" to render after UI framebuffer draws
              uniformSources: [],
              alphaBlend: true,
            }
          );
        } else {
          // Fallback: scale to screen coords
          const scaleX = scaleInfo.screenWidth / scaleInfo.uiWidth;
          const scaleY = scaleInfo.screenHeight / scaleInfo.uiHeight;

          this.uniformBuilder.mappings.uScreenSize.write([scaleInfo.screenWidth, scaleInfo.screenHeight]);
          this.uniformBuilder.mappings.uPosition.write([this.position.x * scaleX, this.position.y * scaleY]);
          this.uniformBuilder.mappings.uSize.write([this.size.width * scaleX, this.size.height * scaleY]);
          this.uniformBuilder.mappings.uFlipY.write([1.0]);

          this.overlayHandle = patchrs.native!.beginOverlay(
            {},
            this.program,
            this.vertexArray,
            {
              uniformBuffer: new Uint8Array(this.uniformBuilder.buffer.buffer.slice(0)),
              renderMode: "triangles",
              trigger: "frameend",
              uniformSources: [],
              alphaBlend: true,
            }
          );
        }
      } else {
        // 1080p mode: direct screen rendering
        this.uniformBuilder.mappings.uScreenSize.write([scaleInfo.screenWidth, scaleInfo.screenHeight]);
        this.uniformBuilder.mappings.uPosition.write([this.position.x, this.position.y]);
        this.uniformBuilder.mappings.uSize.write([this.size.width, this.size.height]);
        this.uniformBuilder.mappings.uFlipY.write([1.0]);

        this.overlayHandle = patchrs.native!.beginOverlay(
          {},
          this.program,
          this.vertexArray,
          {
            uniformBuffer: new Uint8Array(this.uniformBuilder.buffer.buffer.slice(0)),
            renderMode: "triangles",
            trigger: "frameend",
            uniformSources: [],
            alphaBlend: true,
          }
        );
      }
    } catch (e) {
      console.error("[HudCompass] Failed to create overlay:", e);
    }
  }

  /**
   * Stop the overlay
   */
  private stopOverlay(): void {
    if (this.overlayHandle) {
      try {
        this.overlayHandle.stop();
      } catch {
        // Ignore
      }
      this.overlayHandle = null;
    }
  }

  /**
   * Dispose all resources
   */
  dispose(): void {
    console.log("[HudCompass] Disposing...");

    this.setVisible(false);

    if (this.unsubscribeResolution) {
      this.unsubscribeResolution();
      this.unsubscribeResolution = null;
    }

    // Unsubscribe from teleport events
    if (this.teleportCallbackId) {
      offTeleportStateChange(this.teleportCallbackId);
      this.teleportCallbackId = null;
    }
    this.hiddenForTeleport = false;

    this.stopOverlay();

    this.program = null;
    this.vertexArray = null;
    this.uniformBuilder = null;
    this.initialized = false;

    console.log("[HudCompass] Disposed");
  }
}

// Singleton instance
let instance: HudCompassOverlay | null = null;

export function getHudCompassOverlay(): HudCompassOverlay {
  if (!instance) {
    instance = new HudCompassOverlay();
  }
  return instance;
}

export async function initHudCompassOverlay(): Promise<HudCompassOverlay> {
  const overlay = getHudCompassOverlay();
  if (!overlay.isInitialized()) {
    await overlay.init();
  }
  return overlay;
}
