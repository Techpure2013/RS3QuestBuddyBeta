/**
 * SharedRenderStream — Single GPU capture shared across all consumers
 *
 * Instead of each system (NPC overlay, player tracker, tooltip learner, tile overlays)
 * running its own render stream/capture, this provides ONE stream that broadcasts
 * frames to all registered listeners.
 *
 * Features are merged from all listeners — if any listener needs "texturesnapshot",
 * the stream captures it. When listeners with expensive features unsubscribe,
 * the stream restarts with reduced features automatically.
 */

import * as patchrs from "./patchrs_napi";

export type RenderFeature = "vertexarray" | "uniforms" | "textures" | "texturesnapshot" | "texturecapture" | "computebindings" | "framebuffer" | "full";

export interface SharedStreamListener {
    /** Unique ID for this listener (for debugging/logging) */
    id: string;
    /** Which features this listener needs */
    features: RenderFeature[];
    /** Callback receiving each frame's render invocations */
    onFrame: (renders: patchrs.RenderInvocation[]) => void;
    /** Optional: skip program mask to pass through */
    skipProgramMask?: number;
}

export class SharedRenderStream {
    private stream: patchrs.StreamRenderObject | null = null;
    private listeners = new Map<string, SharedStreamListener>();
    private activeFeatures: RenderFeature[] = [];
    private framecooldown: number;
    private skipProgramMask: number;
    private isRestarting = false;
    private paused = false;
    private frameCount = 0;

    constructor(options?: { framecooldown?: number; skipProgramMask?: number }) {
        this.framecooldown = options?.framecooldown ?? 500;
        this.skipProgramMask = options?.skipProgramMask ?? 0;
    }

    /**
     * Add a listener that will receive every frame's render data.
     * The stream automatically starts/restarts if needed.
     */
    addListener(listener: SharedStreamListener): () => void {
        const existed = this.listeners.has(listener.id);
        this.listeners.set(listener.id, listener);

        if (!existed) {
            console.log(`[SharedRenderStream] +listener "${listener.id}" (features: ${listener.features.join(",")}), total: ${this.listeners.size}`);
        }

        // Check if we need to restart with new features
        const merged = this.mergeFeatures();
        if (!this.stream || !this.featuresMatch(merged)) {
            this.restart(merged);
        }

        // Return unsubscribe function
        return () => this.removeListener(listener.id);
    }

    /**
     * Remove a listener by ID. Stream stops when no listeners remain,
     * or restarts with reduced features if an expensive feature is no longer needed.
     */
    removeListener(id: string): void {
        const listener = this.listeners.get(id);
        if (!listener) return;

        this.listeners.delete(id);
        console.log(`[SharedRenderStream] -listener "${id}", remaining: ${this.listeners.size}`);

        if (this.listeners.size === 0) {
            this.stop();
            return;
        }

        // Check if removed listener had features nobody else needs
        const merged = this.mergeFeatures();
        if (!this.featuresMatch(merged)) {
            this.restart(merged);
        }
    }

    /**
     * Stop the stream entirely.
     */
    stop(): void {
        if (this.stream) {
            this.stream.close();
            this.stream = null;
            console.log(`[SharedRenderStream] Stopped (served ${this.frameCount} frames)`);
            this.frameCount = 0;
        }
        this.activeFeatures = [];
        this.paused = false;
    }

    /**
     * Temporarily pause the native stream to free shared memory for one-shot captures.
     * Listeners remain registered — call resume() to restart.
     */
    pause(): void {
        if (this.paused || !this.stream) return;
        this.paused = true;
        this.stream.close();
        this.stream = null;
        console.log(`[SharedRenderStream] Paused (freeing shared memory for one-shot capture)`);
    }

    /**
     * Resume after a pause(). Restarts the native stream with current listeners.
     */
    resume(): void {
        if (!this.paused) return;
        this.paused = false;
        if (this.listeners.size > 0) {
            const merged = this.mergeFeatures();
            console.log(`[SharedRenderStream] Resuming (${this.listeners.size} listeners)`);
            this.restart(merged);
        }
    }

    /**
     * Get current listener count.
     */
    get listenerCount(): number {
        return this.listeners.size;
    }

    /**
     * Get current active features.
     */
    get features(): readonly RenderFeature[] {
        return this.activeFeatures;
    }

    /**
     * Whether the stream is currently active.
     */
    get isActive(): boolean {
        return this.stream !== null;
    }

    /**
     * Update the frame cooldown. Takes effect on next restart.
     */
    setFrameCooldown(ms: number): void {
        this.framecooldown = ms;
    }

    // ── Internals ──

    private mergeFeatures(): RenderFeature[] {
        const featureSet = new Set<RenderFeature>();
        for (const listener of this.listeners.values()) {
            for (const f of listener.features) {
                featureSet.add(f);
            }
        }
        // Sort for stable comparison
        return Array.from(featureSet).sort();
    }

    private featuresMatch(merged: RenderFeature[]): boolean {
        if (merged.length !== this.activeFeatures.length) return false;
        for (let i = 0; i < merged.length; i++) {
            if (merged[i] !== this.activeFeatures[i]) return false;
        }
        return true;
    }

