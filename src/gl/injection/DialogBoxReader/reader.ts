/**
 * DialogBoxReader API
 *
 * Detects and reads dialog box buttons from RuneScape 3's UI.
 *
 * @example
 * ```typescript
 * import { DialogBoxReader } from "./reader";
 *
 * const reader = new DialogBoxReader();
 * await reader.init();
 *
 * // One-shot detection
 * const result = await reader.detect();
 * if (result) {
 *   console.log("Found buttons:", result.buttons.map(b => b.text));
 * }
 *
 * // Continuous monitoring
 * reader.onDetect((result) => {
 *   console.log("Dialog detected:", result.buttons);
 * });
 * reader.start();
 *
 * // Later...
 * reader.stop();
 * ```
 */

import * as patchrs from "../util/patchrs_napi";
import * as uiparser from "../reflect2d/uiparser";
import { AtlasTracker, getUIState } from "../reflect2d/reflect2d";
import { SpriteCache } from "../reflect2d/spritecache";
import { renderStream, uiScaleState } from "./util";

/** Known sprite IDs for dialog box components */
export const DIALOG_IDS = {
  /** Close button (X) */
  dialogxbtn: 18638,
  /** Button background (middle stretch) */
  dialogboxbtnbg: 9060,
  /** Button start cap (left) */
  dialogbtnstart: 9059,
  /** Button end cap (right) */
  dialogbtnend: 9061,
  /** Accept Quest button background (quest start screen) */
  acceptQuestBg: 17817,
  /** Continue button (click to continue dialog) */
  continueBtn: 18635,
  /** Accept Quest button variant 2 — render order: subid 0 (bg), 1 (end), 2 (start) */
  acceptQuestBg2: 60000,
};

/** Set of all dialog sprite IDs for fast lookup (skip masking) */
const DIALOG_ID_SET = new Set([
  DIALOG_IDS.dialogxbtn,
  DIALOG_IDS.dialogboxbtnbg,
  DIALOG_IDS.dialogbtnstart,
  DIALOG_IDS.dialogbtnend,
  DIALOG_IDS.acceptQuestBg,
  DIALOG_IDS.continueBtn,
  DIALOG_IDS.acceptQuestBg2,
]);

/** Default color for buttons when color data is unavailable */
const DEFAULT_COLOR: [number, number, number, number] = [255, 255, 255, 255];

/**
 * Pressed button brightness threshold
 * RS3 dialog buttons are naturally dark (~0.21-0.25 brightness)
 * When pressed, they darken further to ~0.16
 * Threshold set to catch pressed state without false positives on normal buttons
 */
const PRESSED_BRIGHTNESS_THRESHOLD = 0.19;

/**
 * Sample brightness from center of captured button image
 * Assumes imageData is already the button region (captured directly)
 */
function sampleCenterBrightness(imageData: ImageData): number {
  const { data, width, height } = imageData;

  // Sample center 50% of the captured region
  const startX = Math.floor(width * 0.25);
  const startY = Math.floor(height * 0.25);
  const endX = Math.floor(width * 0.75);
  const endY = Math.floor(height * 0.75);

  let totalBrightness = 0;
  let sampleCount = 0;

  for (let y = startY; y < endY; y++) {
    for (let x = startX; x < endX; x++) {
      const idx = (y * width + x) * 4;
      const r = data[idx] / 255;
      const g = data[idx + 1] / 255;
      const b = data[idx + 2] / 255;
      totalBrightness += (r + g + b) / 3;
      sampleCount++;
    }
  }

  return sampleCount > 0 ? totalBrightness / sampleCount : 1.0;
}

/**
 * Detect orange pixels in the button region (hover indicator)
 * Orange pixels have high R, medium G, low B
 * Returns the percentage of pixels that are "orange-ish"
 */
