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

// TODO make this into a lib function
// turned out slightly more complicated because rs uses a different framebuffer for ui scaling
export function renderStream(glapi: patchrs.Alt1GlClient, cb: (state: patchrs.RenderInvocation[]) => void) {
    // return glapi.streamRenderCalls(opts, cb);
    let opts: patchrs.RecordRenderOptions = {
        framebufferId: 0,
        // texturesnapshot populates 'samplers' with TextureSnapshot (has texid, width, height)
        // textures populates 'textures' with TrackedTexture (also has texid, width, height)
        features: ["vertexarray", "uniforms", "textures", "texturesnapshot"]
    }
    // implementation that doesnt pile up calls if the consumer is slow
    let closed = false;
    let scalingtexture = 0;
    let lastScalerSeenFrame = 0;
    let frameCount = 0;

    // Helper to find the scaling texture from render data
    const findScalingTexture = (renders: patchrs.RenderInvocation[]): number | null => {
        console.log(`[renderStream] Scanning ${renders.length} renders for UI scaler...`);

        // Log program types for debugging
        const progTypes: string[] = [];
        for (let render of renders) {
            let prog = getProgramMeta(render.program);
            if (prog.isUiScaler) {
                progTypes.push('UiScaler');
            } else if (prog.isUi) {
                progTypes.push('Ui');
            }
        }
        console.log(`[renderStream] Program types found: ${progTypes.join(', ') || 'none matching (total: ' + renders.length + ')'}`);

        for (let render of renders) {
            let prog = getProgramMeta(render.program);
            if (prog.isUiScaler) {
                // Debug: log full render object structure
                console.log(`[renderStream] UiScaler render keys:`, Object.keys(render));
                console.log(`[renderStream] UiScaler render.samplers:`, render.samplers);
                console.log(`[renderStream] UiScaler render.textures:`, (render as any).textures);
                console.log(`[renderStream] UiScaler render.textureBindings:`, (render as any).textureBindings);

                // Try multiple possible property names for texture data
                const samplers = render.samplers || (render as any).textures || (render as any).textureBindings || {};
                console.log(`[renderStream] Found UiScaler program, samplers:`, Object.keys(samplers));
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

                    console.log(`[renderStream] Found UI scaler: texture ${sampler.texid}, UI ${uiWidth}x${uiHeight}, screen ${screenWidth}x${screenHeight}`);
                    return sampler.texid;
                } else {
                    console.log(`[renderStream] UiScaler has no sampler data`);
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
                const foundTexture = findScalingTexture(initialRenders);
                if (foundTexture !== null) {
                    scalingtexture = foundTexture;
                    lastScalerSeenFrame = 1;
                    console.log(`[renderStream] Initial scan found scaling texture: ${scalingtexture}`);
                }
            } catch (e) {
                console.warn(`[renderStream] Initial scan failed:`, e);
            }

            while (!closed) {
                let mainrenders = glapi.recordRenderCalls({ maxframes: 1, ...opts });
                let uirenders = (scalingtexture == 0 ? [] : glapi.recordRenderCalls({ maxframes: 1, ...opts, framebufferId: undefined, framebufferTexture: scalingtexture }));
                let [mainResults, uiResults] = await Promise.all([mainrenders, uirenders]);

                // Extract UI framebuffer ID from UI renders
                if (uiResults.length > 0 && uiScaleState.uiFramebufferId < 0) {
                    const firstUIRender = uiResults[0];
                    if (firstUIRender.framebufferId !== undefined && firstUIRender.framebufferId >= 0) {
                        uiScaleState.uiFramebufferId = firstUIRender.framebufferId;
                        console.log(`[renderStream] Found UI framebuffer ID: ${uiScaleState.uiFramebufferId}`);
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
                            console.log(`[renderStream] Scaling texture changed: ${scalingtexture} -> ${sampler.texid}`);
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
                        console.log(`[renderStream] No scaler for ${frameCount - lastScalerSeenFrame} frames, resetting to native`);
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

                cb(renders);
            }
        })(),
        close: async () => {
            closed = true;
        }
    };
    return res;
}
