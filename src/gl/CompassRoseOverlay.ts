/**
 * CompassRoseOverlay - 3D compass rose markers for NPC/location highlighting
 *
 * Uses the patchrs GL overlay system to draw compass rose markers that
 * hover above NPCs and other important locations.
 */

import type { GlOverlay } from "@injection/util/patchrs_napi";
import {
	fetchHeightData,
	getHeightAtTile,
	latLngToLocalTile,
} from "@injection/overlays/heightData";
import { GL_FLOAT, UniformSnapshotBuilder, positionMatrix } from "@injection/overlays/index";
import { getProgramMeta } from "@injection/render/renderprogram";
import { compassRoseVertShader, compassRoseFragShader } from "./shaders";

// Constants
const TILE_SIZE = 512;
const CHUNK_SIZE = 64;
const ORB_RADIUS = 0.18;
const ORB_HEIGHT_OFFSET = 400;

// Floor Y constants for fallback height calculation
const FLOOR_Y_BASE = 1152;
const FLOOR_Y_STEP = 1296;

// Skipmask for non-floor programs
const WRONG_PROG_MASK = 0x1000;

interface CompassRoseState {
	patchrs: typeof import("@injection/util/patchrs_napi") | null;
	knownFloorProgramId: number | null;
	anchorVaoId: number | null;
	heightCache: Map<string, Uint16Array | null>;
	activeMarkers: Map<string, {
		captureOverlay?: GlOverlay;
		renderOverlay: GlOverlay;
		vertexArray: any;
		captureProgram?: any;
	}>;
}

const state: CompassRoseState = {
	patchrs: null,
	knownFloorProgramId: null,
	anchorVaoId: null,
	heightCache: new Map(),
	activeMarkers: new Map(),
};

/**
 * Generate a 3D compass rose mesh
 */
