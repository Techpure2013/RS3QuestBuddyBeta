/**
 * Pathfinding API Client
 * Communicates with the backend server for path calculations and transport data
 */

import { getApiBase } from "./base";
import {
  loadCollisionTile,
  saveCollisionTile,
  clearCollisionCache as clearIdbCollisionCache,
  invalidateCollisionTiles,
  getAllCachedTileKeys,
  isTileCached,
} from "../idb/collisionTileStore";

// Valid file coordinate ranges (from RS3QuestMapBuddy META)
// chunksX=100, chunksZ=200, chunksPerFile=20
const MAX_FILE_X = 4; // 100/20 - 1 = 4 (files 0-4)
const MAX_FILE_Y = 9; // 200/20 - 1 = 9 (files 0-9)
const MAX_FLOORS = 4; // floors 0-3

// Track collision cache version from server (updated via WebSocket)
let serverCollisionVersion: number | null = null;
let isPreloadingAll = false;
let preloadProgress: { loaded: number; total: number; errors: number } | null = null;

/**
 * Set the collision cache version from server (called from WebSocket handler)
 * If version changes, the cache will be invalidated on next fetch
 */
export function setServerCollisionVersion(version: number): void {
  if (serverCollisionVersion !== null && version !== serverCollisionVersion) {
    console.log(`[PathfindingApi] Collision cache version changed: ${serverCollisionVersion} -> ${version}, clearing cache`);
    clearIdbCollisionCache();
  }
  serverCollisionVersion = version;
}

/**
 * Get the current server collision version
 */
export function getServerCollisionVersion(): number | null {
  return serverCollisionVersion;
}

/**
 * Invalidate specific collision tiles (called when server notifies of updates)
 */
// TODO: Re-enable collision caching when ready
export async function invalidateCollisionFiles(
  _files: Array<{ floor: number; fileX: number; fileY: number }>
): Promise<void> {
  // console.log(`[PathfindingApi] Invalidating ${_files.length} collision files from server notification`);
  // await invalidateCollisionTiles(_files);
  //
  // // Re-fetch the invalidated files in the background
  // for (const file of _files) {
  //   getCollisionTiles(file.fileX, file.fileY, file.floor).catch(() => {});
  // }
}

/**
 * Preload all collision tiles on first app load
 * This fetches all collision files for ALL floors (0-3) and stores them in IndexedDB
 * Returns progress updates via callback
 *
 * Total files: 5 x 10 x 4 = 200 files (~320MB total)
 */
// TODO: Re-enable collision preloading when ready
export async function preloadAllCollisionTiles(
  _onProgress?: (loaded: number, total: number, errors: number) => void
): Promise<{ success: boolean; loaded: number; errors: number }> {
  return { success: true, loaded: 0, errors: 0 };
}

/**
 * Get current preload progress (or null if not preloading)
 */
export function getPreloadProgress(): { loaded: number; total: number; errors: number } | null {
  return preloadProgress;
}

/**
 * Check if all collision tiles are cached (all floors)
 */
export async function isCollisionCacheComplete(): Promise<boolean> {
  // We consider cache complete if we have at least floor 0 fully cached
  // Higher floors may not exist for all areas
  const expectedFloor0Count = (MAX_FILE_X + 1) * (MAX_FILE_Y + 1); // 50 files for floor 0
  const cachedKeys = await getAllCachedTileKeys();
  const floor0Count = cachedKeys.filter(k => k.floor === 0).length;
  return floor0Count >= expectedFloor0Count;
}

// ============================================================================
// Types
// ============================================================================

/** A coordinate point with x, y, and floor */
export interface PathCoordinate {
  x: number;
  y: number;
  floor: number;
}

/** A path node (may include additional metadata) */
export interface PathNode extends PathCoordinate {
  /** Distance from start in tiles */
  distance?: number;
  /** Whether this node uses a transport */
  isTransport?: boolean;
  /** Transport name if applicable */
  transportName?: string;
}

/** Transport link information */
export interface TransportLink {
  id?: number;
  name: string;
  fromX: number;
  fromY: number;
  fromLevel: number;
  toX: number;
  toY: number;
  toLevel: number;
  time: number;
  transportType?: string;
}

/** Path calculation result from the server */
export interface PathResult {
  path: PathNode[];
  distance: number;
  estimatedTime: number;
  transportsUsed: string[];
  success: boolean;
  error?: string;
  // Performance stats (optional, populated by client-side pathfinder)
  stats?: {
    iterations: number;      // Algorithm loop iterations
    nodesVisited: number;    // Tiles explored (closedSet size)
    totalTimeMs: number;     // Total time including preload
    astarTimeMs: number;     // Pure algorithm time
    preloadTimeMs: number;   // Collision data preload time
    mode?: 'astar' | 'dijkstra' | 'jps';  // Which algorithm was used
    jpsFallback?: boolean;   // True if JPS failed and fell back to A*
    jpsTimeMs?: number;      // Time spent on failed JPS attempt before fallback
  };
}

/** Collision tile data for a region */
export interface CollisionData {
  fileX: number;
  fileY: number;
  floor: number;
  data: Uint8Array | number[];
}

// ============================================================================
// Coordinate Conversion Utilities
// ============================================================================

/**
 * Convert lat/lng (map coordinates) to game x/y coordinates
 * Matches RS3QuestMapBuddy format: lat=y, lng=x
 */
export function latLngToGameCoords(lat: number, lng: number): { x: number; y: number } {
  // Map coordinates: lat = y, lng = x (matching RS3QuestMapBuddy)
  return {
    x: Math.floor(lng),
    y: Math.floor(lat),
  };
}

