/**
 * FreeTypeRenderer - FreeType WASM text rendering engine
 *
 * Replaces Canvas2D fillText() with FreeType-hinted glyph rendering
 * for crisp, readable overlay text. Works in both alt1gl and regular alt1.
 *
 * Usage:
 *   const ft = FreeTypeRenderer.getInstance();
 *   await ft.init('./assets/fonts/MyFont.woff2');
 *   ft.drawText(ctx, 'Hello', 10, 20, 14, '#ffffff');
 */

// @ts-ignore — freetype-wasm ships JS+WASM, no perfect TS module resolution
import FreeTypeInit from "freetype-wasm/dist/freetype.js";

interface GlyphInfo {
  /** Pre-colored canvas for this glyph (white text, alpha from FreeType) */
  canvas: HTMLCanvasElement | null;
  /** Offset from cursor baseline to glyph top-left X */
  bitmapLeft: number;
  /** Offset from cursor baseline to glyph top-left Y */
  bitmapTop: number;
  /** Horizontal advance to next character (in pixels) */
  advance: number;
  /** Glyph index (for kerning lookups) */
  glyphIndex: number;
  /** Bitmap width */
  width: number;
  /** Bitmap rows */
  rows: number;
}

interface SizeCache {
  glyphs: Map<number, GlyphInfo>;
  ascender: number;
  descender: number;
  lineHeight: number;
}

// Characters to pre-cache (ASCII printable + common symbols)
const PRELOAD_FIRST = 32;  // space
const PRELOAD_LAST = 126;  // tilde
// Additional chars: bullet, checkmark, em-dash, curly quotes, ellipsis
const EXTRA_CHARS = [0x2022, 0x2713, 0x2014, 0x2018, 0x2019, 0x201C, 0x201D, 0x2026, 0x2192, 0xB7];

export class FreeTypeRenderer {
  private static instance: FreeTypeRenderer | null = null;

  private ft: any = null;
  private fontLoaded = false;
  private fontFamily = "";
  private sizeCache = new Map<number, SizeCache>();
  private initPromise: Promise<void> | null = null;

  /** Temp canvas for glyph coloring */
  private tempCanvas: HTMLCanvasElement;
  private tempCtx: CanvasRenderingContext2D;

  private constructor() {
    this.tempCanvas = document.createElement("canvas");
    this.tempCtx = this.tempCanvas.getContext("2d")!;
  }

  static getInstance(): FreeTypeRenderer {
    if (!FreeTypeRenderer.instance) {
      FreeTypeRenderer.instance = new FreeTypeRenderer();
    }
    return FreeTypeRenderer.instance;
  }

  get isReady(): boolean {
    return this.fontLoaded;
  }

  /**
   * Initialize FreeType WASM and load a font.
   * @param fontUrl URL to a TTF/OTF/WOFF2 font file
   * @param wasmUrl Optional URL to freetype.wasm (defaults to ./assets/freetype.wasm)
   */
  async init(fontUrl: string, wasmUrl?: string): Promise<void> {
    if (this.initPromise) return this.initPromise;

    this.initPromise = this._init(fontUrl, wasmUrl);
    return this.initPromise;
  }

