/**
 * PlayerPositionTracker - Lightweight player position detection
 *
 * Finds player via occlusion mesh (tinted, animated mesh) and uses
 * camera target to disambiguate player from NPCs.
 *
 * Usage:
 *   const tracker = new PlayerPositionTracker();
 *   const pos = await tracker.getPosition();
 *   if (pos) console.log(`Player at (${pos.x.toFixed(1)}, ${pos.z.toFixed(1)})`);
 */

import * as patchrs from "./patchrs_napi";
import { getProgramMeta, getUniformValue } from "../render/renderprogram";
// SharedRenderStream removed — continuous streaming exhausts the 512MB shared memory heap.
// PassivePlayerTracker now polls with one-shot recordRenderCalls instead.

const TILESIZE = 512;

/** Player position in tile coordinates */
export interface PlayerPosition {
  x: number;
  y: number;
  z: number;
  rotation: number;
  vaoId: number;
  programId: number;
}

/** Camera information */
export interface CameraInfo {
  x: number;
  y: number;
  z: number;
  targetX: number;
  targetZ: number;
  /** Camera yaw in radians (0 = north, increases clockwise) */
  yaw: number;
}

/**
 * Lightweight player position tracker
 */
export class PlayerPositionTracker {
  private debug: boolean;
  private cachedMesh: { vaoId: number; programId: number; timestamp: number } | null = null;
  private cacheTimeout: number;

  constructor(options: { debug?: boolean; cacheTimeout?: number } = {}) {
    this.debug = options.debug ?? false;
    this.cacheTimeout = options.cacheTimeout ?? 30000;
  }

  /**
   * Get current player position (one-shot capture)
   */
  async getPosition(): Promise<PlayerPosition | null> {
    let renders: any[] = [];
    try {
      renders = await patchrs.native.recordRenderCalls({ maxframes: 1,
        features: ["vertexarray", "uniforms"],
      });
      return this.findPlayer(renders);
    } catch (e) {
      if (this.debug) console.error("[PlayerPosition] Capture error:", e);
      return null;
    } finally {
      for (const r of renders) {
        try { r.dispose?.(); } catch (_) {}
      }
    }
  }

  /**
   * Find player from pre-captured renders
   */
  findPlayer(renders: patchrs.RenderInvocation[]): PlayerPosition | null {
    // Try fast path first if we have a cached mesh
    if (this.cachedMesh && Date.now() - this.cachedMesh.timestamp < this.cacheTimeout) {
      const cached = this.findCachedMesh(renders);
      if (cached) return cached;
    }

    // Full scan for player
    return this.scanForPlayer(renders);
  }

  /**
   * Fast path: find position from cached VAO/program
   */
  private findCachedMesh(renders: patchrs.RenderInvocation[]): PlayerPosition | null {
    if (!this.cachedMesh) return null;

    for (const render of renders) {
      if (render.vertexObjectId !== this.cachedMesh.vaoId) continue;
      if (render.program?.programId !== this.cachedMesh.programId) continue;

      try {
        const progmeta = getProgramMeta(render.program);
        if (!progmeta.uModelMatrix) continue;

        const matrix = getUniformValue(render.uniformState, progmeta.uModelMatrix)[0] as number[];
        if (!matrix || matrix.length < 16) continue;

        const x = Math.round(matrix[12] / TILESIZE) - 2;
        const y = matrix[13] / TILESIZE;
        const z = Math.round(matrix[14] / TILESIZE) - 1;

        if (x === 0 && z === 0) continue;

        return {
          x, y, z,
          rotation: Math.atan2(-matrix[8], matrix[0]),
          vaoId: render.vertexObjectId,
          programId: render.program.programId,
        };
      } catch {
        continue;
      }
    }

    // Cache miss - clear it
    this.cachedMesh = null;
    return null;
  }

