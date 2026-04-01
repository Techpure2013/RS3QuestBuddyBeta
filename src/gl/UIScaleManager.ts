/**
 * UIScaleManager - Centralized UI scaling detection and management
 *
 * Automatically detects UI scaling on high-DPI monitors (e.g., 4K) and
 * notifies components when resolution changes.
 *
 * RS3 renders UI at a lower resolution on high-DPI monitors and scales it up.
 * This module detects that scaling and provides the scale factors to other components.
 */


// UI scale state - mirrors the structure in DialogBoxReader/util.ts
export interface UIScaleInfo {
  isScaled: boolean;
  uiWidth: number;
  uiHeight: number;
  screenWidth: number;
  screenHeight: number;
  scaleX: number;
  scaleY: number;
}

/** Minimum valid game resolution — anything smaller is a loading screen artifact (e.g. 128x128) */
const MIN_VALID_RESOLUTION = 640;

// Global state
let state: {
  initialized: boolean;
  patchrs: typeof import("@injection/util/patchrs_napi") | null;
  stream: { close: () => Promise<void> } | null;
  scaleInfo: UIScaleInfo;
  lastScreenWidth: number;
  lastScreenHeight: number;
  onResolutionChange: Array<(info: UIScaleInfo) => void>;
} = {
  initialized: false,
  patchrs: null,
  stream: null,
  scaleInfo: {
    isScaled: false,
    uiWidth: 1920,
    uiHeight: 1080,
    screenWidth: 1920,
    screenHeight: 1080,
    scaleX: 1,
    scaleY: 1,
  },
  lastScreenWidth: 1920,
  lastScreenHeight: 1080,
  onResolutionChange: [],
};

/**
 * Calculate assumed UI dimensions for high-DPI screens
 * RS3 typically renders UI at ~1920 width and scales up
 */
function calculateAssumedUISize(screenWidth: number, screenHeight: number): { uiWidth: number; uiHeight: number } {
  // RS3 renders UI at roughly 1920 width, maintaining aspect ratio
  const uiWidth = 1920;
  const uiHeight = Math.round(screenHeight * (1920 / screenWidth));
  return { uiWidth, uiHeight };
}

/**
 * Detect viewport dimensions from render data
 * This is the most reliable way to get actual rendering dimensions
 */
async function detectViewportFromRenders(): Promise<{ width: number; height: number } | null> {
  if (!state.patchrs?.native) return null;

  let renders: any[] = [];
  try {
    renders = await state.patchrs.native.recordRenderCalls({
      maxframes: 1,
      features: [],
    });

    const viewport = renders.find(r => r.viewport)?.viewport;
    if (viewport) {
      return { width: viewport.width, height: viewport.height };
    }

    return null;
  } catch (e) {
    console.warn(`[UIScaleManager] Viewport detection failed:`, e);
    return null;
  } finally {
    for (const r of renders) {
      try { r.dispose?.()?.catch?.(() => {}); } catch (_) {}
    }
  }
}

/**
 * Detect DPI scaling by finding the Lanczos scaler
 * Returns actual UI dimensions if scaler is found, null otherwise
 */
async function detectDPIScaling(): Promise<{
  screenWidth: number;
  screenHeight: number;
  uiWidth: number;
  uiHeight: number;
} | null> {
  if (!state.patchrs?.native) return null;

  let renders: any[] = [];
  try {
    const { getProgramMeta } = await import("@injection/render/renderprogram");

    renders = await state.patchrs.native.recordRenderCalls({
      maxframes: 1,
      features: ["texturesnapshot"],
      framebufferId: 0,
    });

    const viewport = renders.find(r => r.viewport)?.viewport;
    const screenWidth = viewport?.width || state.patchrs.native.getRsWidth() || 1920;
    const screenHeight = viewport?.height || state.patchrs.native.getRsHeight() || 1080;

    // Find the Lanczos scaler
    for (const render of renders) {
      const prog = getProgramMeta(render.program);
      if (prog.isUiScaler) {
        const samplers = render.samplers || (render as any).textures || {};
        const sampler = Object.values(samplers)[0] as { width: number; height: number } | undefined;
        if (sampler && (sampler.width !== screenWidth || sampler.height !== screenHeight)) {
          return { screenWidth, screenHeight, uiWidth: sampler.width, uiHeight: sampler.height };
        }
      }
    }
    return null;
  } catch (e) {
    console.warn("[UIScaleManager] DPI detection failed:", e);
    return null;
  } finally {
    for (const r of renders) {
      try { r.dispose?.()?.catch?.(() => {}); } catch (_) {}
    }
  }
}

