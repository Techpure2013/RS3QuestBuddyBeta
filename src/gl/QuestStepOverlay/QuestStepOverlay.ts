/**
 * QuestStepOverlay - Renders quest step info as a GL overlay on the RS client
 *
 * Features:
 * - Renders current step description and dialog options
 * - User-positionable (drag to move)
 * - Persists position to localStorage
 * - Auto-hides when no quest active
 * - Handles 4K by scaling position/size to screen coordinates
 */

import * as patchrs from "@injection/util/patchrs_napi";
import { renderQuestStep } from "./TextRenderer";
import { UniformSnapshotBuilder, GL_FLOAT } from "@injection/overlays/index";
import { onResolutionChange, UIScaleInfo, getUIScaleInfo } from "../UIScaleManager";
import { getProgramMeta } from "@injection/render/renderprogram";
import { onTeleportStateChange, offTeleportStateChange } from "../PlayerPositionTracker";

// Storage key prefix for overlay position (keyed by resolution for multi-monitor support)
const POSITION_STORAGE_KEY_PREFIX = "questStepOverlay:position:";
// Legacy storage key for migration
const LEGACY_POSITION_KEY = "questStepOverlay:position";

// Overlay shader - simple textured quad
const VERTEX_SHADER = `
  #version 330 core
  layout (location = 0) in vec2 aPos;
  layout (location = 1) in vec2 aUV;

  uniform vec2 uScreenSize;
  uniform vec2 uPosition;
  uniform vec2 uSize;
  uniform float uFlipY; // 1.0 = flip Y for screen coords, 0.0 = no flip for UI framebuffer
  uniform float uFlipV; // 1.0 = flip V texture coord (needed for framebuffer rendering)
  uniform vec4 uViewport; // Live viewport from GL state (x, y, width, height) — updated each frame via uniformSources

  out vec2 vUV;

  void main() {
    // Scale vertex position (0-1) to actual size
    vec2 scaledPos = aPos * uSize;
    // Add position offset
    vec2 screenPos = scaledPos + uPosition;
    // Use live viewport dimensions (zw) when available, fall back to baked uScreenSize
    // This prevents oversized rendering when GL viewport changes during teleport/transitions
    vec2 screenDims = uViewport.z > 0.0 ? uViewport.zw : uScreenSize;
    // Convert to NDC: [0, screenSize] -> [-1, 1]
    vec2 ndc = (screenPos / screenDims) * 2.0 - 1.0;
    // Conditionally flip Y axis based on render target
    // - frameend (screen): flip Y (screen coords have Y=0 at top)
    // - UI framebuffer (4K): no flip (OpenGL coords have Y=0 at bottom)
    if (uFlipY > 0.5) {
      ndc.y = -ndc.y;
    }
    gl_Position = vec4(ndc, 0.0, 1.0);
    // Flip V coordinate for framebuffer rendering
    // Canvas renders with Y=0 at top, but OpenGL textures have Y=0 at bottom
    // For frameend: Y-flip in NDC cancels this out
    // For framebuffer: Need to flip V to correct texture orientation
    vUV = vec2(aUV.x, uFlipV > 0.5 ? 1.0 - aUV.y : aUV.y);
  }
`;

