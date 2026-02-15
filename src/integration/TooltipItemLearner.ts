/**
 * Tooltip Item Learner
 *
 * Auto-learns item names by detecting tooltips that appear when hovering
 * items in the inventory. Uses mouse position from render uniforms to
 * determine exactly which inventory slot is being hovered.
 *
 * Tooltip sprites: 4650, 4649, 4651, 35516
 * - These form a box around the item name text when hovering
 * - 35516 appears toward the center
 */

import { GLBridgeAdapter, type RenderRect, type UIState } from './GLBridgeAdapter';
import type { RenderInvocation } from '../gl/injection/util/patchrs_napi';
import { hammingDistance, dHash, hashToHex } from '../gl/injection/util/phash';

// Tooltip sprite IDs that form the tooltip background
export const TOOLTIP_SPRITE_IDS = {
  topLeft: 4650,
  topRight: 4649,
  bottomLeft: 4651,
  center: 35516,
};

const TOOLTIP_ID_SET = new Set([
  TOOLTIP_SPRITE_IDS.topLeft,
  TOOLTIP_SPRITE_IDS.topRight,
  TOOLTIP_SPRITE_IDS.bottomLeft,
  TOOLTIP_SPRITE_IDS.center,
]);

/**
 * Extract mouse position from render invocation uniforms
 * Mouse is stored as a vec2 uniform named "uMouse"
 */
export function getMousePositionFromRender(render: RenderInvocation): { x: number; y: number } | null {
  if (!render.program?.uniforms || !render.uniformState) return null;

  // Try different uniform names that might contain mouse position
  const mouseUniform = render.program.uniforms.find((u: any) =>
    u.name === 'uMouse' || u.name === 'mouse' || u.name === 'u_mouse'
  );
  if (!mouseUniform) return null;

  try {
    const offset = mouseUniform.snapshotOffset;
    if (offset === undefined || offset < 0) return null;

    const view = new DataView(
      render.uniformState.buffer,
      render.uniformState.byteOffset + offset
    );
    const x = view.getFloat32(0, true);  // First float (little-endian)
    const y = view.getFloat32(4, true);  // Second float (little-endian)

    // Sanity check - mouse position should be reasonable screen coordinates
    if (isNaN(x) || isNaN(y) || x < 0 || y < 0 || x > 10000 || y > 10000) {
      return null;
    }

    return { x, y };
  } catch (e) {
    return null;
  }
}

/**
 * Debug: Log all uniform names from renders to help identify mouse uniform
 */
export function debugUniformNames(renders: RenderInvocation[]): string[] {
  const names = new Set<string>();
  for (const render of renders) {
    if (render.program?.uniforms) {
      for (const u of render.program.uniforms) {
        names.add((u as any).name);
      }
    }
  }
  return Array.from(names).sort();
}

/**
 * Find mouse position from any render invocation that has the uMouse uniform
 */
export function findMousePosition(renders: RenderInvocation[]): { x: number; y: number } | null {
  for (const render of renders) {
    const pos = getMousePositionFromRender(render);
    if (pos) return pos;
  }
  return null;
}

/**
 * Learned item entry
 */
export interface LearnedItem {
  name: string;
  iconHash: number;       // CRC32 hash (session-specific)
  pHash?: string;         // Perceptual hash (cross-session)
  learnedAt: number;      // Timestamp
  confidence: number;     // 0-1
  source: 'tooltip' | 'database' | 'manual';
}

/**
 * Inventory slot info for correlation
 */
export interface InventorySlotInfo {
  slot: number;
  x: number;
  y: number;
  width: number;
  height: number;
  iconHash: number;
  pHash?: string;
  iconElement: RenderRect | null;
}

/**
 * Tooltip detection result
 */
export interface TooltipDetectionResult {
  isVisible: boolean;
  bounds: { x: number; y: number; width: number; height: number } | null;
  text: string | null;
  nearestSlot: number | null;
  confidence: number;
}

/**
 * Calibration state exposed to UI
 */
export interface CalibrationState {
  active: boolean;
  targetSlot: number;        // 0-indexed slot the user should hover next
  totalSlots: number;        // total slots to calibrate
  samplesCollected: number;  // samples collected for current target slot
  samplesNeeded: number;     // samples needed per slot
  calibratedSlots: number;   // how many slots fully calibrated so far
  message: string;           // human-readable instruction
}

/**
 * TooltipItemLearner - Auto-learns item names from inventory hover tooltips
 */
export class TooltipItemLearner {
  private glBridge: GLBridgeAdapter;
  private learnedItems: Map<number, LearnedItem> = new Map(); // keyed by iconHash
  private pHashIndex: Map<string, LearnedItem> = new Map();   // keyed by pHash for cross-session lookup
  private listeners: Set<(item: LearnedItem) => void> = new Set();
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  // Track last mouse position that was inside the inventory grid.
  // When tooltip lingers after cursor moves away, we use this to determine
  // which slot was actually hovered.
  private lastGridMousePos: { x: number; y: number; slot: number } | null = null;
  private lastGridMouseTime: number = 0;

  // Slot-vote confirmation system for row detection.
  // Since the mouse always drifts past the grid by IPC sampling time, row detection
  // from mouse Y is unreliable. Instead of trying to guess the row perfectly,
  // we track vote counts: how many times a tooltip name has been seen paired with
  // each candidate slot's iconHash. Only confirm a learning after 2+ consistent votes.
  // Key: tooltipName → Map<iconHash, voteCount>
  private slotVotes: Map<string, Map<number, number>> = new Map();
  private static readonly VOTES_REQUIRED = 2;

  // ── pHash-based slot matching ──
  // When a tooltip shows a name, we know the column (from tooltip X) and we know
  // the pHashes of ALL items in that column. We record which pHashes were present
  // in the column each time we see this name. The correct item's pHash appears
  // EVERY time; wrong candidates change as different items are hovered.
  // Key: tooltipName → Set<pHash> (intersection of candidates across sightings)
  private namePHashCandidates: Map<string, Set<string>> = new Map();

  // ── Slot pHash Validation Map ──
  // Maintains a snapshot of each slot's current pHash, updated every frame.
  // Used to VALIDATE guessed slots: after the system guesses which slot is
  // being hovered, we compare the guessed slot's pHash from this map against
  // what we expect. If the pHash at that slot has been stable (same across
  // multiple frames), we can confidently assign the tooltip name to it.
  //
  // Flow: hover → guess slot → validate slot's pHash is stable → assign tooltip name to pHash
  //
  // Map<slotIndex, pHash>
  private slotPHashMap: Map<number, string> = new Map();
  // Track stability: how many consecutive frames each slot kept the same pHash.
  // Key: slotIndex, Value: { pHash, count }
  private slotPHashStability: Map<number, { pHash: string; count: number }> = new Map();
  private static readonly PHASH_STABLE_FRAMES = 2; // require 2+ consistent frames

  // ── Inventory Mouse Calibration ──
  // Records the actual (drifted) mouse position observed when hovering each slot.
  // Because IPC latency causes consistent drift, the calibrated positions let us
  // match future mouse positions to slots without needing accurate absolute coords.
  //
  // Map<slotIndex, { mouseX, mouseY }[]>  — multiple samples averaged for accuracy
  private calibratedMousePositions: Map<number, { x: number; y: number }[]> = new Map();
  private calibrationActive: boolean = false;
  private calibrationTargetSlot: number = 0;
  private calibrationTotalSlots: number = 0;
  private calibrationSamplesPerSlot: number = 3; // require 3 tooltip sightings per slot
  private calibrationListeners: Set<(state: CalibrationState) => void> = new Set();

  // UI text patterns that should never be learned as item names
  // Note: OCR can garble text (e.g. "Don't show this again" → "60 D/6 o 0 n't show this again")
  // so we use loose patterns that match substrings
  private static readonly REJECTED_PATTERNS: RegExp[] = [
    /don'?t\s*show\s*this\s*again/i,
    /show\s*this\s*again/i,          // catches garbled OCR variants
    /are\s*you\s*sure/i,
    /click\s*here\s*to/i,
    /press\s*esc/i,
    /please\s*wait/i,
    /select\s*the\s*icon/i,          // "Select the icon to view your wealth."
    /view\s*your\s*wealth/i,         // wealth evaluator UI text
    /to\s*view\s*your/i,             // generic "to view your X" instructional text
    /right[- ]?click/i,              // "Right-click for options"
    /drag\s*(and|&)?\s*drop/i,       // "Drag and drop to rearrange"
    /hover\s*over/i,                 // "Hover over to see..."
    /left[- ]?click/i,              // "Left-click to..."
    /you\s*currently\s*have/i,       // Coin pouch: "You currently have X coins."
    /select\s*this\s*to/i,          // "Select this to open the price checker"
    /open\s*the\s*price/i,          // Price checker instructional text
  ];

  /**
   * Check if text looks like a UI instruction/sentence rather than an item name.
   * RS3 item names:
   *  - Never end with a period (.)
   *  - Are typically 1-5 words, max ~40 chars
   *  - Don't contain common sentence words like "the", "to", "your", "for", "this"
   *    in combination (one alone is fine - e.g. "Ring of the gods")
   */
  private static isInstructionalText(text: string): boolean {
    const trimmed = text.trim();

    // Item names never end with a period
    if (trimmed.endsWith('.')) return true;

    // Item names never end with an exclamation mark
    if (trimmed.endsWith('!')) return true;

    // Item names are typically short - reject very long text (>60 chars)
    if (trimmed.length > 60) return true;

    // Count "sentence indicator" words - if 3+ present, it's likely a sentence
    const sentenceWords = ['the', 'to', 'your', 'you', 'for', 'this', 'that', 'from',
      'with', 'have', 'has', 'will', 'can', 'select', 'click', 'view', 'open',
      'press', 'drag', 'hover', 'please', 'would', 'should', 'must',
      'currently', 'here', 'items', 'or', 'interface'];
    const lowerWords = trimmed.toLowerCase().split(/\s+/);
    const sentenceWordCount = lowerWords.filter(w => sentenceWords.includes(w)).length;

    // 3+ sentence words strongly suggests instructional text, not an item name
    // (Even "Ring of the gods" only has 1: "the")
    if (sentenceWordCount >= 3) return true;

    return false;
  }

  // Inventory grid config (should match IntegratedInventoryMonitor)
  private gridConfig = {
    startX: 0,
    startY: 0,
    slotWidth: 40,
    slotHeight: 36,
    columns: 4,
    rows: 7,
    horizontalGap: 2,
    verticalGap: 2,
    // Detected actual grid bounds (set by autoCalibrate)
    actualGridTopY: 0,    // Top of grid (highest Y in RS3 coords)
    actualCellWidth: 0,   // Actual width per cell including gap
    actualCellHeight: 0,  // Actual height per cell including gap
  };

  // Actual detected column X and row Y positions (row 0 = highest Y = first element)
  private columnPositions: number[] = [];
  private rowPositions: number[] = []; // Sorted descending: row 0 has highest Y

  // Inventory slot sprite ID
  private readonly INVENTORY_SLOT_SPRITE_ID = 18266;

  constructor(glBridge: GLBridgeAdapter) {
    this.glBridge = glBridge;
  }

  /**
   * Set grid config (should be called after inventory calibration)
   */
  setGridConfig(config: typeof this.gridConfig): void {
    this.gridConfig = { ...config };
  }

  // ── Calibration API ──

  /**
   * Start inventory mouse calibration.
   * The user will be prompted to hover each occupied slot in sequence.
   * For each slot, we record the (drifted) mouse position multiple times
   * and average them. After calibration, findNearestSlot uses these
   * reference positions instead of raw mouse Y for row detection.
   *
   * @param totalSlots - number of slots to calibrate (defaults to columns * rows from grid config)
   */
  startCalibration(totalSlots?: number): void {
    const total = totalSlots ?? (this.gridConfig.columns * this.gridConfig.rows);
    this.calibrationActive = true;
    this.calibrationTargetSlot = 0;
    this.calibrationTotalSlots = total;
    this.calibratedMousePositions.clear();
    console.log(`[Calibration] Started: ${total} slots to calibrate (${this.calibrationSamplesPerSlot} samples each)`);
    this.emitCalibrationState();
  }

  /**
   * Cancel an in-progress calibration. Keeps any already-calibrated positions.
   */
  cancelCalibration(): void {
    if (!this.calibrationActive) return;
    this.calibrationActive = false;
    console.log(`[Calibration] Cancelled. ${this.calibratedMousePositions.size} slots were calibrated.`);
    this.emitCalibrationState();
  }

  /**
   * Skip the current calibration slot (e.g. if it's empty / no item to hover).
   */
  skipCalibrationSlot(): void {
    if (!this.calibrationActive) return;
    console.log(`[Calibration] Skipping slot ${this.calibrationTargetSlot + 1}`);
    this.calibrationTargetSlot++;
    if (this.calibrationTargetSlot >= this.calibrationTotalSlots) {
      this.calibrationActive = false;
      console.log(`[Calibration] Complete! ${this.calibratedMousePositions.size} slots calibrated.`);
    }
    this.emitCalibrationState();
  }

  /**
   * Record a calibration sample for the current target slot.
   * Called internally when a tooltip is detected during calibration mode.
   * @returns true if the slot is now fully calibrated and we advanced to the next
   */
  private recordCalibrationSample(mousePos: { x: number; y: number }): boolean {
    if (!this.calibrationActive) return false;

    const slot = this.calibrationTargetSlot;
    let samples = this.calibratedMousePositions.get(slot);
    if (!samples) {
      samples = [];
      this.calibratedMousePositions.set(slot, samples);
    }

    samples.push({ x: mousePos.x, y: mousePos.y });
    console.log(`[Calibration] Slot ${slot + 1}: sample ${samples.length}/${this.calibrationSamplesPerSlot} at (${mousePos.x.toFixed(0)}, ${mousePos.y.toFixed(0)})`);

    if (samples.length >= this.calibrationSamplesPerSlot) {
      // Enough samples — advance to next slot
      this.calibrationTargetSlot++;
      if (this.calibrationTargetSlot >= this.calibrationTotalSlots) {
        this.calibrationActive = false;
        console.log(`[Calibration] Complete! ${this.calibratedMousePositions.size} slots calibrated.`);
        this.logCalibrationSummary();
      }
      this.emitCalibrationState();
      return true;
    }

    this.emitCalibrationState();
    return false;
  }