  /**
   * Full scan: find player occlusion mesh
   */
  private scanForPlayer(renders: patchrs.RenderInvocation[]): PlayerPosition | null {
    interface Candidate {
      x: number; y: number; z: number;
      rotation: number;
      vaoId: number;
      programId: number;
      tintAlpha: number;
      distFromCamera?: number;
    }

    const candidates: Candidate[] = [];

    for (const render of renders) {
      if (!render.program || !render.uniformState) continue;

      // Need shader sources
      const hasFrag = typeof render.program.fragmentShader?.source === 'string';
      const hasVert = typeof render.program.vertexShader?.source === 'string';
      if (!hasFrag || !hasVert) continue;

      let progmeta;
      try {
        progmeta = getProgramMeta(render.program);
      } catch {
        continue;
      }

      // Must be tinted and animated (player has bones, highlights don't)
      if (!progmeta.isTinted || !progmeta.uTint || !progmeta.uModelMatrix) continue;
      if (!progmeta.isAnimated) continue;

      try {
        const tint = getUniformValue(render.uniformState, progmeta.uTint)[0] as number[];
        if (!tint || tint.length < 4) continue;

        // Occlusion: RGB ~0, alpha <= 0.6
        const rgbSum = Math.abs(tint[0]) + Math.abs(tint[1]) + Math.abs(tint[2]);
        if (rgbSum > 0.1 || tint[3] > 0.6) continue;

        const matrix = getUniformValue(render.uniformState, progmeta.uModelMatrix)[0] as number[];
        if (!matrix || matrix.length < 16) continue;

        const x = Math.round(matrix[12] / TILESIZE) - 2;
        const y = matrix[13] / TILESIZE;
        const z = Math.round(matrix[14] / TILESIZE) - 1;

        if (x === 0 && z === 0) continue;

        candidates.push({
          x, y, z,
          rotation: Math.atan2(-matrix[8], matrix[0]),
          vaoId: render.vertexObjectId,
          programId: render.program.programId,
          tintAlpha: tint[3],
        });
      } catch {
        continue;
      }
    }

    if (candidates.length === 0) return null;

    // Use camera to pick player (closest to camera target)
    const camera = this.extractCamera(renders);
    if (camera) {
      for (const c of candidates) {
        c.distFromCamera = Math.sqrt(
          Math.pow(c.x - camera.targetX, 2) +
          Math.pow(c.z - camera.targetZ, 2)
        );
      }
      candidates.sort((a, b) => (a.distFromCamera ?? 0) - (b.distFromCamera ?? 0));
    } else {
      // Fallback: prefer alpha closer to 0.5
      candidates.sort((a, b) => Math.abs(a.tintAlpha - 0.5) - Math.abs(b.tintAlpha - 0.5));
    }

    const best = candidates[0];

    // Cache for fast future lookups
    this.cachedMesh = {
      vaoId: best.vaoId,
      programId: best.programId,
      timestamp: Date.now(),
    };

    return {
      x: best.x,
      y: best.y,
      z: best.z,
      rotation: best.rotation,
      vaoId: best.vaoId,
      programId: best.programId,
    };
  }

