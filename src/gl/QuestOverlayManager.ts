/**
 * QuestOverlayManager - Manages NPC and Object overlays for quest steps
 *
 * Handles:
 * - NPC highlighting via buffer_hash using arrowByBufferHash()
 * - Continuous scanning for NPCs that come into view
 * - NPC wander radius visualization (terrain-aware)
 * - Object tile path markers (terrain-aware)
 */

import { getAllNpcHashes } from "../api/npcApi";
import type { QuestStep, NpcHighlight, ObjectHighlight } from "../state/types";
import type { GlOverlay } from "@injection/util/patchrs_napi";
import { drawNpcCompassRoseAtLocation, drawNpcCompassRoseAttached, drawNpcCompassRoseOnFloor, clearAllCompassRoses, invalidateCompassAnchorVao } from "./CompassRoseOverlay";
import { initUIScaleManager, onResolutionChange, type UIScaleInfo } from "./UIScaleManager";
import { getPlayerPosition } from "./PlayerPositionTracker";
import { MinimapDirectionOverlay, initMinimapDirectionOverlay } from "./MinimapDirectionOverlay";
import { HudCompassOverlay, initHudCompassOverlay } from "./HudCompassOverlay";

// Import types
// NPC arrows use GlOverlay directly (from patchrs), while wander-radius and object-tile
// use TileOverlayManager's internal ID system (number)
interface OverlayHandle {
	id: GlOverlay | number;
	type: "npc-arrow" | "wander-radius" | "object-tile";
	npcId?: number; // NPC database ID
	npcHash?: string; // Hash that was matched
	// Tracking for VAO-attached overlays
	attachmentType?: "vao" | "static";
	vaoId?: number;
	framebufferId?: number;
	npcInfo?: NpcHighlight; // Full NPC info for fallback creation
	lastSeen?: number; // Timestamp when VAO was last rendered
}

// Tile overlay manager (lazy loaded)
let tileOverlayManager: typeof import("@injection/overlays/TileOverlayManager") | null = null;

interface QuestOverlayState {
	isActive: boolean;
	currentStep: QuestStep | null;
	activeOverlays: OverlayHandle[];
	npcOverlay: any | null;
	patchrs: any | null;
	pendingNpcs: NpcHighlight[];
	pendingWanderNpcs: NpcHighlight[];  // NPCs whose wander radius wasn't visible
	pendingObjects: ObjectHighlight[];  // Objects whose tiles weren't visible
	scanInterval: ReturnType<typeof setInterval> | null;
	visibilityMonitorInterval: ReturnType<typeof setInterval> | null; // Monitor VAO-attached overlays
	proximityMonitorInterval: ReturnType<typeof setInterval> | null; // Monitor player proximity to static overlays
	onNpcFound?: (npcName: string) => void;
	compassOverlayEnabled: boolean;
	// Minimap overlay split into arrow (very taxing) and marker (light)
	minimapArrowEnabled: boolean;
	minimapMarkerEnabled: boolean;
	minimapOverlay: MinimapDirectionOverlay | null; // Minimap direction overlay instance
	hudCompassEnabled: boolean; // Enable HUD compass direction indicator
	hudCompassOverlay: HudCompassOverlay | null; // HUD compass overlay instance
	resolutionChangeCleanup: (() => void) | null; // Cleanup function for resolution change listener
}

// How long before an NPC is considered "out of view" (5 seconds)
const NPC_VISIBILITY_TIMEOUT = 5000;
// How often to check NPC visibility (2 seconds)
const VISIBILITY_CHECK_INTERVAL = 2000;
// How often to check player proximity to static overlays (3 seconds)
const PROXIMITY_CHECK_INTERVAL = 3000;
// Distance in tiles to trigger NPC scan when player approaches wander radius
const PROXIMITY_SCAN_DISTANCE = 30;

let state: QuestOverlayState = {
	isActive: false,
	currentStep: null,
	activeOverlays: [],
	npcOverlay: null,
	patchrs: null,
	pendingNpcs: [],
	pendingWanderNpcs: [],
	pendingObjects: [],
	scanInterval: null,
	visibilityMonitorInterval: null,
	proximityMonitorInterval: null,
	compassOverlayEnabled: false,
	minimapArrowEnabled: false, // Very taxing - off by default
	minimapMarkerEnabled: true, // Light - on by default
	minimapOverlay: null,
	hudCompassEnabled: false, // Disable by default (user opt-in)
	hudCompassOverlay: null,
	resolutionChangeCleanup: null,
};

// Cache for NPC hashes - keyed by NPC database ID
const npcHashCache = new Map<number, string[]>();
// Cache for object hashes - keyed by object database ID
const objectHashCache = new Map<number, string[]>();

// Type for quest structure in prefetch
type PrefetchQuest = {
	questSteps?: Array<{
		highlights?: {
			npc?: Array<{ id?: number; buffer_hash?: string; buffer_hash_variants?: string[] }>;
			object?: Array<{ id?: number; buffer_hash?: string; buffer_hash_variants?: string[] }>;
		};
		// Legacy format support
		npcs?: Array<{ id?: number; buffer_hash?: string; buffer_hash_variants?: string[] }>;
		objects?: Array<{ id?: number; buffer_hash?: string; buffer_hash_variants?: string[] }>;
	}>;
};

/**
 * Prefetch all NPC and object hashes for a quest and enrich the bundle with them
 * Fetches missing hashes from server and adds them directly to the NPC/object records
 */
