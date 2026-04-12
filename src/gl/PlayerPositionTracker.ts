/**
 * PlayerPositionTracker - React-friendly wrapper for player position tracking
 *
 * Uses ts/util/playerPosition.ts PassivePlayerTracker for zero-overhead position tracking.
 * After initial setup, position reads are instant (no GL frame recording needed).
 *
 * Also proactively preloads collision data around the player for faster pathfinding.
 * Automatically detects floor changes when player arrives at transport exit locations.
 */

import type { NpcLocation } from "../state/types";
import { preloadCollisionData, transportCache } from "../api/clientPathfinder";
import type { TransportLink } from "../api/pathfindingApi";
import { findBestLevelForHeight, TILE_SIZE } from "@injection/overlays/heightData";

export interface PlayerPositionData {
	location: NpcLocation;
	floor: number;
	timestamp: number;
}

/** Transport type categories matching the database schema */
export type TransportCategory =
	| "teleportation"  // teleport, lodestone, fairy_ring, spirit_tree, portal, jewelry_teleport
	| "vertical"       // stairs, ladder, trapdoor, rope
	| "aerial"         // gnome_glider, balloon, eagle, magic_carpet
	| "ground"         // minecart, gnome_cart
	| "water"          // boat, canoe, charter_ship
	| "shortcut"       // agility, door, gate
	| "other";

/** Map transport types to categories */
const TRANSPORT_CATEGORIES: Record<string, TransportCategory> = {
	// Teleportation
	teleport: "teleportation",
	lodestone: "teleportation",
	fairy_ring: "teleportation",
	spirit_tree: "teleportation",
	portal: "teleportation",
	jewelry_teleport: "teleportation",
	// Vertical
	stairs: "vertical",
	ladder: "vertical",
	trapdoor: "vertical",
	rope: "vertical",
	// Aerial
	gnome_glider: "aerial",
	balloon: "aerial",
	eagle: "aerial",
	magic_carpet: "aerial",
	// Ground/Rail
	minecart: "ground",
	gnome_cart: "ground",
	// Water
	boat: "water",
	canoe: "water",
	charter_ship: "water",
	// Shortcuts
	agility: "shortcut",
	door: "shortcut",
	gate: "shortcut",
	// Other
	other: "other",
};

/** Get category for a transport type */
export function getTransportCategory(transportType: string): TransportCategory {
	return TRANSPORT_CATEGORIES[transportType.toLowerCase()] || "other";
}

/** Information about a detected transport usage */
export interface DetectedTransport {
	transport: TransportLink;
	name: string;
	type: string;
	category: TransportCategory;
	fromX: number;
	fromY: number;
	fromFloor: number;
	toX: number;
	toY: number;
	toFloor: number;
	distanceFromExit: number; // How close player is to the exit location
}

// State - uses framebuffer-based PassivePlayerTracker for instant reads
let passiveTracker: import("@injection/util/playerPosition").PassivePlayerTracker | null = null;
let currentPosition: PlayerPositionData | null = null;
// Support multiple position callbacks (pathfinding, minimap, etc.)
const positionCallbacks = new Map<string, (position: PlayerPositionData) => void>();
let transportCallback: ((transport: DetectedTransport) => void) | null = null;
let floorChangeCallback: ((newFloor: number, oldFloor: number) => void) | null = null;
let pollingInterval: ReturnType<typeof setInterval> | null = null;
let lastPreloadPosition: { x: number; y: number; floor: number } | null = null;
let lastDetectedPosition: { x: number; y: number; floor: number } | null = null; // For teleport detection
const PRELOAD_MOVE_THRESHOLD = 30; // Only re-preload if moved 30+ tiles
const TELEPORT_DETECTION_THRESHOLD = 50; // tiles - if player moves more than this, check for teleport

// Transport detection state
let cachedTransports: TransportLink[] | null = null;
let transportsLoading = false;
let initialFloorProbed = false; // Flag to ensure we only probe initial floor once
const TRANSPORT_DETECTION_RADIUS = 2; // tiles - how close player must be to transport exit (reduced from 5)

// Teleport suppression state - hide overlays briefly during teleport transitions
let isTeleporting = false;
let teleportSuppressUntil = 0;
const TELEPORT_SUPPRESSION_MS = 500; // Hide overlays for 500ms after teleport detected

// Teleport event callbacks - overlays can subscribe to hide/show during teleports
const teleportCallbacks = new Map<string, (isTeleporting: boolean) => void>();
let teleportCallbackIdCounter = 0;

