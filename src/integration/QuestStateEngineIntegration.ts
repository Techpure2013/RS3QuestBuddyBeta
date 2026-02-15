/**
 * QuestStateEngine Integration
 *
 * Entry point for integrating QuestStateEngine's detection system
 * with RS3QuestBuddyBeta's GL layer.
 *
 * Usage:
 * 1. Import and call initializeQuestStateEngine()
 * 2. Access the inventory monitor via getInventoryMonitor()
 * 3. Subscribe to detection events for quest state updates
 */

import { GLBridgeAdapter, createGLBridge, type RenderRect, type UIState } from './GLBridgeAdapter';
import { DialogBridgeAdapter, createDialogBridge, type QSEDialogResult, type DialogEvent } from './DialogBridgeAdapter';
import { TooltipItemLearner, createTooltipLearner, type LearnedItem } from './TooltipItemLearner';
import { OverlayMouseClient } from './OverlayMouseClient';
import * as patchrs from '../gl/injection/util/patchrs_napi';
import { SpriteCache } from '../gl/injection/reflect2d/spritecache';
import * as path from 'path';

// Item hashes file location (relative to RS3QuestBuddyBeta's data folder)
const ITEM_HASHES_FILE = path.join(__dirname, '..', 'gl', 'injection', 'reflect2d', 'data', 'Item-Hashes.json');

/**
 * Detected inventory item
 */
export interface DetectedInventoryItem {
  slot: number;
  name: string | null;
  quantity: number;
  iconHash: number;
  bounds: { x: number; y: number; width: number; height: number };
  confidence: number;
}

/**
 * Inventory change event
 */
export interface InventoryChangeEvent {
  type: 'added' | 'removed' | 'quantity_changed';
  slot: number;
  item: DetectedInventoryItem | null;
  previousQuantity?: number;
  newQuantity?: number;
  timestamp: number;
}

/**
 * Inventory detection result
 */
export interface InventoryDetectionResult {
  items: DetectedInventoryItem[];
  emptySlots: number[];
  changes: InventoryChangeEvent[];
  timestamp: number;
}

/**
 * Grid configuration for inventory detection
 */
export interface InventoryGridConfig {
  startX: number;
  startY: number;
  slotWidth: number;
  slotHeight: number;
  columns: number;
  rows: number;
  horizontalGap: number;
  verticalGap: number;
}

// Inventory slot sprite ID and dimensions
const INVENTORY_SLOT_SPRITE_ID = 18266;
const SLOT_WIDTH = 40;
const SLOT_HEIGHT = 36;
const SLOT_COUNT = 28;
const COLUMNS = 4;
const ROWS = 7;

/**
 * Simplified inventory monitor for direct use in RS3QuestBuddyBeta
 */
export class IntegratedInventoryMonitor {
  private glBridge: GLBridgeAdapter;
  private itemDatabase: Map<number, string> = new Map();
  private previousItems: Map<number, DetectedInventoryItem> = new Map();
  private gridConfig: InventoryGridConfig;
  private listeners: Set<(result: InventoryDetectionResult) => void> = new Set();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private isCalibrated = false;

  constructor(glBridge: GLBridgeAdapter) {
    this.glBridge = glBridge;
    this.gridConfig = {
      startX: 0,
      startY: 0,
      slotWidth: SLOT_WIDTH,
      slotHeight: SLOT_HEIGHT,
      columns: COLUMNS,
      rows: ROWS,
      horizontalGap: 2,
      verticalGap: 2,
    };

    // Load item database from SpriteCache
    this.loadItemDatabase();
  }

  /**
   * Load item names from SpriteCache's item hash database
   */
  private loadItemDatabase(): void {
    const spriteCache = this.glBridge.getSpriteCache();
    // Items map is loaded in SpriteCache.loadItemHashes()
    for (const [hash, info] of spriteCache.hashes) {
      if (info.itemName) {
        this.itemDatabase.set(hash, info.itemName);
      }
    }
    console.log(`[IntegratedInventoryMonitor] Loaded ${this.itemDatabase.size} items from sprite cache`);
  }

  /**
   * Register an item manually
   */
  registerItem(hash: number, name: string): void {
    this.itemDatabase.set(hash, name);
  }

  /**
   * Calibrate the inventory grid position
   */
  calibrateGrid(startX: number, startY: number): void {
    this.gridConfig.startX = startX;
    this.gridConfig.startY = startY;
    this.isCalibrated = true;
    console.log(`[IntegratedInventoryMonitor] Grid calibrated: start=(${startX}, ${startY})`);
  }

