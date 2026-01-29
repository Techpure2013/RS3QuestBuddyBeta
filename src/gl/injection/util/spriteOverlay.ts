/**
 * Sprite Overlay - Renders overlays directly on UI sprites
 * Takes sprite position/size from the UI render data
 * Supports UI scaling for high-DPI monitors
 */

import * as patchrs from "./patchrs_napi";
import { RenderRect } from "../reflect2d/reflect2d";
import { getProgramMeta } from "../render/renderprogram";

// Import UI scale state - will be updated by UIScaleManager
// When UI scaling is active (4K), the UI is rendered at a lower resolution
// (e.g., 1920x1080) and then scaled up by the Lanczos scaler to screen resolution.
// SpriteOverlay attaches to the UI program, so it renders in UI space, NOT screen space.
let uiScaleState: {
  scaleX: number;
  scaleY: number;
  isScaled: boolean;
  uiWidth: number;
  uiHeight: number;
  scalingTextureId: number;
} | null = null;

/**
 * Set the UI scale state from an external source (e.g., UIScaleManager)
 */
export function setUIScaleState(state: {
  scaleX: number;
  scaleY: number;
  isScaled: boolean;
  uiWidth?: number;
  uiHeight?: number;
  scalingTextureId?: number;
}) {
  uiScaleState = {
    scaleX: state.scaleX,
    scaleY: state.scaleY,
    isScaled: state.isScaled,
    uiWidth: state.uiWidth ?? 1920,
    uiHeight: state.uiHeight ?? 1080,
    scalingTextureId: state.scalingTextureId ?? 0,
  };
  console.log(`[SpriteOverlay] Scale state updated: isScaled=${state.isScaled}, uiSize=${uiScaleState.uiWidth}x${uiScaleState.uiHeight}, scalingTex=${uiScaleState.scalingTextureId}`);
}


// OpenGL constants
const GL_FLOAT = 0x1406;
const GL_UNSIGNED_BYTE = 0x1401;
// GL_TRIANGLES constant removed - renderMode now uses string "triangles"
const GL_FLOAT_VEC2 = 0x8b50;

// Vertex shader for screen-space rendering
// Uses same coordinate system as game UI (Y=0 at bottom)
const vertShader = `
  #version 330 core
  layout (location = 0) in vec2 aPos;
  layout (location = 6) in vec4 aColor;

  uniform vec2 uScreenSize;

  out vec4 vColor;

  void main() {
    // Convert to NDC: map [0, screenSize] to [-1, 1]
    vec2 ndc = (aPos / uScreenSize) * 2.0 - 1.0;
    gl_Position = vec4(ndc, 0.0, 1.0);
    vColor = aColor;
  }
`;

const fragShader = `
  #version 330 core
  in vec4 vColor;
  out vec4 FragColor;
  void main() {
    FragColor = vColor;
  }
`;

/** RGBA color with values 0-255 */
export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface SpriteOverlayOptions {
  /** Color as RGBA object or [r,g,b,a] array (0-255 each) */
  color?: RGBA | [number, number, number, number];
  /** Thickness for outline mode (default: 3) */
  thickness?: number;
  /** Fill mode: 'outline' draws border only, 'fill' draws solid rectangle */
  mode?: "outline" | "fill";
}

/** Convert RGBA object or array to tuple */
function toColorTuple(color: RGBA | [number, number, number, number]): [number, number, number, number] {
  if (Array.isArray(color)) {
    return color;
  }
  return [color.r, color.g, color.b, color.a];
}

/**
 * Generate rectangle geometry
 */
function generateRectGeometry(
  x: number,
  y: number,
  width: number,
  height: number,
  color: [number, number, number, number]
): { pos: Float32Array; colors: Uint8Array; indices: Uint16Array } {
  const pos = new Float32Array([
    x, y,
    x + width, y,
    x + width, y + height,
    x, y + height,
  ]);
  const colors = new Uint8Array([
    ...color, ...color, ...color, ...color,
  ]);
  const indices = new Uint16Array([0, 1, 2, 0, 2, 3]);

  return { pos, colors, indices };
}