function detectOrangePixels(imageData: ImageData): number {
  const { data, width, height } = imageData;

  let orangeCount = 0;
  let totalCount = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];

      // Orange detection: R > 150, G between 50-150, B < 80
      // Also check for amber/gold tones
      const isOrange = r > 150 && g > 50 && g < 180 && b < 100 && r > g && g > b;
      if (isOrange) {
        orangeCount++;
      }
      totalCount++;
    }
  }

  return totalCount > 0 ? orangeCount / totalCount : 0;
}

/**
 * Capture button region pixels from the screen framebuffer
 * Always captures from fb=-1 (main screen) since fb=25 returns empty data
 * Scales UI coordinates to screen coordinates when in 4K mode
 */
async function captureButtonRegion(buttonRect: ButtonRect): Promise<ImageData | null> {
  if (!patchrs.native) return null;

  try {
    // Always capture from main screen framebuffer (-1)
    // fb=25 returns empty pixel data even though dimensions are correct
    const screenHeight = patchrs.native.getRsHeight?.() || 1080;

    // Scale button coordinates from UI space to screen space
    const scaleX = uiScaleState.isScaled ? uiScaleState.scaleX : 1;
    const scaleY = uiScaleState.isScaled ? uiScaleState.scaleY : 1;

    const scaledX = buttonRect.x * scaleX;
    const scaledY = buttonRect.y * scaleY;
    const scaledW = buttonRect.width * scaleX;
    const scaledH = buttonRect.height * scaleY;

    // Flip Y: GL has 0 at bottom, screen capture has 0 at top
    // captureY = screenHeight - scaledY - scaledH
    const captureY = screenHeight - scaledY - scaledH;

    const imageData = await patchrs.native.capture(
      -1, // Main screen framebuffer
      Math.floor(scaledX),
      Math.floor(captureY),
      Math.ceil(scaledW),
      Math.ceil(scaledH)
    );

    if (imageData && imageData.width > 0 && imageData.height > 0) {
      return imageData;
    }
    return null;
  } catch (e) {
    // Silently fail - pressed detection is optional
    return null;
  }
}

/**
 * Detect if a button is in pressed state by capturing and sampling its pixels
 * @param buttonRect - Button bounds in UI coordinates (GL space, Y=0 at bottom)
 */
async function detectButtonPressedAsync(
  buttonRect: ButtonRect
): Promise<{ pressed: boolean; brightness?: number; orangePct?: number }> {
  const buttonPixels = await captureButtonRegion(buttonRect);

  if (buttonPixels) {
    const brightness = sampleCenterBrightness(buttonPixels);
    const orangePct = detectOrangePixels(buttonPixels);
    const pressed = brightness < PRESSED_BRIGHTNESS_THRESHOLD;
    return { pressed, brightness, orangePct };
  }

  return { pressed: false };
}

/** Rectangle bounds */
export interface ButtonRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A detected dialog button */
export interface DialogButton {
  /** The button's text label */
  text: string;
  /** Start cap sprite bounds (left side), null if not present */
  start: ButtonRect | null;
  /** Background sprite bounds (middle) */
  bg: ButtonRect;
  /** End cap sprite bounds (right side), null if not present */
  end: ButtonRect | null;
  /** Whether the button appears to be in pressed/clicked state (direct brightness detection) */
  pressed: boolean;
  /** Raw RGBA color values from the button background (for debugging) */
  bgColor: [number, number, number, number];
  /** Sampled center brightness (0-1), used for transition detection by consumer */
  brightness?: number;
}

/** Debug info for dialog detection */
export interface DialogDebugInfo {
  /** Number of button background sprites found (ID 9060) */
  bgSpritesFound: number;
  /** Number of text elements found */
  textElementsFound: number;
  /** Total elements processed */
  totalElements: number;
}

export interface DialogBoxResult {
  buttons: DialogButton[];
  /** Bounding box of the entire dialog area */
  bounds: ButtonRect;
  /** Header text (e.g., "Choose an option:"), if detected */
  header: string | null;
  /** Debug info */
  debug?: DialogDebugInfo;
}