  /**
   * Auto-calibrate by finding the first inventory slot sprite
   */
  async autoCalibrate(): Promise<boolean> {
    let renders: any[] = [];
    try {
      renders = await this.glBridge.recordRenderCalls({ texturesnapshot: true });
      const uiState = this.glBridge.getUIState(renders);

      // Find the first inventory slot sprite (18266)
      const slotSprites = uiState.elements.filter(
        el => el.sprite.known?.id === INVENTORY_SLOT_SPRITE_ID
      );

      if (slotSprites.length === 0) {
        console.warn('[IntegratedInventoryMonitor] No inventory slots found - is the inventory open?');
        return false;
      }

      // Sort by position to find the top-left slot
      slotSprites.sort((a, b) => {
        if (Math.abs(a.y - b.y) < 10) {
          return a.x - b.x;
        }
        return a.y - b.y;
      });

      const firstSlot = slotSprites[0];
      this.calibrateGrid(firstSlot.x, firstSlot.y);

      console.log(`[IntegratedInventoryMonitor] Auto-calibrated: found ${slotSprites.length} slots, first at (${firstSlot.x}, ${firstSlot.y})`);
      return true;
    } catch (err) {
      console.error('[IntegratedInventoryMonitor] Auto-calibration failed:', err);
      return false;
    } finally {
      // Dispose all render invocations to free native memory
      for (const r of renders) {
        try { r.dispose(); } catch (_) { /* already disposed */ }
      }
    }
  }

  /**
   * Run a single detection cycle
   */
  async detect(): Promise<InventoryDetectionResult> {
    let renders: any[] = [];
    try {
      renders = await this.glBridge.recordRenderCalls({ texturesnapshot: true });
      const uiState = this.glBridge.getUIState(renders);

      // Auto-calibrate if not yet done
      if (!this.isCalibrated) {
        const slotSprites = uiState.elements.filter(
          el => el.sprite.known?.id === INVENTORY_SLOT_SPRITE_ID
        );
        if (slotSprites.length > 0) {
          slotSprites.sort((a, b) => {
            if (Math.abs(a.y - b.y) < 10) return a.x - b.x;
            return a.y - b.y;
          });
          const firstSlot = slotSprites[0];
          this.calibrateGrid(firstSlot.x, firstSlot.y);
        }
      }

      // Detect items in each slot
      const currentItems = this.detectItems(uiState.elements);
      const changes = this.calculateChanges(currentItems);
      const emptySlots = this.findEmptySlots(currentItems);

      const result: InventoryDetectionResult = {
        items: Array.from(currentItems.values()),
        emptySlots,
        changes,
        timestamp: Date.now(),
      };

      // Update previous state
      this.previousItems = currentItems;

      // Notify listeners
      for (const listener of this.listeners) {
        try {
          listener(result);
        } catch (err) {
          console.error('[IntegratedInventoryMonitor] Listener error:', err);
        }
      }

      return result;
    } finally {
      // Dispose all render invocations to free native memory
      for (const r of renders) {
        try { r.dispose(); } catch (_) { /* already disposed */ }
      }
    }
  }

  /**
   * Detect items in inventory slots
   */
  private detectItems(elements: RenderRect[]): Map<number, DetectedInventoryItem> {
    const items = new Map<number, DetectedInventoryItem>();

    for (let slot = 0; slot < SLOT_COUNT; slot++) {
      const slotBounds = this.getSlotBounds(slot);
      const slotElements = this.filterByBounds(elements, slotBounds);

      if (slotElements.length === 0) continue;

      // Find the main item sprite (largest non-background, non-font element)
      const itemSprite = this.findItemSprite(slotElements);
      if (!itemSprite) continue;

      const iconHash = itemSprite.sprite.hash;
      const name = this.itemDatabase.get(iconHash) ?? itemSprite.sprite.known?.name ?? null;
      const quantity = this.extractQuantity(slotElements);

      items.set(slot, {
        slot,
        name,
        quantity,
        iconHash,
        bounds: slotBounds,
        confidence: name ? 0.95 : 0.7,
      });
    }

    return items;
  }

