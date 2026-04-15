import { getProgramMeta } from "../render/renderprogram";
import * as patchrs from "../util/patchrs_napi";

/** UI scaling info for high-DPI monitors */
export interface UIScaleInfo {
    /** Whether UI scaling is active */
    isScaled: boolean;
    /** UI framebuffer width (before scaling) */
    uiWidth: number;
    /** UI framebuffer height (before scaling) */
    uiHeight: number;
    /** Full screen width */
    screenWidth: number;
    /** Full screen height */
    screenHeight: number;
    /** Scale factor (screenWidth / uiWidth) */
    scaleX: number;
    /** Scale factor (screenHeight / uiHeight) */
    scaleY: number;
    /** The texture ID that the Lanczos scaler reads from (0 if not scaled) */
    scalingTextureId: number;
    /** The framebuffer ID where UI is rendered (for pixel capture) */
    uiFramebufferId: number;
}

/** Global UI scale state - updated by renderStream */
export const uiScaleState: UIScaleInfo = {
    isScaled: false,
    uiWidth: 1920,
    uiHeight: 1080,
    screenWidth: 1920,
    screenHeight: 1080,
    scaleX: 1,
    scaleY: 1,
    scalingTextureId: 0,
    uiFramebufferId: -1,
};

/** Adaptive render stream intervals (ms).
 * IDLE: No dialog detected — slow polling to minimize FPS impact.
 * ACTIVE: Dialog detected — fast polling for responsive button highlighting.
 * Each recordRenderCalls stalls the GL pipeline for ~1 frame, so fewer = better FPS. */
const RENDER_STREAM_IDLE_MS = 2000;   // 0.5 checks/sec when no dialog visible
const RENDER_STREAM_ACTIVE_MS = 300;  // 3 checks/sec when dialog is on screen