function generateCompassRose(
	centerX: number, centerY: number, centerZ: number,
	radius: number,
	baseVertexIndex: number
): { verts: number[]; inds: number[] } {
	const verts: number[] = [];
	const inds: number[] = [];

	const longLength = radius * 2.2;
	const shortLength = radius * 1.4;

	let idx = baseVertexIndex;

	// Darker metallic blue colors
	const lightTip: [number, number, number] = [0.08, 0.35, 0.65];
	const lightEdge: [number, number, number] = [0.03, 0.25, 0.50];
	const darkTip: [number, number, number] = [0.0, 0.15, 0.40];
	const darkEdge: [number, number, number] = [0.0, 0.08, 0.25];
	const centerCol: [number, number, number] = [0.05, 0.15, 0.35];
	const edgeCol: [number, number, number] = [0.0, 0.03, 0.10];

	// Track blade index for Z-offset to prevent z-fighting
	let bladeIndex = 0;

	const addBlade = (angle: number, length: number, isCardinal: boolean, glow: number) => {
		const dx = Math.cos(angle);
		const dy = Math.sin(angle);
		const px = -dy;
		const py = dx;

		const tipX = centerX + dx * length;
		const tipY = centerY + dy * length;

		const widthDist = isCardinal ? radius * 0.35 : radius * 0.22;
		const widthPos = length * 0.3;

		const leftX = centerX + dx * widthPos + px * widthDist;
		const leftY = centerY + dy * widthPos + py * widthDist;
		const rightX = centerX + dx * widthPos - px * widthDist;
		const rightY = centerY + dy * widthPos - py * widthDist;

		// Offset each blade slightly in Z to prevent z-fighting at center
		// Each blade gets a unique Z offset so no two blades share exact same depth
		const zOffset = bladeIndex * 0.5;
		bladeIndex++;

		const thickness = 15;
		const frontZ = centerZ + thickness + zOffset;
		const backZ = centerZ - thickness + zOffset;

		// Calculate face normal from 3 points
		const calcNormal = (
			x1: number, y1: number, z1: number,
			x2: number, y2: number, z2: number,
			x3: number, y3: number, z3: number
		): [number, number, number] => {
			const ux = x2 - x1, uy = y2 - y1, uz = z2 - z1;
			const vx = x3 - x1, vy = y3 - y1, vz = z3 - z1;
			const nx = uy * vz - uz * vy;
			const ny = uz * vx - ux * vz;
			const nz = ux * vy - uy * vx;
			const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
			return [nx / len, ny / len, nz / len];
		};

		// Add a triangle with proper normal (single-sided to avoid z-fighting)
		const addTri = (
			x1: number, y1: number, z1: number, r1: number, g1: number, b1: number,
			x2: number, y2: number, z2: number, r2: number, g2: number, b2: number,
			x3: number, y3: number, z3: number, r3: number, g3: number, b3: number
		) => {
			const [nx, ny, nz] = calcNormal(x1, y1, z1, x2, y2, z2, x3, y3, z3);
			const i = idx;
			// Vertex format: x, y, z, r, g, b, glow, nx, ny, nz (10 floats)
			verts.push(x1, y1, z1, r1, g1, b1, glow, nx, ny, nz);
			verts.push(x2, y2, z2, r2, g2, b2, glow, nx, ny, nz);
			verts.push(x3, y3, z3, r3, g3, b3, glow, nx, ny, nz);
			inds.push(i, i + 1, i + 2);
			idx += 3;
		};

		// Add a quad with proper normal (single-sided to avoid z-fighting)
		const addQuad = (
			x1: number, y1: number, z1: number, r1: number, g1: number, b1: number,
			x2: number, y2: number, z2: number, r2: number, g2: number, b2: number,
			x3: number, y3: number, z3: number, r3: number, g3: number, b3: number,
			x4: number, y4: number, z4: number, r4: number, g4: number, b4: number
		) => {
			const [nx, ny, nz] = calcNormal(x1, y1, z1, x2, y2, z2, x3, y3, z3);
			const i = idx;
			// Vertex format: x, y, z, r, g, b, glow, nx, ny, nz (10 floats)
			verts.push(x1, y1, z1, r1, g1, b1, glow, nx, ny, nz);
			verts.push(x2, y2, z2, r2, g2, b2, glow, nx, ny, nz);
			verts.push(x3, y3, z3, r3, g3, b3, glow, nx, ny, nz);
			verts.push(x4, y4, z4, r4, g4, b4, glow, nx, ny, nz);
			inds.push(i, i + 1, i + 2);
			inds.push(i, i + 2, i + 3);
			idx += 4;
		};

		// FRONT FACE - LEFT triangle (LIGHT side)
		addTri(
			tipX, tipY, frontZ, lightTip[0], lightTip[1], lightTip[2],
			leftX, leftY, frontZ, lightEdge[0], lightEdge[1], lightEdge[2],
			centerX, centerY, frontZ, centerCol[0], centerCol[1], centerCol[2]
		);

		// FRONT FACE - RIGHT triangle (DARK side)
		addTri(
			tipX, tipY, frontZ, darkTip[0], darkTip[1], darkTip[2],
			centerX, centerY, frontZ, centerCol[0], centerCol[1], centerCol[2],
			rightX, rightY, frontZ, darkEdge[0], darkEdge[1], darkEdge[2]
		);

		// BACK FACE - LEFT triangle (LIGHT side)
		addTri(
			tipX, tipY, backZ, lightTip[0], lightTip[1], lightTip[2],
			centerX, centerY, backZ, centerCol[0], centerCol[1], centerCol[2],
			leftX, leftY, backZ, lightEdge[0], lightEdge[1], lightEdge[2]
		);

		// BACK FACE - RIGHT triangle (DARK side)
		addTri(
			tipX, tipY, backZ, darkTip[0], darkTip[1], darkTip[2],
			rightX, rightY, backZ, darkEdge[0], darkEdge[1], darkEdge[2],
			centerX, centerY, backZ, centerCol[0], centerCol[1], centerCol[2]
		);

		// EDGE FACES
		const e = edgeCol;

		addQuad(
			tipX, tipY, frontZ, e[0], e[1], e[2],
			tipX, tipY, backZ, e[0], e[1], e[2],
			leftX, leftY, backZ, e[0], e[1], e[2],
			leftX, leftY, frontZ, e[0], e[1], e[2]
		);

		addQuad(
			tipX, tipY, frontZ, e[0], e[1], e[2],
			rightX, rightY, frontZ, e[0], e[1], e[2],
			rightX, rightY, backZ, e[0], e[1], e[2],
			tipX, tipY, backZ, e[0], e[1], e[2]
		);

		addQuad(
			leftX, leftY, frontZ, e[0], e[1], e[2],
			leftX, leftY, backZ, e[0], e[1], e[2],
			centerX, centerY, backZ, e[0], e[1], e[2],
			centerX, centerY, frontZ, e[0], e[1], e[2]
		);

		addQuad(
			centerX, centerY, frontZ, e[0], e[1], e[2],
			centerX, centerY, backZ, e[0], e[1], e[2],
			rightX, rightY, backZ, e[0], e[1], e[2],
			rightX, rightY, frontZ, e[0], e[1], e[2]
		);
	};

	// 4 cardinal blades (south blade at -PI/2 glows)
	addBlade(Math.PI / 2, longLength, true, 0);        // North
	addBlade(0, longLength, true, 0);                   // East
	addBlade(-Math.PI / 2, longLength, true, 1.0);      // South (GLOWING)
	addBlade(Math.PI, longLength, true, 0);             // West

	// 4 ordinal blades (SW and SE adjacent to south also glow slightly)
	addBlade(Math.PI / 4, shortLength, false, 0);       // NE
	addBlade(-Math.PI / 4, shortLength, false, 0.5);    // SE (partial glow)
	addBlade(-3 * Math.PI / 4, shortLength, false, 0.5);// SW (partial glow)
	addBlade(3 * Math.PI / 4, shortLength, false, 0);   // NW

	return { verts, inds };
}