export async function prefetchQuestNpcHashes(quest: PrefetchQuest): Promise<void> {
	if (!quest.questSteps) return;

	// Collect unique NPC and object IDs that need hashes fetched
	const npcIdsToFetch = new Set<number>();
	const objectIdsToFetch = new Set<number>();

	for (const step of quest.questSteps) {
		// Support both highlights.npc format and legacy npcs format
		const npcs = step.highlights?.npc || step.npcs || [];
		const objects = step.highlights?.object || step.objects || [];

		for (const npc of npcs) {
			if (npc.id && !npc.buffer_hash && !npcHashCache.has(npc.id)) {
				npcIdsToFetch.add(npc.id);
			}
		}

		for (const obj of objects) {
			if (obj.id && !obj.buffer_hash && !objectHashCache.has(obj.id)) {
				objectIdsToFetch.add(obj.id);
			}
		}
	}

	// Fetch hashes for NPCs that don't have them
	if (npcIdsToFetch.size > 0) {
		const fetchPromises = Array.from(npcIdsToFetch).map(async (id) => {
			try {
				const hashes = await getAllNpcHashes(id);
				if (hashes.length > 0) {
					npcHashCache.set(id, hashes);
				}
			} catch (e) {
				console.warn(`[QuestOverlay] Failed to fetch hashes for NPC ID ${id}:`, e);
			}
		});

		await Promise.all(fetchPromises);
	}

	// Enrich the bundle: add fetched hashes to all NPC and object records
	for (const step of quest.questSteps) {
		const npcs = step.highlights?.npc || step.npcs || [];
		const objects = step.highlights?.object || step.objects || [];

		for (const npc of npcs) {
			if (!npc.id) continue;

			// If NPC already has a hash, just cache it
			if (npc.buffer_hash) {
				if (!npcHashCache.has(npc.id)) {
					const hashes = [npc.buffer_hash];
					if (npc.buffer_hash_variants) hashes.push(...npc.buffer_hash_variants);
					npcHashCache.set(npc.id, hashes);
				}
				continue;
			}

			// Add fetched hashes to the NPC object
			const cachedHashes = npcHashCache.get(npc.id);
			if (cachedHashes && cachedHashes.length > 0) {
				npc.buffer_hash = cachedHashes[0];
				if (cachedHashes.length > 1) {
					npc.buffer_hash_variants = cachedHashes.slice(1);
				}
			}
		}

		for (const obj of objects) {
			if (!obj.id) continue;

			// If object already has a hash, just cache it
			if (obj.buffer_hash) {
				if (!objectHashCache.has(obj.id)) {
					const hashes = [obj.buffer_hash];
					if (obj.buffer_hash_variants) hashes.push(...obj.buffer_hash_variants);
					objectHashCache.set(obj.id, hashes);
				}
				continue;
			}

			// Add fetched hashes to the object
			const cachedHashes = objectHashCache.get(obj.id);
			if (cachedHashes && cachedHashes.length > 0) {
				obj.buffer_hash = cachedHashes[0];
				if (cachedHashes.length > 1) {
					obj.buffer_hash_variants = cachedHashes.slice(1);
				}
			}
		}
	}
}

/**
 * Clear the NPC and object hash caches (call when switching quests)
 */
export function clearNpcHashCache(): void {
	npcHashCache.clear();
	objectHashCache.clear();
}

// Colors for different overlay types
const COLORS = {
	npcArrow: [0, 255, 0, 255] as [number, number, number, number],
	wanderRadiusFill: [0, 200, 200, 150] as [number, number, number, number],  // Cyan/teal
	objectTile: [0, 128, 255, 200] as [number, number, number, number],
};

// Scan interval in ms
const SCAN_INTERVAL = 2000;

// Debug flags - set to true to disable specific overlay types for testing
const DEBUG_DISABLE_ALL_OVERLAYS = false;

// Individual debug flags for testing
const DEBUG_DISABLE_NPC_ARROWS = false;
const DEBUG_DISABLE_WANDER_RADIUS = false;
const DEBUG_DISABLE_OBJECT_TILES = false;

/**
 * Handle resolution/scale changes
 * Invalidates compass overlay VAO cache since screen space calculations change.
 * UI overlays (SpriteOverlay) handle their own scaling via useGlQuestIntegration.
 */
async function handleResolutionChange(info: UIScaleInfo): Promise<void> {
	console.log(`[QuestOverlay] Resolution changed: ${info.screenWidth}x${info.screenHeight}, scaled: ${info.isScaled}`);

	// Update npcOverlay screen dimensions (for future scans)
	if (state.npcOverlay) {
		state.npcOverlay.refreshScreenDimensions();
	}

	// Invalidate CompassRose anchor VAO - screen space calculations change with resolution
	invalidateCompassAnchorVao();

	// Note: We don't fully recreate NPC overlays, just invalidate the compass cache.
	// The VAO-attached overlays will refresh on next visibility check.
}

/**
 * Initialize the overlay systems (lazy load)
 */
async function initOverlays(): Promise<boolean> {
	if (state.npcOverlay && state.patchrs && tileOverlayManager) return true;

	try {
		state.patchrs = await import("@injection/util/patchrs_napi");
		if (!state.patchrs.native) return false;

		const npcOverlayModule = await import("@injection/NpcOverlay/npcOverlay");
		state.npcOverlay = new npcOverlayModule.NpcOverlay();

		tileOverlayManager = await import("@injection/overlays/TileOverlayManager");

		// Initialize UI scale manager to detect resolution/scaling changes
		await initUIScaleManager();

		// Initialize minimap direction overlay (if arrow or marker is enabled)
		if ((state.minimapArrowEnabled || state.minimapMarkerEnabled) && !state.minimapOverlay) {
			try {
				state.minimapOverlay = await initMinimapDirectionOverlay();
				// Configure which components are enabled
				state.minimapOverlay.setArrowEnabled(state.minimapArrowEnabled);
				state.minimapOverlay.setMarkerEnabled(state.minimapMarkerEnabled);
				console.log("[QuestOverlay] Minimap direction overlay initialized (arrow:", state.minimapArrowEnabled, ", marker:", state.minimapMarkerEnabled, ")");
			} catch (e) {
				console.warn("[QuestOverlay] Failed to init minimap direction overlay:", e);
			}
		}

		// Initialize HUD compass overlay
		if (state.hudCompassEnabled && !state.hudCompassOverlay) {
			try {
				state.hudCompassOverlay = await initHudCompassOverlay();
				console.log("[QuestOverlay] HUD compass overlay initialized");
			} catch (e) {
				console.warn("[QuestOverlay] Failed to init HUD compass overlay:", e);
			}
		}

		// Register for resolution changes (if not already registered)
		if (!state.resolutionChangeCleanup) {
			state.resolutionChangeCleanup = onResolutionChange(handleResolutionChange);
		}

		return true;
	} catch (e) {
		console.error("[QuestOverlay] Failed to init:", e);
		return false;
	}
}

/**
 * Get all buffer hashes for an NPC (from bundle, cache, or server)
 */
function getHashesForNpc(npc: NpcHighlight): string[] {
	const hashes: string[] = [];

	if (npc.buffer_hash) {
		hashes.push(npc.buffer_hash);
		if (npc.buffer_hash_variants) {
			hashes.push(...npc.buffer_hash_variants);
		}
		return hashes;
	}

	if (npc.id) {
		const cachedHashes = npcHashCache.get(npc.id);
		if (cachedHashes && cachedHashes.length > 0) {
			hashes.push(...cachedHashes);
		}
	}

	return hashes;
}

/**
 * Highlight an NPC by trying all known buffer hashes
 * Uses compass rose marker instead of arrow
 *
 * Optimization: Uses VAO cache for fast lookups when we've seen this NPC before
 */
