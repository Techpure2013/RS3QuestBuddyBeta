/**
 * Client-Side Bitwise Pathfinder
 *
 * Uses cached collision tiles with bitwise direction checking for
 * nearly instant pathfinding calculations.
 *
 * Collision data format: 8 bits for 8 directions
 * - 1 = walkable in that direction
 * - 0 = blocked in that direction
 */

import {
  getCollisionTiles,
  getTransports,
  type PathCoordinate,
  type PathNode,
  type PathResult,
  type TransportLink,
} from "./pathfindingApi";

// ============================================================================
// Transport Field Accessors (API returns snake_case, types use camelCase)
// ============================================================================

/**
 * Helper to get transport field values - handles both snake_case (API) and camelCase
 */
function getTransportFields(transport: TransportLink): {
  fromX: number;
  fromY: number;
  fromFloor: number;
  toX: number;
  toY: number;
  toFloor: number;
  time: number;
  name: string;
  transportType: string;
} {
  const t = transport as any;
  return {
    fromX: t.from_x ?? t.fromX ?? 0,
    fromY: t.from_y ?? t.fromY ?? 0,
    fromFloor: t.from_floor ?? t.fromLevel ?? 0,
    toX: t.to_x ?? t.toX ?? 0,
    toY: t.to_y ?? t.toY ?? 0,
    toFloor: t.to_floor ?? t.toLevel ?? 0,
    time: t.time ?? 1,
    name: t.name || "",
    transportType: t.transport_type ?? t.transportType ?? "",
  };
}

// ============================================================================
// Vertical Transport Types - only these can change floors
// ============================================================================

/**
 * Transport types that represent vertical movement (can change floors).
 * Only these types should be used when pathfinding between different floors.
 * Other transports (teleports, boats, etc.) move horizontally within the same floor.
 */
const VERTICAL_TRANSPORT_TYPES = new Set([
  "stairs",
  "ladder",
  "trapdoor",
  "rope",
  "staircase",
  "stairway",
]);

/**
 * Check if a transport type is vertical (can change floors)
 */
function isVerticalTransport(transportType: string): boolean {
  const lower = transportType.toLowerCase();
  // Check exact match first
  if (VERTICAL_TRANSPORT_TYPES.has(lower)) return true;
  // Also check if the name contains any vertical keywords
  return lower.includes("stair") || lower.includes("ladder") ||
         lower.includes("trapdoor") || lower.includes("climb");
}

// ============================================================================
// Direction Bits (matching server format)
// ============================================================================

export const DIRECTION_BITS = {
  WEST: 1,       // bit 0
  NORTH: 2,      // bit 1
  EAST: 4,       // bit 2
  SOUTH: 8,      // bit 3
  NORTHWEST: 16, // bit 4
  NORTHEAST: 32, // bit 5
  SOUTHEAST: 64, // bit 6
  SOUTHWEST: 128,// bit 7
} as const;

type DirectionKey = keyof typeof DIRECTION_BITS;

// Direction vectors: [dx, dy, bit, oppositeBit]
const DIRECTIONS: Array<[number, number, number, number, DirectionKey]> = [
  [-1, 0, DIRECTION_BITS.WEST, DIRECTION_BITS.EAST, "WEST"],
  [0, 1, DIRECTION_BITS.NORTH, DIRECTION_BITS.SOUTH, "NORTH"],
  [1, 0, DIRECTION_BITS.EAST, DIRECTION_BITS.WEST, "EAST"],
  [0, -1, DIRECTION_BITS.SOUTH, DIRECTION_BITS.NORTH, "SOUTH"],
  [-1, 1, DIRECTION_BITS.NORTHWEST, DIRECTION_BITS.SOUTHEAST, "NORTHWEST"],
  [1, 1, DIRECTION_BITS.NORTHEAST, DIRECTION_BITS.SOUTHWEST, "NORTHEAST"],
  [1, -1, DIRECTION_BITS.SOUTHEAST, DIRECTION_BITS.NORTHWEST, "SOUTHEAST"],
  [-1, -1, DIRECTION_BITS.SOUTHWEST, DIRECTION_BITS.NORTHEAST, "SOUTHWEST"],
];

// Diagonal directions require adjacent cardinal directions to be free
const DIAGONAL_REQUIREMENTS: Record<string, [number, number]> = {
  NORTHWEST: [DIRECTION_BITS.NORTH, DIRECTION_BITS.WEST],
  NORTHEAST: [DIRECTION_BITS.NORTH, DIRECTION_BITS.EAST],
  SOUTHEAST: [DIRECTION_BITS.SOUTH, DIRECTION_BITS.EAST],
  SOUTHWEST: [DIRECTION_BITS.SOUTH, DIRECTION_BITS.WEST],
};

// ============================================================================
// Collision Tile Cache
// ============================================================================

// Each collision file covers 20x20 chunks = 1280x1280 tiles
// Matches RS3QuestMapBuddy format: /api/collision/{floor}/0/{fileX}-{fileY}.png
const TILE_FILE_SIZE = 1280;

// Valid file coordinate ranges (from RS3QuestMapBuddy META)
// chunksX=100, chunksZ=200, chunksPerFile=20
const MAX_FILE_X = 4; // 100/20 - 1 = 4 (files 0-4)
const MAX_FILE_Y = 9; // 200/20 - 1 = 9 (files 0-9)

function isValidFileCoord(fileX: number, fileY: number): boolean {
  return fileX >= 0 && fileX <= MAX_FILE_X && fileY >= 0 && fileY <= MAX_FILE_Y;
}

interface CachedTile {
  data: Uint8Array;
  timestamp: number;
}

class CollisionCache {
  private cache = new Map<string, CachedTile>();
  private pending = new Map<string, Promise<Uint8Array | null>>();
  private maxAge = 5 * 60 * 1000; // 5 minutes
  private maxSize = 100; // Max cached regions

  private getKey(fileX: number, fileY: number, floor: number): string {
    return `${fileX}_${fileY}_${floor}`;
  }

  /**
   * SYNCHRONOUS collision byte lookup - only works if data is already cached
   * Returns null if not cached or invalid
   */
  getCollisionByteSync(x: number, y: number, floor: number): number | null {
    const fileX = Math.floor(x / TILE_FILE_SIZE);
    const fileY = Math.floor(y / TILE_FILE_SIZE);

    if (!isValidFileCoord(fileX, fileY)) return null;

    const key = this.getKey(fileX, fileY, floor);
    const cached = this.cache.get(key);
    if (!cached) return null;

    const localX = ((x % TILE_FILE_SIZE) + TILE_FILE_SIZE) % TILE_FILE_SIZE;
    const localY = ((y % TILE_FILE_SIZE) + TILE_FILE_SIZE) % TILE_FILE_SIZE;
    const index = localY * TILE_FILE_SIZE + localX;

    if (index < 0 || index >= cached.data.length) return null;
    return cached.data[index];
  }

  /**
   * Get collision byte for a specific tile (async)
   * Returns null if data not available or tile is outside valid world bounds
   */
  async getCollisionByte(x: number, y: number, floor: number): Promise<number | null> {
    const fileX = Math.floor(x / TILE_FILE_SIZE);
    const fileY = Math.floor(y / TILE_FILE_SIZE);

    // Check if file is within valid bounds
    if (!isValidFileCoord(fileX, fileY)) {
      return null; // Outside world bounds = blocked
    }

    // Use modulo with correction for negative numbers (matches RS3QuestMapBuddy)
    const localX = ((x % TILE_FILE_SIZE) + TILE_FILE_SIZE) % TILE_FILE_SIZE;
    const localY = ((y % TILE_FILE_SIZE) + TILE_FILE_SIZE) % TILE_FILE_SIZE;

    const data = await this.getTileData(fileX, fileY, floor);
    if (!data) return null;

    // Data is stored row by row: index = localY * 1280 + localX
    const index = localY * TILE_FILE_SIZE + localX;
    if (index < 0 || index >= data.length) return null;

    return data[index];
  }

  /**
   * Get collision data for a file region
   */
  async getTileData(fileX: number, fileY: number, floor: number): Promise<Uint8Array | null> {
    const key = this.getKey(fileX, fileY, floor);

    // Check cache
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.timestamp < this.maxAge) {
      return cached.data;
    }

    // Check if already fetching
    const pending = this.pending.get(key);
    if (pending) {
      return pending;
    }

    // Fetch from server
    const fetchPromise = this.fetchTileData(fileX, fileY, floor);
    this.pending.set(key, fetchPromise);

    try {
      const data = await fetchPromise;
      this.pending.delete(key);

      if (data) {
        // Evict old entries if cache is full
        if (this.cache.size >= this.maxSize) {
          this.evictOldest();
        }

        this.cache.set(key, {
          data,
          timestamp: Date.now(),
        });
      }

      return data;
    } catch (e) {
      this.pending.delete(key);
      console.warn(`[CollisionCache] Failed to fetch ${key}:`, e);
      return null;
    }
  }

  private async fetchTileData(fileX: number, fileY: number, floor: number): Promise<Uint8Array | null> {
    const result = await getCollisionTiles(fileX, fileY, floor);
    if (!result) {
      return null;
    }
    const data = result.data instanceof Uint8Array ? result.data : new Uint8Array(result.data);
    return data;
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    this.cache.forEach((value, key) => {
      if (value.timestamp < oldestTime) {
        oldestTime = value.timestamp;
        oldestKey = key;
      }
    });

    if (oldestKey) {
      this.cache.delete(oldestKey);
    }
  }

  /**
   * Preload collision data for a region around a point
   */
  async preloadRegion(centerX: number, centerY: number, floor: number, radius: number = 2): Promise<void> {
    const centerFileX = Math.floor(centerX / TILE_FILE_SIZE);
    const centerFileY = Math.floor(centerY / TILE_FILE_SIZE);

    const promises: Promise<Uint8Array | null>[] = [];

    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        const fileX = centerFileX + dx;
        const fileY = centerFileY + dy;
        // Skip invalid file coordinates
        if (isValidFileCoord(fileX, fileY)) {
          promises.push(this.getTileData(fileX, fileY, floor));
        }
      }
    }

    await Promise.all(promises);
  }

  clear(): void {
    this.cache.clear();
    this.pending.clear();
  }
}

// Singleton cache instance
const collisionCache = new CollisionCache();

// ============================================================================
// Transport Cache
// ============================================================================

interface CachedTransportRegion {
  transports: TransportLink[];
  timestamp: number;
}

class TransportCache {
  private cache = new Map<string, CachedTransportRegion>();
  private allTransports: TransportLink[] | null = null;
  private allTransportsTimestamp = 0;
  private maxAge = 10 * 60 * 1000; // 10 minutes
  private loading = false;

  /**
   * Load all transports (cached)
   */
  async loadAll(): Promise<TransportLink[]> {
    if (this.allTransports && Date.now() - this.allTransportsTimestamp < this.maxAge) {
      return this.allTransports;
    }

    if (this.loading) {
      // Wait for loading to complete
      while (this.loading) {
        await new Promise((r) => setTimeout(r, 50));
      }
      return this.allTransports || [];
    }

    this.loading = true;
    try {
      this.allTransports = await getTransports();
      this.allTransportsTimestamp = Date.now();
      return this.allTransports;
    } catch (e) {
      console.error("[TransportCache] Failed to load transports:", e);
      return [];
    } finally {
      this.loading = false;
    }
  }

  /**
   * Get transports near a location
   */
  async getNearby(x: number, y: number, floor: number, radius: number = 50): Promise<TransportLink[]> {
    const all = await this.loadAll();

    return all.filter((transport) => {
      const t = getTransportFields(transport);
      // Check if transport starts from nearby on this floor
      if (t.fromFloor === floor) {
        const dx = Math.abs(t.fromX - x);
        const dy = Math.abs(t.fromY - y);
        if (dx <= radius && dy <= radius) return true;
      }
      // Also include transports that END nearby (for reverse routing)
      if (t.toFloor === floor) {
        const dx = Math.abs(t.toX - x);
        const dy = Math.abs(t.toY - y);
        if (dx <= radius && dy <= radius) return true;
      }
      return false;
    });
  }

  /**
   * Get transports from a specific tile
   */
  async getFromTile(x: number, y: number, floor: number): Promise<TransportLink[]> {
    const all = await this.loadAll();
    return all.filter((transport) => {
      const t = getTransportFields(transport);
      return t.fromX === x && t.fromY === y && t.fromFloor === floor;
    });
  }

  /**
   * Find transport that could help reach destination faster
   */
  async findUsefulTransport(
    fromX: number,
    fromY: number,
    fromFloor: number,
    toX: number,
    toY: number,
    toFloor: number,
    maxWalkToTransport: number = 30
  ): Promise<TransportLink | null> {
    const all = await this.loadAll();

    // Direct distance to destination
    const directDist = Math.abs(toX - fromX) + Math.abs(toY - fromY);

    let bestTransport: TransportLink | null = null;
    let bestSavings = 0;

    for (const transport of all) {
      const t = getTransportFields(transport);
      // Only consider transports we can walk to
      if (t.fromFloor !== fromFloor) continue;

      const walkToTransport = Math.abs(t.fromX - fromX) + Math.abs(t.fromY - fromY);
      if (walkToTransport > maxWalkToTransport) continue;

      // Check if transport destination is closer to goal
      const distAfterTransport = Math.abs(toX - t.toX) + Math.abs(toY - t.toY);

      // Account for floor changes
      const floorMatch = t.toFloor === toFloor;
      if (!floorMatch && fromFloor === toFloor) continue; // Don't change floors if we don't need to

      // Calculate total distance using transport
      const totalWithTransport = walkToTransport + t.time + distAfterTransport;
      const savings = directDist - totalWithTransport;

      if (savings > bestSavings && savings > 10) {
        // At least 10 tiles saved
        bestSavings = savings;
        bestTransport = transport;
      }
    }

    return bestTransport;
  }

  clear(): void {
    this.cache.clear();
    this.allTransports = null;
  }
}

// Singleton transport cache
const transportCache = new TransportCache();

// ============================================================================
// Same-Floor Transport Lookup (for doors, shortcuts, etc.)
// ============================================================================

type TransportLookupMap = Map<string, TransportLink[]>;

/**
 * Build a lookup map of same-floor transports indexed by entry tile
 * This allows O(1) lookup during A* to find doors/shortcuts from current tile
 *
 * Includes: doors, agility shortcuts, squeeze-throughs, crawl-throughs, etc.
 * Excludes: teleports, spells, lodestones (player-specific magic transports)
 */