// Transport-based floor tracking state
// Floor detection via Y height is UNRELIABLE because hills can reach floor 1 heights
// Instead, we track floor changes via vertical transport usage (stairs, ladders, etc.)
let trackedFloor = 0; // Current tracked floor (default to 0 until transport changes it)
let floorConfidence: "assumed" | "confirmed" = "assumed"; // Confidence level

// Debouncing for floor changes - prevent rapid bouncing
let lastFloorChangeTime = 0;
const FLOOR_CHANGE_COOLDOWN_MS = 2000; // Minimum time between floor changes (2 seconds)

// Y-based floor detection (for floor 1+)
let lastY = 0;
const Y_FLOOR_CHANGE_THRESHOLD = 800; // Y units that indicate a floor change (roughly 1 floor)

// Raw Y logging for floor data gathering (enable via debug)
const ENABLE_Y_LOGGING = false; // Set to true to log raw Y values for analysis
const Y_LOG_INTERVAL = 5000; // Log every 5 seconds
let lastYLogTime = 0;

// Vertical transport types that actually change floors
const FLOOR_CHANGING_TYPES = new Set([
	"stairs", "staircase", "stairway",
	"ladder",
	"trapdoor",
	"rope",
	"climb",
]);

/**
 * Check if a transport type changes floors (vertical movement)
 */
function isFloorChangingTransport(transportType: string): boolean {
	const lower = transportType.toLowerCase();
	if (FLOOR_CHANGING_TYPES.has(lower)) return true;
	return lower.includes("stair") || lower.includes("ladder") ||
	       lower.includes("trapdoor") || lower.includes("climb");
}

/**
 * Log raw Y value for floor data gathering (when enabled)
 */
function logRawY(yTileUnits: number, gameX: number, gameY: number): void {
	if (!ENABLE_Y_LOGGING) return;
	const now = Date.now();
	if (now - lastYLogTime < Y_LOG_INTERVAL) return;
	lastYLogTime = now;
	// Removed per-poll logging for performance
}

// Terrain validation state
let lastTerrainCheckTime = 0;
const TERRAIN_CHECK_INTERVAL = 3000; // Check terrain every 3 seconds
const HEIGHT_TOLERANCE = 200; // Accept if within 200 units of terrain height

/**
 * Validate/detect floor using terrain height data from runeapps
 * Compares player Y against mapheight data for all levels to find best match
 *
 * IMPORTANT: Terrain detection can only be used to go DOWN floors (1→0, 2→1, etc.)
 * Going UP floors (0→1, 1→2) MUST happen via vertical transport detection.
 * This is because hills on floor 0 can reach floor 1 heights, causing false positives.
 *
 * Returns the detected floor if confident, or null to keep current
 */
async function validateFloorWithTerrain(
	playerY: number, // In raw GL units
	lat: number,
	lng: number,
	currentFloor: number
): Promise<number | null> {
	const now = Date.now();
	if (now - lastTerrainCheckTime < TERRAIN_CHECK_INTERVAL) return null;
	lastTerrainCheckTime = now;

	try {
		// Convert player Y to same units as terrain height (TILE_SIZE = 512)
		const playerHeight = playerY * TILE_SIZE;

		// Find best matching level from terrain data
		const bestMatch = await findBestLevelForHeight(lat, lng, playerHeight);

		if (!bestMatch) {
			// No terrain data available - keep current floor
			return null;
		}

		// Check if player is close to the terrain height at this level
		const heightDiff = Math.abs(playerHeight - bestMatch.height);

		if (heightDiff > HEIGHT_TOLERANCE * 2) {
			// Player is far from any known terrain - could be on a bridge, stairs, etc.
			// Don't change floor in this case
			return null;
		}

		if (bestMatch.level !== currentFloor) {
			// Terrain suggests a different floor
			// CRITICAL: Only allow terrain detection to go DOWN floors, never UP
			// Going UP must happen via vertical transport (stairs, ladders, etc.)
			// Hills on floor 0 can reach floor 1 heights, so we can't trust terrain for 0→1
			if (bestMatch.level > currentFloor) {
				// Terrain says we went UP - ignore this, only transports can do that
				return null;
			}

			// Terrain says we went DOWN - this is more reliable
			// (if we're on floor 1+ and terrain says floor 0, we probably went down)
			if (floorConfidence === "assumed") {
				// Not confirmed via transport - trust terrain for going DOWN
				return bestMatch.level;
			}
			// If we've confirmed via transport, only override going DOWN if very confident
			if (heightDiff < HEIGHT_TOLERANCE / 2) {
				return bestMatch.level;
			}
		}

		return null;
	} catch (e) {
		// Terrain check failed - keep current floor
		return null;
	}
}