  private async _init(fontUrl: string, wasmUrl?: string): Promise<void> {
    try {
      // Initialize FreeType WASM
      const resolvedWasmUrl = wasmUrl || "./assets/freetype.wasm";
      this.ft = await FreeTypeInit({
        locateFile: (_path: string) => resolvedWasmUrl,
      });

      // Fetch and load the font
      const response = await fetch(fontUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch font: ${response.status} ${response.statusText}`);
      }
      const fontBuffer = new Uint8Array(await response.arrayBuffer());
      const faces = this.ft.LoadFontFromBytes(fontBuffer);

      if (!faces || faces.length === 0) {
        throw new Error("FreeType: No font faces found in file");
      }

      this.fontFamily = faces[0].family_name;
      this.ft.SetFont(faces[0].family_name, faces[0].style_name);
      this.fontLoaded = true;

      console.log(`[FreeTypeRenderer] Initialized: ${this.fontFamily} ${faces[0].style_name}`);
    } catch (e) {
      console.error("[FreeTypeRenderer] Init failed:", e);
      this.fontLoaded = false;
      this.initPromise = null;
      throw e;
    }
  }

  /**
   * Ensure glyphs are cached for a given pixel size.
   */
  private ensureSize(pixelSize: number): SizeCache {
    let cache = this.sizeCache.get(pixelSize);
    if (cache) return cache;

    // Set pixel size and get metrics
    const metrics = this.ft.SetPixelSize(0, pixelSize);

    // ascender/descender are in 26.6 fixed point (divide by 64)
    const ascender = metrics.ascender / 64;
    const descender = metrics.descender / 64; // negative value
    const lineHeight = metrics.height / 64;

    cache = {
      glyphs: new Map(),
      ascender,
      descender,
      lineHeight,
    };

    // Pre-load ASCII range
    const charcodes: number[] = [];
    for (let c = PRELOAD_FIRST; c <= PRELOAD_LAST; c++) {
      charcodes.push(c);
    }
    charcodes.push(...EXTRA_CHARS);

    this.loadGlyphs(cache, charcodes, pixelSize);
    this.sizeCache.set(pixelSize, cache);
    return cache;
  }

  /**
   * Load and cache specific glyphs.
   */
  private loadGlyphs(cache: SizeCache, charcodes: number[], pixelSize: number): void {
    // Must re-set pixel size before loading (in case another size was active)
    this.ft.SetPixelSize(0, pixelSize);

    const glyphMap = this.ft.LoadGlyphs(
      charcodes,
      this.ft.FT_LOAD_RENDER | this.ft.FT_LOAD_TARGET_LIGHT
    );

    for (const [charcode, slot] of glyphMap) {
      const info: GlyphInfo = {
        canvas: null,
        bitmapLeft: slot.bitmap_left,
        bitmapTop: slot.bitmap_top,
        advance: slot.advance.x / 64, // 26.6 fixed point
        glyphIndex: slot.glyph_index,
        width: slot.bitmap.width,
        rows: slot.bitmap.rows,
      };

      // Create glyph canvas from bitmap (if glyph has visual data)
      if (slot.bitmap.imagedata && slot.bitmap.width > 0 && slot.bitmap.rows > 0) {
        const glyphCanvas = document.createElement("canvas");
        glyphCanvas.width = slot.bitmap.width;
        glyphCanvas.height = slot.bitmap.rows;
        const glyphCtx = glyphCanvas.getContext("2d")!;
        glyphCtx.putImageData(slot.bitmap.imagedata, 0, 0);
        info.canvas = glyphCanvas;
      }

      cache.glyphs.set(charcode, info);
    }
  }

  /**
   * Get a glyph, loading on-demand if not cached.
   * Returns null for .notdef glyphs (glyphIndex === 0) to skip unknown characters
   * instead of rendering a tofu box.
   */
  private getGlyph(cache: SizeCache, charcode: number, pixelSize: number): GlyphInfo | null {
    let glyph = cache.glyphs.get(charcode);
    if (!glyph) {
      // Load on demand
      this.loadGlyphs(cache, [charcode], pixelSize);
      glyph = cache.glyphs.get(charcode);
    }
    if (!glyph) return null;
    // Skip .notdef (tofu box) — the font doesn't have this character
    return glyph.glyphIndex === 0 ? null : glyph;
  }

  /**
   * Measure text width in pixels.
   */
  measureText(text: string, fontSize: number): number {
    if (!this.fontLoaded) return text.length * fontSize * 0.6; // rough fallback

    const cache = this.ensureSize(fontSize);
    let width = 0;

    for (let i = 0; i < text.length; i++) {
      const charcode = text.charCodeAt(i);
      const glyph = this.getGlyph(cache, charcode, fontSize);
      if (glyph) {
        width += glyph.advance;

        // Apply kerning if available
        if (i + 1 < text.length) {
          const nextCharcode = text.charCodeAt(i + 1);
          const nextGlyph = this.getGlyph(cache, nextCharcode, fontSize);
          if (nextGlyph) {
            try {
              const kern = this.ft.GetKerning(glyph.glyphIndex, nextGlyph.glyphIndex, 0);
              width += kern.x / 64;
            } catch (_) {
              // Kerning not available for this pair
            }
          }
        }
      }
    }

    return width;
  }

  /**
   * Get line height for a font size.
   */
  getLineHeight(fontSize: number): number {
    if (!this.fontLoaded) return fontSize * 1.4;
    const cache = this.ensureSize(fontSize);
    return cache.lineHeight;
  }

  /**
   * Get ascender (distance from baseline to top) for a font size.
   */
  getAscender(fontSize: number): number {
    if (!this.fontLoaded) return fontSize * 0.8;
    const cache = this.ensureSize(fontSize);
    return cache.ascender;
  }

  /**
   * Draw text onto a CanvasRenderingContext2D at the given position.
   *
   * @param ctx Target canvas context
   * @param text Text to render
   * @param x X position (left edge)
   * @param y Y position (baseline, same as Canvas2D fillText)
   * @param fontSize Font size in pixels
   * @param color CSS color string (e.g., '#ffffff', 'rgb(255,0,0)')
   */
  drawText(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    fontSize: number,
    color: string
  ): void {
    if (!this.fontLoaded) {
      // Fallback to Canvas2D
      ctx.fillStyle = color;
      ctx.font = `${fontSize}px sans-serif`;
      ctx.fillText(text, x, y);
      return;
    }

    const cache = this.ensureSize(fontSize);
    let cursorX = x;

    for (let i = 0; i < text.length; i++) {
      const charcode = text.charCodeAt(i);
      const glyph = this.getGlyph(cache, charcode, fontSize);

      if (glyph && glyph.canvas) {
        // Position: cursor + bearing offset
        const drawX = cursorX + glyph.bitmapLeft;
        const drawY = y - glyph.bitmapTop; // baseline - top bearing

        // Draw colored glyph:
        // 1. Draw glyph alpha mask to temp canvas
        // 2. Apply color via source-in compositing
        // 3. Draw result to target
        this.tempCanvas.width = glyph.width;
        this.tempCanvas.height = glyph.rows;
        this.tempCtx.clearRect(0, 0, glyph.width, glyph.rows);
        this.tempCtx.drawImage(glyph.canvas, 0, 0);
        this.tempCtx.globalCompositeOperation = "source-in";
        this.tempCtx.fillStyle = color;
        this.tempCtx.fillRect(0, 0, glyph.width, glyph.rows);
        this.tempCtx.globalCompositeOperation = "source-over";

        ctx.drawImage(this.tempCanvas, drawX, drawY);
      }

      if (glyph) {
        cursorX += glyph.advance;

        // Kerning
        if (i + 1 < text.length) {
          const nextCharcode = text.charCodeAt(i + 1);
          const nextGlyph = this.getGlyph(cache, nextCharcode, fontSize);
          if (nextGlyph) {
            try {
              const kern = this.ft.GetKerning(glyph.glyphIndex, nextGlyph.glyphIndex, 0);
              cursorX += kern.x / 64;
            } catch (_) {}
          }
        }
      }
    }
  }

  /**
   * Draw text with bold simulation (draw twice with 1px offset).
   */
  drawTextBold(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    fontSize: number,
    color: string
  ): void {
    // Synthetic bold: draw at offset + original position
    this.drawText(ctx, text, x + 0.5, y, fontSize, color);
    this.drawText(ctx, text, x - 0.5, y, fontSize, color);
  }

  /**
   * Measure text width with bold simulation.
   */
  measureTextBold(text: string, fontSize: number): number {
    return this.measureText(text, fontSize) + 1; // +1 for the bold offset
  }

  /**
   * Clear the glyph cache (e.g., when changing fonts).
   */
  clearCache(): void {
    this.sizeCache.clear();
  }
}
