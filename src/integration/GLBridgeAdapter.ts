/**
 * GLBridge Adapter
 *
 * Bridges RS3QuestBuddyBeta's GL layer to QuestStateEngine's detection system.
 * Implements the GLBridge interface expected by QuestStateEngine detectors.
 */

import * as patchrs from "../gl/injection/util/patchrs_napi";
import { AtlasTracker, getUIState, type RenderRect as RS3RenderRect } from "../gl/injection/reflect2d/reflect2d";
import { SpriteCache, type SpriteInfo as RS3SpriteInfo } from "../gl/injection/reflect2d/spritecache";

// Types matching QuestStateEngine's detection/types.ts
export type RGBAColor = [number, number, number, number];

export interface FontCharInfo {
  chr: string;
  charcode?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface KnownSprite {
  id: number;
  subId?: number;
  fontchr?: FontCharInfo;  // Full object for UIRenderParser compatibility
  name?: string;
  font?: any;  // Font sheet reference for UIRenderParser
}

export interface SpriteInfo {
  hash: number;
  known?: KnownSprite;
  // Raw texture data for pHash computation (preserved from GL layer)
  basetex?: any;
  texX?: number;
  texY?: number;
  texWidth?: number;
  texHeight?: number;
}

export interface RenderRect {
  x: number;
  y: number;
  width: number;
  height: number;
  color: RGBAColor;
  sprite: SpriteInfo;
}

export interface RenderRecordOptions {
  texturesnapshot?: boolean;
  vertexarray?: boolean;
  uniforms?: boolean;
  maxframes?: number;
}

export interface UIState {
  elements: RenderRect[];
  atlasTracker: AtlasTracker;
}

export interface GLBridge {
  recordRenderCalls(options: RenderRecordOptions): Promise<patchrs.RenderInvocation[]>;
  getUIState(renders: patchrs.RenderInvocation[]): UIState;
  capturePixels(textureId: number, x: number, y: number, width: number, height: number): Promise<Uint8Array>;
  getUIScale(): number;
}


/**
 * Adapter that implements GLBridge using RS3QuestBuddyBeta's reflect2d system
 */
export class GLBridgeAdapter implements GLBridge {
  private spriteCache: SpriteCache;
  private atlasTracker: AtlasTracker;
  private uiScale: number = 1;
  constructor(spriteCache: SpriteCache) {
    this.spriteCache = spriteCache;
    this.atlasTracker = new AtlasTracker(spriteCache);
  }

  /**
   * Record render calls from the current frame
   */
  async recordRenderCalls(options: RenderRecordOptions): Promise<patchrs.RenderInvocation[]> {
    // Build features array based on options
    type FeatureType = "vertexarray" | "uniforms" | "textures" | "texturesnapshot" | "texturecapture" | "computebindings" | "framebuffer" | "full";
    const features: FeatureType[] = [];
    if (options.texturesnapshot) features.push('texturesnapshot');
    if (options.vertexarray) features.push('vertexarray');
    if (options.uniforms) features.push('uniforms');

    const renders = await patchrs.native.recordRenderCalls({
      features,
      maxframes: options.maxframes ?? 1,
    });
    return renders;
  }

  /**
   * Get UI elements from render data
   * Converts RS3QuestBuddyBeta's RenderRect format to QuestStateEngine's format
   */
  getUIState(renders: patchrs.RenderInvocation[]): UIState {
    const rs3State = getUIState(renders, this.atlasTracker);
    const elements = rs3State.elements.map(el => this.convertRenderRect(el));

    return {
      elements,
      atlasTracker: this.atlasTracker,
    };
  }