/**
 * Check if player arrived at a transport exit and should change floors
 * Returns the new floor if a transport was used, or null if no transport detected
 *
 * IMPORTANT: Only triggers if the transport STARTS from the player's current floor.
 * This prevents false positives when walking past transports.
 */
function checkTransportArrival(
	gameX: number,
	gameY: number,
	currentFloor: number
): number | null {
	if (!cachedTransports) return null;

	// Check all transports for exit locations near player
	for (const transport of cachedTransports) {
		// API returns snake_case: to_x, to_y, to_floor
		const t = transport as any;
		const fromFloor = t.from_floor ?? t.fromLevel ?? 0;
		const toX = t.to_x ?? t.toX;
		const toY = t.to_y ?? t.toY;
		const toFloor = t.to_floor ?? t.toLevel ?? 0;

		// Skip if transport doesn't START from current floor
		// This prevents false positives when walking past transports
		if (fromFloor !== currentFloor) continue;

		// Skip if transport exit is on the same floor (no floor change needed)
		if (toFloor === currentFloor) continue;

		// Check if player is within detection radius of transport exit
		const dx = Math.abs(gameX - toX);
		const dy = Math.abs(gameY - toY);

		if (dx <= TRANSPORT_DETECTION_RADIUS && dy <= TRANSPORT_DETECTION_RADIUS) {
			return toFloor;
		}
	}

	return null;
}

/**
 * Check if player arrived at a VERTICAL transport exit (stairs, ladder, etc.)
 * Only these transports can change your floor level.
 * Teleports/boats etc. don't actually change floor in the game's floor system.
 * Returns the new floor if a vertical transport was used, or null if no match
 *
 * IMPORTANT: Only triggers if the transport STARTS from the player's current floor.
 * This prevents false positives when walking past stairs (entry/exit share X,Y coordinates).
 */
function checkVerticalTransportArrival(
	gameX: number,
	gameY: number,
	currentFloor: number
): number | null {
	if (!cachedTransports) return null;

	// Check all transports for exit locations near player
	for (const transport of cachedTransports) {
		const t = transport as any;
		const transportType = t.transport_type ?? t.transportType ?? "";

		// Only consider vertical transports (stairs, ladders, trapdoors, ropes)
		if (!isFloorChangingTransport(transportType)) continue;

		const fromFloor = t.from_floor ?? t.fromLevel ?? 0;
		const toX = t.to_x ?? t.toX;
		const toY = t.to_y ?? t.toY;
		const toFloor = t.to_floor ?? t.toLevel ?? 0;

		// Skip if transport doesn't START from current floor
		// This prevents false positives when walking past stairs (entry/exit overlap in X,Y)
		if (fromFloor !== currentFloor) continue;

		// Skip if transport exit is on the same floor (no floor change)
		if (toFloor === currentFloor) continue;

		// Check if player is within detection radius of transport exit
		const dx = Math.abs(gameX - toX);
		const dy = Math.abs(gameY - toY);

		if (dx <= TRANSPORT_DETECTION_RADIUS && dy <= TRANSPORT_DETECTION_RADIUS) {
			return toFloor;
		}
	}

	return null;
}

/**
 * Detect which transport the player used by matching their position to transport exits
 * Returns the best matching transport with all details, or null if no match found
 *
 * Categories of transports that can be detected:
 * - Teleports (spells, jewelry, scrolls)
 * - Lodestones
 * - Fairy Rings
 * - Spirit Trees
 * - Portals (POH, World Gate, etc.)
 * - Gnome Gliders
 * - Balloons
 * - Eagles
 * - Magic Carpets
 * - Minecarts
 * - Gnome Carts
 * - Boats/Ships (Charter Ships, Canoes, etc.)
 */
function detectUsedTransport(
	gameX: number,
	gameY: number,
	floor: number
): DetectedTransport | null {
	if (!cachedTransports || cachedTransports.length === 0) return null;

	let bestMatch: DetectedTransport | null = null;
	let bestDistance = Infinity;

	for (const transport of cachedTransports) {
		const t = transport as any;
		const toX = t.to_x ?? t.toX ?? 0;
		const toY = t.to_y ?? t.toY ?? 0;
		const toFloor = t.to_floor ?? t.toLevel ?? 0;
		const fromX = t.from_x ?? t.fromX ?? 0;
		const fromY = t.from_y ?? t.fromY ?? 0;
		const fromFloor = t.from_floor ?? t.fromLevel ?? 0;
		const transportType = t.transport_type ?? t.transportType ?? "";
		const name = t.name || "";

		// Must match floor
		if (toFloor !== floor) continue;

		// Calculate distance from player to transport exit
		const dx = Math.abs(gameX - toX);
		const dy = Math.abs(gameY - toY);
		const distance = Math.sqrt(dx * dx + dy * dy);

		// Must be within detection radius
		if (distance > TRANSPORT_DETECTION_RADIUS) continue;

		// Found a closer match
		if (distance < bestDistance) {
			bestDistance = distance;
			bestMatch = {
				transport,
				name: name || transportType || "Unknown transport",
				type: transportType,
				category: getTransportCategory(transportType),
				fromX,
				fromY,
				fromFloor,
				toX,
				toY,
				toFloor,
				distanceFromExit: distance,
			};
		}
	}

	return bestMatch;
}