async function buildSameFloorTransportLookup(floor: number): Promise<TransportLookupMap> {
  const all = await transportCache.loadAll();
  const lookup: TransportLookupMap = new Map();

  for (const transport of all) {
    const t = getTransportFields(transport);

    // Only include same-floor transports (doors, shortcuts, etc.)
    if (t.fromFloor !== floor || t.toFloor !== floor) continue;

    // Skip teleports and spells - only use physical transports
    const transportType = t.transportType.toLowerCase();
    const transportName = t.name.toLowerCase();

    // Explicitly skip magical/player-specific transports
    const isMagicalTransport =
      transportType.includes("spell") ||
      transportType.includes("teleport") ||
      transportType.includes("lodestone") ||
      transportType.includes("fairy") ||
      transportType.includes("spirit tree") ||
      transportName.includes("spell:") ||
      transportName.includes("teleport") ||
      transportName.includes("lodestone") ||
      transportName.includes("fairy ring") ||
      transportName.includes("spirit tree");

    if (isMagicalTransport) continue;

    const key = `${t.fromX},${t.fromY}`;
    const existing = lookup.get(key) || [];
    existing.push(transport);
    lookup.set(key, existing);
  }

  return lookup;
}

/**
 * Find same-floor transports that could help get from A to B
 * Returns transports sorted by how much they help (exit closer to destination)
 */
async function findUsefulSameFloorTransports(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  floor: number,
  maxSearchRadius: number = 50
): Promise<TransportLink[]> {
  const all = await transportCache.loadAll();
  const useful: Array<{ transport: TransportLink; score: number }> = [];

  // Direct distance to destination
  const directDist = Math.abs(toX - fromX) + Math.abs(toY - fromY);

  for (const transport of all) {
    const t = getTransportFields(transport);

    // Only same-floor transports
    if (t.fromFloor !== floor || t.toFloor !== floor) continue;

    // Skip magical transports
    const transportType = t.transportType.toLowerCase();
    const transportName = t.name.toLowerCase();
    const isMagicalTransport =
      transportType.includes("spell") ||
      transportType.includes("teleport") ||
      transportType.includes("lodestone") ||
      transportType.includes("fairy") ||
      transportType.includes("spirit tree") ||
      transportName.includes("spell:") ||
      transportName.includes("teleport") ||
      transportName.includes("lodestone") ||
      transportName.includes("fairy ring") ||
      transportName.includes("spirit tree");
    if (isMagicalTransport) continue;

    // Transport entry must be within search radius of player
    const distToEntry = Math.abs(t.fromX - fromX) + Math.abs(t.fromY - fromY);
    if (distToEntry > maxSearchRadius) continue;

    // Transport exit must be within search radius of destination
    const distFromExitToDest = Math.abs(toX - t.toX) + Math.abs(toY - t.toY);
    if (distFromExitToDest > maxSearchRadius) continue;

    // For doors/shortcuts, the value is bypassing walls, not saving distance
    // Include any transport between player and destination
    // Score by weighted path length: heavily favor transports close to player (4x weight)
    // This ensures nearby doors are tried before distant ones with slightly better exit positions
    const ENTRY_WEIGHT = 4;
    const totalDist = distToEntry * ENTRY_WEIGHT + (t.time || 1) + distFromExitToDest;

    useful.push({
      transport,
      score: totalDist, // Lower score = more useful
    });
  }

  // Sort by score (nearby transports first)
  useful.sort((a, b) => a.score - b.score);

  return useful.map((u) => u.transport);
}

/**
 * Internal pathfinder that handles floor changes but NOT same-floor doors
 * Used by findPathWithSameFloorTransports to allow chaining through ladders
 * after going through a door, without causing infinite recursion.
 *
 * Flow: Player → Door → (this function) → Ladder → Destination
 */
async function findPathClientInternal(
  from: PathCoordinate,
  to: PathCoordinate,
  options: PathfinderOptions = {}
): Promise<PathResult> {
  // If different floors, use transport routing (ladders/stairs)
  if (from.floor !== to.floor) {
    return findPathWithTransports(from, to, options);
  }

  // Same floor - use simple A* without doors (to prevent recursion)
  return findPathClientSimple(from, to, options);
}

/**
 * Path through same-floor transports (doors, shortcuts)
 * First tries direct path, then tries routing through useful transports
 */
async function findPathWithSameFloorTransports(
  from: PathCoordinate,
  to: PathCoordinate,
  options: PathfinderOptions = {}
): Promise<PathResult> {
  const { maxDistance = 10000 } = options;
  const floor = from.floor;

  // First try direct path without transport waypoints
  const directPath = await findPathClientSimple(from, to, { ...options, useDoors: false });
  if (directPath.success) {
    return directPath;
  }

  // Debug: log why direct path failed
  console.log(`[SameFloorTransport] Direct path from (${from.x}, ${from.y}) to (${to.x}, ${to.y}) failed: ${directPath.error}`);

  // Direct path failed - find useful transports
  const usefulTransports = await findUsefulSameFloorTransports(
    from.x, from.y, to.x, to.y, floor, maxDistance / 2
  );

  console.log(`[SameFloorTransport] Found ${usefulTransports.length} useful same-floor transports`);
  for (const tr of usefulTransports.slice(0, 5)) {
    const tf = getTransportFields(tr);
    console.log(`[SameFloorTransport]   - ${tf.name || tf.transportType} at (${tf.fromX}, ${tf.fromY})`);
  }

  if (usefulTransports.length === 0) {
    return {
      path: [],
      distance: 0,
      estimatedTime: 0,
      transportsUsed: [],
      success: false,
      error: "No path found and no useful transports available",
    };
  }

  // Try each transport as a waypoint
  for (const transport of usefulTransports.slice(0, 10)) { // Try top 10
    const t = getTransportFields(transport);

    // Path from player to transport entry
    // Try direct path first, then try adjacent tiles (doors can't be stood on)
    let pathToTransport: PathResult | null = null;

    // Try direct path to transport entry
    pathToTransport = await findPathClientSimple(
      { x: from.x, y: from.y, floor },
      { x: t.fromX, y: t.fromY, floor },
      { ...options, maxDistance: maxDistance / 2 }
    );

    // If direct path fails, try adjacent tiles (doors/ladders are clicked from adjacent)
    if (!pathToTransport.success) {
      const adjacentOffsets: [number, number][] = [[0, 1], [0, -1], [1, 0], [-1, 0]];
      for (const [dx, dy] of adjacentOffsets) {
        const adjPath = await findPathClientSimple(
          { x: from.x, y: from.y, floor },
          { x: t.fromX + dx, y: t.fromY + dy, floor },
          { ...options, maxDistance: maxDistance / 2 }
        );
        if (adjPath.success) {
          pathToTransport = adjPath;
          break;
        }
      }
    }

    if (!pathToTransport || !pathToTransport.success) {
      // Can't reach transport entry or any adjacent tile, try next
      continue;
    }

    // Path from transport exit to destination
    // Use findPathClientInternal to allow chaining through MORE transports (ladders, etc.)
    // But disable same-floor doors to prevent infinite recursion on this segment
    let pathFromTransport: PathResult | null = null;

    // Try direct path from transport exit
    pathFromTransport = await findPathClientInternal(
      { x: t.toX, y: t.toY, floor: t.toFloor },
      to,
      { ...options, maxDistance: maxDistance - pathToTransport.distance, useDoors: false }
    );

    // If direct fails and destination is on same floor, try from adjacent tiles of exit
    // (transport exits like door exits may be on blocked tiles)
    if (!pathFromTransport.success && t.toFloor === to.floor) {
      const adjacentOffsets: [number, number][] = [[0, 1], [0, -1], [1, 0], [-1, 0]];
      for (const [dx, dy] of adjacentOffsets) {
        const adjPath = await findPathClientInternal(
          { x: t.toX + dx, y: t.toY + dy, floor: t.toFloor },
          to,
          { ...options, maxDistance: maxDistance - pathToTransport.distance, useDoors: false }
        );
        if (adjPath.success) {
          pathFromTransport = adjPath;
          break;
        }
      }
    }

    if (!pathFromTransport || !pathFromTransport.success) {
      // Can't reach destination from transport exit, try next
      continue;
    }

    // Success! Combine paths
    const combinedPath: PathNode[] = [
      ...pathToTransport.path,
      // Add transport ENTRY as a transport node (visible on source floor)
      { x: t.fromX, y: t.fromY, floor: t.fromFloor, isTransport: true },
      // Add transport EXIT as a transport node (visible on destination floor)
      { x: t.toX, y: t.toY, floor: t.toFloor, isTransport: true },
      // Skip first node of pathFromTransport (overlaps with transport exit)
      ...pathFromTransport.path.slice(1),
    ];

    const transportName = t.name || t.transportType || "Door";

    return {
      path: combinedPath,
      distance: pathToTransport.distance + t.time + pathFromTransport.distance,
      estimatedTime: pathToTransport.estimatedTime + t.time + pathFromTransport.estimatedTime,
      transportsUsed: [transportName, ...pathFromTransport.transportsUsed],
      success: true,
    };
  }

  return {
    path: [],
    distance: 0,
    estimatedTime: 0,
    transportsUsed: [],
    success: false,
    error: "No viable path through available transports",
  };
}

// ============================================================================
// JPS (Jump Point Search) Helper Functions
// ============================================================================

/**
 * Check if a tile is walkable (has collision data and isn't fully blocked)
 */
function isWalkableSync(x: number, y: number, floor: number): boolean {
  const byte = collisionCache.getCollisionByteSync(x, y, floor);
  if (byte === null) return false;
  // Fully blocked = all 8 direction bits set (0xFF)
  return byte !== 0xFF;
}

/**
 * Check if we can move from (x,y) to (x+dx, y+dy)
 */
function canMoveToSync(x: number, y: number, dx: number, dy: number, floor: number): boolean {
  const fromByte = collisionCache.getCollisionByteSync(x, y, floor);
  if (fromByte === null) return false;

  // Find direction info
  const isDiagonal = dx !== 0 && dy !== 0;
  let dirBit: number;
  let oppositeBit: number;

  // Map dx,dy to direction bit
  if (dx === 0 && dy === -1) { dirBit = DIRECTION_BITS.SOUTH; oppositeBit = DIRECTION_BITS.NORTH; }
  else if (dx === 1 && dy === 0) { dirBit = DIRECTION_BITS.EAST; oppositeBit = DIRECTION_BITS.WEST; }
  else if (dx === 0 && dy === 1) { dirBit = DIRECTION_BITS.NORTH; oppositeBit = DIRECTION_BITS.SOUTH; }
  else if (dx === -1 && dy === 0) { dirBit = DIRECTION_BITS.WEST; oppositeBit = DIRECTION_BITS.EAST; }
  else if (dx === 1 && dy === -1) { dirBit = DIRECTION_BITS.SOUTHEAST; oppositeBit = DIRECTION_BITS.NORTHWEST; }
  else if (dx === 1 && dy === 1) { dirBit = DIRECTION_BITS.NORTHEAST; oppositeBit = DIRECTION_BITS.SOUTHWEST; }
  else if (dx === -1 && dy === 1) { dirBit = DIRECTION_BITS.NORTHWEST; oppositeBit = DIRECTION_BITS.SOUTHEAST; }
  else if (dx === -1 && dy === -1) { dirBit = DIRECTION_BITS.SOUTHWEST; oppositeBit = DIRECTION_BITS.NORTHEAST; }
  else return false;

  // Check exit from current tile
  if (!canMove(fromByte, dirBit)) return false;

  // For diagonals, check cardinal components
  if (isDiagonal) {
    const cardX = dx > 0 ? DIRECTION_BITS.EAST : DIRECTION_BITS.WEST;
    const cardY = dy > 0 ? DIRECTION_BITS.NORTH : DIRECTION_BITS.SOUTH;
    if (!canMove(fromByte, cardX) || !canMove(fromByte, cardY)) return false;
  }

  // Check entry to destination tile
  const toByte = collisionCache.getCollisionByteSync(x + dx, y + dy, floor);
  if (toByte === null) return false;
  if (!canMove(toByte, oppositeBit)) return false;

  return true;
}

/**
 * JPS: Jump in a cardinal direction until finding a jump point or obstacle
 * Returns the jump point coordinates or null if none found
 */
function jumpCardinal(
  x: number, y: number,
  dx: number, dy: number,
  goalX: number, goalY: number,
  floor: number,
  maxDist: number = 100
): { x: number; y: number } | null {
  let cx = x + dx;
  let cy = y + dy;
  let dist = 0;
  let lastValidX = x;
  let lastValidY = y;

  while (dist < maxDist) {
    // Can we move here?
    if (!canMoveToSync(cx - dx, cy - dy, dx, dy, floor)) {
      // Hit obstacle - return last valid position if we moved at all
      return dist > 0 ? { x: lastValidX, y: lastValidY } : null;
    }

    lastValidX = cx;
    lastValidY = cy;

    // Reached goal?
    if (cx === goalX && cy === goalY) return { x: cx, y: cy };

    // Check for forced neighbors (obstacles creating diagonal opportunities)
    // For horizontal movement (dx != 0, dy == 0):
    if (dy === 0) {
      // Check above: if blocked but diagonally ahead is open -> forced neighbor
      if (!canMoveToSync(cx, cy, 0, 1, floor) && canMoveToSync(cx, cy, dx, 1, floor)) {
        return { x: cx, y: cy };
      }
      // Check below
      if (!canMoveToSync(cx, cy, 0, -1, floor) && canMoveToSync(cx, cy, dx, -1, floor)) {
        return { x: cx, y: cy };
      }
    }
    // For vertical movement (dx == 0, dy != 0):
    if (dx === 0) {
      // Check left
      if (!canMoveToSync(cx, cy, -1, 0, floor) && canMoveToSync(cx, cy, -1, dy, floor)) {
        return { x: cx, y: cy };
      }
      // Check right
      if (!canMoveToSync(cx, cy, 1, 0, floor) && canMoveToSync(cx, cy, 1, dy, floor)) {
        return { x: cx, y: cy };
      }
    }

    cx += dx;
    cy += dy;
    dist++;
  }

  // Hit maxDist - return last position so search can continue (for open terrain)
  return { x: lastValidX, y: lastValidY };
}

/**
 * JPS: Jump in a diagonal direction
 * Returns the jump point coordinates or null if none found
 */
function jumpDiagonal(
  x: number, y: number,
  dx: number, dy: number,
  goalX: number, goalY: number,
  floor: number,
  maxDist: number = 100
): { x: number; y: number } | null {
  let cx = x + dx;
  let cy = y + dy;
  let dist = 0;
  let lastValidX = x;
  let lastValidY = y;

  while (dist < maxDist) {
    // Can we move here diagonally?
    if (!canMoveToSync(cx - dx, cy - dy, dx, dy, floor)) {
      // Hit obstacle - return last valid position if we moved at all
      return dist > 0 ? { x: lastValidX, y: lastValidY } : null;
    }

    lastValidX = cx;
    lastValidY = cy;

    // Reached goal?
    if (cx === goalX && cy === goalY) return { x: cx, y: cy };

    // Check for forced neighbors on the diagonal
    // If horizontally blocked but diagonally open
    if (!canMoveToSync(cx, cy, -dx, 0, floor) && canMoveToSync(cx, cy, -dx, dy, floor)) {
      return { x: cx, y: cy };
    }
    // If vertically blocked but diagonally open
    if (!canMoveToSync(cx, cy, 0, -dy, floor) && canMoveToSync(cx, cy, dx, -dy, floor)) {
      return { x: cx, y: cy };
    }

    // Recursively check cardinal directions from here
    const jumpH = jumpCardinal(cx, cy, dx, 0, goalX, goalY, floor, maxDist - dist);
    if (jumpH) return { x: cx, y: cy };

    const jumpV = jumpCardinal(cx, cy, 0, dy, goalX, goalY, floor, maxDist - dist);
    if (jumpV) return { x: cx, y: cy };

    cx += dx;
    cy += dy;
    dist++;
  }

  // Hit maxDist - return last position so search can continue (for open terrain)
  return { x: lastValidX, y: lastValidY };
}