  /**
   * Extract camera target and yaw from renders
   */
  private extractCamera(renders: patchrs.RenderInvocation[]): CameraInfo | null {
    for (const render of renders) {
      const uViewMatrix = render.program?.uniforms?.find(u => u.name === "uViewMatrix");
      if (!uViewMatrix || !render.uniformState) continue;

      try {
        const v = getUniformValue(render.uniformState, uViewMatrix)[0] as number[];
        if (!v || v.length < 16) continue;

        // Camera position = -R^T * t
        const camX = -(v[0] * v[12] + v[1] * v[13] + v[2] * v[14]);
        const camY = -(v[4] * v[12] + v[5] * v[13] + v[6] * v[14]);
        const camZ = -(v[8] * v[12] + v[9] * v[13] + v[10] * v[14]);

        // Camera forward direction in world space = -third column of view matrix
        // fwdX = -v[2], fwdY = -v[6], fwdZ = -v[10]
        const fwdX = -v[2];
        const fwdY = -v[6];
        const fwdZ = -v[10];

        // Camera yaw: angle of forward direction projected onto XZ plane
        // RS3: Z+ is north, X+ is east
        // atan2(fwdX, fwdZ) gives 0 when facing north, PI/2 when facing east
        const yaw = Math.atan2(fwdX, fwdZ);

        if (fwdY >= 0) {
          return {
            x: camX / TILESIZE,
            y: camY / TILESIZE,
            z: camZ / TILESIZE,
            targetX: camX / TILESIZE,
            targetZ: camZ / TILESIZE,
            yaw,
          };
        }

        const t = -camY / fwdY;
        return {
          x: camX / TILESIZE,
          y: camY / TILESIZE,
          z: camZ / TILESIZE,
          targetX: (camX + t * fwdX) / TILESIZE,
          targetZ: (camZ + t * fwdZ) / TILESIZE,
          yaw,
        };
      } catch {
        continue;
      }
    }
    return null;
  }

  /**
   * Get camera info only
   */
  async getCamera(): Promise<CameraInfo | null> {
    let renders: any[] = [];
    try {
      renders = await patchrs.native.recordRenderCalls({ maxframes: 1,
        features: ["uniforms"],
      });
      return this.extractCamera(renders);
    } catch {
      return null;
    } finally {
      for (const r of renders) {
        try { r.dispose?.(); } catch (_) {}
      }
    }
  }

  /** Clear cached mesh (force rescan) */
  clearCache(): void {
    this.cachedMesh = null;
  }
}

// Convenience functions

let _tracker: PlayerPositionTracker | null = null;

/** Get player position (singleton tracker) */
export async function getPlayerPosition(): Promise<PlayerPosition | null> {
  if (!_tracker) _tracker = new PlayerPositionTracker();
  return _tracker.getPosition();
}

/** Get player tile as {x, z} */
export async function getPlayerTile(): Promise<{ x: number; z: number } | null> {
  const pos = await getPlayerPosition();
  return pos ? { x: pos.x, z: pos.z } : null;
}

/** Get camera info */
export async function getCameraInfo(): Promise<CameraInfo | null> {
  if (!_tracker) _tracker = new PlayerPositionTracker();
  return _tracker.getCamera();
}

// =============================================================================
// Passive Player Tracker (uses streaming to continuously track player position)
// =============================================================================

/**
 * PassivePlayerTracker - Streaming-based player position tracking
 *
 * Uses streamRenderCalls to monitor renders and extract player position
 * from the tinted occlusion mesh's uModelMatrix uniform.
 */
export class PassivePlayerTracker {
  private debug: boolean;
  private initialized = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollInFlight = false;
  private currentPosition: PlayerPosition | null = null;
  private lastUpdateTime = 0;

  constructor(options: { debug?: boolean } = {}) {
    this.debug = options.debug ?? false;
  }

  /**
   * Initialize polling-based position tracking.
   * Uses one-shot recordRenderCalls every 3s instead of streaming,
   * which avoids exhausting the 512MB shared memory heap.
   */
  async init(): Promise<boolean> {
    if (this.initialized) return true;

    try {
      this.pollTimer = setInterval(() => this.pollOnce(), 3000);
      this.initialized = true;
      // Immediate first poll
      this.pollOnce();
      return true;
    } catch (e) {
      console.error("[PassivePlayer] Init error:", e);
      return false;
    }
  }

  private async pollOnce(): Promise<void> {
    if (this.pollInFlight || !patchrs.native) return;
    this.pollInFlight = true;
    let renders: any[] = [];
    try {
      renders = await patchrs.native.recordRenderCalls({
        maxframes: 1,
        features: ["uniforms"],
      });
      this.processRenders(renders);
    } catch (e) {
      if (this.debug) console.error("[PassivePlayer] Poll error:", e);
    } finally {
      for (const r of renders) {
        try { r.dispose?.(); } catch (_) {}
      }
      this.pollInFlight = false;
    }
  }