/**
 * Check if a position change looks like a teleport (large horizontal distance moved)
 * Floor changes alone don't count as teleports - normal ladders/stairs are fine.
 * Only large horizontal movements trigger overlay suppression.
 */
function isTeleportLikeMovement(
	oldX: number, oldY: number, _oldFloor: number,
	newX: number, newY: number, _newFloor: number
): boolean {
	// Only check horizontal distance - floor changes are normal gameplay
	// and don't cause the matrix instability that requires overlay hiding
	const dx = Math.abs(newX - oldX);
	const dy = Math.abs(newY - oldY);
	const distance = Math.sqrt(dx * dx + dy * dy);

	return distance > TELEPORT_DETECTION_THRESHOLD;
}

/**
 * Probe for the player's initial floor by checking ALL transport entry/exit locations
 * This is called once when tracking starts to determine which floor the player is on
 * Returns the most likely floor based on proximity to transport locations
 *
 * Checks BOTH:
 * - Transport EXIT locations (toX, toY) -> player is on toLevel
 * - Transport ENTRY locations (fromX, fromY) -> player is on fromLevel
 */
function probeInitialFloor(gameX: number, gameY: number): number {
	if (!cachedTransports || cachedTransports.length === 0) {
		return 0;
	}

	const INITIAL_PROBE_RADIUS = 15; // Smaller radius to avoid false positives
	const ENTRY_PRIORITY_RADIUS = 10; // Even smaller radius for high-confidence entry detection

	// PRIORITY 1: Find transport ENTRIES nearby (doors, ladders, stairs on this floor)
	// If player is on floor 1, they should be near a transport that STARTS from floor 1
	let closestEntryFloor = 0;
	let closestEntryDistance = Infinity;
	let closestEntryTransport: TransportLink | null = null;

	for (const transport of cachedTransports) {
		const t = transport as any;
		const fromX = t.from_x ?? t.fromX;
		const fromY = t.from_y ?? t.fromY;
		const fromFloor = t.from_floor ?? t.fromLevel ?? 0;

		// Only consider physical transports (doors, ladders, stairs, minecarts, agility shortcuts)
		const transportType = (t.transport_type ?? t.transportType ?? "").toLowerCase();
		const transportName = (t.name || "").toLowerCase();
		const physicalTypes = ["door", "ladder", "stairs", "staircase", "trapdoor", "minecart", "cart", "agility", "shortcut", "climb", "crawl", "jump", "squeeze"];
		const isPhysicalTransport = physicalTypes.some(
			type => transportType.includes(type) || transportName.includes(type)
		);

		if (!isPhysicalTransport) continue;

		const dxFrom = Math.abs(gameX - fromX);
		const dyFrom = Math.abs(gameY - fromY);
		const distFrom = Math.sqrt(dxFrom * dxFrom + dyFrom * dyFrom);

		if (distFrom <= ENTRY_PRIORITY_RADIUS && distFrom < closestEntryDistance) {
			closestEntryDistance = distFrom;
			closestEntryFloor = fromFloor;
			closestEntryTransport = transport;
		}
	}

	// If we found a nearby physical transport entry, use its floor
	if (closestEntryTransport && closestEntryDistance <= ENTRY_PRIORITY_RADIUS) {
		return closestEntryFloor;
	}

	// PRIORITY 2: Fall back to any transport entry (broader search)
	for (const transport of cachedTransports) {
		const t = transport as any;
		const fromX = t.from_x ?? t.fromX;
		const fromY = t.from_y ?? t.fromY;
		const fromFloor = t.from_floor ?? t.fromLevel ?? 0;

		const dxFrom = Math.abs(gameX - fromX);
		const dyFrom = Math.abs(gameY - fromY);
		const distFrom = Math.sqrt(dxFrom * dxFrom + dyFrom * dyFrom);

		if (distFrom <= INITIAL_PROBE_RADIUS && distFrom < closestEntryDistance) {
			closestEntryDistance = distFrom;
			closestEntryFloor = fromFloor;
			closestEntryTransport = transport;
		}
	}

	if (closestEntryTransport && closestEntryDistance <= INITIAL_PROBE_RADIUS) {
		return closestEntryFloor;
	}

	// PRIORITY 3: Only if no entries found, check exits of PHYSICAL transports only
	// Exclude spells/teleports since those are player-specific and don't indicate current floor
	let closestExitFloor = 0;
	let closestExitDistance = Infinity;
	let closestExitTransport: TransportLink | null = null;

	for (const transport of cachedTransports) {
		const t = transport as any;
		const transportType = t.transport_type ?? t.transportType ?? "";
		const transportName = (t.name || "").toLowerCase();

		// Skip player-specific transports (spells, teleports, lodestones, etc.)
		const isPlayerTeleport =
			transportType.toLowerCase().includes("spell") ||
			transportType.toLowerCase().includes("teleport") ||
			transportType.toLowerCase().includes("lodestone") ||
			transportName.includes("spell:") ||
			transportName.includes("teleport") ||
			transportName.includes("lodestone");

		if (isPlayerTeleport) continue;

		const toX = t.to_x ?? t.toX;
		const toY = t.to_y ?? t.toY;
		const toFloor = t.to_floor ?? t.toLevel ?? 0;

		const dxTo = Math.abs(gameX - toX);
		const dyTo = Math.abs(gameY - toY);
		const distTo = Math.sqrt(dxTo * dxTo + dyTo * dyTo);

		if (distTo <= INITIAL_PROBE_RADIUS && distTo < closestExitDistance) {
			closestExitDistance = distTo;
			closestExitFloor = toFloor;
			closestExitTransport = transport;
		}
	}

	if (closestExitTransport && closestExitDistance <= INITIAL_PROBE_RADIUS) {
		return closestExitFloor;
	}

	return 0;
}