async function highlightNpcByHash(npc: NpcHighlight): Promise<OverlayHandle | null> {
	// Skip compass rose if not enabled
	if (!state.compassOverlayEnabled) {
		return null;
	}

	try {
		const hashes = getHashesForNpc(npc);
		const hasHashes = hashes.length > 0;

		const markerId = `npc-${npc.id ?? npc.npcName ?? 'unknown'}`;
		const floor = npc.floor ?? 0;

		// Hash-based paths require npcOverlay module
		if (state.npcOverlay && hasHashes) {
			// FAST PATH: Check VAO cache first for each hash
			for (const hash of hashes) {
				const cached = state.npcOverlay.getCachedVaoInfo(hash);
				if (cached) {
					console.log(`[QuestOverlay] Fast path: Using cached VAO ${cached.vaoId} for "${npc.npcName}"`);
					try {
						const compassOverlay = await drawNpcCompassRoseAttached(
							cached.vaoId,
							1000,
							markerId,
							cached.framebufferId
						);

						if (compassOverlay) {
							state.onNpcFound?.(npc.npcName);
							return {
								id: compassOverlay,
								type: "npc-arrow",
								npcId: npc.id,
								npcHash: hash,
								attachmentType: "vao",
								vaoId: cached.vaoId,
								framebufferId: cached.framebufferId,
								npcInfo: npc,
								lastSeen: Date.now()
							};
						}
					} catch (e) {
						console.log(`[QuestOverlay] Cached VAO failed, clearing and falling back to scan`);
						// Cache entry may be stale, will fall through to slow path
					}
				}
			}

			// SLOW PATH: Full scan when cache miss
			// Get player position for distance-based filtering (reduces hash computations for far NPCs)
			const playerPos = getPlayerPosition();
			const positionFilter = playerPos ? {
				// PlayerPositionData.location uses lat (north/south = z) and lng (east/west = x)
				playerPosition: { x: playerPos.location.lng, z: playerPos.location.lat },
				maxDistanceFromPlayer: 30 // tiles - reduced for memory optimization
			} : undefined;

			for (const hash of hashes) {
				try {
					console.log(`[QuestOverlay] Slow path: Scanning for NPC "${npc.npcName}" with hash ${hash}...`);
					const result = await state.npcOverlay.arrowByBufferHash(hash, undefined, positionFilter);

					if (result.npc) {
						const framebufferId = result.group?.framebufferId ?? result.npc.framebufferId;
						console.log(`[QuestOverlay] Found NPC "${npc.npcName}" at VAO ${result.npc.vaoId}, fb ${framebufferId}, attaching compass rose`);

						// Stop the arrow overlay if one was created (we want compass rose instead)
						if (result.handle) {
							result.handle.stop();
						}

						// Attach compass rose to the NPC's VAO and framebuffer (fb filter avoids shadow pass)
						const compassOverlay = await drawNpcCompassRoseAttached(
							result.npc.vaoId,
							1000, // height offset - above NPC head
							markerId,
							framebufferId
						);

						if (compassOverlay) {
							state.onNpcFound?.(npc.npcName);
							return {
								id: compassOverlay,
								type: "npc-arrow",
								npcId: npc.id,
								npcHash: hash,
								attachmentType: "vao",
								vaoId: result.npc.vaoId,
								framebufferId: framebufferId,
								npcInfo: npc,
								lastSeen: Date.now()
							};
						}
					}
				} catch (e) {
					console.log(`[QuestOverlay] Hash ${hash} scan failed:`, e);
				}
			}
		}

		// Fallback: draw at floor with framebuffer filtering
		// This happens when: (1) no hashes available, or (2) NPC not found in view
		// Use center of wander radius if available, otherwise use spawn location
		let targetLat = npc.npcLocation.lat;
		let targetLng = npc.npcLocation.lng;

		if (npc.wanderRadius) {
			// Calculate center of wander radius bounds
			targetLat = (npc.wanderRadius.bottomLeft.lat + npc.wanderRadius.topRight.lat) / 2;
			targetLng = (npc.wanderRadius.bottomLeft.lng + npc.wanderRadius.topRight.lng) / 2;
			console.log(`[QuestOverlay] Drawing floor compass rose for "${npc.npcName}" at wander radius center (${targetLat}, ${targetLng})${hasHashes ? '' : ' (no hashes)'}`);
		} else {
			console.log(`[QuestOverlay] Drawing floor compass rose for "${npc.npcName}" at spawn location (${targetLat}, ${targetLng})${hasHashes ? '' : ' (no hashes)'}`);
		}

		// Use floor-attached method with framebuffer filtering (avoids shadow pass double-render)
		const compassOverlay = await drawNpcCompassRoseOnFloor(
			targetLat,
			targetLng,
			floor,
			markerId
		);

		if (compassOverlay) {
			state.onNpcFound?.(npc.npcName);
			return {
				id: compassOverlay,
				type: "npc-arrow",
				npcId: npc.id,
				npcHash: hashes[0] || undefined,
				attachmentType: "static",
				npcInfo: npc
			};
		}

		return null;
	} catch (e) {
		console.error(`[QuestOverlay] Error highlighting NPC "${npc.npcName}":`, e);
		return null;
	}
}

/**
 * Check if an NPC has any buffer hashes we can use for scanning
 */
function npcHasHashes(npc: NpcHighlight): boolean {
	return !!(npc.id || npc.buffer_hash || (npc.buffer_hash_variants && npc.buffer_hash_variants.length > 0));
}

/**
 * Scan for pending NPCs that haven't been found yet
 * Also tries to re-attach static overlays to VAOs if NPCs come back into view
 */
async function scanForPendingNpcs(): Promise<void> {
	if (!state.isActive) return;

	// Retry pending wander radius and object overlays FIRST (cheap operation)
	await retryPendingOverlays();

	// Check if we should stop the interval early (no more pending items)
	const nothingPending = state.pendingNpcs.length === 0 &&
		state.pendingWanderNpcs.length === 0 &&
		state.pendingObjects.length === 0;

	if (nothingPending && state.scanInterval) {
		clearInterval(state.scanInterval);
		state.scanInterval = null;
		return;
	}

	// Skip expensive NPC scanning if no pending NPCs (compass roses)
	// Wander radius and objects are handled by retryPendingOverlays above
	if (state.pendingNpcs.length === 0) {
		return;
	}

	// EXPENSIVE: Try to re-attach any static overlays to VAOs (requires render capture)
	await tryReattachStaticOverlays();

	// If we successfully re-attached any, start monitoring again
	startVisibilityMonitoring();

	const stillPending: NpcHighlight[] = [];

	for (const npc of state.pendingNpcs) {
		// Check if we already have an arrow for this NPC (by ID or any matching hash)
		const existingArrow = state.activeOverlays.find(
			o => o.type === "npc-arrow" && (
				(npc.id && o.npcId === npc.id) ||
				(npc.buffer_hash && o.npcHash === npc.buffer_hash)
			)
		);

		if (existingArrow) {
			continue;
		}

		const handle = await highlightNpcByHash(npc);
		if (handle) {
			state.activeOverlays.push(handle);
		} else {
			stillPending.push(npc);
		}
	}

	state.pendingNpcs = stillPending;

	// Stop scanning if nothing is pending anymore
	if (stillPending.length === 0 &&
		state.pendingWanderNpcs.length === 0 &&
		state.pendingObjects.length === 0 &&
		state.scanInterval) {
		clearInterval(state.scanInterval);
		state.scanInterval = null;
	}
}

