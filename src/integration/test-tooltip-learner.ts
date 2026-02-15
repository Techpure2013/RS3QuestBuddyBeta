/**
 * Test script for TooltipItemLearner
 *
 * Run this with the game client open and hover over inventory items
 * to test the tooltip detection and item learning.
 */

import { type RenderRect, GLBridgeAdapter } from './GLBridgeAdapter';
import { TooltipItemLearner, findMousePosition, TOOLTIP_SPRITE_IDS } from './TooltipItemLearner';
import type { RenderInvocation } from '../gl/injection/util/patchrs_napi';
import * as patchrs from '../gl/injection/util/patchrs_napi';
import { AtlasTracker, getUIState } from '../gl/injection/reflect2d/reflect2d';
import { SpriteCache } from '../gl/injection/reflect2d/spritecache';
import { dHash, hashToHex } from '../gl/injection/util/phash';
import { OverlayMouseClient } from './OverlayMouseClient';

// Persistent singleton for the test - reused across calls
let persistentSpriteCache: SpriteCache | null = null;
let persistentAtlasTracker: AtlasTracker | null = null;
let persistentGLBridge: GLBridgeAdapter | null = null;

async function getOrCreateGLBridge(): Promise<GLBridgeAdapter> {
  if (persistentGLBridge && persistentSpriteCache && persistentAtlasTracker) {
    return persistentGLBridge;
  }

  console.log('[Test] Creating persistent GLBridge...');
  persistentSpriteCache = new SpriteCache();
  await persistentSpriteCache.downloadCacheData();
  persistentGLBridge = new GLBridgeAdapter(persistentSpriteCache);

  // Use the GLBridgeAdapter's internal AtlasTracker for consistency
  persistentAtlasTracker = persistentGLBridge.getAtlasTracker();

  // Warm up by capturing a few frames - use the GLBridgeAdapter's tracker
  console.log('[Test] Warming up AtlasTracker...');
  for (let i = 0; i < 5; i++) {
    try {
      const renders = await patchrs.native.recordRenderCalls({
        features: ['vertexarray', 'uniforms', 'texturesnapshot'],
      });
      // Warm up the GLBridgeAdapter's internal tracker
      getUIState(renders, persistentAtlasTracker);
    } catch (e) {
      // Ignore warm-up errors
    }
  }
  console.log('[Test] Warm-up complete');

  // Initialize mouse tracking overlay
  let mouseOk = await persistentGLBridge.initMouseTracking();

  // If overlay API not available natively, try pipe fallback
  if (!mouseOk) {
    console.log('[Test] Overlay mouse API not available, trying pipe fallback...');

    // Fallback: Direct pipe connection to overlay DLL (standalone mode)
    if (!mouseOk) {
      try {
        const mouseClient = new OverlayMouseClient();
        const injectionMod = await import('../api/glInjection');
        const injectionState = injectionMod.getInjectionState();
        if (injectionState && injectionState.pid > 0) {
          const connected = await mouseClient.connect(injectionState.pid);
          if (connected) {
            if (!patchrs.native.overlay) {
              (patchrs.native as any).overlay = {};
            }
            (patchrs.native as any).overlay.getMousePosition = () => {
              return mouseClient.getMousePosition();
            };
            mouseOk = true;
            console.log(`[Test] Overlay mouse connected via pipe for PID ${injectionState.pid}`);
          } else {
            console.warn('[Test] Could not connect to overlay pipe');
          }
        } else {
          console.warn('[Test] No injection state with valid PID');
        }
      } catch (err) {
        console.warn('[Test] Failed to set up overlay mouse pipe:', err);
      }
    }
  }

  console.log(`[Test] Mouse tracking: ${mouseOk ? 'OK' : 'FAILED'}`);

  return persistentGLBridge;
}

// Inventory constants
const INVENTORY_SLOT_SPRITE_ID = 18266;
const SLOT_WIDTH = 40;
const SLOT_HEIGHT = 36;

interface InventorySlotData {
  slot: number;
  x: number;
  y: number;
  width: number;
  height: number;
  hasItem: boolean;
  itemPHash?: string;
  itemHash?: number;
}

/**
 * Cluster numeric values within tolerance, returning clusters with center and count
 */
function clusterValues(values: number[], tolerance: number): { center: number; count: number }[] {
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

  // Sort by position for consistent output
  return clusters
    .sort((a, b) => a.center - b.center)
    .map(c => ({ center: c.center, count: c.count }));
}

/**
 * Detect inventory grid from elements.
 * Uses clustering to determine column/row positions and assigns
 * slot indices as row * COLS + col (row 0 = highest Y in RS3).
 */