  /**
   * Convert RS3QuestBuddyBeta RenderRect to QuestStateEngine RenderRect
   */
  private convertRenderRect(rs3Rect: RS3RenderRect): RenderRect {
    const sprite = rs3Rect.sprite;
    const known = sprite.known;

    // Map the sprite info - preserve full fontchr object for UIRenderParser compatibility
    const rawSprite = sprite as any;
    const spriteInfo: SpriteInfo = {
      hash: sprite.pixelhash,
      known: known ? {
        id: known.id,
        subId: known.subid,
        fontchr: known.fontchr ? {
          chr: known.fontchr.chr,
          charcode: known.fontchr.charcode,
          x: known.fontchr.x,
          y: known.fontchr.y,
          width: known.fontchr.width,
          height: known.fontchr.height,
        } : undefined,
        name: known.itemName ?? undefined,
        font: known.font,  // Preserve font sheet reference
      } : undefined,
      // Preserve raw texture data for pHash computation
      basetex: rawSprite.basetex,
      texX: rawSprite.x,
      texY: rawSprite.y,
      texWidth: rawSprite.width,
      texHeight: rawSprite.height,
    };

    // Color is already in ABGR format [A, B, G, R] with 0-255 values
    // Note: RS3QB color array is [r, g, b, a] but values are 0-1 floats
    // We need to convert to 0-255 integers in [A, B, G, R] order
    const color: RGBAColor = [
      Math.round(rs3Rect.color[3] * 255), // A
      Math.round(rs3Rect.color[2] * 255), // B
      Math.round(rs3Rect.color[1] * 255), // G
      Math.round(rs3Rect.color[0] * 255), // R
    ];

    return {
      x: rs3Rect.x,
      y: rs3Rect.y,
      width: rs3Rect.width,
      height: rs3Rect.height,
      color,
      sprite: spriteInfo,
    };
  }

  /**
   * Capture pixels from a texture or framebuffer
   */
  async capturePixels(
    textureId: number,
    x: number,
    y: number,
    width: number,
    height: number
  ): Promise<Uint8Array> {
    // This would need access to the texture data from patchrs
    // For now, return empty array - implement based on specific needs
    console.warn("[GLBridgeAdapter] capturePixels not fully implemented");
    return new Uint8Array(width * height * 4);
  }

  /**
   * Get current UI scale factor
   */
  getUIScale(): number {
    return this.uiScale;
  }

  /**
   * Set UI scale factor (call when detected or configured)
   */
  setUIScale(scale: number): void {
    this.uiScale = scale;
  }

  /**
   * Initialize mouse position tracking.
   * Checks if overlay API is available (set up by launcher preload or pipe connection).
   * Returns true if mouse tracking is available.
   */
  async initMouseTracking(): Promise<boolean> {
    // Check overlay API (set up by launcher preload or pipe connection)
    if (patchrs.native.overlay?.getMousePosition) {
      console.log('[GLBridgeAdapter] Mouse tracking via overlay API: available');
      return true;
    }

    console.log('[GLBridgeAdapter] Mouse tracking: not available (no overlay API)');
    return false;
  }

  /**
   * Get current mouse position in GL viewport coordinates (Y-up).
   * Uses overlay API (set up by launcher preload or pipe connection).
   */
  getMousePositionGL(debug: boolean = false): { x: number; y: number } | null {
    // Check overlay API
    try {
      const clientPos = patchrs.native.overlay?.getMousePosition();
      if (clientPos) {
        const viewportHeight = patchrs.native.getRsHeight() || 0;
        if (viewportHeight <= 0) return null;

        const glX = clientPos.x;
        const glY = viewportHeight - clientPos.y;

        if (debug) {
          console.log(`[MouseTrack] Overlay: Client(${clientPos.x}, ${clientPos.y}) → GL(${glX}, ${glY})`);
        }

        if (glX < -10 || glY < -10 || glX > 10000 || glY > 10000) return null;
        return { x: glX, y: glY };
      }
    } catch (e) {
      if (debug) console.warn('[MouseTrack] Overlay error:', e);
    }

    if (debug) console.log('[MouseTrack] No mouse position available');
    return null;
  }

  /**
   * Stop mouse tracking (cleanup)
   */
  stopMouseTracking(): void {
    // No cleanup needed for overlay API
  }

  /**
   * Get the underlying sprite cache for direct access
   */
  getSpriteCache(): SpriteCache {
    return this.spriteCache;
  }

  /**
   * Get the atlas tracker for direct access
   */
  getAtlasTracker(): AtlasTracker {
    return this.atlasTracker;
  }

  /**
   * Get item name from pHash (16-char hex string)
   */
  getItemByPHash(pHash: string): string | null {
    return this.spriteCache.getItemByPHash(pHash);
  }

  /**
   * Find item by pHash with fuzzy matching
   */
  findItemByPHash(pHash: string, threshold: number = 10): { name: string; distance: number; pHash: string } | null {
    return this.spriteCache.findItemByPHash(pHash, threshold);
  }
}

/**
 * Create a GLBridge adapter with initialized sprite cache
 */
export async function createGLBridge(): Promise<GLBridgeAdapter> {
  const spriteCache = new SpriteCache();
  await spriteCache.downloadCacheData();
  return new GLBridgeAdapter(spriteCache);
}