/**
 * Initialize the UI scale manager
 * Starts monitoring for UI scale changes
 */
export async function initUIScaleManager(): Promise<boolean> {
  if (state.initialized) return true;

  try {
    state.patchrs = await import("@injection/util/patchrs_napi");
    if (!state.patchrs.native) {
      console.warn("[UIScaleManager] Native addon not available");
      return false;
    }

    // Get initial screen dimensions
    state.lastScreenWidth = state.patchrs.native.getRsWidth() || 1920;
    state.lastScreenHeight = state.patchrs.native.getRsHeight() || 1080;
    state.scaleInfo.screenWidth = state.lastScreenWidth;
    state.scaleInfo.screenHeight = state.lastScreenHeight;

    // Try to get viewport dimensions from render data (most reliable)
    const viewport = await detectViewportFromRenders();
    if (viewport) {
      state.lastScreenWidth = viewport.width;
      state.lastScreenHeight = viewport.height;
      state.scaleInfo.screenWidth = viewport.width;
      state.scaleInfo.screenHeight = viewport.height;
    }

    // Determine if UI scaling is active based on resolution
    // At 4K (> 2560 width), RS3 scales UI to ~1920 width
    if (state.lastScreenWidth > 2560) {
      const { uiWidth, uiHeight } = calculateAssumedUISize(state.lastScreenWidth, state.lastScreenHeight);
      state.scaleInfo.isScaled = true;
      state.scaleInfo.uiWidth = uiWidth;
      state.scaleInfo.uiHeight = uiHeight;
      state.scaleInfo.scaleX = state.lastScreenWidth / uiWidth;
      state.scaleInfo.scaleY = state.lastScreenHeight / uiHeight;
    } else {
      // Non-4K: check for DPI scaling (e.g., 125%)
      const dpiInfo = await detectDPIScaling();
      if (dpiInfo) {
        state.scaleInfo.isScaled = true;
        state.scaleInfo.screenWidth = dpiInfo.screenWidth;
        state.scaleInfo.screenHeight = dpiInfo.screenHeight;
        state.scaleInfo.uiWidth = dpiInfo.uiWidth;
        state.scaleInfo.uiHeight = dpiInfo.uiHeight;
        state.scaleInfo.scaleX = dpiInfo.screenWidth / dpiInfo.uiWidth;
        state.scaleInfo.scaleY = dpiInfo.screenHeight / dpiInfo.uiHeight;
        state.lastScreenWidth = dpiInfo.screenWidth;
        state.lastScreenHeight = dpiInfo.screenHeight;
      } else {
        // No scaling detected
        state.scaleInfo.isScaled = false;
        state.scaleInfo.uiWidth = state.lastScreenWidth;
        state.scaleInfo.uiHeight = state.lastScreenHeight;
        state.scaleInfo.scaleX = 1;
        state.scaleInfo.scaleY = 1;
      }
    }

    // Notify listeners of initial state
    notifyResolutionChange();

    // Start monitoring for scale changes
    startScaleMonitoring();

    state.initialized = true;
    return true;
  } catch (e) {
    console.error("[UIScaleManager] Failed to initialize:", e);
    return false;
  }
}

/**
 * Start monitoring for resolution changes
 * Uses viewport detection for reliable resolution tracking
 */