let _gridDebugLogged = false;
function detectInventoryGrid(elements: RenderRect[]): {
  slots: InventorySlotData[];
  gridStart: { x: number; y: number } | null;
} {
  // Find all inventory slot sprites
  const slotSprites = elements.filter(
    (el) => el.sprite?.known?.id === INVENTORY_SLOT_SPRITE_ID
  );

  if (slotSprites.length === 0) {
    return { slots: [], gridStart: null };
  }

  // Cluster X positions into columns and Y positions into rows (tolerance 8px)
  const xValues = slotSprites.map(s => s.x);
  const yValues = slotSprites.map(s => s.y);

  const allXClusters = clusterValues(xValues, 8);
  const allYClusters = clusterValues(yValues, 8);

  // Debug: Log clustering results once
  if (!_gridDebugLogged) {
    console.log(`[Grid] ${slotSprites.length} slot sprites found`);
    console.log(`[Grid] Raw positions: ${slotSprites.map(s => `(${s.x.toFixed(0)},${s.y.toFixed(0)})`).join(' ')}`);
    console.log(`[Grid] X clusters (${allXClusters.length}): ${allXClusters.map(c => `${c.center.toFixed(1)}(x${c.count})`).join(', ')}`);
    console.log(`[Grid] Y clusters (${allYClusters.length}): ${allYClusters.map(c => `${c.center.toFixed(1)}(x${c.count})`).join(', ')}`);
    // Also count unresolved sprites (no known ID) as they may be missing inventory slots
    const unresolvedCount = elements.filter(el => !el.sprite?.known).length;
    const totalElements = elements.length;
    console.log(`[Grid] Elements: ${totalElements} total, ${unresolvedCount} unresolved sprite IDs`);
    _gridDebugLogged = true;
  }

  // Filter to clusters with at least 2 members (removes noise from stray sprites)
  const significantXClusters = allXClusters.filter(c => c.count >= 2);
  const significantYClusters = allYClusters.filter(c => c.count >= 2);

  // Always use significant clusters for columns (noise clusters with count=1 are stray sprites)
  const columns = significantXClusters.length >= 2 ? significantXClusters : allXClusters;
  const rows = significantYClusters.length >= 2 ? significantYClusters : allYClusters;

  // Use detected column/row counts — inventory layout can vary (4 or 5 columns,
  // different row counts depending on interface scaling and backpack size).
  const colCenters = columns.map(c => c.center);
  const detectedCols = colCenters.length;

  // Rows: reverse so row 0 = highest Y = top of inventory visually (GL Y-up).
  const rowCenters = rows.map(c => c.center).reverse();

  if (colCenters.length < 2 || rowCenters.length < 2) {
    return { slots: [], gridStart: null };
  }

  const gridStart = {
    x: colCenters[0],
    y: rowCenters[0] // Max Y = top in RS3
  };

  const slots: InventorySlotData[] = [];

  // Helper: find the largest item sprite within given bounds
  function findItemInBounds(bx: number, by: number, bw: number, bh: number) {
    const itemsInSlot = elements.filter((el) => {
      if (el.sprite?.known?.id === INVENTORY_SLOT_SPRITE_ID) return false;
      if (el.sprite?.known?.fontchr) return false; // Skip text
      if (el.width < 10 || el.height < 10) return false; // Skip tiny elements
      return (
        el.x >= bx - 2 &&
        el.y >= by - 2 &&
        el.x + el.width <= bx + bw + 5 &&
        el.y + el.height <= by + bh + 5
      );
    });
    if (itemsInSlot.length === 0) return null;
    return itemsInSlot.reduce((largest, curr) => {
      return (curr.width * curr.height) > (largest.width * largest.height) ? curr : largest;
    });
  }

  // Helper: compute pHash for an item sprite
  function computeItemPHash(itemSprite: any): { pHash?: string; hash?: number } {
    const result: { pHash?: string; hash?: number } = {};
    if (!itemSprite) return result;
    result.hash = itemSprite.sprite.hash;
    try {
      const sprite = itemSprite.sprite;
      if (sprite.basetex && typeof sprite.basetex.capture === 'function') {
        const imgData = sprite.basetex.capture(sprite.x, sprite.y, sprite.width, sprite.height);
        const pHashValue = dHash(imgData.data, imgData.width, imgData.height);
        result.pHash = hashToHex(pHashValue);
      }
    } catch (e) { /* pHash not always possible */ }
    return result;
  }

  // Iterate ALL grid positions (row x col), including extrapolated rows
  // that may not have slot background sprites resolved yet.
  for (let row = 0; row < rowCenters.length; row++) {
    for (let col = 0; col < colCenters.length; col++) {
      const slotIndex = row * detectedCols + col;
      const slotX = colCenters[col];
      const slotY = rowCenters[row];

      const itemSprite = findItemInBounds(slotX, slotY, SLOT_WIDTH, SLOT_HEIGHT);
      const { pHash: itemPHash, hash: itemHash } = computeItemPHash(itemSprite);

      slots.push({
        slot: slotIndex,
        x: Math.round(slotX),
        y: Math.round(slotY),
        width: SLOT_WIDTH,
        height: SLOT_HEIGHT,
        hasItem: itemSprite !== null,
        itemPHash,
        itemHash,
      });
    }
  }

  // Sort by slot index for consistent output
  slots.sort((a, b) => a.slot - b.slot);

  return { slots, gridStart };
}

/**
 * Find which slot contains a point.
 * Uses nearest-center matching with generous tolerance.
 * Slot sprite Y is the BOTTOM edge (from GL botleft vertex), so the mouse
 * hovering an item is typically above the sprite Y by more than the sprite height
 * (inventory panel header, cursor offset, IPC latency drift).
 * Use 2x cell step tolerance to cover the full slot area + margin.
 */
