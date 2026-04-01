/**
 * Height data fetcher for terrain-aware overlays
 * Based on alt1gl tilemarkers approach
 */

export const CHUNK_SIZE = 64;
export const TILE_SIZE = 512;
export const HEIGHT_SCALING = TILE_SIZE / 32;

const HEIGHT_DATA_ENDPOINT = "https://runeapps.org/s3/map4/live/";
const HEIGHT_DATA_FALLBACK = "https://runeapps.org/s3/map4/1764321618/";

// Cache for loaded height data
const heightCache = new Map<string, Uint16Array | null>();
const pendingFetches = new Map<string, Promise<Uint16Array | null>>();

/**
 * Get cache key for a chunk
 */
function getCacheKey(chunkX: number, chunkZ: number, level: number): string {
    return `${level}/${chunkX}-${chunkZ}`;
}

/**
 * Fetch height data for a chunk
 */
export async function fetchHeightData(
    chunkX: number,
    chunkZ: number,
    level: number = 0
): Promise<Uint16Array | null> {
    const key = getCacheKey(chunkX, chunkZ, level);

    // Return cached data if available
    if (heightCache.has(key)) {
        return heightCache.get(key) ?? null;
    }

    // Return pending fetch if already in progress
    if (pendingFetches.has(key)) {
        return pendingFetches.get(key)!;
    }

    // Start new fetch
    const fetchPromise = (async (): Promise<Uint16Array | null> => {
        try {
            const path = `heightmesh-${level}/${chunkX}-${chunkZ}.bin`;
            const url = `${HEIGHT_DATA_ENDPOINT}${path}`;
            console.log(`[HeightData] Fetching ${url}`);

            let res = await fetch(url);
            if (res.status === 403) {
                const fallbackUrl = `${HEIGHT_DATA_FALLBACK}${path}`;
                console.log(`[HeightData] /live/ returned 403, trying versioned fallback: ${fallbackUrl}`);
                res = await fetch(fallbackUrl);
            }
            if (!res.ok) {
                console.warn(`[HeightData] Failed to fetch height data for chunk ${chunkX},${chunkZ}: ${res.status}`);
                heightCache.set(key, null);
                return null;
            }

            const data = new Uint16Array(await res.arrayBuffer());
            const expectedLen = CHUNK_SIZE * CHUNK_SIZE * 5; // 4 corner heights + 1 collision flag per tile
            if (data.length !== expectedLen) {
                console.warn(`[HeightData] Unexpected data size for ${chunkX},${chunkZ}: got ${data.length} elements, expected ${expectedLen} (stride mismatch?)`);
            }
            heightCache.set(key, data);
            console.log(`[HeightData] Loaded height data for chunk ${chunkX},${chunkZ} (${data.length} elements)`);
            return data;
        } catch (e) {
            console.error(`[HeightData] Error fetching height data:`, e);
            heightCache.set(key, null);
            return null;
        } finally {
            pendingFetches.delete(key);
        }
    })();

    pendingFetches.set(key, fetchPromise);
    return fetchPromise;
}

/**
 * Convert lat/lng to chunk coordinates
 */
export function latLngToChunk(lat: number, lng: number): { chunkX: number; chunkZ: number } {
    // RS3 map coordinates: lat/lng are in tile units
    // Chunks are 64 tiles each
    const chunkX = Math.floor(lng / CHUNK_SIZE);
    const chunkZ = Math.floor(lat / CHUNK_SIZE);
    return { chunkX, chunkZ };
}

/**
 * Convert lat/lng to local tile position within a chunk
 */
