/**
 * NPC Overlay - Detect and highlight NPCs in the 3D world
 */

import * as patchrs from "../util/patchrs_napi";
import { captureWithStreamPause } from "../util/SharedRenderStream";
import {
  getProgramMeta,
  getUniformValue,
  ProgramMeta,
} from "../render/renderprogram";
// tilesize constant (from reflect3d)
const tilesize = 512;
import { Matrix4, Vector3 } from "three";
import { RGBA } from "../util/spriteOverlay";
import { extractBufferHashes } from "./npcBufferHash";

// OpenGL constants
const GL_FLOAT = 0x1406;
const GL_UNSIGNED_BYTE = 0x1401;
const RENDER_MODE_TRIANGLES: patchrs.RenderMode = "triangles";
const GL_FLOAT_MAT4 = 0x8b5c;
const GL_FLOAT_VEC3 = 0x8b51;

// Known player buffer hash - used to identify the player's position on the map
// This hash is the combined hash of the player's mesh group
// Update this value by running a scan and finding your own character
export const PLAYER_BUFFER_HASH = "0xF14E10A3"; // TODO: Replace with actual player hash

// Simple passthrough fragment shader
const fragShader = `
  #version 330 core
  in vec4 vColor;
  out vec4 FragColor;
  void main() {
    FragColor = vColor;
  }
`;

// Fragment shader with flat normals computed from derivatives (like tilemarkers)
const fragShaderLit = `
  #version 330 core
  in vec3 FragPos;
  in vec4 vColor;
  uniform mat4 uSunlightViewMatrix;
  uniform vec3 uSunColour;
  uniform vec3 uAmbientColour;
  out vec4 FragColor;
  void main() {
    vec3 dx = dFdx(FragPos);
    vec3 dy = dFdy(FragPos);
    vec3 norm = normalize(cross(dx, dy));
    norm.z = -norm.z;
    vec3 lightDir = normalize(-uSunlightViewMatrix[2].xyz);
    float diff = max(dot(norm, lightDir), 0.0);
    vec3 lighting = diff * uSunColour + uAmbientColour;
    lighting = max(lighting, vec3(0.3));
    FragColor = vec4(vColor.rgb * lighting, vColor.a);
  }
`;

export interface NpcTexture {
  samplerId: number;
  texId: number;
  width: number;
  height: number;
  snapshot: patchrs.TextureSnapshot;
}

export interface NpcMesh {
  vaoId: number;
  programId: number;
  vertexCount: number;
  position: { x: number; y: number; z: number };
  rotation: number;
  modelMatrix: Matrix4;
  screenPos?: { x: number; y: number; z: number };
  hasBones: boolean;
  render: patchrs.RenderInvocation;
  progmeta: ProgramMeta;
  textures?: NpcTexture[];
  /** Framebuffer ID this mesh renders to (for overlay attachment) */
  framebufferId: number;
}

/**
 * A group of meshes that share the same model matrix (belong to the same entity)
 * This includes the body + weapons + accessories + effects
 */
export interface NpcMeshGroup {
  /** The main mesh (body with bones) */
  mainMesh: NpcMesh;
  /** All meshes in this group (including main) */
  allMeshes: NpcMesh[];
  /** All render invocations for combined hash computation */
  renders: patchrs.RenderInvocation[];
  /** Total vertex count across all meshes */
  totalVertexCount: number;
  /** Number of mesh parts */
  meshCount: number;
  /** Position from the main mesh */
  position: { x: number; y: number; z: number };
  /** The shared model matrix */
  modelMatrix: Matrix4;
  /** Framebuffer ID this group renders to (from main mesh) */
  framebufferId: number;
}

export interface NpcFilter {
  vertexCount?: number | { min?: number; max?: number };
  vertexCounts?: number[];
  hasBones?: boolean;
  excludeFloor?: boolean;
  maxVertexCount?: number;
  /** Maximum meshes per group (default: 15). Groups with more meshes are filtered unless they have bones. */
  maxMeshCount?: number;
  excludeSelf?: boolean;
  includeTextures?: boolean;
  /** Number of retry attempts for incomplete positions (default: 0) */
  retryIncomplete?: number;
  /** Delay between retries in ms (default: 50) */
  retryDelay?: number;
  /** Enable aggressive scanning mode with more frames and animation cycle detection */
  aggressiveScan?: boolean;
  /** Maximum frames to capture in aggressive mode (default: 30) */
  maxFrames?: number;
  /** Position tolerance for fuzzy grouping in tiles (default: 0.1) */
  positionTolerance?: number;
  /** Stop after this many consecutive frames with no new meshes (default: 5) */
  noNewMeshThreshold?: number;
  /** Player position for distance-based filtering (skips expensive hash computation for far NPCs) */
  playerPosition?: { x: number; z: number };
  /** Maximum distance from player in tiles (default: 50). Renders beyond this are skipped. */
  maxDistanceFromPlayer?: number;
}

/** Statistics from a scan operation */
export interface ScanStatistics {
  totalFramesCaptured: number;
  totalRenderCalls: number;
  uniqueMeshesFound: number;
  groupsFormed: number;
  incompletePositions: number;
  captureTimeMs: number;
  skippedByFilter: {
    ui: number;
    floor: number;
    noMatrix: number;
    notMesh: number;
    noVerts: number;
  };
  programIdsFound: Set<number>;
  earlyStopReason?: string;
}

/**
 * Represents a position where only tinted/occlusion meshes were found
 * but no main mesh with bones (incomplete render)
 */
export interface IncompletePosition {
  /** Position key */
  key: string;
  /** World position */
  position: { x: number; y: number; z: number };
  /** Screen position if available */
  screenPos?: { x: number; y: number; z: number };
  /** Number of tinted meshes found */
  tintedMeshCount: number;
  /** Model matrix at this position */
  modelMatrix: Matrix4;
}

export interface NpcOverlayOptions {
  color?: RGBA | [number, number, number, number];
  thickness?: number;
  size?: number;
}

function toColorTuple(
  color: RGBA | [number, number, number, number]
): [number, number, number, number] {
  if (Array.isArray(color)) return color;
  return [color.r, color.g, color.b, color.a];
}

// Bitwise mask for filtering programs
const SKIP_PROGRAM_MASK = 1 << 5;

export interface StreamingScanOptions {
  /** Callback for each batch of NPCs detected (individual meshes) */
  onNpcs?: (npcs: NpcMesh[]) => void;
  /** Callback for each batch of grouped NPCs (combined meshes) */
  onGroups?: (groups: NpcMeshGroup[]) => void;
  /** Callback for positions with only tinted meshes (incomplete renders) */
  onIncomplete?: (positions: IncompletePosition[]) => void;
  /** Callback for errors */
  onError?: (error: Error) => void;
  /** Filter options */
  filter?: NpcFilter;
}

export class NpcOverlay {
  private overlayHandles: patchrs.GlOverlay[] = [];
  private viewProjMatrix: Matrix4 | null = null;
  private screenWidth = 1920;
  private screenHeight = 1080;
  private activeStream: { close: () => Promise<void> } | null = null;

  /**
   * Cache of buffer hash -> VAO info for fast NPC lookup
   * Avoids expensive full-frame scans when we've seen this NPC before
   */
  private vaoCache: Map<string, { vaoId: number; framebufferId: number; timestamp: number }> = new Map();
  private readonly VAO_CACHE_TTL = 30000; // 30 seconds - NPCs can change VAO when they move/animate

  constructor() {
    this.updateScreenSize();
  }

  private updateScreenSize(): void {
    this.screenWidth = patchrs.native.getRsWidth() || 1920;
    this.screenHeight = patchrs.native.getRsHeight() || 1080;
  }

  /**
   * Update screen dimensions (call when resolution changes)
   * Also clears the VAO cache since VAO IDs may change after resolution change
   */
  public refreshScreenDimensions(): void {
    const oldWidth = this.screenWidth;
    const oldHeight = this.screenHeight;
    this.updateScreenSize();

    if (oldWidth !== this.screenWidth || oldHeight !== this.screenHeight) {
      // Clear VAO cache since VAO IDs may have changed
      this.clearVaoCache();
    }
  }

  /**
   * Get current screen dimensions
   */
  public getScreenDimensions(): { width: number; height: number } {
    return { width: this.screenWidth, height: this.screenHeight };
  }

  /**
   * Start a streaming scan that continuously detects NPCs.
   * Filters out floor and non-boned items using bitwise masking for performance.
   * Uses native framecooldown (500ms) to reduce memory pressure and prevent RS disconnection.
   *
   * @param options Streaming options including callbacks and filter
   * @returns A function to stop the stream
   */
  startStreamingScan(options: StreamingScanOptions = {}): () => void {
    const { onNpcs, onGroups, onIncomplete, onError, filter } = options;

    // Stop any existing stream
    this.stopStreamingScan();

    try {
      // For streaming, only use uniforms (lightweight) - skip heavy vertex buffer data
      // Hash computation requires inputs but causes memory issues in streaming mode
      // Use scanGrouped() for on-demand hash computation instead
      const streamFeatures: ("uniforms" | "textures")[] = ["uniforms"];
      if (filter?.includeTextures) {
        streamFeatures.push("textures");
      }

      this.activeStream = patchrs.native.streamRenderCalls(
        {
          features: streamFeatures,
          framecooldown: 2000, // 2 second cooldown like tilemarkers
          skipProgramMask: onGroups ? 0 : SKIP_PROGRAM_MASK,
        },
        (renders) => {
          try {
            // Monitor shared memory usage to detect exhaustion before disconnect
            const memState = patchrs.native.debug.memoryState();
            if (memState) {
              const pctUsed = memState.used / memState.size;
              if (pctUsed > 0.9) {
                // Critical - try to free memory before disconnect
                const usedMB = (memState.used / (1024 * 1024)).toFixed(1);
                const totalMB = (memState.size / (1024 * 1024)).toFixed(1);
                console.error(`[NpcOverlay] 🚨 CRITICAL: Shared memory at ${usedMB}/${totalMB}MB (${(pctUsed * 100).toFixed(1)}%) - attempting cleanup`);
                patchrs.native.debug.resetOpenGlState().catch(() => {});
              }
            }

            // If onGroups is provided, use grouped scanning (combines all mesh parts per NPC)
            if (onGroups) {
              const groups = this.scanGroupedFromRenders(renders, { ...filter, excludeFloor: true });
              if (groups.length > 0) {
                onGroups(groups);
              }
              // Report incomplete positions (only uTint found, no main mesh)
              if (onIncomplete) {
                const incompletePositions = this.getLastIncompletePositions();
                if (incompletePositions.length > 0) {
                  onIncomplete(incompletePositions);
                }
              }
              return;
            }

            // Otherwise use individual mesh scanning (legacy behavior)
            const npcs: NpcMesh[] = [];

            for (const render of renders) {
              const progmeta = getProgramMeta(render.program);

              // Skip UI elements
              if (progmeta.isUi) continue;

              // Skip if no model matrix (not a positioned object)
              if (!progmeta.uModelMatrix) continue;

              // Filter: Skip floor meshes - mark program to skip in future
              if (progmeta.isFloor) {
                render.program.skipmask |= SKIP_PROGRAM_MASK;
                continue;
              }

              // Filter: Must have bones (animated mesh)
              if (!progmeta.uBones) {
                render.program.skipmask |= SKIP_PROGRAM_MASK;
                continue;
              }

              const vertexCount = render.vertexArray.indexBuffer?.length || 0;
              const maxVertexCount = filter?.maxVertexCount ?? 10000;
              if (vertexCount > maxVertexCount) continue;

              // Apply additional vertex count filters if specified
              if (filter?.vertexCount !== undefined) {
                if (typeof filter.vertexCount === "number") {
                  if (vertexCount !== filter.vertexCount) continue;
                } else {
                  if (filter.vertexCount.min !== undefined && vertexCount < filter.vertexCount.min) continue;
                  if (filter.vertexCount.max !== undefined && vertexCount > filter.vertexCount.max) continue;
                }
              }

              if (filter?.vertexCounts !== undefined && filter.vertexCounts.length > 0) {
                if (!filter.vertexCounts.includes(vertexCount)) continue;
              }

              // Extract position from model matrix
              const rotmatrix = getUniformValue(render.uniformState, progmeta.uModelMatrix)[0] as number[];
              const modelMatrix = new Matrix4().fromArray(rotmatrix);

              const x = rotmatrix[12] / tilesize - 1.5;
              const y = rotmatrix[13] / tilesize;
              const z = rotmatrix[14] / tilesize - 0.5;
              const yRotation = -Math.atan2(rotmatrix[8], rotmatrix[0]);

              // Update view projection matrix
              if (!this.viewProjMatrix) {
                const projuni = progmeta.raw.uniforms.find((q) => q.name === "uViewProjMatrix");
                if (projuni) {
                  this.viewProjMatrix = new Matrix4().fromArray(
                    getUniformValue(render.uniformState, projuni)[0]
                  );
                }
              }

              // Calculate screen position
              let screenPos: { x: number; y: number; z: number } | undefined;
              if (this.viewProjMatrix) {
                const worldPos = new Vector3(rotmatrix[12], rotmatrix[13], rotmatrix[14]);
                const clipPos = worldPos.applyMatrix4(this.viewProjMatrix);
                screenPos = {
                  x: (clipPos.x * 0.5 + 0.5) * this.screenWidth,
                  y: (1 - (clipPos.y * 0.5 + 0.5)) * this.screenHeight,
                  z: clipPos.z,
                };
              }

              // Capture textures if requested
              let textures: NpcTexture[] | undefined;
              if (render.samplers && Object.keys(render.samplers).length > 0) {
                textures = [];
                for (const [samplerId, snapshot] of Object.entries(render.samplers)) {
                  if (snapshot && snapshot.canCapture()) {
                    textures.push({
                      samplerId: parseInt(samplerId, 10),
                      texId: snapshot.texid,
                      width: snapshot.width,
                      height: snapshot.height,
                      snapshot,
                    });
                  }
                }
                if (textures.length === 0) textures = undefined;
              }

              npcs.push({
                vaoId: render.vertexObjectId,
                programId: render.program.programId,
                framebufferId: render.framebufferId,
                vertexCount,
                position: { x, y, z },
                rotation: yRotation,
                modelMatrix,
                screenPos,
                hasBones: true, // We already filtered for bones
                render,
                progmeta,
                textures,
              });
            }

            // Call the callback with detected NPCs
            if (npcs.length > 0 && onNpcs) {
              onNpcs(npcs);
            }
          } catch (e) {
            onError?.(e instanceof Error ? e : new Error(String(e)));
          }
        }
      );
    } catch (e) {
      onError?.(e instanceof Error ? e : new Error(String(e)));
    }

    return () => this.stopStreamingScan();
  }