  /**
   * Get the averaged calibrated mouse position for a slot.
   * Returns null if the slot has no calibration data.
   */
  getCalibratedPosition(slot: number): { x: number; y: number } | null {
    const samples = this.calibratedMousePositions.get(slot);
    if (!samples || samples.length === 0) return null;
    const avgX = samples.reduce((s, p) => s + p.x, 0) / samples.length;
    const avgY = samples.reduce((s, p) => s + p.y, 0) / samples.length;
    return { x: avgX, y: avgY };
  }

  /**
   * Check if calibration data is available (at least some slots calibrated).
   */
  isCalibrated(): boolean {
    return this.calibratedMousePositions.size > 0;
  }

  /**
   * Check if calibration is currently in progress.
   */
  isCalibrating(): boolean {
    return this.calibrationActive;
  }

  /**
   * Get the current calibration state for UI display.
   */
  getCalibrationState(): CalibrationState {
    const slot = this.calibrationTargetSlot;
    const samples = this.calibratedMousePositions.get(slot);
    const collected = samples?.length ?? 0;
    const { columns } = this.gridConfig;
    const row = Math.floor(slot / columns);
    const col = slot % columns;

    return {
      active: this.calibrationActive,
      targetSlot: slot,
      totalSlots: this.calibrationTotalSlots,
      samplesCollected: collected,
      samplesNeeded: this.calibrationSamplesPerSlot,
      calibratedSlots: this.calibratedMousePositions.size,
      message: this.calibrationActive
        ? `Hover slot ${slot + 1} (row ${row + 1}, col ${col + 1}) — ${collected}/${this.calibrationSamplesPerSlot} samples`
        : this.calibratedMousePositions.size > 0
          ? `Calibrated: ${this.calibratedMousePositions.size} slots`
          : 'Not calibrated',
    };
  }

  /**
   * Subscribe to calibration state changes.
   */
  onCalibrationStateChange(listener: (state: CalibrationState) => void): () => void {
    this.calibrationListeners.add(listener);
    return () => this.calibrationListeners.delete(listener);
  }

  /**
   * Clear all calibration data.
   */
  clearCalibration(): void {
    this.calibratedMousePositions.clear();
    this.calibrationActive = false;
    console.log('[Calibration] Cleared all calibration data.');
    this.emitCalibrationState();
  }

  /**
   * Export calibration data for persistence.
   */
  exportCalibration(): { slot: number; x: number; y: number }[] {
    const result: { slot: number; x: number; y: number }[] = [];
    for (const [slot, samples] of this.calibratedMousePositions) {
      if (samples.length > 0) {
        const avgX = samples.reduce((s, p) => s + p.x, 0) / samples.length;
        const avgY = samples.reduce((s, p) => s + p.y, 0) / samples.length;
        result.push({ slot, x: avgX, y: avgY });
      }
    }
    return result;
  }

  /**
   * Import previously saved calibration data.
   */
  importCalibration(data: { slot: number; x: number; y: number }[]): void {
    this.calibratedMousePositions.clear();
    for (const entry of data) {
      // Store as a single "sample" (already averaged)
      this.calibratedMousePositions.set(entry.slot, [{ x: entry.x, y: entry.y }]);
    }
    console.log(`[Calibration] Imported ${data.length} calibrated positions.`);
  }

  private emitCalibrationState(): void {
    const state = this.getCalibrationState();
    for (const listener of this.calibrationListeners) {
      try {
        listener(state);
      } catch (e) {
        console.error('[Calibration] Listener error:', e);
      }
    }
  }

  private logCalibrationSummary(): void {
    const { columns } = this.gridConfig;
    console.log('[Calibration] === Summary ===');
    for (const [slot, samples] of this.calibratedMousePositions) {
      const avg = this.getCalibratedPosition(slot);
      if (avg) {
        const row = Math.floor(slot / columns);
        const col = slot % columns;
        console.log(`  Slot ${slot + 1} (row${row},col${col}): avg mouse (${avg.x.toFixed(0)}, ${avg.y.toFixed(0)}) from ${samples.length} samples`);
      }
    }
  }

  /**
   * Auto-record calibration data from high-confidence detections.
   * Called when we identify a slot with ≥0.90 confidence (highlight, single-in-column,
   * or already-calibrated match). Records the current mouse position as a reference
   * sample for that slot, passively building calibration data as the user plays.
   *
   * Caps samples per slot at 5 to avoid unbounded growth, keeps recent samples.
   */
  private autoRecordCalibration(slot: number, mousePos: { x: number; y: number }): void {
    let samples = this.calibratedMousePositions.get(slot);
    if (!samples) {
      samples = [];
      this.calibratedMousePositions.set(slot, samples);
    }

    samples.push({ x: mousePos.x, y: mousePos.y });

    // Cap at 5 samples per slot — keep the most recent
    if (samples.length > 5) {
      samples.shift();
    }

    console.log(`[AutoCalibration] Recorded mouse (${mousePos.x.toFixed(0)}, ${mousePos.y.toFixed(0)}) for slot ${slot + 1} (${samples.length} samples, ${this.calibratedMousePositions.size} slots calibrated)`);
  }

  /**
   * Detect tooltip and learn item name if visible
   * Uses mouse position from render uniforms for exact slot correlation
   */
  async detectAndLearn(): Promise<TooltipDetectionResult> {
    // Record with uniforms to get mouse position
    const renders = await this.glBridge.recordRenderCalls({
      texturesnapshot: true,
      uniforms: true,
      vertexarray: true,
    });
    try {
      // Capture mouse position IMMEDIATELY after render returns,
      // before any processing. The cursor is closest to its position
      // during the rendered frame right now; processing delay causes
      // the cursor to drift away from the hovered slot.
      const mousePos = this.glBridge.getMousePositionGL();
      const uiState = this.glBridge.getUIState(renders);
      return this.detectFromElements(uiState.elements, renders, mousePos);
    } finally {
      // Dispose all render invocations to free native memory
      for (const r of renders) {
        try { r.dispose(); } catch (_) { /* already disposed */ }
      }
    }
  }

  /**
   * Detect tooltip from pre-captured elements
   * Use this when you already have captured elements to avoid timing issues.
   * @param preMousePos - Pre-captured mouse position (sampled right after render).
   *   Pass this to avoid timing drift between frame capture and cursor sampling.
   */
  detectFromElements(elements: RenderRect[], renders?: any, preMousePos?: { x: number; y: number } | null): TooltipDetectionResult {

    // Auto-calibrate grid if needed
    this.autoCalibrate(elements);

    // Track mouse grid position every frame (not just when tooltip visible).
    // This ensures we have a recent grid position when a tooltip appears
    // but the mouse has already drifted away (common with fast cursor movement).
    // Use generous tolerance because IPC latency means the cursor position
    // is often 50-150px past the slot by the time we sample it.
    const earlyMousePos = preMousePos ?? this.glBridge.getMousePositionGL();
    if (earlyMousePos) {
      const earlySlot = this.getNearestSlotGenerous(earlyMousePos.x, earlyMousePos.y);
      if (earlySlot !== null) {
        this.lastGridMousePos = { x: earlyMousePos.x, y: earlyMousePos.y, slot: earlySlot };
        this.lastGridMouseTime = Date.now();
      }
    }

    // Find tooltip elements by sprite ID
    const tooltipElements = elements.filter(
      el => el.sprite.known && TOOLTIP_ID_SET.has(el.sprite.known.id)
    );

    let tooltipBounds: { x: number; y: number; width: number; height: number } | null = null;

    if (tooltipElements.length > 0) {
      console.log(`[TooltipLearner] Found ${tooltipElements.length} tooltip sprites by ID`);
      // Log positions of tooltip sprites
      const positions = tooltipElements.slice(0, 5).map(el =>
        `ID:${el.sprite.known?.id} at (${el.x.toFixed(0)},${el.y.toFixed(0)})`
      );
      console.log(`[TooltipLearner] Positions: ${positions.join(', ')}`);

      // Calculate tooltip bounds from sprite IDs
      tooltipBounds = this.calculateTooltipBounds(tooltipElements);
      console.log(`[TooltipLearner] calculateTooltipBounds result: ${tooltipBounds ? `(${tooltipBounds.x.toFixed(0)},${tooltipBounds.y.toFixed(0)}) ${tooltipBounds.width.toFixed(0)}x${tooltipBounds.height.toFixed(0)}` : 'null'}`);
    }

    // Fallback: detect tooltip by finding text character clusters near inventory
    if (!tooltipBounds) {
      tooltipBounds = this.detectTooltipByTextCluster(elements);
      if (tooltipBounds) {
        console.log(`[TooltipLearner] Fallback detected tooltip: (${tooltipBounds.x.toFixed(0)},${tooltipBounds.y.toFixed(0)}) ${tooltipBounds.width.toFixed(0)}x${tooltipBounds.height.toFixed(0)}`);
      }
    }

    if (!tooltipBounds) {
      return {
        isVisible: false,
        bounds: null,
        text: null,
        nearestSlot: null,
        confidence: 0,
      };
    }

    // Extract text from tooltip area
    const { fullText, itemName } = this.extractTooltipText(elements, tooltipBounds);

    // Find inventory slots and their contents
    const inventorySlots = this.findInventorySlots(elements);

    // Update slot→pHash map every frame for stability tracking.
    // This builds a "slot map" of which pHash is at each position.
    // After 2+ consistent frames, a slot's pHash is considered stable
    // and can be used to validate guessed hover slots.
    this.updateSlotPHashMap(inventorySlots);

    // ── Hover detection: find the hovered slot by looking for extra elements ──
    // RS3 renders a highlight/overlay sprite on the hovered inventory slot.
    // Slots with items typically have 2 elements (background + item icon).
    // The hovered slot has an additional highlight element (3+ elements).
    // If exactly one slot in the matched column has more elements than the
    // others, that's our hovered slot — no mouse position needed.
    const hoveredByHighlight = this.detectHoveredSlotByHighlight(inventorySlots, elements);

    // Get mouse position for exact slot determination
    // Priority 0: Pre-captured mouse position (sampled right after render capture)
    // Priority 1: GL overlay mouse tracking (live sample - may have timing drift)
    // Priority 2: Render uniform mouse (unlikely to work - builtin is overlay-only)
    // Priority 3: Column-based proximity fallback
    let mousePos = preMousePos ?? null;
    if (!mousePos) {
      mousePos = this.glBridge.getMousePositionGL();
    }
    if (!mousePos) {
      const rawRenders = renders as unknown as RenderInvocation[];
      mousePos = renders ? findMousePosition(rawRenders) : null;
    }

    // ── Calibration mode: record mouse position for the target slot ──
    // When calibration is active and a tooltip is visible, we capture the
    // drifted mouse position as a reference sample for the current target slot.
    // We don't try to learn any items during calibration — just collect positions.
    if (this.calibrationActive && mousePos) {
      this.recordCalibrationSample(mousePos);
      return {
        isVisible: true,
        bounds: tooltipBounds,
        text: fullText,
        nearestSlot: this.calibrationTargetSlot < this.calibrationTotalSlots
          ? this.calibrationTargetSlot
          : null,
        confidence: 0,
      };
    }

    let hoveredSlot: number | null = null;
    let confidence = 0.5;
    let detectionMethod = 'none';

    // ── Determine tooltip column (reliable — tooltip X aligns with hovered column) ──
    const { columns } = this.gridConfig;
    const cellWidth = this.gridConfig.actualCellWidth || (this.gridConfig.slotWidth + 2);
    const tooltipCenterX = tooltipBounds.x + tooltipBounds.width / 2;
    let tooltipCol = -1;
    let bestColDist = Infinity;
    for (let c = 0; c < this.columnPositions.length; c++) {
      const colCenterX = this.columnPositions[c] + this.gridConfig.slotWidth / 2;
      const dist = Math.abs(tooltipCenterX - colCenterX);
      if (dist < bestColDist) {
        bestColDist = dist;
        tooltipCol = c;
      }
    }
    if (bestColDist > cellWidth * 1.5) tooltipCol = -1; // Too far — reject

    // ══════════════════════════════════════════════════════════════
    // SLOT DETECTION — Calibrated mouse ONLY.
    // Without calibration data, no slot detection occurs (avoids false data).
    // ══════════════════════════════════════════════════════════════

    if (mousePos && this.calibratedMousePositions.size > 0) {
      // ── CALIBRATED MODE (exclusive) ──
      // Match current mouse position against recorded reference positions.
      let bestDist = Infinity;
      let bestCalSlot: number | null = null;
      for (const [slotIdx] of this.calibratedMousePositions) {
        const calPos = this.getCalibratedPosition(slotIdx);
        if (!calPos) continue;
        const dx = mousePos.x - calPos.x;
        const dy = mousePos.y - calPos.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < bestDist) {
          bestDist = dist;
          bestCalSlot = slotIdx;
        }
      }
      // Accept if reasonably close (within 1.5x cell diagonal)
      const cellDiag = Math.sqrt(cellWidth * cellWidth + (this.gridConfig.actualCellHeight || this.gridConfig.slotHeight) ** 2);
      if (bestCalSlot !== null && bestDist < cellDiag * 1.5) {
        hoveredSlot = bestCalSlot;
        confidence = 0.95;
        detectionMethod = 'calibrated';
        const calCol = bestCalSlot % columns;
        console.log(`[TooltipLearner] CALIBRATED: slot ${hoveredSlot + 1} (dist=${bestDist.toFixed(0)}px, col=${calCol}, tooltipCol=${tooltipCol})`);
      } else {
        console.log(`[TooltipLearner] CALIBRATED: no match within range (bestDist=${bestDist.toFixed(0)}px, threshold=${(cellDiag * 1.5).toFixed(0)}px)`);
      }
    } else {
      // ── NO CALIBRATION — skip slot detection entirely ──
      // Heuristic fallbacks (highlight, single-in-column, exact-mouse, column-Y)
      // produce unreliable data. Only calibrated mouse positions are trusted.
      if (!mousePos) {
        console.log(`[TooltipLearner] No mouse position available — skipping slot detection`);
      } else {
        console.log(`[TooltipLearner] No calibration data — skipping slot detection. Run calibration first.`);
      }
    }