function findSlotAtPoint(slots: InventorySlotData[], x: number, y: number): InventorySlotData | null {
  if (slots.length === 0) return null;

  // Estimate cell step from slot positions
  const sortedY = [...new Set(slots.map(s => s.y))].sort((a, b) => a - b);
  const ySteps: number[] = [];
  for (let i = 1; i < sortedY.length; i++) ySteps.push(sortedY[i] - sortedY[i - 1]);
  const cellStepY = ySteps.length > 0
    ? ySteps.sort((a, b) => a - b)[Math.floor(ySteps.length / 2)]
    : slots[0].height;

  const sortedX = [...new Set(slots.map(s => s.x))].sort((a, b) => a - b);
  const xSteps: number[] = [];
  for (let i = 1; i < sortedX.length; i++) xSteps.push(sortedX[i] - sortedX[i - 1]);
  const cellStepX = xSteps.length > 0
    ? xSteps.sort((a, b) => a - b)[Math.floor(xSteps.length / 2)]
    : slots[0].width;

  // Generous tolerance: 2x cell step covers cursor drift + panel header offset
  const maxDX = cellStepX * 1.5;
  const maxDY = cellStepY * 2;

  let best: InventorySlotData | null = null;
  let bestDist = Infinity;

  for (const slot of slots) {
    const cx = slot.x + slot.width / 2;
    const cy = slot.y + slot.height / 2;
    const dx = Math.abs(x - cx);
    const dy = Math.abs(y - cy);

    if (dx > maxDX || dy > maxDY) continue;

    const dist = dx + dy;
    if (dist < bestDist) {
      bestDist = dist;
      best = slot;
    }
  }
  return best;
}

/**
 * Find slot closest to tooltip by column alignment.
 * Tooltip centerX is reliably centered over the hovered slot's column.
 * Y proximity is unreliable because tooltip follows cursor and can appear
 * far from the item in GL Y-up coordinates.
 */
function findSlotNearTooltip(
  slots: InventorySlotData[],
  tooltipBounds: { x: number; y: number; width: number; height: number },
  mousePos?: { x: number; y: number } | null
): InventorySlotData | null {
  const tooltipCenterX = tooltipBounds.x + tooltipBounds.width / 2;

  // Find the column whose center X is closest to tooltip centerX
  // Group slots by column (X position)
  const columnMap = new Map<number, InventorySlotData[]>();
  for (const slot of slots) {
    if (!slot.hasItem) continue;
    const colKey = Math.round(slot.x); // slots in same column have same X
    if (!columnMap.has(colKey)) columnMap.set(colKey, []);
    columnMap.get(colKey)!.push(slot);
  }

  let bestCol: InventorySlotData[] | null = null;
  let bestDist = Infinity;
  for (const [colX, colSlots] of columnMap) {
    const colCenterX = colX + (colSlots[0].width / 2);
    const dist = Math.abs(tooltipCenterX - colCenterX);
    if (dist < bestDist) {
      bestDist = dist;
      bestCol = colSlots;
    }
  }

  // Reject if too far from any column (>100px)
  if (!bestCol || bestDist > 100) return null;

  // Use mouse Y to pick the closest row if available
  if (mousePos && bestCol.length > 1) {
    let bestSlot: InventorySlotData | null = null;
    let bestYDist = Infinity;
    for (const slot of bestCol) {
      const slotCenterY = slot.y + slot.height / 2;
      const yDist = Math.abs(slotCenterY - mousePos.y);
      if (yDist < bestYDist) {
        bestYDist = yDist;
        bestSlot = slot;
      }
    }
    return bestSlot;
  }

  // No mouse — return the topmost item (lowest slot index = row 0)
  bestCol.sort((a, b) => a.slot - b.slot);
  return bestCol[0];
}