/** Callback for dialog detection events - result is null when no dialog detected */
export type DialogDetectCallback = (result: DialogBoxResult | null, renders?: patchrs.RenderInvocation[]) => void;

/**
 * DialogBoxReader - Detects and reads dialog box buttons
 */
export class DialogBoxReader {
  private spriteCache: SpriteCache | null = null;
  private atlas: AtlasTracker | null = null;
  private initialized = false;
  private stream: patchrs.StreamRenderObject | null = null;
  private callbacks: DialogDetectCallback[] = [];
  private lastResult: DialogBoxResult | null = null;
  /** Guard to prevent overlapping brightness checks - only one can run at a time */
  private brightnessCheckInProgress = false;
  /** Flag indicating we skipped a check while one was in progress - need to recheck */
  private recheckNeeded = false;
  /** Minimum interval between brightness checks (ms) */
  private lastBrightnessCheckTime = 0;

  constructor() {}

  /**
   * Initialize the reader (downloads sprite cache data)
   * Must be called before detect() or start()
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    try {
      this.spriteCache = new SpriteCache();
      await this.spriteCache.downloadCacheData();
      this.atlas = new AtlasTracker(this.spriteCache);
      this.initialized = true;
    } catch (e) {
      console.error("[DialogBoxReader] Failed to initialize:", e);
      throw e;
    }
  }

  /**
   * Check if the reader is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * One-shot detection - captures current frame and detects dialog
   * @returns DialogBoxResult if dialog found, null otherwise
   */
  async detect(): Promise<DialogBoxResult | null> {
    if (!this.initialized || !this.atlas) {
      throw new Error("DialogBoxReader not initialized. Call init() first.");
    }

    if (!patchrs.native) {
      console.warn("[DialogBoxReader] Native addon not available");
      return null;
    }

    let renders: patchrs.RenderInvocation[] = [];
    try {
      // Capture renders for dialog detection
      renders = await this.captureRenders();
      return this.detectFromRenders(renders);
    } catch (e) {
      console.error("[DialogBoxReader] Error during detection:", e);
      return null;
    } finally {
      for (const r of renders) { try { r.dispose?.(); } catch (_) {} }
    }
  }

  /**
   * Capture UI renders with texture snapshots
   */
  private async captureRenders(): Promise<patchrs.RenderInvocation[]> {
    if (!patchrs.native) return [];

    // Capture UI renders with texture snapshots (like gameuiview reference)
    return await patchrs.native.recordRenderCalls({
      maxframes: 1,
      framebufferId: 0,
      features: ["vertexarray", "uniforms", "texturesnapshot"]
    });
  }

  /**
   * Detect dialog from existing render data
   * @param renders - Render invocations from recordRenderCalls
   */
  detectFromRenders(
    renders: patchrs.RenderInvocation[]
  ): DialogBoxResult | null {
    if (!this.atlas) {
      throw new Error("DialogBoxReader not initialized. Call init() first.");
    }

    const result = detectDialogBox(renders, this.atlas);
    if (result) {
      this.lastResult = result;
    }
    return result;
  }

  /**
   * Get the last detected result
   */
  getLastResult(): DialogBoxResult | null {
    return this.lastResult;
  }

  /**
   * Register a callback for dialog detection
   * @param callback - Called when a dialog is detected
   */
  onDetect(callback: DialogDetectCallback): void {
    this.callbacks.push(callback);
  }

  /**
   * Remove a detection callback
   */
  offDetect(callback: DialogDetectCallback): void {
    const idx = this.callbacks.indexOf(callback);
    if (idx !== -1) {
      this.callbacks.splice(idx, 1);
    }
  }

  /**
   * Remove all detection callbacks
   */
  clearCallbacks(): void {
    this.callbacks.length = 0;
  }