/**
 * Generate outline geometry (4 rectangles forming a border)
 */
function generateOutlineGeometry(
  x: number,
  y: number,
  width: number,
  height: number,
  thickness: number,
  color: [number, number, number, number]
): { pos: Float32Array; colors: Uint8Array; indices: Uint16Array } {
  const rects = [
    // Top edge
    { x, y: y + height - thickness, w: width, h: thickness },
    // Bottom edge
    { x, y, w: width, h: thickness },
    // Left edge
    { x, y: y + thickness, w: thickness, h: height - thickness * 2 },
    // Right edge
    { x: x + width - thickness, y: y + thickness, w: thickness, h: height - thickness * 2 },
  ];

  const posArray: number[] = [];
  const colorArray: number[] = [];
  const indexArray: number[] = [];

  let vertexOffset = 0;
  for (const rect of rects) {
    // Add 4 vertices for this rectangle
    posArray.push(
      rect.x, rect.y,
      rect.x + rect.w, rect.y,
      rect.x + rect.w, rect.y + rect.h,
      rect.x, rect.y + rect.h
    );
    // Add colors for 4 vertices
    for (let i = 0; i < 4; i++) {
      colorArray.push(...color);
    }
    // Add indices for 2 triangles
    indexArray.push(
      vertexOffset, vertexOffset + 1, vertexOffset + 2,
      vertexOffset, vertexOffset + 2, vertexOffset + 3
    );
    vertexOffset += 4;
  }

  return {
    pos: Float32Array.from(posArray),
    colors: Uint8Array.from(colorArray),
    indices: Uint16Array.from(indexArray),
  };
}

/** Cached UI framebuffer info */
interface UIFramebufferInfo {
  framebufferId: number;
  width: number;
  height: number;
}

/**
 * SpriteOverlay class - renders overlays on UI sprites
 * Renders to the same framebuffer as the UI for proper 4K support
 */
export class SpriteOverlay {
  private overlayHandles: patchrs.GlOverlay[] = [];
  private screenWidth: number = 1920;
  private screenHeight: number = 1080;
  private uiFramebufferInfo: UIFramebufferInfo | null = null;

  constructor() {
    this.updateScreenSize();
  }

  /**
   * Update cached screen dimensions from viewport data
   * Gets actual rendering viewport dimensions, which works correctly at any resolution
   */
  async updateScreenSizeFromViewport(): Promise<void> {
    try {
      const frames = await patchrs.native.recordRenderCalls({ maxframes: 1, features: [] });
      const view = frames.find(f => f.viewport)?.viewport;
      if (view) {
        this.screenWidth = view.width;
        this.screenHeight = view.height;
        console.log(`[SpriteOverlay] Viewport detected: ${view.width}x${view.height}`);
      } else {
        // Fallback to getRsWidth/getRsHeight
        this.screenWidth = patchrs.native.getRsWidth() || 1920;
        this.screenHeight = patchrs.native.getRsHeight() || 1080;
        console.log(`[SpriteOverlay] Using fallback screen size: ${this.screenWidth}x${this.screenHeight}`);
      }
    } catch (e) {
      // Fallback on error
      this.screenWidth = patchrs.native.getRsWidth() || 1920;
      this.screenHeight = patchrs.native.getRsHeight() || 1080;
      console.warn(`[SpriteOverlay] Viewport detection failed, using fallback: ${this.screenWidth}x${this.screenHeight}`);
    }
  }

  /**
   * Update cached screen dimensions (sync version, uses getRs* API)
   */
  updateScreenSize(): void {
    this.screenWidth = patchrs.native.getRsWidth() || 1920;
    this.screenHeight = patchrs.native.getRsHeight() || 1080;
  }