async function testTooltipLearner() {
  console.log('=== TooltipItemLearner Test ===\n');

  // Reset debug flag so we get fresh grid debug output each test run
  _gridDebugLogged = false;

  // Initialize GL Bridge (persistent singleton)
  console.log('Initializing GL Bridge...');
  const glBridge = await getOrCreateGLBridge();
  console.log('GL Bridge initialized.\n');

  // Create tooltip learner
  const learner = new TooltipItemLearner(glBridge);

  // Auto-load saved mouse calibration data
  try {
    const saved = localStorage.getItem('inventoryMouseCalibration');
    if (saved) {
      const calData = JSON.parse(saved) as { slot: number; x: number; y: number }[];
      learner.importCalibration(calData);
      console.log(`[Test] Loaded saved mouse calibration: ${calData.length} slots`);
    } else {
      console.log('[Test] No saved mouse calibration. Run window.calibrateMouse() first for best accuracy.');
    }
  } catch (e) {
    console.warn('[Test] Could not load saved calibration:', e);
  }

  // Track learned associations: pHash -> item name
  const learnedItems = new Map<string, string>();

  // Listen for learned items
  learner.onItemLearned((item) => {
    console.log('\n*** NEW ITEM LEARNED ***');
    console.log(`  Name: "${item.name}"`);
    console.log(`  Icon Hash: ${item.iconHash}`);
    console.log(`  pHash: ${item.pHash ?? 'none'}`);
    console.log(`  Confidence: ${(item.confidence * 100).toFixed(0)}%`);
    console.log('************************\n');
  });

  console.log('Starting tooltip + inventory detection...');
  console.log('Hover over inventory items to test.\n');
  console.log('Tooltip sprite IDs:', TOOLTIP_SPRITE_IDS);
  console.log('');

  // Run detection loop
  let frameCount = 0;
  const maxFrames = 200; // Run for ~100 seconds at 500ms interval
  let lastLoggedSlot = -1;
  let lastTooltipText = '';

  const interval = setInterval(async () => {
    frameCount++;

    try {
      // Capture mouse position BEFORE render capture starts.
      // recordRenderCalls takes 200-400ms (waits for frame swap + reads buffers).
      // By the time it returns, the user has often moved the cursor away from the slot.
      // The pre-render position is much more likely to be on the actual hovered slot.
      const preRenderMousePos = glBridge.getMousePositionGL(frameCount <= 5);

      // Get renders with uniforms for mouse position - use patchrs directly with persistent tracker
      const renders = await patchrs.native.recordRenderCalls({
        features: ['vertexarray', 'uniforms', 'texturesnapshot'],
      });

      // Also capture post-render mouse for comparison
      const postRenderMousePos = glBridge.getMousePositionGL(false);

      // Use pre-render position (more accurate for slot matching)
      const frameMousePos = preRenderMousePos;

      // Use persistent AtlasTracker for proper sprite caching
      const uiState = getUIState(renders, persistentAtlasTracker!);

      // Convert to our RenderRect format
      const elements: RenderRect[] = uiState.elements.map(el => ({
        x: el.x,
        y: el.y,
        width: el.width,
        height: el.height,
        color: [
          Math.round(el.color[3] * 255),
          Math.round(el.color[2] * 255),
          Math.round(el.color[1] * 255),
          Math.round(el.color[0] * 255),
        ] as [number, number, number, number],
        sprite: {
          hash: el.sprite.pixelhash,
          known: el.sprite.known ? {
            id: el.sprite.known.id,
            subId: el.sprite.known.subid,
            fontchr: el.sprite.known.fontchr ? {
              chr: el.sprite.known.fontchr.chr,
              charcode: el.sprite.known.fontchr.charcode,
            } : undefined,
            font: el.sprite.known.font,
          } : undefined,
          // Also keep raw sprite for pHash computation
          basetex: el.sprite.basetex,
          pixelhash: el.sprite.pixelhash,
          x: el.sprite.x,
          y: el.sprite.y,
          width: el.sprite.width,
          height: el.sprite.height,
        } as any,
      }));

      // Detect inventory grid
      const { slots, gridStart } = detectInventoryGrid(elements);

      // Use pre-captured mouse position; fall back to uniform if needed
      let mousePos = frameMousePos;
      let mouseSource = mousePos ? 'glbridge' : 'none';
      if (!mousePos) {
        // Last resort: check render uniforms for uMouse
        const rawRenders = renders as unknown as RenderInvocation[];
        mousePos = findMousePosition(rawRenders);
        if (mousePos) mouseSource = 'uniform';
      }

      // Run tooltip detection using already-captured elements + pre-captured mouse
      const result = learner.detectFromElements(elements, renders, frameMousePos);

      // Use the learner's slot match (has lastGridMousePos tracking for drift handling)
      // Then look up the full slot data from our local slots array
      let hoveredSlot: InventorySlotData | null = null;
      if (result.nearestSlot !== null && slots.length > 0) {
        hoveredSlot = slots.find(s => s.slot === result.nearestSlot) ?? null;
      }
      // Fallback 1: direct mouse hit-test
      if (!hoveredSlot && mousePos && slots.length > 0) {
        hoveredSlot = findSlotAtPoint(slots, mousePos.x, mousePos.y);
      }
      // Fallback 2: tooltip column alignment + mouse Y for row
      // (mouse may have drifted away, but tooltip center X reliably aligns with the hovered column)
      if (!hoveredSlot && result.bounds && slots.length > 0) {
        hoveredSlot = findSlotNearTooltip(slots, result.bounds, mousePos);
      }

      // Log detailed info when tooltip is visible
      if (result.isVisible) {
        console.log(`[TOOLTIP DETECTED] Text: "${result.text}" | Bounds: (${result.bounds?.x?.toFixed(0)}, ${result.bounds?.y?.toFixed(0)}) ${result.bounds?.width?.toFixed(0)}x${result.bounds?.height?.toFixed(0)}`);
      }

      if (result.isVisible && result.text) {
        const slotInfo = hoveredSlot
          ? `Slot ${hoveredSlot.slot + 1} (${hoveredSlot.x}, ${hoveredSlot.y}) pHash: ${hoveredSlot.itemPHash ?? 'N/A'}`
          : 'No slot detected';

        // Only log when something changes
        if (hoveredSlot?.slot !== lastLoggedSlot || result.text !== lastTooltipText) {
          console.log('╔══════════════════════════════════════════════════════════════╗');
          console.log('║ TOOLTIP + INVENTORY LINK                                     ║');
          console.log('╠══════════════════════════════════════════════════════════════╣');
          console.log(`║ Tooltip: "${result.text}"`);
          console.log(`║ ${slotInfo}`);
          if (mousePos) {
            console.log(`║ Mouse: (${mousePos.x.toFixed(0)}, ${mousePos.y.toFixed(0)})`);
          }
          if (result.bounds) {
            console.log(`║ Tooltip bounds: (${result.bounds.x.toFixed(0)}, ${result.bounds.y.toFixed(0)}) ${result.bounds.width.toFixed(0)}x${result.bounds.height.toFixed(0)}`);
          }
          console.log(`║ Inventory: ${slots.length} slots detected, ${slots.filter(s => s.hasItem).length} with items`);
          if (gridStart) {
            console.log(`║ Grid start: (${gridStart.x}, ${gridStart.y})`);
          }
          console.log('╚══════════════════════════════════════════════════════════════╝');

          // Learn the association
          if (hoveredSlot && hoveredSlot.itemPHash && result.text) {
            // Extract just the item name (first line, remove "Withdraw-1" etc.)
            const firstLine = result.text.split('\n')[0] ?? '';
            const itemName = firstLine.replace(/^(Withdraw|Deposit|Use|Eat|Drink|Drop|Examine|Equip|Wield|Remove)-?\s*\d*\s*/i, '').trim();

            if (itemName && itemName.length > 0) {
              learnedItems.set(hoveredSlot.itemPHash, itemName);
              console.log(`[LEARNED] pHash ${hoveredSlot.itemPHash} = "${itemName}"`);
            }
          }

          lastLoggedSlot = hoveredSlot?.slot ?? -1;
          lastTooltipText = result.text;
        }
      } else {
        // Reset when no tooltip
        if (lastLoggedSlot !== -1) {
          lastLoggedSlot = -1;
          lastTooltipText = '';
        }

        // Periodic status update
        if (frameCount % 20 === 0) {
          const mouseStr = mousePos ? `(${mousePos.x.toFixed(0)}, ${mousePos.y.toFixed(0)}) [${mouseSource}]` : 'not found';
          console.log(`[${frameCount}] Mouse: ${mouseStr} | Slots: ${slots.length} | Items: ${slots.filter(s => s.hasItem).length} | Learned: ${learnedItems.size} | Elements: ${elements.length}`);

          // Debug: Log first few sprite IDs we're seeing
          if (frameCount === 20 && elements.length > 0) {
            const spriteIds = new Set<number>();
            for (const el of elements) {
              if (el.sprite?.known?.id) spriteIds.add(el.sprite.known.id);
            }
            console.log(`[DEBUG] Found sprite IDs: ${Array.from(spriteIds).slice(0, 20).join(', ')}${spriteIds.size > 20 ? '...' : ''}`);
            console.log(`[DEBUG] Looking for inventory slot sprite ID: ${INVENTORY_SLOT_SPRITE_ID}`);
            console.log(`[DEBUG] Looking for tooltip sprite IDs: ${Object.values(TOOLTIP_SPRITE_IDS).join(', ')}`);

            // Check if any tooltip sprites exist
            const tooltipSpriteCount = elements.filter(el =>
              el.sprite?.known?.id === TOOLTIP_SPRITE_IDS.topLeft ||
              el.sprite?.known?.id === TOOLTIP_SPRITE_IDS.topRight ||
              el.sprite?.known?.id === TOOLTIP_SPRITE_IDS.bottomLeft ||
              el.sprite?.known?.id === TOOLTIP_SPRITE_IDS.center
            ).length;
            console.log(`[DEBUG] Tooltip sprites found in frame: ${tooltipSpriteCount}`);
          }
        }
      }

    } catch (err) {
      console.error(`[${frameCount}] Error:`, err);
    }

    if (frameCount >= maxFrames) {
      clearInterval(interval);
      console.log('\n=== Test Complete ===');
      console.log('Learned item associations:', learnedItems.size);
      for (const [pHash, name] of learnedItems) {
        console.log(`  - ${pHash}: "${name}"`);
      }
    }
  }, 500);
}