/**
 * Ensure transports are loaded (called once when tracking starts)
 */
async function ensureTransportsLoaded(): Promise<void> {
	if (cachedTransports || transportsLoading) return;

	transportsLoading = true;
	try {
		cachedTransports = await transportCache.loadAll();
	} catch (e) {
		cachedTransports = [];
	} finally {
		transportsLoading = false;
	}
}

// Counter for generating unique callback IDs
let callbackIdCounter = 0;
// Mutex to prevent race conditions during initialization
let isInitializing = false;
// Promise to wait for if already initializing
let initializationPromise: Promise<boolean> | null = null;

/**
 * Start tracking player position using framebuffer-based passive overlay
 * Polls for position at the specified interval - reads are instant after init
 *
 * Supports MULTIPLE callbacks - each caller gets their own callback registered.
 * Returns a callback ID that can be used to unsubscribe later.
 *
 * @param onUpdate - Callback to receive position updates
 * @param intervalMs - Polling interval (only used on first call to start tracking)
 * @param callbackId - Optional custom ID for the callback (for named callbacks like "pathfinding", "minimap")
 */
export async function startPlayerTracking(
	onUpdate: (position: { location: NpcLocation; floor: number }) => void,
	intervalMs: number = 100, // Can poll faster now since reads are instant
	callbackId?: string
): Promise<string | false> {
	// Generate or use provided callback ID
	const id = callbackId ?? `callback_${++callbackIdCounter}`;

	// If already tracking with initialized passive tracker, just add the callback
	if (passiveTracker?.isInitialized() && pollingInterval) {
		positionCallbacks.set(id, onUpdate);
		return id;
	}

	// If currently initializing, wait for it to complete then add callback
	if (isInitializing && initializationPromise) {
		const success = await initializationPromise;
		if (success && passiveTracker?.isInitialized() && pollingInterval) {
			positionCallbacks.set(id, onUpdate);
			return id;
		}
		return false;
	}

	// Start initialization
	isInitializing = true;
	initializationPromise = (async (): Promise<boolean> => {
		try {
			// Initialize passive tracker if needed
			if (!passiveTracker || !passiveTracker.isInitialized()) {
				const playerPosModule = await import("@injection/util/playerPosition");
				passiveTracker = new playerPosModule.PassivePlayerTracker({ debug: false });

				// Initialize finds tint framebuffer and sets up passive overlay
				const initialized = await passiveTracker.init();
				if (!initialized) {
					return false;
				}
			}
			return true;
		} catch (e) {
			console.error("[PlayerTracker] Init error:", e);
			return false;
		}
	})();

	const initSuccess = await initializationPromise;
	isInitializing = false;
	initializationPromise = null;

	if (!initSuccess) {
		return false;
	}

	try {

		// Load transport data for automatic floor detection (non-blocking)
		ensureTransportsLoaded();

		// Add the callback
		positionCallbacks.set(id, onUpdate);

		// Clear any existing interval
		if (pollingInterval) {
			clearInterval(pollingInterval);
		}

		// Start polling - each poll records 1 frame to get player position
		let isPolling = false; // Prevent overlapping async calls

		pollingInterval = setInterval(async () => {
			if (!passiveTracker?.isInitialized() || isPolling) {
				return;
			}

			isPolling = true;
			try {
				// Record 1 frame and scan for player (async)
				const pos = await passiveTracker.getPositionAsync();
				if (pos) {
					// Convert GL coordinates to game coordinates for transport detection
					// pos.x = game X, pos.z = game Y (lat/lng uses: lat=pos.z, lng=pos.x)
					const gameX = Math.floor(pos.x);
					const gameY = Math.floor(pos.z);

					// Log raw Y for floor data gathering (when enabled)
					logRawY(pos.y, gameX, gameY);

					// Check if we're within the cooldown period for floor changes
					const now = Date.now();
					const canChangeFloor = now - lastFloorChangeTime >= FLOOR_CHANGE_COOLDOWN_MS;

					if (canChangeFloor) {
						// Use transport-based floor tracking (Y height is unreliable due to hills)
						// Check if player arrived at a vertical transport exit (must be within 2 tiles)
						const transportFloor = checkVerticalTransportArrival(gameX, gameY, trackedFloor);
						if (transportFloor !== null && transportFloor !== trackedFloor) {
							const oldFloor = trackedFloor;
							trackedFloor = transportFloor;
							floorConfidence = "confirmed";
							lastFloorChangeTime = now;
							lastY = pos.y; // Update Y reference
							try { floorChangeCallback?.(trackedFloor, oldFloor); } catch {}
						}

						// Y-based floor detection for floor 1+ (when on upper floors, Y drop = went down)
						// Only use this if we're already on floor 1+ and Y changed significantly
						// IMPORTANT: Y-based detection can only go DOWN floors, never UP
						// Going UP must happen via vertical transport detection (stairs, ladders, etc.)
						// Hills can cause large Y increases even on the same floor
						if (trackedFloor >= 1 && lastY !== 0) {
							const yDelta = pos.y - lastY;
							// Significant Y decrease while on floor 1+ = likely went down a floor
							if (yDelta < -Y_FLOOR_CHANGE_THRESHOLD) {
								const newFloor = Math.max(0, trackedFloor - 1);
								if (newFloor !== trackedFloor) {
									const oldFloor = trackedFloor;
									trackedFloor = newFloor;
									floorConfidence = "assumed";
									lastFloorChangeTime = now;
									try { floorChangeCallback?.(trackedFloor, oldFloor); } catch {}
								}
							}
							// NOTE: Y increase does NOT trigger floor UP - only transports can do that
							// Hills can cause Y to increase significantly without changing floors
						}
					}

					// Scene change detection: significant Y change indicates ladder/stairs/trapdoor
					// even when floor tracking can't detect the exact floor change
					// (e.g. no transport data for this ladder, or going up from floor 0).
					// Triggers tile overlay recreation to clear stale VAO-attached overlays.
					if (canChangeFloor && lastY !== 0) {
						const absYDelta = Math.abs(pos.y - lastY);
						if (absYDelta > Y_FLOOR_CHANGE_THRESHOLD && lastFloorChangeTime !== now) {
							lastFloorChangeTime = now;
							try { floorChangeCallback?.(trackedFloor, trackedFloor); } catch {}
						}
					}

					// Always update lastY for next comparison
					lastY = pos.y;

					// Validate floor using terrain height data (fallback/correction) - only if not in cooldown
					if (canChangeFloor) {
						// lat = pos.z (north/south), lng = pos.x (east/west)
						const terrainFloor = await validateFloorWithTerrain(pos.y, pos.z, pos.x, trackedFloor);
						if (terrainFloor !== null && terrainFloor !== trackedFloor) {
							const oldFloor = trackedFloor;
							trackedFloor = terrainFloor;
							lastFloorChangeTime = now;
							try { floorChangeCallback?.(trackedFloor, oldFloor); } catch {}
							// Keep confidence as "assumed" since terrain isn't as reliable as transport
						}
					}

					const floor = trackedFloor;

					currentPosition = {
						location: { lat: pos.z, lng: pos.x },
						floor,
						timestamp: Date.now(),
					};

					// Check for teleport-like movements and detect which transport was used
					if (lastDetectedPosition) {
						if (isTeleportLikeMovement(
							lastDetectedPosition.x, lastDetectedPosition.y, lastDetectedPosition.floor,
							gameX, gameY, floor
						)) {
							// Suppress callbacks during teleport transition to prevent huge/distorted overlays
							isTeleporting = true;
							teleportSuppressUntil = now + TELEPORT_SUPPRESSION_MS;

							// Notify teleport subscribers to hide overlays
							for (const cb of teleportCallbacks.values()) {
								try {
									cb(true);
								} catch (e) {
									console.error("[PlayerTracker] Teleport callback error:", e);
								}
							}

							if (transportCallback) {
								const detectedTransport = detectUsedTransport(gameX, gameY, floor);
								if (detectedTransport) {
									// Fill in the "from" details with where the player was
									detectedTransport.fromX = lastDetectedPosition.x;
									detectedTransport.fromY = lastDetectedPosition.y;
									detectedTransport.fromFloor = lastDetectedPosition.floor;
									transportCallback(detectedTransport);
								}
							}
						}
					}

					// Update last detected position for next comparison
					lastDetectedPosition = { x: gameX, y: gameY, floor };

					// Proactively preload collision data around player for faster pathfinding
					// Only preload if player has moved significantly or floor changed
					// (gameX and gameY are already calculated above for transport detection)
					const shouldPreload = !lastPreloadPosition ||
						lastPreloadPosition.floor !== floor ||
						Math.abs(gameX - lastPreloadPosition.x) > PRELOAD_MOVE_THRESHOLD ||
						Math.abs(gameY - lastPreloadPosition.y) > PRELOAD_MOVE_THRESHOLD;

					if (shouldPreload) {
						lastPreloadPosition = { x: gameX, y: gameY, floor };
						// Fire and forget - don't block position updates
						preloadCollisionData(gameX, gameY, floor, 2).catch(() => {});
					}

					// Check if teleport suppression has expired
					if (isTeleporting && now >= teleportSuppressUntil) {
						isTeleporting = false;

						// Notify teleport subscribers to show overlays again
						for (const cb of teleportCallbacks.values()) {
							try {
								cb(false);
							} catch (e) {
								console.error("[PlayerTracker] Teleport callback error:", e);
							}
						}

						// Trigger tile overlay recreation after teleport
						// Scene has settled — new VAOs are in place, stale overlays need replacing
						try { floorChangeCallback?.(trackedFloor, trackedFloor); } catch {}
					}

					// Notify all registered callbacks (unless in teleport suppression mode)
					if (!isTeleporting) {
						const callbackCount = positionCallbacks.size;
						if (callbackCount > 0) {
							for (const callback of positionCallbacks.values()) {
								try {
									callback(currentPosition);
								} catch (e) {
									console.error("[PlayerTracker] Callback error:", e);
								}
							}
						}
					}
				}
			} catch (e) {
				console.error("[PlayerTracker] Position error:", e);
			} finally {
				isPolling = false;
			}
		}, intervalMs);

		return id;
	} catch (e) {
		console.error("[PlayerTracker] Error starting tracking:", e);
		return false;
	}
}