/**
 * Initialize the overlay system
 */
async function init(): Promise<boolean> {
	
	if (state.patchrs) return true;

	try {
		state.patchrs = await import("@injection/util/patchrs_napi");
		if (!state.patchrs.native) {
			console.warn("[CompassRose] Native addon not available");
			return false;
		}
		console.log("[CompassRose] Initialized");
		return true;
	} catch (e) {
		console.error("[CompassRose] Failed to init:", e);
		return false;
	}
}

/**
 * Extract chunk coordinates and Y position from a floor render's uModelMatrix
 * (Same pattern as TileOverlayManager)
 */
function getChunkFromRender(render: any): { chunkX: number; chunkZ: number; modelY: number } | null {
	const modelMatrixUniform = render.program?.uniforms?.find((u: any) => u.name === "uModelMatrix");
	if (!modelMatrixUniform || !render.uniformState) return null;

	const offset = modelMatrixUniform.snapshotOffset;
	const view = new DataView(render.uniformState.buffer, render.uniformState.byteOffset + offset);
	const chunkX = Math.floor(view.getFloat32(12 * 4, true) / CHUNK_SIZE / TILE_SIZE);
	const modelY = view.getFloat32(13 * 4, true);
	const chunkZ = Math.floor(view.getFloat32(14 * 4, true) / CHUNK_SIZE / TILE_SIZE);
	return { chunkX, chunkZ, modelY };
}

/**
 * Find floor render for a SPECIFIC chunk location
 * This is critical - we must attach to the correct floor chunk VAO for the overlay to be visible
 *
 * @param targetLat - Target latitude in tiles
 * @param targetLng - Target longitude in tiles
 * @param targetFloor - Floor level (0 = ground)
 */