/**
 * Start continuous scanning for NPCs and pending overlays
 */
function startNpcScanning(): void {
	if (state.scanInterval) return;

	// Start scanning if we have any pending items (NPCs, wander radius, or objects)
	const hasPending = state.pendingNpcs.length > 0 ||
		state.pendingWanderNpcs.length > 0 ||
		state.pendingObjects.length > 0;

	if (hasPending) {
		state.scanInterval = setInterval(scanForPendingNpcs, SCAN_INTERVAL);
	}
}

/**
 * Stop continuous scanning
 */
function stopNpcScanning(): void {
	if (state.scanInterval) {
		clearInterval(state.scanInterval);
		state.scanInterval = null;
	}
}

/**
 * Check visibility of VAO-attached NPC overlays
 * If an NPC hasn't been seen for NPC_VISIBILITY_TIMEOUT, switch to static location
 * Also detects framebuffer changes and re-attaches overlays with the new framebuffer
 */
async function checkNpcVisibility(): Promise<void> {
	if (!state.isActive || !state.npcOverlay) return;

	const vaoAttachedOverlays = state.activeOverlays.filter(
		o => o.type === "npc-arrow" && o.attachmentType === "vao" && o.vaoId !== undefined
	);

	if (vaoAttachedOverlays.length === 0) {
		stopVisibilityMonitoring();
		return;
	}

	// Use lightweight scan that gets VAO IDs AND framebuffer IDs
	// This allows us to detect when the game switches render targets
	try {
		// Collect the VAO IDs we're tracking
		const trackedVaoIds = new Set<number>();
		for (const overlay of vaoAttachedOverlays) {
			if (overlay.vaoId !== undefined) {
				trackedVaoIds.add(overlay.vaoId);
			}
		}

		// Use the scan that returns both VAO IDs and their current framebuffer IDs
		const vaoFramebufferMap = await state.npcOverlay.scanRenderedVaoIdsWithFramebuffers(trackedVaoIds);

		const now = Date.now();

		for (const overlay of vaoAttachedOverlays) {
			if (overlay.vaoId !== undefined && vaoFramebufferMap.has(overlay.vaoId)) {
				// NPC is visible - update lastSeen
				overlay.lastSeen = now;

				// Check if framebuffer has changed
				const currentFramebufferId = vaoFramebufferMap.get(overlay.vaoId)!;
				if (overlay.framebufferId !== undefined && overlay.framebufferId !== currentFramebufferId) {
					console.log(`[QuestOverlay] Framebuffer changed for NPC VAO ${overlay.vaoId}: ${overlay.framebufferId} -> ${currentFramebufferId}, re-attaching`);
					await reattachWithNewFramebuffer(overlay, currentFramebufferId);
				}
			} else if (overlay.lastSeen && (now - overlay.lastSeen) > NPC_VISIBILITY_TIMEOUT) {
				// NPC has been out of view too long - switch to static location
				await switchToStaticOverlay(overlay);
			}
		}
	} catch (e) {
		console.error("[QuestOverlay] Error checking NPC visibility:", e);
	}
}

/**
 * Re-attach a VAO-attached overlay with a new framebuffer ID
 * Called when the game switches render targets and our overlay filter is stale
 */
async function reattachWithNewFramebuffer(overlay: OverlayHandle, newFramebufferId: number): Promise<void> {
	if (!overlay.npcInfo || overlay.attachmentType !== "vao" || overlay.vaoId === undefined) return;

	const npc = overlay.npcInfo;
	const markerId = `npc-${npc.id ?? overlay.npcHash}`;

	// Stop the old overlay
	if (overlay.id && typeof overlay.id !== "number") {
		try {
			(overlay.id as GlOverlay).stop();
		} catch (e) {
			// Ignore stop errors
		}
	}

	// Create new overlay with updated framebuffer
	const newOverlay = await drawNpcCompassRoseAttached(
		overlay.vaoId,
		1000, // height offset
		markerId,
		newFramebufferId
	);

	if (newOverlay) {
		// Update the overlay handle in place
		overlay.id = newOverlay;
		overlay.framebufferId = newFramebufferId;
		overlay.lastSeen = Date.now();
		console.log(`[QuestOverlay] Re-attached "${npc.npcName}" with new framebuffer ${newFramebufferId}`);
	} else {
		// Failed to re-attach - switch to static
		console.log(`[QuestOverlay] Failed to re-attach "${npc.npcName}", switching to static`);
		await switchToStaticOverlay(overlay);
	}
}

/**
 * Switch a VAO-attached overlay to a static location overlay
 */
async function switchToStaticOverlay(overlay: OverlayHandle): Promise<void> {
	if (!overlay.npcInfo || overlay.attachmentType !== "vao") return;

	const npc = overlay.npcInfo;
	const markerId = `npc-${npc.id ?? overlay.npcHash}`;
	const floor = npc.floor ?? 0;

	console.log(`[QuestOverlay] NPC "${npc.npcName}" left render distance, switching to static location`);

	// Stop the VAO-attached overlay
	if (overlay.id && typeof overlay.id !== "number") {
		try {
			(overlay.id as GlOverlay).stop();
		} catch (e) {
			// Ignore stop errors
		}
	}

	// Calculate target location - use center of wander radius if available
	let targetLat = npc.npcLocation.lat;
	let targetLng = npc.npcLocation.lng;

	if (npc.wanderRadius) {
		targetLat = (npc.wanderRadius.bottomLeft.lat + npc.wanderRadius.topRight.lat) / 2;
		targetLng = (npc.wanderRadius.bottomLeft.lng + npc.wanderRadius.topRight.lng) / 2;
	}

	// Use floor-attached method with framebuffer filtering (avoids shadow pass double-render)
	const staticOverlay = await drawNpcCompassRoseOnFloor(
		targetLat,
		targetLng,
		floor,
		markerId
	);

	if (staticOverlay) {
		// Update the overlay handle in place
		overlay.id = staticOverlay;
		overlay.attachmentType = "static";
		overlay.vaoId = undefined;
		overlay.framebufferId = undefined;
		overlay.lastSeen = undefined;
		console.log(`[QuestOverlay] Switched "${npc.npcName}" to static overlay`);
	}
}

/**
 * Try to re-attach a static overlay to a VAO if the NPC comes back into view
 * Called during pendingNpc scans
 */