/**
 * JPS: Get all jump point successors from a node
 */
function getJPSSuccessors(
  x: number, y: number,
  parentX: number | null, parentY: number | null,
  goalX: number, goalY: number,
  floor: number,
  debug: boolean = false
): Array<{ x: number; y: number; cost: number }> {
  const successors: Array<{ x: number; y: number; cost: number }> = [];

  // If no parent (start node), check all 8 directions
  const directions: Array<[number, number]> = parentX === null || parentY === null
    ? [[0, -1], [1, 0], [0, 1], [-1, 0], [1, -1], [1, 1], [-1, 1], [-1, -1]]
    : getPrunedDirections(x, y, parentX, parentY, floor);

  if (debug) {
    console.log(`[JPS] getJPSSuccessors at (${x}, ${y}), parent: ${parentX},${parentY}, directions: ${directions.length}`);
    // Check if we can even move from this tile
    const tileByte = collisionCache.getCollisionByteSync(x, y, floor);
    console.log(`[JPS] Tile byte at (${x}, ${y}): ${tileByte !== null ? '0x' + tileByte.toString(16) : 'null'}`);
  }

  for (const [dx, dy] of directions) {
    const isDiagonal = dx !== 0 && dy !== 0;
    const jumpFn = isDiagonal ? jumpDiagonal : jumpCardinal;

    if (debug) {
      // Check why canMoveToSync fails
      const canMove = canMoveToSync(x, y, dx, dy, floor);
      console.log(`[JPS] Direction (${dx}, ${dy}): canMoveToSync=${canMove}`);
    }

    const jumpPoint = jumpFn(x, y, dx, dy, goalX, goalY, floor);

    if (jumpPoint) {
      const dist = Math.sqrt((jumpPoint.x - x) ** 2 + (jumpPoint.y - y) ** 2);
      successors.push({ x: jumpPoint.x, y: jumpPoint.y, cost: dist });
      if (debug) console.log(`[JPS] Found jump point at (${jumpPoint.x}, ${jumpPoint.y})`);
    }
  }

  if (debug) console.log(`[JPS] Total successors: ${successors.length}`);
  return successors;
}

/**
 * JPS: Get pruned directions based on parent (natural neighbors only + forced)
 */
function getPrunedDirections(
  x: number, y: number,
  parentX: number, parentY: number,
  floor: number
): Array<[number, number]> {
  const dx = Math.sign(x - parentX);
  const dy = Math.sign(y - parentY);
  const directions: Array<[number, number]> = [];

  if (dx !== 0 && dy !== 0) {
    // Diagonal movement: natural neighbors are ahead, horizontal, vertical
    if (canMoveToSync(x, y, dx, dy, floor)) directions.push([dx, dy]);
    if (canMoveToSync(x, y, dx, 0, floor)) directions.push([dx, 0]);
    if (canMoveToSync(x, y, 0, dy, floor)) directions.push([0, dy]);

    // Forced neighbors (when blocked creates diagonal opportunity)
    if (!canMoveToSync(x, y, -dx, 0, floor) && canMoveToSync(x, y, -dx, dy, floor)) {
      directions.push([-dx, dy]);
    }
    if (!canMoveToSync(x, y, 0, -dy, floor) && canMoveToSync(x, y, dx, -dy, floor)) {
      directions.push([dx, -dy]);
    }
  } else if (dx !== 0) {
    // Horizontal movement
    if (canMoveToSync(x, y, dx, 0, floor)) directions.push([dx, 0]);

    // Forced neighbors
    if (!canMoveToSync(x, y, 0, 1, floor) && canMoveToSync(x, y, dx, 1, floor)) {
      directions.push([dx, 1]);
    }
    if (!canMoveToSync(x, y, 0, -1, floor) && canMoveToSync(x, y, dx, -1, floor)) {
      directions.push([dx, -1]);
    }
  } else if (dy !== 0) {
    // Vertical movement
    if (canMoveToSync(x, y, 0, dy, floor)) directions.push([0, dy]);

    // Forced neighbors
    if (!canMoveToSync(x, y, 1, 0, floor) && canMoveToSync(x, y, 1, dy, floor)) {
      directions.push([1, dy]);
    }
    if (!canMoveToSync(x, y, -1, 0, floor) && canMoveToSync(x, y, -1, dy, floor)) {
      directions.push([-1, dy]);
    }
  }

  return directions;
}

// ============================================================================
// Main Pathfinding Functions
// ============================================================================

/**
 * Simple A* pathfinding - no transport integration
 * Used as building block for transport waypoint routing
 */
async function findPathClientSimple(
  from: PathCoordinate,
  to: PathCoordinate,
  options: PathfinderOptions = {}
): Promise<PathResult> {
  const perfStart = performance.now();
  const {
    maxIterations = 250000,  // Reduced from 2M - chunking handles long paths
    allowDiagonals = true,
    mode = 'astar',
  } = options;

  const isDijkstra = mode === 'dijkstra';
  const isJPS = mode === 'jps';

  // Same tile
  if (from.x === to.x && from.y === to.y) {
    return {
      path: [{ x: from.x, y: from.y, floor: from.floor }],
      distance: 0,
      estimatedTime: 0,
      transportsUsed: [],
      success: true,
    };
  }

  const floor = from.floor;

  // Preload collision files
  const startFileX = Math.floor(from.x / TILE_FILE_SIZE);
  const startFileY = Math.floor(from.y / TILE_FILE_SIZE);
  const goalFileX = Math.floor(to.x / TILE_FILE_SIZE);
  const goalFileY = Math.floor(to.y / TILE_FILE_SIZE);

  const minFileX = Math.max(0, Math.min(startFileX, goalFileX) - 1);
  const maxFileX = Math.min(MAX_FILE_X, Math.max(startFileX, goalFileX) + 1);
  const minFileY = Math.max(0, Math.min(startFileY, goalFileY) - 1);
  const maxFileY = Math.min(MAX_FILE_Y, Math.max(startFileY, goalFileY) + 1);

  const filesToLoad = new Set<string>();
  for (let fx = minFileX; fx <= maxFileX; fx++) {
    for (let fy = minFileY; fy <= maxFileY; fy++) {
      if (isValidFileCoord(fx, fy)) {
        filesToLoad.add(`${fx},${fy}`);
      }
    }
  }

  const preloadPromises = Array.from(filesToLoad).map((key) => {
    const [fx, fy] = key.split(",").map(Number);
    return collisionCache.getTileData(fx, fy, floor);
  });
  await Promise.all(preloadPromises);
  const perfAfterPreload = performance.now();

  // Find accessible start and end points
  const accessibleStart = await findNearestAccessible(from.x, from.y, floor);
  const accessibleEnd = await findNearestAccessible(to.x, to.y, floor);

  if (!accessibleStart) {
    console.log(`[A*Simple] No accessible tile near start (${from.x}, ${from.y}) on floor ${floor}`);
    return {
      path: [],
      distance: 0,
      estimatedTime: 0,
      transportsUsed: [],
      success: false,
      error: "No accessible tile near start position",
    };
  }

  if (!accessibleEnd) {
    console.log(`[A*Simple] No accessible tile near end (${to.x}, ${to.y}) on floor ${floor} - start was (${from.x}, ${from.y})`);
    return {
      path: [],
      distance: 0,
      estimatedTime: 0,
      transportsUsed: [],
      success: false,
      error: "No accessible tile near end position",
    };
  }

  const startX = accessibleStart.x;
  const startY = accessibleStart.y;
  const endX = accessibleEnd.x;
  const endY = accessibleEnd.y;

  // Debug: log if start/end were adjusted
  if (startX !== from.x || startY !== from.y) {
    console.log(`[A*Simple] Start adjusted from (${from.x}, ${from.y}) to (${startX}, ${startY})`);
  }
  if (endX !== to.x || endY !== to.y) {
    console.log(`[A*Simple] End adjusted from (${to.x}, ${to.y}) to (${endX}, ${endY})`);
  }

  if (startX === endX && startY === endY) {
    return {
      path: [{ x: startX, y: startY, floor }],
      distance: 0,
      estimatedTime: 0,
      transportsUsed: [],
      success: true,
    };
  }

  // A* / Dijkstra / JPS implementation (no transport logic)
  const openSet = new MinHeap();
  const closedSet = new Set<string>();
  const cameFrom = new Map<string, string>();
  const gScore = new Map<string, number>();
  // For JPS: track parent coordinates for direction pruning
  const parentCoords = new Map<string, { x: number; y: number } | null>();

  const getKey = (x: number, y: number): string => `${x},${y}`;
  const startKey = getKey(startX, startY);
  const goalKey = getKey(endX, endY);

  const heuristicWeight = isJPS ? 1.0 : 0.15; // JPS uses standard weight

  gScore.set(startKey, 0);
  parentCoords.set(startKey, null); // Start has no parent
  // Dijkstra: f = g (no heuristic), A*/JPS: f = g + h * weight
  const initialF = isDijkstra ? 0 : heuristicWeight * heuristic(startX, startY, endX, endY);
  openSet.push({
    x: startX,
    y: startY,
    floor,
    g: 0,
    f: initialF,
  });

  let iterations = 0;
  const directions = allowDiagonals ? DIRECTIONS : DIRECTIONS.slice(0, 4);
  const perfAStarStart = performance.now();

  while (!openSet.isEmpty() && iterations < maxIterations) {
    iterations++;

    const current = openSet.pop()!;
    const currentKey = getKey(current.x, current.y);

    if (currentKey === goalKey) {
      const perfEnd = performance.now();
      let path: PathNode[] = [];
      let key = goalKey;

      // For JPS, we need to interpolate between jump points
      if (isJPS) {
        const jumpPoints: PathNode[] = [];
        while (key) {
          const [x, y] = key.split(",").map(Number);
          jumpPoints.unshift({ x, y, floor });
          key = cameFrom.get(key) || "";
        }
        // Interpolate between jump points to get full path
        for (let i = 0; i < jumpPoints.length - 1; i++) {
          const from = jumpPoints[i];
          const to = jumpPoints[i + 1];
          // Bresenham-like interpolation
          let cx = from.x, cy = from.y;
          while (cx !== to.x || cy !== to.y) {
            path.push({ x: cx, y: cy, floor });
            const dx = Math.sign(to.x - cx);
            const dy = Math.sign(to.y - cy);
            cx += dx;
            cy += dy;
          }
        }
        // Add final point
        if (jumpPoints.length > 0) {
          const last = jumpPoints[jumpPoints.length - 1];
          path.push({ x: last.x, y: last.y, floor });
        }
      } else {
        // Regular A*/Dijkstra path reconstruction
        while (key) {
          const [x, y] = key.split(",").map(Number);
          path.unshift({ x, y, floor });
          key = cameFrom.get(key) || "";
        }
      }

      const algoName = isJPS ? 'JPS' : (isDijkstra ? 'Dijkstra' : 'A*');
      console.log(`[${algoName}Perf] SUCCESS: total=${(perfEnd - perfStart).toFixed(1)}ms, preload=${(perfAfterPreload - perfStart).toFixed(1)}ms, setup=${(perfAStarStart - perfAfterPreload).toFixed(1)}ms, algo=${(perfEnd - perfAStarStart).toFixed(1)}ms, iterations=${iterations}, tiles=${closedSet.size}, path=${path.length}`);

      return {
        path,
        distance: path.length - 1,
        estimatedTime: Math.ceil((path.length - 1) * 0.6),
        transportsUsed: [],
        success: true,
        stats: {
          iterations,
          nodesVisited: closedSet.size,
          totalTimeMs: perfEnd - perfStart,
          astarTimeMs: perfEnd - perfAStarStart,
          preloadTimeMs: perfAfterPreload - perfStart,
          mode,
        },
      };
    }

    if (closedSet.has(currentKey)) continue;
    closedSet.add(currentKey);

    if (isJPS) {
      // JPS: Get jump point successors
      const parent = parentCoords.get(currentKey);
      const debugJPS = iterations <= 3; // Debug first 3 iterations
      const successors = getJPSSuccessors(
        current.x, current.y,
        parent?.x ?? null, parent?.y ?? null,
        endX, endY,
        floor,
        debugJPS
      );

      for (const succ of successors) {
        const succKey = getKey(succ.x, succ.y);
        if (closedSet.has(succKey)) continue;

        const tentativeG = current.g + succ.cost;
        const existingG = gScore.get(succKey) ?? Infinity;

        if (tentativeG < existingG) {
          cameFrom.set(succKey, currentKey);
          gScore.set(succKey, tentativeG);
          parentCoords.set(succKey, { x: current.x, y: current.y });

          const succF = tentativeG + heuristicWeight * heuristic(succ.x, succ.y, endX, endY);
          openSet.push({
            x: succ.x,
            y: succ.y,
            floor,
            g: tentativeG,
            f: succF,
          });
        }
      }
    } else {
      // A* / Dijkstra: Check all immediate neighbors
      const tileByte = collisionCache.getCollisionByteSync(current.x, current.y, floor);
      if (tileByte === null) continue;

      for (const [dx, dy, dirBit, oppositeBit, dirName] of directions) {
        // Check if we can EXIT current tile in this direction
        if (!canMove(tileByte, dirBit)) continue;

        // For diagonals, check that adjacent cardinal directions are also free on current tile
        if (dirName in DIAGONAL_REQUIREMENTS) {
          const [req1, req2] = DIAGONAL_REQUIREMENTS[dirName];
          if (!canMove(tileByte, req1) || !canMove(tileByte, req2)) continue;
        }

        const nx = current.x + dx;
        const ny = current.y + dy;
        const neighborKey = getKey(nx, ny);

        if (closedSet.has(neighborKey)) continue;

        // Check if we can ENTER the neighbor tile from this direction
        const neighborByte = collisionCache.getCollisionByteSync(nx, ny, floor);
        if (neighborByte === null) continue;
        if (!canMove(neighborByte, oppositeBit)) continue;

        const moveCost = dx !== 0 && dy !== 0 ? 1.41 : 1;
        const tentativeG = current.g + moveCost;
        const existingG = gScore.get(neighborKey) ?? Infinity;

        if (tentativeG < existingG) {
          cameFrom.set(neighborKey, currentKey);
          gScore.set(neighborKey, tentativeG);

          // Dijkstra: f = g (no heuristic), A*: f = g + h * weight
          const neighborF = isDijkstra ? tentativeG : tentativeG + heuristicWeight * heuristic(nx, ny, endX, endY);
          openSet.push({
            x: nx,
            y: ny,
            floor,
            g: tentativeG,
            f: neighborF,
          });
        }
      }
    }
  }

  // Debug: log why algorithm failed
  const perfEnd = performance.now();
  const algoName = isJPS ? 'JPS' : (isDijkstra ? 'Dijkstra' : 'A*');
  const failReason = iterations >= maxIterations ? "Max iterations reached" : "No path found (open set empty)";
  console.log(`[${algoName}Perf] FAILED: total=${(perfEnd - perfStart).toFixed(1)}ms, preload=${(perfAfterPreload - perfStart).toFixed(1)}ms, setup=${(perfAStarStart - perfAfterPreload).toFixed(1)}ms, algo=${(perfEnd - perfAStarStart).toFixed(1)}ms, iterations=${iterations}, tiles=${closedSet.size}`);
  console.log(`[A*Simple] FAILED: ${failReason} - from (${startX}, ${startY}) to (${endX}, ${endY}) on floor ${floor}, explored ${closedSet.size} tiles in ${iterations} iterations`);

  // JPS fallback: if JPS fails, automatically retry with A*
  // JPS can fail on complex terrain with many obstacles where pruning eliminates valid paths
  if (isJPS) {
    console.log(`[JPS] Falling back to A* due to JPS failure...`);
    const astarResult = await findPathClientSimple(from, to, { ...options, mode: 'astar' });
    if (astarResult.success && astarResult.stats) {
      // Add JPS attempt time to stats for transparency
      astarResult.stats.jpsFallback = true;
      astarResult.stats.jpsTimeMs = perfEnd - perfStart;
    }
    return astarResult;
  }

  return {
    path: [],
    distance: 0,
    estimatedTime: 0,
    transportsUsed: [],
    success: false,
    error: iterations >= maxIterations ? "Max iterations reached" : "No path found",
    stats: {
      iterations,
      nodesVisited: closedSet.size,
      totalTimeMs: perfEnd - perfStart,
      astarTimeMs: perfEnd - perfAStarStart,
      preloadTimeMs: perfAfterPreload - perfStart,
      mode,
    },
  };
}