async function findFloorForLocation(
	targetLat: number,
	targetLng: number,
	targetFloor: number
): Promise<{ vaoId: number; modelY: number; chunkX: number; chunkZ: number; framebufferId: number } | null> {
	if (!state.patchrs?.native) {
		console.log("[CompassRose] findFloorForLocation: no native module");
		return null;
	}

	// Calculate target chunk from lat/lng
	const targetChunkX = Math.floor(targetLng / CHUNK_SIZE);
	const targetChunkZ = Math.floor(targetLat / CHUNK_SIZE);
	console.log(`[CompassRose] Looking for floor chunk (${targetChunkX}, ${targetChunkZ}) for target at (${targetLat.toFixed(1)}, ${targetLng.toFixed(1)})`);

	let renders: any[] = [];
	try {
		renders = await state.patchrs.native.recordRenderCalls({
			maxframes: 1,
			features: ["uniforms"],
			...(state.knownFloorProgramId !== null ? { skipProgramMask: WRONG_PROG_MASK } : {}),
		});

		console.log(`[CompassRose] findFloorForLocation: got ${renders.length} renders`);

		// Collect floor renders for the TARGET chunk
		const chunkRenders: Array<{ render: any; chunkX: number; chunkZ: number; modelY: number }> = [];
		let markedWrong = 0;

		for (const render of renders) {
			if (!render.program) continue;

			// Use getProgramMeta to check for shadow pass (like NpcOverlay does)
			const progmeta = getProgramMeta(render.program);

			// Skip shadow pass renders - we want main scene only
			if (progmeta.isShadowRender) {
				continue;
			}

			// Check if this is a floor program
			if (render.program.inputs?.find((i: any) => i.name === "aMaterialSettingsSlotXY3")) {
				// Mark floor program for future skipping optimization
				if (state.knownFloorProgramId === null) {
					state.knownFloorProgramId = render.program.programId;
					console.log(`[CompassRose] Found floor program: ${state.knownFloorProgramId}`);
					// DEBUG: Log uniforms to see what's available
					const uniformNames = render.program.uniforms?.map((u: any) => u.name) || [];
					console.log(`[CompassRose] Floor program uniforms: ${uniformNames.join(", ")}`);
				}

				// Get chunk info from this render's model matrix
				const chunkInfo = getChunkFromRender(render);
				if (chunkInfo && chunkInfo.chunkX === targetChunkX && chunkInfo.chunkZ === targetChunkZ) {
					console.log(`[CompassRose] Found main scene floor render: VAO=${render.vertexObjectId}, fb=${render.framebufferId}`);
					chunkRenders.push({ render, ...chunkInfo });
				}
			} else {
				// Mark non-floor programs to be skipped
				render.program.skipmask |= WRONG_PROG_MASK;
				markedWrong++;
			}
		}

		console.log(`[CompassRose] Found ${chunkRenders.length} renders for target chunk (${targetChunkX}, ${targetChunkZ}), marked ${markedWrong} non-floor`);

		if (chunkRenders.length === 0) {
			console.log(`[CompassRose] Target chunk not currently visible`);
			return null;
		}

		// Sort by Y ascending (lowest = floor 0)
		chunkRenders.sort((a, b) => a.modelY - b.modelY);

		console.log(`[CompassRose] Chunk (${targetChunkX}, ${targetChunkZ}) floor Y values: [${chunkRenders.map(f => f.modelY.toFixed(0)).join(", ")}]`);

		// Pick the floor matching targetFloor (clamped to available floors)
		const floorIndex = Math.min(targetFloor, chunkRenders.length - 1);
		const selected = chunkRenders[floorIndex];

		console.log(`[CompassRose] Selected floor ${floorIndex} with VAO: ${selected.render.vertexObjectId}, modelY: ${selected.modelY.toFixed(0)}`);

		state.anchorVaoId = selected.render.vertexObjectId;
		return {
			vaoId: selected.render.vertexObjectId,
			modelY: selected.modelY,
			chunkX: targetChunkX,
			chunkZ: targetChunkZ,
			framebufferId: selected.render.framebufferId ?? 0,
		};
	} catch (e) {
		console.error("[CompassRose] Error finding floor for location:", e);
	} finally {
		for (const r of renders) {
			try { r.dispose?.(); } catch (_) {}
		}
	}

	return null;
}

/**
 * Find floor VAO AND framebuffer for proper filtering (avoids shadow pass)
 * Returns the LAST floor render's IDs - main scene pass typically comes after shadow pass
 * @deprecated Use findFloorForLocation for location-specific floor finding
 */