  /**
   * Start continuous monitoring for dialogs using streamRenderCalls
   * Uses renderStream from util.ts to properly handle 4K UI scaling
   */
  start(): void {
    if (!this.initialized || !this.atlas) {
      throw new Error("DialogBoxReader not initialized. Call init() first.");
    }

    if (this.stream) {
      this.stop();
    }

    if (!patchrs.native) {
      console.warn("[DialogBoxReader] Native addon not available");
      return;
    }

    // Use renderStream from util.ts - it handles 4K UI scaling by:
    // 1. Finding the Lanczos scaler and its source texture
    // 2. Recording UI renders from the scaling texture's framebuffer
    // This ensures we capture UI elements at 4K where they're rendered to a separate fb
    this.stream = renderStream(patchrs.native, (renders) => this.handleStreamFrame(renders));
  }

  /**
   * Handle incoming stream frame
   * Note: This is called synchronously from the render stream.
   * For pressed detection, we capture framebuffer async when buttons are found.
   */
  private handleStreamFrame(renders: patchrs.RenderInvocation[]): void {
    if (!renders || renders.length === 0) return;

    try {
      // Detect dialog buttons from render data
      const result = this.detectFromRenders(renders);

      // CRITICAL: Update lastResult so updatePressedStates sees the current buttons
      // Without this, updatePressedStates would check stale buttons from a previous dialog!
      this.lastResult = result;

      // If we found buttons, capture each button's pixels async to check pressed state
      if (result && result.buttons.length > 0) {
        const now = Date.now();
        if (!this.brightnessCheckInProgress && now - this.lastBrightnessCheckTime >= 500) {
          // No check in progress and enough time has passed - start one
          this.lastBrightnessCheckTime = now;
          this.recheckNeeded = false;
          this.updatePressedStates(renders);
        } else if (this.brightnessCheckInProgress) {
          // Check in progress - mark that we need to recheck when it finishes
          this.recheckNeeded = true;
        }
      }

      // Always call callbacks - even when result is null so overlay can be cleared
      for (const cb of this.callbacks) {
        try {
          cb(result, renders);
        } catch (e) {
          // Ignore callback errors
        }
      }
    } catch (e: any) {
      const msg = e?.message || String(e);
      if (!msg.includes("No rs process")) {
        console.warn("[DialogBoxReader] Stream frame error:", msg);
      }
    }
  }

  /**
   * Async helper to update pressed states after initial detection
   * Captures each button's region individually and checks brightness
   */
  private async updatePressedStates(
    renders: patchrs.RenderInvocation[]
  ): Promise<void> {
    // Guard: only one brightness check at a time to prevent async pileup
    if (this.brightnessCheckInProgress) return;
    this.brightnessCheckInProgress = true;

    // IMPORTANT: Capture the result reference NOW, before any awaits
    // this.lastResult can be overwritten by newer frames while we process
    const result = this.lastResult;
    if (!result || result.buttons.length === 0) {
      this.brightnessCheckInProgress = false;
      return;
    }

    try {
      // Update pressed state for each button by capturing its region
      // Simple approach: just detect direct brightness press (<0.19) and report values
      // Transition detection is handled by the consumer (useGlQuestIntegration)
      // who knows which specific button is highlighted

      for (const btn of result.buttons) {
        const { pressed, brightness } = await detectButtonPressedAsync(btn.bg);

        // Set button state: direct brightness detection only
        btn.pressed = pressed;
        btn.brightness = brightness;
      }

      // Always fire callbacks with brightness data so consumer can do transition detection
      // The consumer (useGlQuestIntegration) tracks highlighted button brightness history
      // and needs to see brightness values even when not directly pressed
      for (const cb of this.callbacks) {
        try {
          cb(result, renders);
        } catch (e) {
          // Ignore callback errors
        }
      }
    } catch (e) {
      // Ignore errors - pressed detection is best-effort
    } finally {
      this.brightnessCheckInProgress = false;

      // If frames were skipped while we were checking, the next stream frame (every ~150ms)
      // will trigger a fresh check automatically. No need for manual recheck.
      if (this.recheckNeeded) {
        this.recheckNeeded = false;
      }
    }
  }

