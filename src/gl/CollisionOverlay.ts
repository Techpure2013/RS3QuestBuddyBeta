/**
 * CollisionOverlay - Debug visualization of collision data
 *
 * Renders colored tiles showing collision state:
 * - Green: Full movement (byte = 255)
 * - Yellow: Partial movement (some directions blocked)
 * - Red: Blocked (byte = 0 or null)
 * - Arrows show allowed movement directions
 */

import type { GlOverlay, GlUniformArgument } from "@injection/util/patchrs_napi";
import {
	fetchHeightData,
	getHeightAtTile,
	latLngToLocalTile,
} from "@injection/overlays/heightData";

// GL constants
const GL_FLOAT = 0x1406;
const GL_FLOAT_VEC3 = 0x8b51;
const GL_FLOAT_MAT4 = 0x8b5c;

// Uniform type definitions
const uniformTypes = {
	float: { type: GL_FLOAT, len: 1, size: 4, int: false },
	vec3: { type: GL_FLOAT_VEC3, len: 3, size: 4 * 3, int: false },
	mat4: { type: GL_FLOAT_MAT4, len: 16, size: 4 * 16, int: false },
} as const;

type UniformTypeName = keyof typeof uniformTypes;

/**
 * Helper class for building uniform buffers
 */
class UniformSnapshotBuilder<T extends Record<string, UniformTypeName>> {
	args: GlUniformArgument[];
	mappings: {
		[name in keyof T]: { write: (v: number[]) => void; read: () => number[] };
	};
	view: DataView;
	buffer: Uint8Array;

	constructor(init: T) {
		this.args = [];
		this.mappings = {} as any;
		let offset = 0;
		for (const [name, type] of Object.entries(init)) {
			const t = uniformTypes[type as UniformTypeName];
			if (!t) throw new Error("unknown uniform type " + type);
			const entry: GlUniformArgument = {
				name,
				length: 1,
				type: t.type,
				snapshotOffset: offset,
				snapshotSize: t.size,
			};
			this.args.push(entry);
			this.mappings[name as keyof T] = {
				write: (v: number[]) => {
					if (v.length !== t.len) throw new Error("mismatch uniform length");
					for (let i = 0; i < t.len; i++) {
						this.view.setFloat32(entry.snapshotOffset + i * 4, v[i], true);
					}
				},
				read: () => {
					const out: number[] = [];
					for (let i = 0; i < t.len; i++) {
						out.push(this.view.getFloat32(entry.snapshotOffset + i * 4, true));
					}
					return out;
				},
			};
			offset += t.size;
		}
		const data = new ArrayBuffer(offset);
		this.view = new DataView(data);
		this.buffer = new Uint8Array(data);
	}
}

/**
 * Create a translation matrix for positioning at (x, y, z)
 */