  /**
   * Get bounds for a specific inventory slot
   */
  private getSlotBounds(slot: number): { x: number; y: number; width: number; height: number } {
    const { startX, startY, slotWidth, slotHeight, columns, horizontalGap, verticalGap } = this.gridConfig;
    const col = slot % columns;
    const row = Math.floor(slot / columns);

    return {
      x: startX + col * (slotWidth + horizontalGap),
      y: startY + row * (slotHeight + verticalGap),
      width: slotWidth,
      height: slotHeight,
    };
  }

  /**
   * Filter elements within bounds
   */
  private filterByBounds(elements: RenderRect[], bounds: { x: number; y: number; width: number; height: number }): RenderRect[] {
    return elements.filter(
      el =>
        el.x >= bounds.x &&
        el.y >= bounds.y &&
        el.x + el.width <= bounds.x + bounds.width &&
        el.y + el.height <= bounds.y + bounds.height
    );
  }

  /**
   * Find the main item sprite in a slot
   */
  private findItemSprite(slotElements: RenderRect[]): RenderRect | null {
    const itemCandidates = slotElements.filter(el => {
      // Skip inventory slot background
      if (el.sprite.known?.id === INVENTORY_SLOT_SPRITE_ID) return false;
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
   * Extract quantity from slot elements
   */
  private extractQuantity(slotElements: RenderRect[]): number {
    const fontElements = slotElements.filter(el => el.sprite.known?.fontchr);
    if (fontElements.length === 0) return 1;

    // Sort by X position and read
    fontElements.sort((a, b) => a.x - b.x);
    const quantityText = fontElements.map(el => el.sprite.known!.fontchr).join('');

    return this.parseQuantity(quantityText);
  }

  /**
   * Parse quantity text (handles K, M, B suffixes)
   */
  private parseQuantity(text: string): number {
    const cleanText = text.trim().toUpperCase();

    if (cleanText.endsWith('K')) {
      const num = parseFloat(cleanText.slice(0, -1));
      return isNaN(num) ? 1 : Math.round(num * 1000);
    }
    if (cleanText.endsWith('M')) {
      const num = parseFloat(cleanText.slice(0, -1));
      return isNaN(num) ? 1 : Math.round(num * 1000000);
    }
    if (cleanText.endsWith('B')) {
      const num = parseFloat(cleanText.slice(0, -1));
      return isNaN(num) ? 1 : Math.round(num * 1000000000);
    }

    const num = parseInt(cleanText, 10);
    return isNaN(num) ? 1 : num;
  }

  /**
   * Find empty slots
   */
  private findEmptySlots(currentItems: Map<number, DetectedInventoryItem>): number[] {
    const emptySlots: number[] = [];
    for (let slot = 0; slot < SLOT_COUNT; slot++) {
      if (!currentItems.has(slot)) {
        emptySlots.push(slot);
      }
    }
    return emptySlots;
  }

  /**
   * Calculate changes between current and previous state
   */
  private calculateChanges(currentItems: Map<number, DetectedInventoryItem>): InventoryChangeEvent[] {
    const changes: InventoryChangeEvent[] = [];
    const timestamp = Date.now();

    // Check for added/changed items
    for (const [slot, item] of currentItems) {
      const previous = this.previousItems.get(slot);

      if (!previous) {
        changes.push({ type: 'added', slot, item, timestamp });
      } else if (previous.iconHash !== item.iconHash) {
        changes.push({ type: 'removed', slot, item: previous, timestamp });
        changes.push({ type: 'added', slot, item, timestamp });
      } else if (previous.quantity !== item.quantity) {
        changes.push({
          type: 'quantity_changed',
          slot,
          item,
          previousQuantity: previous.quantity,
          newQuantity: item.quantity,
          timestamp,
        });
      }
    }

    // Check for removed items
    for (const [slot, item] of this.previousItems) {
      if (!currentItems.has(slot)) {
        changes.push({ type: 'removed', slot, item, timestamp });
      }
    }

    return changes;
  }

  /**
   * Add a change listener
   */
  onDetection(listener: (result: InventoryDetectionResult) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Start automatic polling
   */
  startPolling(intervalMs: number = 250): void {
    if (this.pollTimer) this.stopPolling();

    this.pollTimer = setInterval(async () => {
      try {
        await this.detect();
      } catch (err) {
        console.error('[IntegratedInventoryMonitor] Detection error:', err);
      }
    }, intervalMs);

    console.log(`[IntegratedInventoryMonitor] Started polling every ${intervalMs}ms`);
  }

  /**
   * Stop automatic polling
   */
  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
      console.log('[IntegratedInventoryMonitor] Stopped polling');
    }
    // Clear cached state to free memory
    this.previousItems.clear();
  }

  /**
   * Check if inventory contains an item by name
   */
  hasItem(name: string): boolean {
    for (const item of this.previousItems.values()) {
      if (item.name?.toLowerCase() === name.toLowerCase()) return true;
    }
    return false;
  }

  /**
   * Check if inventory contains an item by hash
   */
  hasItemHash(hash: number): boolean {
    for (const item of this.previousItems.values()) {
      if (item.iconHash === hash) return true;
    }
    return false;
  }

  /**
   * Get current items
   */
  getCurrentItems(): DetectedInventoryItem[] {
    return Array.from(this.previousItems.values());
  }

  /**
   * Get the total quantity of an item by name (case-insensitive)
   * Returns 0 if item not found
   */
  getItemQuantity(name: string): number {
    let total = 0;
    for (const item of this.previousItems.values()) {
      if (item.name?.toLowerCase() === name.toLowerCase()) {
        total += item.quantity;
      }
    }
    return total;
  }

  /**
   * Check if inventory contains an item with at least the specified quantity
   */
  hasItemWithQuantity(name: string, quantity: number): boolean {
    return this.getItemQuantity(name) >= quantity;
  }

  /**
   * Get item database (for debugging)
   */
  getItemDatabase(): Map<number, string> {
    return new Map(this.itemDatabase);
  }
}

// Singleton instance
let integrationInstance: {
  glBridge: GLBridgeAdapter;
  inventoryMonitor: IntegratedInventoryMonitor;
  dialogBridge: DialogBridgeAdapter;
  tooltipLearner: TooltipItemLearner;
} | null = null;

/**
 * Initialize the QuestStateEngine integration
 */
export async function initializeQuestStateEngine(): Promise<{
  glBridge: GLBridgeAdapter;
  inventoryMonitor: IntegratedInventoryMonitor;
  dialogBridge: DialogBridgeAdapter;
  tooltipLearner: TooltipItemLearner;
}> {
  if (integrationInstance) {
    return integrationInstance;
  }

  console.log('[QSE Integration] Initializing...');

  const glBridge = await createGLBridge();

  // Ensure overlay mouse API is available for tooltip slot detection.
  // Priority 1: Launcher preload already set it up (globalThis.alt1gl)
  // Priority 2: Direct pipe connection to overlay DLL (standalone without launcher)
  if (!patchrs.native.overlay?.getMousePosition) {
    console.log('[QSE Integration] Overlay mouse API not available, trying pipe fallback...');

    let mouseSetUp = false;

    // Fallback: Direct pipe connection (standalone mode, no launcher)
    if (!mouseSetUp) {
      try {
        const mouseClient = new OverlayMouseClient();
        const injectionState = (await import('../api/glInjection')).getInjectionState();
        if (injectionState && injectionState.pid > 0) {
          const connected = await mouseClient.connect(injectionState.pid);
          if (connected) {
            if (!patchrs.native.overlay) {
              (patchrs.native as any).overlay = {};
            }
            (patchrs.native as any).overlay.getMousePosition = () => {
              return mouseClient.getMousePosition();
            };
            mouseSetUp = true;
            console.log(`[QSE Integration] Overlay mouse connected via pipe for PID ${injectionState.pid}`);
          } else {
            console.warn('[QSE Integration] Could not connect to overlay pipe');
          }
        } else {
          console.warn('[QSE Integration] No injection state with valid PID');
        }
      } catch (err) {
        console.warn('[QSE Integration] Failed to set up pipe connection:', err);
      }
    }

    if (!mouseSetUp) {
      console.warn('[QSE Integration] Mouse detection will use tooltip-proximity fallback (no overlay mouse available)');
    }
  } else {
    console.log('[QSE Integration] Overlay mouse API already available');
  }

  const inventoryMonitor = new IntegratedInventoryMonitor(glBridge);
  const dialogBridge = await createDialogBridge();
  const tooltipLearner = createTooltipLearner(glBridge);

  // Wire up tooltip learner to inventory monitor for auto-registration and persistence
  tooltipLearner.onItemLearned((item) => {
    // Register by CRC32 hash (session-specific, immediate lookup)
    inventoryMonitor.registerItem(item.iconHash, item.name);

    // Also register by pHash in the SpriteCache for cross-session lookup
    if (item.pHash && item.pHash.length === 16) {
      const spriteCache = glBridge.getSpriteCache();
      if (!spriteCache.hasItemByPHash(item.pHash)) {
        spriteCache.pHashItems.set(item.pHash, item.name);
        console.log(`[QSE Integration] Registered pHash ${item.pHash} -> "${item.name}" in SpriteCache`);
      }
    }

    console.log(`[QSE Integration] Auto-registered item from tooltip: "${item.name}" (hash: ${item.iconHash}${item.pHash ? `, pHash: ${item.pHash}` : ''})`);
  });

  integrationInstance = { glBridge, inventoryMonitor, dialogBridge, tooltipLearner };

  // Auto-start inventory tracking if setting is enabled
  try {
    const savedSettings = localStorage.getItem('appSettings');
    if (savedSettings) {
      const parsed = JSON.parse(savedSettings);
      if (parsed.inventoryTrackingEnabled) {
        tooltipLearner.startPolling(500);
        console.log('[QSE Integration] Inventory tracking auto-started (setting was enabled)');
      }
    }
  } catch { /* ignore parse errors */ }

  console.log('[QSE Integration] Initialized successfully');
  return integrationInstance;
}

/**
 * Get the inventory monitor (must call initializeQuestStateEngine first)
 */
export function getInventoryMonitor(): IntegratedInventoryMonitor | null {
  return integrationInstance?.inventoryMonitor ?? null;
}

/**
 * Get the GL bridge (must call initializeQuestStateEngine first)
 */
export function getGLBridge(): GLBridgeAdapter | null {
  return integrationInstance?.glBridge ?? null;
}

/**
 * Get the dialog bridge (must call initializeQuestStateEngine first)
 */
export function getDialogBridge(): DialogBridgeAdapter | null {
  return integrationInstance?.dialogBridge ?? null;
}

/**
 * Get the tooltip learner (must call initializeQuestStateEngine first)
 */
export function getTooltipLearner(): TooltipItemLearner | null {
  return integrationInstance?.tooltipLearner ?? _standaloneLearner;
}

/**
 * Standalone learner instance for when QSE isn't initialized.
 * Shares the app's existing SpriteCache singleton to avoid duplicating
 * heavy atlas/font data in memory. No warmup frames needed — the learner's
 * own polling loop progressively warms the atlas tracker.
 */
let _standaloneLearner: TooltipItemLearner | null = null;
let _standaloneInitializing = false;

/**
 * Get or create a tooltip learner — works even without QSE initialization.
 * Lightweight: reuses existing SpriteCache singleton, no warmup frames.
 */
export async function getOrCreateTooltipLearner(): Promise<TooltipItemLearner> {
  // Prefer QSE integration instance
  if (integrationInstance?.tooltipLearner) {
    return integrationInstance.tooltipLearner;
  }

  // Return existing standalone
  if (_standaloneLearner) {
    return _standaloneLearner;
  }

  // Prevent double-init
  if (_standaloneInitializing) {
    while (_standaloneInitializing && !_standaloneLearner) {
      await new Promise(r => setTimeout(r, 100));
    }
    if (_standaloneLearner) return _standaloneLearner;
  }

  _standaloneInitializing = true;
  try {
    const { GLBridgeAdapter } = require('./GLBridgeAdapter');
    const { SpriteCache } = require('../gl/injection/reflect2d/spritecache');

    // Try to reuse an existing bridge (from calibration, SpriteDiscovery, etc.)
    let bridge: any = (window as any)._sharedGLBridge ?? null;

    if (!bridge) {
      // Create one bridge and share it globally so nothing else duplicates it
      const spriteCache = new SpriteCache();
      await spriteCache.downloadCacheData();
      bridge = new GLBridgeAdapter(spriteCache);

      // Initialize mouse tracking
      const mouseOk = await bridge.initMouseTracking();

      (window as any)._sharedGLBridge = bridge;
      console.log(`[QSE] Shared GLBridge created, mouse: ${mouseOk ? 'OK' : 'FAILED'}`);
    } else {
      console.log('[QSE] Reusing existing shared GLBridge');
    }

    const learner = createTooltipLearner(bridge);

    // Auto-load calibration from localStorage
    try {
      const saved = localStorage.getItem('inventoryMouseCalibration');
      if (saved) {
        const data = JSON.parse(saved);
        learner.importCalibration(data);
        console.log(`[QSE] Standalone learner: loaded ${data.length} calibration entries`);
      }
    } catch { /* ignore */ }

    _standaloneLearner = learner;
    return learner;
  } finally {
    _standaloneInitializing = false;
  }
}