/**
 * Stop tracking player position
 * @param preserveTracker If true, keeps the passive overlay active (recommended for performance)
 * @param callbackId Optional - if provided, only removes that specific callback (others keep running)
 */
export async function stopPlayerTracking(preserveTracker: boolean = false, callbackId?: string): Promise<void> {
	// If a specific callback ID is provided, just remove that one
	if (callbackId) {
		positionCallbacks.delete(callbackId);
		// Don't stop tracking if other callbacks are still registered
		if (positionCallbacks.size > 0) {
			return;
		}
	}

	// Stop polling if no callbacks remain or no specific ID was given
	if (pollingInterval) {
		clearInterval(pollingInterval);
		pollingInterval = null;
	}

	if (!preserveTracker && passiveTracker) {
		passiveTracker.stop();
		passiveTracker = null;
		initialFloorProbed = false; // Reset for next tracking session
	}

	// Clear all callbacks
	positionCallbacks.clear();
}

/**
 * Get the current player position (last known)
 */
export function getPlayerPosition(): PlayerPositionData | null {
	return currentPosition;
}

/**
 * Set callback to be notified when player uses a transport (teleport, lodestone, boat, etc.)
 * The callback receives details about the detected transport including:
 * - Transport name and type
 * - Source and destination coordinates
 * - Distance from exit location (for confidence)
 *
 * Pass null to unregister the callback.
 */