async function tryReattachStaticOverlays(): Promise<void> {
	if (!state.isActive || !state.npcOverlay) return;

	const staticOverlays = state.activeOverlays.filter(
		o => o.type === "npc-arrow" && o.attachmentType === "static" && o.npcInfo
	);

	for (const overlay of staticOverlays) {
		const npc = overlay.npcInfo!;
		const hashes = getHashesForNpc(npc);
		let attached = false;

		for (const hash of hashes) {
			if (attached) break;

			// Check cache first (fast path)
			const cached = state.npcOverlay.getCachedVaoInfo(hash);
			if (cached) {
				const markerId = `npc-${npc.id ?? hash}`;

				// Stop the static overlay
				if (overlay.id && typeof overlay.id !== "number") {
					try {
						(overlay.id as GlOverlay).stop();
					} catch (e) {
						// Ignore
					}
				}

				// Create VAO-attached overlay
				const vaoOverlay = await drawNpcCompassRoseAttached(
					cached.vaoId,
					1000,
					markerId,
					cached.framebufferId
				);

				if (vaoOverlay) {
					overlay.id = vaoOverlay;
					overlay.attachmentType = "vao";
					overlay.vaoId = cached.vaoId;
					overlay.framebufferId = cached.framebufferId;
					overlay.lastSeen = Date.now();
					console.log(`[QuestOverlay] Re-attached "${npc.npcName}" to VAO ${cached.vaoId} (from cache)`);
					attached = true;
					break;
				}
			}
		}

		// Slow path: cache miss - do a full scan to check if NPC is now in view
		if (!attached && hashes.length > 0) {
			// Get player position for distance filtering
			const playerPos = getPlayerPosition();
			const positionFilter = playerPos ? {
				playerPosition: { x: playerPos.location.lng, z: playerPos.location.lat },
				maxDistanceFromPlayer: 30
			} : undefined;

			for (const hash of hashes) {
				try {
					const result = await state.npcOverlay.arrowByBufferHash(hash, undefined, positionFilter);
					if (result.npc) {
						const framebufferId = result.group?.framebufferId ?? result.npc.framebufferId;
						const markerId = `npc-${npc.id ?? hash}`;

						// Stop the arrow if created (we want compass rose)
						if (result.handle) {
							result.handle.stop();
						}

						// Stop the static overlay
						if (overlay.id && typeof overlay.id !== "number") {
							try {
								(overlay.id as GlOverlay).stop();
							} catch (e) {
								// Ignore
							}
						}

						// Create VAO-attached compass rose
						const vaoOverlay = await drawNpcCompassRoseAttached(
							result.npc.vaoId,
							1000,
							markerId,
							framebufferId
						);

						if (vaoOverlay) {
							overlay.id = vaoOverlay;
							overlay.attachmentType = "vao";
							overlay.vaoId = result.npc.vaoId;
							overlay.framebufferId = framebufferId;
							overlay.lastSeen = Date.now();
							console.log(`[QuestOverlay] Re-attached "${npc.npcName}" to VAO ${result.npc.vaoId} (from scan)`);
							attached = true;
							break;
						}
					}
				} catch (e) {
					// Scan failed, continue to next hash
				}
			}
		}
	}
}

/**
 * Start monitoring visibility of VAO-attached overlays
 */
function startVisibilityMonitoring(): void {
	if (state.visibilityMonitorInterval) return;

	const hasVaoOverlays = state.activeOverlays.some(
		o => o.type === "npc-arrow" && o.attachmentType === "vao"
	);

	if (hasVaoOverlays) {
		state.visibilityMonitorInterval = setInterval(checkNpcVisibility, VISIBILITY_CHECK_INTERVAL);
	}
}

/**
 * Stop visibility monitoring
 */
function stopVisibilityMonitoring(): void {
	if (state.visibilityMonitorInterval) {
		clearInterval(state.visibilityMonitorInterval);
		state.visibilityMonitorInterval = null;
	}
}

/**
 * Calculate distance between player and wander radius center
 * Returns distance in tiles, or null if can't calculate
 */
function getDistanceToWanderRadius(npc: NpcHighlight): number | null {
	const playerPos = getPlayerPosition();
	if (!playerPos) return null;

	// Get wander radius center (or spawn location if no wander radius)
	let targetLat: number;
	let targetLng: number;

	if (npc.wanderRadius) {
		targetLat = (npc.wanderRadius.bottomLeft.lat + npc.wanderRadius.topRight.lat) / 2;
		targetLng = (npc.wanderRadius.bottomLeft.lng + npc.wanderRadius.topRight.lng) / 2;
	} else {
		targetLat = npc.npcLocation.lat;
		targetLng = npc.npcLocation.lng;
	}

	// Calculate distance (player uses lat for z, lng for x)
	const dx = playerPos.location.lng - targetLng;
	const dz = playerPos.location.lat - targetLat;

	return Math.sqrt(dx * dx + dz * dz);
}

/**
 * Check player proximity to static overlays and trigger scan if within range
 * This enables proactive NPC detection when player approaches the wander radius
 */
async function checkPlayerProximityToStaticOverlays(): Promise<void> {
	if (!state.isActive || !state.npcOverlay) return;

	const staticOverlays = state.activeOverlays.filter(
		o => o.type === "npc-arrow" && o.attachmentType === "static" && o.npcInfo
	);

	if (staticOverlays.length === 0) {
		stopProximityMonitoring();
		return;
	}

	for (const overlay of staticOverlays) {
		const npc = overlay.npcInfo!;
		const distance = getDistanceToWanderRadius(npc);

		if (distance !== null && distance <= PROXIMITY_SCAN_DISTANCE) {
			// Try to find and attach to the NPC
			const hashes = getHashesForNpc(npc);

			for (const hash of hashes) {
				try {
					const playerPos = getPlayerPosition();
					const positionFilter = playerPos ? {
						playerPosition: { x: playerPos.location.lng, z: playerPos.location.lat },
						maxDistanceFromPlayer: PROXIMITY_SCAN_DISTANCE
					} : undefined;

					const result = await state.npcOverlay.arrowByBufferHash(hash, undefined, positionFilter);

					if (result.npc) {
						const framebufferId = result.group?.framebufferId ?? result.npc.framebufferId;
						const markerId = `npc-${npc.id ?? hash}`;

						// Stop the arrow if created
						if (result.handle) {
							result.handle.stop();
						}

						// Stop the static overlay
						if (overlay.id && typeof overlay.id !== "number") {
							try {
								(overlay.id as GlOverlay).stop();
							} catch (e) {
								// Ignore
							}
						}

						// Create VAO-attached compass rose
						const vaoOverlay = await drawNpcCompassRoseAttached(
							result.npc.vaoId,
							1000,
							markerId,
							framebufferId
						);

						if (vaoOverlay) {
							overlay.id = vaoOverlay;
							overlay.attachmentType = "vao";
							overlay.vaoId = result.npc.vaoId;
							overlay.framebufferId = framebufferId;
							overlay.lastSeen = Date.now();

							// Start visibility monitoring now that we have a VAO overlay
							startVisibilityMonitoring();
							break;
						}
					}
				} catch (e) {
					// Scan failed, continue to next hash
				}
			}
		}
	}
}

/**
 * Start monitoring player proximity to static overlays
 */