// TODO make this into a lib function
// turned out slightly more complicated because rs uses a different framebuffer for ui scaling
export function renderStream(glapi: patchrs.Alt1GlClient, cb: (state: patchrs.RenderInvocation[]) => void | boolean) {
    // return glapi.streamRenderCalls(opts, cb);
    let opts: patchrs.RecordRenderOptions = {
        framebufferId: 0,
        // texturesnapshot populates 'samplers' with TextureSnapshot (has texid, width, height)
        // textures populates 'textures' with TrackedTexture (also has texid, width, height)
        features: ["uniforms", "texturesnapshot"]
    }
    // implementation that doesnt pile up calls if the consumer is slow
    let closed = false;
    let scalingtexture = 0;
    let lastScalerSeenFrame = 0;
    let frameCount = 0;
    let dialogActive = false; // Tracks whether a dialog was detected last frame

    // Helper to find the scaling texture from render data
    const findScalingTexture = (renders: patchrs.RenderInvocation[]): number | null => {
        for (let render of renders) {
            let prog = getProgramMeta(render.program);
            if (prog.isUiScaler) {
                // Try multiple possible property names for texture data
                const samplers = render.samplers || (render as any).textures || (render as any).textureBindings || {};
                const sampler = Object.values(samplers)[0] as patchrs.TextureSnapshot | undefined;
                if (sampler) {
                    // Update UI scale state
                    const screenWidth = glapi.getRsWidth() || 1920;
                    const screenHeight = glapi.getRsHeight() || 1080;
                    const uiWidth = sampler.width;
                    const uiHeight = sampler.height;

                    uiScaleState.isScaled = uiWidth !== screenWidth || uiHeight !== screenHeight;
                    uiScaleState.uiWidth = uiWidth;
                    uiScaleState.uiHeight = uiHeight;
                    uiScaleState.screenWidth = screenWidth;
                    uiScaleState.screenHeight = screenHeight;
                    uiScaleState.scaleX = screenWidth / uiWidth;
                    uiScaleState.scaleY = screenHeight / uiHeight;
                    uiScaleState.scalingTextureId = sampler.texid;

                    return sampler.texid;
                }
            }
        }
        return null;
    };

    let res: patchrs.StreamRenderObject = {
        ended: (async () => {
            // Initial scan: Check if we're in scaled mode and find the scaling texture
            // This ensures we capture UI renders from the first frame
            try {
                const initialRenders = await glapi.recordRenderCalls({ maxframes: 1, ...opts });
                try {
                    const foundTexture = findScalingTexture(initialRenders);
                    if (foundTexture !== null) {
                        scalingtexture = foundTexture;
                        lastScalerSeenFrame = 1;
                        console.log(`[renderStream] Initial scan found scaling texture: ${scalingtexture}`);
                    }
                } finally {
                    for (const r of initialRenders) { try { r.dispose?.(); } catch (_) {} }
                }
            } catch (e) {
                console.warn(`[renderStream] Initial scan failed:`, e);
            }

            while (!closed) {
                // When idle (no dialog), skip the expensive UI framebuffer capture on 4K —
                // saves 1 GL pipeline stall per tick. Only capture both when dialog is active.
                let mainrenders = glapi.recordRenderCalls({ maxframes: 1, ...opts });
                let uirenders = (scalingtexture == 0 || !dialogActive ? [] : glapi.recordRenderCalls({ maxframes: 1, ...opts, framebufferId: undefined, framebufferTexture: scalingtexture }));
                let [mainResults, uiResults] = await Promise.all([mainrenders, uirenders]);

                // Extract UI framebuffer ID from UI renders
                if (uiResults.length > 0 && uiScaleState.uiFramebufferId < 0) {
                    const firstUIRender = uiResults[0];
                    if (firstUIRender.framebufferId !== undefined && firstUIRender.framebufferId >= 0) {
                        uiScaleState.uiFramebufferId = firstUIRender.framebufferId;
                    }
                }

                let renders = [...mainResults, ...uiResults];

                frameCount++;
                let foundScaler = false;

                // Check for scaler in main renders
                for (let render of renders) {
                    let prog = getProgramMeta(render.program);
                    if (prog.isUiScaler) {
                        foundScaler = true;
                        lastScalerSeenFrame = frameCount;
                        // Try samplers first (texturesnapshot), then textures as fallback
                        const textureData = render.samplers || render.textures || {};
                        const sampler = Object.values(textureData)[0] as patchrs.TextureSnapshot | patchrs.TrackedTexture | undefined;
                        if (!sampler) continue;

                        // If texture changed, update it
                        if (sampler.texid !== scalingtexture) {
                            scalingtexture = sampler.texid;
                        }

                        // Update UI scale state
                        const screenWidth = glapi.getRsWidth() || 1920;
                        const screenHeight = glapi.getRsHeight() || 1080;
                        const uiWidth = sampler.width;
                        const uiHeight = sampler.height;

                        uiScaleState.isScaled = uiWidth !== screenWidth || uiHeight !== screenHeight;
                        uiScaleState.uiWidth = uiWidth;
                        uiScaleState.uiHeight = uiHeight;
                        uiScaleState.screenWidth = screenWidth;
                        uiScaleState.screenHeight = screenHeight;
                        uiScaleState.scaleX = screenWidth / uiWidth;
                        uiScaleState.scaleY = screenHeight / uiHeight;
                        uiScaleState.scalingTextureId = sampler.texid;
                    }
                }

                // If no UI scaler found for several frames, reset to no scaling
                // This handles moving to a non-scaled monitor
                if (!foundScaler && frameCount - lastScalerSeenFrame > 5) {
                    const screenWidth = glapi.getRsWidth() || 1920;
                    const screenHeight = glapi.getRsHeight() || 1080;

                    // Only update if screen size changed or we were previously scaled
                    if (uiScaleState.isScaled ||
                        uiScaleState.screenWidth !== screenWidth ||
                        uiScaleState.screenHeight !== screenHeight) {
                        uiScaleState.isScaled = false;
                        uiScaleState.uiWidth = screenWidth;
                        uiScaleState.uiHeight = screenHeight;
                        uiScaleState.screenWidth = screenWidth;
                        uiScaleState.screenHeight = screenHeight;
                        uiScaleState.scaleX = 1;
                        uiScaleState.scaleY = 1;
                        uiScaleState.scalingTextureId = 0;
                        // Reset the scaling texture since we're no longer scaled
                        scalingtexture = 0;
                    }
                }

                try {
                    // Callback can return true to signal dialog was detected (enables fast polling)
                    const result = cb(renders);
                    dialogActive = result === true;
                } finally {
                    // Dispose all render invocations to free native GPU shared memory.
                    // MUST happen after cb() completes — the callback processes renders synchronously.
                    for (const r of renders) { try { r.dispose?.(); } catch (_) {} }
                }

                // Adaptive throttle: fast when dialog detected, slow when idle.
                // Each recordRenderCalls stalls the GL pipeline for ~1 frame.
                // In idle mode (no dialog), 2s interval = negligible FPS impact.
                const interval = dialogActive ? RENDER_STREAM_ACTIVE_MS : RENDER_STREAM_IDLE_MS;
                await new Promise(resolve => setTimeout(resolve, interval));
            }
        })(),
        close: async () => {
            closed = true;
        }
    };
    return res;
}
