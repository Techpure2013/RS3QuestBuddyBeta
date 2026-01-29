/**
 * IndexedDB cache for collision tile data
 * Stores collision tiles locally to avoid repeated server fetches
 *
 * Each collision file covers 1280x1280 tiles (~1.6MB per file)
 * Files are keyed by {floor}_{fileX}_{fileY}
 */

const DB_NAME = "RS3QB_IDB";
const DB_VERSION = 3; // Bump version to add collision_tiles store
const STORE = "collision_tiles";

// Cache version - increment when collision data format changes on server
const CACHE_VERSION = 1;

// Max age before we re-check with server (7 days)
// Collision data rarely changes, so we can cache aggressively
const MAX_CACHE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface CachedCollisionTile {
	key: string; // {floor}_{fileX}_{fileY}
	data: Uint8Array;
	version: number;
	timestamp: number;
	floor: number;
	fileX: number;
	fileY: number;
}

let dbInstance: IDBDatabase | null = null;
let dbOpenPromise: Promise<IDBDatabase> | null = null;

/**
 * Open the IndexedDB database (singleton)
 */
function openDB(): Promise<IDBDatabase> {
	if (dbInstance) {
		return Promise.resolve(dbInstance);
	}

	if (dbOpenPromise) {
		return dbOpenPromise;
	}

	dbOpenPromise = new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION);

		req.onupgradeneeded = (event) => {
			const db = req.result;
			const oldVersion = event.oldVersion;

			// Create existing stores if upgrading from old version
			if (oldVersion < 2) {
				if (!db.objectStoreNames.contains("player_session")) {
					db.createObjectStore("player_session");
				}
				if (!db.objectStoreNames.contains("quest_list")) {
					db.createObjectStore("quest_list");
				}
			}

			// Create collision tiles store
			if (!db.objectStoreNames.contains(STORE)) {
				const store = db.createObjectStore(STORE, { keyPath: "key" });
				// Index for querying by floor
				store.createIndex("floor", "floor", { unique: false });
				// Index for finding old entries
				store.createIndex("timestamp", "timestamp", { unique: false });
				console.log("[CollisionTileStore] Created collision_tiles store");
			}
		};

		req.onsuccess = () => {
			dbInstance = req.result;

			// Handle database closing
			dbInstance.onclose = () => {
				dbInstance = null;
				dbOpenPromise = null;
			};

			resolve(dbInstance);
		};

		req.onerror = () => {
			dbOpenPromise = null;
			reject(req.error);
		};
	});

	return dbOpenPromise;
}

/**
 * Get cache key for a collision tile
 */
function getCacheKey(floor: number, fileX: number, fileY: number): string {
	return `${floor}_${fileX}_${fileY}`;
}

/**
 * Load a collision tile from cache
 * Returns null if not cached or expired
 */
export async function loadCollisionTile(
	floor: number,
	fileX: number,
	fileY: number
): Promise<Uint8Array | null> {
	try {
		const db = await openDB();
		const key = getCacheKey(floor, fileX, fileY);

		const result = await new Promise<CachedCollisionTile | null>((resolve, reject) => {
			const tx = db.transaction(STORE, "readonly");
			const req = tx.objectStore(STORE).get(key);
			req.onsuccess = () => resolve(req.result ?? null);
			req.onerror = () => reject(req.error);
		});

		if (!result) {
			return null;
		}

		// Check version
		if (result.version !== CACHE_VERSION) {
			console.log(`[CollisionTileStore] Cache version mismatch for ${key}, will re-fetch`);
			return null;
		}

		// Check age
		const age = Date.now() - result.timestamp;
		if (age > MAX_CACHE_AGE_MS) {
			console.log(`[CollisionTileStore] Cache expired for ${key} (${Math.floor(age / 86400000)} days old)`);
			return null;
		}

		//console.log(`[CollisionTileStore] Cache hit for ${key}`);
		return result.data;
	} catch (e) {
		console.warn("[CollisionTileStore] Error loading from cache:", e);
		return null;
	}
}