// ============================================================================
// Priority Queue (Min-Heap for A* / Dijkstra)
// ============================================================================

interface HeapNode {
  x: number;
  y: number;
  floor: number;
  f: number; // f = g + h (total cost)
  g: number; // cost from start
}

class MinHeap {
  private heap: HeapNode[] = [];

  push(node: HeapNode): void {
    this.heap.push(node);
    this.bubbleUp(this.heap.length - 1);
  }

  pop(): HeapNode | undefined {
    if (this.heap.length === 0) return undefined;
    if (this.heap.length === 1) return this.heap.pop();

    const result = this.heap[0];
    this.heap[0] = this.heap.pop()!;
    this.bubbleDown(0);
    return result;
  }

  isEmpty(): boolean {
    return this.heap.length === 0;
  }

  private bubbleUp(index: number): void {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.heap[parent].f <= this.heap[index].f) break;
      [this.heap[parent], this.heap[index]] = [this.heap[index], this.heap[parent]];
      index = parent;
    }
  }

  private bubbleDown(index: number): void {
    const length = this.heap.length;
    while (true) {
      const left = 2 * index + 1;
      const right = 2 * index + 2;
      let smallest = index;

      if (left < length && this.heap[left].f < this.heap[smallest].f) {
        smallest = left;
      }
      if (right < length && this.heap[right].f < this.heap[smallest].f) {
        smallest = right;
      }

      if (smallest === index) break;
      [this.heap[smallest], this.heap[index]] = [this.heap[index], this.heap[smallest]];
      index = smallest;
    }
  }
}

// ============================================================================
// Bitwise Pathfinder
// ============================================================================

interface PathfinderOptions {
  maxIterations?: number;
  allowDiagonals?: boolean;
  maxDistance?: number;
  useTransports?: boolean;
  useDoors?: boolean;  // Use same-floor transports (doors) to bypass blocked areas
  mode?: 'astar' | 'dijkstra' | 'jps';  // Algorithm mode: 'astar' (default), 'dijkstra', or 'jps' (Jump Point Search)
  chunkSize?: number;  // Max distance per pathfinding segment (default: 150 tiles)
  useChunking?: boolean;  // Enable chunked pathfinding for long distances (default: true for distances > chunkSize)
}

/**
 * Check if movement from tile is allowed in a direction using bitwise check
 */
function canMove(tileByte: number, directionBit: number): boolean {
  return (tileByte & directionBit) !== 0;
}

/**
 * Check if a tile is accessible (can be reached from any direction)
 * This checks if ANY neighbor can move INTO this tile
 */
async function isAccessible(x: number, y: number, floor: number): Promise<boolean> {
  // Check all 8 neighbors - if any can move toward this tile, it's accessible
  const checks: Array<[number, number, number]> = [
    [x - 1, y, DIRECTION_BITS.EAST],    // West neighbor can move east to us
    [x + 1, y, DIRECTION_BITS.WEST],    // East neighbor can move west to us
    [x, y - 1, DIRECTION_BITS.NORTH],   // South neighbor can move north to us
    [x, y + 1, DIRECTION_BITS.SOUTH],   // North neighbor can move south to us
    [x - 1, y + 1, DIRECTION_BITS.SOUTHEAST], // NW neighbor can move SE to us
    [x + 1, y + 1, DIRECTION_BITS.SOUTHWEST], // NE neighbor can move SW to us
    [x + 1, y - 1, DIRECTION_BITS.NORTHWEST], // SE neighbor can move NW to us
    [x - 1, y - 1, DIRECTION_BITS.NORTHEAST], // SW neighbor can move NE to us
  ];

  for (const [nx, ny, bit] of checks) {
    const neighborByte = await collisionCache.getCollisionByte(nx, ny, floor);
    if (neighborByte !== null && canMove(neighborByte, bit)) {
      return true;
    }
  }
  return false;
}

/**
 * Find nearest accessible tile to a position
 * If the exact position is blocked, search outward in a spiral pattern
 */
async function findNearestAccessible(
  x: number,
  y: number,
  floor: number,
  maxRadius: number = 10
): Promise<{ x: number; y: number } | null> {
  // First check if the original position is accessible
  if (await isAccessible(x, y, floor)) {
    return { x, y };
  }

  // Search outward in expanding squares
  for (let radius = 1; radius <= maxRadius; radius++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        // Only check the perimeter of the square
        if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;

        const checkX = x + dx;
        const checkY = y + dy;
        if (await isAccessible(checkX, checkY, floor)) {
          return { x: checkX, y: checkY };
        }
      }
    }
  }

  return null;
}

/**
 * Calculate heuristic (Chebyshev distance for diagonal movement)
 */
function heuristic(x1: number, y1: number, x2: number, y2: number): number {
  const dx = Math.abs(x2 - x1);
  const dy = Math.abs(y2 - y1);
  // Chebyshev distance with small diagonal penalty (RS3 diagonals are same speed)
  return Math.max(dx, dy) + 0.2 * Math.min(dx, dy);
}

/**
 * Find path that requires floor changes using transports
 * Multi-stage: path to transport -> use transport -> path to destination
 */
async function findPathWithTransports(
  from: PathCoordinate,
  to: PathCoordinate,
  options: PathfinderOptions = {}
): Promise<PathResult> {
  const { maxDistance = 10000 } = options;

  // Multi-floor path needed

  // Load all transports
  const allTransports = await transportCache.loadAll();

  // Find transports that go from current floor toward target floor
  // For multi-floor journeys, we may need to chain transports
  // IMPORTANT: Only use vertical transports (stairs, ladders, trapdoors) for floor changes
  const relevantTransports = allTransports.filter((transport) => {
    const t = getTransportFields(transport);
    // Transport must start on our floor
    if (t.fromFloor !== from.floor) return false;

    // Transport must actually change floors (not same-floor transport)
    if (t.toFloor === t.fromFloor) return false;

    // CRITICAL: Only vertical transports can change floors
    // Teleports, boats, etc. move horizontally within the game world
    if (!isVerticalTransport(t.transportType) && !isVerticalTransport(t.name)) {
      return false;
    }

    // Transport should bring us closer to target floor or reach it
    const currentFloorDiff = Math.abs(to.floor - from.floor);
    const afterTransportFloorDiff = Math.abs(to.floor - t.toFloor);

    // Accept if it gets us to target floor or closer
    return afterTransportFloorDiff < currentFloorDiff || t.toFloor === to.floor;
  });

  if (relevantTransports.length === 0) {
    return {
      path: [],
      distance: 0,
      estimatedTime: 0,
      transportsUsed: [],
      success: false,
      error: `No transports available from floor ${from.floor} to ${to.floor}`,
    };
  }


  // STEP-BY-STEP APPROACH: Sort by distance to transport entry only
  // We use a greedy approach - just find the NEAREST transport that moves toward the goal floor.
  // The path will recalculate after each transport, so we don't need to optimize the whole journey.
  type TransportCandidate = {
    transport: TransportLink;
    distToTransport: number;
  };

  const candidates: TransportCandidate[] = [];

  for (const transport of relevantTransports) {
    const tf = getTransportFields(transport);
    // Distance from player to transport entry
    const distToTransport = Math.abs(tf.fromX - from.x) + Math.abs(tf.fromY - from.y);

    // Skip if transport is too far to walk to
    if (distToTransport > maxDistance) continue;

    candidates.push({
      transport,
      distToTransport,
    });
  }

  // Sort by distance to transport entry (nearest first)
  candidates.sort((a, b) => a.distToTransport - b.distToTransport);

  // Debug: log top candidates
  console.log(`[Pathfinder] Found ${candidates.length} transport candidates from floor ${from.floor} to ${to.floor}`);
  for (const c of candidates.slice(0, 5)) {
    const tf = getTransportFields(c.transport);
    console.log(`[Pathfinder] Candidate: ${tf.name || tf.transportType} at (${tf.fromX}, ${tf.fromY}), dist=${c.distToTransport}`);
  }

  // PROXIMITY TRUST THRESHOLD: If a transport is within this distance, trust it
  // even if A* fails (collision data can be unreliable for some areas)
  const PROXIMITY_TRUST_THRESHOLD = 15;

  // Try each candidate until we find one that works
  for (const candidate of candidates.slice(0, 10)) { // Try top 10 candidates
    const { transport, distToTransport } = candidate;
    const tf = getTransportFields(transport);

    console.log(`[Pathfinder] Trying transport: ${tf.name || tf.transportType} at (${tf.fromX}, ${tf.fromY})`);

    // Path from start to transport entry (same floor)
    // Use findPathWithSameFloorTransports to explicitly route through doors if needed
    let pathToTransport = await findPathWithSameFloorTransports(
      { x: from.x, y: from.y, floor: from.floor },
      { x: tf.fromX, y: tf.fromY, floor: from.floor },
      { ...options, maxDistance: maxDistance / 2 }
    );

    // PROXIMITY BYPASS: If transport is very close but A* failed (bad collision data),
    // create a simple direct path. Player can see nearby transports and walk to them.
    if (!pathToTransport.success && distToTransport <= PROXIMITY_TRUST_THRESHOLD) {
      console.log(`[Pathfinder] A* failed but transport is close (${distToTransport} tiles) - using proximity bypass`);
      // Create straight-line path with intermediate points for smoother tube rendering
      const directPath: PathNode[] = [];
      const steps = Math.max(2, Math.ceil(distToTransport / 2)); // One point every ~2 tiles
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        directPath.push({
          x: Math.round(from.x + (tf.fromX - from.x) * t),
          y: Math.round(from.y + (tf.fromY - from.y) * t),
          floor: from.floor,
        });
      }
      pathToTransport = {
        path: directPath,
        distance: distToTransport,
        estimatedTime: Math.ceil(distToTransport * 0.6),
        transportsUsed: [],
        success: true,
      };
    }

    if (!pathToTransport.success) {
      console.log(`[Pathfinder] Failed to path to transport: ${pathToTransport.error}`);
      continue;
    }

    // If transport lands on target floor, path from transport to destination
    if (tf.toFloor === to.floor) {
      // Use simple A* for the exit leg (no doors needed, we're already through)
      const pathFromTransport = await findPathClientSimple(
        { x: tf.toX, y: tf.toY, floor: tf.toFloor },
        { x: to.x, y: to.y, floor: to.floor },
        { ...options, maxDistance: maxDistance / 2 }
      );

      if (!pathFromTransport.success) {
        continue;
      }

      // Combine paths: path to transport + transport node + path from transport
      const combinedPath: PathNode[] = [
        ...pathToTransport.path,
        // Add transport ENTRY marker (visible on source floor)
        { x: tf.fromX, y: tf.fromY, floor: tf.fromFloor, isTransport: true },
        // Add transport EXIT marker (visible on destination floor)
        { x: tf.toX, y: tf.toY, floor: tf.toFloor, isTransport: true },
        // Skip first node of pathFromTransport as it overlaps with transport exit
        ...pathFromTransport.path.slice(1),
      ];

      const transportName = tf.name || tf.transportType || `Transport (${tf.fromFloor}->${tf.toFloor})`;

      console.log(`[Pathfinder] SUCCESS using transport: ${transportName} at (${tf.fromX}, ${tf.fromY})`);
      return {
        path: combinedPath,
        distance: pathToTransport.distance + tf.time + pathFromTransport.distance,
        estimatedTime: pathToTransport.estimatedTime + tf.time + pathFromTransport.estimatedTime,
        transportsUsed: [...pathToTransport.transportsUsed, transportName],
        success: true,
      };
    } else {
      // Transport doesn't reach target floor - need to chain another transport
      // Recursively find path from transport exit to destination
      const pathFromTransport = await findPathWithTransports(
        { x: tf.toX, y: tf.toY, floor: tf.toFloor },
        to,
        { ...options, maxDistance: maxDistance - candidate.distToTransport }
      );

      if (!pathFromTransport.success) {
        continue;
      }

      // Combine paths
      const combinedPath: PathNode[] = [
        ...pathToTransport.path,
        // Add transport ENTRY marker (visible on source floor)
        { x: tf.fromX, y: tf.fromY, floor: tf.fromFloor, isTransport: true },
        // Add transport EXIT marker (visible on destination floor)
        { x: tf.toX, y: tf.toY, floor: tf.toFloor, isTransport: true },
        ...pathFromTransport.path.slice(1),
      ];

      const transportName = tf.name || tf.transportType || `Transport (${tf.fromFloor}->${tf.toFloor})`;

      return {
        path: combinedPath,
        distance: pathToTransport.distance + tf.time + pathFromTransport.distance,
        estimatedTime: pathToTransport.estimatedTime + tf.time + pathFromTransport.estimatedTime,
        transportsUsed: [...pathToTransport.transportsUsed, transportName, ...pathFromTransport.transportsUsed],
        success: true,
      };
    }
  }

  // FALLBACK: If A* pathfinding failed but we have transport candidates,
  // generate a simple hint path: player → transport → destination
  // This gives the user a visual guide even if we can't find the exact walkable route
  if (candidates.length > 0) {
    const bestCandidate = candidates[0]; // Nearest transport
    const tf = getTransportFields(bestCandidate.transport);
    const transportName = tf.name || tf.transportType || `Transport (${tf.fromFloor}->${tf.toFloor})`;

    console.log(`[Pathfinder] Using fallback hint path via ${transportName}`);

    // Generate simple straight-line hint path
    const hintPath: PathNode[] = [];

    // Add intermediate points from player to transport (for smooth tube rendering)
    const stepsToTransport = Math.max(2, Math.ceil(bestCandidate.distToTransport / 5));
    for (let i = 0; i <= stepsToTransport; i++) {
      const t = i / stepsToTransport;
      hintPath.push({
        x: Math.round(from.x + (tf.fromX - from.x) * t),
        y: Math.round(from.y + (tf.fromY - from.y) * t),
        floor: from.floor,
      });
    }

    // Add transport markers
    hintPath.push({ x: tf.fromX, y: tf.fromY, floor: tf.fromFloor, isTransport: true });
    hintPath.push({ x: tf.toX, y: tf.toY, floor: tf.toFloor, isTransport: true });

    // Add intermediate points from transport exit to destination
    const distFromTransport = Math.abs(to.x - tf.toX) + Math.abs(to.y - tf.toY);
    const stepsFromTransport = Math.max(2, Math.ceil(distFromTransport / 5));
    for (let i = 1; i <= stepsFromTransport; i++) {
      const t = i / stepsFromTransport;
      hintPath.push({
        x: Math.round(tf.toX + (to.x - tf.toX) * t),
        y: Math.round(tf.toY + (to.y - tf.toY) * t),
        floor: tf.toFloor,
      });
    }

    return {
      path: hintPath,
      distance: bestCandidate.distToTransport + tf.time + distFromTransport,
      estimatedTime: Math.ceil((bestCandidate.distToTransport + distFromTransport) * 0.6) + tf.time,
      transportsUsed: [transportName],
      success: true, // Mark as success so path is drawn
    };
  }

  return {
    path: [],
    distance: 0,
    estimatedTime: 0,
    transportsUsed: [],
    success: false,
    error: `No viable transport path found from floor ${from.floor} to ${to.floor}`,
  };
}