  /**
   * Stop the active streaming scan
   */
  stopStreamingScan(): void {
    if (this.activeStream) {
      try {
        this.activeStream.close();
      } catch {
        // Ignore errors when stopping
      }
      this.activeStream = null;
    }
  }

  /**
   * Check if streaming scan is active
   */
  isStreaming(): boolean {
    return this.activeStream !== null;
  }

  async scan(filter?: NpcFilter): Promise<NpcMesh[]> {
    const features: ("vertexarray" | "uniforms" | "textures")[] = ["vertexarray", "uniforms"];
    if (filter?.includeTextures) {
      features.push("textures");
    }
    const renders = await captureWithStreamPause(() => patchrs.native.recordRenderCalls({ maxframes: 1, features }));
    const result = this.scanFromRenders(renders, filter);
    return result;
  }

  scanFromRenders(renders: patchrs.RenderInvocation[], filter?: NpcFilter): NpcMesh[] {
    const meshes: NpcMesh[] = [];

    for (const render of renders) {
      const progmeta = getProgramMeta(render.program);

      if (progmeta.isUi) continue;
      if (!progmeta.uModelMatrix) continue;

      // Filter: Must have bones (animated mesh)
      if (!progmeta.uBones) continue;

      const vertexCount = render.vertexArray.indexBuffer?.length || 0;
      const maxVertexCount = filter?.maxVertexCount ?? 10000;
      if (vertexCount > maxVertexCount) continue;

      if (filter) {
        if (filter.excludeFloor && progmeta.isFloor) continue;

        if (filter.vertexCount !== undefined) {
          if (typeof filter.vertexCount === "number") {
            if (vertexCount !== filter.vertexCount) continue;
          } else {
            if (filter.vertexCount.min !== undefined && vertexCount < filter.vertexCount.min) continue;
            if (filter.vertexCount.max !== undefined && vertexCount > filter.vertexCount.max) continue;
          }
        }

        if (filter.vertexCounts !== undefined && filter.vertexCounts.length > 0) {
          if (!filter.vertexCounts.includes(vertexCount)) continue;
        }

        if (filter.hasBones !== undefined && !!progmeta.uBones !== filter.hasBones) continue;
      }

      const rotmatrix = getUniformValue(render.uniformState, progmeta.uModelMatrix)[0] as number[];
      const modelMatrix = new Matrix4().fromArray(rotmatrix);

      const x = rotmatrix[12] / tilesize - 1.5;
      const y = rotmatrix[13] / tilesize;
      const z = rotmatrix[14] / tilesize - 0.5;
      const yRotation = -Math.atan2(rotmatrix[8], rotmatrix[0]);

      if (!this.viewProjMatrix) {
        const projuni = progmeta.raw.uniforms.find((q) => q.name === "uViewProjMatrix");
        if (projuni) {
          this.viewProjMatrix = new Matrix4().fromArray(
            getUniformValue(render.uniformState, projuni)[0]
          );
        }
      }

      let screenPos: { x: number; y: number; z: number } | undefined;
      if (this.viewProjMatrix) {
        const worldPos = new Vector3(rotmatrix[12], rotmatrix[13], rotmatrix[14]);
        const clipPos = worldPos.applyMatrix4(this.viewProjMatrix);
        screenPos = {
          x: (clipPos.x * 0.5 + 0.5) * this.screenWidth,
          y: (1 - (clipPos.y * 0.5 + 0.5)) * this.screenHeight,
          z: clipPos.z,
        };
      }

      let textures: NpcTexture[] | undefined;
      if (render.samplers && Object.keys(render.samplers).length > 0) {
        textures = [];
        for (const [samplerId, snapshot] of Object.entries(render.samplers)) {
          if (snapshot && snapshot.canCapture()) {
            textures.push({
              samplerId: parseInt(samplerId, 10),
              texId: snapshot.texid,
              width: snapshot.width,
              height: snapshot.height,
              snapshot,
            });
          }
        }
        if (textures.length === 0) textures = undefined;
      }

      meshes.push({
        vaoId: render.vertexObjectId,
        programId: render.program.programId,
        framebufferId: render.framebufferId,
        vertexCount,
        position: { x, y, z },
        rotation: yRotation,
        modelMatrix,
        screenPos,
        hasBones: !!progmeta.uBones,
        render,
        progmeta,
        textures,
      });
    }

    if (filter?.excludeSelf && meshes.length > 0) {
      const centerX = this.screenWidth / 2;
      const centerY = this.screenHeight / 2;
      let closestIdx = -1;
      let closestDist = Infinity;

      for (let i = 0; i < meshes.length; i++) {
        const mesh = meshes[i];
        if (mesh.screenPos) {
          const dx = mesh.screenPos.x - centerX;
          const dy = mesh.screenPos.y - centerY;
          const dist = dx * dx + dy * dy;
          if (dist < closestDist) {
            closestDist = dist;
            closestIdx = i;
          }
        }
      }

      if (closestIdx >= 0) {
        meshes.splice(closestIdx, 1);
      }
    }

    return meshes;
  }

  /**
   * Scan and group meshes by model matrix.
   * Returns NPC groups where each group contains all mesh parts for one entity.
   * Useful for computing combined hashes that include body + weapons + accessories.
   */
  async scanGrouped(filter?: NpcFilter): Promise<NpcMeshGroup[]> {
    // NOTE: Removed "textures" - TextureSnapshots are massive memory hogs (can be 500MB+)
    // Only use textures when explicitly needed for texture capture
    const features: ("vertexarray" | "uniforms")[] = ["vertexarray", "uniforms"];

    const renders = await captureWithStreamPause(() => patchrs.native.recordRenderCalls({ maxframes: 1, features }));

    return this.scanGroupedFromRenders(renders, filter);
  }