/**
 * Convert game x/y coordinates to lat/lng (map coordinates)
 * Matches RS3QuestMapBuddy format: lat=y, lng=x
 */
export function gameCoordsToLatLng(x: number, y: number): { lat: number; lng: number } {
  return {
    lat: y,
    lng: x,
  };
}

// ============================================================================
// API Functions
// ============================================================================

/**
 * Calculate a path between two points
 */
export async function calculatePath(
  from: PathCoordinate,
  to: PathCoordinate,
  options?: {
    useTransports?: boolean;
    maxDistance?: number;
  }
): Promise<PathResult> {
  const apiBase = getApiBase();
  const params = new URLSearchParams({
    fromX: from.x.toString(),
    fromY: from.y.toString(),
    fromFloor: from.floor.toString(),
    toX: to.x.toString(),
    toY: to.y.toString(),
    toFloor: to.floor.toString(),
  });

  if (options?.useTransports !== undefined) {
    params.append("useTransports", options.useTransports.toString());
  }
  if (options?.maxDistance !== undefined) {
    params.append("maxDistance", options.maxDistance.toString());
  }

  try {
    const response = await fetch(`${apiBase}/paths/calculate?${params}`);

    if (!response.ok) {
      return {
        path: [],
        distance: 0,
        estimatedTime: 0,
        transportsUsed: [],
        success: false,
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    const data = await response.json();
    return {
      path: data.path || [],
      distance: data.distance || 0,
      estimatedTime: data.estimatedTime || 0,
      transportsUsed: data.transportsUsed || [],
      success: true,
    };
  } catch (error) {
    return {
      path: [],
      distance: 0,
      estimatedTime: 0,
      transportsUsed: [],
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * Get all available transports
 */
export async function getTransports(options?: {
  floor?: number;
  type?: string;
  limit?: number;
}): Promise<TransportLink[]> {
  const apiBase = getApiBase();
  const params = new URLSearchParams();

  if (options?.floor !== undefined) {
    params.append("floor", options.floor.toString());
  }
  if (options?.type) {
    params.append("type", options.type);
  }
  if (options?.limit !== undefined) {
    params.append("limit", options.limit.toString());
  }

  try {
    const url = params.toString()
      ? `${apiBase}/transports?${params}`
      : `${apiBase}/transports/all`;
    const response = await fetch(url);

    if (!response.ok) {
      console.warn("Failed to fetch transports:", response.statusText);
      return [];
    }

    const data = await response.json();
    // Handle both array response and { transports: [] } response
    return Array.isArray(data) ? data : data.transports || [];
  } catch (error) {
    console.error("Error fetching transports:", error);
    return [];
  }
}

/**
 * Get transports from a specific location
 */
export async function getTransportsFrom(
  x: number,
  y: number,
  floor: number
): Promise<TransportLink[]> {
  const apiBase = getApiBase();
  const params = new URLSearchParams({
    fromX: x.toString(),
    fromY: y.toString(),
    floor: floor.toString(),
  });

  try {
    const response = await fetch(`${apiBase}/transports/from?${params}`);

    if (!response.ok) {
      return [];
    }

    const data = await response.json();
    return Array.isArray(data) ? data : data.transports || [];
  } catch (error) {
    console.error("Error fetching transports from location:", error);
    return [];
  }
}

/**
 * Check if a tile is walkable
 */
export async function isTileWalkable(
  x: number,
  y: number,
  floor: number
): Promise<boolean> {
  const apiBase = getApiBase();
  const params = new URLSearchParams({
    x: x.toString(),
    y: y.toString(),
    floor: floor.toString(),
  });

  try {
    const response = await fetch(`${apiBase}/collision/check?${params}`);

    if (!response.ok) {
      return false;
    }

    const data = await response.json();
    return data.walkable === true;
  } catch (error) {
    console.error("Error checking tile walkability:", error);
    return false;
  }
}

/**
 * Get collision data for a region (for client-side pathfinding)
 * Fetches from /api/collision/{floor}/0/{fileX}-{fileY}.png
 * Each pixel in the PNG represents collision flags for a tile (1280x1280 tiles per file)
 *
 * Uses IndexedDB cache to avoid repeated server fetches.
 * Cache is invalidated when server sends a new collision version via WebSocket.
 *
 * @param noFallback - If true, don't fall back to floor 0 when higher floor not found (used for preloading)
 */
// TODO: Re-enable collision loading when ready
// All collision file fetching and IDB loading is disabled.
export async function getCollisionTiles(
  _fileX: number,
  _fileY: number,
  _floor: number,
  _noFallback: boolean = false
): Promise<CollisionData | null> {
  return null;
}

/**
 * Simple path finding using the server's pathfinding endpoint
 * Converts lat/lng coordinates to game coordinates automatically
 */
export async function findPath(
  fromLat: number,
  fromLng: number,
  fromFloor: number,
  toLat: number,
  toLng: number,
  toFloor: number,
  useTransports: boolean = true
): Promise<PathResult> {
  const from = latLngToGameCoords(fromLat, fromLng);
  const to = latLngToGameCoords(toLat, toLng);

  return calculatePath(
    { x: from.x, y: from.y, floor: fromFloor },
    { x: to.x, y: to.y, floor: toFloor },
    { useTransports }
  );
}

/**
 * Calculate distance between two points (Euclidean)
 */
export function calculateDistance(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number }
): number {
  const dx = to.lng - from.lng;
  const dy = to.lat - from.lat;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Calculate Manhattan distance (tiles) between two points
 */
export function calculateTileDistance(
  from: PathCoordinate,
  to: PathCoordinate
): number {
  return Math.abs(to.x - from.x) + Math.abs(to.y - from.y);
}