function positionMatrix(x: number, y: number, z: number): number[] {
	return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

// Constants
const TILE_SIZE = 512;
const CHUNK_SIZE = 64;
const TILE_HEIGHT_OFFSET = 150; // Height above floor base

// Floor Y positions (same as PathCylinderOverlay)
const FLOOR_Y_BASE = 1152;
const FLOOR_Y_STEP = 1296;

// Colors (RGB 0-1) - made more vivid
const COLLISION_COLORS = {
	open: [0.0, 1.0, 0.3] as [number, number, number], // Bright green - full movement
	partial: [1.0, 0.9, 0.0] as [number, number, number], // Bright yellow - some blocked
	blocked: [1.0, 0.0, 0.0] as [number, number, number], // Bright red - fully blocked
	noData: [0.6, 0.6, 0.6] as [number, number, number], // Gray - no collision data
	arrow: [0.2, 0.4, 1.0] as [number, number, number], // Bright blue - direction arrows
};

// Simple shaders
const vertshader = `
    #version 330 core
    layout (location = 0) in vec3 aPos;
    layout (location = 6) in vec3 aColor;
    uniform highp mat4 uModelMatrix;
    uniform highp mat4 uViewProjMatrix;
    out vec3 ourColor;
    void main() {
        vec4 worldpos = uModelMatrix * vec4(aPos, 1.);
        gl_Position = uViewProjMatrix * worldpos;
        ourColor = aColor;
    }`;

const fragshader = `
    #version 330 core
    in vec3 ourColor;
    out vec4 FragColor;
    void main() {
        FragColor = vec4(ourColor, 1.0);
    }`;

interface CollisionOverlayState {
	isActive: boolean;
	overlays: Map<number, GlOverlay>;
	patchrs: (typeof import("@injection/util/patchrs_napi")) | null;
	program: any | null;
	centerX: number;
	centerY: number;
	floor: number;
	radius: number;
}

const state: CollisionOverlayState = {
	isActive: false,
	overlays: new Map(),
	patchrs: null,
	program: null,
	centerX: 0,
	centerY: 0,
	floor: 0,
	radius: 0,
};

// Direction bits (same as clientPathfinder)
const DIRECTION_BITS = {
	WEST: 1,
	NORTH: 2,
	EAST: 4,
	SOUTH: 8,
	NORTHWEST: 16,
	NORTHEAST: 32,
	SOUTHEAST: 64,
	SOUTHWEST: 128,
};

interface TileCollision {
	x: number;
	y: number;
	byte: number | null;
}

/**
 * Get collision color based on byte value
 */
function getCollisionColor(byte: number | null): [number, number, number] {
	if (byte === null) return COLLISION_COLORS.noData;
	if (byte === 0) return COLLISION_COLORS.blocked;
	if (byte === 255) return COLLISION_COLORS.open;
	return COLLISION_COLORS.partial;
}

/**
 * Count number of allowed directions from collision byte
 */
function countAllowedDirections(byte: number | null): number {
	if (byte === null || byte === 0) return 0;
	let count = 0;
	for (let i = 0; i < 8; i++) {
		if ((byte & (1 << i)) !== 0) count++;
	}
	return count;
}

/**
 * Generate tile mesh vertices for a single tile
 */
function generateTileMesh(
	localX: number,
	localZ: number,
	y: number,
	color: [number, number, number],
	tileScale: number = 0.85 // Scale < 1 to show gaps between tiles
): { positions: number[]; indices: number[] } {
	const positions: number[] = [];
	const indices: number[] = [];

	// Tile center position
	const cx = (localX + 0.5) * TILE_SIZE;
	const cz = (localZ + 0.5) * TILE_SIZE;


	// Half size (with scale)
	const halfSize = (TILE_SIZE * tileScale) / 2;

	// Four corners of the tile (flat quad)
	const corners = [
		[cx - halfSize, y, cz - halfSize], // 0: bottom-left
		[cx + halfSize, y, cz - halfSize], // 1: bottom-right
		[cx + halfSize, y, cz + halfSize], // 2: top-right
		[cx - halfSize, y, cz + halfSize], // 3: top-left
	];

	// Add vertices with color
	for (const [px, py, pz] of corners) {
		positions.push(px, py, pz, color[0], color[1], color[2]);
	}

	// Two triangles for the quad - DOUBLE SIDED
	// Front face (visible from above, CCW winding)
	indices.push(0, 1, 2, 0, 2, 3);
	// Back face (visible from below, reversed winding)
	indices.push(0, 2, 1, 0, 3, 2);

	return { positions, indices };
}

/**
 * Generate arrow mesh for a direction
 */
function generateArrowMesh(
	localX: number,
	localZ: number,
	y: number,
	dx: number,
	dz: number,
	color: [number, number, number]
): { positions: number[]; indices: number[] } {
	const positions: number[] = [];
	const indices: number[] = [];

	// Tile center
	const cx = (localX + 0.5) * TILE_SIZE;
	const cz = (localZ + 0.5) * TILE_SIZE;

	// Arrow geometry
	const arrowLength = TILE_SIZE * 0.35;
	const arrowWidth = TILE_SIZE * 0.08;
	const arrowHeadLength = TILE_SIZE * 0.15;
	const arrowHeadWidth = TILE_SIZE * 0.15;

	// Normalize direction
	const len = Math.sqrt(dx * dx + dz * dz);
	const ndx = dx / len;
	const ndz = dz / len;

	// Perpendicular
	const px = -ndz;
	const pz = ndx;

	// Arrow shaft start/end
	const startX = cx - ndx * arrowLength * 0.3;
	const startZ = cz - ndz * arrowLength * 0.3;
	const endX = cx + ndx * arrowLength * 0.5;
	const endZ = cz + ndz * arrowLength * 0.5;

	// Arrow head tip
	const tipX = cx + ndx * (arrowLength * 0.5 + arrowHeadLength);
	const tipZ = cz + ndz * (arrowLength * 0.5 + arrowHeadLength);

	// Shaft vertices (quad)
	positions.push(
		startX + px * arrowWidth,
		y + 5,
		startZ + pz * arrowWidth,
		color[0],
		color[1],
		color[2]
	);
	positions.push(
		startX - px * arrowWidth,
		y + 5,
		startZ - pz * arrowWidth,
		color[0],
		color[1],
		color[2]
	);
	positions.push(
		endX - px * arrowWidth,
		y + 5,
		endZ - pz * arrowWidth,
		color[0],
		color[1],
		color[2]
	);
	positions.push(
		endX + px * arrowWidth,
		y + 5,
		endZ + pz * arrowWidth,
		color[0],
		color[1],
		color[2]
	);

	// Shaft triangles
	indices.push(0, 1, 2, 0, 2, 3);

	// Arrow head vertices (triangle)
	positions.push(
		endX + px * arrowHeadWidth,
		y + 5,
		endZ + pz * arrowHeadWidth,
		color[0],
		color[1],
		color[2]
	); // 4
	positions.push(
		endX - px * arrowHeadWidth,
		y + 5,
		endZ - pz * arrowHeadWidth,
		color[0],
		color[1],
		color[2]
	); // 5
	positions.push(tipX, y + 5, tipZ, color[0], color[1], color[2]); // 6

	// Arrow head triangle
	indices.push(4, 5, 6);

	return { positions, indices };
}

/**
 * Generate collision mesh for all tiles in a chunk
 */
async function generateCollisionMeshForChunk(
	tiles: TileCollision[],
	chunkX: number,
	chunkZ: number,
	floor: number,
	showArrows: boolean = true
): Promise<{ positions: Float32Array; indices: Uint16Array }> {
	const allPositions: number[] = [];
	const allIndices: number[] = [];

	// Fetch height data for this chunk
	const heightData = await fetchHeightData(chunkX, chunkZ, floor);

	// Root position - chunk-local, centered
	const rootX = (-CHUNK_SIZE / 2) * TILE_SIZE;
	const rootZ = (-CHUNK_SIZE / 2) * TILE_SIZE;

	let vertexOffset = 0;

	let firstTileLogged = false;
	for (const tile of tiles) {
		// Check if tile is in this chunk
		const tileChunkX = Math.floor(tile.x / CHUNK_SIZE);
		const tileChunkZ = Math.floor(tile.y / CHUNK_SIZE);
		if (tileChunkX !== chunkX || tileChunkZ !== chunkZ) continue;

		// Local tile position within chunk
		const localTileX = tile.x - chunkX * CHUNK_SIZE;
		const localTileZ = tile.y - chunkZ * CHUNK_SIZE;

		// Calculate Y position based on floor level
		// Use floor base + offset to ensure tiles render above the floor geometry
		const floorBaseY = FLOOR_Y_BASE + floor * FLOOR_Y_STEP;
		let y = floorBaseY + TILE_HEIGHT_OFFSET;

		// Optionally add terrain height variation if available
		if (heightData) {
			const { tileX, tileZ } = latLngToLocalTile(tile.y, tile.x);
			const terrainHeight = getHeightAtTile(heightData, tileX, tileZ, 0.5, 0.5);
			// Only use terrain height if it's reasonable (not too different from floor base)
			if (terrainHeight > floorBaseY - 500 && terrainHeight < floorBaseY + 500) {
				y = terrainHeight + TILE_HEIGHT_OFFSET;
			}
		}

		// Adjust local position to be relative to chunk center
		const adjustedLocalX = localTileX - CHUNK_SIZE / 2;
		const adjustedLocalZ = localTileZ - CHUNK_SIZE / 2;

		// Debug log first tile
		if (!firstTileLogged) {
			const worldX = (chunkX + 0.5) * TILE_SIZE * CHUNK_SIZE + (adjustedLocalX + 0.5) * TILE_SIZE;
			const worldZ = (chunkZ + 0.5) * TILE_SIZE * CHUNK_SIZE + (adjustedLocalZ + 0.5) * TILE_SIZE;
			console.log(`[CollisionOverlay] First tile: game(${tile.x}, ${tile.y}) floor=${floor} floorBaseY=${floorBaseY} -> world(${worldX}, ${worldZ}) y=${y}`);
			firstTileLogged = true;
		}

		// Generate tile quad
		const color = getCollisionColor(tile.byte);
		const tileMesh = generateTileMesh(adjustedLocalX, adjustedLocalZ, y, color);

		// Add vertices
		for (let i = 0; i < tileMesh.positions.length; i++) {
			allPositions.push(tileMesh.positions[i]);
		}

		// Add indices (offset by current vertex count)
		for (const idx of tileMesh.indices) {
			allIndices.push(idx + vertexOffset);
		}
		vertexOffset += tileMesh.positions.length / 6;

		// Generate arrows for allowed directions (only for partial tiles to reduce clutter)
		if (showArrows && tile.byte !== null && tile.byte !== 0 && tile.byte !== 255) {
			const directionVectors: Array<[number, keyof typeof DIRECTION_BITS, number, number]> = [
				[DIRECTION_BITS.NORTH, "NORTH", 0, 1],
				[DIRECTION_BITS.SOUTH, "SOUTH", 0, -1],
				[DIRECTION_BITS.EAST, "EAST", 1, 0],
				[DIRECTION_BITS.WEST, "WEST", -1, 0],
			];

			for (const [bit, , dx, dz] of directionVectors) {
				if ((tile.byte & bit) !== 0) {
					const arrowMesh = generateArrowMesh(
						adjustedLocalX,
						adjustedLocalZ,
						y,
						dx,
						dz,
						COLLISION_COLORS.arrow
					);

					for (let i = 0; i < arrowMesh.positions.length; i++) {
						allPositions.push(arrowMesh.positions[i]);
					}
					for (const idx of arrowMesh.indices) {
						allIndices.push(idx + vertexOffset);
					}
					vertexOffset += arrowMesh.positions.length / 6;
				}
			}
		}
	}

	return {
		positions: new Float32Array(allPositions),
		indices: new Uint16Array(allIndices),
	};
}

/**
 * Find floor VAOs for chunks
 */
async function findFloorChunks(
	chunkCoords: Array<{ chunkX: number; chunkZ: number }>,
	floor: number
): Promise<
	Map<
		string,
		{
			chunkX: number;
			chunkZ: number;
			floorY: number;
			vertexObjectId: number;
			programId: number;
		}
	>
> {
	if (!state.patchrs?.native) return new Map();

	const chunkSet = new Set(chunkCoords.map((c) => `${c.chunkX},${c.chunkZ}`));
	const foundChunks = new Map<
		string,
		{
			chunkX: number;
			chunkZ: number;
			floorY: number;
			vertexObjectId: number;
			programId: number;
		}
	>();

	let renders: any[] = [];
	try {
		renders = await state.patchrs.native.recordRenderCalls({
			maxframes: 1,
			features: ["vertexarray", "uniforms"],
		});

		const allFloors = new Map<
			string,
			Array<{
				chunkX: number;
				chunkZ: number;
				floorY: number;
				vertexObjectId: number;
				programId: number;
			}>
		>();

		for (const render of renders) {
			if (!render.program?.inputs?.find((i: any) => i.name === "aMaterialSettingsSlotXY3"))
				continue;
			if (!render.uniformState) continue;

			const modelMatrixUniform = render.program.uniforms?.find(
				(u: any) => u.name === "uModelMatrix"
			);
			if (!modelMatrixUniform) continue;

			const offset = modelMatrixUniform.snapshotOffset;
			const dv = new DataView(
				render.uniformState.buffer,
				render.uniformState.byteOffset + offset
			);
			const worldX = dv.getFloat32(12 * 4, true);
			const worldY = dv.getFloat32(13 * 4, true);
			const worldZ = dv.getFloat32(14 * 4, true);

			const chunkX = Math.floor(worldX / (TILE_SIZE * CHUNK_SIZE));
			const chunkZ = Math.floor(worldZ / (TILE_SIZE * CHUNK_SIZE));
			const key = `${chunkX},${chunkZ}`;

			if (chunkSet.has(key)) {
				if (!allFloors.has(key)) {
					allFloors.set(key, []);
				}
				allFloors.get(key)!.push({
					chunkX,
					chunkZ,
					floorY: worldY,
					vertexObjectId: render.vertexObjectId,
					programId: render.program.programId,
				});
			}
		}

		// Select floor VAO matching target floor
		const FLOOR_Y_BASE = 1152;
		const FLOOR_Y_STEP = 1296;
		const expectedY = FLOOR_Y_BASE + floor * FLOOR_Y_STEP;

		for (const [key, floors] of allFloors) {
			floors.sort((a, b) => Math.abs(a.floorY - expectedY) - Math.abs(b.floorY - expectedY));
			const bestFloor = floors[0];
			const actualFloor = Math.max(
				0,
				Math.min(3, Math.round((bestFloor.floorY - FLOOR_Y_BASE) / FLOOR_Y_STEP))
			);

			if (actualFloor === floor) {
				foundChunks.set(key, bestFloor);
			}
		}
	} catch (e) {
		console.error("[CollisionOverlay] Error finding floor chunks:", e);
	} finally {
		for (const r of renders) {
			try { r.dispose?.(); } catch (_) {}
		}
	}

	return foundChunks;
}

/**
 * Create overlay for a chunk
 */
async function createChunkOverlay(
	tiles: TileCollision[],
	chunkX: number,
	chunkZ: number,
	floor: number,
	vertexObjectId: number,
	showArrows: boolean
): Promise<GlOverlay | null> {
	if (!state.patchrs?.native) return null;

	const mesh = await generateCollisionMeshForChunk(tiles, chunkX, chunkZ, floor, showArrows);
	if (mesh.indices.length === 0) return null;

	// Create program if not cached
	if (!state.program) {
		state.program = state.patchrs.native.createProgram(
			vertshader,
			fragshader,
			[
				{ location: 0, name: "aPos", type: GL_FLOAT, length: 3 },
				{ location: 6, name: "aColor", type: GL_FLOAT, length: 3 },
			],
			[
				{ name: "uModelMatrix", length: 1, type: GL_FLOAT_MAT4, snapshotOffset: 0, snapshotSize: 64 },
				{ name: "uViewProjMatrix", length: 1, type: GL_FLOAT_MAT4, snapshotOffset: 64, snapshotSize: 64 },
			]
		);
	}

	const vertexBuffer = new Uint8Array(mesh.positions.buffer);
	const indexBuffer = new Uint8Array(mesh.indices.buffer);

	const vertex = state.patchrs.native.createVertexArray(indexBuffer, [
		{
			location: 0,
			buffer: vertexBuffer,
			enabled: true,
			normalized: false,
			offset: 0,
			stride: 6 * 4,
			scalartype: GL_FLOAT,
			vectorlength: 3,
		},
		{
			location: 6,
			buffer: vertexBuffer,
			enabled: true,
			normalized: false,
			offset: 3 * 4,
			stride: 6 * 4,
			scalartype: GL_FLOAT,
			vectorlength: 3,
		},
	]);

	const uniforms = new UniformSnapshotBuilder({
		uModelMatrix: "mat4",
		uViewProjMatrix: "mat4",
	});

	const modelMatrix = positionMatrix(
		(chunkX + 0.5) * TILE_SIZE * CHUNK_SIZE,
		0,
		(chunkZ + 0.5) * TILE_SIZE * CHUNK_SIZE
	);
	uniforms.mappings.uModelMatrix.write(modelMatrix);

	const uniformSources = [
		{ name: "uViewProjMatrix", sourceName: "uViewProjMatrix", type: "program" as const },
	];

	const renderRanges = [{ start: 0, length: mesh.indices.length }];

	// Log debug info
	console.log(`[CollisionOverlay] Creating overlay:`, {
		vertexObjectId,
		chunkX, chunkZ, floor,
		positionsLength: mesh.positions.length,
		indicesLength: mesh.indices.length,
		firstVertex: mesh.positions.length > 0 ? [mesh.positions[0], mesh.positions[1], mesh.positions[2]] : null,
		modelMatrix: modelMatrix.slice(12, 15), // translation part
	});

	try {
		const overlay = state.patchrs.native.beginOverlay(
			{ vertexObjectId },
			state.program,
			vertex,
			{
				uniformSources,
				uniformBuffer: uniforms.buffer,
				ranges: renderRanges,
			}
		);

		console.log(
			`[CollisionOverlay] Created overlay for chunk (${chunkX}, ${chunkZ}) with ${mesh.indices.length / 3} triangles, VAO=${vertexObjectId}`
		);
		return overlay;
	} catch (e) {
		console.error("[CollisionOverlay] Failed to create overlay:", e);
		return null;
	}
}

/**
 * Initialize the overlay system
 */
async function init(): Promise<boolean> {
	if (state.patchrs) return true;

	try {
		state.patchrs = await import("@injection/util/patchrs_napi");
		if (!state.patchrs.native) {
			console.warn("[CollisionOverlay] Native addon not available");
			return false;
		}

		console.log("[CollisionOverlay] Initialized");
		return true;
	} catch (e) {
		console.error("[CollisionOverlay] Failed to init:", e);
		return false;
	}
}

/**
 * Show collision overlay for an area
 * @param centerX Center X coordinate (game tiles)
 * @param centerY Center Y coordinate (game tiles)
 * @param floor Floor level (0-3)
 * @param radius Radius in tiles (default 15)
 * @param showArrows Whether to show direction arrows (default true)
 */
export async function showCollisionOverlay(
	centerX: number,
	centerY: number,
	floor: number,
	radius: number = 15,
	showArrows: boolean = true
): Promise<boolean> {
	const initialized = await init();
	if (!initialized || !state.patchrs) {
		console.log("[CollisionOverlay] Not initialized");
		return false;
	}

	// Clear existing overlays first
	await clearCollisionOverlay();

	// Import collision cache from clientPathfinder
	const { preloadCollisionData } = await import("../api/clientPathfinder");

	// Preload collision data for the region
	console.log(`[CollisionOverlay] Preloading collision data around (${centerX}, ${centerY}) floor ${floor}`);
	await preloadCollisionData(centerX, centerY, floor, 1);

	// Now access the collision cache to get tile data
	// We'll import the collisionCache indirectly via a debug helper
	const collisionBytes: TileCollision[] = [];

	// Get collision bytes for all tiles in radius
	const { getCollisionByteForOverlay } = await import("../api/clientPathfinder");

	for (let dx = -radius; dx <= radius; dx++) {
		for (let dy = -radius; dy <= radius; dy++) {
			const x = centerX + dx;
			const y = centerY + dy;
			const byte = await getCollisionByteForOverlay(x, y, floor);
			collisionBytes.push({ x, y, byte });
		}
	}

	console.log(`[CollisionOverlay] Collected ${collisionBytes.length} tiles`);

	// Group tiles by chunk
	const chunkMap = new Map<string, TileCollision[]>();
	for (const tile of collisionBytes) {
		const chunkX = Math.floor(tile.x / CHUNK_SIZE);
		const chunkZ = Math.floor(tile.y / CHUNK_SIZE);
		const key = `${chunkX},${chunkZ}`;
		if (!chunkMap.has(key)) {
			chunkMap.set(key, []);
		}
		chunkMap.get(key)!.push(tile);
	}

	// Find floor VAOs for chunks
	const chunkCoords = [...chunkMap.keys()].map((k) => {
		const [cx, cz] = k.split(",").map(Number);
		return { chunkX: cx, chunkZ: cz };
	});

	const floorChunks = await findFloorChunks(chunkCoords, floor);
	console.log(`[CollisionOverlay] Found ${floorChunks.size} floor VAOs`);

	if (floorChunks.size === 0) {
		console.log("[CollisionOverlay] No floor chunks visible - try moving camera");
		return false;
	}

	// Create overlays for each chunk
	for (const [key, chunkInfo] of floorChunks) {
		const tiles = chunkMap.get(key) || [];
		const overlay = await createChunkOverlay(
			tiles,
			chunkInfo.chunkX,
			chunkInfo.chunkZ,
			floor,
			chunkInfo.vertexObjectId,
			showArrows
		);
		if (overlay) {
			state.overlays.set(chunkInfo.vertexObjectId, overlay);
		}
	}

	state.isActive = state.overlays.size > 0;
	state.centerX = centerX;
	state.centerY = centerY;
	state.floor = floor;
	state.radius = radius;

	// Print summary
	const openCount = collisionBytes.filter((t) => t.byte === 255).length;
	const partialCount = collisionBytes.filter(
		(t) => t.byte !== null && t.byte !== 0 && t.byte !== 255
	).length;
	const blockedCount = collisionBytes.filter((t) => t.byte === 0).length;
	const noDataCount = collisionBytes.filter((t) => t.byte === null).length;

	console.log(`[CollisionOverlay] Summary:`);
	console.log(`  Green (open): ${openCount}`);
	console.log(`  Yellow (partial): ${partialCount}`);
	console.log(`  Red (blocked): ${blockedCount}`);
	console.log(`  Gray (no data): ${noDataCount}`);

	return state.isActive;
}

/**
 * Clear collision overlay
 */
export async function clearCollisionOverlay(): Promise<void> {
	const count = state.overlays.size;
	if (count === 0) {
		state.isActive = false;
		return;
	}

	console.log(`[CollisionOverlay] Clearing ${count} overlays...`);

	for (const [vaoId, overlay] of state.overlays.entries()) {
		try {
			overlay.stop();
		} catch (e) {
			console.warn(`[CollisionOverlay] Error stopping overlay for VAO ${vaoId}:`, e);
		}
	}

	state.overlays.clear();
	state.isActive = false;
	state.program = null;

	console.log(`[CollisionOverlay] Cleared`);
}

/**
 * Check if overlay is active
 */
export function isCollisionOverlayActive(): boolean {
	return state.isActive;
}

/**
 * Get current overlay info
 */
export function getCollisionOverlayInfo(): {
	active: boolean;
	centerX: number;
	centerY: number;
	floor: number;
	radius: number;
} {
	return {
		active: state.isActive,
		centerX: state.centerX,
		centerY: state.centerY,
		floor: state.floor,
		radius: state.radius,
	};
}
