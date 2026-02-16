/**
 * PathTubeOverlay - Connected cylindrical tubes for path visualization
 *
 * Creates solid cyan tubes connecting path nodes for NPC guidance.
 * Uses a SINGLE global overlay to render the entire path at once.
 */

import type { GlOverlay, GlUniformArgument } from "@injection/util/patchrs_napi";
import {
	fetchHeightData,
	getHeightAtTile,
	latLngToLocalTile,
} from "@injection/overlays/heightData";

// GL constants
const GL_FLOAT = 0x1406;
const GL_FLOAT_MAT4 = 0x8B5C;

// Uniform type definitions for UniformSnapshotBuilder
const uniformTypes = {
	mat4: { type: GL_FLOAT_MAT4, len: 16, size: 4 * 16, int: false },
} as const;

type UniformTypeName = keyof typeof uniformTypes;

/**
 * Helper class for building uniform buffers
 */
class UniformSnapshotBuilder<T extends Record<string, UniformTypeName>> {
	args: GlUniformArgument[];
	mappings: { [name in keyof T]: { write: (v: number[]) => void; read: () => number[] } };
	view: DataView;
	buffer: Uint8Array;

	constructor(init: T) {
		this.args = [];
		this.mappings = {} as any;
		let offset = 0;
		for (const [name, type] of Object.entries(init)) {
			const t = uniformTypes[type as UniformTypeName];
			if (!t) throw new Error("unknown uniform type " + type);
			const entry: GlUniformArgument = { name, length: 1, type: t.type, snapshotOffset: offset, snapshotSize: t.size };
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

// Constants
const TILE_SIZE = 512;
const CHUNK_SIZE = 64;

// Tube dimensions
const TUBE_RADIUS = 8; // Radius of the tube in world units
const TUBE_SEGMENTS = 8; // Number of segments around the tube circumference
const TUBE_HEIGHT_OFFSET = 100; // Height above terrain

// Floor Y constants for fallback height calculation
const FLOOR_Y_BASE = 1152;
const FLOOR_Y_STEP = 1296;

// Solid cyan color
const TUBE_COLOR: [number, number, number] = [0.0, 0.85, 0.85];

// Shader - simple vertex color pass-through
const vertshader = `#version 330 core
layout (location = 0) in vec3 aPos;
layout (location = 1) in vec3 aColor;
uniform highp mat4 uModelMatrix;
uniform highp mat4 uViewProjMatrix;
out vec3 vColor;
void main() {
    vec4 worldpos = uModelMatrix * vec4(aPos, 1.);
    gl_Position = uViewProjMatrix * worldpos;
    vColor = aColor;
}`;

const fragshader = `#version 330 core
in vec3 vColor;
out vec4 fragColor;
void main() {
    fragColor = vec4(vColor, 1.0);
}`;

interface PathNode {
	lat: number;
	lng: number;
	floor: number;
}

interface PathTubeState {
	isActive: boolean;
	overlay: GlOverlay | null;
	patchrs: typeof import("@injection/util/patchrs_napi") | null;
	fullPath: PathNode[];
	isDrawing: boolean;
	generation: number;
	lastPathHash: string;
	lastRedrawTime: number;
	knownFloorProgramId: number | null;
	anchorVaoId: number | null;
	heightCache: Map<string, Uint16Array | null>;
	vertexArray: any | null;
}

const REDRAW_THROTTLE_MS = 500;
const WRONG_PROG_MASK = 0x1000;

const state: PathTubeState = {
	isActive: false,
	overlay: null,
	patchrs: null,
	fullPath: [],
	isDrawing: false,
	generation: 0,
	lastPathHash: "",
	lastRedrawTime: 0,
	knownFloorProgramId: null,
	anchorVaoId: null,
	heightCache: new Map(),
	vertexArray: null,
};

function getPathHash(path: Array<{ lat: number; lng: number; floor: number }>): string {
	if (path.length === 0) return "";
	const first = path[0];
	const last = path[path.length - 1];
	return `${path.length}:${first.lat.toFixed(1)},${first.lng.toFixed(1)},${first.floor}:${last.lat.toFixed(1)},${last.lng.toFixed(1)},${last.floor}`;
}

async function getHeightAtWorldTile(lat: number, lng: number, floor: number): Promise<number> {
	const chunkX = Math.floor(lng / CHUNK_SIZE);
	const chunkZ = Math.floor(lat / CHUNK_SIZE);
	const cacheKey = `${chunkX},${chunkZ},${floor}`;

	if (!state.heightCache.has(cacheKey)) {
		const heightData = await fetchHeightData(chunkX, chunkZ, floor);
		state.heightCache.set(cacheKey, heightData);
	}

	const heightData = state.heightCache.get(cacheKey);
	if (heightData) {
		const { tileX, tileZ } = latLngToLocalTile(lat, lng);
		return getHeightAtTile(heightData, tileX, tileZ, 0.5, 0.5) + TUBE_HEIGHT_OFFSET;
	}

	return FLOOR_Y_BASE + floor * FLOOR_Y_STEP + TUBE_HEIGHT_OFFSET;
}

function tileToWorld(lat: number, lng: number): { x: number; z: number } {
	return {
		x: (lng + 0.5) * TILE_SIZE,
		z: (lat + 0.5) * TILE_SIZE,
	};
}

/**
 * Generate a cylinder segment between two points
 * Uses explicit double-sided triangle rendering for no face culling
 */
function generateCylinderSegment(
	startX: number, startY: number, startZ: number,
	endX: number, endY: number, endZ: number,
	radius: number,
	color: [number, number, number],
	baseVertexIndex: number
): { verts: number[]; inds: number[] } {
	const verts: number[] = [];
	const inds: number[] = [];

	// Direction vector from start to end
	const dx = endX - startX;
	const dy = endY - startY;
	const dz = endZ - startZ;
	const length = Math.sqrt(dx * dx + dy * dy + dz * dz);

	if (length < 0.001) {
		return { verts, inds };
	}

	// Normalize direction
	const dirX = dx / length;
	const dirY = dy / length;
	const dirZ = dz / length;

	// Find perpendicular vectors for the tube cross-section
	// Use a more robust method - try multiple reference vectors
	let refX = 0, refY = 1, refZ = 0;
	// If direction is too parallel to Y, use X instead
	if (Math.abs(dirY) > 0.9) {
		refX = 1; refY = 0; refZ = 0;
	}

	// Cross product: right = dir x ref (gives perpendicular)
	let rightX = dirY * refZ - dirZ * refY;
	let rightY = dirZ * refX - dirX * refZ;
	let rightZ = dirX * refY - dirY * refX;
	let rightLen = Math.sqrt(rightX * rightX + rightY * rightY + rightZ * rightZ);

	// Safety check - if still near zero, try Z reference
	if (rightLen < 0.001) {
		refX = 0; refY = 0; refZ = 1;
		rightX = dirY * refZ - dirZ * refY;
		rightY = dirZ * refX - dirX * refZ;
		rightZ = dirX * refY - dirY * refX;
		rightLen = Math.sqrt(rightX * rightX + rightY * rightY + rightZ * rightZ);
	}

	rightX /= rightLen;
	rightY /= rightLen;
	rightZ /= rightLen;

	// Cross product: up = right x dir (orthogonal to both)
	const upX = rightY * dirZ - rightZ * dirY;
	const upY = rightZ * dirX - rightX * dirZ;
	const upZ = rightX * dirY - rightY * dirX;

	let idx = baseVertexIndex;
	const [r, g, b] = color;

	// Helper to add a double-sided triangle (both winding orders)
	const addDoubleSidedTri = (
		x1: number, y1: number, z1: number,
		x2: number, y2: number, z2: number,
		x3: number, y3: number, z3: number
	) => {
		const i = idx;
		verts.push(x1, y1, z1, r, g, b);
		verts.push(x2, y2, z2, r, g, b);
		verts.push(x3, y3, z3, r, g, b);
		// Both windings for double-sided
		inds.push(i, i + 1, i + 2);
		inds.push(i, i + 2, i + 1);
		idx += 3;
	};

	// Generate ring vertices at start and end
	// Use negative angle to ensure consistent winding regardless of tube direction
	const startRing: { x: number; y: number; z: number }[] = [];
	const endRing: { x: number; y: number; z: number }[] = [];

	for (let i = 0; i < TUBE_SEGMENTS; i++) {
		// Negative angle for clockwise winding when viewed from start toward end
		const angle = -(i / TUBE_SEGMENTS) * Math.PI * 2;
		const cos = Math.cos(angle);
		const sin = Math.sin(angle);

		// Offset from center using right and up vectors
		const offsetX = (rightX * cos + upX * sin) * radius;
		const offsetY = (rightY * cos + upY * sin) * radius;
		const offsetZ = (rightZ * cos + upZ * sin) * radius;

		startRing.push({
			x: startX + offsetX,
			y: startY + offsetY,
			z: startZ + offsetZ
		});

		endRing.push({
			x: endX + offsetX,
			y: endY + offsetY,
			z: endZ + offsetZ
		});
	}

	// Create tube wall - two triangles per quad segment
	// With clockwise ring, outside visibility needs: s1 -> s2 -> e2, then s1 -> e2 -> e1
	for (let i = 0; i < TUBE_SEGMENTS; i++) {
		const next = (i + 1) % TUBE_SEGMENTS;

		const s1 = startRing[i];
		const s2 = startRing[next];
		const e1 = endRing[i];
		const e2 = endRing[next];

		// First triangle: s1 -> s2 -> e2
		const t1 = idx;
		verts.push(s1.x, s1.y, s1.z, r, g, b);
		verts.push(s2.x, s2.y, s2.z, r, g, b);
		verts.push(e2.x, e2.y, e2.z, r, g, b);
		inds.push(t1, t1 + 1, t1 + 2);
		inds.push(t1, t1 + 2, t1 + 1);
		idx += 3;

		// Second triangle: s1 -> e2 -> e1
		const t2 = idx;
		verts.push(s1.x, s1.y, s1.z, r, g, b);
		verts.push(e2.x, e2.y, e2.z, r, g, b);
		verts.push(e1.x, e1.y, e1.z, r, g, b);
		inds.push(t2, t2 + 1, t2 + 2);
		inds.push(t2, t2 + 2, t2 + 1);
		idx += 3;
	}

	return { verts, inds };
}

/**
 * Generate tube mesh for the entire path
 */
async function generateFullPathMesh(
	fullPath: PathNode[]
): Promise<{ positions: Float32Array; indices: Uint16Array }> {
	const positions: number[] = [];
	const indices: number[] = [];

	if (fullPath.length < 2) {
		return { positions: new Float32Array(positions), indices: new Uint16Array(indices) };
	}

	// Prefetch height data for all unique chunks
	const chunkSet = new Set<string>();
	for (const node of fullPath) {
		const chunkX = Math.floor(node.lng / CHUNK_SIZE);
		const chunkZ = Math.floor(node.lat / CHUNK_SIZE);
		chunkSet.add(`${chunkX},${chunkZ},${node.floor}`);
	}

	await Promise.all(
		[...chunkSet].map(async (key) => {
			const [cx, cz, f] = key.split(",").map(Number);
			if (!state.heightCache.has(key)) {
				const heightData = await fetchHeightData(cx, cz, f);
				state.heightCache.set(key, heightData);
			}
		})
	);

	// Pre-calculate all world positions
	const worldPositions: { x: number; y: number; z: number }[] = [];
	for (const node of fullPath) {
		const world = tileToWorld(node.lat, node.lng);
		const height = await getHeightAtWorldTile(node.lat, node.lng, node.floor);
		worldPositions.push({ x: world.x, y: height, z: world.z });
	}

	const FLOATS_PER_VERTEX = 6;

	// Generate cylinder segments connecting consecutive path nodes
	for (let i = 0; i < fullPath.length - 1; i++) {
		const start = worldPositions[i];
		const end = worldPositions[i + 1];

		const baseVertex = positions.length / FLOATS_PER_VERTEX;
		const segment = generateCylinderSegment(
			start.x, start.y, start.z,
			end.x, end.y, end.z,
			TUBE_RADIUS,
			TUBE_COLOR,
			baseVertex
		);

		positions.push(...segment.verts);
		indices.push(...segment.inds);
	}

	return {
		positions: new Float32Array(positions),
		indices: new Uint16Array(indices),
	};
}

async function findAnyFloorVAO(forceRefresh: boolean = false): Promise<number | null> {
	if (!state.patchrs?.native) return null;

	// Use cached VAO unless force refresh is requested
	if (state.anchorVaoId !== null && !forceRefresh) {
		return state.anchorVaoId;
	}

	// Clear cached VAO when refreshing
	if (forceRefresh) {
		state.anchorVaoId = null;
	}

	try {
		const needsInputs = state.knownFloorProgramId === null;
		const features: ("vertexarray" | "uniforms")[] = needsInputs ? ["vertexarray", "uniforms"] : ["uniforms"];

		// IMPORTANT: Don't use skipProgramMask when looking for floor program for the first time
		// Otherwise if no floor renders were present during initialization, ALL programs get marked
		// as "wrong" and will be skipped forever, returning 0 renders
		let renders: any[] = [];
		try {
			renders = await state.patchrs.native.recordRenderCalls({
				maxframes: 1,
				features,
				...(state.knownFloorProgramId !== null ? { skipProgramMask: WRONG_PROG_MASK } : {}),
			});

			for (const render of renders) {
				if (!render.program) continue;

				if (state.knownFloorProgramId === null) {
					if (!render.program.inputs?.find((i: any) => i.name === "aMaterialSettingsSlotXY3")) {
						// Don't mark programs as wrong until we've found a floor program
						continue;
					}
					state.knownFloorProgramId = render.program.programId;
				} else {
					if (render.program.programId !== state.knownFloorProgramId) continue;
				}

				state.anchorVaoId = render.vertexObjectId;
				return state.anchorVaoId;
			}
		} finally {
			for (const r of renders) {
				try { r.dispose?.(); } catch (_) {}
			}
		}
	} catch (e) {
		console.error("[PathTube] Error finding floor VAO:", e);
	}

	return null;
}

async function createGlobalOverlay(
	mesh: { positions: Float32Array; indices: Uint16Array }
): Promise<GlOverlay | null> {
	if (!state.patchrs?.native) return null;

	const uniforms = new UniformSnapshotBuilder({
		uModelMatrix: "mat4",
		uViewProjMatrix: "mat4",
	});

	const program = state.patchrs.native.createProgram(
		vertshader,
		fragshader,
		[
			{ location: 0, name: "aPos", type: GL_FLOAT, length: 3 },
			{ location: 1, name: "aColor", type: GL_FLOAT, length: 3 },
		],
		uniforms.args
	);

	if (state.vertexArray) {
		try {
			state.vertexArray.destroy?.();
		} catch (e) {
			// Ignore cleanup errors
		}
		state.vertexArray = null;
	}

	const vertexBuffer = new Uint8Array(mesh.positions.buffer);
	const indexBuffer = new Uint8Array(mesh.indices.buffer);

	const vertex = state.patchrs.native.createVertexArray(indexBuffer, [
		{ location: 0, buffer: vertexBuffer, enabled: true, normalized: false, offset: 0, stride: 6 * 4, scalartype: GL_FLOAT, vectorlength: 3 },
		{ location: 1, buffer: vertexBuffer, enabled: true, normalized: false, offset: 3 * 4, stride: 6 * 4, scalartype: GL_FLOAT, vectorlength: 3 },
	]);

	state.vertexArray = vertex;

	const identityMatrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
	uniforms.mappings.uModelMatrix.write(identityMatrix);

	const uniformSources = [
		{ name: "uViewProjMatrix", sourceName: "uViewProjMatrix", type: "program" as const },
	];

	const renderRanges = [{ start: 0, length: mesh.indices.length }];

	try {
		if (state.anchorVaoId === null) {
			return null;
		}

		const overlay = state.patchrs.native.beginOverlay(
			{ vertexObjectId: state.anchorVaoId },
			program,
			vertex,
			{
				uniformSources,
				uniformBuffer: uniforms.buffer,
				ranges: renderRanges,
				alphaBlend: false,
				trigger: "after",
			}
		);

		return overlay;
	} catch (e) {
		console.error("[PathTube] Overlay creation error:", e);
		return null;
	}
}

async function init(): Promise<boolean> {
	if (state.patchrs) return true;

	try {
		state.patchrs = await import("@injection/util/patchrs_napi");
		if (!state.patchrs.native) {
			return false;
		}
		return true;
	} catch (e) {
		console.error("[PathTube] Init error:", e);
		return false;
	}
}

/**
 * Draw path as connected tubes
 */
export async function drawPathTubes(
	path: Array<{ lat: number; lng: number; floor: number }>,
	options?: {
		forceRedraw?: boolean;
	}
): Promise<boolean> {
	const forceRedraw = options?.forceRedraw ?? false;

	if (state.isDrawing) {
		return false;
	}

	if (path.length < 2) {
		return false;
	}

	const now = Date.now();
	const timeSinceLastDraw = now - state.lastRedrawTime;

	if (!forceRedraw && timeSinceLastDraw < REDRAW_THROTTLE_MS) {
		return state.isActive;
	}

	const pathHash = getPathHash(path);
	if (!forceRedraw && pathHash === state.lastPathHash && state.isActive) {
		return true;
	}

	// Check if path area changed significantly (different terrain chunks likely)
	// This means VAO anchor may be stale
	if (state.fullPath.length > 0 && path.length > 0) {
		const prevStart = state.fullPath[0];
		const newStart = path[0];
		const areaChange = Math.abs(prevStart.lat - newStart.lat) > 32 ||
		                   Math.abs(prevStart.lng - newStart.lng) > 32 ||
		                   prevStart.floor !== newStart.floor;
		if (areaChange) {
			state.anchorVaoId = null;
			state.heightCache.clear();
		}
	}

	const initialized = await init();
	if (!initialized || !state.patchrs) {
		return false;
	}

	state.isDrawing = true;
	state.generation++;
	state.lastRedrawTime = now;
	const thisGeneration = state.generation;

	try {
		if (state.overlay) {
			try {
				state.overlay.stop();
			} catch (e) {
				// Ignore
			}
			state.overlay = null;
		}
		state.isActive = false;
		// NOTE: Don't set lastPathHash here - only set it after successful overlay creation!

		if (state.generation !== thisGeneration) {
			return false;
		}

		// Try to find VAO, refresh if we don't have one cached
		await findAnyFloorVAO(state.anchorVaoId === null);
		if (state.anchorVaoId === null) {
			// No anchor VAO yet - allow retry on next call
			return false;
		}

		const pathNodes: PathNode[] = path.map((node) => ({
			lat: node.lat,
			lng: node.lng,
			floor: node.floor,
		}));

		state.fullPath = pathNodes;

		const mesh = await generateFullPathMesh(pathNodes);
		if (mesh.indices.length === 0) {
			return false;
		}

		state.overlay = await createGlobalOverlay(mesh);

		// If overlay creation failed, try refreshing the VAO anchor and retry once
		if (!state.overlay) {
			await findAnyFloorVAO(true); // Force refresh
			if (state.anchorVaoId !== null) {
				state.overlay = await createGlobalOverlay(mesh);
			}
		}

		state.isActive = state.overlay !== null;

		// Only set path hash after successful overlay creation
		// This allows retry if overlay creation fails
		if (state.isActive) {
			state.lastPathHash = pathHash;
		}

		return state.isActive;
	} finally {
		state.isDrawing = false;
	}
}

/**
 * Clear all path tube overlays
 */
export async function clearPathTubes(): Promise<void> {
	if (state.overlay) {
		try {
			state.overlay.stop();
		} catch (e) {
			console.warn("[PathTube] Error stopping overlay:", e);
		}
		state.overlay = null;
	}

	if (state.vertexArray) {
		try {
			state.vertexArray.destroy?.();
		} catch (e) {
			// Ignore cleanup errors
		}
		state.vertexArray = null;
	}

	state.fullPath = [];
	state.isActive = false;
	state.lastPathHash = "";

	if (state.heightCache.size > 20) {
		state.heightCache.clear();
	}
}

/**
 * Check if tubes are active
 */
export function isPathTubesActive(): boolean {
	return state.isActive;
}

/**
 * Invalidate the cached anchor VAO
 */
export function invalidateTubeAnchorVao(): void {
	state.anchorVaoId = null;
}