export function latLngToLocalTile(lat: number, lng: number): { tileX: number; tileZ: number } {
    const tileX = ((lng % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    const tileZ = ((lat % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
    return { tileX: Math.floor(tileX), tileZ: Math.floor(tileZ) };
}

/**
 * Get terrain height at a specific tile position within chunk height data
 */
export function getHeightAtTile(
    heightData: Uint16Array,
    tileX: number,
    tileZ: number,
    subX: number = 0.5,
    subZ: number = 0.5
): number {
    // Each tile has 5 values: 4 corner heights + collision flags
    const tileIndex = (tileX + tileZ * CHUNK_SIZE) * 5;

    if (tileIndex < 0 || tileIndex + 4 >= heightData.length) {
        return 0;
    }

    // Bilinear interpolation of the 4 corner heights
    const y00 = heightData[tileIndex + 0] * HEIGHT_SCALING * (1 - subX) * (1 - subZ);
    const y01 = heightData[tileIndex + 1] * HEIGHT_SCALING * subX * (1 - subZ);
    const y10 = heightData[tileIndex + 2] * HEIGHT_SCALING * (1 - subX) * subZ;
    const y11 = heightData[tileIndex + 3] * HEIGHT_SCALING * subX * subZ;

    return y00 + y01 + y10 + y11;
}

/**
 * Get height at a world lat/lng position
 */
export async function getHeightAtLatLng(
    lat: number,
    lng: number,
    level: number = 0
): Promise<number> {
    const { chunkX, chunkZ } = latLngToChunk(lat, lng);
    const { tileX, tileZ } = latLngToLocalTile(lat, lng);

    const heightData = await fetchHeightData(chunkX, chunkZ, level);
    if (!heightData) {
        return 0;
    }

    // Get sub-tile position (fractional part)
    const subX = lng - Math.floor(lng);
    const subZ = lat - Math.floor(lat);

    return getHeightAtTile(heightData, tileX, tileZ, subX, subZ);
}

/**
 * Convert lat/lng to world position with proper height
 */
export async function latLngToWorldWithHeight(
    lat: number,
    lng: number,
    level: number = 0
): Promise<{ x: number; y: number; z: number }> {
    const x = lng * TILE_SIZE;
    const z = lat * TILE_SIZE;
    const y = await getHeightAtLatLng(lat, lng, level);

    return { x, y, z };
}

/**
 * Clear the height data cache
 */
export function clearHeightCache(): void {
    heightCache.clear();
}

/**
 * Maximum floor levels in RS3 (0-3 typically)
 */
export const MAX_FLOOR_LEVELS = 4;

/**
 * Fetch height data for all available levels of a chunk
 * Returns an array indexed by level (null for unavailable levels)
 */
export async function fetchAllLevelsHeightData(
    chunkX: number,
    chunkZ: number
): Promise<(Uint16Array | null)[]> {
    // Fetch all levels in parallel
    const promises = [];
    for (let level = 0; level < MAX_FLOOR_LEVELS; level++) {
        promises.push(fetchHeightData(chunkX, chunkZ, level));
    }

    return Promise.all(promises);
}

/**
 * Get tile collision/flags data (5th value per tile)
 * This may contain information about floor level occupancy
 */
export function getTileFlags(
    heightData: Uint16Array,
    tileX: number,
    tileZ: number
): number {
    const tileIndex = (tileX + tileZ * CHUNK_SIZE) * 5;
    if (tileIndex < 0 || tileIndex + 4 >= heightData.length) {
        return 0;
    }
    return heightData[tileIndex + 4];
}

/**
 * Check if a tile has valid height data (non-zero heights)
 */
export function tileHasValidHeight(
    heightData: Uint16Array,
    tileX: number,
    tileZ: number
): boolean {
    const tileIndex = (tileX + tileZ * CHUNK_SIZE) * 5;
    if (tileIndex < 0 || tileIndex + 4 >= heightData.length) {
        return false;
    }
    // Check if any corner has non-zero height
    return heightData[tileIndex + 0] > 0 ||
           heightData[tileIndex + 1] > 0 ||
           heightData[tileIndex + 2] > 0 ||
           heightData[tileIndex + 3] > 0;
}

/**
 * Get heights for all available levels at a specific tile
 * Returns array of { level, height } for levels that have valid data
 */
export async function getHeightsAtAllLevels(
    lat: number,
    lng: number
): Promise<{ level: number; height: number; flags: number }[]> {
    const { chunkX, chunkZ } = latLngToChunk(lat, lng);
    const { tileX, tileZ } = latLngToLocalTile(lat, lng);
    const subX = lng - Math.floor(lng);
    const subZ = lat - Math.floor(lat);

    const allLevels = await fetchAllLevelsHeightData(chunkX, chunkZ);
    const results: { level: number; height: number; flags: number }[] = [];

    for (let level = 0; level < allLevels.length; level++) {
        const heightData = allLevels[level];
        if (heightData && tileHasValidHeight(heightData, tileX, tileZ)) {
            const height = getHeightAtTile(heightData, tileX, tileZ, subX, subZ);
            const flags = getTileFlags(heightData, tileX, tileZ);
            results.push({ level, height, flags });
        }
    }

    return results;
}

/**
 * Find the best matching floor level for a given Y height
 * Useful for determining which level an overlay should render on
 */
export async function findBestLevelForHeight(
    lat: number,
    lng: number,
    targetY: number
): Promise<{ level: number; height: number } | null> {
    const levels = await getHeightsAtAllLevels(lat, lng);

    if (levels.length === 0) {
        return null;
    }

    // Find the level with height closest to (but not above) targetY
    let best: { level: number; height: number } | null = null;
    let bestDiff = Infinity;

    for (const { level, height } of levels) {
        const diff = Math.abs(height - targetY);
        if (diff < bestDiff) {
            bestDiff = diff;
            best = { level, height };
        }
    }

    return best;
}

/**
 * Create terrain-conforming vertices for a rectangular area across all levels
 * Returns vertices for each level that has terrain in the area
 */
export async function createMultiLevelTerrainMesh(
    minLat: number,
    minLng: number,
    maxLat: number,
    maxLng: number,
    resolution: number = 1 // tiles per vertex
): Promise<{
    level: number;
    vertices: Float32Array;  // x, y, z per vertex
    indices: Uint16Array;
}[]> {
    const results: {
        level: number;
        vertices: Float32Array;
        indices: Uint16Array;
    }[] = [];

    // For each level, try to build a mesh
    for (let level = 0; level < MAX_FLOOR_LEVELS; level++) {
        const vertices: number[] = [];
        const indices: number[] = [];
        let hasValidData = false;

        // Iterate through all tiles in the area
        const tilesX = Math.ceil(maxLng - minLng);
        const tilesZ = Math.ceil(maxLat - minLat);

        for (let tz = 0; tz <= tilesZ; tz += resolution) {
            for (let tx = 0; tx <= tilesX; tx += resolution) {
                const lat = minLat + tz;
                const lng = minLng + tx;

                const { chunkX, chunkZ } = latLngToChunk(lat, lng);
                const { tileX, tileZ } = latLngToLocalTile(lat, lng);

                const heightData = await fetchHeightData(chunkX, chunkZ, level);

                let y = 0;
                if (heightData && tileHasValidHeight(heightData, tileX, tileZ)) {
                    y = getHeightAtTile(heightData, tileX, tileZ, 0.5, 0.5);
                    hasValidData = true;
                }

                // World coordinates
                const worldX = lng * TILE_SIZE;
                const worldZ = lat * TILE_SIZE;

                vertices.push(worldX, y, worldZ);
            }
        }

        if (!hasValidData) continue;

        // Build triangle indices (grid of quads -> triangles)
        const gridWidth = Math.floor(tilesX / resolution) + 1;
        const gridHeight = Math.floor(tilesZ / resolution) + 1;

        for (let z = 0; z < gridHeight - 1; z++) {
            for (let x = 0; x < gridWidth - 1; x++) {
                const topLeft = z * gridWidth + x;
                const topRight = topLeft + 1;
                const bottomLeft = (z + 1) * gridWidth + x;
                const bottomRight = bottomLeft + 1;

                // Two triangles per quad
                indices.push(topLeft, bottomLeft, topRight);
                indices.push(topRight, bottomLeft, bottomRight);
            }
        }

        if (indices.length > 0) {
            results.push({
                level,
                vertices: Float32Array.from(vertices),
                indices: Uint16Array.from(indices)
            });
        }
    }

    return results;
}

/**
 * Debug function: Log terrain info for a position
 */
export async function debugTerrainAtPosition(lat: number, lng: number): Promise<void> {
    console.log(`[HeightData] Debug terrain at lat=${lat.toFixed(2)}, lng=${lng.toFixed(2)}`);

    const { chunkX, chunkZ } = latLngToChunk(lat, lng);
    const { tileX, tileZ } = latLngToLocalTile(lat, lng);

    console.log(`  Chunk: (${chunkX}, ${chunkZ}), Local tile: (${tileX}, ${tileZ})`);
    console.log(`  World coords: X=${(lng * TILE_SIZE).toFixed(0)}, Z=${(lat * TILE_SIZE).toFixed(0)}`);

    const levels = await getHeightsAtAllLevels(lat, lng);

    if (levels.length === 0) {
        console.log(`  No height data available for any level`);
    } else {
        for (const { level, height, flags } of levels) {
            console.log(`  Level ${level}: height=${height.toFixed(1)}, flags=0x${flags.toString(16)}`);
        }
    }
}

// Expose terrain utilities globally for console debugging
if (typeof globalThis !== 'undefined') {
    (globalThis as any).terrainDebug = {
        debugTerrainAtPosition,
        getHeightsAtAllLevels,
        fetchHeightData,
        fetchAllLevelsHeightData,
        latLngToChunk,
        latLngToLocalTile,
        CHUNK_SIZE,
        TILE_SIZE,
        HEIGHT_SCALING,
        MAX_FLOOR_LEVELS
    };
}