const FRAGMENT_SHADER = `
  #version 330 core
  in vec2 vUV;
  out vec4 FragColor;

  uniform sampler2D uTexture;
  uniform vec2 uSize;           // Overlay size in pixels
  uniform vec4 uBgColor;        // Background color RGBA
  uniform vec4 uBorderColor;    // Border color RGBA
  uniform float uCornerRadius;  // Corner radius in pixels
  uniform float uBorderWidth;   // Border width in pixels

  // Rounded box SDF - returns negative inside, positive outside
  float roundedBoxSDF(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + r;
    return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
  }

  void main() {
    // Calculate pixel position from UV
    vec2 pixelPos = vUV * uSize;
    vec2 center = uSize * 0.5;
    vec2 halfSize = center;

    // Position relative to center for SDF
    vec2 posFromCenter = pixelPos - center;

    // Rounded rectangle SDF
    float boxDist = roundedBoxSDF(posFromCenter, halfSize - 1.0, uCornerRadius);

    // Background mask - 1.0 inside, 0.0 outside with antialiased edge
    float boxMask = 1.0 - smoothstep(-1.0, 1.0, boxDist);

    // Border mask - 1.0 on border, 0.0 elsewhere
    float borderDist = abs(boxDist) - uBorderWidth * 0.5;
    float borderMask = 1.0 - smoothstep(-1.0, 1.0, borderDist);

    // Start with background color
    vec3 color = uBgColor.rgb;
    float alpha = uBgColor.a * boxMask;

    // Apply border on top
    color = mix(color, uBorderColor.rgb, borderMask * boxMask);

    // Sample text texture and composite on top
    vec4 texColor = texture(uTexture, vUV);
    color = mix(color, texColor.rgb, texColor.a);
    alpha = max(alpha * boxMask, texColor.a * boxMask);

    // Discard fully transparent pixels
    if (alpha < 0.01) {
      discard;
    }

    FragColor = vec4(color, alpha);
  }
`;

export interface OverlayPosition {
  x: number;
  y: number;
}

export class QuestStepOverlay {
  private overlayHandle: patchrs.GlOverlay | null = null;
  private texture: patchrs.TrackedTexture | null = null;
  private program: patchrs.GlProgram | null = null;
  private vertexArray: patchrs.VertexArraySnapshot | null = null;

  private position: OverlayPosition;
  private size: { width: number; height: number } = { width: 350, height: 100 };
  private uiSize: { width: number; height: number } | null = null;

  private currentStepIndex: number = -1;
  private totalSteps: number = 0;
  private currentDescription: string = "";
  private currentDialogOptions: string[] | undefined = undefined;
  private currentAdditionalInfo: string[] | undefined = undefined;
  private completedDialogCount: number = 0;
  private currentRequiredItems: string[] | undefined = undefined;
  private currentRecommendedItems: string[] | undefined = undefined;
  private fontSize: number = 14;

  private isVisible: boolean = false;
  private unsubscribeResolution: (() => void) | null = null;
  private isUpdating: boolean = false; // Mutex to prevent concurrent updates
  private pendingUpdate: boolean = false; // Flag to track if an update is pending
  private teleportCallbackId: string | null = null; // Teleport suppression subscription
  private hiddenForTeleport: boolean = false; // Track if hidden due to teleport

  constructor() {
    // Load saved position or use default
    this.position = this.loadPosition();

    // Subscribe to resolution changes from UIScaleManager
    this.unsubscribeResolution = onResolutionChange((info: UIScaleInfo) => {
      this.handleResolutionChange(info);
    });

    // Subscribe to teleport events to hide overlay during teleport transitions
    // This prevents the overlay from appearing huge/distorted when matrices are invalid
    this.teleportCallbackId = onTeleportStateChange((isTeleporting) => {
      if (isTeleporting) {
        // Hide overlay during teleport
        if (this.isVisible && this.overlayHandle) {
          this.hiddenForTeleport = true;
          this.stopOverlay();
        }
      } else {
        // Restore overlay after teleport
        if (this.hiddenForTeleport && this.isVisible) {
          this.hiddenForTeleport = false;
          this.updateOverlay();
        }
      }
    }, "questStepOverlay");
  }

  /**
   * Handle resolution changes from UIScaleManager
   */
  private handleResolutionChange(info: UIScaleInfo): void {
    // Use UI dimensions (not screen dimensions) for our coordinate space
    const newWidth = info.uiWidth;
    const newHeight = info.uiHeight;

    // Ignore invalid/minimized window dimensions
    // When minimized, dimensions can become very small or 0
    const MIN_VALID_SIZE = 640;
    if (newWidth < MIN_VALID_SIZE || newHeight < MIN_VALID_SIZE) {
      return;
    }

    const oldWidth = this.uiSize?.width ?? 0;
    const oldHeight = this.uiSize?.height ?? 0;

    // Invalidate cached UI framebuffer info on resolution change
    this.uiFramebufferInfo = null;

    if (newWidth !== oldWidth || newHeight !== oldHeight) {
      this.uiSize = { width: newWidth, height: newHeight };

      // Load position saved for this specific resolution
      const savedPosition = this.loadPositionForResolution(newWidth, newHeight);

      // Clamp the saved position to ensure it's on-screen
      const maxX = Math.max(0, newWidth - this.size.width);
      const maxY = Math.max(0, newHeight - this.size.height);
      this.position = {
        x: Math.max(0, Math.min(savedPosition.x, maxX)),
        y: Math.max(0, Math.min(savedPosition.y, maxY)),
      };

      // Recreate overlay with new dimensions
      if (this.isVisible) {
        this.updateOverlay();
      }
    }
  }