/**
 * Save a collision tile to cache
 */
export async function saveCollisionTile(
	floor: number,
	fileX: number,
	fileY: number,
	data: Uint8Array
): Promise<void> {
	try {
		const db = await openDB();
		const key = getCacheKey(floor, fileX, fileY);

		const entry: CachedCollisionTile = {
			key,
			data,
			version: CACHE_VERSION,
			timestamp: Date.now(),
			floor,
			fileX,
			fileY,
		};

		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction(STORE, "readwrite");
			tx.objectStore(STORE).put(entry);
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});

		console.log(`[CollisionTileStore] Cached ${key} (${data.length} bytes)`);
	} catch (e) {
		console.warn("[CollisionTileStore] Error saving to cache:", e);
	}
}

/**
 * Clear all cached collision tiles
 */
export async function clearCollisionCache(): Promise<void> {
	try {
		const db = await openDB();
		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction(STORE, "readwrite");
			tx.objectStore(STORE).clear();
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
		console.log("[CollisionTileStore] Cache cleared");
	} catch (e) {
		console.warn("[CollisionTileStore] Error clearing cache:", e);
	}
}

/**
 * Clear cached tiles for a specific floor
 */
export async function clearFloorCache(floor: number): Promise<void> {
	try {
		const db = await openDB();
		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction(STORE, "readwrite");
			const store = tx.objectStore(STORE);
			const index = store.index("floor");
			const range = IDBKeyRange.only(floor);
			const req = index.openCursor(range);

			req.onsuccess = () => {
				const cursor = req.result;
				if (cursor) {
					store.delete(cursor.primaryKey);
					cursor.continue();
				}
			};

			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});
		console.log(`[CollisionTileStore] Cleared floor ${floor} cache`);
	} catch (e) {
		console.warn("[CollisionTileStore] Error clearing floor cache:", e);
	}
}

/**
 * Get cache statistics
 */
export async function getCollisionCacheStats(): Promise<{
	count: number;
	totalBytes: number;
	oldestTimestamp: number | null;
	newestTimestamp: number | null;
}> {
	try {
		const db = await openDB();

		return await new Promise((resolve, reject) => {
			const tx = db.transaction(STORE, "readonly");
			const store = tx.objectStore(STORE);

			let count = 0;
			let totalBytes = 0;
			let oldest: number | null = null;
			let newest: number | null = null;

			const req = store.openCursor();
			req.onsuccess = () => {
				const cursor = req.result;
				if (cursor) {
					const entry = cursor.value as CachedCollisionTile;
					count++;
					totalBytes += entry.data.length;
					if (oldest === null || entry.timestamp < oldest) oldest = entry.timestamp;
					if (newest === null || entry.timestamp > newest) newest = entry.timestamp;
					cursor.continue();
				}
			};

			tx.oncomplete = () => resolve({
				count,
				totalBytes,
				oldestTimestamp: oldest,
				newestTimestamp: newest,
			});
			tx.onerror = () => reject(tx.error);
		});
	} catch (e) {
		console.warn("[CollisionTileStore] Error getting stats:", e);
		return { count: 0, totalBytes: 0, oldestTimestamp: null, newestTimestamp: null };
	}
}

/**
 * Invalidate (delete) a specific collision tile from cache
 * Used when server notifies of updated collision data
 */
export async function invalidateCollisionTile(
	floor: number,
	fileX: number,
	fileY: number
): Promise<void> {
	try {
		const db = await openDB();
		const key = getCacheKey(floor, fileX, fileY);

		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction(STORE, "readwrite");
			tx.objectStore(STORE).delete(key);
			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});

		console.log(`[CollisionTileStore] Invalidated ${key}`);
	} catch (e) {
		console.warn("[CollisionTileStore] Error invalidating tile:", e);
	}
}

/**
 * Invalidate multiple collision tiles at once
 * More efficient than calling invalidateCollisionTile multiple times
 */