export function setTransportCallback(
	callback: ((transport: DetectedTransport) => void) | null
): void {
	transportCallback = callback;
}

/**
 * Set callback to be notified when the tracked floor changes.
 * Fires on vertical transport detection, Y-based floor drop, and terrain validation.
 * Used by QuestOverlayManager to recreate tile overlays after floor transitions.
 */
export function setFloorChangeCallback(
	callback: ((newFloor: number, oldFloor: number) => void) | null
): void {
	floorChangeCallback = callback;
}

/**
 * Clear the player position and reinitialize passive tracking
 */
export function clearPlayerPosition(): void {
	currentPosition = null;
	lastPreloadPosition = null;
	lastDetectedPosition = null;
	initialFloorProbed = false; // Reset so next tracking session probes floor again
	// Reset floor tracking state
	trackedFloor = 0;
	floorConfidence = "assumed";
	lastTerrainCheckTime = 0;
	// Reset teleport suppression state
	isTeleporting = false;
	teleportSuppressUntil = 0;
	// Reinit passive tracker to re-detect player mesh (e.g., after login/world hop)
	if (passiveTracker?.isInitialized()) {
		passiveTracker.reinit().catch(() => {});
	}
}

/**
 * Check if tracking is active
 */
export function isPlayerTrackingActive(): boolean {
	return pollingInterval !== null;
}