  /**
   * Invalidate cached state (call when resolution changes)
   * Also stops all overlays since they target the old framebuffer
   */
  invalidateCache(): void {
    this.updateScreenSize();
    this.uiFramebufferInfo = null;
    // Stop all overlays since they target the old framebuffer configuration
    // This prevents stacking when moving between screens
    this.stopAll();
    console.log(`[SpriteOverlay] Cache invalidated, all overlays stopped, screen: ${this.screenWidth}x${this.screenHeight}`);
  }

  /**
   * Find the UI framebuffer from render data
   * The UI is rendered to a specific framebuffer, which may differ from the screen at 4K
   *
   * At 4K: We actively scan for the Lanczos scaler program, get the texture it reads from,
   * then find which framebuffer that texture is attached to.
   */
  private async findUIFramebuffer(): Promise<UIFramebufferInfo | null> {
    try {
      // Step 1: Record from screen (fb 0) to find the Lanczos scaler
      // Need texturesnapshot to populate samplers with TextureSnapshot objects
      const screenRenders = await patchrs.native.recordRenderCalls({
        maxframes: 1,
        features: ["texturesnapshot"],
        framebufferId: 0,
      });

      console.log(`[SpriteOverlay] findUIFramebuffer: Got ${screenRenders.length} renders from fb 0`);

      // Step 2: Find the Lanczos scaler program and get its source texture
      let scalingTextureId = 0;
      let scalerCount = 0;
      let uiCount = 0;
      for (const render of screenRenders) {
        if (!render.program) continue;
        const progMeta = getProgramMeta(render.program);

        if (progMeta.isUiScaler) {
          scalerCount++;
          // Get the texture the scaler reads from
          // Try samplers first (texturesnapshot), then textures as fallback
          const textureData = render.samplers || render.textures || {};
          const sampler = Object.values(textureData)[0] as patchrs.TextureSnapshot | patchrs.TrackedTexture | undefined;
          if (sampler) {
            scalingTextureId = sampler.texid;
            console.log(`[SpriteOverlay] Found Lanczos scaler reading from texture ${scalingTextureId} (${sampler.width}x${sampler.height})`);
            break;
          } else {
            console.log(`[SpriteOverlay] UiScaler found but no texture data in samplers or textures`);
          }
        }
        if (progMeta.isUi) uiCount++;
      }

      if (scalerCount === 0) {
        console.log(`[SpriteOverlay] No UiScaler found in fb 0 renders (found ${uiCount} UI programs)`);
      }

      // Step 3: If we found a scaling texture, record from its framebuffer
      if (scalingTextureId > 0) {
        const uiRenders = await patchrs.native.recordRenderCalls({
          maxframes: 1,
          features: [],
          framebufferTexture: scalingTextureId,
        });

        // Get the framebuffer ID from one of the UI renders
        const uiRender = uiRenders.find(r => r.viewport);
        if (uiRender && uiRender.viewport) {
          const info: UIFramebufferInfo = {
            framebufferId: uiRender.framebufferId,
            width: uiRender.viewport.width,
            height: uiRender.viewport.height,
          };
          console.log(`[SpriteOverlay] Found UI framebuffer: fb=${info.framebufferId}, size=${info.width}x${info.height}`);
          return info;
        }

        // If no viewport in renders, use the texture dimensions
        console.log(`[SpriteOverlay] No viewport in UI renders, using texture dimensions`);
        // We need to find the framebuffer ID - check the first render
        const firstRender = uiRenders[0];
        if (firstRender) {
          return {
            framebufferId: firstRender.framebufferId,
            width: uiScaleState?.uiWidth ?? 1920,
            height: uiScaleState?.uiHeight ?? 1010,
          };
        }
      }

      // Non-scaled mode or fallback: check for UI program in screen renders
      for (const render of screenRenders) {
        if (!render.program) continue;
        const progMeta = getProgramMeta(render.program);

        if (progMeta.isUi && render.viewport) {
          const info: UIFramebufferInfo = {
            framebufferId: render.framebufferId,
            width: render.viewport.width,
            height: render.viewport.height,
          };
          console.log(`[SpriteOverlay] Found UI framebuffer (non-scaled): fb=${info.framebufferId}, size=${info.width}x${info.height}`);
          return info;
        }
      }

      // Final fallback: use framebuffer 0 with viewport dimensions
      const viewport = screenRenders.find(r => r.viewport)?.viewport;
      if (viewport) {
        console.log(`[SpriteOverlay] Fallback: using fb 0 with viewport ${viewport.width}x${viewport.height}`);
        return {
          framebufferId: 0,
          width: viewport.width,
          height: viewport.height,
        };
      }

      return null;
    } catch (e) {
      console.warn("[SpriteOverlay] Failed to find UI framebuffer:", e);
      return null;
    }
  }

