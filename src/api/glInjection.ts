/**
 * GL Injection API - Wrapper for alt1gl native addon
 *
 * Provides high-level functions for initializing and managing
 * GL injection into the RuneScape client.
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

		// Check if already connected (e.g., launcher preload already set up globalThis.alt1gl)
		try {
			if (patchrs.native.getRsReady()) {
				console.log("[glInjection] Already connected to RS client (via launcher preload)");
				injectionState = {
					pid: 0, // PID not known from preload path
					dllname: "preload",
					details: { memoryid: 0, instanceid: 0 },
				};
				return true;
			}
		} catch (e) {
			// getRsReady may throw if not connected yet - that's fine
		}

		// Find RS client processes
		const pids = patchrs.native.debug.getExePids("rs2client.exe");
		if (pids.length === 0) {
			console.log("[glInjection] No rs2client.exe process found");
			return false;
		}

		console.log(`[glInjection] Found RS client PIDs: ${pids.join(", ")}`);

		// Check if the launcher's overlay is already managing this RS client.
		// The overlay DLL creates a marker file in %TEMP% when it initializes.
		// If this file exists, re-injecting would cause GL hook conflicts and crash.
		const targetPid = pids[0];
		try {
			const fs = require("fs");
			const os = require("os");
			const path = require("path");
			const markerPath = path.join(os.tmpdir(), `alt1gl-active-${targetPid}`);
			console.log(`[glInjection] Checking for injection marker: ${markerPath}`);
			if (fs.existsSync(markerPath)) {
				console.log(`[glInjection] Injection marker found for PID ${targetPid} - launcher overlay is already active`);

				// Read the overlay DLL path from the marker file.
				// The overlay writes its own DLL path so we can pass it to injectDll
				// to connect to existing shared memory without loading a second DLL.
				let overlayDllPath = "";
				try {
					overlayDllPath = fs.readFileSync(markerPath, "utf-8").trim();
				} catch (e) {
					console.log("[glInjection] Could not read DLL path from marker file:", e);
				}

				if (overlayDllPath && overlayDllPath.length > 0) {
					console.log(`[glInjection] Overlay DLL path from marker: ${overlayDllPath}`);
					console.log("[glInjection] Connecting to existing shared memory session...");

					// Call injectDll directly with the overlay DLL path.
					// Since this DLL is already loaded in the target process,
					// LoadLibrary just increments the ref count and injectDll
					// connects us to the existing shared memory.
					try {
						const res = patchrs.native.debug.injectDll(targetPid, overlayDllPath);
						injectionState = {
							pid: targetPid,
							dllname: overlayDllPath,
							details: res,
						};

						if (res) {
							console.log(`[glInjection] Connected to launcher overlay session for PID ${targetPid}`);
							console.log(`[glInjection] Memory ID: ${res.memoryid}, Instance ID: ${res.instanceid}`);
							return true;
						} else {
							console.log("[glInjection] injectDll returned null - failed to connect");
							return false;
						}
					} catch (error) {
						console.error("[glInjection] Error connecting to launcher overlay session:", error);
						return false;
					}
				} else {
					console.log("[glInjection] Marker file empty (old format) - falling through to standard injection");
				}
			}
			console.log("[glInjection] No injection marker found, proceeding with injection");
		} catch (e) {
			console.log("[glInjection] Marker check error:", e);
		}

		// Inject into first process (usually the main one)
		const result = patchrs.injectClient(targetPid);
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