function startProximityMonitoring(): void {
	if (state.proximityMonitorInterval) return;

	const hasStaticOverlays = state.activeOverlays.some(
		o => o.type === "npc-arrow" && o.attachmentType === "static"
	);

	if (hasStaticOverlays) {
		state.proximityMonitorInterval = setInterval(checkPlayerProximityToStaticOverlays, PROXIMITY_CHECK_INTERVAL);
	}
}

/**
 * Stop proximity monitoring
 */
function stopProximityMonitoring(): void {
	if (state.proximityMonitorInterval) {
		clearInterval(state.proximityMonitorInterval);
		state.proximityMonitorInterval = null;
	}
}

/**
 * Draw wander radius with islanding effect (terrain-aware)
 * Uses the exact bounds from wanderRadius data
 * Single draw call with both wander tiles (cyan) and NPC spawn tile (red)
 */
async function drawWanderRadiusFilled(npc: NpcHighlight): Promise<OverlayHandle | null> {
	if (!npc.wanderRadius) {
		console.log(`[QuestOverlay] No wanderRadius data for "${npc.npcName}"`);
		return null;
	}
	if (!tileOverlayManager) {
		console.log(`[QuestOverlay] tileOverlayManager not initialized`);
		return null;
	}

	const { bottomLeft, topRight } = npc.wanderRadius;
	console.log(`[QuestOverlay] Attempting wander radius for "${npc.npcName}" at (${bottomLeft.lat}-${topRight.lat}, ${bottomLeft.lng}-${topRight.lng}) floor ${npc.floor ?? 0}`);

	try {
		const overlayId = await tileOverlayManager.addNPCWanderMarker({
			npcLocation: npc.npcLocation,
			wanderRadius: npc.wanderRadius,
			color: COLORS.wanderRadiusFill,
			npcColor: [255, 50, 50, 255],
			thickness: 0.07,
			floor: npc.floor ?? 0,
			// Skip if chunk not visible - will be retried when player gets closer
			skipIfNotVisible: true
		});

		if (overlayId !== null) {
			console.log(`[QuestOverlay] Wander radius created for "${npc.npcName}" with overlayId ${overlayId}`);
			return { id: overlayId, type: "wander-radius" };
		}
		console.log(`[QuestOverlay] Wander radius returned null for "${npc.npcName}" (chunk not visible or other issue)`);
		return null;
	} catch (e) {
		console.error(`[QuestOverlay] Error drawing wander radius for "${npc.npcName}":`, e);
		return null;
	}
}

/**
 * Draw object tile markers (terrain-aware) with islanding effect
 * Uses batched rendering for efficiency - borders only on outer edges
 */
async function drawObjectTiles(obj: ObjectHighlight): Promise<OverlayHandle[]> {
	const handles: OverlayHandle[] = [];
	if (!tileOverlayManager) return handles;

	try {
		const tileGroup = {
			name: obj.name,
			tiles: obj.objectLocation.map(point => ({
				lat: point.lat,
				lng: point.lng,
				color: point.color,
				numberLabel: point.numberLabel
			})),
			defaultColor: COLORS.objectTile,
			floor: obj.floor ?? 0,
			thickness: 0.04
		};

		const overlayId = await tileOverlayManager.addObjectTilesBatched(tileGroup);

		if (overlayId !== null) {
			handles.push({ id: overlayId, type: "object-tile" });
		}
	} catch (e) {
		console.error(`[QuestOverlay] Error drawing object tiles for "${obj.name}":`, e);
	}

	return handles;
}

/**
 * Clear all active overlays
 */
async function clearOverlays(): Promise<void> {
	// Clear tile overlays using the manager
	if (tileOverlayManager) {
		try {
			await tileOverlayManager.clearAllOverlays();
		} catch (e) {
			console.warn("[QuestOverlay] Error clearing tile overlays:", e);
		}
	}

	// Clear compass rose markers
	try {
		await clearAllCompassRoses();
	} catch (e) {
		console.warn("[QuestOverlay] Error clearing compass roses:", e);
	}

	// Clear NPC arrow overlays via .stop() (GlOverlay objects)
	for (const overlay of state.activeOverlays) {
		if (overlay.type === "npc-arrow" && typeof overlay.id !== "number") {
			try {
				overlay.id.stop();
			} catch (e) {
				// Ignore errors when stopping
			}
		}
	}

	state.activeOverlays = [];
	state.pendingNpcs = [];
	state.pendingWanderNpcs = [];
	state.pendingObjects = [];
}

/**
 * Activate overlays for a quest step
 */
export async function activateStepOverlays(
	step: QuestStep,
	options?: {
		onNpcFound?: (npcName: string) => void;
		compassOverlayEnabled?: boolean;
	}
): Promise<boolean> {
	if (DEBUG_DISABLE_ALL_OVERLAYS) return true;

	const initialized = await initOverlays();
	if (!initialized) return false;

	await deactivateStepOverlays();

	state.currentStep = step;
	state.isActive = true;
	state.onNpcFound = options?.onNpcFound;
	state.compassOverlayEnabled = options?.compassOverlayEnabled ?? false;
	console.log(`[QuestOverlay] activateStepOverlays - compassOverlayEnabled: ${state.compassOverlayEnabled}`);

	const { npc: npcs, object: objects } = step.highlights;

	// Process NPCs
	for (const npc of npcs) {
		// Try to highlight NPC if we have hash info
		if (!DEBUG_DISABLE_NPC_ARROWS && npcHasHashes(npc)) {
			const handle = await highlightNpcByHash(npc);
			if (handle) {
				state.activeOverlays.push(handle);
			} else {
				state.pendingNpcs.push(npc);
			}
		}

		// Draw wander radius if available
		if (!DEBUG_DISABLE_WANDER_RADIUS && npc.wanderRadius) {
			const handle = await drawWanderRadiusFilled(npc);
			if (handle) {
				state.activeOverlays.push(handle);
			} else {
				// Track for retry when player gets closer
				state.pendingWanderNpcs.push(npc);
			}
		}
	}

	// Process Objects
	if (!DEBUG_DISABLE_OBJECT_TILES) {
		for (const obj of objects) {
			const handles = await drawObjectTiles(obj);
			if (handles.length > 0) {
				state.activeOverlays.push(...handles);
			} else {
				// Track for retry when player gets closer
				state.pendingObjects.push(obj);
			}
		}
	}

	// Start scanning for any NPCs we couldn't find immediately
	startNpcScanning();

	// Start monitoring visibility of VAO-attached overlays
	startVisibilityMonitoring();

	// Start proximity monitoring for static overlays (triggers scan when player approaches)
	startProximityMonitoring();

	// Start minimap direction indicator if enabled (arrow or marker) and we have targets
	if ((state.minimapArrowEnabled || state.minimapMarkerEnabled) && state.minimapOverlay && (npcs.length > 0 || objects.length > 0)) {
		state.minimapOverlay.setTargetsFromQuestStep(npcs, objects);
		state.minimapOverlay.start(300); // Update every 300ms
		console.log(`[QuestOverlay] Minimap direction started with ${npcs.length} NPCs and ${objects.length} objects`);
	}

	// Start HUD compass if enabled and we have targets
	if (state.hudCompassEnabled && state.hudCompassOverlay && (npcs.length > 0 || objects.length > 0)) {
		// Get first target location (NPC or object)
		let targetLat: number | undefined;
		let targetLng: number | undefined;

		if (npcs.length > 0 && npcs[0].npcLocation) {
			targetLat = npcs[0].npcLocation.lat;
			targetLng = npcs[0].npcLocation.lng;
		} else if (objects.length > 0 && objects[0].objectLocation?.[0]) {
			targetLat = objects[0].objectLocation[0].lat;
			targetLng = objects[0].objectLocation[0].lng;
		}

		if (targetLat !== undefined && targetLng !== undefined) {
			state.hudCompassOverlay.setTarget(targetLat, targetLng);
			state.hudCompassOverlay.setVisible(true);
			console.log(`[QuestOverlay] HUD compass started pointing to (${targetLat}, ${targetLng})`);
		}
	}

	return true;
}