  /**
   * Create shader program
   */
  private createProgram() {
    return patchrs.native.createProgram(
      vertShader,
      fragShader,
      [
        { location: 0, name: "aPos", type: GL_FLOAT, length: 2 },
        { location: 6, name: "aColor", type: GL_UNSIGNED_BYTE, length: 4 },
      ],
      [
        { name: "uScreenSize", length: 1, type: GL_FLOAT_VEC2, snapshotOffset: 0, snapshotSize: 8 },
      ]
    );
  }

  /**
   * Render a rectangle overlay on a UI sprite element
   * @param element - The RenderRect element from UI state
   * @param options - Overlay options (color, thickness, mode)
   */
  async renderRect(element: RenderRect, options: SpriteOverlayOptions = {}): Promise<patchrs.GlOverlay | null> {
    const {
      color = [255, 255, 0, 200],
      thickness = 3,
      mode = "outline",
    } = options;

    return this.renderRectAt(element.x, element.y, element.width, element.height, { color, thickness, mode });
  }

  /**
   * Render a rectangle overlay at specific coordinates
   * @param x - X position (in UI coordinate space)
   * @param y - Y position (in UI coordinate space)
   * @param width - Width (in UI coordinate space)
   * @param height - Height (in UI coordinate space)
   * @param options - Overlay options
   */
  async renderRectAt(
    x: number,
    y: number,
    width: number,
    height: number,
    options: SpriteOverlayOptions = {}
  ): Promise<patchrs.GlOverlay | null> {
    const {
      color = [255, 255, 0, 200],
      thickness = 3,
      mode = "outline",
    } = options;

    const colorTuple = toColorTuple(color);

    // Find the UI framebuffer - this is where the button is rendered
    // At 4K, UI renders to a separate framebuffer (e.g., fb 18) at lower resolution,
    // then Lanczos scaler upscales to screen (fb 0)
    // Use cached info if available to prevent framebuffer ID changes mid-frame
    let uiFb = this.uiFramebufferInfo;
    if (!uiFb) {
      uiFb = await this.findUIFramebuffer();
      // Cache the UI framebuffer info for future use
      if (uiFb) {
        this.uiFramebufferInfo = uiFb;
      }
    }

    // Use UI framebuffer dimensions, fallback to cached or default
    const fbWidth = uiFb?.width ?? this.screenWidth;
    const fbHeight = uiFb?.height ?? this.screenHeight;
    const framebufferId = uiFb?.framebufferId ?? 0;

    // NOTE: Coordinates should be in UI space (not screen-scaled)
    // When rendering to the UI framebuffer, we use the same coordinate system as the UI

    // Generate geometry - use coordinates as-is since they're in UI space
    const geo = mode === "outline"
      ? generateOutlineGeometry(x, y, width, height, thickness, colorTuple)
      : generateRectGeometry(x, y, width, height, colorTuple);

    const vertex = patchrs.native.createVertexArray(
      new Uint8Array(geo.indices.buffer),
      [
        { location: 0, buffer: new Uint8Array(geo.pos.buffer), enabled: true, normalized: false, offset: 0, scalartype: GL_FLOAT, stride: 8, vectorlength: 2 },
        { location: 6, buffer: geo.colors, enabled: true, normalized: true, offset: 0, scalartype: GL_UNSIGNED_BYTE, stride: 4, vectorlength: 4 },
      ]
    );

    const program = this.createProgram();

    // Set up uniform buffer with UI framebuffer size
    // The shader converts UI coordinates to NDC
    const uniformBuffer = new ArrayBuffer(8);
    const view = new DataView(uniformBuffer);
    view.setFloat32(0, fbWidth, true);
    view.setFloat32(4, fbHeight, true);

    try {
      // At 4K: UI renders to fb 28 (texture 90), then Lanczos scaler reads texture 90 → fb 0
      // We must render to the UI framebuffer so it gets scaled by Lanczos
      const scalingTexId = uiScaleState?.scalingTextureId ?? 0;
      const isScaled = uiScaleState?.isScaled ?? false;

      // Use the framebuffer ID we found - this is more reliable than framebufferTexture
      // At 4K: render to UI framebuffer (fb 28), non-scaled: render to screen (fb 0)
      const targetFb = framebufferId;

      console.log(`[SpriteOverlay] Creating overlay: targetFb=${targetFb}, scalingTex=${scalingTexId}, isScaled=${isScaled}`);

      const handle = patchrs.native.beginOverlay(
        { framebufferId: targetFb }, // Match draws to our target framebuffer
        program,
        vertex,
        {
          uniformSources: [],
          uniformBuffer: new Uint8Array(uniformBuffer),
          renderMode: "triangles",
          // "after" renders right after matched draw calls
          trigger: "after",
          // Enable alpha blending for translucent overlays
          alphaBlend: true,
        }
      );
      this.overlayHandles.push(handle);
      console.log(`[SpriteOverlay] Rect (${Math.round(x)},${Math.round(y)}) ${Math.round(width)}x${Math.round(height)}, fb=${targetFb}, size=${fbWidth}x${fbHeight}${isScaled ? ' [4K]' : ''}`);
      return handle;
    } catch (e) {
      console.error("[SpriteOverlay] Failed:", e);
      return null;
    }
  }