export async function invalidateCollisionTiles(
	tiles: Array<{ floor: number; fileX: number; fileY: number }>
): Promise<void> {
	if (tiles.length === 0) return;

	try {
		const db = await openDB();

		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction(STORE, "readwrite");
			const store = tx.objectStore(STORE);

			for (const tile of tiles) {
				const key = getCacheKey(tile.floor, tile.fileX, tile.fileY);
				store.delete(key);
			}

			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});

		console.log(`[CollisionTileStore] Invalidated ${tiles.length} tiles`);
	} catch (e) {
		console.warn("[CollisionTileStore] Error invalidating tiles:", e);
	}
}

/**
 * Get all cached tile keys
 * Returns array of {floor, fileX, fileY} for each cached tile
 */
export async function getAllCachedTileKeys(): Promise<
	Array<{ floor: number; fileX: number; fileY: number }>
> {
	try {
		const db = await openDB();

		return await new Promise((resolve, reject) => {
			const tx = db.transaction(STORE, "readonly");
			const store = tx.objectStore(STORE);
			const keys: Array<{ floor: number; fileX: number; fileY: number }> = [];

			const req = store.openCursor();
			req.onsuccess = () => {
				const cursor = req.result;
				if (cursor) {
					const entry = cursor.value as CachedCollisionTile;
					keys.push({
						floor: entry.floor,
						fileX: entry.fileX,
						fileY: entry.fileY,
					});
					cursor.continue();
				}
			};

			tx.oncomplete = () => resolve(keys);
			tx.onerror = () => reject(tx.error);
		});
	} catch (e) {
		console.warn("[CollisionTileStore] Error getting cached keys:", e);
		return [];
	}
}

/**
 * Check if a specific tile is cached (without loading the data)
 */
export async function isTileCached(
	floor: number,
	fileX: number,
	fileY: number
): Promise<boolean> {
	try {
		const db = await openDB();
		const key = getCacheKey(floor, fileX, fileY);

		const result = await new Promise<CachedCollisionTile | null>((resolve, reject) => {
			const tx = db.transaction(STORE, "readonly");
			const req = tx.objectStore(STORE).get(key);
			req.onsuccess = () => resolve(req.result ?? null);
			req.onerror = () => reject(req.error);
		});

		if (!result) return false;

		// Check version and age
		if (result.version !== CACHE_VERSION) return false;
		const age = Date.now() - result.timestamp;
		if (age > MAX_CACHE_AGE_MS) return false;

		return true;
	} catch (e) {
		return false;
	}
}

/**
 * Prune old cache entries (entries older than MAX_CACHE_AGE_MS)
 */
export async function pruneOldEntries(): Promise<number> {
	try {
		const db = await openDB();
		const cutoff = Date.now() - MAX_CACHE_AGE_MS;
		let pruned = 0;

		await new Promise<void>((resolve, reject) => {
			const tx = db.transaction(STORE, "readwrite");
			const store = tx.objectStore(STORE);
			const index = store.index("timestamp");
			const range = IDBKeyRange.upperBound(cutoff);
			const req = index.openCursor(range);

			req.onsuccess = () => {
				const cursor = req.result;
				if (cursor) {
					store.delete(cursor.primaryKey);
					pruned++;
					cursor.continue();
				}
			};

			tx.oncomplete = () => resolve();
			tx.onerror = () => reject(tx.error);
		});

		if (pruned > 0) {
			console.log(`[CollisionTileStore] Pruned ${pruned} old entries`);
		}
		return pruned;
	} catch (e) {
		console.warn("[CollisionTileStore] Error pruning old entries:", e);
		return 0;
	}
}

// Expose for debugging
if (typeof globalThis !== "undefined") {
	(globalThis as any).collisionTileCache = {
		load: loadCollisionTile,
		save: saveCollisionTile,
		clear: clearCollisionCache,
		clearFloor: clearFloorCache,
		stats: getCollisionCacheStats,
		prune: pruneOldEntries,
		invalidate: invalidateCollisionTile,
		invalidateBatch: invalidateCollisionTiles,
		getCachedKeys: getAllCachedTileKeys,
		isCached: isTileCached,
	};
}