// Also export a quick single-frame test
export async function quickTest() {
  const glBridge = await getOrCreateGLBridge();
  const learner = new TooltipItemLearner(glBridge);

  console.log('Running single detection...');

  // Get renders using persistent AtlasTracker
  const renders = await patchrs.native.recordRenderCalls({
    features: ['vertexarray', 'uniforms', 'texturesnapshot'],
  });

  const uiState = getUIState(renders, persistentAtlasTracker!);

  // Convert to RenderRect format, preserving raw sprite for pHash computation
  const elements: RenderRect[] = uiState.elements.map(el => ({
    x: el.x,
    y: el.y,
    width: el.width,
    height: el.height,
    color: [
      Math.round(el.color[3] * 255),
      Math.round(el.color[2] * 255),
      Math.round(el.color[1] * 255),
      Math.round(el.color[0] * 255),
    ] as [number, number, number, number],
    sprite: {
      hash: el.sprite.pixelhash,
      known: el.sprite.known ? {
        id: el.sprite.known.id,
        subId: el.sprite.known.subid,
        fontchr: el.sprite.known.fontchr ? {
          chr: el.sprite.known.fontchr.chr,
          charcode: el.sprite.known.fontchr.charcode,
        } : undefined,
        font: el.sprite.known.font,
        name: el.sprite.known.itemName,
      } : undefined,
      // Preserve raw sprite data for pHash computation
      basetex: el.sprite.basetex,
      x: el.sprite.x,
      y: el.sprite.y,
      width: el.sprite.width,
      height: el.sprite.height,
    } as any,
  }));

  // Detect inventory
  const { slots, gridStart } = detectInventoryGrid(elements);

  // Detect tooltip
  const result = await learner.detectAndLearn();

  // Get mouse position
  const rawRenders = renders as unknown as RenderInvocation[];
  const mousePos = findMousePosition(rawRenders);

  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║ QUICK TEST RESULT                                            ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║ Elements: ${elements.length}`);
  console.log(`║ Inventory slots: ${slots.length}`);
  console.log(`║ Slots with items: ${slots.filter(s => s.hasItem).length}`);
  if (gridStart) {
    console.log(`║ Grid start: (${gridStart.x}, ${gridStart.y})`);
  }
  console.log(`║ Mouse: ${mousePos ? `(${mousePos.x.toFixed(0)}, ${mousePos.y.toFixed(0)})` : 'not detected'}`);
  console.log(`║ Tooltip visible: ${result.isVisible}`);
  if (result.isVisible) {
    console.log(`║ Tooltip text: "${result.text}"`);
    if (result.bounds) {
      console.log(`║ Tooltip bounds: (${result.bounds.x.toFixed(0)}, ${result.bounds.y.toFixed(0)})`);
    }
  }
  console.log('╚══════════════════════════════════════════════════════════════╝');

  // Log slot details
  if (slots.length > 0) {
    console.log('\nSlot details:');
    for (const slot of slots) {
      if (slot.hasItem) {
        console.log(`  [${slot.slot + 1}] (${slot.x}, ${slot.y}) - Item pHash: ${slot.itemPHash ?? 'N/A'}`);
      }
    }
  }

  return { result, slots, mousePos, gridStart };
}

// Test inventory detection only
export async function testInventory() {
  await getOrCreateGLBridge();

  console.log('Detecting inventory...');

  // Get renders using persistent AtlasTracker
  const renders = await patchrs.native.recordRenderCalls({
    features: ['vertexarray', 'uniforms', 'texturesnapshot'],
  });

  const uiState = getUIState(renders, persistentAtlasTracker!);

  // Convert to RenderRect format, preserving raw sprite for pHash computation
  const elements: RenderRect[] = uiState.elements.map(el => ({
    x: el.x,
    y: el.y,
    width: el.width,
    height: el.height,
    color: [
      Math.round(el.color[3] * 255),
      Math.round(el.color[2] * 255),
      Math.round(el.color[1] * 255),
      Math.round(el.color[0] * 255),
    ] as [number, number, number, number],
    sprite: {
      hash: el.sprite.pixelhash,
      known: el.sprite.known ? {
        id: el.sprite.known.id,
        subId: el.sprite.known.subid,
        fontchr: el.sprite.known.fontchr ? {
          chr: el.sprite.known.fontchr.chr,
          charcode: el.sprite.known.fontchr.charcode,
        } : undefined,
        font: el.sprite.known.font,
        name: el.sprite.known.itemName,
      } : undefined,
      // Preserve raw sprite data for pHash computation
      basetex: el.sprite.basetex,
      x: el.sprite.x,
      y: el.sprite.y,
      width: el.sprite.width,
      height: el.sprite.height,
    } as any,
  }));

  const { slots, gridStart } = detectInventoryGrid(elements);

  // Debug: find item-sized sprites near the grid X range that weren't matched to any slot
  if (slots.length > 0) {
    const gridMinX = Math.min(...slots.map(s => s.x)) - 5;
    const gridMaxX = Math.max(...slots.map(s => s.x)) + SLOT_WIDTH + 5;
    const gridMinY = Math.min(...slots.map(s => s.y)) - 50;
    const gridMaxY = Math.max(...slots.map(s => s.y)) + SLOT_HEIGHT + 50;
    const matchedItems = slots.filter(s => s.hasItem);
    const unmatchedItems = elements.filter(el => {
      if (el.sprite?.known?.id === INVENTORY_SLOT_SPRITE_ID) return false;
      if (el.sprite?.known?.fontchr) return false;
      if (el.width < 10 || el.height < 10) return false;
      if (el.x < gridMinX || el.x > gridMaxX) return false;
      if (el.y < gridMinY || el.y > gridMaxY) return false;
      // Check if this element is already matched
      for (const s of matchedItems) {
        if (el.x >= s.x - 2 && el.y >= s.y - 2 &&
            el.x + el.width <= s.x + s.width + 5 &&
            el.y + el.height <= s.y + s.height + 5) return false;
      }
      return true;
    });
    if (unmatchedItems.length > 0) {
      console.log(`[Debug] ${unmatchedItems.length} unmatched item-sized sprites near grid:`);
      for (const el of unmatchedItems.slice(0, 20)) {
        console.log(`  (${el.x.toFixed(0)}, ${el.y.toFixed(0)}) ${el.width.toFixed(0)}x${el.height.toFixed(0)} sprite=${el.sprite?.known?.id ?? 'unknown'} hash=${el.sprite?.hash}`);
      }
    }
  }

  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║ INVENTORY DETECTION                                          ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║ Total elements: ${elements.length}`);
  console.log(`║ Inventory slots found: ${slots.length}`);
  console.log(`║ Slots with items: ${slots.filter(s => s.hasItem).length}`);

  if (gridStart) {
    console.log(`║ Grid start: (${gridStart.x}, ${gridStart.y})`);
  } else {
    console.log('║ Grid: NOT DETECTED - Is inventory visible?');
  }
  console.log('╚══════════════════════════════════════════════════════════════╝');

  if (slots.length > 0) {
    console.log('\nInventory contents:');
    console.log('┌──────┬────────────┬──────────────────────┐');
    console.log('│ Slot │ Position   │ Item pHash           │');
    console.log('├──────┼────────────┼──────────────────────┤');
    for (const slot of slots) {
      const posStr = `(${slot.x}, ${slot.y})`.padEnd(10);
      const pHashStr = slot.hasItem ? (slot.itemPHash ?? 'computing...').substring(0, 18) : '-'.padEnd(18);
      console.log(`│ ${String(slot.slot + 1).padStart(4)} │ ${posStr} │ ${pHashStr.padEnd(20)} │`);
    }
    console.log('└──────┴────────────┴──────────────────────┘');
  }

  return { slots, gridStart, elements };
}