  /**
   * Scan and group meshes, with multi-frame capture for better coverage.
   * Captures multiple frames to catch meshes that render at different times.
   * Includes periodic memory cleanup to prevent exhaustion.
   *
   * @param filter Filter options including retryIncomplete and retryDelay
   * @returns Object with groups, incomplete positions, and scan statistics
   */
  async scanGroupedWithRetry(filter?: NpcFilter): Promise<{
    groups: NpcMeshGroup[];
    incomplete: IncompletePosition[];
    statistics?: ScanStatistics;
  }> {
    const startTime = performance.now();
    const isAggressive = filter?.aggressiveScan ?? false;

    // Aggressive mode: more frames, longer capture, animation cycle detection
    // Increased to catch NPCs on different elevations/floors
    const maxFrames = filter?.maxFrames ?? (isAggressive ? 20 : 8);
    const baseDelay = filter?.retryDelay ?? (isAggressive ? 100 : 50);
    const noNewMeshThreshold = filter?.noNewMeshThreshold ?? 4;

    // Store only essential data to reduce memory footprint
    // Must include all fields that getRenderFunc and other processing functions need
    interface MinimalRenderData {
      vertexObjectId: number;
      programId: number;
      uniformState: Uint8Array;
      vertexArray: patchrs.VertexArraySnapshot;
      program: patchrs.GlProgram;
      samplers?: { [key: string]: patchrs.TextureSnapshot };
      renderRanges: { start: number; length: number }[];
      renderMode: string;
      indexType: number;
    }

    // Collect minimal render data across multiple frames
    const allRenders: MinimalRenderData[] = [];
    const seenVaoIds = new Set<number>();
    const programIdsFound = new Set<number>();

    // Track original RenderInvocation objects for disposal after processing
    const allOriginalFrameRenders: patchrs.RenderInvocation[][] = [];

    // Statistics tracking
    let totalRenderCalls = 0;
    let framesCaptured = 0;
    let consecutiveNoNewMeshes = 0;
    let earlyStopReason: string | undefined;

    // Small delay before first capture to ensure game is in a good state
    await new Promise(resolve => setTimeout(resolve, 50));

    // Try capturing multiple times if first attempt returns nothing
    let initialRenders: patchrs.RenderInvocation[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {  // Reduced from 5 to 3
      initialRenders = await captureWithStreamPause(() => patchrs.native.recordRenderCalls({ maxframes: 1, features: ["vertexarray", "uniforms"] }));  // Removed "textures" to save memory
      if (initialRenders.length > 0) break;
      await new Promise(resolve => setTimeout(resolve, 50 + attempt * 50));
    }
    allOriginalFrameRenders.push(initialRenders);

    framesCaptured++;
    totalRenderCalls += initialRenders.length;

    for (const render of initialRenders) {
      if (!seenVaoIds.has(render.vertexObjectId)) {
        seenVaoIds.add(render.vertexObjectId);
        // Store only essential data
        allRenders.push({
          vertexObjectId: render.vertexObjectId,
          programId: render.program.programId,
          uniformState: render.uniformState,
          vertexArray: render.vertexArray,
          program: render.program,
          samplers: render.samplers,
          renderRanges: render.renderRanges,
          renderMode: render.renderMode,
          indexType: render.indexType,
        });
        programIdsFound.add(render.program.programId);
      }
    }

    const initialMeshCount = allRenders.length;

    // Capture additional frames with animation cycle detection
    for (let frame = 0; frame < maxFrames; frame++) {
      // Use staggered delays: base, base*1.5, base, base*2, base, etc.
      // This helps catch meshes that render at different intervals
      const delay = frame % 3 === 1 ? baseDelay * 1.5 : frame % 3 === 2 ? baseDelay * 2 : baseDelay;
      await new Promise(resolve => setTimeout(resolve, delay));

      const frameRenders = await captureWithStreamPause(() => patchrs.native.recordRenderCalls({ maxframes: 1, features: ["vertexarray", "uniforms"] }));
      allOriginalFrameRenders.push(frameRenders);
      framesCaptured++;
      totalRenderCalls += frameRenders.length;

      let newMeshes = 0;
      for (const render of frameRenders) {
        if (!seenVaoIds.has(render.vertexObjectId)) {
          seenVaoIds.add(render.vertexObjectId);
          allRenders.push({
            vertexObjectId: render.vertexObjectId,
            programId: render.program.programId,
            uniformState: render.uniformState,
            vertexArray: render.vertexArray,
            program: render.program,
            samplers: render.samplers,
            renderRanges: render.renderRanges,
            renderMode: render.renderMode,
            indexType: render.indexType,
          });
          programIdsFound.add(render.program.programId);
          newMeshes++;
        }
      }

      if (newMeshes > 0) {
        consecutiveNoNewMeshes = 0;
      } else {
        consecutiveNoNewMeshes++;

        // Animation cycle detection: stop if no new meshes for threshold frames
        if (consecutiveNoNewMeshes >= noNewMeshThreshold) {
          earlyStopReason = `No new meshes for ${noNewMeshThreshold} consecutive frames (animation cycle complete)`;
          break;
        }
      }

      // Check memory every 3 frames
      if ((frame + 1) % 3 === 0) {
        const memState = patchrs.native.debug.memoryState();
        if (memState) {
          const pctUsed = memState.used / memState.size;
          if (pctUsed > 0.9) {
            const usedMB = (memState.used / (1024 * 1024)).toFixed(1);
            console.error(`[NpcOverlay] 🚨 CRITICAL memory: ${usedMB}MB (${(pctUsed * 100).toFixed(1)}%) - stopping scan early`);
            earlyStopReason = `Memory critical (${(pctUsed * 100).toFixed(0)}%)`;
            break;
          }
        }
      }
    }

    // Final cleanup after capture loop
    try {
      await patchrs.native.debug.resetOpenGlState();
    } catch {
      // Ignore cleanup errors
    }

    const captureTimeMs = performance.now() - startTime;

    // Process all collected renders with fuzzy grouping
    // Cast MinimalRenderData to RenderInvocation - they share the essential fields
    try {
      const allGroups = this.scanGroupedFromRenders(allRenders as unknown as patchrs.RenderInvocation[], filter);
      const incomplete = this.getLastIncompletePositions();

      // Compile statistics
      const statistics: ScanStatistics = {
        totalFramesCaptured: framesCaptured,
        totalRenderCalls,
        uniqueMeshesFound: allRenders.length,
        groupsFormed: allGroups.length,
        incompletePositions: incomplete.length,
        captureTimeMs,
        skippedByFilter: (this as any)._lastFilterStats || {
          ui: 0, floor: 0, shadow: 0, noMatrix: 0, notMesh: 0, noVerts: 0
        },
        programIdsFound,
        earlyStopReason,
      };

      // Store statistics for UI access
      (this as any)._lastScanStatistics = statistics;

      return { groups: allGroups, incomplete, statistics };
    } finally {
      // Dispose all original RenderInvocation objects to free native GPU memory.
      // The MinimalRenderData copies in allRenders have already been processed by scanGroupedFromRenders.
      for (const frameRenders of allOriginalFrameRenders) {
        for (const r of frameRenders) { try { r.dispose?.(); } catch (_) {} }
      }
    }
  }

  /**
   * Get statistics from the last scan operation
   */
  getLastScanStatistics(): ScanStatistics | undefined {
    return (this as any)._lastScanStatistics;
  }

  /**
   * Rescan a specific position across multiple frames to capture all mesh parts.
   * Captures a full animation cycle worth of frames to find all mesh variations.
   *
   * @param targetGroup The NPC group to rescan (uses its position)
   * @param options Optional settings for frame count and delay
   * @returns Updated group with all mesh parts found across frames
   */
  async rescanGroupMultiFrame(
    targetGroup: NpcMeshGroup,
    options: { frameCount?: number; frameDelay?: number; positionTolerance?: number } = {}
  ): Promise<NpcMeshGroup> {
    // More aggressive defaults - capture ~2 seconds of animation
    const frameCount = options.frameCount ?? 20;
    const frameDelay = options.frameDelay ?? 100;
    const tolerance = options.positionTolerance ?? 0.5; // Larger tolerance for attached items

    // Target position and rotation to match
    const targetX = targetGroup.position.x;
    const targetY = targetGroup.position.y;
    const targetZ = targetGroup.position.z;
    const targetRotation = targetGroup.mainMesh.rotation;

    // Collect all unique meshes at this position across multiple frames
    const collectedMeshes: NpcMesh[] = [];
    const collectedRenders: patchrs.RenderInvocation[] = [];
    const seenVaoIds = new Set<number>();

    // Track stats
    let totalRendersChecked = 0;
    let skippedWrongPos = 0;
    let skippedWrongRot = 0;

    // Add existing meshes from the target group
    for (const mesh of targetGroup.allMeshes) {
      if (!seenVaoIds.has(mesh.vaoId)) {
        seenVaoIds.add(mesh.vaoId);
        collectedMeshes.push(mesh);
        collectedRenders.push(mesh.render);
      }
    }

    // Capture multiple frames to catch all animation states
    for (let frame = 0; frame < frameCount; frame++) {
      await new Promise(resolve => setTimeout(resolve, frameDelay));

      // NOTE: Removed "textures" - TextureSnapshots are massive memory hogs
      const frameRenders = await captureWithStreamPause(() => patchrs.native.recordRenderCalls({ maxframes: 1, features: ["vertexarray", "uniforms"] }));
      let newMeshes = 0;

      for (const render of frameRenders) {
        totalRendersChecked++;

        // Skip if already seen
        if (seenVaoIds.has(render.vertexObjectId)) continue;

        const progmeta = getProgramMeta(render.program);

        // Skip UI and floor
        if (progmeta.isUi) continue;
        if (progmeta.isFloor) continue;
        if (!progmeta.uModelMatrix) continue;

        // Accept ANY mesh with a model matrix (very permissive for animation capture)
        // We'll filter by position/rotation instead
        const vertexCount = render.vertexArray.indexBuffer?.length || 0;
        if (vertexCount === 0) continue;

        const rotmatrix = getUniformValue(render.uniformState, progmeta.uModelMatrix)[0] as number[];
        const x = rotmatrix[12] / tilesize - 1.5;
        const y = rotmatrix[13] / tilesize;
        const z = rotmatrix[14] / tilesize - 0.5;
        const yRotation = -Math.atan2(rotmatrix[8], rotmatrix[0]);

        // Check position - use XZ distance (horizontal), Y can vary more for held items
        const dxz = Math.sqrt((x - targetX) ** 2 + (z - targetZ) ** 2);
        const dy = Math.abs(y - targetY);

        // Position must be close horizontally, but allow more vertical variation
        if (dxz > tolerance) { skippedWrongPos++; continue; }
        if (dy > tolerance * 3) { skippedWrongPos++; continue; } // More vertical tolerance

        // Rotation should be similar (within ~30 degrees)
        let rotDiff = Math.abs(yRotation - targetRotation);
        if (rotDiff > Math.PI) rotDiff = 2 * Math.PI - rotDiff;
        if (rotDiff > 0.5) { skippedWrongRot++; continue; } // ~30 degrees tolerance

        // This mesh belongs to the target NPC
        seenVaoIds.add(render.vertexObjectId);
        newMeshes++;

        const modelMatrix = new Matrix4().fromArray(rotmatrix);

        let screenPos: { x: number; y: number; z: number } | undefined;
        if (this.viewProjMatrix) {
          const worldPos = new Vector3(rotmatrix[12], rotmatrix[13], rotmatrix[14]);
          const clipPos = worldPos.applyMatrix4(this.viewProjMatrix);
          screenPos = {
            x: (clipPos.x * 0.5 + 0.5) * this.screenWidth,
            y: (1 - (clipPos.y * 0.5 + 0.5)) * this.screenHeight,
            z: clipPos.z,
          };
        }

        const mesh: NpcMesh = {
          vaoId: render.vertexObjectId,
          programId: render.program.programId,
          vertexCount,
          position: { x, y, z },
          rotation: yRotation,
          modelMatrix,
          screenPos,
          hasBones: !!progmeta.uBones,
          render,
          progmeta,
          framebufferId: render.framebufferId,
        };

        collectedMeshes.push(mesh);
        collectedRenders.push(render);
      }
    }

    // Deduplicate meshes by position buffer hash
    const seenMeshHashes = new Set<number>();
    const uniqueMeshes: NpcMesh[] = [];
    const uniqueRenders: patchrs.RenderInvocation[] = [];
    for (let i = 0; i < collectedMeshes.length; i++) {
      const mesh = collectedMeshes[i];
      const hashes = extractBufferHashes(mesh.render);
      if (hashes.posBufferHashNum === 0 || !seenMeshHashes.has(hashes.posBufferHashNum)) {
        if (hashes.posBufferHashNum !== 0) {
          seenMeshHashes.add(hashes.posBufferHashNum);
        }
        uniqueMeshes.push(mesh);
        uniqueRenders.push(collectedRenders[i]);
      }
    }

    // Find the best main mesh (with bones, or largest)
    let mainMesh = uniqueMeshes.find(m => m.hasBones && m.progmeta.isMainMesh);
    if (!mainMesh) {
      mainMesh = uniqueMeshes.reduce((a, b) => a.vertexCount > b.vertexCount ? a : b);
    }

    const totalVertexCount = uniqueMeshes.reduce((sum, m) => sum + m.vertexCount, 0);

    return {
      mainMesh,
      allMeshes: uniqueMeshes,
      renders: uniqueRenders,
      totalVertexCount,
      meshCount: uniqueMeshes.length,
      position: targetGroup.position,
      modelMatrix: targetGroup.modelMatrix,
      framebufferId: mainMesh.framebufferId,
    };
  }

  /**
   * Group meshes from render invocations by model matrix.
   * Supports fuzzy position grouping for attached items with slight position variations.
   */
  scanGroupedFromRenders(renders: patchrs.RenderInvocation[], filter?: NpcFilter): NpcMeshGroup[] {
    // Position tolerance for fuzzy grouping (in tiles)
    const tolerance = filter?.positionTolerance ?? 0.1;
    const toleranceMultiplier = Math.round(1 / tolerance); // Convert tolerance to rounding factor

    const groups = new Map<string, { meshes: NpcMesh[]; renders: patchrs.RenderInvocation[]; matrix: Matrix4; centroid: { x: number; y: number; z: number } }>();

    // Debug counters - store for statistics
    let skippedUi = 0, skippedFloor = 0, skippedShadow = 0, skippedNoMatrix = 0, skippedNotMesh = 0, skippedNoVerts = 0, accepted = 0;

    for (const render of renders) {
      const progmeta = getProgramMeta(render.program);

      // Skip UI and floor
      if (progmeta.isUi) { skippedUi++; continue; }
      if (filter?.excludeFloor !== false && progmeta.isFloor) {
        skippedFloor++;
        continue;
      }
      // Skip shadow pass renders - same meshes get rendered twice (main + shadow)
      // Shadow pass only writes depth for shadow mapping, we want main render only
      if (progmeta.isShadowRender) {
        skippedShadow++;
        continue;
      }
      if (!progmeta.uModelMatrix) { skippedNoMatrix++; continue; }

      // Filter: Must have bones (animated mesh)
      if (!progmeta.uBones) {
        skippedNotMesh++;
        continue;
      }

      const vertexCount = render.vertexArray.indexBuffer?.length || 0;
      if (vertexCount === 0) { skippedNoVerts++; continue; }

      // Get position FIRST (before expensive hash computation) for distance filtering
      const rotmatrix = getUniformValue(render.uniformState, progmeta.uModelMatrix)[0] as number[];
      const x = rotmatrix[12] / tilesize - 1.5;
      const y = rotmatrix[13] / tilesize;
      const z = rotmatrix[14] / tilesize - 0.5;
      const yRotation = -Math.atan2(rotmatrix[8], rotmatrix[0]);

      // Distance-based filtering: skip renders far from player to save hash computation
      if (filter?.playerPosition) {
        const maxDist = filter.maxDistanceFromPlayer ?? 50;
        const dx = x - filter.playerPosition.x;
        const dz = z - filter.playerPosition.z;
        const distSq = dx * dx + dz * dz;
        if (distSq > maxDist * maxDist) {
          render.dispose?.();
          continue;
        }
      }

      // Skip blank meshes (no valid buffer hash) - these are auxiliary meshes like shadows/hitboxes
      // This is expensive so we do it AFTER distance filtering
      const bufferHashes = extractBufferHashes(render);
      if (bufferHashes.posBufferHash === "0x00000000") {
        skippedNoVerts++; // Count as no verts since it's effectively empty
        continue;
      }

      accepted++;

      const modelMatrix = new Matrix4().fromArray(rotmatrix);

      // Create a key from the model matrix (position + rotation)
      // Use tolerance-based rounding for fuzzy grouping
      const matrixKey = `${Math.round(x * toleranceMultiplier)}_${Math.round(y * toleranceMultiplier)}_${Math.round(z * toleranceMultiplier)}_${Math.round(yRotation * 100)}`;

      // Get/update viewProjMatrix
      if (!this.viewProjMatrix) {
        const projuni = progmeta.raw.uniforms.find((q) => q.name === "uViewProjMatrix");
        if (projuni) {
          this.viewProjMatrix = new Matrix4().fromArray(
            getUniformValue(render.uniformState, projuni)[0]
          );
        }
      }

      let screenPos: { x: number; y: number; z: number } | undefined;
      if (this.viewProjMatrix) {
        const worldPos = new Vector3(rotmatrix[12], rotmatrix[13], rotmatrix[14]);
        const clipPos = worldPos.applyMatrix4(this.viewProjMatrix);
        screenPos = {
          x: (clipPos.x * 0.5 + 0.5) * this.screenWidth,
          y: (1 - (clipPos.y * 0.5 + 0.5)) * this.screenHeight,
          z: clipPos.z,
        };
      }

      const mesh: NpcMesh = {
        vaoId: render.vertexObjectId,
        programId: render.program.programId,
        vertexCount,
        position: { x, y, z },
        rotation: yRotation,
        modelMatrix,
        screenPos,
        hasBones: !!progmeta.uBones,
        render,
        progmeta,
        framebufferId: render.framebufferId,
      };

      if (!groups.has(matrixKey)) {
        groups.set(matrixKey, { meshes: [], renders: [], matrix: modelMatrix, centroid: { x, y, z } });
      }
      const group = groups.get(matrixKey)!;
      group.meshes.push(mesh);
      group.renders.push(render);
      // Update centroid as running average
      const n = group.meshes.length;
      group.centroid.x = ((n - 1) * group.centroid.x + x) / n;
      group.centroid.y = ((n - 1) * group.centroid.y + y) / n;
      group.centroid.z = ((n - 1) * group.centroid.z + z) / n;
    }

    // Store filter statistics for scan statistics
    (this as any)._lastFilterStats = {
      ui: skippedUi,
      floor: skippedFloor,
      shadow: skippedShadow,
      noMatrix: skippedNoMatrix,
      notMesh: skippedNotMesh,
      noVerts: skippedNoVerts,
    };

    // Convert to NpcMeshGroup array and track incomplete positions
    const result: NpcMeshGroup[] = [];
    const incomplete: IncompletePosition[] = [];
    let groupsWithBones = 0, groupsNoBones = 0;

    // Define mesh count limit outside loop for use in logging
    const maxMeshCount = filter?.maxMeshCount ?? 15;

    for (const [key, group] of groups) {
      // Find the main mesh using priority:
      // 1. Mesh with both bones AND isMainMesh (ideal case)
      // 2. Largest mesh with bones (animated but not marked as main - like Death)
      // 3. Fallback to largest mesh overall
      let mainMesh = group.meshes.find(m => m.hasBones && m.progmeta.isMainMesh);
      if (!mainMesh) {
        // Look for meshes with bones, pick the largest
        const meshesWithBones = group.meshes.filter(m => m.hasBones);
        if (meshesWithBones.length > 0) {
          mainMesh = meshesWithBones.reduce((a, b) => a.vertexCount > b.vertexCount ? a : b);
        } else {
          // No bones, fallback to largest mesh
          mainMesh = group.meshes.reduce((a, b) => a.vertexCount > b.vertexCount ? a : b);
        }
      }

      // Check if this group is a valid NPC
      // Valid if: ANY mesh has bones (animated), OR main mesh is isMainMesh (lighted 3D object)
      const anyMeshHasBones = group.meshes.some(m => m.hasBones);
      const isValidNpc = anyMeshHasBones || mainMesh.progmeta.isMainMesh;

      if (!isValidNpc) {
        groupsNoBones++;
        // Check if any mesh is tinted (has uTint) - indicates incomplete render
        const tintedMeshes = group.meshes.filter(m => m.progmeta.isTinted);
        if (tintedMeshes.length > 0) {
          // This is an incomplete position - only tint/occlusion rendered
          const pos = tintedMeshes[0].position;
          incomplete.push({
            key,
            position: pos,
            screenPos: tintedMeshes[0].screenPos,
            tintedMeshCount: tintedMeshes.length,
            modelMatrix: group.matrix,
          });
        }
        continue;
      }

      groupsWithBones++;

      // Deduplicate meshes within this group by position buffer hash
      const seenMeshHashes = new Set<number>();
      const uniqueMeshes: NpcMesh[] = [];
      const uniqueRenders: patchrs.RenderInvocation[] = [];
      for (let i = 0; i < group.meshes.length; i++) {
        const mesh = group.meshes[i];
        const hashes = extractBufferHashes(mesh.render);
        if (hashes.posBufferHashNum === 0 || !seenMeshHashes.has(hashes.posBufferHashNum)) {
          if (hashes.posBufferHashNum !== 0) {
            seenMeshHashes.add(hashes.posBufferHashNum);
          }
          uniqueMeshes.push(mesh);
          uniqueRenders.push(group.renders[i]);
        }
      }

      const totalVertexCount = uniqueMeshes.reduce((sum, m) => sum + m.vertexCount, 0);

      // Check if ANY mesh in the group has bones (animated entity = NPC)
      const groupHasBones = uniqueMeshes.some(m => m.hasBones);

      // Filter out groups with too many meshes (likely terrain/complex objects, not NPCs)
      // EXCEPTION: Groups with bones are NPCs and should NEVER be filtered
      const hasTooManyMeshes = uniqueMeshes.length > maxMeshCount;
      if (!groupHasBones && hasTooManyMeshes) {
        continue;
      }

      // Use the main mesh from unique meshes if it was deduplicated
      if (!uniqueMeshes.includes(mainMesh)) {
        mainMesh = uniqueMeshes.find(m => m.hasBones && m.progmeta.isMainMesh) ||
                   uniqueMeshes.reduce((a, b) => a.vertexCount > b.vertexCount ? a : b);
      }

      result.push({
        mainMesh,
        allMeshes: uniqueMeshes,
        renders: uniqueRenders,
        totalVertexCount,
        meshCount: uniqueMeshes.length,
        position: mainMesh.position,
        modelMatrix: group.matrix,
        framebufferId: mainMesh.framebufferId,
      });
    }

    // Sort by distance from screen center (closest first)
    const centerX = this.screenWidth / 2;
    const centerY = this.screenHeight / 2;
    result.sort((a, b) => {
      const aDist = a.mainMesh.screenPos
        ? Math.hypot(a.mainMesh.screenPos.x - centerX, a.mainMesh.screenPos.y - centerY)
        : Infinity;
      const bDist = b.mainMesh.screenPos
        ? Math.hypot(b.mainMesh.screenPos.x - centerX, b.mainMesh.screenPos.y - centerY)
        : Infinity;
      return aDist - bDist;
    });

    // Store incomplete positions for potential retry
    (this as any)._lastIncompletePositions = incomplete;

    return result;
  }

  /**
   * Get incomplete positions from the last scan (positions with only tinted meshes)
   */
  getLastIncompletePositions(): IncompletePosition[] {
    return (this as any)._lastIncompletePositions || [];
  }

  async highlightNpc(npc: NpcMesh, options: NpcOverlayOptions = {}): Promise<patchrs.GlOverlay | null> {
    const {
      color = { r: 255, g: 0, b: 0, a: 200 },
      thickness = 0.03,
      size = 0.4,
    } = options;

    const colorTuple = toColorTuple(color);
    const progmeta = npc.progmeta;

    if (!progmeta) {
      console.error("[NpcOverlay] NPC has no progmeta");
      return null;
    }

    const uViewProjMatrix = progmeta.raw.uniforms.find((q) => q.name === "uViewProjMatrix");
    if (!uViewProjMatrix || !progmeta.uModelMatrix) {
      console.error("[NpcOverlay] NPC program missing required uniforms. uViewProjMatrix:", !!uViewProjMatrix, "uModelMatrix:", !!progmeta.uModelMatrix);
      return null;
    }

    const radius = size * tilesize;
    const t = thickness * tilesize;
    const segments = 32;

    const pos: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];

    for (let i = 0; i <= segments; i++) {
      const angle = (i / segments) * Math.PI * 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);

      pos.push(cos * (radius + t), 0, sin * (radius + t));
      colors.push(...colorTuple);
      pos.push(cos * radius, 0, sin * radius);
      colors.push(...colorTuple);
    }