  /**
   * Stop continuous monitoring
   */
  stop(): void {
    if (this.stream) {
      this.stream.close();
      this.stream = null;
    }
  }

  /**
   * Check if monitoring is active
   */
  isRunning(): boolean {
    return this.stream !== null;
  }

  /**
   * Find a button by text (case-insensitive partial match)
   * @param searchText - Text to search for
   * @param result - Optional result to search in (uses lastResult if not provided)
   */
  findButton(
    searchText: string,
    result?: DialogBoxResult
  ): DialogButton | null {
    const target = result ?? this.lastResult;
    if (!target) return null;
    return findButtonByText(target, searchText);
  }

  /**
   * Get all button texts from a result
   * @param result - Optional result (uses lastResult if not provided)
   */
  getButtonTexts(result?: DialogBoxResult): string[] {
    const target = result ?? this.lastResult;
    if (!target) return [];
    return target.buttons.map((b) => b.text);
  }

  /**
   * Clear the atlas cache to free memory
   * Call this periodically to prevent memory buildup from accumulated texture data
   */
  clearCache(): void {
    if (this.atlas) {
      this.atlas.cache.clear();
    }
    this.lastResult = null;
  }

  /**
   * Get the current cache size for debugging
   */
  getCacheSize(): number {
    return this.atlas?.cache.size ?? 0;
  }

}

/**
 * Find a button by text (case-insensitive partial match)
 */
export function findButtonByText(
  result: DialogBoxResult,
  searchText: string
): DialogButton | null {
  const search = searchText.toLowerCase();
  return (
    result.buttons.find((btn) => btn.text.toLowerCase().includes(search)) ??
    null
  );
}

/**
 * Low-level detection function - use DialogBoxReader class for easier API
 * @param renders - Render invocations from recordRenderCalls
 * @param atlas - AtlasTracker instance
 */