/**
 * Check if currently in teleport suppression mode
 * Overlays should hide themselves during this time to avoid distorted rendering
 */
export function isTeleportSuppressed(): boolean {
	return isTeleporting;
}

/**
 * Subscribe to teleport events - overlays can use this to hide/show during teleports
 * @param callback Called with true when teleport starts, false when teleport ends
 * @param id Optional custom ID for the callback
 * @returns Callback ID for unsubscribing
 */
export function onTeleportStateChange(
	callback: (isTeleporting: boolean) => void,
	id?: string
): string {
	const callbackId = id ?? `teleport_${++teleportCallbackIdCounter}`;
	teleportCallbacks.set(callbackId, callback);
	return callbackId;
}

/**
 * Unsubscribe from teleport events
 */
export function offTeleportStateChange(callbackId: string): void {
	teleportCallbacks.delete(callbackId);
}

/**
 * Set the player's floor (call when using transports)
 */
export function setPlayerFloor(floor: number): void {
	// Update tracked floor state
	trackedFloor = floor;
	floorConfidence = "confirmed";

	if (currentPosition) {
		currentPosition = {
			...currentPosition,
			floor,
			timestamp: Date.now(),
		};

		// Notify all registered callbacks
		for (const callback of positionCallbacks.values()) {
			try {
				callback(currentPosition);
			} catch (e) {
				console.error("[PlayerTracker] Callback error:", e);
			}
		}
	}
}

/**
 * Manually set player position (for testing or external sources)
 */
export function setManualPlayerPosition(lat: number, lng: number, floor: number): void {
	currentPosition = {
		location: { lat, lng },
		floor,
		timestamp: Date.now(),
	};

	// Notify all registered callbacks
	for (const callback of positionCallbacks.values()) {
		try {
			callback(currentPosition);
		} catch (e) {
			console.error("[PlayerTracker] Callback error:", e);
		}
	}
}

// Expose for debugging
if (typeof globalThis !== "undefined") {
	(globalThis as any).playerTracker = {
		start: startPlayerTracking,
		stop: stopPlayerTracking,
		getPosition: getPlayerPosition,
		setPosition: setManualPlayerPosition,
		setFloor: setPlayerFloor,
		clear: clearPlayerPosition,
		setTransportCallback,
		setFloorChangeCallback,
		// Floor tracking state
		getFloorState: () => ({
			floor: trackedFloor,
			confidence: floorConfidence,
			lastTerrainCheck: lastTerrainCheckTime,
		}),
		// Teleport suppression state
		getTeleportState: () => ({
			isTeleporting,
			suppressUntil: teleportSuppressUntil,
			remainingMs: isTeleporting ? Math.max(0, teleportSuppressUntil - Date.now()) : 0,
		}),
		// Debug helpers
		testTransportDetection: (gameX: number, gameY: number, floor: number) => {
			const result = detectUsedTransport(gameX, gameY, floor);
			if (result) {
				console.log(`[Debug] Found transport: ${result.name} (${result.type})`);
				console.log(`[Debug]   Exit at: (${result.toX}, ${result.toY}) floor ${result.toFloor}`);
				console.log(`[Debug]   Distance: ${result.distanceFromExit.toFixed(1)} tiles`);
			} else {
				console.log(`[Debug] No transport found at (${gameX}, ${gameY}) floor ${floor}`);
			}
			return result;
		},
		getCachedTransports: () => cachedTransports,
		getLastDetectedPosition: () => lastDetectedPosition,
	};
}