async function findFloorVaoAndFramebuffer(): Promise<{ vaoId: number; framebufferId: number } | null> {
	if (!state.patchrs?.native) {
		console.log("[CompassRose] findFloorVaoAndFramebuffer: no native module");
		return null;
	}

	let renders: any[] = [];
	try {
		const needsInputs = state.knownFloorProgramId === null;
		const features: ("vertexarray" | "uniforms")[] = needsInputs ? ["vertexarray", "uniforms"] : ["uniforms"];

		// IMPORTANT: Don't use skipProgramMask when looking for floor program for the first time
		// Otherwise if no floor renders were present during initialization, ALL programs get marked
		// as "wrong" and will be skipped forever, returning 0 renders
		renders = await state.patchrs.native.recordRenderCalls({
			maxframes: 1,
			features,
			...(state.knownFloorProgramId !== null ? { skipProgramMask: WRONG_PROG_MASK } : {}),
		});

		console.log(`[CompassRose] findFloorVaoAndFramebuffer: got ${renders.length} renders, knownFloorProgramId=${state.knownFloorProgramId}`);

		// Match TileOverlayManager pattern exactly - mark non-floor programs with skipmask
		// Shadow pass programs are different programs and get marked automatically
		const floorRenders: { vaoId: number; framebufferId: number }[] = [];
		let markedWrong = 0;

		for (const render of renders) {
			if (!render.program) continue;

			// Check if this is a floor program by looking for floor-specific input
			if (render.program.inputs?.find((i: any) => i.name === "aMaterialSettingsSlotXY3")) {
				// This is a floor render
				if (state.knownFloorProgramId === null) {
					state.knownFloorProgramId = render.program.programId;
					console.log(`[CompassRose] Found floor program: ${state.knownFloorProgramId}`);
				}

				floorRenders.push({
					vaoId: render.vertexObjectId,
					framebufferId: render.framebufferId ?? 0,
				});
			} else {
				// Mark non-floor programs to be skipped (like TileOverlayManager)
				render.program.skipmask |= WRONG_PROG_MASK;
				markedWrong++;
			}
		}

		console.log(`[CompassRose] Found ${floorRenders.length} floor renders, marked ${markedWrong} non-floor programs`);

		// Return the LAST floor render (main scene pass, after shadow pass)
		if (floorRenders.length > 0) {
			const lastRender = floorRenders[floorRenders.length - 1];
			state.anchorVaoId = lastRender.vaoId;
			console.log(`[CompassRose] Using last floor render - VAO: ${lastRender.vaoId}, fb: ${lastRender.framebufferId}`);
			return lastRender;
		}

		console.log(`[CompassRose] No floor VAO found`);
	} catch (e) {
		console.error("[CompassRose] Error finding floor VAO and framebuffer:", e);
	} finally {
		for (const r of renders) {
			try { r.dispose?.(); } catch (_) {}
		}
	}

	return null;
}

/**
 * Get height at a world tile position
 */
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
		return getHeightAtTile(heightData, tileX, tileZ, 0.5, 0.5) + ORB_HEIGHT_OFFSET;
	}

	return FLOOR_Y_BASE + floor * FLOOR_Y_STEP + ORB_HEIGHT_OFFSET;
}

/**
 * Draw a compass rose marker attached to an NPC by VAO ID and framebuffer
 * This makes the compass rose follow the NPC as it moves
 *
 * @param npcVaoId - The NPC's Vertex Array Object ID
 * @param heightOffset - Height above the NPC's origin (in world units, ~350-500 typical)
 * @param markerId - Unique ID for this marker
 * @param framebufferId - Optional framebuffer ID to filter (avoids shadow pass rendering)
 */