/**
 * Deactivate all step overlays
 */
export async function deactivateStepOverlays(): Promise<void> {
	stopNpcScanning();
	stopVisibilityMonitoring();
	stopProximityMonitoring();

	// Stop minimap direction overlay
	if (state.minimapOverlay) {
		state.minimapOverlay.stop();
		state.minimapOverlay.clearTargets();
	}

	// Stop HUD compass overlay
	if (state.hudCompassOverlay) {
		state.hudCompassOverlay.clearTarget();
		state.hudCompassOverlay.setVisible(false);
	}

	await clearOverlays();
	state.isActive = false;
	state.currentStep = null;
	state.onNpcFound = undefined;
}

/**
 * Refresh overlays (re-scan for NPCs)
 */
export async function refreshOverlays(): Promise<void> {
	if (!state.isActive || !state.currentStep) return;
	await scanForPendingNpcs();
}

/**
 * Retry creating overlays that couldn't be drawn because chunk wasn't visible
 * Call this when player moves closer to the target
 */
export async function retryPendingOverlays(): Promise<void> {
	if (!state.isActive) return;

	const wanderCount = state.pendingWanderNpcs.length;
	const objectCount = state.pendingObjects.length;

	if (wanderCount > 0 || objectCount > 0) {
		console.log(`[QuestOverlay] retryPendingOverlays: ${wanderCount} wander, ${objectCount} objects pending`);
	}

	// Retry pending wander radius overlays
	const stillPendingWander: NpcHighlight[] = [];
	for (const npc of state.pendingWanderNpcs) {
		const handle = await drawWanderRadiusFilled(npc);
		if (handle) {
			state.activeOverlays.push(handle);
			console.log(`[QuestOverlay] Successfully created wander radius for "${npc.npcName}"`);
		} else {
			stillPendingWander.push(npc);
		}
	}
	state.pendingWanderNpcs = stillPendingWander;

	// Retry pending object overlays
	const stillPendingObjects: ObjectHighlight[] = [];
	for (const obj of state.pendingObjects) {
		const handles = await drawObjectTiles(obj);
		if (handles.length > 0) {
			state.activeOverlays.push(...handles);
		} else {
			stillPendingObjects.push(obj);
		}
	}
	state.pendingObjects = stillPendingObjects;
}

/**
 * Check if there are pending overlays that need retry
 */
export function hasPendingOverlays(): boolean {
	return state.pendingWanderNpcs.length > 0 || state.pendingObjects.length > 0;
}

/**
 * Get current overlay state
 */
export function getOverlayState(): Readonly<{
	isActive: boolean;
	activeCount: number;
	pendingNpcCount: number;
}> {
	return {
		isActive: state.isActive,
		activeCount: state.activeOverlays.length,
		pendingNpcCount: state.pendingNpcs.length,
	};
}

/**
 * Check if overlays are active
 */
export function isOverlayActive(): boolean {
	return state.isActive;
}

/**
 * Get count of active overlays
 */
export function getActiveOverlayCount(): number {
	return state.activeOverlays.length;
}

/**
 * Get list of NPCs we're still looking for
 */
export function getPendingNpcs(): string[] {
	return state.pendingNpcs.map(npc => npc.npcName);
}

// ============================================================================
// Path Overlay Functions
// ============================================================================

// Colors for path visualization
const PATH_COLORS = {
	pathTile: [0, 255, 128, 180] as [number, number, number, number],       // Bright green for path
	nextWaypoint: [255, 255, 0, 220] as [number, number, number, number],   // Yellow for next waypoint
	destination: [255, 100, 100, 220] as [number, number, number, number],  // Red for destination
	transportNode: [128, 0, 255, 200] as [number, number, number, number],  // Purple for transport
};

// Path overlay state
interface PathOverlayState {
	isActive: boolean;
	activePathOverlays: GlOverlay[];  // Overlay objects for path tiles
	currentFloor: number;
}

const pathState: PathOverlayState = {
	isActive: false,
	activePathOverlays: [],
	currentFloor: 0,
};

/**
 * Draw a path overlay on the game world
 * Uses animated shaders with flowing gradient from cyan (start) to gold (destination)
 * @param path Array of path nodes with lat/lng coordinates
 * @param floor The floor level to draw on
 */
export async function drawPathOverlay(
	path: Array<{ lat: number; lng: number; floor: number; isTransport?: boolean }>,
	_options?: {
		highlightDestination?: boolean;
		highlightNextWaypoint?: number;
	}
): Promise<boolean> {
	const initialized = await initOverlays();
	if (!initialized || !tileOverlayManager) return false;

	await clearPathOverlay();

	if (path.length === 0) return false;

	pathState.isActive = true;
	pathState.currentFloor = path[0]?.floor ?? 0;

	// Build array of path tiles with progress values for animated gradient
	// progress: 0 = start of path (cyan), 1 = destination (gold)
	const pathTiles: Array<{
		lat: number;
		lng: number;
		color: [number, number, number, number];
		floor: number;
		progress: number;
	}> = [];

	// Count tiles on current floor to calculate progress correctly
	const tilesOnFloor = path.filter(n => n.floor === pathState.currentFloor).length;

	let floorIndex = 0;
	for (let i = 0; i < path.length; i++) {
		const node = path[i];

		if (node.floor !== pathState.currentFloor) continue;

		// Calculate progress (0 = start, 1 = end)
		const progress = tilesOnFloor > 1 ? floorIndex / (tilesOnFloor - 1) : 0.5;

		// Base color (used as fallback, but animated shader uses its own gradient)
		let color = PATH_COLORS.pathTile;

		// Transport nodes get a slightly different treatment
		if (node.isTransport) {
			color = PATH_COLORS.transportNode;
		}

		pathTiles.push({
			lat: node.lat,
			lng: node.lng,
			color,
			floor: node.floor,
			progress,
		});

		floorIndex++;
	}

	// Single batched draw call for all path tiles with animation enabled
	try {
		const overlayIds = await tileOverlayManager.addPathTilesBatched({
			tiles: pathTiles,
			floor: pathState.currentFloor,
			thickness: 0.05,
			skipIfNotVisible: true,
			animated: true,  // Enable animated flowing gradient effect
		});

		pathState.activePathOverlays.push(...overlayIds);
	} catch (e) {
		// Error drawing path tiles, ignore
	}

	return true;
}