    for (let i = 0; i < segments; i++) {
      const i0 = i * 2;
      indices.push(i0, i0 + 1, i0 + 2);
      indices.push(i0 + 1, i0 + 3, i0 + 2);
    }

    const vertex = patchrs.native.createVertexArray(
      new Uint8Array(Uint16Array.from(indices).buffer),
      [
        {
          location: 0,
          buffer: new Uint8Array(Float32Array.from(pos).buffer),
          enabled: true,
          normalized: false,
          offset: 0,
          scalartype: GL_FLOAT,
          stride: 12,
          vectorlength: 3,
        },
        {
          location: 6,
          buffer: Uint8Array.from(colors),
          enabled: true,
          normalized: true,
          offset: 0,
          scalartype: GL_UNSIGNED_BYTE,
          stride: 4,
          vectorlength: 4,
        },
      ]
    );

    const localShader = `
      #version 330 core
      layout (location = 0) in vec3 aPos;
      layout (location = 6) in vec4 aColor;
      uniform mat4 uViewProjMatrix;
      uniform mat4 uModelMatrix;
      out vec4 vColor;
      void main() {
        vec4 worldPos = uModelMatrix * vec4(aPos, 1.0);
        gl_Position = uViewProjMatrix * worldPos;
        vColor = aColor;
      }
    `;

    const program = patchrs.native.createProgram(
      localShader,
      fragShader,
      [
        { location: 0, name: "aPos", type: GL_FLOAT, length: 3 },
        { location: 6, name: "aColor", type: GL_UNSIGNED_BYTE, length: 4 },
      ],
      [
        { name: "uViewProjMatrix", length: 1, type: GL_FLOAT_MAT4, snapshotOffset: 0, snapshotSize: 64 },
        { name: "uModelMatrix", length: 1, type: GL_FLOAT_MAT4, snapshotOffset: 64, snapshotSize: 64 },
      ]
    );