/**
 * Mouse Calibration for Inventory
 *
 * Guides the user to hover each inventory slot in sequence.
 * For each slot, records the (drifted) mouse position when a tooltip is detected.
 * After calibration, the tooltip learner uses these reference positions to accurately
 * determine which slot is being hovered — eliminating IPC mouse drift issues.
 *
 * Usage: window.calibrateMouse()
 *   - Detects inventory grid first
 *   - Asks user to hover slot 1, then slot 2, etc.
 *   - Records mouse position when tooltip appears over each slot
 *   - Requires 2 tooltip sightings per slot for averaging
 *   - Skips empty slots automatically
 *   - Prints calibration summary when complete
 *   - Stores calibration data in the TooltipItemLearner for immediate use
 */
async function calibrateMouse() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║ MOUSE CALIBRATION FOR INVENTORY                             ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log('║ This will guide you to hover each inventory slot.           ║');
  console.log('║ When you hover a slot, the mouse position is recorded.      ║');
  console.log('║ This calibrates the system to handle IPC mouse drift.       ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  // Initialize GL Bridge
  const glBridge = await getOrCreateGLBridge();

  // First, detect inventory to find which slots have items
  const renders = await patchrs.native.recordRenderCalls({
    features: ['vertexarray', 'uniforms', 'texturesnapshot'],
  });
  const uiState = getUIState(renders, persistentAtlasTracker!);
  const elements: RenderRect[] = uiState.elements.map(el => ({
    x: el.x,
    y: el.y,
    width: el.width,
    height: el.height,
    color: [
      Math.round(el.color[3] * 255),
      Math.round(el.color[2] * 255),
      Math.round(el.color[1] * 255),
      Math.round(el.color[0] * 255),
    ] as [number, number, number, number],
    sprite: {
      hash: el.sprite.pixelhash,
      known: el.sprite.known ? {
        id: el.sprite.known.id,
        subId: el.sprite.known.subid,
        fontchr: el.sprite.known.fontchr ? {
          chr: el.sprite.known.fontchr.chr,
          charcode: el.sprite.known.fontchr.charcode,
        } : undefined,
        font: el.sprite.known.font,
      } : undefined,
      basetex: el.sprite.basetex,
      pixelhash: el.sprite.pixelhash,
      x: el.sprite.x,
      y: el.sprite.y,
      width: el.sprite.width,
      height: el.sprite.height,
    } as any,
  }));

  const { slots } = detectInventoryGrid(elements);
  if (slots.length === 0) {
    console.error('[Calibration] No inventory slots detected! Make sure your inventory is open.');
    return;
  }

  const slotsWithItems = slots.filter(s => s.hasItem);
  console.log(`[Calibration] Found ${slots.length} slots, ${slotsWithItems.length} with items`);
  console.log(`[Calibration] Will calibrate ${slotsWithItems.length} slots with items (empty slots skipped)`);
  console.log('');

  // Create a learner to use its calibration API
  const learner = new TooltipItemLearner(glBridge);

  // Also auto-calibrate the learner's grid from elements
  learner.detectFromElements(elements, renders, null);

  // Calibration state
  const SAMPLES_PER_SLOT = 2;
  const calibrationData: Map<number, { x: number; y: number }[]> = new Map();
  let currentTargetIdx = 0;

  // Determine grid layout for display
  const colCenters = [...new Set(slots.map(s => s.x))].sort((a, b) => a - b);
  const rowCenters = [...new Set(slots.map(s => s.y))].sort((a, b) => b - a); // Y descending (GL Y-up, row 0 = top)
  const numCols = colCenters.length;

  function getRowCol(slotIndex: number): { row: number; col: number } {
    return { row: Math.floor(slotIndex / numCols), col: slotIndex % numCols };
  }

  let countdownActive = false;
  let captureReady = false;

  async function countdown(seconds: number): Promise<void> {
    countdownActive = true;
    captureReady = false;
    for (let i = seconds; i > 0; i--) {
      console.log(`  ⏱️  ${i}...`);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    console.log(`  📸 CAPTURE! Hold still...`);
    countdownActive = false;
    captureReady = true;
  }

  async function promptNextSlot() {
    if (currentTargetIdx >= slotsWithItems.length) {
      finishCalibration();
      return;
    }
    const target = slotsWithItems[currentTargetIdx];
    const { row, col } = getRowCol(target.slot);
    console.log(`\n>>> Hover SLOT ${target.slot + 1} (row ${row + 1}, col ${col + 1}) — then hold still <<<`);
    await countdown(3);
  }

  function finishCalibration() {
    console.log('\n╔══════════════════════════════════════════════════════════════╗');
    console.log('║ CALIBRATION COMPLETE                                         ║');
    console.log('╠══════════════════════════════════════════════════════════════╣');

    // Build summary and import into learner
    const exportData: { slot: number; x: number; y: number }[] = [];
    for (const [slotIdx, samples] of calibrationData) {
      const avgX = samples.reduce((s, p) => s + p.x, 0) / samples.length;
      const avgY = samples.reduce((s, p) => s + p.y, 0) / samples.length;
      const { row, col } = getRowCol(slotIdx);
      console.log(`║ Slot ${String(slotIdx + 1).padStart(2)} (row${row + 1},col${col + 1}): mouse avg (${avgX.toFixed(0)}, ${avgY.toFixed(0)}) from ${samples.length} samples`);
      exportData.push({ slot: slotIdx, x: avgX, y: avgY });
    }

    console.log(`║ Total: ${calibrationData.size} slots calibrated`);
    console.log('╚══════════════════════════════════════════════════════════════╝');

    // Import into learner for immediate use
    learner.importCalibration(exportData);

    // Store globally so testTooltipLearner can pick it up
    (window as any)._mouseCalibrationData = exportData;

    // Persist to localStorage for cross-session reuse
    try {
      localStorage.setItem('inventoryMouseCalibration', JSON.stringify(exportData));
      console.log('\n[Calibration] Data saved to localStorage (persists across sessions)');
    } catch (e) {
      console.warn('[Calibration] Could not save to localStorage:', e);
    }

    console.log('[Calibration] Run window.testTooltipLearner() to test with calibrated mouse positions');
    console.log('[Calibration] To clear saved calibration: window.clearCalibration()');

    clearInterval(pollInterval);
  }

  // Start prompting
  promptNextSlot();

  // Poll for mouse position at 300ms intervals — only capture after countdown completes
  const pollInterval = setInterval(async () => {
    if (currentTargetIdx >= slotsWithItems.length) {
      clearInterval(pollInterval);
      return;
    }

    // Skip during countdown — wait for capture window
    if (countdownActive || !captureReady) return;

    try {
      // Capture mouse position
      const mousePos = glBridge.getMousePositionGL();
      if (!mousePos) return;

      const target = slotsWithItems[currentTargetIdx];
      let samples = calibrationData.get(target.slot);
      if (!samples) {
        samples = [];
        calibrationData.set(target.slot, samples);
      }

      samples.push({ x: mousePos.x, y: mousePos.y });
      const { row, col } = getRowCol(target.slot);
      console.log(`  ✅ Slot ${target.slot + 1} (row${row + 1},col${col + 1}): sample ${samples.length}/${SAMPLES_PER_SLOT} at mouse (${mousePos.x.toFixed(0)}, ${mousePos.y.toFixed(0)})`);

      if (samples.length >= SAMPLES_PER_SLOT) {
        // Enough samples — move to next slot
        captureReady = false;
        currentTargetIdx++;
        // Small pause before next slot countdown
        await new Promise(resolve => setTimeout(resolve, 500));
        promptNextSlot();
      }
    } catch (err) {
      // Ignore frame errors during calibration
    }
  }, 300);

  // Return a cancel function
  return {
    cancel: () => {
      clearInterval(pollInterval);
      console.log('[Calibration] Cancelled.');
      console.log(`[Calibration] ${calibrationData.size} slots were calibrated before cancellation.`);
    },
    getData: () => {
      const result: { slot: number; x: number; y: number }[] = [];
      for (const [slotIdx, samples] of calibrationData) {
        const avgX = samples.reduce((s, p) => s + p.x, 0) / samples.length;
        const avgY = samples.reduce((s, p) => s + p.y, 0) / samples.length;
        result.push({ slot: slotIdx, x: avgX, y: avgY });
      }
      return result;
    },
  };
}

/**
 * Clear saved mouse calibration data.
 * Use this when you rearrange your inventory or move the game window.
 */
function clearCalibration() {
  try {
    localStorage.removeItem('inventoryMouseCalibration');
    delete (window as any)._mouseCalibrationData;
    console.log('[Calibration] Saved calibration data cleared.');
    console.log('[Calibration] Run window.calibrateMouse() to recalibrate.');
  } catch (e) {
    console.warn('[Calibration] Could not clear calibration:', e);
  }
}

// Expose to window for dev console testing
if (typeof window !== 'undefined') {
  (window as any).testTooltipLearner = testTooltipLearner;
  (window as any).quickTestTooltip = quickTest;
  (window as any).testInventory = testInventory;
  (window as any).calibrateMouse = calibrateMouse;
  (window as any).clearCalibration = clearCalibration;
  console.log('[TooltipItemLearner] Test functions exposed:');
  console.log('  - window.testTooltipLearner() - Run continuous test (hover items)');
  console.log('  - window.quickTestTooltip() - Run single detection');
  console.log('  - window.testInventory() - Test inventory slot detection');
  console.log('  - window.calibrateMouse() - Calibrate mouse positions for inventory slots');
  console.log('  - window.clearCalibration() - Clear saved calibration data');

  // Show calibration status on load
  try {
    const saved = localStorage.getItem('inventoryMouseCalibration');
    if (saved) {
      const data = JSON.parse(saved);
      console.log(`  ✅ Mouse calibration loaded: ${data.length} slots saved`);
    } else {
      console.log('  ⚠️  No mouse calibration saved. Run window.calibrateMouse() for best accuracy.');
    }
  } catch { /* ignore */ }
}

export { testTooltipLearner };