/**
 * Clear path overlay
 */
export async function clearPathOverlay(): Promise<void> {
	for (const overlay of pathState.activePathOverlays) {
		try {
			overlay.stop();
		} catch (e) {
			// Ignore errors when stopping
		}
	}

	pathState.activePathOverlays = [];
	pathState.isActive = false;
}

/**
 * Check if path overlay is active
 */
export function isPathOverlayActive(): boolean {
	return pathState.isActive;
}

/**
 * Enable or disable the minimap direction arrow (very taxing)
 * Call this when the setting changes
 */
export function setMinimapArrowEnabled(enabled: boolean): void {
	state.minimapArrowEnabled = enabled;

	if (state.minimapOverlay) {
		state.minimapOverlay.setArrowEnabled(enabled);

		// If both are disabled, stop the overlay
		if (!enabled && !state.minimapMarkerEnabled) {
			state.minimapOverlay.stop();
			state.minimapOverlay.clearTargets();
		} else if ((enabled || state.minimapMarkerEnabled) && state.isActive && state.currentStep) {
			// Re-enable while a step is active: restart with current targets
			const { npc: npcs, object: objects } = state.currentStep.highlights;
			if (npcs.length > 0 || objects.length > 0) {
				state.minimapOverlay.setTargetsFromQuestStep(npcs, objects);
				state.minimapOverlay.start(300);
			}
		}
	}
}

/**
 * Enable or disable the minimap direction marker (light resource usage)
 * Call this when the setting changes
 */
export function setMinimapMarkerEnabled(enabled: boolean): void {
	state.minimapMarkerEnabled = enabled;

	if (state.minimapOverlay) {
		state.minimapOverlay.setMarkerEnabled(enabled);

		// If both are disabled, stop the overlay
		if (!enabled && !state.minimapArrowEnabled) {
			state.minimapOverlay.stop();
			state.minimapOverlay.clearTargets();
		} else if ((enabled || state.minimapArrowEnabled) && state.isActive && state.currentStep) {
			// Re-enable while a step is active: restart with current targets
			const { npc: npcs, object: objects } = state.currentStep.highlights;
			if (npcs.length > 0 || objects.length > 0) {
				state.minimapOverlay.setTargetsFromQuestStep(npcs, objects);
				state.minimapOverlay.start(300);
			}
		}
	}
}

/**
 * Check if minimap arrow is enabled
 */
export function isMinimapArrowEnabled(): boolean {
	return state.minimapArrowEnabled;
}

/**
 * Check if minimap marker is enabled
 */
export function isMinimapMarkerEnabled(): boolean {
	return state.minimapMarkerEnabled;
}

/**
 * Enable or disable the HUD compass overlay
 * Call this when the setting changes
 */
export async function setHudCompassEnabled(enabled: boolean): Promise<void> {
	state.hudCompassEnabled = enabled;

	if (!enabled && state.hudCompassOverlay) {
		// Disable: clear target and hide
		state.hudCompassOverlay.clearTarget();
		state.hudCompassOverlay.setVisible(false);
	} else if (enabled) {
		// Initialize if needed
		if (!state.hudCompassOverlay) {
			try {
				state.hudCompassOverlay = await initHudCompassOverlay();
				console.log("[QuestOverlay] HUD compass overlay initialized (on enable)");
			} catch (e) {
				console.warn("[QuestOverlay] Failed to init HUD compass overlay:", e);
				return;
			}
		}

		// Re-enable while a step is active: restart with current targets
		if (state.hudCompassOverlay && state.isActive && state.currentStep) {
			const { npc: npcs, object: objects } = state.currentStep.highlights;
			let targetLat: number | undefined;
			let targetLng: number | undefined;

			if (npcs.length > 0 && npcs[0].npcLocation) {
				targetLat = npcs[0].npcLocation.lat;
				targetLng = npcs[0].npcLocation.lng;
			} else if (objects.length > 0 && objects[0].objectLocation?.[0]) {
				targetLat = objects[0].objectLocation[0].lat;
				targetLng = objects[0].objectLocation[0].lng;
			}

			if (targetLat !== undefined && targetLng !== undefined) {
				state.hudCompassOverlay.setTarget(targetLat, targetLng);
				state.hudCompassOverlay.setVisible(true);
			}
		}
	}
}

/**
 * Check if HUD compass overlay is enabled
 */
export function isHudCompassEnabled(): boolean {
	return state.hudCompassEnabled;
}

/**
 * Set HUD compass position
 */
export function setHudCompassPosition(x: number, y: number): void {
	if (state.hudCompassOverlay) {
		state.hudCompassOverlay.setPosition(x, y);
	}
}

/**
 * Get count of path overlay tiles
 */
export function getPathOverlayCount(): number {
	return pathState.activePathOverlays.length;
}

/**
 * Update path overlay when player floor changes
 */
export async function updatePathOverlayFloor(
	path: Array<{ lat: number; lng: number; floor: number; isTransport?: boolean }>,
	newFloor: number,
	options?: {
		highlightDestination?: boolean;
		highlightNextWaypoint?: number;
	}
): Promise<void> {
	if (newFloor === pathState.currentFloor) return;

	pathState.currentFloor = newFloor;

	// Redraw path for new floor
	if (path.length > 0) {
		await drawPathOverlay(path, options);
	}
}

/**
 * Draw a single waypoint marker (for highlighting next destination)
 */
export async function drawWaypointMarker(
	lat: number,
	lng: number,
	floor: number,
	type: "next" | "destination" | "transport" = "next"
): Promise<GlOverlay | null> {
	const initialized = await initOverlays();
	if (!initialized || !tileOverlayManager) {
		return null;
	}

	const color = type === "destination" ? PATH_COLORS.destination
		: type === "transport" ? PATH_COLORS.transportNode
		: PATH_COLORS.nextWaypoint;

	try {
		const result = await tileOverlayManager.addTileMarker({
			lat,
			lng,
			color,
			filled: true,  // Filled to stand out
			solidFill: true,
			thickness: 0.05,
			floor,
			// Skip if chunk not visible to avoid delays
			skipIfNotVisible: true,
		});
		return result;
	} catch (e) {
		return null;
	}
}