    // If we found a slot with an item, learn the association
    // Use itemName (colored text) for learning, which is the actual item name without action verbs
    const nameToLearn = itemName || fullText;
    if (hoveredSlot !== null && nameToLearn && nameToLearn.length > 0) {
      // Filter out known UI dialog text that isn't an item
      const isRejected = TooltipItemLearner.REJECTED_PATTERNS.some(p => p.test(nameToLearn));
      const isInstruction = TooltipItemLearner.isInstructionalText(nameToLearn);
      if (isRejected || isInstruction) {
        console.log(`[TooltipLearner] Rejected ${isRejected ? 'UI pattern' : 'instructional text'}: "${nameToLearn}"`);
        return {
          isVisible: true,
          bounds: tooltipBounds,
          text: fullText,
          nearestSlot: hoveredSlot,
          confidence: 0,
        };
      }

      // Filter out non-inventory tooltips (NPC/world context menus)
      // If no inventory verb was stripped (itemName = first line) AND tooltip has "+X options",
      // this is likely a right-click context menu, not an inventory hover
      const firstLine = fullText?.split('\n')[0]?.trim() ?? '';
      const hasContextMenu = fullText ? /\+\d+ options/.test(fullText) : false;
      const verbWasStripped = itemName !== null && itemName !== firstLine;

      if (!verbWasStripped && hasContextMenu) {
        console.log(`[TooltipLearner] Skipping non-inventory tooltip: "${firstLine}" (context menu with no inventory verb)`);
      } else {
        let slotInfo = inventorySlots.find(s => s.slot === hoveredSlot);
        const { columns } = this.gridConfig;
        const col = hoveredSlot! % columns;

        // ── pHash intersection matching ──
        // Collect pHashes of all items in this column. Each time we see the same
        // tooltip name, intersect with previous candidates. When only 1 pHash
        // remains, we know exactly which slot has this item — no mouse Y needed.
        const columnSlotsWithItems = inventorySlots.filter(s =>
          (s.slot % columns) === col && s.iconHash !== 0 && s.pHash
        );
        const currentColumnPHashes = new Set(columnSlotsWithItems.map(s => s.pHash!));

        if (currentColumnPHashes.size > 0) {
          const existing = this.namePHashCandidates.get(nameToLearn);
          if (existing) {
            // Intersect: keep only pHashes that appear in both sets
            const intersection = new Set<string>();
            for (const ph of existing) {
              if (currentColumnPHashes.has(ph)) intersection.add(ph);
            }
            this.namePHashCandidates.set(nameToLearn, intersection);
            console.log(`[pHashMatch] "${nameToLearn}": intersected ${existing.size} × ${currentColumnPHashes.size} → ${intersection.size} candidates`);

            // If narrowed to exactly 1 pHash, find the slot with that pHash
            if (intersection.size === 1) {
              const matchedPHash = Array.from(intersection)[0];
              const matchedSlot = columnSlotsWithItems.find(s => s.pHash === matchedPHash);
              if (matchedSlot) {
                console.log(`[pHashMatch] "${nameToLearn}" resolved to slot ${matchedSlot.slot + 1} via pHash ${matchedPHash}`);
                slotInfo = matchedSlot;
                hoveredSlot = matchedSlot.slot;
                confidence = 0.92;
              }
            }
          } else {
            // First sighting: record all column pHashes as initial candidates
            this.namePHashCandidates.set(nameToLearn, currentColumnPHashes);
            console.log(`[pHashMatch] "${nameToLearn}": first sighting, ${currentColumnPHashes.size} candidates in col ${col}`);
          }
        }

        // Elimination fallback: if this name is new (not yet learned) and the
        // mouse-Y-picked slot already has a known item, try to find the correct
        // slot by elimination. Look for slots in the same column that have items
        // but no learned name yet — if only one such slot exists, it must be
        // the one being hovered.
        if (slotInfo && slotInfo.iconHash !== 0) {
          const alreadyKnown = this.learnedItems.get(slotInfo.iconHash);
          const nameAlreadyLearned = Array.from(this.learnedItems.values()).some(i => i.name === nameToLearn);

          if (!nameAlreadyLearned && alreadyKnown && alreadyKnown.name !== nameToLearn) {
            // The mouse-Y-picked slot already has a different learned name.
            // Try elimination: find unlearned slots in the same column with items.
            const allColumnSlotsWithItems = inventorySlots.filter(s =>
              (s.slot % columns) === col && s.iconHash !== 0
            );
            const unlearnedInColumn = allColumnSlotsWithItems.filter(s =>
              !this.learnedItems.has(s.iconHash)
            );

            if (unlearnedInColumn.length === 1) {
              // Only one unlearned slot in this column — must be the hovered item
              console.log(`[TooltipLearner] Elimination: "${nameToLearn}" must be slot ${unlearnedInColumn[0].slot + 1} (only unlearned slot in col ${col})`);
              slotInfo = unlearnedInColumn[0];
              hoveredSlot = slotInfo.slot;
            } else if (unlearnedInColumn.length > 1) {
              console.log(`[TooltipLearner] Elimination: ${unlearnedInColumn.length} unlearned slots in col ${col}, can't disambiguate yet`);
            }
          }
        }

        if (slotInfo && slotInfo.iconHash !== 0) {
          // ── pHash Validation Gate ──
          // Before learning, validate the guessed slot using pHash stability.
          // If the slot's pHash has been stable across multiple frames, the item
          // hasn't moved and we can confidently assign the tooltip name to it.
          // This is the core "hover → guess → validate → assign" flow.
          const validation = this.validateSlotByPHash(hoveredSlot!, inventorySlots);

          if (validation.valid && validation.pHash) {
            // pHash is stable — bypass voting, learn immediately with high confidence
            console.log(`[pHashValidation] Slot ${hoveredSlot! + 1} VALIDATED (pHash: ${validation.pHash}) — learning "${nameToLearn}" immediately`);

            // Check if already learned this exact mapping
            const existing = this.learnedItems.get(slotInfo.iconHash);
            if (existing && existing.name === nameToLearn) {
              // Already known — skip
            } else {
              // Check if name is already learned for a different hash
              const nameAlreadyLearned = Array.from(this.learnedItems.values()).some(i => i.name === nameToLearn);
              if (!nameAlreadyLearned) {
                const learnedItem: LearnedItem = {
                  name: nameToLearn,
                  iconHash: slotInfo.iconHash,
                  pHash: validation.pHash,
                  learnedAt: Date.now(),
                  confidence: 0.95,
                  source: 'tooltip',
                };
                this.learnedItems.set(slotInfo.iconHash, learnedItem);
                if (validation.pHash) {
                  this.pHashIndex.set(validation.pHash, learnedItem);
                }
                // Notify listeners
                for (const listener of this.listeners) {
                  try { listener(learnedItem); } catch (e) { console.error('[TooltipLearner] Listener error:', e); }
                }
                // Clear any pending votes for this name (no longer needed)
                this.slotVotes.delete(nameToLearn);
                console.log(`[TooltipLearner] ✓ Learned "${nameToLearn}" via pHash validation (slot ${hoveredSlot! + 1}, pHash: ${validation.pHash}, iconHash: ${slotInfo.iconHash})`);
              } else {
                console.log(`[TooltipLearner] "${nameToLearn}" already learned for different hash — skipping`);
              }
            }
          } else {
            // pHash not stable yet — fall back to voting system
            console.log(`[pHashValidation] Slot ${hoveredSlot! + 1} NOT validated: ${validation.reason} — using vote system`);
            this.learnItemSync(slotInfo, nameToLearn);
          }

          console.log(`[TooltipLearner] Processing slot ${hoveredSlot! + 1}: "${nameToLearn}" (method: ${detectionMethod}, itemName: "${itemName}", fullText: "${fullText}")`);
        }
      }
    }