    try {
      const handle = await patchrs.native.beginOverlay(
        { vertexObjectId: npc.vaoId },
        program,
        vertex,
        {
          uniformSources: [
            { name: "uViewProjMatrix", sourceName: uViewProjMatrix.name, type: "program" },
            { name: "uModelMatrix", sourceName: progmeta.uModelMatrix.name, type: "program" },
          ],
          renderMode: RENDER_MODE_TRIANGLES,
          trigger: "after",
        }
      );
      this.overlayHandles.push(handle);
      return handle;
    } catch (e) {
      console.error("[NpcOverlay] Failed to create overlay:", e);
      return null;
    }
  }

  async drawArrowAboveNpc(
    npc: NpcMesh,
    options: { color?: RGBA | [number, number, number, number]; size?: number; height?: number } = {}
  ): Promise<patchrs.GlOverlay | null> {
    const { color = { r: 255, g: 255, b: 0, a: 255 }, size = 0.3, height = 2.5 } = options;

    const colorTuple = toColorTuple(color);
    const progmeta = npc.progmeta;

    const uViewProjMatrix = progmeta.raw.uniforms.find((q) => q.name === "uViewProjMatrix");
    if (!uViewProjMatrix || !progmeta.uModelMatrix) {
      console.error("[NpcOverlay] NPC program missing required uniforms");
      return null;
    }

    const arrowSize = size * tilesize;
    const arrowHeight = height * tilesize;

    const pos: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];

    const tipY = arrowHeight - arrowSize * 1.5;
    const baseY = arrowHeight;
    const stemWidth = arrowSize * 0.25;
    const stemTop = arrowHeight + arrowSize * 0.8;

    // Plane 1 (XY) - arrow head
    pos.push(0, tipY, 0);
    colors.push(...colorTuple);
    pos.push(-arrowSize * 0.6, baseY, 0);
    colors.push(...colorTuple);
    pos.push(arrowSize * 0.6, baseY, 0);
    colors.push(...colorTuple);
    indices.push(0, 1, 2, 0, 2, 1);

    // Plane 1 - stem
    pos.push(-stemWidth, baseY, 0);
    colors.push(...colorTuple);
    pos.push(stemWidth, baseY, 0);
    colors.push(...colorTuple);
    pos.push(stemWidth, stemTop, 0);
    colors.push(...colorTuple);
    pos.push(-stemWidth, stemTop, 0);
    colors.push(...colorTuple);
    indices.push(3, 4, 5, 3, 5, 6, 3, 5, 4, 3, 6, 5);

    // Plane 2 (YZ) - arrow head
    const v = 7;
    pos.push(0, tipY, 0);
    colors.push(...colorTuple);
    pos.push(0, baseY, -arrowSize * 0.6);
    colors.push(...colorTuple);
    pos.push(0, baseY, arrowSize * 0.6);
    colors.push(...colorTuple);
    indices.push(v, v + 1, v + 2, v, v + 2, v + 1);

    // Plane 2 - stem
    pos.push(0, baseY, -stemWidth);
    colors.push(...colorTuple);
    pos.push(0, baseY, stemWidth);
    colors.push(...colorTuple);
    pos.push(0, stemTop, stemWidth);
    colors.push(...colorTuple);
    pos.push(0, stemTop, -stemWidth);
    colors.push(...colorTuple);
    indices.push(v + 3, v + 4, v + 5, v + 3, v + 5, v + 6, v + 3, v + 5, v + 4, v + 3, v + 6, v + 5);

    const vertex = patchrs.native.createVertexArray(
      new Uint8Array(Uint16Array.from(indices).buffer),
      [
        {
          location: 0,
          buffer: new Uint8Array(Float32Array.from(pos).buffer),
          enabled: true,
          normalized: false,
          offset: 0,
          scalartype: GL_FLOAT,
          stride: 12,
          vectorlength: 3,
        },
        {
          location: 6,
          buffer: Uint8Array.from(colors),
          enabled: true,
          normalized: true,
          offset: 0,
          scalartype: GL_UNSIGNED_BYTE,
          stride: 4,
          vectorlength: 4,
        },
      ]
    );

    const arrowShader = `
      #version 330 core
      layout (location = 0) in vec3 aPos;
      layout (location = 6) in vec4 aColor;
      uniform mat4 uViewProjMatrix;
      uniform mat4 uModelMatrix;
      out vec3 FragPos;
      out vec4 vColor;
      void main() {
        vec3 npcPos = vec3(uModelMatrix[3][0], uModelMatrix[3][1], uModelMatrix[3][2]);
        vec4 worldPos = vec4(npcPos + aPos, 1.0);
        gl_Position = uViewProjMatrix * worldPos;
        FragPos = worldPos.xyz;
        vColor = aColor;
      }
    `;

    const uSunlightViewMatrix = progmeta.raw.uniforms.find((q) => q.name === "uSunlightViewMatrix");
    const uSunColour = progmeta.raw.uniforms.find((q) => q.name === "uSunColour");
    const uAmbientColour = progmeta.raw.uniforms.find((q) => q.name === "uAmbientColour");
    const hasLighting = uSunlightViewMatrix && uSunColour && uAmbientColour;

    const uniforms: patchrs.GlUniformArgument[] = [
      { name: "uViewProjMatrix", length: 1, type: GL_FLOAT_MAT4, snapshotOffset: 0, snapshotSize: 64 },
      { name: "uModelMatrix", length: 1, type: GL_FLOAT_MAT4, snapshotOffset: 64, snapshotSize: 64 },
    ];
    const uniformSources: patchrs.OverlayUniformSource[] = [
      { name: "uViewProjMatrix", sourceName: uViewProjMatrix.name, type: "program" },
      { name: "uModelMatrix", sourceName: progmeta.uModelMatrix.name, type: "program" },
    ];

    if (hasLighting) {
      uniforms.push(
        { name: "uSunlightViewMatrix", length: 1, type: GL_FLOAT_MAT4, snapshotOffset: 128, snapshotSize: 64 },
        { name: "uSunColour", length: 1, type: GL_FLOAT_VEC3, snapshotOffset: 192, snapshotSize: 12 },
        { name: "uAmbientColour", length: 1, type: GL_FLOAT_VEC3, snapshotOffset: 204, snapshotSize: 12 }
      );
      uniformSources.push(
        { name: "uSunlightViewMatrix", sourceName: uSunlightViewMatrix.name, type: "program" },
        { name: "uSunColour", sourceName: uSunColour.name, type: "program" },
        { name: "uAmbientColour", sourceName: uAmbientColour.name, type: "program" }
      );
    }

    const program = patchrs.native.createProgram(
      arrowShader,
      hasLighting ? fragShaderLit : fragShader,
      [
        { location: 0, name: "aPos", type: GL_FLOAT, length: 3 },
        { location: 6, name: "aColor", type: GL_UNSIGNED_BYTE, length: 4 },
      ],
      uniforms
    );

    try {
      const handle = await patchrs.native.beginOverlay(
        { vertexObjectId: npc.vaoId },
        program,
        vertex,
        { uniformSources, renderMode: RENDER_MODE_TRIANGLES, trigger: "after" }
      );
      this.overlayHandles.push(handle);
      return handle;
    } catch (e) {
      console.error("[NpcOverlay] Failed to create arrow overlay:", e);
      return null;
    }
  }

  /**
   * Estimate NPC height from vertex data by finding max Y in position buffer
   * Returns height in tiles
   */
  private estimateNpcHeight(npc: NpcMesh): number {
    try {
      const progmeta = npc.progmeta;
      if (!progmeta.aPos) return 2.5; // Default height

      const posAttr = npc.render.vertexArray.attributes.find(a => a.location === progmeta.aPos!.location);
      if (!posAttr || !posAttr.buffer) return 2.5;

      // Read position buffer as floats (assuming GL_FLOAT vec3)
      const floatView = new Float32Array(posAttr.buffer.buffer, posAttr.buffer.byteOffset, posAttr.buffer.byteLength / 4);
      const stride = posAttr.stride / 4; // Stride in floats
      const offset = posAttr.offset / 4; // Offset in floats

      let maxY = 0;
      const numVerts = Math.floor(floatView.length / stride);

      // Sample every 100th vertex for performance (good enough for height estimate)
      const step = Math.max(1, Math.floor(numVerts / 1000));
      for (let i = 0; i < numVerts; i += step) {
        const yIdx = i * stride + offset + 1; // Y is second component
        if (yIdx < floatView.length) {
          maxY = Math.max(maxY, floatView[yIdx]);
        }
      }

      // Convert from world units to tiles and add some padding
      const heightInTiles = maxY / tilesize + 0.5;
      return Math.max(2.5, heightInTiles); // Minimum 2.5 tiles
    } catch {
      return 2.5;
    }
  }

  async draw3DArrowAboveNpc(
    npc: NpcMesh,
    options: { color?: RGBA | [number, number, number, number]; size?: number; height?: number; autoHeight?: boolean; segments?: number } = {}
  ): Promise<patchrs.GlOverlay | null> {
    // Auto-calculate height if not specified and autoHeight is true (default)
    const autoHeight = options.autoHeight !== false;
    const estimatedHeight = autoHeight && options.height === undefined ? this.estimateNpcHeight(npc) : undefined;
    // Reduced default segments from 12 to 6 for better memory efficiency
    const { color = { r: 255, g: 255, b: 0, a: 255 }, size = 0.3, height = estimatedHeight ?? 2.5, segments = 6 } = options;

    const colorTuple = toColorTuple(color);
    const progmeta = npc.progmeta;

    const uViewProjMatrix = progmeta.raw.uniforms.find((q) => q.name === "uViewProjMatrix");
    if (!uViewProjMatrix || !progmeta.uModelMatrix) {
      console.error("[NpcOverlay] NPC program missing required uniforms");
      return null;
    }

    const arrowSize = size * tilesize;
    const arrowHeight = height * tilesize;

    const pos: number[] = [];
    const normals: number[] = [];
    const colors: number[] = [];
    const indices: number[] = [];

    // Cone (arrow head)
    const coneRadius = arrowSize * 0.6;
    const coneHeight = arrowSize * 1.5;
    const coneBaseY = arrowHeight;
    const coneTipY = arrowHeight - coneHeight;

    pos.push(0, coneTipY, 0);
    normals.push(0, -1, 0);
    colors.push(...colorTuple);

    for (let i = 0; i < segments; i++) {
      const angle = (i / segments) * Math.PI * 2;
      const x = Math.cos(angle) * coneRadius;
      const z = Math.sin(angle) * coneRadius;
      pos.push(x, coneBaseY, z);
      const nx = Math.cos(angle);
      const nz = Math.sin(angle);
      const ny = coneRadius / coneHeight;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      normals.push(nx / len, -ny / len, nz / len);
      colors.push(...colorTuple);
    }

    for (let i = 0; i < segments; i++) {
      // Front and back faces for double-sided rendering
      indices.push(0, 1 + i, 1 + ((i + 1) % segments));
      indices.push(0, 1 + ((i + 1) % segments), 1 + i);
    }

    const coneBaseCenterIdx = pos.length / 3;
    pos.push(0, coneBaseY, 0);
    normals.push(0, 1, 0);
    colors.push(...colorTuple);

    for (let i = 0; i < segments; i++) {
      // Double-sided cone base
      indices.push(coneBaseCenterIdx, 1 + ((i + 1) % segments), 1 + i);
      indices.push(coneBaseCenterIdx, 1 + i, 1 + ((i + 1) % segments));
    }

    // Cylinder (stem)
    const stemRadius = arrowSize * 0.2;
    const stemBottomY = coneBaseY;
    const stemTopY = arrowHeight + arrowSize * 0.8;
    const stemBottomStartIdx = pos.length / 3;

    for (let i = 0; i < segments; i++) {
      const angle = (i / segments) * Math.PI * 2;
      pos.push(Math.cos(angle) * stemRadius, stemBottomY, Math.sin(angle) * stemRadius);
      normals.push(Math.cos(angle), 0, Math.sin(angle));
      colors.push(...colorTuple);
    }

    const stemTopStartIdx = pos.length / 3;

    for (let i = 0; i < segments; i++) {
      const angle = (i / segments) * Math.PI * 2;
      pos.push(Math.cos(angle) * stemRadius, stemTopY, Math.sin(angle) * stemRadius);
      normals.push(Math.cos(angle), 0, Math.sin(angle));
      colors.push(...colorTuple);
    }

    for (let i = 0; i < segments; i++) {
      const next = (i + 1) % segments;
      const b0 = stemBottomStartIdx + i;
      const b1 = stemBottomStartIdx + next;
      const t0 = stemTopStartIdx + i;
      const t1 = stemTopStartIdx + next;
      // Double-sided cylinder
      indices.push(b0, b1, t1, b0, t1, t0);
      indices.push(b0, t1, b1, b0, t0, t1);
    }

    // Bottom cap for cylinder
    const bottomCapCenterIdx = pos.length / 3;
    pos.push(0, stemBottomY, 0);
    normals.push(0, -1, 0);
    colors.push(...colorTuple);

    for (let i = 0; i < segments; i++) {
      // Double-sided bottom cap
      indices.push(bottomCapCenterIdx, stemBottomStartIdx + ((i + 1) % segments), stemBottomStartIdx + i);
      indices.push(bottomCapCenterIdx, stemBottomStartIdx + i, stemBottomStartIdx + ((i + 1) % segments));
    }

    const topCapCenterIdx = pos.length / 3;
    pos.push(0, stemTopY, 0);
    normals.push(0, 1, 0);
    colors.push(...colorTuple);

    for (let i = 0; i < segments; i++) {
      // Double-sided top cap
      indices.push(topCapCenterIdx, stemTopStartIdx + i, stemTopStartIdx + ((i + 1) % segments));
      indices.push(topCapCenterIdx, stemTopStartIdx + ((i + 1) % segments), stemTopStartIdx + i);
    }

    const vertex = patchrs.native.createVertexArray(
      new Uint8Array(Uint16Array.from(indices).buffer),
      [
        { location: 0, buffer: new Uint8Array(Float32Array.from(pos).buffer), enabled: true, normalized: false, offset: 0, scalartype: GL_FLOAT, stride: 12, vectorlength: 3 },
        { location: 1, buffer: new Uint8Array(Float32Array.from(normals).buffer), enabled: true, normalized: false, offset: 0, scalartype: GL_FLOAT, stride: 12, vectorlength: 3 },
        { location: 6, buffer: Uint8Array.from(colors), enabled: true, normalized: true, offset: 0, scalartype: GL_UNSIGNED_BYTE, stride: 4, vectorlength: 4 },
      ]
    );

    const arrow3DShader = `
      #version 330 core
      layout (location = 0) in vec3 aPos;
      layout (location = 1) in vec3 aNormal;
      layout (location = 6) in vec4 aColor;
      uniform mat4 uViewProjMatrix;
      uniform mat4 uModelMatrix;
      out vec3 FragPos;
      out vec3 vNormal;
      out vec4 vColor;
      void main() {
        vec3 npcPos = vec3(uModelMatrix[3][0], uModelMatrix[3][1], uModelMatrix[3][2]);
        vec4 worldPos = vec4(npcPos + aPos, 1.0);
        gl_Position = uViewProjMatrix * worldPos;
        FragPos = worldPos.xyz;
        vNormal = aNormal;
        vColor = aColor;
      }
    `;

    const fragShader3DLit = `
      #version 330 core
      in vec3 FragPos;
      in vec3 vNormal;
      in vec4 vColor;
      uniform mat4 uSunlightViewMatrix;
      uniform vec3 uSunColour;
      uniform vec3 uAmbientColour;
      out vec4 FragColor;
      void main() {
        vec3 norm = normalize(vNormal);
        vec3 lightDir = normalize(-uSunlightViewMatrix[2].xyz);
        float diff = max(dot(norm, lightDir), 0.0);
        vec3 lighting = max(diff * uSunColour + uAmbientColour, vec3(0.3));
        FragColor = vec4(vColor.rgb * lighting, vColor.a);
      }
    `;

    const fragShader3DUnlit = `
      #version 330 core
      in vec3 FragPos;
      in vec3 vNormal;
      in vec4 vColor;
      out vec4 FragColor;
      void main() {
        FragColor = vColor;
      }
    `;

    const uSunlightViewMatrix = progmeta.raw.uniforms.find((q) => q.name === "uSunlightViewMatrix");
    const uSunColour = progmeta.raw.uniforms.find((q) => q.name === "uSunColour");
    const uAmbientColour = progmeta.raw.uniforms.find((q) => q.name === "uAmbientColour");
    const hasLighting = uSunlightViewMatrix && uSunColour && uAmbientColour;

    const uniforms: patchrs.GlUniformArgument[] = [
      { name: "uViewProjMatrix", length: 1, type: GL_FLOAT_MAT4, snapshotOffset: 0, snapshotSize: 64 },
      { name: "uModelMatrix", length: 1, type: GL_FLOAT_MAT4, snapshotOffset: 64, snapshotSize: 64 },
    ];
    const uniformSources: patchrs.OverlayUniformSource[] = [
      { name: "uViewProjMatrix", sourceName: uViewProjMatrix.name, type: "program" },
      { name: "uModelMatrix", sourceName: progmeta.uModelMatrix.name, type: "program" },
    ];

    if (hasLighting) {
      uniforms.push(
        { name: "uSunlightViewMatrix", length: 1, type: GL_FLOAT_MAT4, snapshotOffset: 128, snapshotSize: 64 },
        { name: "uSunColour", length: 1, type: GL_FLOAT_VEC3, snapshotOffset: 192, snapshotSize: 12 },
        { name: "uAmbientColour", length: 1, type: GL_FLOAT_VEC3, snapshotOffset: 204, snapshotSize: 12 }
      );
      uniformSources.push(
        { name: "uSunlightViewMatrix", sourceName: uSunlightViewMatrix.name, type: "program" },
        { name: "uSunColour", sourceName: uSunColour.name, type: "program" },
        { name: "uAmbientColour", sourceName: uAmbientColour.name, type: "program" }
      );
    }

    const program = patchrs.native.createProgram(
      arrow3DShader,
      hasLighting ? fragShader3DLit : fragShader3DUnlit,
      [
        { location: 0, name: "aPos", type: GL_FLOAT, length: 3 },
        { location: 1, name: "aNormal", type: GL_FLOAT, length: 3 },
        { location: 6, name: "aColor", type: GL_UNSIGNED_BYTE, length: 4 },
      ],
      uniforms
    );

    try {
      const handle = await patchrs.native.beginOverlay(
        { vertexObjectId: npc.vaoId },
        program,
        vertex,
        { uniformSources, renderMode: RENDER_MODE_TRIANGLES, trigger: "after" }
      );
      this.overlayHandles.push(handle);
      return handle;
    } catch (e) {
      console.error("[NpcOverlay] Failed to create 3D arrow overlay:", e);
      return null;
    }
  }

  async draw3DArrowsAboveAll(
    filter?: NpcFilter,
    options?: { color?: RGBA | [number, number, number, number]; size?: number; height?: number; segments?: number }
  ): Promise<patchrs.GlOverlay[]> {
    const npcs = await this.scan(filter);
    try {
      const handles: patchrs.GlOverlay[] = [];
      for (const npc of npcs) {
        const handle = await this.draw3DArrowAboveNpc(npc, options);
        if (handle !== null) handles.push(handle);
      }
      return handles;
    } finally {
      for (const npc of npcs) { try { npc.render?.dispose?.(); } catch (_) {} }
    }
  }

  async drawArrowsAboveAll(
    filter?: NpcFilter,
    options?: { color?: RGBA | [number, number, number, number]; size?: number; height?: number }
  ): Promise<patchrs.GlOverlay[]> {
    const npcs = await this.scan(filter);
    try {
      const handles: patchrs.GlOverlay[] = [];
      for (const npc of npcs) {
        const handle = await this.drawArrowAboveNpc(npc, options);
        if (handle !== null) handles.push(handle);
      }
      return handles;
    } finally {
      for (const npc of npcs) { try { npc.render?.dispose?.(); } catch (_) {} }
    }
  }

  async highlightAll(filter?: NpcFilter, options?: NpcOverlayOptions): Promise<patchrs.GlOverlay[]> {
    const npcs = await this.scan(filter);
    try {
      const handles: patchrs.GlOverlay[] = [];
      for (const npc of npcs) {
        const handle = await this.highlightNpc(npc, options);
        if (handle !== null) handles.push(handle);
      }
      return handles;
    } finally {
      for (const npc of npcs) { try { npc.render?.dispose?.(); } catch (_) {} }
    }
  }

  async highlightByVertexCount(vertexCount: number | number[], options?: NpcOverlayOptions): Promise<patchrs.GlOverlay[]> {
    const filter: NpcFilter = { excludeFloor: true };
    if (Array.isArray(vertexCount)) {
      filter.vertexCounts = vertexCount;
    } else {
      filter.vertexCount = vertexCount;
    }
    return this.highlightAll(filter, options);
  }

  /**
   * Find an NPC by hash - accumulates meshes across frames then computes hash.
   * Required for NPCs like Death with 35 meshes where combined hash needs all parts.
   */
  private async findByHashStreaming(targetHashNum: number, maxFrames: number = 15): Promise<{ mesh: NpcMesh; group: NpcMeshGroup } | null> {
    const { extractBufferHashes, computeCombinedHash } = await import("./npcBufferHash");

    // Accumulate meshes at each position across frames (key: posKey, value: vaoId -> render)
    const positionMeshes = new Map<string, Map<number, patchrs.RenderInvocation>>();
    // Track all frame renders for disposal (includes both stored and filtered-out renders)
    const allFrameRenders: patchrs.RenderInvocation[][] = [];
    let framesWithNoNew = 0;

    for (let frame = 0; frame < maxFrames; frame++) {
      if (frame > 0) await new Promise(r => setTimeout(r, 60));

      const renders = await captureWithStreamPause(() => patchrs.native.recordRenderCalls({ maxframes: 1, features: ["vertexarray", "uniforms"] }));
      allFrameRenders.push(renders);
      let newMeshes = 0;

      for (const render of renders) {
        const progmeta = getProgramMeta(render.program);
        if (progmeta.isUi || progmeta.isFloor || !progmeta.uModelMatrix) continue;
        if (!progmeta.uBones) continue;

        const rotmatrix = getUniformValue(render.uniformState, progmeta.uModelMatrix)[0] as number[];
        const posKey = `${Math.round(rotmatrix[12] / tilesize * 10)},${Math.round(rotmatrix[14] / tilesize * 10)}`;

        if (!positionMeshes.has(posKey)) positionMeshes.set(posKey, new Map());
        const meshMap = positionMeshes.get(posKey)!;
        if (!meshMap.has(render.vertexObjectId)) {
          meshMap.set(render.vertexObjectId, render);
          newMeshes++;
        }
      }

      if (newMeshes === 0) {
        if (++framesWithNoNew >= 3) break;
      } else {
        framesWithNoNew = 0;
      }
    }

    try {
      for (const [posKey, meshMap] of positionMeshes) {
        const groupRenders = Array.from(meshMap.values());
        const combined = computeCombinedHash(groupRenders);

        if (combined.num === targetHashNum) {
          return this.buildGroupFromRenders(groupRenders);
        }

        for (const render of groupRenders) {
          if (extractBufferHashes(render).posBufferHashNum === targetHashNum) {
            return this.buildGroupFromRenders(groupRenders);
          }
        }
      }

      return null;
    } finally {
      // Dispose all render invocations from all frames to free native GPU memory
      for (const frameRenders of allFrameRenders) {
        for (const r of frameRenders) { try { r.dispose?.(); } catch (_) {} }
      }
    }
  }

  /**
   * Build an NpcMeshGroup from render invocations (helper for streaming search)
   */
  private buildGroupFromRenders(renders: patchrs.RenderInvocation[]): { mesh: NpcMesh; group: NpcMeshGroup } {
    const meshes: NpcMesh[] = [];
    let mainMesh: NpcMesh | null = null;

    for (const render of renders) {
      const progmeta = getProgramMeta(render.program);
      const vertexCount = render.vertexArray.indexBuffer?.length || 0;
      const rotmatrix = getUniformValue(render.uniformState, progmeta.uModelMatrix!)[0] as number[];
      const modelMatrix = new Matrix4().fromArray(rotmatrix);

      const mesh: NpcMesh = {
        vaoId: render.vertexObjectId,
        programId: render.program.programId,
        vertexCount,
        position: {
          x: rotmatrix[12] / tilesize,
          y: rotmatrix[13] / tilesize,
          z: rotmatrix[14] / tilesize,
        },
        rotation: -Math.atan2(rotmatrix[8], rotmatrix[0]),
        modelMatrix,
        hasBones: !!progmeta.uBones,
        render,
        progmeta,
        framebufferId: render.framebufferId,
      };

      meshes.push(mesh);

      // Track main mesh (with bones, or largest)
      if (progmeta.uBones && progmeta.isMainMesh) {
        if (!mainMesh || vertexCount > mainMesh.vertexCount) {
          mainMesh = mesh;
        }
      }
    }

    // Deduplicate meshes by position buffer hash
    const seenMeshHashes = new Set<number>();
    const uniqueMeshes: NpcMesh[] = [];
    const uniqueRenders: patchrs.RenderInvocation[] = [];
    for (let i = 0; i < meshes.length; i++) {
      const mesh = meshes[i];
      const hashes = extractBufferHashes(mesh.render);
      if (hashes.posBufferHashNum === 0 || !seenMeshHashes.has(hashes.posBufferHashNum)) {
        if (hashes.posBufferHashNum !== 0) {
          seenMeshHashes.add(hashes.posBufferHashNum);
        }
        uniqueMeshes.push(mesh);
        uniqueRenders.push(renders[i]);
      }
    }

    // Fallback to largest mesh if no bones found
    if (!mainMesh || !uniqueMeshes.includes(mainMesh)) {
      mainMesh = uniqueMeshes.find(m => m.hasBones && m.progmeta.isMainMesh) ||
                 uniqueMeshes.reduce((a, b) => a.vertexCount > b.vertexCount ? a : b);
    }

    const totalVertexCount = uniqueMeshes.reduce((sum, m) => sum + m.vertexCount, 0);

    const group: NpcMeshGroup = {
      mainMesh,
      allMeshes: uniqueMeshes,
      renders: uniqueRenders,
      totalVertexCount,
      meshCount: uniqueMeshes.length,
      position: mainMesh.position,
      modelMatrix: mainMesh.modelMatrix,
      framebufferId: mainMesh.framebufferId,
    };

    return { mesh: mainMesh, group };
  }

  /**
   * Scan for an NPC with a specific buffer hash and highlight it
   * Uses streaming search to avoid memory exhaustion on large NPCs like Death (2.5M vertices)
   * @param bufferHash The position buffer hash as hex string (e.g., "0x1A2B3C4D")
   * @param options Highlight options
   * @returns The overlay handle if found and highlighted, null otherwise
   */
  async highlightByBufferHash(bufferHash: string, options?: NpcOverlayOptions): Promise<{ handle: patchrs.GlOverlay | null; npc: NpcMesh | null; group: NpcMeshGroup | null }> {
    const { fromHexHash, computeCombinedHash } = await import("./npcBufferHash");

    // Parse target hash to number for fast comparison
    const targetHashNum = fromHexHash(bufferHash);

    // Use single-frame scan (same as scan all NPCs)
    const groups = await this.scanGrouped({
      excludeFloor: true,
      // maxMeshCount defaults to 15 - groups with >15 meshes filtered unless they have bones
    });

    try {
      // Search for matching combined hash
      for (const group of groups) {
        const combined = computeCombinedHash(group.renders);
        if (combined.num === targetHashNum) {
          const handle = await this.highlightNpc(group.mainMesh, options);
          return { handle, npc: group.mainMesh, group };
        }
      }

      return { handle: null, npc: null, group: null };
    } finally {
      for (const group of groups) {
        for (const r of group.renders) { try { (r as any).dispose?.(); } catch (_) {} }
      }
    }
  }

  /**
   * Get cached VAO info for a buffer hash (fast lookup, no scanning)
   * Returns null if not in cache or cache expired
   * @param bufferHash The buffer hash to look up
   */
  getCachedVaoInfo(bufferHash: string): { vaoId: number; framebufferId: number } | null {
    const cached = this.vaoCache.get(bufferHash);
    if (!cached) return null;

    // Check if cache entry is still valid
    if (Date.now() - cached.timestamp > this.VAO_CACHE_TTL) {
      this.vaoCache.delete(bufferHash);
      return null;
    }

    return { vaoId: cached.vaoId, framebufferId: cached.framebufferId };
  }

  /**
   * Update the VAO cache with new info
   * @param bufferHash The buffer hash
   * @param vaoId The VAO ID
   * @param framebufferId The framebuffer ID
   */
  updateVaoCache(bufferHash: string, vaoId: number, framebufferId: number): void {
    this.vaoCache.set(bufferHash, { vaoId, framebufferId, timestamp: Date.now() });
  }

  /**
   * Clear the VAO cache (call when NPCs may have changed, e.g., area transition)
   */
  clearVaoCache(): void {
    this.vaoCache.clear();
  }

  /**
   * Scan for an NPC with a specific buffer hash and draw an arrow above it
   * Uses single-frame scan (same as scan all NPCs)
   * @param bufferHash The position buffer hash as hex string (e.g., "0x1A2B3C4D")
   * @param options Rendering options for the arrow
   * @param filter Optional filter including playerPosition for distance-based optimization
   */
  async arrowByBufferHash(
    bufferHash: string,
    options?: { color?: RGBA | [number, number, number, number]; size?: number; height?: number },
    filter?: Pick<NpcFilter, 'playerPosition' | 'maxDistanceFromPlayer'>
  ): Promise<{ handle: patchrs.GlOverlay | null; npc: NpcMesh | null; group: NpcMeshGroup | null }> {
    const { fromHexHash, computeCombinedHash } = await import("./npcBufferHash");

    // Parse target hash to number for fast comparison
    const targetHashNum = fromHexHash(bufferHash);

    // Use single-frame scan with optional position filtering
    const groups = await this.scanGrouped({
      excludeFloor: true,
      // maxMeshCount defaults to 15 - groups with >15 meshes filtered unless they have bones
      playerPosition: filter?.playerPosition,
      maxDistanceFromPlayer: filter?.maxDistanceFromPlayer,
    });

    try {
      for (const group of groups) {
        const combined = computeCombinedHash(group.renders);
        if (combined.num === targetHashNum) {
          this.updateVaoCache(bufferHash, group.mainMesh.vaoId, group.mainMesh.framebufferId);
          const handle = await this.draw3DArrowAboveNpc(group.mainMesh, options);
          return { handle, npc: group.mainMesh, group };
        }
      }

      if (groups.length > 0) {
        const hashes = groups.map(g => computeCombinedHash(g.renders).hex).slice(0, 5);
        console.log(`[NpcOverlay] No match for ${bufferHash} among ${groups.length} groups. Nearby hashes: ${hashes.join(', ')}`);
      }

      return { handle: null, npc: null, group: null };
    } finally {
      for (const group of groups) {
        for (const r of group.renders) { try { (r as any).dispose?.(); } catch (_) {} }
      }
    }
  }

  /**
   * Match a buffer hash against pre-scanned groups and draw arrow if found.
   * Used to share ONE recording across multiple NPC lookups (avoids per-NPC frame captures).
   */
  async arrowByBufferHashFromGroups(
    bufferHash: string,
    groups: NpcMeshGroup[],
    options?: { color?: RGBA | [number, number, number, number]; size?: number; height?: number },
  ): Promise<{ handle: patchrs.GlOverlay | null; npc: NpcMesh | null; group: NpcMeshGroup | null }> {
    const { fromHexHash, computeCombinedHash } = await import("./npcBufferHash");
    const targetHashNum = fromHexHash(bufferHash);

    for (const group of groups) {
      const combined = computeCombinedHash(group.renders);
      if (combined.num === targetHashNum) {
        this.updateVaoCache(bufferHash, group.mainMesh.vaoId, group.mainMesh.framebufferId);
        const handle = await this.draw3DArrowAboveNpc(group.mainMesh, options);
        return { handle, npc: group.mainMesh, group };
      }
    }

    // Log nearest misses to help identify stale DB hashes
    if (groups.length > 0) {
      const hashes = groups.map(g => computeCombinedHash(g.renders).hex).slice(0, 5);
      console.log(`[NpcOverlay] No match for ${bufferHash} among ${groups.length} groups. Nearby hashes: ${hashes.join(', ')}`);
    }

    return { handle: null, npc: null, group: null };
  }

  /**
   * Filter groups by NPC location, then hash match within that subset.
   * Position narrows the search (only hash nearby meshes), hash identifies the exact NPC.
   * Returns the hash-matched NPC if found, or the closest animated mesh as fallback.
   */
  async findNpcByLocationThenHash(
    groups: NpcMeshGroup[],
    targetX: number,
    targetZ: number,
    maxDistance: number = 5,
    bufferHashes: string[] = [],
  ): Promise<{ npc: NpcMesh | null; group: NpcMeshGroup | null; hashMatched: boolean }> {
    const TILESIZE = 512;
    const { fromHexHash, computeCombinedHash } = await import("./npcBufferHash");

    const targetHashNums = bufferHashes.map(h => fromHexHash(h));

    // Filter groups by proximity to NPC's known location — only hash these
    const nearby: { group: NpcMeshGroup; dist: number }[] = [];

    for (const group of groups) {
      const mainMesh = group.mainMesh;
      if (!mainMesh || !mainMesh.hasBones) continue;

      const npcX = Math.round(mainMesh.position.x / TILESIZE) - 2;
      const npcZ = Math.round(mainMesh.position.z / TILESIZE) - 1;

      const dx = npcX - targetX;
      const dz = npcZ - targetZ;
      const dist = Math.sqrt(dx * dx + dz * dz);

      if (dist <= maxDistance) {
        nearby.push({ group, dist });
      }
    }

    if (nearby.length === 0) return { npc: null, group: null, hashMatched: false };

    // Hash only nearby groups — much fewer than the full scene
    for (const { group } of nearby) {
      try {
        const combined = computeCombinedHash(group.renders);
        if (targetHashNums.some(h => h === combined.num)) {
          console.log(`[NpcOverlay] Location+Hash match at (${targetX},${targetZ}): hash=${combined.hex} from ${nearby.length} nearby groups`);
          this.updateVaoCache(bufferHashes[0], group.mainMesh.vaoId, group.mainMesh.framebufferId);
          return { npc: group.mainMesh, group, hashMatched: true };
        }
      } catch {}
    }

    // Hash didn't match any nearby group — log what we found for DB updates
    const nearbyHashes = nearby.map(({ group }) => {
      try { return computeCombinedHash(group.renders).hex; } catch { return "?"; }
    });
    console.log(`[NpcOverlay] No hash match near (${targetX},${targetZ}). ${nearby.length} nearby groups, hashes: ${nearbyHashes.join(", ")}`);

    // Fallback: return closest animated mesh (position-only match)
    nearby.sort((a, b) => a.dist - b.dist);
    return { npc: nearby[0].group.mainMesh, group: nearby[0].group, hashMatched: false };
  }

  /**
   * Find the player's position using the known player buffer hash.
   * This helps identify where the player is on the map for accurate NPC positioning.
   *
   * @param playerHash Optional custom player hash. If not provided, uses PLAYER_BUFFER_HASH constant.
   * @returns Player position and mesh group if found, null otherwise
   */
  async findPlayer(playerHash?: string): Promise<{
    position: { x: number; y: number; z: number };
    group: NpcMeshGroup;
    combinedHash: string;
  } | null> {
    const { fromHexHash, computeCombinedHash } = await import("./npcBufferHash");

    const hashToFind = playerHash ?? PLAYER_BUFFER_HASH;

    // Don't search if using placeholder hash
    if (hashToFind === "0x00000000") {
      return null;
    }

    const targetHashNum = fromHexHash(hashToFind);

    // Use single-frame scan
    const groups = await this.scanGrouped({
      excludeFloor: true,
    });

    try {
      for (const group of groups) {
        const combined = computeCombinedHash(group.renders);
        if (combined.num === targetHashNum) {
          return {
            position: group.position,
            group,
            combinedHash: combined.hex,
          };
        }
      }

      return null;
    } finally {
      for (const group of groups) {
        for (const r of group.renders) { try { (r as any).dispose?.(); } catch (_) {} }
      }
    }
  }

  /**
   * Scan all NPCs and return them with positions relative to the player.
   * Useful for mapping NPC locations when the player's position is known.
   *
   * @param playerHash Optional custom player hash
   * @returns Object with player position, all NPCs, and relative positions
   */
  async scanWithPlayerReference(playerHash?: string): Promise<{
    player: { position: { x: number; y: number; z: number }; group: NpcMeshGroup } | null;
    npcs: Array<{
      group: NpcMeshGroup;
      combinedHash: string;
      relativePosition: { x: number; y: number; z: number } | null;
    }>;
  }> {
    const { computeCombinedHash, fromHexHash } = await import("./npcBufferHash");

    const hashToFind = playerHash ?? PLAYER_BUFFER_HASH;
    const targetHashNum = hashToFind !== "0x00000000" ? fromHexHash(hashToFind) : 0;

    const groups = await this.scanGrouped({
      excludeFloor: true,
    });

    try {
      let playerData: { position: { x: number; y: number; z: number }; group: NpcMeshGroup } | null = null;
      const npcs: Array<{
        group: NpcMeshGroup;
        combinedHash: string;
        relativePosition: { x: number; y: number; z: number } | null;
      }> = [];

      // First pass: find player and collect all NPCs
      for (const group of groups) {
        const combined = computeCombinedHash(group.renders);

        // Check if this is the player
        if (targetHashNum !== 0 && combined.num === targetHashNum) {
          playerData = {
            position: group.position,
            group,
          };
        }

        npcs.push({
          group,
          combinedHash: combined.hex,
          relativePosition: null, // Will be calculated after finding player
        });
      }

      // Second pass: calculate relative positions if player was found
      if (playerData) {
        for (const npc of npcs) {
          npc.relativePosition = {
            x: npc.group.position.x - playerData.position.x,
            y: npc.group.position.y - playerData.position.y,
            z: npc.group.position.z - playerData.position.z,
          };
        }
      }

      return { player: playerData, npcs };
    } finally {
      for (const group of groups) {
        for (const r of group.renders) { try { (r as any).dispose?.(); } catch (_) {} }
      }
    }
  }

  async getVertexCountStats(): Promise<Map<number, number>> {
    const npcs = await this.scan({ excludeFloor: true });
    try {
      const counts = new Map<number, number>();
      for (const npc of npcs) {
        counts.set(npc.vertexCount, (counts.get(npc.vertexCount) || 0) + 1);
      }
      return counts;
    } finally {
      for (const npc of npcs) { try { npc.render?.dispose?.(); } catch (_) {} }
    }
  }

  captureTexture(npc: NpcMesh, textureIndex: number = 0): ImageData | null {
    if (!npc.textures || npc.textures.length === 0) return null;
    if (textureIndex >= npc.textures.length) return null;
    const tex = npc.textures[textureIndex];
    if (!tex.snapshot.canCapture()) return null;
    try {
      return tex.snapshot.capture(0, 0, tex.width, tex.height);
    } catch {
      return null;
    }
  }

  captureAllTextures(npc: NpcMesh): { index: number; samplerId: number; texId: number; width: number; height: number; imageData: ImageData }[] {
    const results: { index: number; samplerId: number; texId: number; width: number; height: number; imageData: ImageData }[] = [];
    if (!npc.textures || npc.textures.length === 0) return results;

    for (let i = 0; i < npc.textures.length; i++) {
      const tex = npc.textures[i];
      if (tex.snapshot.canCapture()) {
        try {
          results.push({
            index: i,
            samplerId: tex.samplerId,
            texId: tex.texId,
            width: tex.width,
            height: tex.height,
            imageData: tex.snapshot.capture(0, 0, tex.width, tex.height),
          });
        } catch {
          // skip
        }
      }
    }
    return results;
  }

  async scanWithTextures(filter?: Omit<NpcFilter, "includeTextures">): Promise<NpcMesh[]> {
    return this.scan({ ...filter, includeTextures: true });
  }

  async stop(handle: patchrs.GlOverlay): Promise<void> {
    try {
      handle.stop();
      const idx = this.overlayHandles.indexOf(handle);
      if (idx !== -1) this.overlayHandles.splice(idx, 1);
    } catch {
      // ignore
    }
  }

  async stopAll(): Promise<void> {
    for (const handle of this.overlayHandles) {
      try {
        handle.stop();
      } catch (e) {
        console.error(`[NpcOverlay] Failed to stop overlay:`, e);
      }
    }
    this.overlayHandles = [];

    // Clean up GL resources to prevent memory exhaustion
    try {
      await patchrs.native.debug.resetOpenGlState();
    } catch {
      // Ignore cleanup errors
    }
  }

  getActiveCount(): number {
    return this.overlayHandles.length;
  }

  /**
   * Get shared memory status to monitor for exhaustion.
   * Disconnect happens when 512MB is nearly full.
   */
  getMemoryStatus(): { used: number; size: number; free: number; pctUsed: number; warning: boolean } | null {
    const memState = patchrs.native.debug.memoryState();
    if (!memState) return null;
    const pctUsed = (memState.used / memState.size) * 100;
    return {
      used: memState.used,
      size: memState.size,
      free: memState.free,
      pctUsed,
      warning: pctUsed > 80,
    };
  }

  /**
   * Log detailed memory status for debugging disconnects.
   */
  logMemoryStatus(): void {
    // Method kept for compatibility but logging removed for performance
  }

  /**
   * Debug function: Dump ALL meshes without filtering to find "hidden" NPCs like Death.
   * This captures everything with a model matrix and logs detailed info about each mesh.
   */
  async debugDumpAllMeshes(): Promise<void> {
    const renders = await captureWithStreamPause(() => patchrs.native.recordRenderCalls({ maxframes: 1, features: ["vertexarray", "uniforms"] }));

    const meshes: Array<{
      vaoId: number;
      verts: number;
      x: number;
      y: number;
      z: number;
      isMainMesh: boolean;
      isTinted: boolean;
      hasBones: boolean;
      isLighted: boolean;
      isFloor: boolean;
      isUi: boolean;
      isParticles: boolean;
      isShadow: boolean;
      fragDefines: string[];
    }> = [];

    for (const render of renders) {
      const progmeta = getProgramMeta(render.program);

      // Skip only UI - we want to see EVERYTHING else
      if (progmeta.isUi) continue;
      if (!progmeta.uModelMatrix) continue;

      const vertexCount = render.vertexArray.indexBuffer?.length || 0;
      if (vertexCount === 0) continue;

      const rotmatrix = getUniformValue(render.uniformState, progmeta.uModelMatrix)[0] as number[];
      const x = Math.round(rotmatrix[12] / tilesize * 10) / 10;
      const y = Math.round(rotmatrix[13] / tilesize * 10) / 10;
      const z = Math.round(rotmatrix[14] / tilesize * 10) / 10;

      meshes.push({
        vaoId: render.vertexObjectId,
        verts: vertexCount,
        x, y, z,
        isMainMesh: progmeta.isMainMesh,
        isTinted: progmeta.isTinted,
        hasBones: !!progmeta.uBones,
        isLighted: progmeta.isLighted,
        isFloor: progmeta.isFloor,
        isUi: progmeta.isUi,
        isParticles: progmeta.isParticles,
        isShadow: progmeta.isShadowRender,
        fragDefines: progmeta.fragdefines.slice(0, 5),
      });
    }

    // Sort by vertex count descending
    meshes.sort((a, b) => b.verts - a.verts);

    // Group by approximate position to find entities
    const posGroups = new Map<string, typeof meshes>();
    for (const m of meshes) {
      const key = `${Math.round(m.x)},${Math.round(m.z)}`;
      if (!posGroups.has(key)) posGroups.set(key, []);
      posGroups.get(key)!.push(m);
    }
  }

  /**
   * Scan ALL meshes without filtering - returns NpcMeshGroups that can be viewed in catalog.
   * Use this to find NPCs like Death that get filtered out by normal scans.
   * Note: Still skips floor to prevent memory exhaustion, but accepts everything else.
   */
  async scanAllUnfiltered(): Promise<NpcMeshGroup[]> {
    // NOTE: Removed "textures" - TextureSnapshots are massive memory hogs (can grow to 500MB+)
    const renders = await captureWithStreamPause(() => patchrs.native.recordRenderCalls({ maxframes: 1, features: ["vertexarray", "uniforms"] }));

    // Group by position (same logic as scanGroupedFromRenders but minimal filtering)
    const tolerance = 0.15;
    const groups = new Map<string, { meshes: NpcMesh[]; renders: patchrs.RenderInvocation[]; matrix: Matrix4; centroid: { x: number; y: number; z: number } }>();

    let skippedFloor = 0;
    let skippedUi = 0;

    for (const render of renders) {
      const progmeta = getProgramMeta(render.program);

      // Skip UI
      if (progmeta.isUi) { skippedUi++; continue; }
      if (!progmeta.uModelMatrix) continue;

      // Skip floor to prevent memory exhaustion (floor tiles are massive)
      if (progmeta.isFloor) { skippedFloor++; continue; }

      const vertexCount = render.vertexArray.indexBuffer?.length || 0;
      if (vertexCount === 0) continue;

      const rotmatrix = getUniformValue(render.uniformState, progmeta.uModelMatrix)[0] as number[];
      const x = rotmatrix[12] / tilesize - 1.5;
      const y = rotmatrix[13] / tilesize;
      const z = rotmatrix[14] / tilesize - 0.5;
      const yRotation = -Math.atan2(rotmatrix[8], rotmatrix[0]);

      const modelMatrix = new Matrix4().fromArray(rotmatrix);

      // Round position for grouping
      const roundedX = Math.round(x / tolerance) * tolerance;
      const roundedZ = Math.round(z / tolerance) * tolerance;
      const groupKey = `${roundedX.toFixed(2)},${roundedZ.toFixed(2)}`;

      const mesh: NpcMesh = {
        render,
        vaoId: render.vertexObjectId,
        programId: render.program.programId,
        vertexCount,
        position: { x, y, z },
        rotation: yRotation,
        modelMatrix,
        hasBones: !!progmeta.uBones,
        progmeta,
        framebufferId: render.framebufferId,
      };

      if (!groups.has(groupKey)) {
        groups.set(groupKey, {
          meshes: [],
          renders: [],
          matrix: modelMatrix,
          centroid: { x, y, z },
        });
      }

      const group = groups.get(groupKey)!;
      group.meshes.push(mesh);
      group.renders.push(render);
    }

    // Convert to NpcMeshGroup array
    const result: NpcMeshGroup[] = [];
    for (const [key, group] of groups) {
      // Deduplicate meshes within this group by position buffer hash
      const seenMeshHashes = new Set<number>();
      const uniqueMeshes: NpcMesh[] = [];
      const uniqueRenders: patchrs.RenderInvocation[] = [];
      for (let i = 0; i < group.meshes.length; i++) {
        const mesh = group.meshes[i];
        const hashes = extractBufferHashes(mesh.render);
        if (hashes.posBufferHashNum === 0 || !seenMeshHashes.has(hashes.posBufferHashNum)) {
          if (hashes.posBufferHashNum !== 0) {
            seenMeshHashes.add(hashes.posBufferHashNum);
          }
          uniqueMeshes.push(mesh);
          uniqueRenders.push(group.renders[i]);
        }
      }

      // Sort meshes by vertex count descending
      uniqueMeshes.sort((a, b) => b.vertexCount - a.vertexCount);

      // Main mesh is the largest one
      const mainMesh = uniqueMeshes[0];
      const totalVertexCount = uniqueMeshes.reduce((sum, m) => sum + m.vertexCount, 0);

      result.push({
        mainMesh,
        allMeshes: uniqueMeshes,
        renders: uniqueRenders,
        totalVertexCount,
        meshCount: uniqueMeshes.length,
        position: group.centroid,
        modelMatrix: group.matrix,
        framebufferId: mainMesh.framebufferId,
      });
    }

    // Sort by total vertex count descending
    result.sort((a, b) => b.totalVertexCount - a.totalVertexCount);

    // Limit to top 50 groups to prevent memory exhaustion when browsing
    const maxGroups = 50;
    const limitedResult = result.slice(0, maxGroups);

    return limitedResult;
  }

  /**
   * Lightweight scan to get VAO IDs of NPC-like renders.
   * Uses minimal memory by NOT capturing vertex arrays or textures.
   * Still applies proper NPC filtering using program metadata (isUi, isFloor, etc.)
   *
   * Ideal for visibility checking where we just need to know which NPC VAOs exist.
   *
   * @param vaoIds Optional set of VAO IDs to check for - if provided, only returns matches from these
   * @returns Set of VAO IDs that are currently being rendered as NPC-like entities
   */
  async scanRenderedVaoIds(vaoIds?: Set<number>): Promise<Set<number>> {
    // Use features: [] to avoid capturing heavy vertex arrays and textures
    // We still get render.program which allows us to filter by program metadata
    const renders = await captureWithStreamPause(() => patchrs.native.recordRenderCalls({
      maxframes: 1,
      features: [],  // Minimal - no vertex arrays, no uniforms, no textures
    }));

    const renderedVaoIds = new Set<number>();

    for (const render of renders) {
      // Apply the same filtering as scanGroupedFromRenders using program metadata
      // (getProgramMeta only needs render.program, not vertex arrays or uniforms)
      const progmeta = getProgramMeta(render.program);

      // Skip UI and floor
      if (progmeta.isUi) {
        render.dispose?.();
        continue;
      }
      if (progmeta.isFloor) {
        render.dispose?.();
        continue;
      }
      // Skip shadow pass renders
      if (progmeta.isShadowRender) {
        render.dispose?.();
        continue;
      }
      // Skip if no model matrix (not a 3D object)
      if (!progmeta.uModelMatrix) {
        render.dispose?.();
        continue;
      }
      // Filter: Must have bones (animated mesh)
      if (!progmeta.uBones) {
        render.dispose?.();
        continue;
      }

      // If we're looking for specific VAOs, only include those
      if (vaoIds) {
        if (vaoIds.has(render.vertexObjectId)) {
          renderedVaoIds.add(render.vertexObjectId);
        }
      } else {
        renderedVaoIds.add(render.vertexObjectId);
      }

      // Clean up render data to free memory immediately
      render.dispose?.();
    }

    return renderedVaoIds;
  }

  /**
   * Lightweight scan that returns VAO IDs along with their current framebuffer IDs.
   * Use this to detect when an NPC's framebuffer has changed (e.g., game switched render targets).
   *
   * @param vaoIds Optional set of VAO IDs to check for - if provided, only returns matches from these
   * @returns Map of VAO ID to framebuffer ID for currently rendered NPC-like entities
   */
  async scanRenderedVaoIdsWithFramebuffers(vaoIds?: Set<number>): Promise<Map<number, number>> {
    // Use features: [] to avoid capturing heavy vertex arrays and textures
    const renders = await captureWithStreamPause(() => patchrs.native.recordRenderCalls({
      maxframes: 1,
      features: [],  // Minimal - no vertex arrays, no uniforms, no textures
    }));

    const result = new Map<number, number>();

    for (const render of renders) {
      const progmeta = getProgramMeta(render.program);

      // Skip UI and floor
      if (progmeta.isUi) {
        render.dispose?.();
        continue;
      }
      if (progmeta.isFloor) {
        render.dispose?.();
        continue;
      }
      // Skip shadow pass renders
      if (progmeta.isShadowRender) {
        render.dispose?.();
        continue;
      }
      // Skip if no model matrix (not a 3D object)
      if (!progmeta.uModelMatrix) {
        render.dispose?.();
        continue;
      }
      // Filter: Must have bones (animated mesh)
      if (!progmeta.uBones) {
        render.dispose?.();
        continue;
      }

      // If we're looking for specific VAOs, only include those
      if (vaoIds) {
        if (vaoIds.has(render.vertexObjectId)) {
          result.set(render.vertexObjectId, render.framebufferId ?? 0);
        }
      } else {
        result.set(render.vertexObjectId, render.framebufferId ?? 0);
      }

      // Clean up render data to free memory immediately
      render.dispose?.();
    }

    return result;
  }

  /**
   * Check if specific VAO IDs are currently being rendered as NPC-like entities.
   * Uses same filtering as full NPC scan but with minimal memory overhead.
   *
   * @param vaoIds Set of VAO IDs to check
   * @returns Map of VAO ID to whether it's currently rendered
   */
  async checkVaoVisibility(vaoIds: Set<number>): Promise<Map<number, boolean>> {
    const result = new Map<number, boolean>();

    // Initialize all as not visible
    for (const id of vaoIds) {
      result.set(id, false);
    }

    if (vaoIds.size === 0) return result;

    // Use the filtered scan
    const renderedVaoIds = await this.scanRenderedVaoIds(vaoIds);

    for (const vaoId of renderedVaoIds) {
      result.set(vaoId, true);
    }

    return result;
  }
}
