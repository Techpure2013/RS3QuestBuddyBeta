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
        features: ["uniforms"],
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
// GL constants for passive overlay program
const GL_FLOAT = 0x1406;
const GL_FLOAT_MAT4 = 0x8B5C;

// Minimal shaders — passive overlay never actually renders, these just define the uniform layout
const POSITION_TRACK_VERT = `#version 330 core
layout (location = 0) in vec3 aPos;
uniform highp mat4 uModelMatrix;
void main() { gl_Position = vec4(aPos, 1.0); }`;

const POSITION_TRACK_FRAG = `#version 330 core
out vec4 FragColor;
void main() { FragColor = vec4(0.0); }`;

export class PassivePlayerTracker {
  private debug: boolean;
  private initialized = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollInFlight = false;
  private currentPosition: PlayerPosition | null = null;
  private lastUpdateTime = 0;

  // Passive overlay state — zero-cost position reading after initial discovery
  private passiveOverlay: patchrs.GlOverlay | null = null;
  private playerVaoId: number = 0;
  private playerProgramId: number = 0;
  private rediscoverTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: { debug?: boolean } = {}) {
    this.debug = options.debug ?? false;
  }

  /**
   * Initialize position tracking.
   * Phase 1: ONE recordRenderCalls to find the player mesh.
   * Phase 2: Attach passive overlay → all future reads are shared memory only (zero GPU cost).
   * Falls back to periodic recordRenderCalls if passive overlay can't be created.
   */
  async init(): Promise<boolean> {
    if (this.initialized) return true;

    try {
      this.initialized = true;

      // Start polling fallback IMMEDIATELY — don't wait for discovery.
      // Discovery runs async and upgrades to passive overlay when ready.
      // This ensures position tracking works even if GL isn't ready yet.
      this.pollTimer = setInterval(() => this.pollOnce(), 5000);

      // Try initial discovery after a short delay (GL context may need time)
      setTimeout(() => this.tryUpgradeToPassive(), 3000);

      return true;
    } catch (e) {
      console.error("[PassivePlayer] Init error:", e);
      return false;
    }
  }

  /** Attempt to find player and upgrade from polling to passive overlay */
  private async tryUpgradeToPassive(): Promise<void> {
    if (this.passiveOverlay) return; // Already upgraded

    const attached = await this.discoverAndAttach();
    if (attached) {
      // Switch from polling to passive overlay reads
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
      }
      this.pollTimer = setInterval(() => this.readFromOverlay(), 500);
      this.rediscoverTimer = setInterval(() => this.verifyOrRediscover(), 30000);
    } else {
      setTimeout(() => this.tryUpgradeToPassive(), 10000);
    }
  }

  /**
   * Find the player mesh via ONE recordRenderCalls, then attach a passive overlay.
   * Returns true if passive overlay is now active.
   */
  private async discoverAndAttach(): Promise<boolean> {
    if (!patchrs.native) return false;

    let renders: any[] = [];
    try {
      // Timeout: if GL server isn't responding, don't hang forever
      const recordPromise = patchrs.native.recordRenderCalls({
        maxframes: 1,
        features: ["uniforms"],
      });
      const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000));
      const result = await Promise.race([recordPromise, timeoutPromise]);
      if (result === null) return false;
      renders = result as any[];

      // Find the player mesh
      const tracker = new PlayerPositionTracker();
      const pos = tracker.findPlayer(renders);
      if (!pos) return false;

      this.playerVaoId = pos.vaoId;
      this.playerProgramId = pos.programId;
      this.currentPosition = pos;
      this.lastUpdateTime = Date.now();

      // Create a minimal program just to define the uModelMatrix uniform layout
      let program;
      try {
        program = patchrs.native.createProgram(
          POSITION_TRACK_VERT,
          POSITION_TRACK_FRAG,
          [{ location: 0, name: "aPos", type: GL_FLOAT, length: 3 }],
          [{ name: "uModelMatrix", type: GL_FLOAT_MAT4, length: 1, snapshotOffset: 0, snapshotSize: 64 }]
        );
      } catch (e) {
        return false;
      }

      // Attach passive overlay — fires every frame the player mesh renders,
      // copies uModelMatrix into the uniform buffer (shared memory).
      // Zero GPU cost: no extra draw calls, no pipeline stalls.
      try {
        this.passiveOverlay = patchrs.native.beginOverlay(
          { vertexObjectId: this.playerVaoId },
          program,
          undefined,
          {
            trigger: 'passive',
            uniformSources: [
              { name: "uModelMatrix", sourceName: "uModelMatrix", type: "program" as const },
            ],
            uniformBuffer: new Uint8Array(64),
          }
        );
      } catch (e) {
        return false;
      }

      return !!this.passiveOverlay;
    } catch (e) {
      return false;
    } finally {
      for (const r of renders) {
        try { r.dispose?.(); } catch (_) {}
      }
    }
  }

  /**
   * Read position from passive overlay uniform state — instant shared memory read.
   * No recordRenderCalls, no GPU stall.
   */
  private readFromOverlay(): void {
    if (!this.passiveOverlay) return;

    try {
      const uniformState = this.passiveOverlay.getUniformState();
      if (!uniformState || uniformState.length < 64) return;

      // Read model matrix translation: X=offset 48, Y=offset 52, Z=offset 56
      const view = new DataView(uniformState.buffer, uniformState.byteOffset);
      const rawX = view.getFloat32(48, true);
      const rawY = view.getFloat32(52, true);
      const rawZ = view.getFloat32(56, true);

      if (rawX === 0 && rawZ === 0) return;

      const x = Math.round(rawX / TILESIZE) - 2;
      const y = rawY / TILESIZE;
      const z = Math.round(rawZ / TILESIZE) - 1;

      // Read rotation from matrix columns [0] and [8]
      const m0 = view.getFloat32(0, true);
      const m8 = view.getFloat32(32, true);

      this.currentPosition = {
        x, y, z,
        rotation: Math.atan2(-m8, m0),
        vaoId: this.playerVaoId,
        programId: this.playerProgramId,
      };
      this.lastUpdateTime = Date.now();
    } catch (e) {
      if (this.debug) console.error("[PassivePlayer] Overlay read error:", e);
    }
  }

  /**
   * Verify the passive overlay is still getting updates.
   * If position is stale (>10s), the VAO might have changed — rediscover.
   */
  private async verifyOrRediscover(): Promise<void> {
    if (!this.passiveOverlay) return;

    const staleMs = Date.now() - this.lastUpdateTime;
    if (staleMs < 10000) return; // Still fresh

    // Stop old overlay
    try { this.passiveOverlay.stop(); } catch {}
    this.passiveOverlay = null;

    // Try to rediscover
    const attached = await this.discoverAndAttach();
    if (!attached) {
      // Switch to polling fallback
      if (this.pollTimer) clearInterval(this.pollTimer);
      this.pollTimer = setInterval(() => this.pollOnce(), 5000);
    }
  }

  /** Fallback: poll with recordRenderCalls (expensive) */
  private async pollOnce(): Promise<void> {
    if (this.pollInFlight || !patchrs.native) return;
    this.pollInFlight = true;
    let renders: any[] = [];
    try {
      const recordPromise = patchrs.native.recordRenderCalls({
        maxframes: 1,
        features: ["uniforms"],
      });
      const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000));
      const result = await Promise.race([recordPromise, timeout]);
      if (result === null) return; // GL not ready, skip this poll
      renders = result as any[];
      this.processRenders(renders);

      // Try to upgrade to passive overlay if we found the player
      if (this.currentPosition && !this.passiveOverlay) {
        this.playerVaoId = this.currentPosition.vaoId;
        this.playerProgramId = this.currentPosition.programId;
        const attached = await this.discoverAndAttach();
        if (attached) {
          if (this.pollTimer) clearInterval(this.pollTimer);
          this.pollTimer = setInterval(() => this.readFromOverlay(), 500);
          if (!this.rediscoverTimer) {
            this.rediscoverTimer = setInterval(() => this.verifyOrRediscover(), 30000);
          }
        }
      }
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
    // Return cached position if recent.
    // Passive overlay mode updates at 500ms, fallback polling at 5s.
    // Use 10s staleness window to cover rediscovery gaps.
    if (this.currentPosition && Date.now() - this.lastUpdateTime < 10000) {
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
    if (this.rediscoverTimer) {
      clearInterval(this.rediscoverTimer);
      this.rediscoverTimer = null;
    }
    if (this.passiveOverlay) {
      try { this.passiveOverlay.stop(); } catch {}
      this.passiveOverlay = null;
    }
    this.playerVaoId = 0;
    this.playerProgramId = 0;
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