  /**
   * Get storage key for current resolution
   */
  private getPositionStorageKey(): string {
    const width = this.uiSize?.width ?? 1920;
    const height = this.uiSize?.height ?? 1080;
    return `${POSITION_STORAGE_KEY_PREFIX}${width}x${height}`;
  }

  /**
   * Load position from localStorage for current resolution
   * Falls back to legacy key for migration, then default
   */
  private loadPosition(): OverlayPosition {
    try {
      // Try resolution-specific key first
      const resKey = this.getPositionStorageKey();
      const saved = localStorage.getItem(resKey);
      if (saved) {
        const pos = JSON.parse(saved);
        if (typeof pos.x === "number" && typeof pos.y === "number") {
          return pos;
        }
      }

      // Fall back to legacy key for migration
      const legacy = localStorage.getItem(LEGACY_POSITION_KEY);
      if (legacy) {
        const pos = JSON.parse(legacy);
        if (typeof pos.x === "number" && typeof pos.y === "number") {
          return pos;
        }
      }
    } catch {
      // Ignore
    }
    // Default: top-left area
    return { x: 50, y: 50 };
  }

  /**
   * Load position for a specific resolution
   */
  private loadPositionForResolution(width: number, height: number): OverlayPosition {
    try {
      const resKey = `${POSITION_STORAGE_KEY_PREFIX}${width}x${height}`;
      const saved = localStorage.getItem(resKey);
      if (saved) {
        const pos = JSON.parse(saved);
        if (typeof pos.x === "number" && typeof pos.y === "number") {
          return pos;
        }
      }
    } catch {
      // Ignore
    }
    // Default: top-left area
    return { x: 50, y: 50 };
  }

  /**
   * Save position to localStorage for current resolution
   */
  private savePosition(): void {
    try {
      const resKey = this.getPositionStorageKey();
      localStorage.setItem(resKey, JSON.stringify(this.position));
    } catch {
      // Ignore
    }
  }

  /**
   * Set overlay position (saves to localStorage)
   * Uses live update if overlay exists for smooth repositioning
   */
  setPosition(x: number, y: number): void {
    // Use live update for smooth repositioning if overlay exists
    if (this.overlayHandle && this.isVisible) {
      this.updatePositionLive(x, y);
      this.savePosition();
    } else {
      this.position = { x, y };
      this.savePosition();
      if (this.isVisible) {
        this.updateOverlay();
      }
    }
  }

  /**
   * Update position smoothly without recreating texture (for live dragging)
   * This updates the uniform buffer directly for better performance
   */
  updatePositionLive(x: number, y: number): void {
    // Clamp position to UI bounds
    const maxX = (this.uiSize?.width ?? 1920) - this.size.width;
    const maxY = (this.uiSize?.height ?? 1080) - this.size.height;
    this.position = {
      x: Math.max(0, Math.min(x, maxX)),
      y: Math.max(0, Math.min(y, maxY)),
    };

    // If overlay handle exists, update uniforms directly
    if (this.overlayHandle && this.isVisible) {
      try {
        const uniformState = this.overlayHandle.getUniformState();
        const view = new DataView(uniformState.buffer, uniformState.byteOffset, uniformState.byteLength);

        // Get current scale info to determine rendering mode
        const scaleInfo = getUIScaleInfo();

        if (scaleInfo.isScaled && this.uiFramebufferInfo) {
          // 4K UI framebuffer mode: use UI coordinates with Y flip
          const glPositionY = this.uiFramebufferInfo.height - this.position.y - this.size.height;
          // uPosition is at offset 8 (after uScreenSize which is 2 floats = 8 bytes)
          view.setFloat32(8, this.position.x, true);
          view.setFloat32(12, glPositionY, true);
        } else {
          // 1080p/freespace mode: use screen coordinates with scaling if needed
          const scaleX = scaleInfo.isScaled ? scaleInfo.screenWidth / scaleInfo.uiWidth : 1;
          const scaleY = scaleInfo.isScaled ? scaleInfo.screenHeight / scaleInfo.uiHeight : 1;
          view.setFloat32(8, this.position.x * scaleX, true);
          view.setFloat32(12, this.position.y * scaleY, true);
        }

        this.overlayHandle.setUniformState(uniformState);
      } catch (e) {
        // Fallback: recreate overlay
        console.warn("[QuestStepOverlay] Live position update failed, recreating overlay:", e);
        this.updateOverlay();
      }
    }
  }