export async function drawNpcCompassRoseAttached(
	npcVaoId: number,
	heightOffset: number = 1000,
	markerId?: string,
	framebufferId?: number
): Promise<GlOverlay | null> {
	console.log(`[CompassRose] drawNpcCompassRoseAttached called for VAO ${npcVaoId}, height offset ${heightOffset}, fb ${framebufferId}`);

	const initialized = await init();
	if (!initialized || !state.patchrs?.native) {
		console.log("[CompassRose] Not initialized or no native module");
		return null;
	}

	const id = markerId ?? "default";

	// Clear previous marker with same ID
	await clearNpcCompassRose(id);

	const radius = ORB_RADIUS * TILE_SIZE * 0.6;

	// Generate compass rose at local origin with height offset
	// The NPC's model matrix will position it in world space
	const compass = generateCompassRose(
		0,              // Local X (centered on NPC)
		heightOffset,   // Height above NPC origin
		0,              // Local Z (centered on NPC)
		radius,
		0
	);

	if (compass.verts.length === 0) return null;

	// Rotation speed: ~0.5 radians per second for a gentle spin
	const ROTATION_SPEED = 0.5;

	const uniforms = new UniformSnapshotBuilder({
		uModelMatrix: "mat4",
		uViewProjMatrix: "mat4",
		uTime: "float",
		uRotationCenter: "vec3",
		uRotationSpeed: "float",
	});

	// Set rotation center (where the compass rotates around)
	uniforms.mappings.uRotationCenter.write([0, heightOffset, 0]);
	// Set rotation speed
	uniforms.mappings.uRotationSpeed.write([ROTATION_SPEED]);

	const program = state.patchrs.native.createProgram(
		compassRoseVertShader,
		compassRoseFragShader,
		[
			{ location: 0, name: "aPos", type: GL_FLOAT, length: 3 },
			{ location: 1, name: "aColor", type: GL_FLOAT, length: 4 },  // r,g,b,glow
			{ location: 2, name: "aNormal", type: GL_FLOAT, length: 3 },
		],
		uniforms.args
	);

	const positions = new Float32Array(compass.verts);
	const indices = new Uint16Array(compass.inds);
	const vertexBuffer = new Uint8Array(positions.buffer);
	const indexBuffer = new Uint8Array(indices.buffer);

	// Vertex stride: 10 floats (x,y,z, r,g,b,glow, nx,ny,nz) = 40 bytes
	const vertex = state.patchrs.native.createVertexArray(indexBuffer, [
		{ location: 0, buffer: vertexBuffer, enabled: true, normalized: false, offset: 0, stride: 10 * 4, scalartype: GL_FLOAT, vectorlength: 3 },
		{ location: 1, buffer: vertexBuffer, enabled: true, normalized: false, offset: 3 * 4, stride: 10 * 4, scalartype: GL_FLOAT, vectorlength: 4 },
		{ location: 2, buffer: vertexBuffer, enabled: true, normalized: false, offset: 7 * 4, stride: 10 * 4, scalartype: GL_FLOAT, vectorlength: 3 },
	]);

	// Link matrices from the NPC's shader - uModelMatrix positions the compass at NPC location
	// uRotationCenter and uRotationSpeed are set in uniformBuffer (not sourced from NPC shader)
	const uniformSources = [
		{ name: "uViewProjMatrix", sourceName: "uViewProjMatrix", type: "program" as const },
		{ name: "uModelMatrix", sourceName: "uModelMatrix", type: "program" as const },
		{ name: "uTime", sourceName: "timestamp", type: "builtin" as const },
	];

	try {
		// Build filter - attach to NPC's VAO and optionally filter by framebuffer
		// Using framebufferId prevents the overlay from rendering during shadow pass
		const filter: { vertexObjectId: number; framebufferId?: number } = { vertexObjectId: npcVaoId };
		if (framebufferId !== undefined) {
			filter.framebufferId = framebufferId;
		}

		// Attach to the NPC's VAO so compass follows NPC movement
		const overlay = state.patchrs.native.beginOverlay(
			filter,
			program,
			vertex,
			{
				uniformSources: uniformSources,
				uniformBuffer: new Uint8Array(uniforms.buffer.buffer),
				ranges: [{ start: 0, length: indices.length }],
			}
		);

		state.activeMarkers.set(id, { renderOverlay: overlay, vertexArray: vertex });
		console.log(`[CompassRose] Created attached marker "${id}" on NPC VAO ${npcVaoId}, fb ${framebufferId}`);
		return overlay;
	} catch (e) {
		console.error("[CompassRose] Failed to create attached overlay:", e);
		return null;
	}
}

/**
 * Draw a compass rose marker at a tile location (lat/lng)
 * This is a fallback method for static positioning
 */