  /**
   * Stop a specific overlay by handle
   */
  async stop(handle: patchrs.GlOverlay): Promise<void> {
    if (!handle) {
      console.warn("[SpriteOverlay] stop() called with null/undefined handle");
      return;
    }
    try {
      console.log(`[SpriteOverlay] Stopping overlay handle, tracked count: ${this.overlayHandles.length}`);
      handle.stop();
      const idx = this.overlayHandles.indexOf(handle);
      if (idx !== -1) {
        this.overlayHandles.splice(idx, 1);
        console.log(`[SpriteOverlay] Overlay stopped and removed from tracking, remaining: ${this.overlayHandles.length}`);
      } else {
        console.log(`[SpriteOverlay] Overlay stopped but was not in tracking list`);
      }
    } catch (e) {
      console.error("[SpriteOverlay] Error stopping overlay:", e);
    }
  }

  /**
   * Stop all overlays
   */
  async stopAll(): Promise<void> {
    const count = this.overlayHandles.length;
    if (count === 0) {
      console.log("[SpriteOverlay] stopAll() called but no overlays to stop");
      return;
    }
    console.log(`[SpriteOverlay] stopAll() stopping ${count} overlays`);
    for (const handle of this.overlayHandles) {
      try {
        handle.stop();
      } catch (e) {
        console.error("[SpriteOverlay] Error stopping overlay in stopAll:", e);
      }
    }
    this.overlayHandles = [];
    console.log(`[SpriteOverlay] All overlays stopped`);
  }

  /**
   * Get count of active overlays
   */
  getActiveCount(): number {
    return this.overlayHandles.length;
  }

  /**
   * Check if the SpriteOverlay system is available
   */
  isAvailable(): boolean {
    return patchrs.native !== null;
  }
}
