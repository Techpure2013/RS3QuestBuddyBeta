/**
 * GL Injection API - Detection wrapper for alt1gl native addon
 *
 * Detects the native GL client provided by Alt1GL-Launcher (globalThis.alt1gl)
 * or Alt1 (window.alt1). No manual injection — the launcher handles everything.
 */

// Import native module to check availability at module load time
import * as patchrsModule from "@injection/util/patchrs_napi";

// Re-export types from patchrs_napi for convenience
export type {
	Alt1GlClient,
	TrackedTexture,
	TextureSnapshot,
	GlProgram,
	GlShaderSource,
	GlUniformMeta,
	GlUniformArgument,
	GlInputMeta,
	PackedTypeInfo,
	RenderInput,
	VertexArraySnapshot,
	RenderRange,
	RenderInvocation,
	GlState,
	RecordRenderOptions,
	RenderFilter,
	RendererInfo,
} from "@injection/util/patchrs_napi";

export interface HookResult {
	pid: number;
	dllname: string;
	details: { memoryid: number; instanceid: number } | null;
}

// Module state
let patchrs: typeof import("@injection/util/patchrs_napi") | null = null;
let injectionState: HookResult | null = null;

/**
 * Check if GL injection is available (native addon loaded)
 * This checks the actual native export from patchrs_napi, which is set at module load time
 */
export function isGlInjectionAvailable(): boolean {
	return patchrsModule.native !== null && patchrsModule.native !== undefined;
}

/**
 * Get the native GL API client
 */
export function getGlClient(): import("@injection/util/patchrs_napi").Alt1GlClient | null {
	return patchrs?.native ?? patchrsModule.native ?? null;
}

/**
 * Get the injection state
 */
export function getInjectionState(): HookResult | null {
	return injectionState;
}

/**
 * Check if RuneScape client is running
 */
export async function isRsClientRunning(): Promise<boolean> {
	const client = patchrs?.native ?? patchrsModule.native;
	if (!client) return false;
	try {
		return !!client.getRsReady();
	} catch {
		return false;
	}
}

/**
 * Initialize GL connection — detects native addon from launcher preload
 * and waits for the RS client to become ready. No manual injection.
 */
export async function initGlInjection(): Promise<boolean> {
	try {
		patchrs = await import("@injection/util/patchrs_napi");

		if (!patchrs.native) {
			console.error("[glInjection] Native addon not loaded");
			return false;
		}

		console.log("[glInjection] Native addon detected, waiting for RS client...");

		// Poll getRsReady() — the launcher has already set up shared memory,
		// but the RS client may need a moment to render its first frame.
		const MAX_WAIT_MS = 30000;
		const POLL_INTERVAL_MS = 500;
		const startTime = Date.now();

		while (Date.now() - startTime < MAX_WAIT_MS) {
			try {
				if (patchrs.native.getRsReady()) {
					console.log("[glInjection] RS client ready");
					injectionState = {
						pid: 0,
						dllname: "preload",
						details: { memoryid: 0, instanceid: 0 },
					};
					return true;
				}
			} catch {
				// getRsReady may throw if not connected yet
			}
			await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
		}

		// Timeout — addon is available but RS client didn't become ready.
		// Still return true so GL features can activate when RS does connect.
		console.warn("[glInjection] RS client not ready after 30s, continuing with addon available");
		injectionState = {
			pid: 0,
			dllname: "preload",
			details: { memoryid: 0, instanceid: 0 },
		};
		return true;
	} catch (error) {
		console.error("[glInjection] Failed to initialize:", error);
		return false;
	}
}

/**
 * Retry initialization
 */
export async function retryGlInjection(): Promise<boolean> {
	console.log("[glInjection] Retrying...");
	return initGlInjection();
}

/**
 * Clean up (no-op since launcher manages the connection)
 */
export async function cleanupGlInjection(): Promise<void> {
	injectionState = null;
	console.log("[glInjection] Cleaned up state");
}