export async function drawNpcCompassRoseAtLocation(
	lat: number,
	lng: number,
	floor: number,
	markerId?: string
): Promise<GlOverlay | null> {
	console.log(`[CompassRose] drawNpcCompassRoseAtLocation called at (${lat}, ${lng}) floor ${floor}, markerId: ${markerId}`);

	// Convert tile coordinates to world coordinates
	// World coordinates: X = lng * TILE_SIZE, Z = lat * TILE_SIZE
	const worldX = lng * TILE_SIZE;
	const worldZ = lat * TILE_SIZE;

	// Get terrain height at this location
	const worldY = await getHeightAtWorldTile(lat, lng, floor);
	console.log(`[CompassRose] Converted to world coords: (${worldX.toFixed(0)}, ${worldY.toFixed(0)}, ${worldZ.toFixed(0)})`);

	return drawNpcCompassRose(worldX, worldY, worldZ, markerId);
}

// Height offset for floor-attached compass overlays
// Needs to be high enough to be above terrain (terrain heights can be 500-1000+)
const FLOOR_COMPASS_HEIGHT_OFFSET = 2000;

/**
 * Draw a compass rose marker attached to floor with proper world positioning
 * Use this as fallback when NPC is not in view
 *
 * Key insight: NPC-attached works because it SOURCES uModelMatrix from the program.
 * For floor attachment to work with colors, we must do the same - source uModelMatrix
 * from the floor program, generate geometry at origin, and use uWorldOffset to
 * translate to the target world position.
 *
 * @param lat - Tile latitude (center of wander radius if available)
 * @param lng - Tile longitude (center of wander radius if available)
 * @param floor - Floor level
 * @param markerId - Unique ID for this marker
 */
export async function drawNpcCompassRoseOnFloor(
	lat: number,
	lng: number,
	floor: number,
	markerId?: string
): Promise<GlOverlay | null> {
	console.log(`[CompassRose] drawNpcCompassRoseOnFloor called at (${lat}, ${lng}) floor ${floor}, markerId: ${markerId}`);

	const initialized = await init();
	if (!initialized || !state.patchrs?.native) {
		console.log("[CompassRose] Not initialized or no native module");
		return null;
	}

	const id = markerId ?? "default";

	// Clear previous marker with same ID
	await clearNpcCompassRose(id);

	// Find floor VAO for the SPECIFIC chunk where our target is located
	// This is critical - we must attach to the correct floor chunk VAO
	const floorInfo = await findFloorForLocation(lat, lng, floor);
	if (!floorInfo) {
		console.log("[CompassRose] Target chunk not visible, cannot create floor-attached compass");
		return null;
	}

	// Calculate target world position - same as wander overlay pattern
	const targetWorldX = lng * TILE_SIZE;
	const targetWorldZ = lat * TILE_SIZE;
	// Use TILE_SIZE / 32 for Y base (like wander overlay) plus height offset
	const baseY = TILE_SIZE / 32;

	const radius = ORB_RADIUS * TILE_SIZE * 0.6;
	const heightOffset = FLOOR_COMPASS_HEIGHT_OFFSET;

	// Generate compass rose at origin with height offset
	// The uModelMatrix will position it at world coordinates
	const compass = generateCompassRose(
		0,              // Local X (centered at origin)
		heightOffset,   // Local Y (height above ground)
		0,              // Local Z (centered at origin)
		radius,
		0
	);

	if (compass.verts.length === 0) return null;

	// No rotation for floor-attached compass (static marker)
	const ROTATION_SPEED = 0;

	const uniforms = new UniformSnapshotBuilder({
		uModelMatrix: "mat4",
		uViewProjMatrix: "mat4",
		uTime: "float",
		uRotationCenter: "vec3",
		uRotationSpeed: "float",
	});

	// CRITICAL: Write our own uModelMatrix (like wander overlay does)
	// This positions the compass at the exact world coordinates
	uniforms.mappings.uModelMatrix.write(positionMatrix(targetWorldX, baseY, targetWorldZ));
	// Set rotation center (at origin, since geometry is at origin)
	uniforms.mappings.uRotationCenter.write([0, heightOffset, 0]);
	// Set rotation speed
	uniforms.mappings.uRotationSpeed.write([ROTATION_SPEED]);

	const program = state.patchrs.native.createProgram(
		compassRoseVertShader,
		compassRoseFragShader,
		[
			{ location: 0, name: "aPos", type: GL_FLOAT, length: 3 },
			{ location: 1, name: "aColor", type: GL_FLOAT, length: 4 },  // r,g,b,glow
			{ location: 2, name: "aNormal", type: GL_FLOAT, length: 3 },
		],
		uniforms.args
	);

	const positions = new Float32Array(compass.verts);
	const indices = new Uint16Array(compass.inds);
	const vertexBuffer = new Uint8Array(positions.buffer);
	const indexBuffer = new Uint8Array(indices.buffer);

	// Vertex stride: 10 floats (x,y,z, r,g,b,glow, nx,ny,nz) = 40 bytes
	const vertex = state.patchrs.native.createVertexArray(indexBuffer, [
		{ location: 0, buffer: vertexBuffer, enabled: true, normalized: false, offset: 0, stride: 10 * 4, scalartype: GL_FLOAT, vectorlength: 3 },
		{ location: 1, buffer: vertexBuffer, enabled: true, normalized: false, offset: 3 * 4, stride: 10 * 4, scalartype: GL_FLOAT, vectorlength: 4 },
		{ location: 2, buffer: vertexBuffer, enabled: true, normalized: false, offset: 7 * 4, stride: 10 * 4, scalartype: GL_FLOAT, vectorlength: 3 },
	]);

	const uniformSources = [
		
		{ name: "uViewProjMatrix", sourceName: "uViewProjMatrix", type: "program" as const },
		{ name: "uTime", sourceName: "timestamp", type: "builtin" as const },
	];

	try {
		// Use same pattern as wander overlay: just vertexObjectId (no framebufferId filter)
		// The VAO is rendered to multiple framebuffers, we want to attach to all of them
		const overlay = state.patchrs.native.beginOverlay(
			{ vertexObjectId: floorInfo.vaoId },
			program,
			vertex,
			{
				uniformSources: uniformSources,
				uniformBuffer: new Uint8Array(uniforms.buffer.buffer),
				ranges: [{ start: 0, length: indices.length }],
				alphaBlend: true,
			}
		);

		state.activeMarkers.set(id, { renderOverlay: overlay, vertexArray: vertex });
		console.log(`[CompassRose] Created floor-attached marker "${id}" at world (${targetWorldX.toFixed(0)}, ${baseY.toFixed(0)}, ${targetWorldZ.toFixed(0)}), vaoId=${floorInfo.vaoId}, fb=${floorInfo.framebufferId}`);
		return overlay;
	} catch (e) {
		console.error("[CompassRose] Failed to create floor-attached overlay:", e);
		return null;
	}
}