  /**
   * Commit position after dragging (saves to localStorage)
   */
  commitPosition(): void {
    this.savePosition();
  }

  /**
   * Get current position
   */
  getPosition(): OverlayPosition {
    return { ...this.position };
  }

  /**
   * Get overlay size
   */
  getSize(): { width: number; height: number } {
    return { ...this.size };
  }

  /**
   * Get UI bounds for position clamping
   */
  getUIBounds(): { width: number; height: number } {
    return this.uiSize ? { ...this.uiSize } : { width: 1920, height: 1080 };
  }

  /**
   * Update screen size (call when resolution changes)
   * Invalidates cached framebuffer info since resolution changed
   */
  setScreenSize(width: number, height: number): void {
    // Ignore invalid/minimized window dimensions
    const MIN_VALID_SIZE = 100;
    if (width < MIN_VALID_SIZE || height < MIN_VALID_SIZE) {
      return;
    }

    const oldWidth = this.uiSize?.width ?? 0;
    const oldHeight = this.uiSize?.height ?? 0;
    const resolutionChanged = width !== oldWidth || height !== oldHeight;

    this.uiSize = { width, height };

    // Only clamp position if it would be off-screen with new dimensions
    const maxX = Math.max(0, width - this.size.width);
    const maxY = Math.max(0, height - this.size.height);
    if (this.position.x > maxX || this.position.y > maxY) {
      this.position.x = Math.max(0, Math.min(this.position.x, maxX));
      this.position.y = Math.max(0, Math.min(this.position.y, maxY));
    }

    if (resolutionChanged && this.isVisible) {
      this.updateOverlay();
    }
  }

  /**
   * Update the displayed step
   */
  async showStep(
    stepIndex: number,
    totalSteps: number,
    description: string,
    dialogOptions?: string[],
    additionalInfo?: string[],
    requiredItems?: string[],
    recommendedItems?: string[]
  ): Promise<void> {
    // Validate step index - don't show for invalid steps
    if (stepIndex < 0) {
      await this.hide();
      return;
    }

    // Reset dialog completion count when step changes
    if (stepIndex !== this.currentStepIndex) {
      this.completedDialogCount = 0;
    }

    this.currentStepIndex = stepIndex;
    this.totalSteps = totalSteps;
    this.currentDescription = description;
    this.currentDialogOptions = dialogOptions;
    this.currentAdditionalInfo = additionalInfo;
    this.currentRequiredItems = requiredItems;
    this.currentRecommendedItems = recommendedItems;
    this.isVisible = true;

    await this.updateOverlay();
  }

  /**
   * Set font size (14-22pt)
   */
  setFontSize(size: number): void {
    const clamped = Math.max(14, Math.min(22, size));
    if (this.fontSize !== clamped) {
      this.fontSize = clamped;
      if (this.isVisible) {
        this.updateOverlay();
      }
    }
  }

  /**
   * Hide the overlay
   */
  async hide(): Promise<void> {
    this.isVisible = false;
    await this.stopOverlay();
    this.currentDescription = "";
    this.currentDialogOptions = undefined;
    this.currentAdditionalInfo = undefined;
    this.currentRequiredItems = undefined;
    this.currentRecommendedItems = undefined;
    this.currentStepIndex = -1;
    this.completedDialogCount = 0;
  }