export function detectDialogBox(
  renders: patchrs.RenderInvocation[],
  atlas: AtlasTracker
): DialogBoxResult | null {
  const newstate = getUIState(renders, atlas);

  // Skip masking: quick scan for dialog sprite IDs before expensive processing
  // This avoids text parsing and pattern matching when no dialog is present
  let hasDialogSprite = false;
  for (const el of newstate.elements) {
    const spriteId = el.sprite.known?.id;
    if (spriteId && DIALOG_ID_SET.has(spriteId)) {
      hasDialogSprite = true;
      break;
    }
  }

  if (!hasDialogSprite) {
    // No dialog sprites found - skip all further processing
    return null;
  }

  const parser = new uiparser.UIRenderParser(newstate.elements);

  const buttons: DialogButton[] = [];

  // First, find all bg sprites (including color data for pressed detection)
  const bgSprites: Array<{
    x: number;
    y: number;
    width: number;
    height: number;
    index: number;
    color: [number, number, number, number];
  }> = [];

  for (let i = 0; i < newstate.elements.length; i++) {
    const el = newstate.elements[i];
    // Check for regular dialog button, accept quest button, OR continue button
    if (el.sprite.known?.id === DIALOG_IDS.dialogboxbtnbg ||
        el.sprite.known?.id === DIALOG_IDS.acceptQuestBg ||
        el.sprite.known?.id === DIALOG_IDS.continueBtn ||
        (el.sprite.known?.id === DIALOG_IDS.acceptQuestBg2 && el.sprite.known?.subid === 0)) {
      bgSprites.push({
        x: el.x,
        y: el.y,
        width: el.width,
        height: el.height,
        index: i,
        color: el.color as [number, number, number, number],
      });
    }
  }

  // Find all text elements
  const textElements: Array<{
    text: string;
    x: number;
    y: number;
    index: number;
  }> = [];

  const textParser = new uiparser.UIRenderParser(newstate.elements);
  while (textParser.index < textParser.end) {
    const el = textParser.peek();
    if (el?.sprite.known?.fontchr) {
      const fontResult = textParser.readFont();
      if (fontResult.text) {
        textElements.push({
          text: fontResult.text,
          x: fontResult.x,
          y: fontResult.y,
          index: fontResult.startindex,
        });
        // Log gap data for debugging font spacing issues
        // if (fontResult.gaps && fontResult.gaps.length > 0) {
        //   const fontHash = fontResult.font?.basesprite?.hash ?? "unknown";
        //   const gapSummary = fontResult.gaps
        //     .map((g: { prevChar: string; nextChar: string; gap: number }) => `${g.prevChar}→${g.nextChar}:${g.gap}`)
        //     .join(" ");
        //   console.log(
        //     `[font:${fontHash}] [${fontResult.text}] gaps: ${gapSummary}`
        //   );
        // }
      }
    } else {
      textParser.skip(1);
    }
  }

  // Search for button patterns
  let foundContinueBtn = false;
  while (parser.index < parser.end) {
    // Full pattern: start (optional) -> bg -> end (optional) -> text
    let match = parser.searchUIPattern([
      { id: DIALOG_IDS.dialogbtnstart, ref: "btnStart", repeat: [0, 1] },
      { id: DIALOG_IDS.dialogboxbtnbg, ref: "btnBg" },
      { id: DIALOG_IDS.dialogbtnend, ref: "btnEnd", repeat: [0, 1] },
      { repeat: [0, 10] },
      { string: "", ref: "btnText" },
    ]);

    if (!match) {
      // Try simpler pattern: just bg + text
      const simpleMatch = parser.searchUIPattern([
        { id: DIALOG_IDS.dialogboxbtnbg, ref: "btnBg" },
        { repeat: [0, 10] },
        { string: "", ref: "btnText" },
      ]);

      if (simpleMatch) {
        const bgMatch = simpleMatch.btnBg.match;
        // Find color from the matching bg sprite
        const bgColor = bgSprites.find(
          s => Math.abs(s.x - bgMatch.x) < 1 && Math.abs(s.y - bgMatch.y) < 1
        )?.color ?? DEFAULT_COLOR;

        const bgRect: ButtonRect = {
          x: bgMatch.x,
          y: bgMatch.y,
          width: bgMatch.width,
          height: bgMatch.height,
        };
        buttons.push({
          text: simpleMatch.btnText.text,
          start: null,
          bg: bgRect,
          end: null,
          pressed: false, // Updated async via updatePressedStates
          bgColor,
        });
        continue;
      }

      // Try ACCEPT QUEST button pattern (sprite 17817)
      const acceptMatch = parser.searchUIPattern([
        { id: DIALOG_IDS.acceptQuestBg, ref: "btnBg" },
        { repeat: [0, 10] },
        { string: "", ref: "btnText" },
      ]);

      if (acceptMatch) {
        const bgMatch = acceptMatch.btnBg.match;
        const bgColor = bgSprites.find(
          s => Math.abs(s.x - bgMatch.x) < 1 && Math.abs(s.y - bgMatch.y) < 1
        )?.color ?? DEFAULT_COLOR;

        const bgRect: ButtonRect = {
          x: bgMatch.x,
          y: bgMatch.y,
          width: bgMatch.width,
          height: bgMatch.height,
        };
        buttons.push({
          text: acceptMatch.btnText.text,
          start: null,
          bg: bgRect,
          end: null,
          pressed: false, // Updated async via updatePressedStates
          bgColor,
        });
        continue;
      }

      // Try CONTINUE button pattern (sprite 18635 - click to continue dialog)
      // This is just a sprite with no text - used to advance dialog
      if (!foundContinueBtn) {
        const continueMatch = parser.searchUIPattern([
          { id: DIALOG_IDS.continueBtn, ref: "continueBtn" },
        ]);

        if (continueMatch) {
          const continueEl = continueMatch.continueBtn.match;
          const continueRect: ButtonRect = {
            x: continueEl.x,
            y: continueEl.y,
            width: continueEl.width,
            height: continueEl.height,
          };

          buttons.push({
            text: "Click to continue",  // Fixed label - sprite has no text
            start: null,
            bg: continueRect,
            end: null,
            pressed: false, // Updated async via updatePressedStates
            bgColor: (continueEl as any).color ?? DEFAULT_COLOR,
          });
          foundContinueBtn = true;
          continue;
        }
      }

      // Try ACCEPT QUEST button pattern 2 (sprite 60000, 3-part + text)
      // Render order: subid 0 (bg), subid 1 (end), subid 2 (start)
      const acceptMatch2 = parser.searchUIPattern([
        { id: DIALOG_IDS.acceptQuestBg2, ref: "part0" },
        { id: DIALOG_IDS.acceptQuestBg2, ref: "part1" },
        { id: DIALOG_IDS.acceptQuestBg2, ref: "part2" },
        { repeat: [0, 10] },
        { string: "", ref: "btnText" },
      ]);

      if (acceptMatch2) {
        // part0 = subid 0 = background (used for press/brightness detection)
        // part1 = subid 1 = end cap
        // part2 = subid 2 = start cap
        const bgMatch = acceptMatch2.part0.match;
        const bgColor = bgSprites.find(
          s => Math.abs(s.x - bgMatch.x) < 1 && Math.abs(s.y - bgMatch.y) < 1
        )?.color ?? DEFAULT_COLOR;

        const bgRect: ButtonRect = {
          x: bgMatch.x,
          y: bgMatch.y,
          width: bgMatch.width,
          height: bgMatch.height,
        };
        buttons.push({
          text: acceptMatch2.btnText.text,
          start: {
            x: acceptMatch2.part2.match.x,
            y: acceptMatch2.part2.match.y,
            width: acceptMatch2.part2.match.width,
            height: acceptMatch2.part2.match.height,
          },
          bg: bgRect,
          end: {
            x: acceptMatch2.part1.match.x,
            y: acceptMatch2.part1.match.y,
            width: acceptMatch2.part1.match.width,
            height: acceptMatch2.part1.match.height,
          },
          pressed: false,
          bgColor,
        });
        continue;
      }

      // Also try simple pattern: just one 60000 sprite + text (fallback if not 3-part)
      const acceptSimple2 = parser.searchUIPattern([
        { id: DIALOG_IDS.acceptQuestBg2, ref: "btnBg" },
        { repeat: [0, 10] },
        { string: "", ref: "btnText" },
      ]);

      if (acceptSimple2) {
        const bgMatch = acceptSimple2.btnBg.match;
        const bgColor = bgSprites.find(
          s => Math.abs(s.x - bgMatch.x) < 1 && Math.abs(s.y - bgMatch.y) < 1
        )?.color ?? DEFAULT_COLOR;

        const bgRect: ButtonRect = {
          x: bgMatch.x,
          y: bgMatch.y,
          width: bgMatch.width,
          height: bgMatch.height,
        };
        buttons.push({
          text: acceptSimple2.btnText.text,
          start: null,
          bg: bgRect,
          end: null,
          pressed: false,
          bgColor,
        });
        continue;
      }

      // No pattern matched at current position, skip one element and keep searching
      parser.skip(1);
      continue;
    }

    const bgMatch2 = match.btnBg.match;
    const textInfo = match.btnText;

    // Find color from the matching bg sprite
    const bgColor = bgSprites.find(
      s => Math.abs(s.x - bgMatch2.x) < 1 && Math.abs(s.y - bgMatch2.y) < 1
    )?.color ?? DEFAULT_COLOR;

    const bgRect2: ButtonRect = {
      x: bgMatch2.x,
      y: bgMatch2.y,
      width: bgMatch2.width,
      height: bgMatch2.height,
    };
    buttons.push({
      text: textInfo.text,
      start: match.btnStart
        ? {
            x: match.btnStart.match.x,
            y: match.btnStart.match.y,
            width: match.btnStart.match.width,
            height: match.btnStart.match.height,
          }
        : null,
      bg: bgRect2,
      end: match.btnEnd
        ? {
            x: match.btnEnd.match.x,
            y: match.btnEnd.match.y,
            width: match.btnEnd.match.width,
            height: match.btnEnd.match.height,
          }
        : null,
      pressed: false, // Updated async via updatePressedStates
      bgColor,
    });
  }

  // Fallback: position-based matching if pattern matching found nothing
  if (buttons.length === 0 && bgSprites.length > 0) {
    for (const bg of bgSprites) {
      const nearbyText = textElements.find((text) => {
        const inBoundsX = text.x >= bg.x - 20 && text.x <= bg.x + bg.width + 20;
        const inBoundsY =
          text.y >= bg.y - 10 && text.y <= bg.y + bg.height + 10;
        return inBoundsX && inBoundsY;
      });

      const fallbackRect: ButtonRect = { x: bg.x, y: bg.y, width: bg.width, height: bg.height };
      if (nearbyText) {
        buttons.push({
          text: nearbyText.text,
          start: null,
          bg: fallbackRect,
          end: null,
          pressed: false, // Updated async via updatePressedStates
          bgColor: bg.color,
        });
        const idx = textElements.indexOf(nearbyText);
        if (idx !== -1) textElements.splice(idx, 1);
      } else {
        buttons.push({
          text: `[Button at ${bg.x},${bg.y}]`,
          start: null,
          bg: fallbackRect,
          end: null,
          pressed: false, // Updated async via updatePressedStates
          bgColor: bg.color,
        });
      }
    }
  }

  // Build debug info
  const debug: DialogDebugInfo = {
    bgSpritesFound: bgSprites.length,
    textElementsFound: textElements.length,
    totalElements: newstate.elements.length,
  };

  if (buttons.length === 0) {
    // Return null but with debug info available via console for troubleshooting
    // console.log("[DialogBox] No buttons found:", debug);
    return null;
  }

  // Sort buttons by Y position (top to bottom), then X (left to right)
  // Y=0 is at bottom of screen, so higher Y = higher on screen (sort descending)
  buttons.sort((a, b) => {
    if (Math.abs(a.bg.y - b.bg.y) < 10) {
      return a.bg.x - b.bg.x;
    }
    return b.bg.y - a.bg.y;
  });

  // Calculate bounds from all button rectangles
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const btn of buttons) {
    const rects = [btn.bg, btn.start, btn.end].filter(Boolean) as ButtonRect[];
    for (const r of rects) {
      minX = Math.min(minX, r.x);
      minY = Math.min(minY, r.y);
      maxX = Math.max(maxX, r.x + r.width);
      maxY = Math.max(maxY, r.y + r.height);
    }
  }

  // Try to find header text above the buttons (e.g., "Choose an option:")
  let header: string | null = null;
  const topButtonY = buttons[0].bg.y;
  for (const text of textElements) {
    // Header should be above buttons and contain common phrases
    if (text.y < topButtonY && text.y > topButtonY - 50) {
      const lowerText = text.text.toLowerCase();
      if (lowerText.includes("choose") || lowerText.includes("select") ||
          lowerText.includes("option") || lowerText.includes("?") ||
          lowerText.endsWith(":")) {
        header = text.text;
        // Expand bounds to include header
        minY = Math.min(minY, text.y);
        break;
      }
    }
  }

  const bounds: ButtonRect = {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  };

  // Return buttons in UI coordinate space (not screen-scaled)
  // SpriteOverlay now renders to the UI framebuffer, so it needs UI coordinates
  // The overlay will be scaled along with the UI by the Lanczos scaler

  return { buttons, bounds, header, debug };
}