/**
 * Same-floor pathfinding helper (internal use)
 */
async function findPathClientSameFloor(
  from: PathCoordinate,
  to: PathCoordinate,
  options: PathfinderOptions = {}
): Promise<PathResult> {
  const {
    maxIterations = 250000,  // Reduced from 2M - chunking handles long paths
    allowDiagonals = true,
    useDoors = true, // Enable same-floor transport usage by default
  } = options;

  // Same tile
  if (from.x === to.x && from.y === to.y) {
    return {
      path: [{ x: from.x, y: from.y, floor: from.floor }],
      distance: 0,
      estimatedTime: 0,
      transportsUsed: [],
      success: true,
    };
  }

  const floor = from.floor;

  // Preload collision files covering the path area
  const startFileX = Math.floor(from.x / TILE_FILE_SIZE);
  const startFileY = Math.floor(from.y / TILE_FILE_SIZE);
  const goalFileX = Math.floor(to.x / TILE_FILE_SIZE);
  const goalFileY = Math.floor(to.y / TILE_FILE_SIZE);

  const minFileX = Math.max(0, Math.min(startFileX, goalFileX) - 1);
  const maxFileX = Math.min(MAX_FILE_X, Math.max(startFileX, goalFileX) + 1);
  const minFileY = Math.max(0, Math.min(startFileY, goalFileY) - 1);
  const maxFileY = Math.min(MAX_FILE_Y, Math.max(startFileY, goalFileY) + 1);

  const filesToLoad = new Set<string>();
  for (let fx = minFileX; fx <= maxFileX; fx++) {
    for (let fy = minFileY; fy <= maxFileY; fy++) {
      if (isValidFileCoord(fx, fy)) {
        filesToLoad.add(`${fx},${fy}`);
      }
    }
  }

  const preloadPromises = Array.from(filesToLoad).map((key) => {
    const [fx, fy] = key.split(",").map(Number);
    return collisionCache.getTileData(fx, fy, floor);
  });
  await Promise.all(preloadPromises);

  // Build same-floor transport lookup if doors are enabled
  const transportLookup = useDoors ? await buildSameFloorTransportLookup(floor) : new Map();

  // Find accessible start and end points
  const accessibleStart = await findNearestAccessible(from.x, from.y, floor);
  const accessibleEnd = await findNearestAccessible(to.x, to.y, floor);

  if (!accessibleStart) {
    return {
      path: [],
      distance: 0,
      estimatedTime: 0,
      transportsUsed: [],
      success: false,
      error: "No accessible tile near start position",
    };
  }

  if (!accessibleEnd) {
    return {
      path: [],
      distance: 0,
      estimatedTime: 0,
      transportsUsed: [],
      success: false,
      error: "No accessible tile near end position",
    };
  }

  const startX = accessibleStart.x;
  const startY = accessibleStart.y;
  const endX = accessibleEnd.x;
  const endY = accessibleEnd.y;

  if (startX === endX && startY === endY) {
    return {
      path: [{ x: startX, y: startY, floor }],
      distance: 0,
      estimatedTime: 0,
      transportsUsed: [],
      success: true,
    };
  }

  // A* implementation
  const openSet = new MinHeap();
  const closedSet = new Set<string>();
  const cameFrom = new Map<string, string>();
  const gScore = new Map<string, number>();

  const getKey = (x: number, y: number): string => `${x},${y}`;
  const startKey = getKey(startX, startY);
  const goalKey = getKey(endX, endY);

  const heuristicWeight = 2.0;

  gScore.set(startKey, 0);
  openSet.push({
    x: startX,
    y: startY,
    floor,
    g: 0,
    f: heuristicWeight * heuristic(startX, startY, endX, endY),
  });

  let iterations = 0;
  const directions = allowDiagonals ? DIRECTIONS : DIRECTIONS.slice(0, 4);

  while (!openSet.isEmpty() && iterations < maxIterations) {
    iterations++;

    const current = openSet.pop()!;
    const currentKey = getKey(current.x, current.y);

    if (currentKey === goalKey) {
      const path: PathNode[] = [];
      let key = goalKey;

      while (key) {
        const [x, y] = key.split(",").map(Number);
        path.unshift({ x, y, floor });
        key = cameFrom.get(key) || "";
      }

      return {
        path,
        distance: path.length - 1,
        estimatedTime: Math.ceil((path.length - 1) * 0.6),
        transportsUsed: [],
        success: true,
      };
    }

    if (closedSet.has(currentKey)) continue;
    closedSet.add(currentKey);

    const tileByte = collisionCache.getCollisionByteSync(current.x, current.y, floor);
    if (tileByte === null) continue;

    for (const [dx, dy, dirBit, oppositeBit, dirName] of directions) {
      // Check if we can EXIT current tile in this direction
      if (!canMove(tileByte, dirBit)) continue;

      // For diagonals, check that adjacent cardinal directions are also free
      if (dirName in DIAGONAL_REQUIREMENTS) {
        const [req1, req2] = DIAGONAL_REQUIREMENTS[dirName];
        if (!canMove(tileByte, req1) || !canMove(tileByte, req2)) continue;
      }

      const nx = current.x + dx;
      const ny = current.y + dy;
      const neighborKey = getKey(nx, ny);

      if (closedSet.has(neighborKey)) continue;

      // Check if we can ENTER the neighbor tile from this direction
      const neighborByte = collisionCache.getCollisionByteSync(nx, ny, floor);
      if (neighborByte === null) continue;
      if (!canMove(neighborByte, oppositeBit)) continue;

      const moveCost = dx !== 0 && dy !== 0 ? 1.41 : 1;

      const tentativeG = current.g + moveCost;
      const existingG = gScore.get(neighborKey) ?? Infinity;

      if (tentativeG < existingG) {
        cameFrom.set(neighborKey, currentKey);
        gScore.set(neighborKey, tentativeG);

        openSet.push({
          x: nx,
          y: ny,
          floor,
          g: tentativeG,
          f: tentativeG + heuristicWeight * heuristic(nx, ny, endX, endY),
        });
      }
    }

    // Check for same-floor transports (doors, shortcuts) from current tile
    if (useDoors) {
      const transportsFromHere = transportLookup.get(currentKey);
      if (transportsFromHere) {
        for (const transport of transportsFromHere) {
          const t = getTransportFields(transport);
          const transportExitKey = getKey(t.toX, t.toY);

          if (closedSet.has(transportExitKey)) continue;

          const transportCost = t.time || 1;
          const tentativeG = current.g + transportCost;

          const existingG = gScore.get(transportExitKey) ?? Infinity;
          if (tentativeG < existingG) {
            cameFrom.set(transportExitKey, currentKey);
            gScore.set(transportExitKey, tentativeG);

            openSet.push({
              x: t.toX,
              y: t.toY,
              floor,
              g: tentativeG,
              f: tentativeG + heuristicWeight * heuristic(t.toX, t.toY, endX, endY),
            });
          }
        }
      }

      // Also check ADJACENT tiles for doors (RS3 lets you click doors from adjacent tiles)
      // This allows using doors even when you can't step onto the door tile itself
      const adjacentOffsets: [number, number][] = [[0, 1], [0, -1], [1, 0], [-1, 0]];
      for (const [dx, dy] of adjacentOffsets) {
        const adjacentKey = getKey(current.x + dx, current.y + dy);
        const adjacentTransports = transportLookup.get(adjacentKey);
        if (adjacentTransports) {
          for (const transport of adjacentTransports) {
            const t = getTransportFields(transport);
            const transportExitKey = getKey(t.toX, t.toY);

            if (closedSet.has(transportExitKey)) continue;

            // Cost = 1 tick to click from adjacent + transport time
            const transportCost = 1 + (t.time || 1);
            const tentativeG = current.g + transportCost;

            const existingG = gScore.get(transportExitKey) ?? Infinity;
            if (tentativeG < existingG) {
              cameFrom.set(transportExitKey, currentKey);
              gScore.set(transportExitKey, tentativeG);

              openSet.push({
                x: t.toX,
                y: t.toY,
                floor,
                g: tentativeG,
                f: tentativeG + heuristicWeight * heuristic(t.toX, t.toY, endX, endY),
              });
            }
          }
        }
      }
    }
  }

  return {
    path: [],
    distance: 0,
    estimatedTime: 0,
    transportsUsed: [],
    success: false,
    error: iterations >= maxIterations ? "Max iterations reached" : "No path found",
  };
}

// ============================================================================
// Chunked Pathfinding for Long Distances
// ============================================================================

const DEFAULT_CHUNK_SIZE = 150; // Tiles per segment - achievable within 250k iterations

/**
 * Generate intermediate waypoints along the beeline path
 * Returns waypoints including start (but not goal - that's the final destination)
 */
function generateWaypoints(
  fromX: number, fromY: number,
  toX: number, toY: number,
  chunkSize: number
): Array<{ x: number; y: number }> {
  const dx = toX - fromX;
  const dy = toY - fromY;
  const distance = Math.sqrt(dx * dx + dy * dy);

  if (distance <= chunkSize) {
    return [{ x: fromX, y: fromY }];
  }

  const numSegments = Math.ceil(distance / chunkSize);
  const stepX = dx / numSegments;
  const stepY = dy / numSegments;

  const waypoints: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < numSegments; i++) {
    waypoints.push({
      x: Math.round(fromX + stepX * i),
      y: Math.round(fromY + stepY * i),
    });
  }

  return waypoints;
}

/**
 * Chunked pathfinding - breaks long distances into segments
 * Each segment is pathfound separately with limited iterations
 * Segments are chained together for the full path
 */
async function findPathChunked(
  from: PathCoordinate,
  to: PathCoordinate,
  options: PathfinderOptions = {}
): Promise<PathResult> {
  const {
    chunkSize = DEFAULT_CHUNK_SIZE,
    maxIterations = 250000,  // Reduced iteration limit per chunk
    ...restOptions
  } = options;

  const floor = from.floor;

  // Generate waypoints along the beeline
  const waypoints = generateWaypoints(from.x, from.y, to.x, to.y, chunkSize);
  waypoints.push({ x: to.x, y: to.y }); // Add final destination

  if (waypoints.length <= 2) {
    // Short enough for direct pathfinding
    return findPathClientSimple(from, to, { ...restOptions, maxIterations });
  }

  console.log(`[ChunkedPath] Breaking path into ${waypoints.length - 1} segments (chunk size: ${chunkSize})`);

  const fullPath: PathNode[] = [];
  const transportsUsed: string[] = [];
  let totalDistance = 0;

  // Path through each segment
  for (let i = 0; i < waypoints.length - 1; i++) {
    const segmentFrom: PathCoordinate = {
      x: waypoints[i].x,
      y: waypoints[i].y,
      floor,
    };
    const segmentTo: PathCoordinate = {
      x: waypoints[i + 1].x,
      y: waypoints[i + 1].y,
      floor,
    };

    // Use the actual last position from previous segment as start (if we have one)
    if (fullPath.length > 0) {
      const lastNode = fullPath[fullPath.length - 1];
      segmentFrom.x = lastNode.x;
      segmentFrom.y = lastNode.y;
    }

    const segmentResult = await findPathClientSimple(segmentFrom, segmentTo, {
      ...restOptions,
      maxIterations,
    });

    if (!segmentResult.success) {
      // Try with doors/transports if simple path fails
      const transportResult = await findPathWithSameFloorTransports(segmentFrom, segmentTo, {
        ...restOptions,
        maxIterations,
      });

      if (!transportResult.success) {
        console.log(`[ChunkedPath] Segment ${i + 1}/${waypoints.length - 1} failed: ${transportResult.error}`);
        return {
          path: fullPath.length > 0 ? fullPath : [],
          distance: totalDistance,
          estimatedTime: totalDistance * 0.6,
          transportsUsed,
          success: false,
          error: `Segment ${i + 1} failed: ${transportResult.error}`,
        };
      }

      // Use transport path
      if (fullPath.length > 0) {
        // Skip first node to avoid duplicate
        fullPath.push(...transportResult.path.slice(1));
      } else {
        fullPath.push(...transportResult.path);
      }
      totalDistance += transportResult.distance;
      transportsUsed.push(...transportResult.transportsUsed);
    } else {
      // Use simple path
      if (fullPath.length > 0) {
        // Skip first node to avoid duplicate
        fullPath.push(...segmentResult.path.slice(1));
      } else {
        fullPath.push(...segmentResult.path);
      }
      totalDistance += segmentResult.distance;
    }
  }

  console.log(`[ChunkedPath] Success: ${fullPath.length} nodes, ${totalDistance} distance`);

  return {
    path: fullPath,
    distance: totalDistance,
    estimatedTime: totalDistance * 0.6,
    transportsUsed,
    success: true,
  };
}