/**
 * Draw a compass rose marker at a specific world position
 * Delegates to drawNpcCompassRoseOnFloor after converting world coords to lat/lng
 */
export async function drawNpcCompassRose(
	worldX: number,
	_worldY: number,  // Unused - height calculated from terrain
	worldZ: number,
	markerId?: string,
	floor: number = 0
): Promise<GlOverlay | null> {
	// Convert world coordinates to lat/lng and delegate
	const lat = worldZ / TILE_SIZE;
	const lng = worldX / TILE_SIZE;
	return drawNpcCompassRoseOnFloor(lat, lng, floor, markerId);
}

/**
 * Clear a specific compass rose marker by ID
 */
export async function clearNpcCompassRose(markerId?: string): Promise<void> {
	const id = markerId ?? "default";
	const marker = state.activeMarkers.get(id);

	if (marker) {
		try {
			marker.captureOverlay?.stop();
		} catch (e) {
			// Ignore
		}

		try {
			marker.renderOverlay.stop();
		} catch (e) {
			// Ignore
		}

		try {
			marker.vertexArray.destroy?.();
		} catch (e) {
			// Ignore
		}

		state.activeMarkers.delete(id);
	}
}

/**
 * Clear all compass rose markers
 */
export async function clearAllCompassRoses(): Promise<void> {
	for (const [id] of state.activeMarkers) {
		await clearNpcCompassRose(id);
	}
}

/**
 * Check if any compass rose markers are active
 */
export function isCompassRoseActive(): boolean {
	return state.activeMarkers.size > 0;
}

/**
 * Get count of active compass rose markers
 */
export function getCompassRoseCount(): number {
	return state.activeMarkers.size;
}

/**
 * Invalidate the cached anchor VAO
 */
export function invalidateCompassAnchorVao(): void {
	state.anchorVaoId = null;
}