    return {
      isVisible: true,
      bounds: tooltipBounds,
      text: fullText,  // Return full text for display, but learn with itemName
      nearestSlot: hoveredSlot,
      confidence,
    };
  }

  /**
   * Get the inventory slot at a specific screen position (exact mouse position)
   * Uses actual detected positions when available for accuracy.
   */
  private getSlotAtPosition(x: number, y: number): number | null {
    const { slotWidth, slotHeight, columns, actualCellWidth, actualCellHeight } = this.gridConfig;

    // X tolerance: half cell step (tight — don't skip columns).
    // Y tolerance: 2x cell step — slot sprite Y is the bottom edge (GL botleft vertex),
    // so the mouse hovering top-row items can be 70+ px above the sprite Y due to
    // inventory panel header offset. Must be generous to match correctly.
    const hitHalfW = (actualCellWidth > 0 ? actualCellWidth : slotWidth) / 2;
    const hitMaxY = (actualCellHeight > 0 ? actualCellHeight : slotHeight) * 2;

    // Use actual detected positions if available
    if (this.columnPositions.length > 0 && this.rowPositions.length > 0) {
      // Find closest column
      let bestCol = -1;
      let bestColDist = Infinity;
      for (let c = 0; c < this.columnPositions.length; c++) {
        const colCenter = this.columnPositions[c] + slotWidth / 2;
        const dist = Math.abs(x - colCenter);
        if (dist < bestColDist && dist <= hitHalfW) {
          bestColDist = dist;
          bestCol = c;
        }
      }

      // Find closest row (rowPositions[0] = highest Y = row 0)
      let bestRow = -1;
      let bestRowDist = Infinity;
      for (let r = 0; r < this.rowPositions.length; r++) {
        const rowCenter = this.rowPositions[r] + slotHeight / 2;
        const dist = Math.abs(y - rowCenter);
        if (dist < bestRowDist && dist <= hitMaxY) {
          bestRowDist = dist;
          bestRow = r;
        }
      }

      if (bestCol >= 0 && bestRow >= 0) {
        return bestRow * columns + bestCol;
      }
      return null;
    }

    // Fallback: step-based calculation
    const { startX, startY, rows, actualGridTopY } = this.gridConfig;
    const cellWidth = actualCellWidth > 0 ? actualCellWidth : (slotWidth + 2);
    const cellHeight = actualCellHeight > 0 ? actualCellHeight : (slotHeight + 2);
    const gridTopY = actualGridTopY > 0 ? actualGridTopY : startY;

    // RS3 Y-up: row 0 at gridTopY, row N at bottom
    const col = Math.floor((x - startX + cellWidth / 2) / cellWidth);
    const row = Math.floor((gridTopY - y + cellHeight / 2) / cellHeight);

    if (col < 0 || col >= columns || row < 0 || row >= rows) {
      return null;
    }

    return row * columns + col;
  }

  /**
   * Find nearest inventory slot with generous tolerance for mouse tracking.
   * The overlay DLL sends cursor position at frame-swap time, but by then
   * the user may have moved the cursor 50-150px past the slot they hovered.
   * This method finds the nearest slot within a wide radius (3x cell step)
   * so we can remember which slot was "recently near" the cursor.
   */
  private getNearestSlotGenerous(x: number, y: number): number | null {
    const { slotWidth, slotHeight, columns, actualCellWidth, actualCellHeight } = this.gridConfig;

    if (this.columnPositions.length === 0 || this.rowPositions.length === 0) return null;

    // X tolerance: 1.5x cell step — specific enough to not skip columns.
    // Y tolerance: 2.5x cell step — needs to be generous because slot sprite Y
    // is the bottom edge (GL botleft vertex), and the mouse hovering top-row items
    // can be 70+ px above the sprite Y due to inventory panel header offset.
    const maxColDist = (actualCellWidth > 0 ? actualCellWidth : slotWidth) * 1.5;
    const maxRowDist = (actualCellHeight > 0 ? actualCellHeight : slotHeight) * 2.5;

    // Find closest column
    let bestCol = -1;
    let bestColDist = Infinity;
    for (let c = 0; c < this.columnPositions.length; c++) {
      const colCenter = this.columnPositions[c] + slotWidth / 2;
      const dist = Math.abs(x - colCenter);
      if (dist < bestColDist) {
        bestColDist = dist;
        bestCol = c;
      }
    }
    if (bestCol < 0 || bestColDist > maxColDist) return null;

    // Find closest row
    let bestRow = -1;
    let bestRowDist = Infinity;
    for (let r = 0; r < this.rowPositions.length; r++) {
      const rowCenter = this.rowPositions[r] + slotHeight / 2;
      const dist = Math.abs(y - rowCenter);
      if (dist < bestRowDist) {
        bestRowDist = dist;
        bestRow = r;
      }
    }
    if (bestRow < 0 || bestRowDist > maxRowDist) return null;

    return bestRow * columns + bestCol;
  }

  /**
   * Detect tooltip by finding clusters of text characters
   * Fallback when tooltip sprite IDs don't match
   */
  private detectTooltipByTextCluster(elements: RenderRect[]): { x: number; y: number; width: number; height: number } | null {
    // Find all text elements (have fontchr), excluding shadow text
    const textElements = elements.filter(el => {
      if (!el.sprite.known?.fontchr) return false;
      // Filter out shadow text (very dark)
      const color = el.color;
      if (color && (color[1] ?? 0) < 15 && (color[2] ?? 0) < 15 && (color[3] ?? 0) < 15) {
        return false;
      }
      return true;
    });

    if (textElements.length < 3) return null;

    // Find inventory slots to know where inventory is
    const inventorySlots = elements.filter(
      el => el.sprite.known?.id === 18266 // Inventory slot sprite ID
    );

    if (inventorySlots.length === 0) return null;

    // Get inventory bounds
    const invMinX = Math.min(...inventorySlots.map(s => s.x));
    const invMaxX = Math.max(...inventorySlots.map(s => s.x + s.width));
    const invMinY = Math.min(...inventorySlots.map(s => s.y));
    const invMaxY = Math.max(...inventorySlots.map(s => s.y + s.height));

    // Look for text clusters NEAR the inventory (above, below, or overlapping)
    // Tooltips typically appear above the hovered item
    const searchArea = {
      x: invMinX - 200,
      y: invMinY - 150,  // Look above inventory
      width: (invMaxX - invMinX) + 400,
      height: (invMaxY - invMinY) + 300,
    };

    // Filter text elements in the search area
    const nearbyText = textElements.filter(el =>
      el.x >= searchArea.x && el.x <= searchArea.x + searchArea.width &&
      el.y >= searchArea.y && el.y <= searchArea.y + searchArea.height
    );

    if (nearbyText.length < 3) return null;

    // Group text by Y position to find lines
    const Y_TOLERANCE = 8;
    const lines: RenderRect[][] = [];
    const sorted = [...nearbyText].sort((a, b) => b.y - a.y); // Sort by Y desc

    let currentLine: RenderRect[] = [];
    let currentY = -Infinity;

    for (const el of sorted) {
      if (currentLine.length === 0 || Math.abs(el.y - currentY) <= Y_TOLERANCE) {
        currentLine.push(el);
        currentY = currentLine.reduce((sum, e) => sum + e.y, 0) / currentLine.length;
      } else {
        if (currentLine.length >= 2) lines.push(currentLine);
        currentLine = [el];
        currentY = el.y;
      }
    }
    if (currentLine.length >= 2) lines.push(currentLine);

    // Find clusters of 1-4 consecutive lines (typical tooltip size)
    for (let i = 0; i < lines.length; i++) {
      // Try clusters of 1-4 lines
      for (let numLines = 1; numLines <= Math.min(4, lines.length - i); numLines++) {
        const cluster = lines.slice(i, i + numLines);
        const allChars = cluster.flat();

        // Calculate bounds
        const minX = Math.min(...allChars.map(c => c.x));
        const maxX = Math.max(...allChars.map(c => c.x + c.width));
        const minY = Math.min(...allChars.map(c => c.y));
        const maxY = Math.max(...allChars.map(c => c.y + c.height));

        const width = maxX - minX;
        const height = maxY - minY;

        // Tooltip should be reasonably sized (not too wide, not too tall)
        if (width < 30 || width > 350) continue;
        if (height < 8 || height > 150) continue;

        // Should have reasonable character density (not scattered UI text)
        const charDensity = allChars.length / (width * height) * 1000;
        if (charDensity < 0.1) continue; // Too sparse

        // Validate text content - tooltip should have actual words, not just numbers/symbols
        const clusterText = allChars
          .map(c => this.getFontChar(c.sprite.known?.fontchr))
          .join('');

        // Skip if text is mostly numbers/punctuation (like "/6600" or "123")
        const letterCount = (clusterText.match(/[a-zA-Z]/g) || []).length;
        const totalCount = clusterText.length;
        if (letterCount < 2 || letterCount / totalCount < 0.3) {
          continue; // Not enough letters - probably not a tooltip
        }

        // Check if this cluster is near an inventory slot
        const clusterCenterX = (minX + maxX) / 2;
        const clusterBottom = minY;

        // Tooltip should be above or near inventory items
        for (const slot of inventorySlots) {
          const slotCenterX = slot.x + slot.width / 2;
          const slotTop = slot.y + slot.height;

          // Check horizontal alignment and vertical proximity
          const dx = Math.abs(clusterCenterX - slotCenterX);
          const dy = clusterBottom - slotTop; // Positive = tooltip above slot

          if (dx < 100 && dy > -50 && dy < 150) {
            // Found a good candidate
            console.log(`[TooltipLearner] Fallback found: "${clusterText}" (${letterCount}/${totalCount} letters)`);
            return {
              x: minX - 5,
              y: minY - 5,
              width: width + 10,
              height: height + 10,
            };
          }
        }
      }
    }

    return null;
  }

  /**
   * Calculate the bounding box of tooltip sprites
   * Looks for a small cluster of tooltip sprites (actual tooltip, not whole UI)
   */
  private calculateTooltipBounds(elements: RenderRect[]): { x: number; y: number; width: number; height: number } | null {
    if (elements.length === 0) return null;

    // Look for the center sprite (35516) first - it's most indicative of actual tooltip
    const centerSprites = elements.filter(el => el.sprite.known?.id === TOOLTIP_SPRITE_IDS.center);
    console.log(`[calculateTooltipBounds] ${elements.length} tooltip elements, ${centerSprites.length} center sprites`);

    if (centerSprites.length > 0) {
      // Find the smallest cluster around a center sprite
      for (const center of centerSprites) {
        // Look for other tooltip sprites near this center (within 300px)
        const nearby = elements.filter(el => {
          const dx = Math.abs(el.x - center.x);
          const dy = Math.abs(el.y - center.y);
          return dx < 300 && dy < 200; // Tooltip shouldn't be huge
        });

        console.log(`[calculateTooltipBounds] Center at (${center.x.toFixed(0)},${center.y.toFixed(0)}) has ${nearby.length} nearby`);

        if (nearby.length >= 2) {
          // Calculate bounds of this cluster
          let minX = Infinity, minY = Infinity;
          let maxX = -Infinity, maxY = -Infinity;

          for (const el of nearby) {
            minX = Math.min(minX, el.x);
            minY = Math.min(minY, el.y);
            maxX = Math.max(maxX, el.x + el.width);
            maxY = Math.max(maxY, el.y + el.height);
          }

          const width = maxX - minX;
          const height = maxY - minY;

          console.log(`[calculateTooltipBounds] Cluster bounds: ${width.toFixed(0)}x${height.toFixed(0)}`);

          // Tooltip should be reasonably sized (not a huge UI panel)
          if (width < 400 && height < 300 && width > 20 && height > 10) {
            return { x: minX, y: minY, width, height };
          } else {
            console.log(`[calculateTooltipBounds] Rejected - size out of range`);
          }
        }
      }
    }

    // Fallback: find any small cluster of tooltip sprites
    // Group sprites by proximity
    console.log(`[calculateTooltipBounds] Trying fallback cluster detection...`);
    let bestCluster: { x: number; y: number; width: number; height: number } | null = null;
    let smallestArea = Infinity;

    for (const el of elements) {
      const nearby = elements.filter(other => {
        const dx = Math.abs(other.x - el.x);
        const dy = Math.abs(other.y - el.y);
        return dx < 200 && dy < 150;
      });

      if (nearby.length >= 2) {
        let minX = Infinity, minY = Infinity;
        let maxX = -Infinity, maxY = -Infinity;

        for (const n of nearby) {
          minX = Math.min(minX, n.x);
          minY = Math.min(minY, n.y);
          maxX = Math.max(maxX, n.x + n.width);
          maxY = Math.max(maxY, n.y + n.height);
        }

        const width = maxX - minX;
        const height = maxY - minY;
        const area = width * height;

        if (width < 350 && height < 250 && width > 20 && height > 10) {
          if (area < smallestArea) {
            smallestArea = area;
            bestCluster = { x: minX, y: minY, width, height };
          }
        }
      }
    }

    if (bestCluster) {
      console.log(`[calculateTooltipBounds] Found cluster: ${bestCluster.width.toFixed(0)}x${bestCluster.height.toFixed(0)}`);
      return bestCluster;
    }

    console.log(`[calculateTooltipBounds] No valid cluster found`);
    return null;
  }

  /**
   * Extract the character from a fontchr object
   * fontchr can be an object with { chr: string } or sometimes a string directly
   */
  private getFontChar(fontchr: any): string {
    if (!fontchr) return '';
    if (typeof fontchr === 'string') return fontchr;
    if (typeof fontchr === 'object' && fontchr.chr) return fontchr.chr;
    return '';
  }

  /**
   * Check if text element is shadow (black/dark text rendered behind main text)
   * Color format: [A, B, G, R] (ABGR order from RS3 renderer)
   */
  private isShadowText(color: number[] | undefined): boolean {
    if (!color || !Array.isArray(color)) return false;
    // Shadow is very dark: B < 15, G < 15, R < 15
    // ABGR: [0]=A, [1]=B, [2]=G, [3]=R
    return (color[1] ?? 0) < 15 && (color[2] ?? 0) < 15 && (color[3] ?? 0) < 15;
  }

  /**
   * Normalize a color value to 0-255 range
   * Handles cases where colors are in 0-65025 range (255² due to conversion bug)
   */
  private normalizeColorValue(value: number): number {
    if (value > 255) {
      // Colors are in 0-65025 range (255²), need to sqrt and normalize
      return Math.round(Math.sqrt(value));
    }
    return value;
  }

  /**
   * Check if text element is "colored" (not white/gray)
   * Colored text in RS3 tooltips indicates the item name
   * Color format: [A, B, G, R] (ABGR order)
   *
   * Examples:
   * - Orange (Shark): R~255, G~150, B~0 -> spread=255, clearly colored
   * - Light cyan (Sapphire ring): R~200, G~220, B~255 -> spread=55, colored
   * - White (action verbs): R~200, G~200, B~200 -> spread<15, not colored
   */
  private isColoredText(color: number[] | undefined): boolean {
    if (!color || !Array.isArray(color)) return false;

    // ABGR: [0]=A, [1]=B, [2]=G, [3]=R
    // Normalize values in case they're in 0-65025 range
    const b = this.normalizeColorValue(color[1] ?? 0);
    const g = this.normalizeColorValue(color[2] ?? 0);
    const r = this.normalizeColorValue(color[3] ?? 0);

    // Calculate color characteristics
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const spread = max - min;

    // Calculate how "gray" the color is (how close R, G, B are to each other)
    const avgColor = (r + g + b) / 3;
    const rDiff = Math.abs(r - avgColor);
    const gDiff = Math.abs(g - avgColor);
    const bDiff = Math.abs(b - avgColor);
    const maxDiff = Math.max(rDiff, gDiff, bDiff);

    // White/gray text: all channels are very similar (maxDiff < 15) and bright (avg > 140)
    // This catches pure white and light gray action verb text
    if (maxDiff < 15 && avgColor > 140) {
      return false; // White/gray text (like "Wear", "Eat", "Use")
    }

    // Colored text: any noticeable tint (spread >= 20 OR one channel differs by >= 15)
    // This catches both strong colors (orange) and subtle tints (light cyan, pale blue)
    if (spread >= 20 || maxDiff >= 15) {
      return true; // Colored text (like "Shark", "Sapphire ring")
    }

    // Default: if it's dark or has any color variation, treat as colored
    return avgColor < 140 || spread > 10;
  }

  /**
   * Extract just the item name from the first line of tooltip
   * The item name is the COLORED text (orange/yellow/cyan/etc), not the action verb (white/gray)
   * Example: "Eat Shark" -> "Shark" (Shark is orange, Eat is white)
   * Example: "Wear Sapphire ring" -> "Sapphire ring" (cyan tint, Wear is white)
   */
  private extractItemNameFromFirstLine(lineChars: RenderRect[], gapThreshold: number): string {
    // Sort by X within line
    const sorted = [...lineChars].sort((a, b) => a.x - b.x);

    let itemName = '';
    let prevEl: RenderRect | null = null;
    let prevChar = '';
    let inColoredSection = false;
    let debugColors: string[] = [];

    for (const el of sorted) {
      const thisChar = this.getFontChar(el.sprite.known!.fontchr);

      // Skip shadow duplicates
      if (prevEl && thisChar === prevChar && Math.abs(el.x - prevEl.x) <= 2) {
        continue;
      }

      const color = el.color as number[];
      const isColored = this.isColoredText(color);

      // Debug: log color info for first few characters (normalized values)
      if (debugColors.length < 15) {
        const r = this.normalizeColorValue(color?.[3] ?? 0);
        const g = this.normalizeColorValue(color?.[2] ?? 0);
        const b = this.normalizeColorValue(color?.[1] ?? 0);
        debugColors.push(`'${thisChar}':[R${r},G${g},B${b}]=${isColored ? 'COLOR' : 'white'}`);
      }

      // Once we hit colored text, start capturing
      if (isColored) {
        inColoredSection = true;

        // Add space if there's a gap
        if (prevEl && inColoredSection) {
          const prevEnd = prevEl.x + prevEl.width;
          const gap = el.x - prevEnd;
          if (gap >= gapThreshold) {
            itemName += ' ';
          }
        }

        itemName += thisChar;
        prevEl = el;
        prevChar = thisChar;
      } else if (inColoredSection) {
        // We were in colored section but hit non-colored - might be end of item name
        // But check if it's just a space gap
        if (prevEl) {
          const prevEnd = prevEl.x + prevEl.width;
          const gap = el.x - prevEnd;
          // If there's a significant gap after colored text and we hit white text, stop
          if (gap >= gapThreshold * 2) {
            break;
          }
        }
      }
    }

    console.log(`[ColorDetect] ${debugColors.join(', ')}`);

    // If no colored text found, fall back to full line extraction
    if (!itemName.trim()) {
      console.log(`[ColorDetect] No colored text found, using full line`);
      return this.extractLineText(sorted, gapThreshold);
    }

    console.log(`[ColorDetect] Extracted colored item name: "${itemName.trim()}"`);
    return itemName.trim();
  }

  /**
   * Extract full text from a line of characters
   */
  private extractLineText(lineChars: RenderRect[], gapThreshold: number): string {
    let lineText = '';
    let prevEl: RenderRect | null = null;
    let prevChar = '';

    for (const el of lineChars) {
      const thisChar = this.getFontChar(el.sprite.known!.fontchr);

      // Skip shadow duplicates
      if (prevEl && thisChar === prevChar && Math.abs(el.x - prevEl.x) <= 2) {
        continue;
      }

      // Detect space
      if (prevEl) {
        const prevEnd = prevEl.x + prevEl.width;
        const gap = el.x - prevEnd;
        if (gap >= gapThreshold) {
          lineText += ' ';
        }
      }

      lineText += thisChar;
      prevEl = el;
      prevChar = thisChar;
    }

    return lineText;
  }

  /**
   * Extract text from elements within the tooltip bounds
   * Uses custom text extraction with font-size-aware spacing detection
   * Returns both full tooltip text and the extracted item name (colored text from first line)
   */
  private extractTooltipText(elements: RenderRect[], bounds: { x: number; y: number; width: number; height: number }): { fullText: string | null, itemName: string | null } {
    // Filter elements to those STRICTLY within tooltip bounds
    // Use minimal padding - tooltip text should be inside the tooltip box
    const padding = 10; // Small padding for edge characters

    const tooltipElements = elements.filter(el => {
      return (
        el.x >= bounds.x - padding &&
        el.x <= bounds.x + bounds.width + padding &&
        el.y >= bounds.y - padding &&
        el.y <= bounds.y + bounds.height + padding
      );
    });

    if (tooltipElements.length === 0) return { fullText: null, itemName: null };

    // Font ID 494 is the action bar countdown font - filter it out
    const ACTION_BAR_FONT_ID = 494;

    // Get only font elements, filter shadows and action bar font, sort by position
    // Use same Y_LINE_TOLERANCE for initial sort to keep same-line chars together
    const SORT_Y_TOLERANCE = 6;
    const fontElements = tooltipElements
      .filter(el => {
        // Must have font character
        if (!el.sprite.known?.fontchr) return false;
        // Filter out shadow text
        if (this.isShadowText(el.color as number[])) return false;
        // Filter out action bar font (ID 494)
        const fontId = el.sprite.known?.font?.basesprite?.id;
        if (fontId === ACTION_BAR_FONT_ID) {
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        // Sort by Y descending (higher Y = top in RS3), then X ascending
        // Use tolerance so same-line characters stay together regardless of minor Y differences
        const yDiff = b.y - a.y;
        if (Math.abs(yDiff) > SORT_Y_TOLERANCE) return yDiff;
        return a.x - b.x;
      });

    if (fontElements.length === 0) return { fullText: null, itemName: null };

    // Group into lines by Y position
    // IMPORTANT: Y tolerance must be generous because:
    // - Characters like 'g', 'p', 'y' have descenders that shift Y position
    // - Apostrophes/quotes are rendered at different Y than base text
    // - Font rendering can have minor Y variations
    const Y_LINE_TOLERANCE = 12;
    const lines: RenderRect[][] = [];
    let currentLine: RenderRect[] = [];
    let currentLineY = -Infinity;

    for (const el of fontElements) {
      if (currentLine.length === 0 || Math.abs(el.y - currentLineY) <= Y_LINE_TOLERANCE) {
        currentLine.push(el);
        // Update line Y to be the average of all elements for better tolerance
        if (currentLine.length === 1) {
          currentLineY = el.y;
        } else {
          currentLineY = currentLine.reduce((sum, e) => sum + e.y, 0) / currentLine.length;
        }
      } else {
        if (currentLine.length > 0) lines.push(currentLine);
        currentLine = [el];
        currentLineY = el.y;
      }
    }
    if (currentLine.length > 0) lines.push(currentLine);

    // Post-process: merge lines that are very close in Y (within tolerance)
    // This catches cases where characters were initially put in separate groups
    const mergedLines: RenderRect[][] = [];
    for (const line of lines) {
      const lineAvgY = line.reduce((sum, el) => sum + el.y, 0) / line.length;

      // Check if this line should merge with the previous one
      if (mergedLines.length > 0) {
        const prevLine = mergedLines[mergedLines.length - 1];
        const prevAvgY = prevLine.reduce((sum, el) => sum + el.y, 0) / prevLine.length;

        if (Math.abs(lineAvgY - prevAvgY) <= Y_LINE_TOLERANCE) {
          // Merge with previous line
          prevLine.push(...line);
          console.log(`[Tooltip] Merged line at Y=${lineAvgY.toFixed(0)} with previous at Y=${prevAvgY.toFixed(0)}`);
          continue;
        }
      }
      mergedLines.push([...line]);
    }

    console.log(`[Tooltip] Line grouping: ${lines.length} initial → ${mergedLines.length} merged (tolerance=${Y_LINE_TOLERANCE}px)`);

    // Process each line with smart spacing
    const textLines: { y: number; text: string }[] = [];

    for (const lineChars of mergedLines) {
      // Sort by X within line
      lineChars.sort((a, b) => a.x - b.x);

      // Detect which font/sprite sheet is being used
      const fontId = lineChars[0]?.sprite.known?.font?.basesprite?.id;
      const avgHeight = lineChars.reduce((sum, el) => sum + el.height, 0) / lineChars.length;

      // Font-specific gap thresholds based on sprite sheet
      // IMPORTANT: 1px is TOO SMALL - it detects inter-letter kerning as spaces
      // Minimum should be 2px for small fonts, 3px for unknown fonts
      let gapThreshold: number;
      if (fontId && fontId > 0) {
        // Known font IDs and their optimal gap thresholds
        // These are tuned based on the actual font metrics
        const fontGapThresholds: Record<number, number> = {
          // Small fonts (10pt-14pt) - use 2px minimum
          645: 2,    // chat10pt or similar
          646: 2,
          647: 2,    // chat12pt
          648: 2,    // chat14pt
          // Medium fonts (16pt-18pt)
          649: 3,
          650: 3,
          // Large fonts (20pt-22pt) - wider spacing
          651: 3,
          652: 3,
        };
        gapThreshold = fontGapThresholds[fontId] ?? Math.max(2, Math.round(avgHeight * 0.25));
        console.log(`[Tooltip] Using font ID ${fontId}, gap threshold: ${gapThreshold}px`);
      } else {
        // Unknown/fallback font (fontId -1 or undefined)
        // Use 3px like dialog reader - this is the proven working threshold
        // For very small fonts (< 10px height), use 2px
        gapThreshold = avgHeight < 10 ? 2 : 3;
        console.log(`[Tooltip] Unknown font (ID ${fontId}), using conservative gap threshold: ${gapThreshold}px (avgH=${avgHeight.toFixed(1)})`);
      }

      let lineText = '';
      let prevEl: RenderRect | null = null;
      let prevChar = '';

      for (const el of lineChars) {
        const thisChar = this.getFontChar(el.sprite.known!.fontchr);

        // Skip shadow duplicates: same character within 2 pixels of previous
        // Shadow text is rendered at X-1 or X+1 offset with same character
        if (prevEl && thisChar === prevChar && Math.abs(el.x - prevEl.x) <= 2) {
          continue;
        }

        // Detect space: gap between end of prev char and start of this char
        if (prevEl) {
          const prevEnd = prevEl.x + prevEl.width;
          const gap = el.x - prevEnd;
          if (gap >= gapThreshold) {
            lineText += ' ';
          }
        }

        lineText += thisChar;
        prevEl = el;
        prevChar = thisChar;
      }

      if (lineText.trim()) {
        textLines.push({ y: lineChars[0].y, text: lineText });
        console.log(`[Tooltip] Line Y=${lineChars[0].y.toFixed(0)} avgH=${avgHeight.toFixed(1)} gap=${gapThreshold}px: "${lineText}"`);
      }
    }

    if (textLines.length === 0) return { fullText: null, itemName: null };

    // Sort lines by Y descending (top to bottom in RS3)
    textLines.sort((a, b) => b.y - a.y);

    console.log(`[Tooltip] Pre-autoSpace lines: ${JSON.stringify(textLines.map(l => `Y${l.y.toFixed(0)}: "${l.text}"`))}`);

    // Apply auto-spacing post-processing to fix common patterns
    const processedLines = textLines.map(l => ({
      y: l.y,
      text: this.autoSpaceText(l.text)
    }));

    console.log(`[Tooltip] Post-autoSpace lines: ${JSON.stringify(processedLines.map(l => `Y${l.y.toFixed(0)}: "${l.text}"`))}`);

    const fullText = processedLines.map(l => l.text).join('\n') || null;

    // Extract item name from the first MEANINGFUL line
    // Skip lines that are just punctuation, very short, or clearly not item names
    // PRIMARY METHOD: Remove action verbs from the beginning (most reliable)
    // FALLBACK: Use color detection for colored text
    let itemName: string | null = null;

    // Find the first meaningful line (not just punctuation or very short)
    const meaningfulLine = processedLines.find(line => {
      const text = line.text.trim();
      // Skip if too short (less than 3 chars)
      if (text.length < 3) return false;
      // Skip if it's just punctuation
      if (/^['".,;:!?+\-\s]+$/.test(text)) return false;
      // Skip if it starts with + (like "+3 options")
      if (text.startsWith('+')) return false;
      return true;
    });

    if (meaningfulLine) {
      const firstLine = meaningfulLine.text;
      console.log(`[Tooltip] First meaningful line for item extraction: "${firstLine}"`);

      // Common action verbs that precede item names in RS3 tooltips
      // Longer phrases first so "Get info" matches before "Get"
      const actionVerbs = [
        'Get info', 'String', 'Unstring',
        'Eat', 'Use', 'Wear', 'Wield', 'Equip', 'Remove', 'Drop', 'Examine',
        'Drink', 'Read', 'Open', 'Close', 'Light', 'Extinguish', 'Empty',
        'Fill', 'Check', 'Activate', 'Deactivate', 'Bury', 'Scatter',
        'Cast', 'Plant', 'Pick', 'Harvest', 'Info',
        'Clean', 'Crush', 'Grind', 'Mix', 'Add', 'Combine', 'Split',
        'Craft', 'Fletch', 'Smith', 'Cook', 'Burn', 'Cut', 'Chop',
        'Mine', 'Smelt', 'Spin', 'Weave', 'Tan', 'Chip',
        'Rub', 'Break', 'Destroy', 'Disassemble', 'Dismantle',
        'Teleport', 'Configure', 'Adjust', 'Set', 'Tune',
        'Summon', 'Dismiss', 'Feed', 'Interact', 'Play',
        'Claim', 'Redeem', 'Inspect', 'Study', 'Investigate',
        'Sip', 'Apply', 'Invoke', 'Boost', 'Restore',
        'Assemble', 'Repair', 'Charge', 'Uncharge',
        'Toggle', 'Switch', 'Brandish', 'Flourish',
        'Offer', 'Sacrifice', 'Release',
      ];

      // Try to extract item name by removing action verb
      for (const verb of actionVerbs) {
        if (firstLine.toLowerCase().startsWith(verb.toLowerCase() + ' ')) {
          itemName = firstLine.substring(verb.length + 1).trim();
          console.log(`[Tooltip] Extracted item name by removing verb "${verb}": "${itemName}"`);
          break;
        }
      }

      // If no action verb found, the first line might just be the item name
      // (for items with no default action shown, or special tooltips)
      if (!itemName) {
        // Check if the line looks like an item name (not "+X options" or other UI text)
        if (!firstLine.startsWith('+') && !firstLine.match(/^\d/)) {
          itemName = firstLine;
          console.log(`[Tooltip] Using first line as item name (no verb): "${itemName}"`);
        }
      }
    }

    // FALLBACK: Try color-based extraction if verb method didn't work
    if (!itemName && meaningfulLine) {
      const targetY = meaningfulLine.y;
      const targetLineChars = mergedLines.find(line => {
        const avgY = line.reduce((sum, el) => sum + el.y, 0) / line.length;
        return Math.abs(avgY - targetY) < 15; // Use larger tolerance for matching
      });

      if (targetLineChars && targetLineChars.length > 0) {
        const avgHeight = targetLineChars.reduce((sum, el) => sum + el.height, 0) / targetLineChars.length;
        const gapThreshold = avgHeight < 10 ? 2 : 3;
        itemName = this.extractItemNameFromFirstLine(targetLineChars, gapThreshold);
        if (itemName) {
          itemName = this.autoSpaceText(itemName);
          console.log(`[Tooltip] Extracted item name by color: "${itemName}"`);
        }
      }
    }

    // Final sanitization: handle "X -> Y" arrow pattern in any extraction path
    // This occurs when an item is selected and you hover another (or same) item
    // e.g. "Avantoe seed -> Avantoe seed" — extract the target (right side)
    if (itemName && itemName.includes('->')) {
      const arrowParts = itemName.split('->').map(s => s.trim());
      if (arrowParts.length >= 2 && arrowParts[1].length > 0) {
        console.log(`[Tooltip] Arrow pattern in final name: "${itemName}" → using target: "${arrowParts[1]}"`);
        itemName = arrowParts[1];
      }
    }

    return { fullText, itemName };
  }

  /**
   * Auto-space text to fix common missing space patterns
   * Keeps 3px gap detection intact but adds pattern-based fixes
   */
  private autoSpaceText(text: string): string {
    let result = text;
    const charCodes: number[] = [];
    for (let i = 0; i < text.length; i++) {
      charCodes.push(text.charCodeAt(i));
    }
    console.log(`[AutoSpace] Input: "${text}" (length=${text.length}, chars=${charCodes.join(',')})`);

    // Rule 1: Add space between digit(s) and letter (e.g., "+4options" → "+4 options")
    const before1 = result;
    result = result.replace(/(\d)([a-zA-Z])/g, '$1 $2');
    if (result !== before1) console.log(`[AutoSpace] Rule1 (digit→letter): "${before1}" → "${result}"`);

    // Rule 2: Add space between letter and digit when it looks like quantity (e.g., "item10" → "item 10")
    // But be careful not to break things like "RS3" or "M1D1"
    const before2 = result;
    result = result.replace(/([a-z])(\d+)(?=[^a-zA-Z]|$)/gi, '$1 $2');
    if (result !== before2) console.log(`[AutoSpace] Rule2 (letter→digit): "${before2}" → "${result}"`);

    // Rule 3: Add space between lowercase and uppercase (camelCase → camel Case)
    // e.g., "ExoskeletonTorso" → "Exoskeleton Torso"
    const before3 = result;
    result = result.replace(/([a-z])([A-Z])/g, '$1 $2');
    if (result !== before3) console.log(`[AutoSpace] Rule3 (camelCase): "${before3}" → "${result}"`);

    // Rule 4: Common RS3 patterns - words that often get merged
    // Add space before common suffixes when preceded by lowercase
    // IMPORTANT: Must avoid breaking real words like "during", "bring", "boring", etc.
    const commonSuffixes = ['torso', 'helm', 'legs', 'boots', 'gloves', 'shield', 'sword', 'bow', 'staff', 'wand', 'orb', 'cape', 'amulet', 'necklace', 'bracelet', 'options', 'charges', 'uses'];
    // Separate handling for 'ring' - only split if preceded by typical item name endings
    const ringSafePattern = /([lnst])(ring)(?:\s|$)/gi; // Only split after l, n, s, t (e.g., "moonring", "goldring")

    for (const suffix of commonSuffixes) {
      // Match lowercase letter directly followed by suffix (case insensitive)
      const before4 = result;
      const pattern = new RegExp(`([a-z])(${suffix})`, 'gi');
      result = result.replace(pattern, '$1 $2');
      if (result !== before4) console.log(`[AutoSpace] Rule4 (suffix "${suffix}"): "${before4}" → "${result}"`);
    }

    // Handle 'ring' separately with more restrictive pattern
    const before4ring = result;
    result = result.replace(ringSafePattern, '$1 $2');
    if (result !== before4ring) console.log(`[AutoSpace] Rule4 (suffix "ring" safe): "${before4ring}" → "${result}"`);

    // Rule 5: Common RS3 prefixes that should have space after
    const commonPrefixes = ['Wear', 'Wield', 'Equip', 'Remove', 'Drop', 'Examine', 'Use', 'Eat', 'Drink', 'Read', 'Open', 'Close', 'Attack', 'Talk', 'Trade', 'Follow', 'Destroy'];
    for (const prefix of commonPrefixes) {
      // Match prefix directly followed by uppercase letter
      const before5 = result;
      const pattern = new RegExp(`^(${prefix})([A-Z])`, 'g');
      result = result.replace(pattern, '$1 $2');
      if (result !== before5) console.log(`[AutoSpace] Rule5 (prefix "${prefix}"): "${before5}" → "${result}"`);
    }

    // Rule 6: Aggressive fallback - look for known RS3 item name patterns
    // Match "Exoskeleton" specifically followed by armor piece
    const before6a = result;
    result = result.replace(/([Ee]xoskeleton)(torso|helm|legs|boots|gloves)/gi, '$1 $2');
    if (result !== before6a) console.log(`[AutoSpace] Rule6a (Exoskeleton): "${before6a}" → "${result}"`);

    // Rule 6b: Handle +Noptions pattern (right-click menu options count)
    const before6b = result;
    result = result.replace(/(\+\d+)(options)/gi, '$1 $2');
    if (result !== before6b) console.log(`[AutoSpace] Rule6b (+N options): "${before6b}" → "${result}"`);

    // Rule 6c: Handle common "XYZtorso", "XYZhelm" etc where XYZ ends in vowel or common consonant
    const before6c = result;
    result = result.replace(/([aeiousnrt])(torso|helm|legs|boots|gloves|shield|cape)(?![a-z])/gi, '$1 $2');
    if (result !== before6c) console.log(`[AutoSpace] Rule6c (armor piece): "${before6c}" → "${result}"`);

    // Rule 7: Fix orphaned trailing letters - when a character (apostrophe, accent, etc.)
    // is on a different Y-line, it causes letters to be separated from words.
    // Examples: "herring s ring" → "herrings ring", "level l :" → "levell :"
    // Pattern: word + space + single common trailing letter + (space or punctuation)
    // Common trailing letters: s, l, e, d, n, t, r, y (frequent word endings)
    const before7 = result;
    result = result.replace(/([a-zA-Z0-9]{2,}) ([sledintyhr])(?=[\s:;,.]|$)/gi, '$1$2');
    if (result !== before7) console.log(`[AutoSpace] Rule7 (orphaned trailing letter): "${before7}" → "${result}"`);

    // Rule 8: Fix spacing around colons - remove space before colon
    // Examples: "level :" → "level:", "Next level :" → "Next level:"
    const before8 = result;
    result = result.replace(/ +:/g, ':');
    if (result !== before8) console.log(`[AutoSpace] Rule8 (space before colon): "${before8}" → "${result}"`);

    // Rule 8b: Fix spacing in numbers - remove space before/after comma in numbers
    // Examples: "1 ,450" → "1,450", "2, 000" → "2,000"
    const before8b = result;
    result = result.replace(/(\d) +,/g, '$1,');  // "1 ," → "1,"
    result = result.replace(/,\s+(\d)/g, ',$1'); // ", 4" → ",4"
    if (result !== before8b) console.log(`[AutoSpace] Rule8b (number comma spacing): "${before8b}" → "${result}"`);

    // Rule 9: OCR word corrections - fix common character confusions (e/1/3, l/1)
    // The game uses fonts that aren't fully mapped, causing '1'↔'l'↔'e' and '3'↔'e'↔'v' confusion
    const ocrCorrections: [RegExp, string][] = [
      // "level" variations (very common in skills interface)
      [/\bl[1l]?[e3][v3][e3][l1]\b/gi, 'level'],
      [/\bl[1l]?[e3]v[e3][l1]\b/gi, 'level'],
      [/\bl1e3v1\b/gi, 'level'],
      [/\bleve1\b/gi, 'level'],
      [/\b1evel\b/gi, 'level'],
      [/\b1eve1\b/gi, 'level'],
      // "Next" variations
      [/\bN[e3]xt\b/gi, 'Next'],
      [/\bn[e3]xt\b/gi, 'next'],
      // "Experience" / "XP" variations
      [/\b[e3]xp[e3]ri[e3]nc[e3]\b/gi, 'experience'],
      [/\bExp[e3]ri[e3]nc[e3]\b/gi, 'Experience'],
      // "Total" variations
      [/\btota[l1]\b/gi, 'total'],
      [/\bTota[l1]\b/gi, 'Total'],
      // "Skill" variations
      [/\bski[l1][l1]\b/gi, 'skill'],
      [/\bSki[l1][l1]\b/gi, 'Skill'],
      // "Health" / "Constitution" variations
      [/\bh[e3]a[l1]th\b/gi, 'health'],
      [/\bH[e3]a[l1]th\b/gi, 'Health'],
      // "Prayer" variations
      [/\bpray[e3]r\b/gi, 'prayer'],
      [/\bPray[e3]r\b/gi, 'Prayer'],
      // "Attack" / "Defence" / "Strength" common skills
      [/\batt[a4]ck\b/gi, 'attack'],
      [/\bd[e3]f[e3]nc[e3]\b/gi, 'defence'],
      [/\bstr[e3]ngth\b/gi, 'strength'],
      // "Current" variations
      [/\bcurr[e3]nt\b/gi, 'current'],
      [/\bCurr[e3]nt\b/gi, 'Current'],
    ];

    for (const [pattern, replacement] of ocrCorrections) {
      const before9 = result;
      result = result.replace(pattern, replacement);
      if (result !== before9) console.log(`[AutoSpace] Rule9 (OCR correction): "${before9}" → "${result}"`);
    }

    // Clean up any double spaces
    result = result.replace(/\s+/g, ' ').trim();

    console.log(`[AutoSpace] Final: "${text}" → "${result}" (changed=${result !== text})`);

    return result;
  }

  /**
   * Auto-calibrate grid from inventory slot sprites
   *
   * RS3 coordinate system: Y increases UPWARD
   * - Top-left slot has HIGHEST Y and LOWEST X
   * - Bottom-right slot has LOWEST Y and HIGHEST X
   *
   * Uses clustering to find column/row positions robustly,
   * handling outlier sprites that aren't part of the 4x7 grid.
   */
  private autoCalibrate(elements: RenderRect[]): void {
    if (this.gridConfig.startX !== 0 || this.gridConfig.startY !== 0) return;

    const slotSprites = elements.filter(
      el => el.sprite.known?.id === this.INVENTORY_SLOT_SPRITE_ID
    );

    if (slotSprites.length < 8) return; // Need reasonable number of slots

    // Get average slot dimensions from actual sprites
    const avgSlotWidth = slotSprites.reduce((sum, s) => sum + s.width, 0) / slotSprites.length;
    const avgSlotHeight = slotSprites.reduce((sum, s) => sum + s.height, 0) / slotSprites.length;

    // Cluster X positions to find columns (tight tolerance: 8px to avoid merging adjacent)
    const xClusters = this.clusterPositions(slotSprites.map(s => s.x), 8);
    // Cluster Y positions to find rows (tight tolerance: 8px)
    const yClusters = this.clusterPositions(slotSprites.map(s => s.y), 8);

    // Filter clusters by minimum member count (at least 2 sprites = real grid position).
    const significantXClusters = xClusters.filter(c => c.count >= 2);
    const significantYClusters = yClusters.filter(c => c.count >= 2);

    console.log(`[AutoCalibrate] Raw X clusters (count≥2): ${significantXClusters.map(c => `X=${c.center.toFixed(0)}(n=${c.count})`).join(', ')}`);
    console.log(`[AutoCalibrate] Raw Y clusters (count≥2): ${significantYClusters.map(c => `Y=${c.center.toFixed(0)}(n=${c.count})`).join(', ')}`);

    // Sort by position
    let columns = significantXClusters.sort((a, b) => a.center - b.center);
    const rows = significantYClusters.sort((a, b) => a.center - b.center);

    if (columns.length < 2 || rows.length < 2) return;

    // Cross-validate columns: a valid column must have sprites at Y positions
    // that overlap with detected row Y positions. This filters out phantom columns
    // from UI sprites outside the inventory grid that share the same sprite ID.
    // Require sprites in at least half the detected rows — a real inventory column
    // spans all rows, while phantom columns from other UI elements hit only a few.
    const rowYTolerance = 15; // Must be near a detected row Y
    const minRowsRequired = Math.max(2, Math.ceil(rows.length / 2));
    columns = columns.filter(col => {
      // Find sprites in this column cluster
      const colSprites = slotSprites.filter(s => Math.abs(s.x - col.center) <= 8);
      // Count how many distinct rows this column has sprites in
      const rowsHit = new Set<number>();
      for (const sprite of colSprites) {
        for (let ri = 0; ri < rows.length; ri++) {
          if (Math.abs(sprite.y - rows[ri].center) <= rowYTolerance) {
            rowsHit.add(ri);
            break;
          }
        }
      }
      const valid = rowsHit.size >= minRowsRequired;
      if (!valid) {
        console.log(`[AutoCalibrate] Rejecting column at X=${col.center.toFixed(0)}: only ${rowsHit.size}/${rows.length} row(s) hit (need ≥${minRowsRequired}), sprites=${colSprites.length}`);
      }
      return valid;
    });

    if (columns.length < 2) return;

    // Compute cell step from median of consecutive cluster gaps
    const xSteps: number[] = [];
    for (let i = 1; i < columns.length; i++) {
      xSteps.push(columns[i].center - columns[i - 1].center);
    }
    const ySteps: number[] = [];
    for (let i = 1; i < rows.length; i++) {
      ySteps.push(rows[i].center - rows[i - 1].center);
    }

    const actualCellWidth = this.medianValue(xSteps);
    const actualCellHeight = this.medianValue(ySteps);

    // Use detected rows as-is — inventory is resizable so row/column counts are dynamic.
    const rowCenters = rows.map(r => r.center); // Sorted ascending (lowest Y first)

    // Grid layout (RS3 Y-up):
    // - startX = leftmost column center
    // - gridTopY = highest Y cluster = top row (row 0)
    // - gridBottomY = lowest Y cluster = bottom row
    const startX = columns[0].center;
    const gridTopY = rowCenters[rowCenters.length - 1];  // Highest Y = top row
    const gridBottomY = rowCenters[0];                     // Lowest Y = bottom row

    // Update grid dimensions from detected data (columns/rows may vary by interface layout)
    this.gridConfig.columns = columns.length;
    this.gridConfig.rows = rowCenters.length;
    this.gridConfig.startX = startX;
    this.gridConfig.startY = gridBottomY;
    this.gridConfig.actualGridTopY = gridTopY;
    this.gridConfig.actualCellWidth = actualCellWidth;
    this.gridConfig.actualCellHeight = actualCellHeight;
    this.gridConfig.slotWidth = avgSlotWidth;
    this.gridConfig.slotHeight = avgSlotHeight;

    // Store actual positions for direct lookup (row 0 = highest Y)
    this.columnPositions = columns.map(c => c.center);
    this.rowPositions = [...rowCenters].reverse(); // Descending: row 0 = highest Y

    const totalSlots = this.gridConfig.columns * this.gridConfig.rows;
    console.log(`[AutoCalibrate] Found ${slotSprites.length} slot sprites → ${columns.length} cols, ${rowCenters.length} rows (${totalSlots} slots)`);
    console.log(`[AutoCalibrate] Columns: ${columns.map(c => c.center.toFixed(0)).join(', ')}`);
    console.log(`[AutoCalibrate] Rows (top→bottom): ${this.rowPositions.map(y => y.toFixed(0)).join(', ')}`);
    console.log(`[AutoCalibrate] Cell step: ${actualCellWidth.toFixed(1)}x${actualCellHeight.toFixed(1)}`);
    console.log(`[AutoCalibrate] Slot size: ${avgSlotWidth.toFixed(1)}x${avgSlotHeight.toFixed(1)}`);

    // Verify using actual positions
    const lastRow = this.gridConfig.rows - 1;
    const lastCol = this.gridConfig.columns - 1;
    console.log(`[AutoCalibrate] Slot 1 (row0,col0): (${this.columnPositions[0]?.toFixed(0)}, ${this.rowPositions[0]?.toFixed(0)})`);
    console.log(`[AutoCalibrate] Slot ${lastCol + 1} (row0,col${lastCol}): (${this.columnPositions[lastCol]?.toFixed(0)}, ${this.rowPositions[0]?.toFixed(0)})`);
    console.log(`[AutoCalibrate] Slot ${lastRow * this.gridConfig.columns + 1} (row${lastRow},col0): (${this.columnPositions[0]?.toFixed(0)}, ${this.rowPositions[lastRow]?.toFixed(0)})`);
  }

  /**
   * Cluster numeric values that are close together
   * Returns sorted clusters with center position and member count
   */
  private clusterPositions(values: number[], tolerance: number): { center: number; count: number }[] {
    const sorted = [...values].sort((a, b) => a - b);
    const clusters: { sum: number; count: number; center: number }[] = [];

    for (const val of sorted) {
      let merged = false;
      for (const cluster of clusters) {
        if (Math.abs(val - cluster.center) <= tolerance) {
          cluster.sum += val;
          cluster.count++;
          cluster.center = cluster.sum / cluster.count;
          merged = true;
          break;
        }
      }
      if (!merged) {
        clusters.push({ sum: val, count: 1, center: val });
      }
    }

    return clusters.map(c => ({ center: c.center, count: c.count }));
  }

  /**
   * Compute median of an array of numbers
   */
  private medianValue(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  /**
   * Internal helper for slot bounds calculation (used during calibration logging)
   */
  private getSlotBoundsInternal(slot: number, cellWidth: number, cellHeight: number, gridTopY: number): { x: number; y: number } {
    const col = slot % this.gridConfig.columns;
    const row = Math.floor(slot / this.gridConfig.columns);
    return {
      x: this.gridConfig.startX + col * cellWidth,
      y: gridTopY - row * cellHeight,
    };
  }

  /**
   * Find inventory slots and their current contents
   */
  private findInventorySlots(elements: RenderRect[]): InventorySlotInfo[] {
    const slots: InventorySlotInfo[] = [];
    const slotCount = this.gridConfig.columns * this.gridConfig.rows;

    // Log first few slot bounds for debugging
    let loggedSlots = 0;

    for (let slot = 0; slot < slotCount; slot++) {
      const slotBounds = this.getSlotBounds(slot);
      if (!slotBounds) continue; // Slot outside detected grid

      // Use a more lenient bounds check - element center must be within slot bounds
      // with some padding tolerance
      const padding = 5;
      const slotElements = elements.filter(el => {
        const elCenterX = el.x + el.width / 2;
        const elCenterY = el.y + el.height / 2;
        return (
          elCenterX >= slotBounds.x - padding &&
          elCenterX <= slotBounds.x + slotBounds.width + padding &&
          elCenterY >= slotBounds.y - padding &&
          elCenterY <= slotBounds.y + slotBounds.height + padding
        );
      });

      // Find item sprite (largest non-background, non-font element)
      const itemSprite = this.findItemSprite(slotElements);

      // Compute pHash from item sprite's raw texture data
      let itemPHash: string | undefined;
      if (itemSprite) {
        try {
          const rawSprite = itemSprite.sprite as any;
          const basetex = rawSprite.basetex;
          if (basetex && typeof basetex.capture === 'function') {
            // Check if texture can be captured (not detached/disposed)
            const canCapture = typeof basetex.canCapture === 'function' ? basetex.canCapture() : true;
            if (canCapture) {
              // Support both GLBridgeAdapter naming (texX/texY/texWidth/texHeight)
              // and direct AtlasSnapshotFragment naming (x/y/width/height)
              const texX = rawSprite.texX ?? rawSprite.x ?? 0;
              const texY = rawSprite.texY ?? rawSprite.y ?? 0;
              const texW = rawSprite.texWidth ?? rawSprite.width ?? 0;
              const texH = rawSprite.texHeight ?? rawSprite.height ?? 0;

              // Validate bounds against texture dimensions to avoid native SubImage assertion
              const texDataW = basetex.width ?? 0;
              const texDataH = basetex.height ?? 0;
              if (texW > 0 && texH > 0 && texX >= 0 && texY >= 0 &&
                  texX + texW <= texDataW && texY + texH <= texDataH) {
                const imgData = basetex.capture(texX, texY, texW, texH);
                const expectedLen = imgData ? imgData.width * imgData.height * 4 : 0;
                if (imgData && imgData.data && imgData.data.length >= expectedLen && imgData.width > 0 && imgData.height > 0) {
                  const pHashValue = dHash(imgData.data, imgData.width, imgData.height);
                  const pHashHex = hashToHex(pHashValue);
                  // Reject degenerate hashes (all-zero = empty/freed texture, all-ones = fully transparent)
                  if (pHashHex !== '0000000000000000' && pHashHex !== 'ffffffffffffffff') {
                    itemPHash = pHashHex;
                  }
                  // Diagnostic: log first 4 slots' pHash input data
                  if (slot < 4) {
                    const px = imgData.data;
                    const sample = `[${px[0]},${px[1]},${px[2]},${px[3]}|${px[4]},${px[5]},${px[6]},${px[7]}]`;
                    console.log(`[pHash-DIAG] Slot ${slot}: tex=${texW}x${texH} @(${texX},${texY}) atlas=${texDataW}x${texDataH} img=${imgData.width}x${imgData.height} dataLen=${imgData.data.length}/${expectedLen} px0=${sample} hash=${pHashHex}${pHashHex === '0000000000000000' ? ' REJECTED:empty' : ''}`);
                  }
                }
              }
            }
          }
        } catch (e) {
          // pHash computation not available for this sprite
        }
      }

      // Log bounds for first 4 slots and slot 24 for debugging
      if ((slot < 4 || slot === 24) && loggedSlots < 6) {
        const row = Math.floor(slot / this.gridConfig.columns);
        const col = slot % this.gridConfig.columns;
        console.log(`[InventorySlots] Slot ${slot + 1} (row${row},col${col}): X=${slotBounds.x.toFixed(0)}, Y=${slotBounds.y.toFixed(0)}, elements=${slotElements.length}, hasItem=${itemSprite !== null}${itemPHash ? `, pHash=${itemPHash}` : ''}`);
        loggedSlots++;
      }

      slots.push({
        slot,
        ...slotBounds,
        iconHash: itemSprite?.sprite.hash ?? 0,
        pHash: itemPHash,
        iconElement: itemSprite,
      });
    }

    return slots;
  }

  /**
   * Update the slot→pHash map from current frame's inventory data.
   * Called every frame to track which pHash is at each slot position.
   * Also tracks stability: how many consecutive frames each slot kept the same pHash.
   * A stable pHash (2+ frames) means the item hasn't moved and slot assignment is reliable.
   */
  private updateSlotPHashMap(inventorySlots: InventorySlotInfo[]): void {
    for (const slot of inventorySlots) {
      if (slot.pHash && slot.iconHash !== 0) {
        const prev = this.slotPHashStability.get(slot.slot);
        if (prev && prev.pHash === slot.pHash) {
          // Same pHash as last frame — increment stability counter
          prev.count++;
        } else {
          // Different pHash or first time — reset stability
          this.slotPHashStability.set(slot.slot, { pHash: slot.pHash, count: 1 });
        }
        this.slotPHashMap.set(slot.slot, slot.pHash);
      } else {
        // Empty slot or no pHash — clear tracking
        this.slotPHashMap.delete(slot.slot);
        this.slotPHashStability.delete(slot.slot);
      }
    }
  }

  /**
   * Check if a slot's pHash is stable (same across multiple frames).
   * Returns the stable pHash if confirmed, null if unstable or unknown.
   */
  private getStableSlotPHash(slotIndex: number): string | null {
    const stability = this.slotPHashStability.get(slotIndex);
    if (!stability) return null;
    if (stability.count >= TooltipItemLearner.PHASH_STABLE_FRAMES) {
      return stability.pHash;
    }
    return null;
  }

  /**
   * Validate a guessed slot by checking its pHash against the slot map.
   * Returns true if the slot's pHash is stable AND matches what we see at that position.
   * This is the core of the "hover → guess → validate → assign" flow.
   */
  private validateSlotByPHash(guessedSlot: number, inventorySlots: InventorySlotInfo[]): { valid: boolean; pHash: string | null; reason: string } {
    const stablePHash = this.getStableSlotPHash(guessedSlot);
    if (!stablePHash) {
      return { valid: false, pHash: null, reason: 'slot pHash not stable yet' };
    }

    // Verify the guessed slot's current pHash matches the stable one
    const currentSlot = inventorySlots.find(s => s.slot === guessedSlot);
    if (!currentSlot || !currentSlot.pHash) {
      return { valid: false, pHash: null, reason: 'slot has no current pHash' };
    }

    if (currentSlot.pHash !== stablePHash) {
      return { valid: false, pHash: currentSlot.pHash, reason: `pHash changed this frame (was ${stablePHash}, now ${currentSlot.pHash})` };
    }

    // pHash is stable and matches current frame — this slot is validated
    return { valid: true, pHash: stablePHash, reason: 'pHash stable and consistent' };
  }

  /**
   * Detect the hovered inventory slot by looking for extra render elements.
   *
   * RS3 renders a highlight/overlay sprite on the hovered slot. A normal slot
   * with an item has a baseline number of elements (background + item icon,
   * possibly quantity text, augmentation overlay, etc.). The hovered slot has
   * additional highlight elements rendered on top — typically 5+ extra elements.
   *
   * Strategy: find the slot with the MAX element count that is significantly
   * above the second-highest count. Items like stackables or augmented gear
   * may naturally have 2-5 elements, but the hover highlight adds many more
   * (e.g., 11 elements when others have 1-5).
   */
  private detectHoveredSlotByHighlight(
    inventorySlots: InventorySlotInfo[],
    allElements: RenderRect[]
  ): number | null {
    // Only consider slots that have items (iconHash !== 0)
    const slotsWithItems = inventorySlots.filter(s => s.iconHash !== 0);
    if (slotsWithItems.length < 2) return null;

    // Count significant (non-bg, non-font) elements per slot
    const padding = 5;
    const slotElementCounts: { slot: number; count: number }[] = [];

    for (const slotInfo of slotsWithItems) {
      let count = 0;
      for (const el of allElements) {
        // Skip font characters
        if (el.sprite.known?.fontchr) continue;
        // Skip inventory slot background
        if (el.sprite.known?.id === this.INVENTORY_SLOT_SPRITE_ID) continue;
        // Must be within slot bounds
        const elCenterX = el.x + el.width / 2;
        const elCenterY = el.y + el.height / 2;
        if (
          elCenterX >= slotInfo.x - padding &&
          elCenterX <= slotInfo.x + slotInfo.width + padding &&
          elCenterY >= slotInfo.y - padding &&
          elCenterY <= slotInfo.y + slotInfo.height + padding
        ) {
          count++;
        }
      }

      slotElementCounts.push({ slot: slotInfo.slot, count });
    }

    // Sort descending by element count
    slotElementCounts.sort((a, b) => b.count - a.count);

    const top = slotElementCounts[0];
    const secondTop = slotElementCounts[1];

    if (!top || !secondTop) return null;

    // The hovered slot should have significantly more elements than any other.
    // Require: top count is at least 2x the second-highest AND at least 3 more.
    // This filters out natural variation (augmented items, stackables) while
    // catching the hover highlight which adds 5+ extra sprites.
    const gap = top.count - secondTop.count;
    const ratio = secondTop.count > 0 ? top.count / secondTop.count : top.count;

    if (gap >= 3 && ratio >= 1.5) {
      const { columns } = this.gridConfig;
      const row = Math.floor(top.slot / columns);
      const col = top.slot % columns;
      console.log(`[HoverDetect] Slot ${top.slot + 1} (row${row},col${col}) has ${top.count} elements, next highest=${secondTop.count} (gap=${gap}, ratio=${ratio.toFixed(1)}x) — likely hovered`);
      return top.slot;
    }

    // Log diagnostic info when detection is ambiguous
    const topFew = slotElementCounts.slice(0, 5).map(s => `slot${s.slot + 1}=${s.count}`).join(', ');
    console.log(`[HoverDetect] No clear hover outlier: top=[${topFew}] (gap=${gap}, ratio=${ratio.toFixed(1)}x)`);

    return null;
  }

  /**
   * Find the main item sprite in slot elements
   */
  private findItemSprite(slotElements: RenderRect[]): RenderRect | null {
    const itemCandidates = slotElements.filter(el => {
      // Skip inventory slot background
      if (el.sprite.known?.id === this.INVENTORY_SLOT_SPRITE_ID) return false;
      // Skip font characters
      if (el.sprite.known?.fontchr) return false;
      return true;
    });

    if (itemCandidates.length === 0) return null;

    // Return the largest element
    return itemCandidates.reduce((largest, current) => {
      const largestArea = largest.width * largest.height;
      const currentArea = current.width * current.height;
      return currentArea > largestArea ? current : largest;
    });
  }

  /**
   * Get bounds for a specific inventory slot
   *
   * RS3 coordinate system: Y increases UPWARD
   * - Slot 0 (row 0) is at TOP of grid (highest Y)
   * - Last slot is at BOTTOM of grid (lowest Y)
   *
   * Uses actual detected positions from autoCalibrate when available,
   * falls back to step-based calculation.
   */
  private getSlotBounds(slot: number): { x: number; y: number; width: number; height: number } | null {
    const { slotWidth, slotHeight, columns } = this.gridConfig;
    const col = slot % columns;
    const row = Math.floor(slot / columns);

    // Out of bounds for detected grid
    if (row >= this.gridConfig.rows || col >= columns) {
      return null;
    }

    // Use actual detected positions if available (most accurate)
    if (this.columnPositions.length > col && this.rowPositions.length > row) {
      return {
        x: this.columnPositions[col],
        y: this.rowPositions[row],
        width: slotWidth,
        height: slotHeight,
      };
    }

    // Fallback to step-based calculation
    const { startX, actualGridTopY, actualCellWidth, actualCellHeight } = this.gridConfig;
    const cellWidth = actualCellWidth > 0 ? actualCellWidth : (slotWidth + 2);
    const cellHeight = actualCellHeight > 0 ? actualCellHeight : (slotHeight + 2);
    const gridTopY = actualGridTopY > 0 ? actualGridTopY : (this.gridConfig.startY + 6 * cellHeight);

    return {
      x: startX + col * cellWidth,
      y: gridTopY - row * cellHeight,
      width: slotWidth,
      height: slotHeight,
    };
  }

  /**
   * Find the inventory slot being hovered based on tooltip position
   *
   * RS3 coordinate system: Y increases UPWARD (OpenGL style)
   * - tooltipBounds.y = bottom edge of tooltip (lowest Y)
   * - tooltipBounds.y + tooltipBounds.height = top edge of tooltip (highest Y)
   *
   * In RS3, tooltip appears BELOW the hovered item (lower Y than the item)
   * So we look for slots that are ABOVE the tooltip (higher Y)
   */
  private findNearestSlot(
    tooltipBounds: { x: number; y: number; width: number; height: number },
    slots: InventorySlotInfo[],
    mousePos?: { x: number; y: number } | null
  ): number | null {
    const tooltipCenterX = tooltipBounds.x + tooltipBounds.width / 2;
    const tooltipTopY = tooltipBounds.y + tooltipBounds.height;

    console.log(`[SlotFind] Tooltip: X=${tooltipBounds.x.toFixed(0)}-${(tooltipBounds.x + tooltipBounds.width).toFixed(0)}, Y=${tooltipBounds.y.toFixed(0)}-${tooltipTopY.toFixed(0)}, centerX=${tooltipCenterX.toFixed(0)}`);

    // Early reject: tooltip center X must be near the inventory grid X range
    const gridLeftX = this.columnPositions[0] ?? this.gridConfig.startX;
    const gridRightX = (this.columnPositions[this.columnPositions.length - 1] ?? gridLeftX) + this.gridConfig.slotWidth;
    const gridWidth = gridRightX - gridLeftX;
    const gridMarginX = Math.max(gridWidth / 2, 100);

    if (tooltipCenterX < gridLeftX - gridMarginX || tooltipCenterX > gridRightX + gridMarginX) {
      console.log(`[SlotFind] Tooltip center X=${tooltipCenterX.toFixed(0)} outside inventory grid, not an inventory tooltip`);
      return null;
    }

    // Early reject: tooltip must be within reasonable Y distance of the inventory grid
    // RS3 renders tooltips in a FIXED AREA above the inventory panel, NOT at the cursor.
    // Even inventory item tooltips can appear 300+ pixels above the grid for top-row items.
    // Only reject truly distant tooltips (equipment panel tooltips at Y=700+).
    // Use a generous 500px tolerance above grid top to allow all inventory tooltip positions.
    const gridTopY = this.rowPositions[0] ?? this.gridConfig.actualGridTopY;
    const gridBottomY = this.rowPositions[this.rowPositions.length - 1] ?? this.gridConfig.startY;
    const gridHeight = Math.abs(gridTopY - gridBottomY) + this.gridConfig.slotHeight;
    const maxYDistance = Math.max(gridHeight * 2, 500); // Very generous - 500px or 2x grid height

    // In RS3 Y-up coords: tooltip below grid has Y < gridBottomY, above grid has Y > gridTopY
    const tooltipMidY = tooltipBounds.y + tooltipBounds.height / 2;
    const yDistFromGrid = (tooltipMidY > gridTopY + this.gridConfig.slotHeight)
      ? (tooltipMidY - gridTopY - this.gridConfig.slotHeight)  // Above grid
      : (tooltipMidY < gridBottomY)
        ? (gridBottomY - tooltipMidY)  // Below grid
        : 0;  // Inside grid Y range

    if (yDistFromGrid > maxYDistance) {
      console.log(`[SlotFind] Tooltip Y=${tooltipMidY.toFixed(0)} too far from grid (dist=${yDistFromGrid.toFixed(0)}px, max=${maxYDistance.toFixed(0)}px) - likely equipment/other tooltip`);
      return null;
    }

    // RS3 renders the tooltip in a fixed area ABOVE the inventory panel,
    // not at the cursor. This means:
    //   - X alignment is the primary signal (tooltip is roughly centered on hovered column)
    //   - Y distance is unreliable for determining the row
    //
    // Strategy: match by X (column) first, then pick the best row candidate
    // among slots with items. Use tooltip center X as the column indicator.

    const { columns } = this.gridConfig;
    const cellWidth = this.gridConfig.actualCellWidth || (this.gridConfig.slotWidth + 2);

    // Step 1: Find the best-matching column by X distance from tooltip center
    let bestCol = -1;
    let bestColDist = Infinity;
    for (let c = 0; c < this.columnPositions.length; c++) {
      const colCenterX = this.columnPositions[c] + this.gridConfig.slotWidth / 2;
      const dist = Math.abs(tooltipCenterX - colCenterX);
      if (dist < bestColDist) {
        bestColDist = dist;
        bestCol = c;
      }
    }

    // Fallback: step-based column if positions not available
    if (bestCol < 0 && this.gridConfig.startX > 0) {
      bestCol = Math.round((tooltipCenterX - this.gridConfig.startX - this.gridConfig.slotWidth / 2) / cellWidth);
      bestCol = Math.max(0, Math.min(columns - 1, bestCol));
      bestColDist = Math.abs(tooltipCenterX - (this.gridConfig.startX + bestCol * cellWidth + this.gridConfig.slotWidth / 2));
    }

    if (bestCol < 0) {
      console.log(`[SlotFind] Could not determine column`);
      return null;
    }

    // Reject if X alignment is too poor (more than 1.5 cell widths off)
    if (bestColDist > cellWidth * 1.5) {
      console.log(`[SlotFind] Best column ${bestCol} too far from tooltip center (${bestColDist.toFixed(0)}px)`);
      return null;
    }

    console.log(`[SlotFind] Best column: ${bestCol} (dist=${bestColDist.toFixed(0)}px)`);

    // Step 2: Among slots in this column, pick the best row
    // Since we can't determine row from tooltip Y, prefer slots that have items
    const columnSlots = slots.filter(s => (s.slot % columns) === bestCol);
    const slotsWithItems = columnSlots.filter(s => s.iconHash !== 0);

    // If only one slot in this column has an item, that's our answer
    if (slotsWithItems.length === 1) {
      console.log(`[SlotFind] Only slot ${slotsWithItems[0].slot + 1} in col ${bestCol} has an item`);
      return slotsWithItems[0].slot;
    }

    // Multiple items in column - determine row from mouse position.
    // Priority:
    //   1. Calibrated positions (if available) — compare current mouse pos to
    //      recorded reference positions per slot. This handles IPC drift perfectly
    //      because calibration captures the ACTUAL drifted position per slot.
    //   2. Raw mouse Y fallback — nearest row by Y distance (unreliable for
    //      far-right columns, but voting system filters wrong guesses).
    const candidatePool = slotsWithItems.length > 0 ? slotsWithItems : columnSlots;
    let bestSlot: InventorySlotInfo | null = null;

    if (mousePos && this.calibratedMousePositions.size > 0) {
      // ── Calibrated matching ──
      // Find the candidate slot whose calibrated mouse position is closest
      // to the current mouse position (Euclidean distance).
      let bestDist = Infinity;
      for (const slot of candidatePool) {
        const calPos = this.getCalibratedPosition(slot.slot);
        if (!calPos) continue;
        const dx = mousePos.x - calPos.x;
        const dy = mousePos.y - calPos.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < bestDist) {
          bestDist = dist;
          bestSlot = slot;
        }
      }
      if (bestSlot) {
        console.log(`[SlotFind] Calibrated match: slot ${bestSlot.slot + 1} (dist=${bestDist.toFixed(0)}px from calibrated pos)`);
      } else {
        // No calibrated positions for any candidates — fall through to raw Y
        console.log(`[SlotFind] No calibration data for candidates in col ${bestCol}, falling back to raw mouse Y`);
      }
    }

    if (mousePos && !bestSlot) {
      // ── Raw mouse Y fallback ──
      // The mouse has drifted past the grid, but Y still roughly correlates.
      // The voting system in learnItemSync will filter out wrong guesses.
      let bestYDist = Infinity;
      for (const slot of candidatePool) {
        const slotCenterY = slot.y + slot.height / 2;
        const yDist = Math.abs(slotCenterY - mousePos.y);
        if (yDist < bestYDist) {
          bestYDist = yDist;
          bestSlot = slot;
        }
      }
      console.log(`[SlotFind] Using raw mouse Y=${mousePos.y.toFixed(0)} for row selection (bestYDist=${bestYDist.toFixed(0)})`);
    } else if (!mousePos) {
      // No mouse position — pick the topmost slot (highest Y in GL = row 0)
      // since we can't determine the row from tooltip position
      candidatePool.sort((a, b) => a.slot - b.slot);
      bestSlot = candidatePool[0] ?? null;
      console.log(`[SlotFind] No mouse pos, defaulting to topmost slot in column`);
    }

    if (!bestSlot) {
      console.log(`[SlotFind] No valid slots in column ${bestCol}`);
      return null;
    }

    // Log candidates for debugging
    const refY = mousePos ? mousePos.y : tooltipTopY;
    const candLog = candidatePool.map(s =>
      `slot${s.slot + 1}(row${Math.floor(s.slot / columns)},yDist=${Math.abs((s.y + s.height / 2) - refY).toFixed(0)},item=${s.iconHash !== 0})`
    ).join(', ');
    console.log(`[SlotFind] Column ${bestCol} candidates: ${candLog}`);
    console.log(`[SlotFind] Best: slot ${bestSlot.slot + 1} (row${Math.floor(bestSlot.slot / columns)}, col${bestCol})`);

    return bestSlot.slot;
  }

  /**
   * Learn an item association (sync version for detectFromElements)
   */
  private learnItemSync(slotInfo: InventorySlotInfo, name: string): void {
    // Check if we already know this item by this exact iconHash
    const existing = this.learnedItems.get(slotInfo.iconHash);
    if (existing && existing.name === name) {
      return; // Already learned
    }

    // Check if we already know this item name for a DIFFERENT iconHash.
    // If so, the name is already learned - don't overwrite with a potentially
    // wrong slot's iconHash (row detection is unreliable).
    for (const [hash, item] of this.learnedItems) {
      if (item.name === name && hash !== slotInfo.iconHash) {
        console.log(`[TooltipLearner] "${name}" already known (hash: ${hash}), skipping re-learn for hash ${slotInfo.iconHash}`);
        return;
      }
    }

    // Slot-vote confirmation: accumulate votes for (name, iconHash) pairs.
    // Row detection from mouse Y is unreliable because the cursor drifts past
    // the grid by IPC sampling time. By requiring multiple consistent sightings,
    // we filter out wrong first-guesses. The correct slot will accumulate votes
    // faster because the user hovers the same item repeatedly.
    let nameVotes = this.slotVotes.get(name);
    if (!nameVotes) {
      nameVotes = new Map();
      this.slotVotes.set(name, nameVotes);
    }
    const currentVotes = (nameVotes.get(slotInfo.iconHash) ?? 0) + 1;
    nameVotes.set(slotInfo.iconHash, currentVotes);

    console.log(`[TooltipLearner] Vote for "${name}" → hash ${slotInfo.iconHash}: ${currentVotes}/${TooltipItemLearner.VOTES_REQUIRED}`);

    if (currentVotes < TooltipItemLearner.VOTES_REQUIRED) {
      return; // Not enough votes yet
    }

    // Enough votes — commit the learning
    // Clear votes for this name (learned successfully)
    this.slotVotes.delete(name);

    const learnedItem: LearnedItem = {
      name,
      iconHash: slotInfo.iconHash,
      pHash: slotInfo.pHash,
      learnedAt: Date.now(),
      confidence: slotInfo.pHash ? 0.90 : 0.85,
      source: 'tooltip',
    };

    // Store by iconHash
    this.learnedItems.set(slotInfo.iconHash, learnedItem);

    // Also index by pHash for cross-session lookup
    if (slotInfo.pHash) {
      this.pHashIndex.set(slotInfo.pHash, learnedItem);
    }

    // Notify listeners
    for (const listener of this.listeners) {
      try {
        listener(learnedItem);
      } catch (e) {
        console.error('[TooltipLearner] Listener error:', e);
      }
    }

    console.log(`[TooltipLearner] Confirmed: "${name}" (hash: ${slotInfo.iconHash}${slotInfo.pHash ? `, pHash: ${slotInfo.pHash}` : ''})`);
  }

  /**
   * Learn an item association (async variant, delegates to sync version with voting)
   */
  private async learnItem(slotInfo: InventorySlotInfo, name: string): Promise<void> {
    this.learnItemSync(slotInfo, name);
  }

  /**
   * Look up item name by hash
   */
  getItemName(iconHash: number): string | null {
    return this.learnedItems.get(iconHash)?.name ?? null;
  }

  /**
   * Look up item name by pHash (cross-session)
   */
  getItemNameByPHash(pHash: string, maxDistance: number = 10): string | null {
    // Exact match first
    const exact = this.pHashIndex.get(pHash);
    if (exact) return exact.name;

    // Fuzzy match
    for (const [storedHash, item] of this.pHashIndex) {
      const distance = hammingDistance(
        BigInt('0x' + pHash),
        BigInt('0x' + storedHash)
      );
      if (distance <= maxDistance) {
        return item.name;
      }
    }

    return null;
  }

  /**
   * Get all learned items
   */
  getLearnedItems(): LearnedItem[] {
    return Array.from(this.learnedItems.values());
  }

  /**
   * Export learned items for persistence
   */
  exportLearnedItems(): { iconHash: number; name: string; pHash?: string }[] {
    return Array.from(this.learnedItems.values()).map(item => ({
      iconHash: item.iconHash,
      name: item.name,
      pHash: item.pHash,
    }));
  }

  /**
   * Import previously learned items
   */
  importLearnedItems(items: { iconHash: number; name: string; pHash?: string }[]): void {
    for (const item of items) {
      const learnedItem: LearnedItem = {
        name: item.name,
        iconHash: item.iconHash,
        pHash: item.pHash,
        learnedAt: Date.now(),
        confidence: 0.8,
        source: 'database',
      };

      this.learnedItems.set(item.iconHash, learnedItem);
      if (item.pHash) {
        this.pHashIndex.set(item.pHash, learnedItem);
      }
    }
    console.log(`[TooltipItemLearner] Imported ${items.length} items`);
  }

  /**
   * Register a callback for newly learned items
   */
  onItemLearned(callback: (item: LearnedItem) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /**
   * Start automatic tooltip learning
   */
  startPolling(intervalMs: number = 500): void {
    if (this.pollTimer) this.stopPolling();

    this.pollTimer = setInterval(async () => {
      try {
        await this.detectAndLearn();
      } catch (err) {
        console.error('[TooltipItemLearner] Detection error:', err);
      }
    }, intervalMs);

    console.log(`[TooltipItemLearner] Started polling every ${intervalMs}ms`);
  }

  /**
   * Stop automatic tooltip learning
   */
  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
      console.log('[TooltipItemLearner] Stopped polling');
    }
    // Clear transient state to free memory
    this.slotVotes.clear();
    this.namePHashCandidates.clear();
    this.slotPHashMap.clear();
    this.slotPHashStability.clear();
    this.lastGridMousePos = null;
  }
}

/**
 * Create a configured TooltipItemLearner instance
 */
export function createTooltipLearner(glBridge: GLBridgeAdapter): TooltipItemLearner {
  return new TooltipItemLearner(glBridge);
}