/**
 * Find path using A* with bitwise collision checking
 * Automatically uses chunked pathfinding for long distances
 */
export async function findPathClient(
  from: PathCoordinate,
  to: PathCoordinate,
  options: PathfinderOptions = {}
): Promise<PathResult> {
  const {
    maxIterations = 250000,  // Reduced to 250k - chunking handles long paths
    allowDiagonals = true,
    useDoors = true, // Enable same-floor transport usage by default
    chunkSize = DEFAULT_CHUNK_SIZE,
    useChunking = true,  // Enable chunking by default
  } = options;

  // Same tile
  if (from.x === to.x && from.y === to.y && from.floor === to.floor) {
    return {
      path: [{ x: from.x, y: from.y, floor: from.floor }],
      distance: 0,
      estimatedTime: 0,
      transportsUsed: [],
      success: true,
    };
  }

  // Floor changes require transports - find and use them client-side
  if (from.floor !== to.floor) {
    return findPathWithTransports(from, to, options);
  }

  // Calculate distance to decide if chunking is needed
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.sqrt(dx * dx + dy * dy);

  // Use chunked pathfinding for long distances (same floor only)
  if (useChunking && distance > chunkSize) {
    console.log(`[PathClient] Long distance (${Math.round(distance)} tiles) - using chunked pathfinding`);
    return findPathChunked(from, to, { ...options, maxIterations, chunkSize });
  }

  // Same floor - use transport waypoint routing if enabled
  // This explicitly routes TO doors/shortcuts as intermediate destinations
  if (useDoors) {
    return findPathWithSameFloorTransports(from, to, options);
  }

  // No doors - use simple A*
  const floor = from.floor;

  // Preload collision files covering the entire rectangular area between start and goal
  // This ensures the synchronous A* loop has all data it needs
  const startFileX = Math.floor(from.x / TILE_FILE_SIZE);
  const startFileY = Math.floor(from.y / TILE_FILE_SIZE);
  const goalFileX = Math.floor(to.x / TILE_FILE_SIZE);
  const goalFileY = Math.floor(to.y / TILE_FILE_SIZE);

  // Get bounding box of files to load (with 1 file padding for detours)
  const minFileX = Math.max(0, Math.min(startFileX, goalFileX) - 1);
  const maxFileX = Math.min(MAX_FILE_X, Math.max(startFileX, goalFileX) + 1);
  const minFileY = Math.max(0, Math.min(startFileY, goalFileY) - 1);
  const maxFileY = Math.min(MAX_FILE_Y, Math.max(startFileY, goalFileY) + 1);

  // Load all files in the bounding box
  const filesToLoad = new Set<string>();
  for (let fx = minFileX; fx <= maxFileX; fx++) {
    for (let fy = minFileY; fy <= maxFileY; fy++) {
      if (isValidFileCoord(fx, fy)) {
        filesToLoad.add(`${fx},${fy}`);
      }
    }
  }

  const preloadPromises = Array.from(filesToLoad).map((key) => {
    const [fx, fy] = key.split(",").map(Number);
    return collisionCache.getTileData(fx, fy, floor);
  });
  await Promise.all(preloadPromises);

  // Build same-floor transport lookup if doors are enabled
  const transportLookup = useDoors ? await buildSameFloorTransportLookup(floor) : new Map();

  // Find accessible start and end points (like RS3QuestMapBuddy)
  const accessibleStart = await findNearestAccessible(from.x, from.y, floor);
  const accessibleEnd = await findNearestAccessible(to.x, to.y, floor);

  if (!accessibleStart) {
    return {
      path: [],
      distance: 0,
      estimatedTime: 0,
      transportsUsed: [],
      success: false,
      error: "No accessible tile near start position",
    };
  }

  if (!accessibleEnd) {
    return {
      path: [],
      distance: 0,
      estimatedTime: 0,
      transportsUsed: [],
      success: false,
      error: "No accessible tile near end position",
    };
  }

  // Use accessible positions for pathfinding
  const startX = accessibleStart.x;
  const startY = accessibleStart.y;
  const endX = accessibleEnd.x;
  const endY = accessibleEnd.y;


  // Same tile after accessibility adjustment
  if (startX === endX && startY === endY) {
    return {
      path: [{ x: startX, y: startY, floor }],
      distance: 0,
      estimatedTime: 0,
      transportsUsed: [],
      success: true,
    };
  }

  // A* implementation
  const openSet = new MinHeap();
  const closedSet = new Set<string>();
  const cameFrom = new Map<string, string>();
  const gScore = new Map<string, number>();

  const getKey = (x: number, y: number): string => `${x},${y}`;
  const startKey = getKey(startX, startY);
  const goalKey = getKey(endX, endY);

  // Use weighted A* (weight > 1 makes search more greedy/faster)
  const heuristicWeight = 2.0;

  gScore.set(startKey, 0);
  openSet.push({
    x: startX,
    y: startY,
    floor,
    g: 0,
    f: heuristicWeight * heuristic(startX, startY, endX, endY),
  });

  let iterations = 0;
  let neighborsAdded = 0;
  const directions = allowDiagonals ? DIRECTIONS : DIRECTIONS.slice(0, 4);


  // Main A* loop - fully synchronous since collision data is preloaded
  while (!openSet.isEmpty() && iterations < maxIterations) {
    iterations++;

    const current = openSet.pop()!;
    const currentKey = getKey(current.x, current.y);

    // Goal reached
    if (currentKey === goalKey) {
      // Reconstruct path
      const path: PathNode[] = [];
      let key = goalKey;

      while (key) {
        const [x, y] = key.split(",").map(Number);
        path.unshift({ x, y, floor });
        key = cameFrom.get(key) || "";
      }

      return {
        path,
        distance: path.length - 1,
        estimatedTime: Math.ceil((path.length - 1) * 0.6), // ~0.6 ticks per tile
        transportsUsed: [],
        success: true,
      };
    }

    if (closedSet.has(currentKey)) continue;
    closedSet.add(currentKey);

    // Get collision byte for current tile - SYNCHRONOUS lookup (data is preloaded)
    const tileByte = collisionCache.getCollisionByteSync(current.x, current.y, floor);
    if (tileByte === null) {
      continue;
    }

    // Check all directions
    for (const [dx, dy, dirBit, oppositeBit, dirName] of directions) {
      // Check if we can EXIT current tile in this direction
      if (!canMove(tileByte, dirBit)) continue;

      // For diagonals, check that adjacent cardinal directions are also free
      if (dirName in DIAGONAL_REQUIREMENTS) {
        const [req1, req2] = DIAGONAL_REQUIREMENTS[dirName];
        if (!canMove(tileByte, req1) || !canMove(tileByte, req2)) continue;
      }

      const nx = current.x + dx;
      const ny = current.y + dy;
      const neighborKey = getKey(nx, ny);

      if (closedSet.has(neighborKey)) continue;

      // Check if we can ENTER the neighbor tile from this direction
      const neighborByte = collisionCache.getCollisionByteSync(nx, ny, floor);
      if (neighborByte === null) continue;
      if (!canMove(neighborByte, oppositeBit)) continue;

      // Base movement cost: 1 for cardinal, 1.41 for diagonal
      const moveCost = dx !== 0 && dy !== 0 ? 1.41 : 1;

      const tentativeG = current.g + moveCost;

      const existingG = gScore.get(neighborKey) ?? Infinity;
      if (tentativeG < existingG) {
        cameFrom.set(neighborKey, currentKey);
        gScore.set(neighborKey, tentativeG);
        neighborsAdded++;

        openSet.push({
          x: nx,
          y: ny,
          floor,
          g: tentativeG,
          f: tentativeG + heuristicWeight * heuristic(nx, ny, endX, endY),
        });
      }
    }

    // Check for same-floor transports (doors, shortcuts) from current tile
    // This allows bypassing collision-blocked areas by using doors
    if (useDoors) {
      const transportsFromHere = transportLookup.get(currentKey);
      if (transportsFromHere) {
        for (const transport of transportsFromHere) {
          const t = getTransportFields(transport);
          const transportExitKey = getKey(t.toX, t.toY);

          if (closedSet.has(transportExitKey)) continue;

          // Transport cost = travel time (typically 1-2 ticks for doors)
          const transportCost = t.time || 1;
          const tentativeG = current.g + transportCost;

          const existingG = gScore.get(transportExitKey) ?? Infinity;
          if (tentativeG < existingG) {
            cameFrom.set(transportExitKey, currentKey);
            gScore.set(transportExitKey, tentativeG);
            neighborsAdded++;

            openSet.push({
              x: t.toX,
              y: t.toY,
              floor,
              g: tentativeG,
              f: tentativeG + heuristicWeight * heuristic(t.toX, t.toY, endX, endY),
            });
          }
        }
      }

      // Also check ADJACENT tiles for doors (RS3 lets you click doors from adjacent tiles)
      // This allows using doors even when you can't step onto the door tile itself
      const adjacentOffsets: [number, number][] = [[0, 1], [0, -1], [1, 0], [-1, 0]];
      for (const [dx, dy] of adjacentOffsets) {
        const adjacentKey = getKey(current.x + dx, current.y + dy);
        const adjacentTransports = transportLookup.get(adjacentKey);
        if (adjacentTransports) {
          for (const transport of adjacentTransports) {
            const t = getTransportFields(transport);
            const transportExitKey = getKey(t.toX, t.toY);

            if (closedSet.has(transportExitKey)) continue;

            // Cost = 1 tick to click from adjacent + transport time
            const transportCost = 1 + (t.time || 1);
            const tentativeG = current.g + transportCost;

            const existingG = gScore.get(transportExitKey) ?? Infinity;
            if (tentativeG < existingG) {
              cameFrom.set(transportExitKey, currentKey);
              gScore.set(transportExitKey, tentativeG);
              neighborsAdded++;

              openSet.push({
                x: t.toX,
                y: t.toY,
                floor,
                g: tentativeG,
                f: tentativeG + heuristicWeight * heuristic(t.toX, t.toY, endX, endY),
              });
            }
          }
        }
      }
    }
  }

  return {
    path: [],
    distance: 0,
    estimatedTime: 0,
    transportsUsed: [],
    success: false,
    error: iterations >= maxIterations ? `Max iterations reached (explored ${closedSet.size} tiles)` : "No path found (open set empty)",
  };
}

/**
 * Simplified path finding for short distances (synchronous if data cached)
 */
export async function findShortPath(
  from: PathCoordinate,
  to: PathCoordinate,
  maxTiles: number = 50
): Promise<PathResult> {
  return findPathClient(from, to, {
    maxIterations: maxTiles * 100,
    maxDistance: maxTiles,
    allowDiagonals: true,
  });
}

/**
 * Check if a direct line path is possible (no obstacles)
 */
export async function isDirectPathClear(
  from: PathCoordinate,
  to: PathCoordinate
): Promise<boolean> {
  if (from.floor !== to.floor) return false;

  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const steps = Math.max(Math.abs(dx), Math.abs(dy));

  if (steps === 0) return true;

  const stepX = dx / steps;
  const stepY = dy / steps;

  for (let i = 0; i < steps; i++) {
    const x = Math.round(from.x + stepX * i);
    const y = Math.round(from.y + stepY * i);

    const tileByte = await collisionCache.getCollisionByte(x, y, from.floor);
    if (tileByte === null || tileByte === 0) return false;

    // Check movement direction
    const nextX = Math.round(from.x + stepX * (i + 1));
    const nextY = Math.round(from.y + stepY * (i + 1));
    const dirX = Math.sign(nextX - x);
    const dirY = Math.sign(nextY - y);

    let dirBit = 0;
    if (dirX === -1 && dirY === 0) dirBit = DIRECTION_BITS.WEST;
    else if (dirX === 1 && dirY === 0) dirBit = DIRECTION_BITS.EAST;
    else if (dirX === 0 && dirY === 1) dirBit = DIRECTION_BITS.NORTH;
    else if (dirX === 0 && dirY === -1) dirBit = DIRECTION_BITS.SOUTH;
    else if (dirX === -1 && dirY === 1) dirBit = DIRECTION_BITS.NORTHWEST;
    else if (dirX === 1 && dirY === 1) dirBit = DIRECTION_BITS.NORTHEAST;
    else if (dirX === 1 && dirY === -1) dirBit = DIRECTION_BITS.SOUTHEAST;
    else if (dirX === -1 && dirY === -1) dirBit = DIRECTION_BITS.SOUTHWEST;

    if (dirBit && !canMove(tileByte, dirBit)) return false;
  }

  return true;
}

/**
 * Preload collision data for an area
 */
export async function preloadCollisionData(
  centerX: number,
  centerY: number,
  floor: number,
  radius: number = 2
): Promise<void> {
  await collisionCache.preloadRegion(centerX, centerY, floor, radius);
}

/**
 * Clear collision cache
 */
export function clearCollisionCache(): void {
  collisionCache.clear();
}

/**
 * Get collision byte for overlay visualization
 * Exported for CollisionOverlay.ts
 */
export async function getCollisionByteForOverlay(
  x: number,
  y: number,
  floor: number
): Promise<number | null> {
  return collisionCache.getCollisionByte(x, y, floor);
}

/**
 * Preload all transport data
 */
export async function preloadTransports(): Promise<void> {
  await transportCache.loadAll();
}

/**
 * Get transports near a position
 */
export async function getNearbyTransports(
  x: number,
  y: number,
  floor: number,
  radius: number = 50
): Promise<TransportLink[]> {
  return transportCache.getNearby(x, y, floor, radius);
}

/**
 * Find a transport that could help reach destination faster
 */
export async function findUsefulTransport(
  fromX: number,
  fromY: number,
  fromFloor: number,
  toX: number,
  toY: number,
  toFloor: number
): Promise<TransportLink | null> {
  return transportCache.findUsefulTransport(fromX, fromY, fromFloor, toX, toY, toFloor);
}

/**
 * Clear transport cache
 */
export function clearTransportCache(): void {
  transportCache.clear();
}

export { collisionCache, transportCache };

// ============================================================================
// Debug Helpers - expose to window for console debugging
// ============================================================================

/**
 * Expose debug functions to window for console access
 * Usage in browser console:
 *   await window.debugPathfinder.getNearbyTransports(3232, 3424, 1, 30)
 *   await window.debugPathfinder.getAllTransports()
 */
