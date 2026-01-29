/**
 * GL Injection API - Wrapper for alt1gl native addon
 *
 * Provides high-level functions for initializing and managing
 * GL injection into the RuneScape client in Electron mode.
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
 * Get the native GL API client (after injection)
 */
export function getGlClient(): import("@injection/util/patchrs_napi").Alt1GlClient | null {
	return patchrs?.native ?? null;
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
	if (!patchrs?.native) return false;
	try {
		const pids = patchrs.native.debug.getExePids("rs2client.exe");
		return pids.length > 0;
	} catch {
		return false;
	}
}

/**
 * Initialize GL injection - hooks into the first rs2client.exe found
 * Returns true if injection succeeded, false otherwise
 */
export async function initGlInjection(): Promise<boolean> {
	try {
		// Dynamically import the native module
		patchrs = await import("@injection/util/patchrs_napi");

		if (!patchrs.native) {
			console.error("[glInjection] Native addon not loaded");
			return false;
		}

		// Find RS client processes
		const pids = patchrs.native.debug.getExePids("rs2client.exe");
		if (pids.length === 0) {
			console.log("[glInjection] No rs2client.exe process found");
			return false;
		}

		console.log(`[glInjection] Found RS client PIDs: ${pids.join(", ")}`);

		// Inject into first process (usually the main one)
		const result = patchrs.injectClient(pids[0]);
		injectionState = result;

		if (!result.details) {
			console.log("[glInjection] Injection returned null details");
			return false;
		}

		console.log(`[glInjection] Successfully injected into PID ${result.pid}`);
		console.log(`[glInjection] Memory ID: ${result.details.memoryid}, Instance ID: ${result.details.instanceid}`);

		return true;
	} catch (error) {
		console.error("[glInjection] Failed to initialize:", error);
		return false;
	}
}

/**
 * Retry injection - useful if RS client wasn't running on first try
 */
export async function retryGlInjection(): Promise<boolean> {
	console.log("[glInjection] Retrying injection...");
	return initGlInjection();
}

/**
 * Clean up injection (exit DLL)
 */
export async function cleanupGlInjection(): Promise<void> {
	if (!patchrs?.native) return;

	try {
		patchrs.native.debug.exitDll();
		injectionState = null;
		console.log("[glInjection] Cleaned up injection");
	} catch (error) {
		console.error("[glInjection] Failed to cleanup:", error);
	}
}