  /**
   * Mark the next dialog option as completed
   * Dialog options are completed in order
   */
  async markDialogCompleted(): Promise<void> {
    if (!this.currentDialogOptions) {
      return;
    }

    if (this.completedDialogCount >= this.currentDialogOptions.length) {
      return;
    }

    this.completedDialogCount++;

    // Recreate overlay to show updated completion state
    if (this.isVisible) {
      await this.updateOverlay();
    }
  }

  /**
   * Get the number of completed dialogs
   */
  getCompletedDialogCount(): number {
    return this.completedDialogCount;
  }

  /**
   * Get total number of dialog options for current step
   */
  getTotalDialogCount(): number {
    return this.currentDialogOptions?.length ?? 0;
  }

  /** Cached UI framebuffer info for 4K rendering */
  private uiFramebufferInfo: { framebufferId: number; width: number; height: number; cachedAt: number } | null = null;

  /**
   * Find the UI framebuffer for 4K rendering
   * At 4K, the UI renders to a separate framebuffer which is then scaled by Lanczos
   */
  private async findUIFramebuffer(): Promise<{ framebufferId: number; width: number; height: number } | null> {
    // Check cache with 5-second TTL
    if (this.uiFramebufferInfo && (Date.now() - this.uiFramebufferInfo.cachedAt) < 5000) {
      return this.uiFramebufferInfo;
    }
    // Invalidate stale cache
    this.uiFramebufferInfo = null;

    if (!patchrs.native) return null;

    try {
      // Record from screen (fb 0) to find the Lanczos scaler
      let screenRenders: any[] = [];
      let uiRenders: any[] = [];

      try {
        screenRenders = await patchrs.native.recordRenderCalls({
          maxframes: 1,
          features: ["texturesnapshot"],
          framebufferId: 0,
        });

        // Find the Lanczos scaler and get its source texture
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
          // Record from the UI framebuffer (the one with the scaling texture)
          uiRenders = await patchrs.native.recordRenderCalls({
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
              cachedAt: Date.now(),
            };
            return this.uiFramebufferInfo;
          }
        }

        return null;
      } finally {
        for (const r of screenRenders) {
          try { r.dispose?.(); } catch (_) {}
        }
        for (const r of uiRenders) {
          try { r.dispose?.(); } catch (_) {}
        }
      }
    } catch (e) {
      console.warn("[QuestStepOverlay] Error finding UI framebuffer:", e);
      return null;
    }
  }

  /**
   * Update the overlay with current step data
   * Always uses frameend to render in screen space ("freespace" over the 3D world)
   * At 4K: scales UI coordinates to screen coordinates
   */
  private async updateOverlay(): Promise<void> {
    if (!this.currentDescription || !patchrs.native) {
      return;
    }

    // Prevent concurrent updates - if already updating, mark as pending
    if (this.isUpdating) {
      this.pendingUpdate = true;
      return;
    }

    this.isUpdating = true;
    this.pendingUpdate = false;

    try {
      // Stop existing overlay
      await this.stopOverlay();

    // Get dimensions from UIScaleManager (centralized and reliable)
    const scaleInfo = getUIScaleInfo();
    const isScaled = scaleInfo.isScaled;
    const screenWidth = scaleInfo.screenWidth;
    const screenHeight = scaleInfo.screenHeight;
    const uiWidth = scaleInfo.uiWidth;
    const uiHeight = scaleInfo.uiHeight;

    // Store UI size for position clamping
    this.uiSize = { width: uiWidth, height: uiHeight };

    // Render text to texture
    const renderResult = renderQuestStep(
      this.currentStepIndex,
      this.totalSteps,
      this.currentDescription,
      this.currentDialogOptions,
      this.currentAdditionalInfo,
      this.completedDialogCount,
      { fontSize: this.fontSize },
      this.currentRequiredItems,
      this.currentRecommendedItems
    );

    const oldHeight = this.size.height;
    this.size = { width: renderResult.width, height: renderResult.height };

    // Expand UPWARD: Keep bottom edge anchored when content height changes
    // Calculate current bottom position, then derive new top position
    const bottomY = this.position.y + oldHeight;
    let newTopY = bottomY - this.size.height;

    // Clamp to screen bounds (can't go above screen or below)
    const minY = 0;
    const maxY = Math.max(0, uiHeight - this.size.height);
    newTopY = Math.max(minY, Math.min(newTopY, maxY));

    if (newTopY !== this.position.y) {
      this.position.y = newTopY;
    }

    // Create texture from rendered text
    this.texture = patchrs.native.createTexture(renderResult.imageData);

    // Create uniform snapshot using the builder
    const uniforms = new UniformSnapshotBuilder({
      uScreenSize: "vec2",
      uPosition: "vec2",
      uSize: "vec2",
      uTexture: "sampler2d",
      uFlipY: "float",
      uFlipV: "float",
      uBgColor: "vec4",
      uBorderColor: "vec4",
      uCornerRadius: "float",
      uBorderWidth: "float",
      uViewport: "vec4",
    });

    // Always render to frameend (screen space) for "freespace" overlay
    // At 4K: scale position/size from UI coords to screen coords
    // At 1080p: no scaling needed (UI coords == screen coords)
    const renderWidth = screenWidth;
    const renderHeight = screenHeight;
    let finalPosX: number;
    let finalPosY: number;
    let finalWidth: number;
    let finalHeight: number;

    if (isScaled) {
      // 4K mode: scale from UI coordinates to screen coordinates
      const scaleX = screenWidth / uiWidth;
      const scaleY = screenHeight / uiHeight;
      finalPosX = this.position.x * scaleX;
      finalPosY = this.position.y * scaleY;
      finalWidth = renderResult.width * scaleX;
      finalHeight = renderResult.height * scaleY;
    } else {
      // 1080p mode: no scaling needed
      finalPosX = this.position.x;
      finalPosY = this.position.y;
      finalWidth = renderResult.width;
      finalHeight = renderResult.height;
    }

    // Always use frameend: Y-flip in NDC, no V flip
    const flipY = 1.0;
    const flipV = 0.0;

    // Write uniform values
    uniforms.mappings.uScreenSize.write([renderWidth, renderHeight]);
    uniforms.mappings.uPosition.write([finalPosX, finalPosY]);
    uniforms.mappings.uSize.write([finalWidth, finalHeight]);
    uniforms.mappings.uTexture.write([0]); // Sampler unit 0
    uniforms.mappings.uFlipY.write([flipY]);
    uniforms.mappings.uFlipV.write([flipV]);
    // SDF background/border uniforms (matching TextRenderer colors)
    uniforms.mappings.uBgColor.write([40/255, 45/255, 55/255, 0.95]); // rgba(40, 45, 55, 0.95)
    uniforms.mappings.uBorderColor.write([136/255, 204/255, 255/255, 1.0]); // #88ccff
    uniforms.mappings.uCornerRadius.write([8.0]);
    uniforms.mappings.uBorderWidth.write([2.0]);
    // Initialize viewport with baked values (overridden each frame by uniformSources builtin)
    uniforms.mappings.uViewport.write([0, 0, renderWidth, renderHeight]);

    // Viewport builtin: dynamically updates uViewport each frame with the live GL viewport
    // This prevents oversized rendering when the viewport changes during teleport/transitions
    const viewportSource = { name: "uViewport", sourceName: "viewport", type: "builtin" as const };

    // Create shader program
    this.program = patchrs.native.createProgram(
      VERTEX_SHADER,
      FRAGMENT_SHADER,
      [
        { location: 0, name: "aPos", type: GL_FLOAT, length: 2 },
        { location: 1, name: "aUV", type: GL_FLOAT, length: 2 },
      ],
      uniforms.args
    );

    // Create vertex array (simple quad)
    this.vertexArray = this.createVertexArray();

    // Render overlay - different approaches for 4K vs 1080p
    // At 4K: render to UI framebuffer so it gets scaled by Lanczos (stuck to UI but visible)
    // At 1080p: use frameend to render in screen space
    try {
      if (isScaled) {
        // 4K mode: Find UI framebuffer and render there
        // This makes the overlay "stuck to UI" but ensures it's visible
        const uiFb = await this.findUIFramebuffer();

        if (uiFb) {
          // At 4K, render to UI framebuffer in UI coordinates (no scaling needed)
          // IMPORTANT: The saved position uses screen coords (Y=0 at top, Y increases down)
          const glPositionY = uiFb.height - this.position.y - renderResult.height;

          uniforms.mappings.uScreenSize.write([uiFb.width, uiFb.height]);
          uniforms.mappings.uPosition.write([this.position.x, glPositionY]);
          uniforms.mappings.uSize.write([renderResult.width, renderResult.height]);
          // For UI framebuffer: no Y flip in NDC (already flipped position), but DO flip V
          // because vertex Y=0 is at bottom of quad but texture Y=0 is at top of image
          uniforms.mappings.uFlipY.write([0.0]);
          uniforms.mappings.uFlipV.write([1.0]);

          this.overlayHandle = patchrs.native.beginOverlay(
            { },
            this.program,
            this.vertexArray,
            {
              uniformBuffer: uniforms.buffer,
              samplers: { "0": this.texture },
              renderMode: "triangles",
              trigger: "frameend",
              uniformSources: [viewportSource],
              alphaBlend: true,
            }
          );
        } else {
          // UI framebuffer not found — fall through to frameend (same as 1080p)
          this.overlayHandle = patchrs.native.beginOverlay(
            {},
            this.program,
            this.vertexArray,
            {
              uniformBuffer: uniforms.buffer,
              samplers: { "0": this.texture },
              renderMode: "triangles",
              trigger: "frameend",
              uniformSources: [viewportSource],
              alphaBlend: true,
            }
          );
        }
      } else {
        // 1080p mode: use frameend with empty filter
        this.overlayHandle = patchrs.native.beginOverlay(
          {},
          this.program,
          this.vertexArray,
          {
            uniformBuffer: uniforms.buffer,
            samplers: { "0": this.texture },
            renderMode: "triangles",
            trigger: "frameend",
            uniformSources: [viewportSource],
            alphaBlend: true,
          }
        );
      }
    } catch (e) {
      console.error("[QuestStepOverlay] Failed to create overlay:", e);
    }
    } catch (outerError) {
      console.error("[QuestStepOverlay] Error in updateOverlay:", outerError);
    } finally {
      this.isUpdating = false;
      // If an update was requested while we were updating, do it now
      if (this.pendingUpdate) {
        this.pendingUpdate = false;
        this.updateOverlay();
      }
    }
  }

  /**
   * Create vertex array (unit quad)
   */
  private createVertexArray(): patchrs.VertexArraySnapshot {
    // Quad vertices: position (0-1) and UV (0-1)
    const vertices = new Float32Array([
      // Position   UV
      0, 0,        0, 0,  // Screen top-left, Texture top-left
      1, 0,        1, 0,  // Screen top-right, Texture top-right
      1, 1,        1, 1,  // Screen bottom-right, Texture bottom-right
      0, 1,        0, 1,  // Screen bottom-left, Texture bottom-left
    ]);

    // CCW winding after Y-flip
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
   * Stop the overlay
   */
  private async stopOverlay(): Promise<void> {
    if (this.overlayHandle) {
      try {
        this.overlayHandle.stop();
      } catch (e) {
        console.error("[QuestStepOverlay] Error stopping overlay:", e);
      }
      this.overlayHandle = null;
    }
  }

  /**
   * Check if overlay is currently visible
   */
  isShowing(): boolean {
    return this.isVisible;
  }

  /**
   * Cleanup all resources
   */
  async dispose(): Promise<void> {
    // Unsubscribe from resolution changes
    if (this.unsubscribeResolution) {
      this.unsubscribeResolution();
      this.unsubscribeResolution = null;
    }

    // Unsubscribe from teleport events
    if (this.teleportCallbackId) {
      offTeleportStateChange(this.teleportCallbackId);
      this.teleportCallbackId = null;
    }

    await this.stopOverlay();
    this.texture = null;
    this.program = null;
    this.vertexArray = null;
  }
}