if (typeof window !== "undefined") {
  (window as any).debugPathfinder = {
    getNearbyTransports: async (x: number, y: number, floor: number, radius: number = 30) => {
      const transports = await transportCache.getNearby(x, y, floor, radius);
      console.log(`Found ${transports.length} transports near (${x}, ${y}) floor ${floor}:`);
      transports.forEach((t) => {
        const fields = getTransportFields(t);
        console.log(`  ${fields.name || fields.transportType}: (${fields.fromX}, ${fields.fromY}) floor ${fields.fromFloor} -> (${fields.toX}, ${fields.toY}) floor ${fields.toFloor}`);
      });
      return transports;
    },
    getAllTransports: async () => {
      const all = await transportCache.loadAll();
      console.log(`Total transports: ${all.length}`);
      return all;
    },
    getTransportsOnFloor: async (floor: number) => {
      const all = await transportCache.loadAll();
      const onFloor = all.filter((t) => {
        const fields = getTransportFields(t);
        return fields.fromFloor === floor || fields.toFloor === floor;
      });
      console.log(`Transports involving floor ${floor}: ${onFloor.length}`);
      onFloor.forEach((t) => {
        const fields = getTransportFields(t);
        console.log(`  ${fields.name || fields.transportType}: (${fields.fromX}, ${fields.fromY}) floor ${fields.fromFloor} -> (${fields.toX}, ${fields.toY}) floor ${fields.toFloor}`);
      });
      return onFloor;
    },
    findTransportByName: async (namePattern: string) => {
      const all = await transportCache.loadAll();
      const pattern = namePattern.toLowerCase();
      const matches = all.filter((t) => {
        const fields = getTransportFields(t);
        return fields.name.toLowerCase().includes(pattern) || fields.transportType.toLowerCase().includes(pattern);
      });
      console.log(`Transports matching "${namePattern}": ${matches.length}`);
      matches.forEach((t) => {
        const fields = getTransportFields(t);
        console.log(`  ${fields.name || fields.transportType}: (${fields.fromX}, ${fields.fromY}) floor ${fields.fromFloor} -> (${fields.toX}, ${fields.toY}) floor ${fields.toFloor}`);
      });
      return matches;
    },
    getCollisionByte: async (x: number, y: number, floor: number) => {
      const byte = await collisionCache.getCollisionByte(x, y, floor);
      if (byte !== null) {
        console.log(`Collision at (${x}, ${y}) floor ${floor}: ${byte} (${byte.toString(2).padStart(8, '0')})`);
        console.log(`  Can move: W=${!!(byte & 1)}, N=${!!(byte & 2)}, E=${!!(byte & 4)}, S=${!!(byte & 8)}, NW=${!!(byte & 16)}, NE=${!!(byte & 32)}, SE=${!!(byte & 64)}, SW=${!!(byte & 128)}`);
      } else {
        console.log(`No collision data for (${x}, ${y}) floor ${floor}`);
      }
      return byte;
    },

    // Trace a line between two points and check collision at each tile
    traceCollisionLine: async (fromX: number, fromY: number, toX: number, toY: number, floor: number) => {
      console.log(`Tracing collision from (${fromX}, ${fromY}) to (${toX}, ${toY}) floor ${floor}`);
      const dx = toX - fromX;
      const dy = toY - fromY;
      const steps = Math.max(Math.abs(dx), Math.abs(dy));

      let blockedAt: { x: number; y: number; byte: number | null }[] = [];

      for (let i = 0; i <= steps; i++) {
        const x = Math.round(fromX + (dx / steps) * i);
        const y = Math.round(fromY + (dy / steps) * i);
        const byte = await collisionCache.getCollisionByte(x, y, floor);

        const canMoveAll = byte !== null && byte === 255;
        const status = byte === null ? "NO_DATA" : (canMoveAll ? "OPEN" : `PARTIAL(${byte})`);

        console.log(`  (${x}, ${y}): ${status}`);

        if (byte !== 255 && byte !== null) {
          blockedAt.push({ x, y, byte });
        }
      }

      if (blockedAt.length > 0) {
        console.log(`\nTiles with blocked directions:`);
        for (const tile of blockedAt) {
          const b = tile.byte!;
          const blocked = [];
          if (!(b & 1)) blocked.push('W');
          if (!(b & 2)) blocked.push('N');
          if (!(b & 4)) blocked.push('E');
          if (!(b & 8)) blocked.push('S');
          if (!(b & 16)) blocked.push('NW');
          if (!(b & 32)) blocked.push('NE');
          if (!(b & 64)) blocked.push('SE');
          if (!(b & 128)) blocked.push('SW');
          console.log(`  (${tile.x}, ${tile.y}): blocked=${blocked.join(',')}`);
        }
      }

      return { steps, blockedAt };
    },

    // Test a short pathfind with detailed logging
    testPathfind: async (fromX: number, fromY: number, toX: number, toY: number, floor: number) => {
      console.log(`Testing path from (${fromX}, ${fromY}) to (${toX}, ${toY}) floor ${floor}`);

      const result = await findPathClient(
        { x: fromX, y: fromY, floor },
        { x: toX, y: toY, floor },
        { maxDistance: 100, maxIterations: 2000000 }
      );

      if (result.success) {
        console.log(`SUCCESS: Path found with ${result.path.length} nodes`);
        // Show path
        console.log(`Path: ${result.path.map(n => `(${n.x},${n.y})`).join(' -> ')}`);
      } else {
        console.log(`FAILED: ${result.error}`);
      }

      return result;
    },

    // Check all 8 neighbors of a tile
    checkNeighbors: async (x: number, y: number, floor: number) => {
      console.log(`Checking neighbors of (${x}, ${y}) floor ${floor}`);

      const centerByte = await collisionCache.getCollisionByte(x, y, floor);
      console.log(`Center tile byte: ${centerByte} (${centerByte?.toString(2).padStart(8, '0')})`);

      const neighbors = [
        { dx: -1, dy: 0, name: 'W', bit: 1 },
        { dx: 0, dy: 1, name: 'N', bit: 2 },
        { dx: 1, dy: 0, name: 'E', bit: 4 },
        { dx: 0, dy: -1, name: 'S', bit: 8 },
        { dx: -1, dy: 1, name: 'NW', bit: 16 },
        { dx: 1, dy: 1, name: 'NE', bit: 32 },
        { dx: 1, dy: -1, name: 'SE', bit: 64 },
        { dx: -1, dy: -1, name: 'SW', bit: 128 },
      ];

      for (const n of neighbors) {
        const nx = x + n.dx;
        const ny = y + n.dy;
        const neighborByte = await collisionCache.getCollisionByte(nx, ny, floor);
        const canMoveFromCenter = centerByte !== null && (centerByte & n.bit) !== 0;
        console.log(`  ${n.name} (${nx}, ${ny}): byte=${neighborByte}, canMoveFromCenter=${canMoveFromCenter}`);
      }
    },

    // Get all same-floor transports (doors, shortcuts) for a floor
    getSameFloorTransports: async (floor: number) => {
      const lookup = await buildSameFloorTransportLookup(floor);
      console.log(`Same-floor transports on floor ${floor}: ${lookup.size} entry points`);

      let totalTransports = 0;
      lookup.forEach((transports, key) => {
        totalTransports += transports.length;
        for (const transport of transports) {
          const t = getTransportFields(transport);
          console.log(`  [${key}] ${t.name || t.transportType}: (${t.fromX}, ${t.fromY}) -> (${t.toX}, ${t.toY})`);
        }
      });

      console.log(`Total: ${totalTransports} transports`);
      return lookup;
    },

    // Test pathfinding with doors explicitly enabled/disabled
    testPathfindWithDoors: async (fromX: number, fromY: number, toX: number, toY: number, floor: number, useDoors: boolean = true) => {
      console.log(`Testing path from (${fromX}, ${fromY}) to (${toX}, ${toY}) floor ${floor} (useDoors=${useDoors})`);

      const result = await findPathClient(
        { x: fromX, y: fromY, floor },
        { x: toX, y: toY, floor },
        { maxDistance: 100, maxIterations: 20000000, useDoors }
      );

      if (result.success) {
        console.log(`SUCCESS: Path found with ${result.path.length} nodes`);
        if (result.transportsUsed.length > 0) {
          console.log(`Transports used: ${result.transportsUsed.join(', ')}`);
        }
        console.log(`Path: ${result.path.map(n => `(${n.x},${n.y})${n.isTransport ? '[T]' : ''}`).join(' -> ')}`);
      } else {
        console.log(`FAILED: ${result.error}`);
      }

      return result;
    },

    // Find useful transports between two points
    findUsefulTransports: async (fromX: number, fromY: number, toX: number, toY: number, floor: number) => {
      console.log(`Finding useful transports from (${fromX}, ${fromY}) to (${toX}, ${toY}) floor ${floor}`);

      const transports = await findUsefulSameFloorTransports(fromX, fromY, toX, toY, floor, 50);
      console.log(`Found ${transports.length} useful transports:`);

      for (const transport of transports) {
        const t = getTransportFields(transport);
        const distToEntry = Math.abs(t.fromX - fromX) + Math.abs(t.fromY - fromY);
        const distFromExitToDest = Math.abs(toX - t.toX) + Math.abs(toY - t.toY);
        console.log(`  ${t.name || t.transportType}: entry(${t.fromX}, ${t.fromY}) -> exit(${t.toX}, ${t.toY})`);
        console.log(`    Walk ${distToEntry} tiles to entry, then ${distFromExitToDest} tiles from exit to dest`);
      }

      return transports;
    },

    // Test simple A* (no transports)
    testSimplePath: async (fromX: number, fromY: number, toX: number, toY: number, floor: number) => {
      console.log(`Testing SIMPLE path (no transports) from (${fromX}, ${fromY}) to (${toX}, ${toY}) floor ${floor}`);

      const result = await findPathClientSimple(
        { x: fromX, y: fromY, floor },
        { x: toX, y: toY, floor },
        { maxDistance: 100, maxIterations: 20000000 }
      );

      if (result.success) {
        console.log(`SUCCESS: Path found with ${result.path.length} nodes`);
      } else {
        console.log(`FAILED: ${result.error}`);
      }

      return result;
    },

    // Test full multi-floor path with detailed logging
    testMultiFloorPath: async (fromX: number, fromY: number, fromFloor: number, toX: number, toY: number, toFloor: number) => {
      console.log(`\n=== MULTI-FLOOR PATH TEST ===`);
      console.log(`From: (${fromX}, ${fromY}) floor ${fromFloor}`);
      console.log(`To: (${toX}, ${toY}) floor ${toFloor}`);

      if (fromFloor === toFloor) {
        console.log(`Same floor - using findPathWithSameFloorTransports`);
        const result = await findPathWithSameFloorTransports(
          { x: fromX, y: fromY, floor: fromFloor },
          { x: toX, y: toY, floor: toFloor },
          { maxDistance: 500 }
        );
        if (result.success) {
          console.log(`SUCCESS: ${result.path.length} nodes, transports: ${result.transportsUsed.join(', ') || 'none'}`);
        } else {
          console.log(`FAILED: ${result.error}`);
        }
        return result;
      }

      console.log(`\n--- Step 1: Find floor-changing transports (ladders/stairs) ---`);
      const allTransports = await transportCache.loadAll();
      const relevantTransports = allTransports.filter((transport) => {
        const t = getTransportFields(transport);
        if (t.fromFloor !== fromFloor) return false;
        const currentFloorDiff = Math.abs(toFloor - fromFloor);
        const afterTransportFloorDiff = Math.abs(toFloor - t.toFloor);
        return afterTransportFloorDiff < currentFloorDiff || t.toFloor === toFloor;
      });

      console.log(`Found ${relevantTransports.length} relevant floor-changing transports`);

      // Score and sort
      const candidates: Array<{ transport: any; distTo: number; distFrom: number; score: number }> = [];
      for (const transport of relevantTransports) {
        const tf = getTransportFields(transport);
        const distTo = Math.abs(tf.fromX - fromX) + Math.abs(tf.fromY - fromY);
        const distFrom = Math.abs(toX - tf.toX) + Math.abs(toY - tf.toY);
        if (distTo <= 250 && distFrom <= 250) {
          candidates.push({ transport, distTo, distFrom, score: distTo + tf.time + distFrom });
        }
      }
      candidates.sort((a, b) => a.score - b.score);

      console.log(`Top candidates after filtering:`);
      for (const c of candidates.slice(0, 5)) {
        const tf = getTransportFields(c.transport);
        console.log(`  ${tf.name || tf.transportType}: entry(${tf.fromX}, ${tf.fromY}) F${tf.fromFloor} -> exit(${tf.toX}, ${tf.toY}) F${tf.toFloor}`);
        console.log(`    Walk ${c.distTo} to entry, ${c.distFrom} from exit, total score: ${c.score}`);
      }

      if (candidates.length === 0) {
        console.log(`FAILED: No viable floor-changing transports found`);
        return { success: false, error: "No transports", path: [], distance: 0, estimatedTime: 0, transportsUsed: [] };
      }

      // Try best candidate
      const best = candidates[0];
      const tf = getTransportFields(best.transport);
      console.log(`\n--- Step 2: Try pathing to best transport (${tf.name || tf.transportType}) ---`);
      console.log(`Target: transport entry at (${tf.fromX}, ${tf.fromY}) F${fromFloor}`);

      // First test direct path
      console.log(`\n  Testing DIRECT path to transport entry...`);
      const directPath = await findPathClientSimple(
        { x: fromX, y: fromY, floor: fromFloor },
        { x: tf.fromX, y: tf.fromY, floor: fromFloor },
        { maxDistance: 250 }
      );
      if (directPath.success) {
        console.log(`  Direct path SUCCESS: ${directPath.path.length} nodes`);
      } else {
        console.log(`  Direct path FAILED: ${directPath.error}`);
        console.log(`  Looking for same-floor doors to bypass obstacle...`);

        // Find useful doors
        const doors = await findUsefulSameFloorTransports(fromX, fromY, tf.fromX, tf.fromY, fromFloor, 125);
        console.log(`  Found ${doors.length} potentially useful doors:`);
        for (const door of doors.slice(0, 5)) {
          const d = getTransportFields(door);
          console.log(`    ${d.name || d.transportType}: (${d.fromX}, ${d.fromY}) -> (${d.toX}, ${d.toY})`);
        }
      }

      console.log(`\n--- Step 3: Running full findPathClient ---`);
      const fullResult = await findPathClient(
        { x: fromX, y: fromY, floor: fromFloor },
        { x: toX, y: toY, floor: toFloor },
        { maxDistance: 500 }
      );

      if (fullResult.success) {
        console.log(`\nSUCCESS!`);
        console.log(`Path: ${fullResult.path.length} nodes`);
        console.log(`Transports used: ${fullResult.transportsUsed.join(' -> ') || 'none'}`);
        console.log(`First 10 nodes: ${fullResult.path.slice(0, 10).map(n => `(${n.x},${n.y})F${n.floor}${n.isTransport ? '[T]' : ''}`).join(' ')}`);
      } else {
        console.log(`\nFAILED: ${fullResult.error}`);
      }

      return fullResult;
    },

    // Test door → ladder routing specifically
    testDoorToLadder: async (
      playerX: number, playerY: number,
      doorEntryX: number, doorEntryY: number,
      doorExitX: number, doorExitY: number,
      ladderX: number, ladderY: number,
      floor: number
    ) => {
      console.log(`\n=== DOOR → LADDER PATH TEST ===`);
      console.log(`Player: (${playerX}, ${playerY})`);
      console.log(`Door: (${doorEntryX}, ${doorEntryY}) → (${doorExitX}, ${doorExitY})`);
      console.log(`Ladder: (${ladderX}, ${ladderY})`);
      console.log(`Floor: ${floor}`);

      // Step 1: Can we path from player to door entry?
      console.log(`\n--- Step 1: Player → Door Entry ---`);
      let pathToEntry = await findPathClientSimple(
        { x: playerX, y: playerY, floor },
        { x: doorEntryX, y: doorEntryY, floor },
        { maxDistance: 100 }
      );
      if (pathToEntry.success) {
        console.log(`Direct to entry: SUCCESS (${pathToEntry.path.length} nodes)`);
      } else {
        console.log(`Direct to entry: FAILED - trying adjacent tiles`);
        const adjacentOffsets: [number, number][] = [[0, 1], [0, -1], [1, 0], [-1, 0]];
        for (const [dx, dy] of adjacentOffsets) {
          const adjPath = await findPathClientSimple(
            { x: playerX, y: playerY, floor },
            { x: doorEntryX + dx, y: doorEntryY + dy, floor },
            { maxDistance: 100 }
          );
          if (adjPath.success) {
            console.log(`To adjacent (${doorEntryX + dx}, ${doorEntryY + dy}): SUCCESS (${adjPath.path.length} nodes)`);
            pathToEntry = adjPath;
            break;
          } else {
            console.log(`To adjacent (${doorEntryX + dx}, ${doorEntryY + dy}): FAILED`);
          }
        }
      }

      // Step 2: Can we path from door exit to ladder?
      console.log(`\n--- Step 2: Door Exit → Ladder ---`);
      let pathToLadder = await findPathClientSimple(
        { x: doorExitX, y: doorExitY, floor },
        { x: ladderX, y: ladderY, floor },
        { maxDistance: 100 }
      );
      if (pathToLadder.success) {
        console.log(`Direct exit to ladder: SUCCESS (${pathToLadder.path.length} nodes)`);
        console.log(`Path: ${pathToLadder.path.map(n => `(${n.x},${n.y})`).join(' → ')}`);
      } else {
        console.log(`Direct exit to ladder: FAILED (${pathToLadder.error})`);
        console.log(`Trying from adjacent tiles of exit...`);
        const adjacentOffsets: [number, number][] = [[0, 1], [0, -1], [1, 0], [-1, 0]];
        for (const [dx, dy] of adjacentOffsets) {
          const adjPath = await findPathClientSimple(
            { x: doorExitX + dx, y: doorExitY + dy, floor },
            { x: ladderX, y: ladderY, floor },
            { maxDistance: 100 }
          );
          console.log(`From (${doorExitX + dx}, ${doorExitY + dy}): ${adjPath.success ? 'SUCCESS' : 'FAILED'}`);
        }
      }

      // Step 3: Check collision bytes along the expected path
      console.log(`\n--- Step 3: Collision bytes from exit to ladder ---`);
      for (let x = Math.min(doorExitX, ladderX); x <= Math.max(doorExitX, ladderX); x++) {
        for (let y = Math.min(doorExitY, ladderY); y <= Math.max(doorExitY, ladderY); y++) {
          const byte = await collisionCache.getCollisionByte(x, y, floor);
          const canW = byte !== null && (byte & 1) !== 0;
          const canE = byte !== null && (byte & 4) !== 0;
          const canN = byte !== null && (byte & 2) !== 0;
          const canS = byte !== null && (byte & 8) !== 0;
          console.log(`  (${x}, ${y}): ${byte} - W:${canW} E:${canE} N:${canN} S:${canS}`);
        }
      }

      return { pathToEntry, pathToLadder };
    },

    // Show collision overlay for an area
    showCollision: async (x: number, y: number, floor: number, radius: number = 15, showArrows: boolean = true) => {
      console.log(`Showing collision overlay at (${x}, ${y}) floor ${floor} radius ${radius}`);
      try {
        const { showCollisionOverlay } = await import("../gl/CollisionOverlay");
        const success = await showCollisionOverlay(x, y, floor, radius, showArrows);
        if (success) {
          console.log(`Collision overlay active - use debugPathfinder.clearCollision() to hide`);
        } else {
          console.log(`Failed to show collision overlay - check if floor chunks are visible`);
        }
        return success;
      } catch (e) {
        console.error("Failed to show collision overlay:", e);
        return false;
      }
    },

    // Clear collision overlay
    clearCollision: async () => {
      try {
        const { clearCollisionOverlay } = await import("../gl/CollisionOverlay");
        await clearCollisionOverlay();
        console.log("Collision overlay cleared");
      } catch (e) {
        console.error("Failed to clear collision overlay:", e);
      }
    },

    // Show collision at player's current position
    showCollisionAtPlayer: async (radius: number = 15, showArrows: boolean = true) => {
      try {
        const { getPlayerPosition } = await import("../gl/PlayerPositionTracker");
        const pos = getPlayerPosition();
        if (!pos) {
          console.log("No player position available - ensure tracking is active");
          return false;
        }
        const x = Math.floor(pos.location.lng);
        const y = Math.floor(pos.location.lat);
        const floor = pos.floor;
        console.log(`Player at (${x}, ${y}) floor ${floor}`);
        const { showCollisionOverlay } = await import("../gl/CollisionOverlay");
        return await showCollisionOverlay(x, y, floor, radius, showArrows);
      } catch (e) {
        console.error("Failed to show collision at player:", e);
        return false;
      }
    },

    // Test path overlay - draws a simple path from player position
    testPathOverlay: async () => {
      try {
        const { getPlayerPosition } = await import("../gl/PlayerPositionTracker");
        const pos = getPlayerPosition();
        if (!pos) {
          console.log("No player position - ensure tracking is active");
          return false;
        }
        const x = Math.floor(pos.location.lng);
        const y = Math.floor(pos.location.lat);
        const floor = pos.floor;
        console.log(`Testing path overlay at (${x}, ${y}) floor ${floor}`);

        // PathTubeOverlay disabled
        return false;
      } catch (e) {
        console.error("Failed to test path overlay:", e);
        return false;
      }
    },

    // Clear path overlay
    clearPathOverlay: async () => {
      try {
        // PathTubeOverlay disabled
      } catch (e) {
        console.error("Failed to clear path overlay:", e);
      }
    },

    // Performance test: run pathfinding with timing
    // mode: 'astar' (default) or 'dijkstra'
    perfTest: async (targetX?: number, targetY?: number, targetFloor?: number, mode: 'astar' | 'dijkstra' | 'jps' = 'astar') => {
      const { getPlayerPosition } = await import("../gl/PlayerPositionTracker");
      const pos = getPlayerPosition();
      if (!pos) {
        console.log("No player position - ensure tracking is active");
        return;
      }
      const fromX = Math.floor(pos.location.lng);
      const fromY = Math.floor(pos.location.lat);
      const floor = targetFloor ?? pos.floor;

      // If no target specified, find a random nearby point
      const toX = targetX ?? fromX + Math.floor(Math.random() * 40) - 20;
      const toY = targetY ?? fromY + Math.floor(Math.random() * 40) - 20;

      const algoName = mode === 'dijkstra' ? 'DIJKSTRA' : 'A*';
      console.log(`\n=== ${algoName} PERFORMANCE TEST ===`);
      console.log(`From: (${fromX}, ${fromY}) floor ${floor}`);
      console.log(`To: (${toX}, ${toY}) floor ${floor}`);
      console.log(`Distance: ${Math.abs(toX - fromX) + Math.abs(toY - fromY)} tiles (manhattan)`);

      const result = await findPathClientSimple(
        { x: fromX, y: fromY, floor },
        { x: toX, y: toY, floor },
        { maxIterations: 20000000, mode }
      );

      if (result.success) {
        console.log(`Result: SUCCESS - path has ${result.path.length} nodes`);
      } else {
        console.log(`Result: FAILED - ${result.error}`);
      }

      if (result.stats) {
        console.log(`\n=== STATS ===`);
        console.log(`Algorithm: ${result.stats.mode}`);
        console.log(`Nodes visited: ${result.stats.nodesVisited}`);
        console.log(`Iterations: ${result.stats.iterations}`);
        console.log(`Total time: ${result.stats.totalTimeMs.toFixed(1)}ms`);
        console.log(`  - Preload: ${result.stats.preloadTimeMs.toFixed(1)}ms`);
        console.log(`  - Algorithm: ${result.stats.astarTimeMs.toFixed(1)}ms`);
      }

      return result;
    },

    // Compare A* vs Dijkstra vs JPS performance
    compareAlgorithms: async (targetX?: number, targetY?: number, targetFloor?: number) => {
      const { getPlayerPosition } = await import("../gl/PlayerPositionTracker");
      const pos = getPlayerPosition();
      if (!pos) {
        console.log("No player position - ensure tracking is active");
        return;
      }
      const fromX = Math.floor(pos.location.lng);
      const fromY = Math.floor(pos.location.lat);
      const floor = targetFloor ?? pos.floor;

      const toX = targetX ?? fromX + Math.floor(Math.random() * 100) - 50;
      const toY = targetY ?? fromY + Math.floor(Math.random() * 100) - 50;

      console.log(`\n=== ALGORITHM COMPARISON ===`);
      console.log(`From: (${fromX}, ${fromY}) floor ${floor}`);
      console.log(`To: (${toX}, ${toY}) floor ${floor}`);
      console.log(`Distance: ${Math.abs(toX - fromX) + Math.abs(toY - fromY)} tiles (manhattan)\n`);

      // Run A*
      console.log(`--- Running A* ---`);
      const astarResult = await findPathClientSimple(
        { x: fromX, y: fromY, floor },
        { x: toX, y: toY, floor },
        { maxIterations: 20000000, mode: 'astar' }
      );

      // Run Dijkstra
      console.log(`\n--- Running Dijkstra ---`);
      const dijkstraResult = await findPathClientSimple(
        { x: fromX, y: fromY, floor },
        { x: toX, y: toY, floor },
        { maxIterations: 20000000, mode: 'dijkstra' }
      );

      // Run JPS
      console.log(`\n--- Running JPS ---`);
      const jpsResult = await findPathClientSimple(
        { x: fromX, y: fromY, floor },
        { x: toX, y: toY, floor },
        { maxIterations: 20000000, mode: 'jps' }
      );

      // Compare results
      if (astarResult.stats && dijkstraResult.stats && jpsResult.stats) {
        const astarMs = astarResult.stats.astarTimeMs;
        const dijkstraMs = dijkstraResult.stats.astarTimeMs;
        const jpsMs = jpsResult.stats.astarTimeMs;

        console.log(`\n=== ALGORITHM RACE ===`);
        console.log(`A*:       ${astarMs.toFixed(1)}ms`);
        console.log(`Dijkstra: ${dijkstraMs.toFixed(1)}ms`);
        console.log(`JPS:      ${jpsMs.toFixed(1)}ms`);

        // Find winner
        const times = [
          { name: 'A*', ms: astarMs },
          { name: 'Dijkstra', ms: dijkstraMs },
          { name: 'JPS', ms: jpsMs }
        ].sort((a, b) => a.ms - b.ms);
        const winner = times[0];
        const slowest = times[2];
        console.log(`Winner:   ${winner.name} (${(slowest.ms / winner.ms).toFixed(1)}x faster than ${slowest.name})`);

        console.log(`\n=== PATH QUALITY ===`);
        console.log(`A* path:       ${astarResult.path.length} tiles`);
        console.log(`Dijkstra path: ${dijkstraResult.path.length} tiles`);
        console.log(`JPS path:      ${jpsResult.path.length} tiles`);

        console.log(`\n=== NODE STATS ===`);
        console.log(`A* visited:       ${astarResult.stats.nodesVisited.toLocaleString()} nodes`);
        console.log(`Dijkstra visited: ${dijkstraResult.stats.nodesVisited.toLocaleString()} nodes`);
        console.log(`JPS visited:      ${jpsResult.stats.nodesVisited.toLocaleString()} nodes (jump points only)`);

        // JPS efficiency
        const jpsSavings = ((dijkstraResult.stats.nodesVisited - jpsResult.stats.nodesVisited) / dijkstraResult.stats.nodesVisited) * 100;
        if (jpsSavings > 0) {
          console.log(`JPS explored ${jpsSavings.toFixed(1)}% fewer nodes than Dijkstra`);
        }
      }

      return { astar: astarResult, dijkstra: dijkstraResult, jps: jpsResult };
    },

    // Batch performance test
    perfTestBatch: async (count: number = 10, maxDist: number = 50, mode: 'astar' | 'dijkstra' | 'jps' = 'astar') => {
      const { getPlayerPosition } = await import("../gl/PlayerPositionTracker");
      const pos = getPlayerPosition();
      if (!pos) {
        console.log("No player position - ensure tracking is active");
        return;
      }
      const fromX = Math.floor(pos.location.lng);
      const fromY = Math.floor(pos.location.lat);
      const floor = pos.floor;

      const algoName = mode === 'dijkstra' ? 'DIJKSTRA' : 'A*';
      console.log(`\n=== ${algoName} BATCH PERFORMANCE TEST (${count} runs) ===`);
      console.log(`Center: (${fromX}, ${fromY}) floor ${floor}`);
      console.log(`Max distance: ${maxDist} tiles`);

      const results: { success: boolean; time: number; pathLen: number; nodesVisited: number }[] = [];

      for (let i = 0; i < count; i++) {
        const toX = fromX + Math.floor(Math.random() * maxDist * 2) - maxDist;
        const toY = fromY + Math.floor(Math.random() * maxDist * 2) - maxDist;

        const start = performance.now();
        const result = await findPathClientSimple(
          { x: fromX, y: fromY, floor },
          { x: toX, y: toY, floor },
          { maxIterations: 20000000, mode }
        );
        const elapsed = performance.now() - start;

        results.push({
          success: result.success,
          time: elapsed,
          pathLen: result.path.length,
          nodesVisited: result.stats?.nodesVisited ?? 0,
        });
      }

      const successCount = results.filter(r => r.success).length;
      const avgTime = results.reduce((sum, r) => sum + r.time, 0) / results.length;
      const maxTime = Math.max(...results.map(r => r.time));
      const minTime = Math.min(...results.map(r => r.time));
      const avgNodes = results.reduce((sum, r) => sum + r.nodesVisited, 0) / results.length;

      console.log(`\n=== RESULTS ===`);
      console.log(`Algorithm: ${mode}`);
      console.log(`Success rate: ${successCount}/${count} (${(100 * successCount / count).toFixed(0)}%)`);
      console.log(`Avg time: ${avgTime.toFixed(1)}ms`);
      console.log(`Min time: ${minTime.toFixed(1)}ms`);
      console.log(`Max time: ${maxTime.toFixed(1)}ms`);
      console.log(`Avg nodes visited: ${avgNodes.toFixed(0)}`);

      return results;
    },
  };
}
