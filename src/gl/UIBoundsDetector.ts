/**
 * UIBoundsDetector - Captures RS3 screen for UI positioning
 *
 * Provides screenshot capture functionality to show the actual game UI
 * in the position editor preview.
 */

import * as patchrs from "@injection/util/patchrs_napi";

export interface ScreenCapture {
  imageData: ImageData;
  width: number;
  height: number;
  capturedAt: number;
}

// Keep old interface for compatibility (but won't be used)
export interface UIBounds {
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
}

export interface UIBoundsResult {
  screenWidth: number;
  screenHeight: number;
  components: UIBounds[];
  detectedAt: number;
  // New: actual screenshot
  screenshot?: ScreenCapture;
}

// Singleton state
let state: {
  initialized: boolean;
  lastCapture: ScreenCapture | null;
} = {
  initialized: false,
  lastCapture: null,
};

/**
 * Initialize the screen capture system
 */
export async function initUIBoundsDetector(): Promise<boolean> {
  if (state.initialized) return true;

  try {
    // Just check if patchrs.native is available
    if (!patchrs.native) {
      console.warn("[UIBoundsDetector] Native addon not available");
      return false;
    }
    state.initialized = true;
    return true;
  } catch (e) {
    console.error("[UIBoundsDetector] Failed to initialize:", e);
    return false;
  }
}

/**
 * Capture screenshot of RS3 game window
 * Uses patchrs.native.capture(-1, 0, 0, -1, -1) to capture full framebuffer
 */
export async function captureScreen(): Promise<ScreenCapture | null> {
  if (!state.initialized || !patchrs.native) {
    return null;
  }

  try {
    // Capture full framebuffer: id=-1 means framebuffer, -1 for width/height means full size
    const imageData = await patchrs.native.capture(-1, 0, 0, -1, -1);

    if (!imageData || !imageData.width || !imageData.height) {
      return null;
    }

    const capture: ScreenCapture = {
      imageData,
      width: imageData.width,
      height: imageData.height,
      capturedAt: Date.now(),
    };

    state.lastCapture = capture;
    return capture;
  } catch (e: any) {
    if (!e?.message?.includes("No rs process")) {
      console.error("[UIBoundsDetector] Capture error:", e);
    }
    return null;
  }
}

/**
 * Detect UI bounds - now just captures a screenshot
 * Returns screenshot in the result for display
 */
export async function detectUIBounds(): Promise<UIBoundsResult | null> {
  const screenshot = await captureScreen();

  if (!screenshot) {
    return null;
  }

  return {
    screenWidth: screenshot.width,
    screenHeight: screenshot.height,
    components: [], // No longer detecting components
    detectedAt: screenshot.capturedAt,
    screenshot,
  };
}

/**
 * Get the last captured screenshot
 */
export function getLastCapture(): ScreenCapture | null {
  return state.lastCapture;
}

/**
 * Check if detector is initialized
 */
export function isUIBoundsDetectorInitialized(): boolean {
  return state.initialized;
}