  /** Counter for reducing log frequency */
  private processCounter = 0;

  /**
   * Process renders to find player position
   */
  private processRenders(renders: patchrs.RenderInvocation[]): void {
    this.processCounter++;

    // Find the player's tinted occlusion mesh and extract position
    let skippedNoShader = 0;
    for (const render of renders) {
      if (!render.program || !render.uniformState) continue;

      const hasFrag = typeof render.program.fragmentShader?.source === 'string';
      const hasVert = typeof render.program.vertexShader?.source === 'string';
      if (!hasFrag || !hasVert) {
        skippedNoShader++;
        continue;
      }

      let progmeta;
      try {
        progmeta = getProgramMeta(render.program);
      } catch {
        continue;
      }

      // Look for tinted + animated mesh with uModelMatrix
      if (!progmeta.isTinted || !progmeta.uTint || !progmeta.isAnimated || !progmeta.uModelMatrix) continue;

      try {
        const tint = getUniformValue(render.uniformState, progmeta.uTint)[0] as number[];
        if (!tint || tint.length < 4) continue;

        // Occlusion: RGB ~0, alpha <= 0.6
        const rgbSum = Math.abs(tint[0]) + Math.abs(tint[1]) + Math.abs(tint[2]);
        if (rgbSum > 0.1 || tint[3] > 0.6) continue;

        // Found player mesh - extract position from model matrix
        const matrix = getUniformValue(render.uniformState, progmeta.uModelMatrix)[0] as number[];
        if (!matrix || matrix.length < 16) continue;

        const rawX = matrix[12];
        const rawY = matrix[13];
        const rawZ = matrix[14];

        if (rawX === 0 && rawZ === 0) continue;

        const x = Math.round(rawX / TILESIZE) - 2;
        const y = rawY / TILESIZE;
        const z = Math.round(rawZ / TILESIZE) - 1;

        this.currentPosition = {
          x,
          y,
          z,
          rotation: Math.atan2(-matrix[8], matrix[0]),
          vaoId: render.vertexObjectId,
          programId: render.program.programId,
        };
        this.lastUpdateTime = Date.now();

        // Found player, stop searching this frame
        return;
      } catch {
        continue;
      }
    }
  }

  /**
   * Get current player position (instant read from cached value)
   */
  getPosition(): PlayerPosition | null {
    // Return cached position if recent (within 5s — stream fires every ~2s)
    if (this.currentPosition && Date.now() - this.lastUpdateTime < 5000) {
      return this.currentPosition;
    }
    return null;
  }

  /**
   * Async version - just returns cached position (stream updates it automatically)
   */
  async getPositionAsync(): Promise<PlayerPosition | null> {
    return this.getPosition();
  }

  /**
   * Reinitialize (restart stream)
   */
  async reinit(): Promise<boolean> {
    this.stop();
    return this.init();
  }

  /**
   * Stop tracking
   */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.currentPosition = null;
    this.initialized = false;
  }

  /**
   * Check if initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }
}

// Singleton passive tracker
let _passiveTracker: PassivePlayerTracker | null = null;

/**
 * Get the singleton passive player tracker
 */
export function getPassiveTracker(): PassivePlayerTracker {
  if (!_passiveTracker) {
    _passiveTracker = new PassivePlayerTracker();
  }
  return _passiveTracker;
}

/**
 * Initialize passive tracking (call once at startup)
 */
export async function initPassiveTracking(): Promise<boolean> {
  return getPassiveTracker().init();
}

/**
 * Get player position from passive tracker (instant, no frame capture)
 */
export function getPassivePlayerPosition(): PlayerPosition | null {
  const tracker = getPassiveTracker();
  if (!tracker.isInitialized()) return null;
  return tracker.getPosition();
}