function startScaleMonitoring(): void {
  if (state.stream || !state.patchrs?.native) return;

  // Monitor for resolution changes every 2 seconds
  const monitorScale = async () => {
    while (state.stream !== null && state.patchrs?.native) {
      let renders: any[] = [];
      try {
        // Get viewport from render data (most reliable)
        renders = await state.patchrs.native.recordRenderCalls({
          maxframes: 1,
          features: [],
        });

        const viewport = renders.find(r => r.viewport)?.viewport;
        const currentWidth = viewport?.width || state.patchrs.native.getRsWidth() || 1920;
        const currentHeight = viewport?.height || state.patchrs.native.getRsHeight() || 1080;

        // Detect resolution change with stability check
        if (currentWidth !== state.lastScreenWidth || currentHeight !== state.lastScreenHeight) {
          // Wait 500ms and re-check to filter transient changes (e.g., teleport animations)
          await new Promise(resolve => setTimeout(resolve, 500));

          let confirmRenders: any[] = [];
          try {
            confirmRenders = await state.patchrs.native.recordRenderCalls({
              maxframes: 1,
              features: [],
            });
            const confirmViewport = confirmRenders.find(r => r.viewport)?.viewport;
            const confirmWidth = confirmViewport?.width || state.patchrs.native.getRsWidth() || 1920;
            const confirmHeight = confirmViewport?.height || state.patchrs.native.getRsHeight() || 1080;

            // Only broadcast if resolution is still the same as the first detection
            // (filters out transient viewport changes from teleport/loading animations)
            if (confirmWidth !== state.lastScreenWidth || confirmHeight !== state.lastScreenHeight) {
              // Reject obviously invalid resolutions — RS3 loading screens use tiny viewports (e.g. 128x128)
              if (confirmWidth >= MIN_VALID_RESOLUTION && confirmHeight >= MIN_VALID_RESOLUTION) {
                state.lastScreenWidth = confirmWidth;
                state.lastScreenHeight = confirmHeight;
                state.scaleInfo.screenWidth = confirmWidth;
                state.scaleInfo.screenHeight = confirmHeight;

                // Update scale info based on resolution
                if (confirmWidth > 2560) {
                  const { uiWidth, uiHeight } = calculateAssumedUISize(confirmWidth, confirmHeight);
                  state.scaleInfo.isScaled = true;
                  state.scaleInfo.uiWidth = uiWidth;
                  state.scaleInfo.uiHeight = uiHeight;
                  state.scaleInfo.scaleX = confirmWidth / uiWidth;
                  state.scaleInfo.scaleY = confirmHeight / uiHeight;
                } else {
                  // Non-4K: check for DPI scaling
                  const dpiInfo = await detectDPIScaling();
                  if (dpiInfo) {
                    state.scaleInfo.isScaled = true;
                    state.scaleInfo.screenWidth = dpiInfo.screenWidth;
                    state.scaleInfo.screenHeight = dpiInfo.screenHeight;
                    state.scaleInfo.uiWidth = dpiInfo.uiWidth;
                    state.scaleInfo.uiHeight = dpiInfo.uiHeight;
                    state.scaleInfo.scaleX = dpiInfo.screenWidth / dpiInfo.uiWidth;
                    state.scaleInfo.scaleY = dpiInfo.screenHeight / dpiInfo.uiHeight;
                  } else {
                    state.scaleInfo.isScaled = false;
                    state.scaleInfo.uiWidth = confirmWidth;
                    state.scaleInfo.uiHeight = confirmHeight;
                    state.scaleInfo.scaleX = 1;
                    state.scaleInfo.scaleY = 1;
                  }
                }

                notifyResolutionChange();
              }
            }
          } finally {
            for (const r of confirmRenders) {
              try { r.dispose?.()?.catch?.(() => {}); } catch (_) {}
            }
          }
        }

        // Wait before next check (2 seconds)
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (e: any) {
        if (!e?.message?.includes("No rs process")) {
          console.warn("[UIScaleManager] Monitoring error:", e);
        }
        await new Promise(resolve => setTimeout(resolve, 5000));
      } finally {
        for (const r of renders) {
          try { r.dispose?.()?.catch?.(() => {}); } catch (_) {}
        }
      }
    }
  };

  // Create stream handle
  state.stream = {
    close: async () => {
      state.stream = null;
    }
  };

  // Start monitoring loop
  monitorScale();
}

/**
 * Notify all listeners of resolution/scale change
 */
function notifyResolutionChange(): void {
  // Update the DialogBoxReader's uiScaleState
  updateDialogBoxReaderScale();

  // Update spriteOverlay scale state
  updateSpriteOverlayScale();

  // Notify other listeners
  for (const listener of state.onResolutionChange) {
    try {
      listener({ ...state.scaleInfo });
    } catch (e) {
      // Ignore listener errors
    }
  }
}

/**
 * Update the DialogBoxReader's uiScaleState
 */
async function updateDialogBoxReaderScale(): Promise<void> {
  try {
    const util = await import("@injection/DialogBoxReader/util");
    // Directly update the exported uiScaleState object
    util.uiScaleState.isScaled = state.scaleInfo.isScaled;
    util.uiScaleState.uiWidth = state.scaleInfo.uiWidth;
    util.uiScaleState.uiHeight = state.scaleInfo.uiHeight;
    util.uiScaleState.screenWidth = state.scaleInfo.screenWidth;
    util.uiScaleState.screenHeight = state.scaleInfo.screenHeight;
    util.uiScaleState.scaleX = state.scaleInfo.scaleX;
    util.uiScaleState.scaleY = state.scaleInfo.scaleY;
  } catch (e) {
    // Module may not be loaded
  }
}

/**
 * Update spriteOverlay's UI scale state
 */
async function updateSpriteOverlayScale(): Promise<void> {
  try {
    const spriteOverlay = await import("@injection/util/spriteOverlay");
    // Get the scaling texture ID from DialogBoxReader's uiScaleState
    // This is where renderStream stores it after detecting the Lanczos scaler
    let scalingTextureId = 0;
    try {
      const util = await import("@injection/DialogBoxReader/util");
      scalingTextureId = util.uiScaleState.scalingTextureId;
    } catch {
      // util module may not be loaded
    }

    spriteOverlay.setUIScaleState({
      scaleX: state.scaleInfo.scaleX,
      scaleY: state.scaleInfo.scaleY,
      isScaled: state.scaleInfo.isScaled,
      uiWidth: state.scaleInfo.uiWidth,
      uiHeight: state.scaleInfo.uiHeight,
      scalingTextureId,
    });
  } catch (e) {
    // Module may not be loaded
  }
}

/**
 * Stop the UI scale manager
 */
export async function stopUIScaleManager(): Promise<void> {
  if (state.stream) {
    await state.stream.close();
    state.stream = null;
  }
  state.initialized = false;
}

/**
 * Get current UI scale info
 */
export function getUIScaleInfo(): Readonly<UIScaleInfo> {
  return { ...state.scaleInfo };
}

/**
 * Get current screen dimensions
 */
export function getScreenDimensions(): { width: number; height: number } {
  return {
    width: state.scaleInfo.screenWidth,
    height: state.scaleInfo.screenHeight,
  };
}

/**
 * Register a callback for resolution/scale changes
 */
export function onResolutionChange(callback: (info: UIScaleInfo) => void): () => void {
  state.onResolutionChange.push(callback);
  return () => {
    const idx = state.onResolutionChange.indexOf(callback);
    if (idx !== -1) {
      state.onResolutionChange.splice(idx, 1);
    }
  };
}

/**
 * Check if UI is scaled (high-DPI mode)
 */
export function isUIScaled(): boolean {
  return state.scaleInfo.isScaled;
}

/**
 * Check if manager is initialized
 */
export function isUIScaleManagerInitialized(): boolean {
  return state.initialized;
}