    private restart(features: RenderFeature[]): void {
        if (this.isRestarting) return;
        this.isRestarting = true;

        try {
            // Stop existing stream
            if (this.stream) {
                this.stream.close();
                this.stream = null;
            }

            if (!patchrs.native || this.listeners.size === 0) {
                this.activeFeatures = [];
                return;
            }

            this.activeFeatures = features;

            // Merge skipProgramMask from all listeners
            let combinedSkipMask = this.skipProgramMask;
            for (const listener of this.listeners.values()) {
                if (listener.skipProgramMask) {
                    // We can only use the INTERSECTION of skip masks
                    // (a program skipped by all listeners can be skipped globally)
                    // For simplicity, use the base mask only
                }
            }

            console.log(`[SharedRenderStream] Starting stream (features: [${features.join(",")}], cooldown: ${this.framecooldown}ms, listeners: ${this.listeners.size})`);

            this.stream = patchrs.native.streamRenderCalls(
                {
                    features: features as any,
                    framecooldown: this.framecooldown,
                    skipProgramMask: combinedSkipMask,
                },
                (renders) => this.broadcastFrame(renders)
            );

            // Auto-restart if the stream ends unexpectedly (game restart, DLL reinit)
            // Capture reference so we don't restart if pause()/resume() already replaced it
            const thisStream = this.stream;
            if (this.stream.ended) {
                this.stream.ended.then(() => {
                    if (this.stream !== thisStream) return; // stream was replaced by pause/resume
                    if (this.paused) return; // intentionally paused
                    if (this.listeners.size > 0 && !this.isRestarting) {
                        console.log(`[SharedRenderStream] Stream ended unexpectedly, restarting (${this.listeners.size} listeners)`);
                        this.stream = null;
                        this.activeFeatures = [];
                        this.restart(this.mergeFeatures());
                    }
                }).catch(() => {});
            }
        } finally {
            this.isRestarting = false;
        }
    }

    private broadcastFrame(renders: patchrs.RenderInvocation[]): void {
        this.frameCount++;

        // Diagnostic: log every ~10 frames or when empty
        if (this.frameCount % 10 === 1 || renders.length === 0) {
            const ids = [...this.listeners.keys()].join(",");
            console.log(`[SharedRenderStream] frame=${this.frameCount} renders=${renders.length} listeners=[${ids}]`);
        }
        if (renders.length === 0) logSharedMemoryState();

        // Broadcast to all listeners — catch errors per-listener so one bad
        // listener doesn't kill the stream for everyone
        for (const listener of this.listeners.values()) {
            try {
                listener.onFrame(renders);
            } catch (e) {
                console.error(`[SharedRenderStream] Error in listener "${listener.id}":`, e);
            }
        }
    }
}

// ── Singleton ──

let _instance: SharedRenderStream | null = null;

/**
 * Get the global SharedRenderStream instance.
 * All continuous consumers should use this instead of their own streams.
 */
export function getSharedRenderStream(): SharedRenderStream {
    if (!_instance) {
        _instance = new SharedRenderStream({ framecooldown: 2000 });
    }
    return _instance;
}

/**
 * Destroy the global instance (for cleanup/testing).
 */
export function destroySharedRenderStream(): void {
    if (_instance) {
        _instance.stop();
        _instance = null;
    }
}

/**
 * Pause the shared stream, run an async operation, then resume.
 * Use this around any recordRenderCalls() to free shared memory
 * from the continuous stream so the one-shot capture succeeds.
 */
/**
 * Debounced resume: after the last capture finishes, wait before restarting
 * the stream. This prevents rapid close/reopen cycles that corrupt the
 * shared memory allocator (Boost rbtree double-free).
 */
let _resumeTimer: ReturnType<typeof setTimeout> | null = null;
let _streamWasPaused = false;

export async function captureWithStreamPause<T>(fn: () => Promise<T>): Promise<T> {
    // If no stream is active, just run the function directly.
    // With polling-based consumers (no streaming), this is the normal path.
    if (!_instance || !_instance.isActive) {
        return fn();
    }

    // Cancel any pending debounced resume
    if (_resumeTimer) {
        clearTimeout(_resumeTimer);
        _resumeTimer = null;
    }

    _instance.pause();
    _streamWasPaused = true;

    try {
        return await fn();
    } finally {
        if (_streamWasPaused) {
            const stream = _instance;
            _resumeTimer = setTimeout(() => {
                _resumeTimer = null;
                _streamWasPaused = false;
                stream?.resume();
            }, 5000);
        }
    }
}

/** One-time memory state log at startup */
let memoryLogged = false;
export function logSharedMemoryState(): void {
    if (memoryLogged) return;
    try {
        const state = (patchrs.native as any)?.debug?.memoryState?.();
        if (state) {
            const usedMB = (state.used / (1024 * 1024)).toFixed(1);
            const freeMB = ((state.size - state.used) / (1024 * 1024)).toFixed(1);
            const totalMB = (state.size / (1024 * 1024)).toFixed(1);
            const pct = ((state.used / state.size) * 100).toFixed(1);
            console.log(`[SharedMem] used=${usedMB}MB free=${freeMB}MB total=${totalMB}MB (${pct}% used)`);
            memoryLogged = true;
        }
    } catch {}
}
