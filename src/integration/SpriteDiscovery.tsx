/**
 * Sprite Discovery Tool
 *
 * A UI state viewer for discovering sprite IDs in the Quest Journal.
 * Based on gameuiview.tsx from alt1gl-main.
 *
 * Usage:
 * 1. Open the Quest Journal in RS3
 * 2. Click "Capture" to record the current UI state
 * 3. Click on elements to see their sprite IDs
 * 4. Ctrl+click to collect sprites to a list
 * 5. Use the slider to filter elements by index
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import * as patchrs from "../gl/injection/util/patchrs_napi";
import { AtlasTracker, getUIState, type RenderRect } from "../gl/injection/reflect2d/reflect2d";
import { SpriteCache } from "../gl/injection/reflect2d/spritecache";
import { UIRenderTextureCache } from "../gl/injection/reflect2d/UIRenderTextureCache";
import { renderGameUI } from "../gl/injection/reflect2d/render";
import { crc32 } from "../gl/injection/util/crc32";
import { dHash, hashToHex, hammingDistance, isSimilar } from "../gl/injection/util/phash";
import { TooltipItemLearner, findMousePosition, debugUniformNames, TOOLTIP_SPRITE_IDS } from "./TooltipItemLearner";
import { FontCharacterCollector, type CollectedCharacter, type FontSheetData } from "./FontCharacterCollector";
import type { RenderInvocation } from "../gl/injection/util/patchrs_napi";

// API endpoint for items
const API_BASE = process.env.REACT_APP_API_URL || "http://localhost:42069";
const ITEMS_API = `${API_BASE}/api/items`;

interface StoredItemHash {
  pHash: string;      // Perceptual hash hex (stable across sessions)
  name: string;
  firstSeen: string;
}

// API item type (matches server schema)
interface ApiItem {
  id: number;
  pHash: string;
  name: string;
  firstSeen: string;
  createdAt: string;
  updatedAt: string;
}

// Discovered item type
interface DiscoveredItem {
  pHash: string;      // Perceptual hash hex (stable across sessions)
  name: string;
  firstSeen: number;
  slot: number;
  x: number;          // Element x position for matching
  y: number;          // Element y position for matching
}

// Load item hashes from API
async function loadItemHashesFromApi(): Promise<Map<string, DiscoveredItem>> {
  const map = new Map<string, DiscoveredItem>();
  try {
    const response = await fetch(`${ITEMS_API}?limit=500`);
    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }
    const data = await response.json();
    const items: ApiItem[] = data.items || [];

    for (const item of items) {
      if (!item.pHash || item.pHash.length !== 16) continue;

      map.set(item.pHash, {
        pHash: item.pHash,
        name: item.name || "",
        firstSeen: new Date(item.firstSeen).getTime(),
        slot: 0,
        x: 0,
        y: 0,
      });
    }
    console.log(`[ItemHashes] Loaded ${map.size} items from API`);
  } catch (err) {
    console.error("[ItemHashes] Failed to load from API:", err);
  }
  return map;
}

// Sync function for initial state (returns empty, loads async)
function loadItemHashes(): Map<string, DiscoveredItem> {
  return new Map<string, DiscoveredItem>();
}

// Save item hashes to API (batch upsert)
async function saveItemHashesToApi(items: Map<string, DiscoveredItem>): Promise<void> {
  try {
    const itemsArray = Array.from(items.values())
      .filter(item => item.pHash && item.pHash.length === 16 && item.name && item.name.length > 0)
      .map(item => ({
        pHash: item.pHash,
        name: item.name,
        firstSeen: new Date(item.firstSeen).toISOString(),
      }));

    if (itemsArray.length === 0) return;

    const response = await fetch(`${ITEMS_API}/batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: itemsArray }),
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const result = await response.json();
    console.log(`[ItemHashes] Synced ${result.created} items to API`);
  } catch (err) {
    console.error("[ItemHashes] Failed to save to API:", err);
  }
}

interface SpriteDiscoveryState {
  elements: RenderRect[];
  selectedElement: RenderRect | null;
  collectedSprites: string[];
  filterStart: number;
  filterEnd: number;
  isCapturing: boolean;
  showBorders: boolean;
  error: string | null;
}

interface TooltipTestResult {
  mousePos: { x: number; y: number } | null;
  tooltipVisible: boolean;
  tooltipText: string | null;
  hoveredSlot: number | null;
  confidence: number;
  learnedItems: number;
}

export function SpriteDiscovery() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const spriteCacheRef = useRef<SpriteCache | null>(null);
  const atlasRef = useRef<AtlasTracker | null>(null);
  const textureCacheRef = useRef<UIRenderTextureCache>(new UIRenderTextureCache());

  const [state, setState] = useState<SpriteDiscoveryState>({
    elements: [],
    selectedElement: null,
    collectedSprites: [],
    filterStart: 0,
    filterEnd: Infinity,
    isCapturing: false,
    showBorders: true,
    error: null,
  });

  const [viewOrigin, setViewOrigin] = useState({ x: 400, y: 400 });
  const [scale, setScale] = useState(1);
  const [elementsAtClick, setElementsAtClick] = useState<RenderRect[]>([]);
  const [maxElementSize, setMaxElementSize] = useState<number>(300); // Filter out elements larger than this
  const [hideLargeElements, setHideLargeElements] = useState(true); // Toggle for filtering large elements
  const [clickIndex, setClickIndex] = useState(0);
  const [droppedImageHash, setDroppedImageHash] = useState<{ hash: number; name: string; size: string } | null>(null);
  // Known items - already saved in DB (pHash -> name)
  const [knownItems, setKnownItems] = useState<Map<string, string>>(new Map());
  // Pending items - newly discovered, need naming before save
  const [pendingItems, setPendingItems] = useState<Map<string, DiscoveredItem>>(new Map());
  const [selectedItemHash, setSelectedItemHash] = useState<string | null>(null);
  const [itemsLoaded, setItemsLoaded] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Tooltip learner state
  const tooltipLearnerRef = useRef<TooltipItemLearner | null>(null);
  const [tooltipTestResult, setTooltipTestResult] = useState<TooltipTestResult | null>(null);
  const [isTooltipTesting, setIsTooltipTesting] = useState(false);
  const tooltipTestIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Font character collector state
  const fontCollectorRef = useRef<FontCharacterCollector | null>(null);
  const [fontCollectorStats, setFontCollectorStats] = useState<{
    total: number;
    labeled: number;
    unlabeled: number;
    withPHash: number;
    autoMatchable: number;
    bySize: { size: string; count: number }[];
  } | null>(null);
  const [isFontScanning, setIsFontScanning] = useState(false);
  const [fontLabelInput, setFontLabelInput] = useState('');
  const [selectedFontChar, setSelectedFontChar] = useState<CollectedCharacter | null>(null);
  const fontScanIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fontPreviewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [pHashThreshold, setPHashThreshold] = useState(5); // Default threshold for auto-matching

  // Load known items from API on mount
  useEffect(() => {
    loadItemHashesFromApi().then((items) => {
      // Store as simple pHash -> name map for known items
      const known = new Map<string, string>();
      for (const [pHash, item] of items) {
        if (item.name && item.name.length > 0) {
          known.set(pHash, item.name);
        }
      }
      setKnownItems(known);
      console.log(`[ItemHashes] Loaded ${known.size} known items from DB`);
      setItemsLoaded(true);
    });
  }, []);

  // Resize canvas to match display size
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resizeObserver = new ResizeObserver(() => {
      const rect = canvas.getBoundingClientRect();
      if (canvas.width !== rect.width || canvas.height !== rect.height) {
        canvas.width = rect.width;
        canvas.height = rect.height;
      }
    });

    resizeObserver.observe(canvas);
    return () => resizeObserver.disconnect();
  }, []);

  // Initialize sprite cache
  useEffect(() => {
    const initCache = async () => {
      try {
        const cache = new SpriteCache();
        await cache.downloadCacheData();
        spriteCacheRef.current = cache;
        atlasRef.current = new AtlasTracker(cache);

        // Also set on font collector if it exists
        if (fontCollectorRef.current) {
          fontCollectorRef.current.setSpriteCache(cache);
        }

        console.log("[SpriteDiscovery] Sprite cache initialized");
      } catch (e) {
        console.error("[SpriteDiscovery] Failed to init sprite cache:", e);
        setState((s) => ({ ...s, error: "Failed to initialize sprite cache" }));
      }
    };
    initCache();
  }, []);

  // Capture UI state
  const captureFrame = useCallback(async () => {
    if (!patchrs.native || !atlasRef.current) {
      setState((s) => ({ ...s, error: "Not ready - native addon or cache not loaded" }));
      return;
    }

    setState((s) => ({ ...s, isCapturing: true, error: null }));

    try {
      const renders = await patchrs.native.recordRenderCalls({
        features: ["vertexarray", "uniforms", "texturesnapshot"],
      });

      const uiState = getUIState(renders, atlasRef.current);
      console.log(`[SpriteDiscovery] Captured ${uiState.elements.length} elements`);

      // Log sprite ID range for quest journal detection
      const spriteIds = uiState.elements
        .map((el) => el.sprite.known?.id)
        .filter((id): id is number => id !== undefined);

      if (spriteIds.length > 0) {
        const minId = Math.min(...spriteIds);
        const maxId = Math.max(...spriteIds);
        console.log(`[SpriteDiscovery] Sprite ID range: ${minId} - ${maxId}`);
      }

      // Find elements with sprite ID 18015 (Quest Journal start)
      const journalElements = uiState.elements.filter(
        (el) => el.sprite.known?.id === 18015
      );
      if (journalElements.length > 0) {
        console.log(`[SpriteDiscovery] Found ${journalElements.length} Quest Journal start markers (18015)`);
      }

      // Find elements with sprite ID 792 (Quest Journal end marker)
      const endMarkers = uiState.elements.filter(
        (el) => el.sprite.known?.id === 792
      );
      if (endMarkers.length > 0) {
        console.log(`[SpriteDiscovery] Found ${endMarkers.length} end markers (792)`);
      }

      setState((s) => ({
        ...s,
        elements: uiState.elements,
        isCapturing: false,
        filterEnd: uiState.elements.length,
      }));
    } catch (e) {
      console.error("[SpriteDiscovery] Capture failed:", e);
      setState((s) => ({
        ...s,
        isCapturing: false,
        error: `Capture failed: ${e}`,
      }));
    }
  }, []);

  // Render canvas with actual sprite textures
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Clear
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#1a1a2e";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const hasElements = state.elements.length > 0;
    const hasFontChars = fontCollectorRef.current && fontCollectorRef.current.getCollectedCharacters().length > 0;

    if (!hasElements && !hasFontChars) {
      ctx.fillStyle = "#888";
      ctx.font = "14px sans-serif";
      ctx.fillText("Click 'Capture' with Quest Journal open", 20, 30);
      return;
    }

    // Apply transform (pan + zoom)
    ctx.setTransform(
      scale,
      0,
      0,
      -scale, // Flip Y for UI coordinates
      canvas.width / 2 - viewOrigin.x * scale,
      canvas.height / 2 + viewOrigin.y * scale
    );

    // Render elements using the proper rendering function
    const start = state.filterStart;
    const end = Math.min(state.filterEnd, state.elements.length);

    // Filter elements if hideLargeElements is enabled
    // Check both rendered size (width/height) and sample size (samplewidth/sampleheight)
    let loggedLargeOnce = false;
    const filteredElements = hideLargeElements
      ? state.elements.filter(el => {
          const w = el.width;
          const h = el.height;
          // Also check sample dimensions if available (for RS3RenderRect)
          const sw = (el as any).samplewidth ?? w;
          const sh = (el as any).sampleheight ?? h;
          const maxDim = Math.max(w, h, Math.abs(sw), Math.abs(sh));
          const keep = maxDim <= maxElementSize;
          // Log first few filtered-out elements
          if (!keep && !loggedLargeOnce) {
            console.log(`[Filter] Hiding large element: ${w}x${h}, sample: ${sw}x${sh}, max: ${maxDim}`);
            loggedLargeOnce = true;
          }
          return keep;
        })
      : state.elements;

    try {
      renderGameUI(
        ctx,
        textureCacheRef.current,
        filteredElements,
        0, // Use 0 since we already filtered
        filteredElements.length,
        state.showBorders,
        state.selectedElement?.sprite
      );
    } catch (e) {
      console.error("[SpriteDiscovery] Render error:", e);
    }

    // Highlight selected element extra
    if (state.selectedElement) {
      const el = state.selectedElement;
      ctx.save();
      ctx.strokeStyle = "#ff0";
      ctx.lineWidth = 3 / scale;
      ctx.strokeRect(el.x, el.y, el.width, el.height);
      ctx.restore();
    }

    // Draw all collected font characters with color coding:
    // GREEN = labeled/found, YELLOW = unlabeled/unknown
    if (fontCollectorRef.current) {
      const allChars = fontCollectorRef.current.getCollectedCharacters();
      if (allChars.length > 0) {
        console.log(`[Canvas] Drawing ${allChars.length} font chars, ${allChars.filter(c => c.chr !== undefined).length} labeled`);
      }
      ctx.save();
      ctx.lineWidth = 2 / scale;

      for (const char of allChars) {
        if (char.chr !== undefined) {
          // LABELED - Green border
          ctx.strokeStyle = "#0f0";
          ctx.fillStyle = "rgba(0, 255, 0, 0.15)";
        } else {
          // UNLABELED - Yellow/orange border
          ctx.strokeStyle = "#fa0";
          ctx.fillStyle = "rgba(255, 170, 0, 0.1)";
        }
        ctx.fillRect(char.screenX, char.screenY, char.width, char.height);
        ctx.strokeRect(char.screenX, char.screenY, char.width, char.height);

        // Draw the character label if known
        if (char.chr !== undefined) {
          ctx.fillStyle = "#0f0";
          ctx.font = `${Math.max(8, 10 / scale)}px monospace`;
          ctx.fillText(char.chr, char.screenX, char.screenY - 2 / scale);
        }
      }
      ctx.restore();
    }

    // Highlight selected font character with bright magenta
    if (selectedFontChar) {
      ctx.save();
      ctx.strokeStyle = "#f0f";
      ctx.fillStyle = "rgba(255, 0, 255, 0.3)";
      ctx.lineWidth = 3 / scale;
      ctx.fillRect(selectedFontChar.screenX, selectedFontChar.screenY, selectedFontChar.width, selectedFontChar.height);
      ctx.strokeRect(selectedFontChar.screenX, selectedFontChar.screenY, selectedFontChar.width, selectedFontChar.height);
      // Draw crosshairs
      ctx.strokeStyle = "#f0f";
      ctx.lineWidth = 1 / scale;
      ctx.beginPath();
      ctx.moveTo(selectedFontChar.screenX - 10, selectedFontChar.screenY + selectedFontChar.height / 2);
      ctx.lineTo(selectedFontChar.screenX + selectedFontChar.width + 10, selectedFontChar.screenY + selectedFontChar.height / 2);
      ctx.moveTo(selectedFontChar.screenX + selectedFontChar.width / 2, selectedFontChar.screenY - 10);
      ctx.lineTo(selectedFontChar.screenX + selectedFontChar.width / 2, selectedFontChar.screenY + selectedFontChar.height + 10);
      ctx.stroke();
      ctx.restore();
    }
  }, [state.elements, state.selectedElement, state.filterStart, state.filterEnd, state.showBorders, viewOrigin, scale, selectedFontChar, hideLargeElements, maxElementSize, fontCollectorStats]);

  // Handle wheel zoom - use native event listener to avoid passive event issues
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      setScale((s) => s * Math.exp(-e.deltaY / 300));
    };

    canvas.addEventListener("wheel", handleWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", handleWheel);
  }, []);

  // Handle canvas click
  const handleCanvasClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas || state.elements.length === 0) return;

      const rect = canvas.getBoundingClientRect();
      const canvasX = e.clientX - rect.left;
      const canvasY = e.clientY - rect.top;

      // Convert to UI coordinates (invert the render transform)
      const uiX = (canvasX - canvas.width / 2) / scale + viewOrigin.x;
      const uiY = viewOrigin.y - (canvasY - canvas.height / 2) / scale;

      const start = state.filterStart;
      const end = Math.min(state.filterEnd, state.elements.length);

      // Find ALL elements at this position, sorted by size (smallest first)
      const matches: RenderRect[] = [];
      for (let i = start; i < end; i++) {
        const el = state.elements[i];
        if (!el) continue;

        if (
          uiX >= el.x &&
          uiX <= el.x + el.width &&
          uiY >= el.y &&
          uiY <= el.y + el.height
        ) {
          matches.push(el);
        }
      }

      // Sort by size (smallest first for precision)
      matches.sort((a, b) => (a.width * a.height) - (b.width * b.height));

      if (matches.length > 0) {
        // Shift+click to cycle through overlapping elements
        let index = 0;
        if (e.shiftKey && elementsAtClick.length > 0) {
          // Check if we're clicking in the same area
          const prevMatch = elementsAtClick[0];
          if (matches.includes(prevMatch)) {
            index = (clickIndex + 1) % matches.length;
          }
        }

        const match = matches[index];
        setElementsAtClick(matches);
        setClickIndex(index);

        // Ctrl+click to collect
        if (e.ctrlKey) {
          const spriteId = match.sprite?.known
            ? `${match.sprite.known.id}${match.sprite.known.subid ? `:${match.sprite.known.subid}` : ""}`
            : `hash:${match.sprite?.pixelhash}`;

          if (!state.collectedSprites.includes(spriteId)) {
            setState((s) => ({
              ...s,
              selectedElement: match,
              collectedSprites: [...s.collectedSprites, spriteId],
            }));
          }
        } else {
          setState((s) => ({ ...s, selectedElement: match }));
        }

        // Log selected element
        console.log(`[SpriteDiscovery] Selected (${index + 1}/${matches.length}):`, {
          spriteId: match.sprite?.known?.id,
          subId: match.sprite?.known?.subid,
          hash: match.sprite?.pixelhash,
          position: { x: match.x, y: match.y },
          size: { width: match.width, height: match.height },
        });
      }
    },
    [state.elements, state.filterStart, state.filterEnd, state.collectedSprites, viewOrigin, scale, elementsAtClick, clickIndex]
  );

  // Handle drag pan
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;

      const startX = e.clientX;
      const startY = e.clientY;
      const startOrigin = { ...viewOrigin };

      const handleMouseMove = (moveE: MouseEvent) => {
        const dx = (moveE.clientX - startX) / scale;
        const dy = (moveE.clientY - startY) / scale;
        setViewOrigin({
          x: startOrigin.x - dx,
          y: startOrigin.y + dy,
        });
      };

      const handleMouseUp = () => {
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
      };

      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    },
    [viewOrigin, scale]
  );

  // Copy collected sprites
  const copyCollected = useCallback(() => {
    navigator.clipboard.writeText(state.collectedSprites.join("\n"));
  }, [state.collectedSprites]);

  // Export UI state as JSON for testing
  const exportJSON = useCallback(() => {
    if (state.elements.length === 0) {
      alert("No elements captured. Click Capture first.");
      return;
    }

    // Serialize elements (convert sprite objects to plain data)
    const exportData = {
      timestamp: Date.now(),
      elementCount: state.elements.length,
      elements: state.elements.map((el) => ({
        x: el.x,
        y: el.y,
        width: el.width,
        height: el.height,
        color: el.color,
        sprite: {
          known: el.sprite?.known
            ? {
                id: el.sprite.known.id,
                subid: el.sprite.known.subid,
                fontchr: el.sprite.known.fontchr,
              }
            : null,
          pixelhash: el.sprite?.pixelhash,
          basetex: el.sprite?.basetex,
        },
        samplex: el.samplex,
        sampley: el.sampley,
        samplewidth: el.samplewidth,
        sampleheight: el.sampleheight,
      })),
    };

    const json = JSON.stringify(exportData, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = `ui-state-${Date.now()}.json`;
    a.click();

    URL.revokeObjectURL(url);
    console.log("[SpriteDiscovery] Exported UI state to JSON");
  }, [state.elements]);

  // ========================================
  // TEXT FRAGMENT RECONSTRUCTION UTILITIES
  // ========================================

  /** Descender characters that may be rendered on separate lines (below text) */
  const DESCENDER_CHARS = new Set(['g', 'p', 'q', 'y', 'j', ',', ';']);

  /** Ascender characters that may be rendered on separate lines (above text) */
  const ASCENDER_CHARS = new Set(["'", '"', '`', '\u2018', '\u2019', '\u201C', '\u201D']);

  /** Y tolerance for grouping text fragments into lines */
  const Y_TOLERANCE = 5;

  /** Additional Y tolerance for merging descender/ascender fragments */
  const FRAGMENT_Y_TOLERANCE = 12;

  /** Gap threshold for adding spaces between fragments (gaps >= this get spaces) */
  const GAP_THRESHOLD = 3;

  /** Characters that should not have a space BEFORE them (closing punctuation) */
  const NO_SPACE_BEFORE = new Set(["'", '"', '`', '\u2019', '\u201D', '.', ',', ';', ':', '!', '?', ')', ']', '}']);

  /** Characters that should not have a space AFTER them (opening punctuation only) */
  const NO_SPACE_AFTER = new Set(['\u2018', '\u201C', '(', '[', '{']);

  /**
   * Specific merged phrase patterns - only matches exact problematic combinations
   * These are safe because these letter combinations don't appear in valid English words
   */
  const WORD_BOUNDARY_PATTERNS = [
    // Specific "of the" combinations (safe - "ofthe" is never a valid word)
    { pattern: /ofthe/gi, replacement: 'of the' },
    { pattern: /ofan?(?=[^a-z]|$)/gi, replacement: 'of a' },  // "ofa " but not "ofan" in middle

    // Specific "to the" combinations
    { pattern: /tothe/gi, replacement: 'to the' },
    { pattern: /tofind/gi, replacement: 'to find' },
    { pattern: /tobuild/gi, replacement: 'to build' },
    { pattern: /touse/gi, replacement: 'to use' },
    { pattern: /toput/gi, replacement: 'to put' },

    // Specific "in the" combinations
    { pattern: /inthe/gi, replacement: 'in the' },

    // Specific "for the" / "for a" combinations
    { pattern: /forthe/gi, replacement: 'for the' },
    { pattern: /fora(?=\s|time|while)/gi, replacement: 'for a' },

    // Specific "with the" combinations
    { pattern: /withthe/gi, replacement: 'with the' },
    { pattern: /withthis/gi, replacement: 'with this' },

    // Specific "from the" combinations
    { pattern: /fromthe/gi, replacement: 'from the' },

    // Specific "back to" / "back time" combinations
    { pattern: /backto/gi, replacement: 'back to' },
    { pattern: /backtime/gi, replacement: 'back time' },

    // Specific "how to" combinations
    { pattern: /howto/gi, replacement: 'how to' },

    // Specific "not" combinations (careful - not in "nothing", "notify", etc.)
    { pattern: /notcome/gi, replacement: 'not come' },
    { pattern: /notpersuade/gi, replacement: 'not persuade' },

    // Specific "all" combinations (careful - not in "alliance", "allthe" ok)
    { pattern: /allthe/gi, replacement: 'all the' },
    { pattern: /allto/gi, replacement: 'all to' },

    // Specific "as the" combinations
    { pattern: /asthe/gi, replacement: 'as the' },

    // Specific "at the" combinations
    { pattern: /atthe/gi, replacement: 'at the' },

    // Specific "that" combinations
    { pattern: /thatwe/gi, replacement: 'that we' },
    { pattern: /thathe/gi, replacement: 'that he' },

    // Specific compound fixes
    { pattern: /cannotwork/gi, replacement: 'cannot work' },
    { pattern: /couldnot/gi, replacement: 'could not' },
    { pattern: /wouldnot/gi, replacement: 'would not' },

    // "from" combinations - word ending + "from"
    { pattern: /([a-z])from/gi, replacement: '$1 from' },

    // "so" at word boundary (careful - not in "also", "son", etc.)
    { pattern: /([a-z])so([^a-z]|$)/gi, replacement: '$1 so$2' },

    // "my" followed by word (mystory, mybank, etc.)
    { pattern: /\bmy([a-z]{2,})/gi, replacement: 'my $1' },

    // "tower" combinations
    { pattern: /towerto/gi, replacement: 'tower to' },

    // "Feather" combinations
    { pattern: /Featherto/g, replacement: 'Feather to' },
    { pattern: /featherto/gi, replacement: 'feather to' },

    // "to give" / "to get" / "to take" combinations
    { pattern: /togive/gi, replacement: 'to give' },
    { pattern: /toget/gi, replacement: 'to get' },
    { pattern: /totake/gi, replacement: 'to take' },

    // Period followed by capital = sentence boundary
    // BUT NOT for acronyms (single letter followed by period)
    { pattern: /([a-z])\.([A-Z][a-z])/g, replacement: '$1. $2' },
    // Comma followed by word (but not number)
    { pattern: /,([A-Za-z])/g, replacement: ', $1' },

    // Fix acronym spacing - remove spaces between single letters with periods
    // "H. A. M." → "H.A.M."
    { pattern: /([A-Z])\. ([A-Z])\./g, replacement: '$1.$2.' },
    // Handle 3+ letter acronyms by running twice
    { pattern: /([A-Z])\. ([A-Z])\./g, replacement: '$1.$2.' },
  ];

  /**
   * Post-process text to fix common merged word patterns
   */
  const fixMergedWords = (text: string): string => {
    let result = text;
    for (const { pattern, replacement } of WORD_BOUNDARY_PATTERNS) {
      result = result.replace(pattern, replacement);
    }
    // Clean up any double spaces
    return result.replace(/  +/g, ' ');
  };

  /**
   * Check if element is shadow text (should be filtered out)
   * Color format: [A, B, G, R] (ABGR order from RS3 renderer)
   */
  const isShadowText = (color: number[] | undefined): boolean => {
    if (!color || !Array.isArray(color)) return false;
    // Shadow is pure black: B < 10, G < 10, R < 10
    // ABGR: [0]=A, [1]=B, [2]=G, [3]=R
    return (color[1] ?? 0) < 10 && (color[2] ?? 0) < 10 && (color[3] ?? 0) < 10;
  };

  /**
   * Group text elements by Y position with enhanced tolerance
   */
  const groupTextByLineEnhanced = (
    elements: RenderRect[],
    yTolerance: number = Y_TOLERANCE
  ): Map<number, RenderRect[]> => {
    const lines = new Map<number, RenderRect[]>();
    const fontElements = elements.filter((el) => el.sprite?.known?.fontchr && !isShadowText(el.color as number[]));

    for (const el of fontElements) {
      // Find existing line within tolerance
      let lineY: number | null = null;
      for (const existingY of lines.keys()) {
        if (Math.abs(el.y - existingY) <= yTolerance) {
          lineY = existingY;
          break;
        }
      }

      if (lineY === null) {
        lineY = el.y;
        lines.set(lineY, []);
      }

      lines.get(lineY)!.push(el);
    }

    // Sort elements within each line by X position
    for (const lineElements of lines.values()) {
      lineElements.sort((a, b) => a.x - b.x);
    }

    return lines;
  };

  /**
   * Check if a line looks like it contains only fragment characters
   * (descenders below or ascenders above the main text line)
   */
  const looksLikeFragmentLine = (
    fragments: RenderRect[],
    parentLine: RenderRect[]
  ): boolean => {
    // If too many characters, probably a real line
    if (fragments.length > 5) return false;

    // Check if this is a section header (single uppercase letter like A, B, C...)
    if (fragments.length <= 2) {
      let allUppercase = true;
      let hasAscender = false;
      for (const el of fragments) {
        const fc = el.sprite?.known?.fontchr;
        const chr = fc?.chr ?? (typeof fc === "string" ? fc : "");
        if (chr) {
          // Check if it's an ascender character (apostrophe, quote)
          if (ASCENDER_CHARS.has(chr)) {
            hasAscender = true;
          } else if (chr !== chr.toUpperCase()) {
            allUppercase = false;
          }
        }
      }
      // If all uppercase and no ascenders, it's a section header
      if (allUppercase && !hasAscender) {
        return false;
      }
    }

    // Count fragment characters (descenders + ascenders)
    let fragmentCharCount = 0;
    for (const el of fragments) {
      const fc = el.sprite?.known?.fontchr;
      const chr = fc?.chr ?? (typeof fc === "string" ? fc : "");
      if (chr) {
        if (DESCENDER_CHARS.has(chr.toLowerCase()) || ASCENDER_CHARS.has(chr)) {
          fragmentCharCount++;
        }
      }
    }

    // At least 50% should be fragment chars to be considered a fragment line
    if (fragments.length > 0 && fragmentCharCount / fragments.length < 0.5) {
      return false;
    }

    // Check X overlap with parent line - fragments should be within parent's X range
    if (parentLine.length > 0) {
      const parentMinX = Math.min(...parentLine.map((el) => el.x));
      const parentMaxX = Math.max(...parentLine.map((el) => el.x + el.width));

      for (const frag of fragments) {
        if (frag.x < parentMinX - 10 || frag.x > parentMaxX + 10) {
          return false; // Fragment is outside parent's X range
        }
      }
    }

    return true;
  };

  /**
   * Merge fragment lines (descenders below and ascenders above) with their parent lines
   */
  const mergeFragmentLines = (
    lines: Map<number, RenderRect[]>
  ): Map<number, RenderRect[]> => {
    const sortedYs = Array.from(lines.keys()).sort((a, b) => a - b);
    const mergedLines = new Map<number, RenderRect[]>();
    const usedYs = new Set<number>();

    for (let i = 0; i < sortedYs.length; i++) {
      const y = sortedYs[i]!;
      if (usedYs.has(y)) continue;

      const lineElements = [...lines.get(y)!];
      usedYs.add(y);

      // Look for fragment lines ABOVE this line (ascenders like apostrophes)
      for (let j = i - 1; j >= 0; j--) {
        const prevY = sortedYs[j]!;
        if (usedYs.has(prevY)) continue;

        const yDiff = y - prevY;

        // If too far above, stop looking
        if (yDiff > FRAGMENT_Y_TOLERANCE) break;

        // Check if the previous line looks like ascender fragments
        const prevLineElements = lines.get(prevY)!;
        if (looksLikeFragmentLine(prevLineElements, lineElements)) {
          // Merge the fragments
          lineElements.push(...prevLineElements);
          usedYs.add(prevY);
        }
      }

      // Look for fragment lines BELOW this line (descenders like g, p, q, y)
      for (let j = i + 1; j < sortedYs.length; j++) {
        const nextY = sortedYs[j]!;
        if (usedYs.has(nextY)) continue;

        const yDiff = nextY - y;

        // If too far below, stop looking
        if (yDiff > FRAGMENT_Y_TOLERANCE) break;

        // Check if the next line looks like descender fragments
        const nextLineElements = lines.get(nextY)!;
        if (looksLikeFragmentLine(nextLineElements, lineElements)) {
          // Merge the fragments
          lineElements.push(...nextLineElements);
          usedYs.add(nextY);
        }
      }

      // Sort merged elements by X position
      lineElements.sort((a, b) => a.x - b.x);
      mergedLines.set(y, lineElements);
    }

    return mergedLines;
  };

  /**
   * Read text from elements with enhanced fragment handling
   * Also collects gap statistics for debugging
   */
  const readTextFromElements = (
    elements: RenderRect[],
    gapThreshold: number = GAP_THRESHOLD,
    collectGaps?: { gaps: number[]; pairs: string[] }
  ): { text: string; color: number[] | null } => {
    if (elements.length === 0) return { text: "", color: null };

    // Filter out shadow text and sort by X
    const sorted = elements
      .filter((el) => !isShadowText(el.color as number[]))
      .sort((a, b) => a.x - b.x);

    if (sorted.length === 0) return { text: "", color: null };

    let text = '';
    let prevEl: RenderRect | null = null;
    let prevChr = '';

    for (const el of sorted) {
      const fc = el.sprite?.known?.fontchr;
      if (!fc) continue;
      const chr = fc.chr ?? (typeof fc === "string" ? fc : "");
      if (!chr) continue;

      // Determine if we should add a space
      if (prevEl && text.length > 0) {
        const gap = el.x - (prevEl.x + prevEl.width);

        // Collect gap data for debugging
        if (collectGaps) {
          collectGaps.gaps.push(gap);
          collectGaps.pairs.push(prevChr + chr);
        }

        // Don't add space before/after certain punctuation
        const noSpaceBefore = NO_SPACE_BEFORE.has(chr);
        const noSpaceAfter = NO_SPACE_AFTER.has(prevChr);

        // Detect case transitions: lowercase→UPPERCASE almost always = word boundary
        const isLowerToUpper = /[a-z]/.test(prevChr) && /[A-Z]/.test(chr);

        // Add space if:
        // 1. Gap exceeds threshold, OR
        // 2. Case transition (lowercase→uppercase) with positive gap
        const shouldAddSpace = (gap >= gapThreshold) || (isLowerToUpper && gap > 0);

        if (shouldAddSpace && !noSpaceBefore && !noSpaceAfter) {
          text += ' ';
        }
      }

      text += chr;
      prevEl = el;
      prevChr = chr;
    }

    // Apply post-processing to fix common merged word patterns
    const fixedText = fixMergedWords(text);
    return { text: fixedText, color: (sorted[0]?.color as number[]) ?? null };
  };

  /**
   * Analyze gap distribution to calibrate GAP_THRESHOLD
   */
  const analyzeGaps = (elements: RenderRect[]): void => {
    const fontElements = elements
      .filter((el) => el.sprite?.known?.fontchr && !isShadowText(el.color as number[]))
      .sort((a, b) => a.x - b.x);

    const gaps: { gap: number; before: string; after: string; y: number }[] = [];

    for (let i = 1; i < fontElements.length; i++) {
      const prev = fontElements[i - 1]!;
      const curr = fontElements[i]!;

      // Only analyze gaps on the same line (within Y tolerance)
      if (Math.abs(prev.y - curr.y) > Y_TOLERANCE) continue;

      const gap = curr.x - (prev.x + prev.width);
      const prevFc = prev.sprite?.known?.fontchr;
      const currFc = curr.sprite?.known?.fontchr;
      const prevChr = prevFc?.chr ?? (typeof prevFc === "string" ? prevFc : "?");
      const currChr = currFc?.chr ?? (typeof currFc === "string" ? currFc : "?");

      gaps.push({ gap, before: prevChr, after: currChr, y: prev.y });
    }

    // Sort by gap value
    gaps.sort((a, b) => a.gap - b.gap);

    // Show gap distribution
    console.log("[Gap Analysis] === GAP DISTRIBUTION ===");
    console.log(`[Gap Analysis] Total gaps analyzed: ${gaps.length}`);

    // Group by gap ranges
    const ranges = [
      { min: -Infinity, max: 0, label: "negative/overlap" },
      { min: 0, max: 1, label: "0-1 (tight)" },
      { min: 1, max: 2, label: "1-2" },
      { min: 2, max: 3, label: "2-3" },
      { min: 3, max: 4, label: "3-4" },
      { min: 4, max: 5, label: "4-5" },
      { min: 5, max: 10, label: "5-10 (likely word gap)" },
      { min: 10, max: Infinity, label: "10+ (large gap)" },
    ];

    for (const range of ranges) {
      const inRange = gaps.filter((g) => g.gap > range.min && g.gap <= range.max);
      if (inRange.length > 0) {
        const samples = inRange.slice(0, 5).map((g) => `"${g.before}${g.after}"(${g.gap.toFixed(1)})`).join(", ");
        console.log(`[Gap Analysis] ${range.label}: ${inRange.length} gaps - samples: ${samples}`);
      }
    }

    // Show specific examples we care about
    console.log("[Gap Analysis] === SPECIFIC EXAMPLES ===");
    const lookFor = [
      { chars: "ft", label: "f→t (of the)" },
      { chars: "th", label: "t→h (the)" },
      { chars: "he", label: "h→e (the)" },
      { chars: "of", label: "o→f (of)" },
    ];

    for (const { chars, label } of lookFor) {
      const matching = gaps.filter((g) => g.before + g.after === chars);
      if (matching.length > 0) {
        console.log(`[Gap Analysis] ${label}: gaps = [${matching.map((g) => g.gap.toFixed(2)).join(", ")}]`);
      }
    }
  };

  // Test Quest Journal detection - outputs structured results
  const testDetection = useCallback(() => {
    if (state.elements.length === 0) {
      console.log("╔════════════════════════════════════════════════════════════╗");
      console.log("║           QUEST JOURNAL DETECTION RESULT                   ║");
      console.log("╠════════════════════════════════════════════════════════════╣");
      console.log("║ isOpen: false (no elements captured)                       ║");
      console.log("╚════════════════════════════════════════════════════════════╝");
      return;
    }

    const elements = state.elements;
    const questListBgHash = 1599682762;

    // Find journal bounds
    let journalBounds: { x: number; y: number; w: number; h: number } | null = null;
    for (const el of elements) {
      if (el?.sprite?.pixelhash === questListBgHash) {
        journalBounds = { x: el.x, y: el.y, w: el.width, h: el.height };
        break;
      }
    }

    if (!journalBounds) {
      console.log("╔════════════════════════════════════════════════════════════╗");
      console.log("║           QUEST JOURNAL DETECTION RESULT                   ║");
      console.log("╠════════════════════════════════════════════════════════════╣");
      console.log("║ isOpen: false (journal background not found)               ║");
      console.log("╚════════════════════════════════════════════════════════════╝");
      return;
    }

    // Get journal elements
    const journalElements = elements.filter(el =>
      el.x >= journalBounds!.x &&
      el.y >= journalBounds!.y &&
      el.x + el.width <= journalBounds!.x + journalBounds!.w + 50 &&
      el.y + el.height <= journalBounds!.y + journalBounds!.h + 50
    );

    // Check for Quest Overview button (tab detection)
    const allTextLines = groupTextByLineEnhanced(elements.filter(el => el.sprite?.known?.fontchr));
    let hasQuestOverview = false;
    for (const [, lineEls] of allTextLines) {
      const { text } = readTextFromElements(lineEls);
      if (text.toLowerCase().includes('quest overview')) {
        hasQuestOverview = true;
        break;
      }
    }

    // Color detection helpers
    const getQuestStatus = (color: number[] | undefined): string => {
      if (!color) return "unknown";
      const [, b, g, r] = color;
      if (r! < 100 && g! > 200 && b! < 100) return "completed";
      if (r! < 100 && g! > 200 && b! > 200) return "in_progress";
      if (r! > 200 && g! < 100 && b! < 100) return "not_started";
      if (r! < 100 && g! < 100 && b! > 200) return "not_started";
      return "unknown";
    };

    const getDetailsType = (color: number[] | undefined): string => {
      if (!color) return "unknown";
      const [, b, g, r] = color;
      // Orange (225, 146, 30) = next step
      if (r! > 200 && g! > 120 && g! < 170 && b! < 50) return "next_step";
      // Yellow (234, 223, 118) = keyword/link
      if (r! > 220 && g! > 200 && b! > 100 && b! < 140) return "keyword";
      // Grey (~153, 153, 153) = completed step
      if (r! > 100 && r! < 180 && g! > 100 && g! < 180 && b! > 100 && b! < 180) return "completed_step";
      return "info";
    };

    const isQuestColor = (color: number[] | undefined): boolean => {
      return getQuestStatus(color) !== "unknown";
    };

    // Panel separation
    const leftPanelMaxX = journalBounds.x + journalBounds.w * 0.35;
    const EDGE_MARGIN = 8;
    const panelTop = journalBounds.y + journalBounds.h - EDGE_MARGIN;
    const panelBottom = journalBounds.y + EDGE_MARGIN;

    // Get quest list elements
    const questElements = journalElements.filter(el =>
      el.sprite?.known?.fontchr &&
      el.x < leftPanelMaxX &&
      isQuestColor(el.color as number[]) &&
      el.y <= panelTop && el.y >= panelBottom
    );

    // Get details elements
    const detailsElements = journalElements.filter(el =>
      el.sprite?.known?.fontchr &&
      el.x >= leftPanelMaxX &&
      el.y <= panelTop && el.y >= panelBottom &&
      !isShadowText(el.color as number[])
    );

    // Check if tab is active
    const questsTabActive = hasQuestOverview || questElements.length > 5;

    if (!questsTabActive) {
      console.log("╔════════════════════════════════════════════════════════════╗");
      console.log("║           QUEST JOURNAL DETECTION RESULT                   ║");
      console.log("╠════════════════════════════════════════════════════════════╣");
      console.log("║ isOpen: false (Quests tab not active)                      ║");
      console.log("║ Note: Adventures window open but on different tab          ║");
      console.log("╚════════════════════════════════════════════════════════════╝");
      return;
    }

    // Extract quest list
    const questLines = groupTextByLineEnhanced(questElements, Y_TOLERANCE);
    const mergedQuestLines = mergeFragmentLines(questLines);

    interface DetectedQuest {
      name: string;
      status: string;
    }

    const quests: DetectedQuest[] = [];
    const sortedQuestLines = Array.from(mergedQuestLines.entries()).sort(([a], [b]) => b - a);

    for (const [, lineEls] of sortedQuestLines) {
      const { text, color } = readTextFromElements(lineEls);
      const name = text.trim();
      if (!name || name.length < 3) continue;

      const status = getQuestStatus(color as number[]);
      if (status !== "unknown") {
        quests.push({ name, status });
      }
    }

    // Extract details panel - group by LINE first, then identify colors within each line
    const nextSteps: string[] = [];
    const keywords: string[] = [];
    const completedSteps: string[] = [];
    let selectedQuestName = "";

    // UI text patterns to filter out
    const UI_PATTERNS = [
      /^Showing\s*\d+\s*of\s*\d+\s*items?$/i,
      /^Quest\s*Overview$/i,
      /^Set\s*Active$/i,
      /^\d+\s*of\s*\d+$/,
      /^Quest$/i,
      /^items?$/i,
    ];

    const isUIText = (text: string): boolean => {
      const trimmed = text.trim();
      return UI_PATTERNS.some(pattern => pattern.test(trimmed));
    };

    // Check if color is yellow (keyword)
    const isKeywordColor = (color: number[] | undefined): boolean => {
      if (!color) return false;
      const [, b, g, r] = color;
      return r! > 220 && g! > 200 && b! > 100 && b! < 140;
    };

    // Check if color is light blue (title)
    const isTitleColor = (color: number[] | undefined): boolean => {
      if (!color) return false;
      const [, b, g, r] = color;
      return r! > 180 && r! < 220 && g! > 220 && b! > 240;
    };

    // Group ALL details elements by line first
    const detailLines = groupTextByLineEnhanced(detailsElements, Y_TOLERANCE);
    const mergedDetailLines = mergeFragmentLines(detailLines);
    const sortedDetailLines = Array.from(mergedDetailLines.entries()).sort(([a], [b]) => b - a);

    for (const [, lineEls] of sortedDetailLines) {
      // Build full line text
      const { text: fullLineText } = readTextFromElements(lineEls);
      const line = fullLineText.trim();
      if (!line || isUIText(line)) continue;

      // Extract keywords from this line (yellow fragments)
      const sortedEls = [...lineEls].sort((a, b) => a.x - b.x);
      let currentKeyword = '';
      let lastKeywordX = 0;
      let inKeyword = false;

      let prevKeywordChar = '';
      for (const el of sortedEls) {
        // fontchr can be a string OR an object with .chr property
        const fc = el.sprite?.known?.fontchr;
        const char = (fc as { chr?: string })?.chr ?? (typeof fc === "string" ? fc : "");
        const isYellow = isKeywordColor(el.color as number[]);

        if (isYellow) {
          const gap = el.x - lastKeywordX;
          if (inKeyword) {
            // Large gap (> 8) = new keyword phrase
            if (gap > 8 && currentKeyword.trim()) {
              const word = currentKeyword.trim();
              if (word.length > 1) {
                keywords.push(word);
              }
              currentKeyword = '';
            } else {
              // Check for case transition: lowercase→uppercase = word boundary
              const isLowerToUpper = /[a-z]/.test(prevKeywordChar) && /[A-Z]/.test(char);
              const shouldAddSpace = (gap >= GAP_THRESHOLD) || (isLowerToUpper && gap > 0);
              if (shouldAddSpace) {
                currentKeyword += ' ';
              }
            }
          }
          currentKeyword += char;
          lastKeywordX = el.x + el.width;
          prevKeywordChar = char;
          inKeyword = true;
        } else if (inKeyword && currentKeyword.trim()) {
          // End of keyword
          const word = currentKeyword.trim();
          if (word.length > 1) {
            keywords.push(word);
          }
          currentKeyword = '';
          inKeyword = false;
          prevKeywordChar = '';
        }
      }
      // Don't forget last keyword
      if (currentKeyword.trim() && currentKeyword.trim().length > 1) {
        keywords.push(currentKeyword.trim());
      }

      // Determine line type by majority/first significant color
      const firstNonKeywordEl = lineEls.find(el => !isKeywordColor(el.color as number[]) && !isShadowText(el.color as number[]));
      const lineColor = firstNonKeywordEl?.color as number[] | undefined;
      const lineType = getDetailsType(lineColor);

      // Check for title (light blue)
      if (isTitleColor(lineColor) && !selectedQuestName) {
        selectedQuestName = line;
        continue;
      }

      if (lineType === "next_step") {
        nextSteps.push(line);
      } else if (lineType === "completed_step") {
        completedSteps.push(line);
      }
    }

    // Concatenate lines that don't end with sentence-ending punctuation
    const concatenateLines = (lines: string[]): string[] => {
      const result: string[] = [];
      let currentSentence = '';

      for (const line of lines) {
        if (currentSentence) {
          // Continue building sentence
          currentSentence += ' ' + line;
        } else {
          currentSentence = line;
        }

        // Check if this line ends a sentence
        const endsWithPunctuation = /[.!?]$/.test(line.trim());
        if (endsWithPunctuation) {
          result.push(currentSentence);
          currentSentence = '';
        }
      }

      // Don't forget any remaining partial sentence
      if (currentSentence) {
        result.push(currentSentence);
      }

      return result;
    };

    const concatenatedNextSteps = concatenateLines(nextSteps);
    const concatenatedCompletedSteps = concatenateLines(completedSteps);

    // Output structured result
    console.log("╔════════════════════════════════════════════════════════════╗");
    console.log("║           QUEST JOURNAL DETECTION RESULT                   ║");
    console.log("╠════════════════════════════════════════════════════════════╣");
    console.log(`║ isOpen: true                                               ║`);
    console.log(`║ questsTabActive: ${hasQuestOverview ? "true (Quest Overview found)" : "true (fallback)"}        ║`);
    console.log("╠════════════════════════════════════════════════════════════╣");

    if (selectedQuestName) {
      console.log(`║ SELECTED QUEST: ${selectedQuestName.substring(0, 42).padEnd(42)}║`);
      console.log("╠════════════════════════════════════════════════════════════╣");
    }

    console.log("║ QUEST LIST:                                                ║");
    const completed = quests.filter(q => q.status === "completed");
    const inProgress = quests.filter(q => q.status === "in_progress");
    const notStarted = quests.filter(q => q.status === "not_started");

    console.log(`║   ✓ Completed: ${completed.length.toString().padEnd(44)}║`);
    console.log(`║   → In Progress: ${inProgress.length.toString().padEnd(42)}║`);
    console.log(`║   ○ Not Started: ${notStarted.length.toString().padEnd(42)}║`);

    // Show first few quests of each type
    if (inProgress.length > 0) {
      console.log("║                                                            ║");
      console.log("║   In Progress Quests:                                      ║");
      for (const q of inProgress.slice(0, 5)) {
        console.log(`║     → ${q.name.substring(0, 52).padEnd(52)}║`);
      }
    }

    if (notStarted.length > 0 && notStarted.length <= 5) {
      console.log("║                                                            ║");
      console.log("║   Not Started Quests:                                      ║");
      for (const q of notStarted.slice(0, 5)) {
        console.log(`║     ○ ${q.name.substring(0, 52).padEnd(52)}║`);
      }
    }

    console.log("╠════════════════════════════════════════════════════════════╣");
    console.log("║ DETAILS PANEL:                                             ║");

    if (concatenatedNextSteps.length > 0) {
      console.log("║                                                            ║");
      console.log("║   ★ NEXT STEPS (Orange):                                   ║");
      for (const step of concatenatedNextSteps) {
        // Word wrap long lines
        const words = step.split(' ');
        let currentLine = '';
        for (const word of words) {
          if ((currentLine + ' ' + word).length > 52) {
            console.log(`║     ${currentLine.padEnd(54)}║`);
            currentLine = word;
          } else {
            currentLine = currentLine ? currentLine + ' ' + word : word;
          }
        }
        if (currentLine) {
          console.log(`║     ${currentLine.padEnd(54)}║`);
        }
      }
    }

    if (keywords.length > 0) {
      console.log("║                                                            ║");
      console.log("║   → Keywords/Links (Yellow):                               ║");
      const keywordList = keywords.join(", ").substring(0, 100);
      console.log(`║     ${keywordList.padEnd(54)}║`);
    }

    if (concatenatedCompletedSteps.length > 0) {
      console.log("║                                                            ║");
      console.log(`║   ✓ Completed Steps: ${concatenatedCompletedSteps.length.toString().padEnd(38)}║`);
      for (const step of concatenatedCompletedSteps.slice(0, 3)) {
        const truncated = step.length > 50 ? step.substring(0, 47) + "..." : step;
        console.log(`║     ${truncated.padEnd(54)}║`);
      }
      if (concatenatedCompletedSteps.length > 3) {
        console.log(`║     ... and ${(concatenatedCompletedSteps.length - 3).toString()} more                                      ║`);
      }
    }

    console.log("╚════════════════════════════════════════════════════════════╝");

    // Also log raw data for debugging
    console.log("\n[Debug] Raw quest data:", quests);
    console.log("[Debug] Next steps (concatenated):", concatenatedNextSteps);
    console.log("[Debug] Keywords:", keywords);
    console.log("[Debug] Completed steps (concatenated):", concatenatedCompletedSteps);

    /**
     * Categorize a color into a semantic type
     * Color format: [A, B, G, R] (ABGR order from RS3 renderer)
     */
    const categorizeColor = (c: number[]): { category: string; label: string } => {
      // ABGR: [0]=A, [1]=B, [2]=G, [3]=R
      const [a, b, g, r] = c;

      // Quest status colors (left panel)
      if (r < 50 && g > 200 && b < 50) return { category: "QUEST", label: "✓ COMPLETE (green)" };
      if (r < 50 && g > 200 && b > 200) return { category: "QUEST", label: "→ IN-PROGRESS (cyan)" };
      if (r > 200 && g < 50 && b < 50) return { category: "QUEST", label: "○ NOT-STARTED (red)" };
      if (r < 50 && g < 50 && b > 200) return { category: "QUEST", label: "○ NOT-STARTED (blue)" };

      // Details panel colors
      // Keywords/links - yellow/gold (234, 223, 118) RGB
      if (r > 220 && g > 200 && b > 100 && b < 140) return { category: "DETAILS", label: "→ Keyword/link (yellow)" };
      // Current step/objective - orange (225, 146, 30) RGB
      if (r > 200 && g > 120 && g < 170 && b < 50) return { category: "DETAILS", label: "★ Next step (orange)" };
      // Completed steps - grey text (steps already done)
      if (r > 100 && r < 160 && g > 100 && g < 160 && b > 100 && b < 160) return { category: "DETAILS", label: "✓ Completed step (grey)" };
      if (b > 220 && g > 180 && r > 100) return { category: "DETAILS", label: "Quest title (light blue)" };

      // UI colors
      if (r > 200 && g > 200 && b > 180) return { category: "UI", label: "Button/link text (cream)" };
      if (r > 200 && g > 200 && b > 200) return { category: "UI", label: "Highlighted text (white)" };
      if (b > 200 && g > 100 && g < 180 && r < 50) return { category: "UI", label: "UI header (blue)" };

      return { category: "OTHER", label: "Other" };
    };

    // Collect colors by category
    const colorsByCategory = new Map<string, Map<string, { count: number; sample: string; rgba: number[] }>>();

    for (const el of journalElements.filter(e => e.sprite?.known?.fontchr)) {
      const c = el.color as number[];
      if (!c || isShadowText(c)) continue;

      const { category, label } = categorizeColor(c);
      // ABGR: [0]=A, [1]=B, [2]=G, [3]=R
      const key = `R=${c[3]} G=${c[2]} B=${c[1]}`;

      if (!colorsByCategory.has(category)) {
        colorsByCategory.set(category, new Map());
      }
      const categoryMap = colorsByCategory.get(category)!;

      const fc = el.sprite?.known?.fontchr;
      const chr = fc?.chr ?? (typeof fc === "string" ? fc : "?");

      if (!categoryMap.has(key)) {
        categoryMap.set(key, { count: 0, sample: "", rgba: c });
      }
      const entry = categoryMap.get(key)!;
      entry.count++;
      if (entry.sample.length < 25) entry.sample += chr;
    }

    // Print by category
    const categoryOrder = ["QUEST", "DETAILS", "UI", "OTHER"];
    for (const category of categoryOrder) {
      const colors = colorsByCategory.get(category);
      if (!colors || colors.size === 0) continue;

      console.log(`  ── ${category} ──`);

      // Sort by count descending
      const sorted = Array.from(colors.entries()).sort((a, b) => b[1].count - a[1].count);

      for (const [key, data] of sorted) {
        const { label } = categorizeColor(data.rgba);
        console.log(`    ${label}`);
        console.log(`      ${key} (${data.count} chars)`);
        console.log(`      Sample: "${data.sample}"`);
      }
      console.log("");
    }
  }, [state.elements]);

  // Test color channel order to determine actual byte layout
  const testColorChannels = useCallback(() => {
    if (state.elements.length === 0) {
      console.log("[Color Test] No elements captured");
      return;
    }

    const elements = state.elements;
    const questListBgHash = 1599682762;

    // Find journal bounds
    let journalBounds: { x: number; y: number; w: number; h: number } | null = null;
    for (const el of elements) {
      if (el?.sprite?.pixelhash === questListBgHash) {
        journalBounds = { x: el.x, y: el.y, w: el.width, h: el.height };
        break;
      }
    }

    if (!journalBounds) {
      console.log("[Color Test] Quest Journal not found");
      return;
    }

    // Find text elements in journal
    const leftPanelMaxX = journalBounds.x + journalBounds.w * 0.35;
    const journalTextElements = elements.filter(el =>
      el.sprite?.known?.fontchr &&
      el.x >= journalBounds!.x &&
      el.x < leftPanelMaxX &&
      el.y >= journalBounds!.y &&
      el.y <= journalBounds!.y + journalBounds!.h &&
      !isShadowText(el.color as number[])
    );

    console.log("[Color Test] === COLOR CHANNEL ORDER TEST ===");
    console.log("[Color Test] Testing all possible byte orderings...");
    console.log("");

    // Collect unique colors with their text samples
    const uniqueColors = new Map<string, { raw: number[]; sample: string; count: number }>();

    for (const el of journalTextElements) {
      const c = el.color as number[];
      if (!c || c.length < 4) continue;

      const key = `${c[0]},${c[1]},${c[2]},${c[3]}`;
      const fc = el.sprite?.known?.fontchr;
      const chr = fc?.chr ?? (typeof fc === "string" ? fc : "?");

      if (!uniqueColors.has(key)) {
        uniqueColors.set(key, { raw: [...c], sample: "", count: 0 });
      }
      const entry = uniqueColors.get(key)!;
      entry.count++;
      if (entry.sample.length < 30) entry.sample += chr;
    }

    // Sort by count (most common first)
    const sortedColors = Array.from(uniqueColors.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 10); // Top 10 colors

    console.log("[Color Test] Top colors found in quest list (raw bytes):");
    console.log("");

    // Define possible orderings
    const orderings = [
      { name: "ARGB [A,R,G,B]", indices: [0, 1, 2, 3] },
      { name: "ABGR [A,B,G,R]", indices: [0, 3, 2, 1] },
      { name: "RGBA [R,G,B,A]", indices: [3, 0, 1, 2] },
      { name: "BGRA [B,G,R,A]", indices: [3, 2, 1, 0] },
    ];

    // Categorize a color given specific RGBA values
    const categorizeRGBA = (r: number, g: number, b: number): string => {
      // Pure colors
      if (r > 200 && g < 50 && b < 50) return "RED";
      if (r < 50 && g > 200 && b < 50) return "GREEN";
      if (r < 50 && g < 50 && b > 200) return "BLUE";
      // Mixed colors
      if (r < 50 && g > 200 && b > 200) return "CYAN";
      if (r > 200 && g > 200 && b < 50) return "YELLOW";
      if (r > 200 && g < 50 && b > 200) return "MAGENTA";
      // Neutrals
      if (r > 200 && g > 200 && b > 200) return "WHITE";
      if (r < 50 && g < 50 && b < 50) return "BLACK";
      if (Math.abs(r - g) < 30 && Math.abs(g - b) < 30) return "GREY";
      // Light variants
      if (r > 150 && g > 150 && b > 150) return "LIGHT";
      return "OTHER";
    };

    for (const [key, data] of sortedColors) {
      const raw = data.raw;
      console.log(`[Color Test] Raw: [${raw[0]}, ${raw[1]}, ${raw[2]}, ${raw[3]}] (${data.count} chars)`);
      console.log(`[Color Test] Sample: "${data.sample}"`);
      console.log("[Color Test] Interpretations:");

      for (const ordering of orderings) {
        const [aIdx, rIdx, gIdx, bIdx] = ordering.indices;
        const r = raw[rIdx!]!;
        const g = raw[gIdx!]!;
        const b = raw[bIdx!]!;
        const a = raw[aIdx!]!;

        const colorName = categorizeRGBA(r, g, b);
        const marker = colorName === "GREEN" ? " ← COMPLETE?" :
                       colorName === "CYAN" ? " ← IN-PROGRESS?" :
                       colorName === "BLUE" ? " ← NOT-STARTED?" :
                       colorName === "RED" ? " ← NOT-STARTED (alt)?" : "";

        console.log(`[Color Test]   ${ordering.name}: R=${r} G=${g} B=${b} A=${a} → ${colorName}${marker}`);
      }
      console.log("");
    }

    // Summary: which ordering gives expected quest status colors?
    console.log("[Color Test] === SUMMARY ===");
    console.log("[Color Test] Expected quest status colors:");
    console.log("[Color Test]   - COMPLETE quests: GREEN text");
    console.log("[Color Test]   - IN-PROGRESS quests: CYAN text");
    console.log("[Color Test]   - NOT-STARTED quests: BLUE or RED text");
    console.log("");
    console.log("[Color Test] Look at the interpretations above and see which ordering");
    console.log("[Color Test] produces GREEN/CYAN/BLUE for the expected quest statuses.");
    console.log("");

    // Try to auto-detect by finding the ordering that gives most sensible results
    console.log("[Color Test] === AUTO-DETECTION ===");

    for (const ordering of orderings) {
      const [aIdx, rIdx, gIdx, bIdx] = ordering.indices;

      let greenCount = 0;
      let cyanCount = 0;
      let blueCount = 0;
      let redCount = 0;

      for (const [, data] of sortedColors) {
        const r = data.raw[rIdx!]!;
        const g = data.raw[gIdx!]!;
        const b = data.raw[bIdx!]!;

        const colorName = categorizeRGBA(r, g, b);
        if (colorName === "GREEN") greenCount += data.count;
        if (colorName === "CYAN") cyanCount += data.count;
        if (colorName === "BLUE") blueCount += data.count;
        if (colorName === "RED") redCount += data.count;
      }

      const total = greenCount + cyanCount + blueCount + redCount;
      console.log(`[Color Test] ${ordering.name}: GREEN=${greenCount} CYAN=${cyanCount} BLUE=${blueCount} RED=${redCount} (total quest colors: ${total})`);
    }

  }, [state.elements]);

  // Test Inventory detection - finds slot grid and items
  const testInventory = useCallback(() => {
    if (state.elements.length === 0) {
      console.log("╔════════════════════════════════════════════════════════════╗");
      console.log("║           INVENTORY DETECTION RESULT                       ║");
      console.log("╠════════════════════════════════════════════════════════════╣");
      console.log("║ No elements captured. Click Capture first.                 ║");
      console.log("╚════════════════════════════════════════════════════════════╝");
      return;
    }

    const INVENTORY_SLOT_SPRITE_ID = 18266;
    const SLOT_WIDTH = 40;
    const SLOT_HEIGHT = 36;
    const EXPECTED_SLOTS = 28;  // RS3 inventory is always 4x7 = 28 slots
    const EXPECTED_COLS = 4;
    const EXPECTED_ROWS = 7;

    // Find all inventory slot sprites
    const slotSprites = state.elements.filter(
      (el) => el.sprite?.known?.id === INVENTORY_SLOT_SPRITE_ID
    );

    if (slotSprites.length === 0) {
      console.log("╔════════════════════════════════════════════════════════════╗");
      console.log("║           INVENTORY DETECTION RESULT                       ║");
      console.log("╠════════════════════════════════════════════════════════════╣");
      console.log("║ Inventory not found (no slot sprites 18266 detected)       ║");
      console.log("║ Make sure inventory is visible on screen.                  ║");
      console.log("╚════════════════════════════════════════════════════════════╝");
      return;
    }

    const slotStatus = slotSprites.length === EXPECTED_SLOTS
      ? "✓ All 28 slots detected"
      : `⚠ Expected 28, found ${slotSprites.length}`;

    console.log("╔════════════════════════════════════════════════════════════╗");
    console.log("║           INVENTORY DETECTION RESULT                       ║");
    console.log("╠════════════════════════════════════════════════════════════╣");
    console.log(`║ ${slotStatus.padEnd(58)}║`);

    // Sort slots by position to determine grid layout
    const sortedByY = [...slotSprites].sort((a, b) => a.y - b.y);
    const sortedByX = [...slotSprites].sort((a, b) => a.x - b.x);

    // Get grid bounds
    const minX = sortedByX[0]!.x;
    const maxX = sortedByX[sortedByX.length - 1]!.x;
    const minY = sortedByY[0]!.y;
    const maxY = sortedByY[sortedByY.length - 1]!.y;

    console.log("╠════════════════════════════════════════════════════════════╣");
    console.log("║ GRID BOUNDS:                                               ║");
    console.log(`║   Start X: ${minX.toFixed(0).padEnd(48)}║`);
    console.log(`║   Start Y: ${minY.toFixed(0).padEnd(48)}║`);
    console.log(`║   End X: ${maxX.toFixed(0).padEnd(50)}║`);
    console.log(`║   End Y: ${maxY.toFixed(0).padEnd(50)}║`);

    // Group by rows (Y position with tolerance)
    const rows = new Map<number, RenderRect[]>();
    const Y_TOLERANCE = 5;

    for (const slot of slotSprites) {
      let rowY: number | null = null;
      for (const existingY of rows.keys()) {
        if (Math.abs(slot.y - existingY) <= Y_TOLERANCE) {
          rowY = existingY;
          break;
        }
      }
      if (rowY === null) {
        rowY = slot.y;
        rows.set(rowY, []);
      }
      rows.get(rowY)!.push(slot);
    }

    // Sort rows from top to bottom (higher Y = higher on screen in RS3)
    const sortedRows = Array.from(rows.entries()).sort(([a], [b]) => b - a);

    console.log("╠════════════════════════════════════════════════════════════╣");
    console.log("║ GRID LAYOUT: 4 columns × 7 rows (fixed)                    ║");

    // Calculate gaps between slots
    let hGap = 0;
    let vGap = 0;

    if (sortedRows.length > 0) {
      const firstRow = sortedRows[0]![1].sort((a, b) => a.x - b.x);
      if (firstRow.length >= 2) {
        hGap = firstRow[1]!.x - (firstRow[0]!.x + SLOT_WIDTH);
        console.log(`║   Horizontal gap: ${hGap.toFixed(1).padEnd(40)}║`);
      }
    }

    if (sortedRows.length >= 2) {
      vGap = sortedRows[0]![0] - (sortedRows[1]![0] + SLOT_HEIGHT);
      console.log(`║   Vertical gap: ${vGap.toFixed(1).padEnd(42)}║`);
    }

    // Find items within each slot (non-slot, non-font elements)
    console.log("╠════════════════════════════════════════════════════════════╣");
    console.log("║ DETECTED ITEMS:                                            ║");

    interface DetectedItem {
      slot: number;
      x: number;
      y: number;
      pHash: string;         // Perceptual hash (stable across sessions)
      quantity: string;
      width: number;
      height: number;
    }

    const items: DetectedItem[] = [];
    let slotIndex = 0;

    for (const [, rowSlots] of sortedRows) {
      const sortedRowSlots = rowSlots.sort((a, b) => a.x - b.x);

      for (const slotSprite of sortedRowSlots) {
        // Find elements within this slot's bounds
        const slotBounds = {
          x: slotSprite.x,
          y: slotSprite.y,
          width: SLOT_WIDTH,
          height: SLOT_HEIGHT,
        };

        const slotElements = state.elements.filter((el) => {
          if (el.sprite?.known?.id === INVENTORY_SLOT_SPRITE_ID) return false;
          return (
            el.x >= slotBounds.x &&
            el.y >= slotBounds.y &&
            el.x + el.width <= slotBounds.x + slotBounds.width + 5 &&
            el.y + el.height <= slotBounds.y + slotBounds.height + 5
          );
        });

        // Separate font elements (quantity) from item sprites
        const fontElements = slotElements.filter((el) => el.sprite?.known?.fontchr);
        const itemSprites = slotElements.filter(
          (el) => !el.sprite?.known?.fontchr && el.width > 5 && el.height > 5
        );

        if (itemSprites.length > 0) {
          // Find largest non-font element (the item icon)
          const itemSprite = itemSprites.reduce((largest, curr) => {
            const largestArea = largest.width * largest.height;
            const currArea = curr.width * curr.height;
            return currArea > largestArea ? curr : largest;
          });

          // Extract quantity text
          let quantity = "1";
          if (fontElements.length > 0) {
            const sortedFont = fontElements.sort((a, b) => a.x - b.x);
            quantity = sortedFont
              .map((el) => {
                const fc = el.sprite?.known?.fontchr;
                return (fc as { chr?: string })?.chr ?? (typeof fc === "string" ? fc : "");
              })
              .join("");
          }

          // Compute perceptual hash from sprite pixels
          let pHashValue = 0n;
          let pHashHex = "0000000000000000";
          try {
            const sprite = itemSprite.sprite;
            if (sprite && sprite.basetex) {
              // Capture the sprite's pixels from the texture atlas
              const imgData = sprite.basetex.capture(
                sprite.x,
                sprite.y,
                sprite.width,
                sprite.height
              );
              pHashValue = dHash(imgData.data, imgData.width, imgData.height);
              pHashHex = hashToHex(pHashValue);
            }
          } catch (e) {
            console.warn(`[Inventory] Failed to compute pHash for slot ${slotIndex}:`, e);
          }

          items.push({
            slot: slotIndex,
            x: Math.round(slotSprite.x),
            y: Math.round(slotSprite.y),
            pHash: pHashHex,
            quantity,
            width: Math.round(itemSprite.width),
            height: Math.round(itemSprite.height),
          });
        }

        slotIndex++;
      }
    }

    if (items.length === 0) {
      console.log("║   No items detected (inventory may be empty)              ║");
    } else {
      console.log(`║   Found ${items.length} items:                                          ║`);
      console.log("╠════════════════════════════════════════════════════════════╣");
      console.log("║ DETECTED ITEMS (by pHash):                                 ║");
      for (const item of items.slice(0, 10)) {
        console.log(`║ Slot ${item.slot.toString().padStart(2)}: pHash=${item.pHash} qty=${item.quantity.padEnd(4)} ║`);
      }
      if (items.length > 10) {
        console.log(`║   ... and ${(items.length - 10).toString()} more items                                  ║`);
      }
    }

    console.log("╠════════════════════════════════════════════════════════════╣");
    console.log("║ CALIBRATION CONFIG:                                        ║");
    console.log("║   Copy this to InventoryMonitor:                           ║");

    const configJson = {
      startX: Math.round(minX),
      startY: Math.round(minY),
      slotWidth: SLOT_WIDTH,
      slotHeight: SLOT_HEIGHT,
      columns: EXPECTED_COLS,
      rows: EXPECTED_ROWS,
      horizontalGap: Math.round(hGap),
      verticalGap: Math.round(vGap),
    };

    console.log("║                                                            ║");
    console.log(`║   startX: ${configJson.startX}, startY: ${configJson.startY}`.padEnd(60) + "║");
    console.log(`║   slotWidth: ${SLOT_WIDTH}, slotHeight: ${SLOT_HEIGHT}`.padEnd(60) + "║");
    console.log(`║   columns: ${EXPECTED_COLS}, rows: ${EXPECTED_ROWS}`.padEnd(60) + "║");
    console.log(`║   horizontalGap: ${configJson.horizontalGap}, verticalGap: ${configJson.verticalGap}`.padEnd(60) + "║");
    console.log("╚════════════════════════════════════════════════════════════╝");

    // Log detailed data for debugging
    console.log("\n[Inventory Debug] Grid config:", configJson);
    console.log("[Inventory Debug] All items:", items.map(i => ({
      slot: i.slot,
      pHash: i.pHash,
      qty: i.quantity,
      size: `${i.width}x${i.height}`,
    })));
    console.log("[Inventory Debug] Unique pHashes:", [...new Set(items.map((i) => i.pHash))]);

    // Track new items - add to pending if not already known or pending
    const newPending = new Map(pendingItems);
    let newCount = 0;

    for (const item of items) {
      // Skip items without valid pHash
      if (!item.pHash || item.pHash === "0000000000000000") continue;

      // Skip if already known (in DB) or already pending
      if (knownItems.has(item.pHash) || newPending.has(item.pHash)) continue;

      // Add to pending items (no name yet - user will fill in)
      newPending.set(item.pHash, {
        pHash: item.pHash,
        name: "",
        firstSeen: Date.now(),
        slot: item.slot,
        x: item.x,
        y: item.y,
      });
      newCount++;
    }

    if (newCount > 0) {
      setPendingItems(newPending);
      console.log(`[Inventory] Found ${newCount} new item(s) to identify`);
    }

  }, [state.elements, knownItems, pendingItems]);

  // ========================================
  // TOOLTIP ITEM LEARNER TEST
  // ========================================

  /**
   * Initialize tooltip learner if not already done
   */
  const initTooltipLearner = useCallback(async () => {
    if (tooltipLearnerRef.current) return tooltipLearnerRef.current;

    if (!spriteCacheRef.current || !atlasRef.current) {
      console.log("[Tooltip Test] Sprite cache not ready");
      return null;
    }

    // Create a simple GLBridge-like adapter using patchrs directly
    const glBridgeAdapter = {
      recordRenderCalls: async (options: any) => {
        return patchrs.native.recordRenderCalls({
          features: ["vertexarray", "uniforms", "texturesnapshot"],
          ...options
        });
      },
      getUIState: (renders: any) => {
        return getUIState(renders, atlasRef.current!);
      },
      getSpriteCache: () => spriteCacheRef.current!,
    };

    const learner = new TooltipItemLearner(glBridgeAdapter as any);
    tooltipLearnerRef.current = learner;

    // Log learned items
    learner.onItemLearned((item) => {
      console.log(`[Tooltip] LEARNED: "${item.name}" (hash: ${item.iconHash}, pHash: ${item.pHash ?? 'none'})`);
    });

    return learner;
  }, []);

  /**
   * Run a single tooltip detection test
   */
  const testTooltipOnce = useCallback(async () => {
    const learner = await initTooltipLearner();
    if (!learner) {
      setState(s => ({ ...s, error: "Could not initialize tooltip learner" }));
      return;
    }

    try {
      // Record renders with uniforms to get mouse position
      const renders = await patchrs.native.recordRenderCalls({
        features: ["vertexarray", "uniforms", "texturesnapshot"],
      });

      // Debug: log uniform names on first test
      const uniformNames = debugUniformNames(renders as unknown as RenderInvocation[]);
      console.log("[Tooltip Test] Available uniforms:", uniformNames.slice(0, 20).join(", "));

      // Get UI state to check for tooltip sprites
      const uiState = getUIState(renders, atlasRef.current!);
      const tooltipSprites = uiState.elements.filter(el =>
        el.sprite.known && [4650, 4649, 4651, 35516].includes(el.sprite.known.id)
      );
      if (tooltipSprites.length > 0) {
        console.log(`[Tooltip Test] Found ${tooltipSprites.length} tooltip sprites:`,
          tooltipSprites.map(s => `ID ${s.sprite.known?.id} at (${s.x}, ${s.y})`).slice(0, 5));
      }

      // Get mouse position from renders (likely won't work - it's a builtin for overlays only)
      const mousePos = findMousePosition(renders as unknown as RenderInvocation[]);

      // Run tooltip detection
      const result = await learner.detectAndLearn();

      setTooltipTestResult({
        mousePos,
        tooltipVisible: result.isVisible,
        tooltipText: result.text,
        hoveredSlot: result.nearestSlot,
        confidence: result.confidence,
        learnedItems: learner.getLearnedItems().length,
      });

      console.log(`[Tooltip Test] Mouse: ${mousePos ? `(${mousePos.x.toFixed(0)}, ${mousePos.y.toFixed(0)})` : 'not found'} | Tooltip: ${result.text ?? 'none'} | Slot: ${result.nearestSlot ?? 'none'} | Conf: ${(result.confidence * 100).toFixed(0)}%`);
    } catch (err) {
      console.error("[Tooltip Test] Error:", err);
      setState(s => ({ ...s, error: `Tooltip test error: ${err}` }));
    }
  }, [initTooltipLearner]);

  /**
   * Start continuous tooltip testing
   */
  const startTooltipTest = useCallback(async () => {
    if (isTooltipTesting) return;

    const learner = await initTooltipLearner();
    if (!learner) {
      setState(s => ({ ...s, error: "Could not initialize tooltip learner" }));
      return;
    }

    setIsTooltipTesting(true);
    console.log("[Tooltip Test] Starting continuous test - hover over inventory items...");

    tooltipTestIntervalRef.current = setInterval(async () => {
      try {
        const renders = await patchrs.native.recordRenderCalls({
          features: ["vertexarray", "uniforms", "texturesnapshot"],
        });

        const mousePos = findMousePosition(renders as unknown as RenderInvocation[]);
        const result = await learner.detectAndLearn();

        setTooltipTestResult({
          mousePos,
          tooltipVisible: result.isVisible,
          tooltipText: result.text,
          hoveredSlot: result.nearestSlot,
          confidence: result.confidence,
          learnedItems: learner.getLearnedItems().length,
        });
      } catch (err) {
        console.error("[Tooltip Test] Frame error:", err);
      }
    }, 300);
  }, [isTooltipTesting, initTooltipLearner]);

  /**
   * Stop continuous tooltip testing
   */
  const stopTooltipTest = useCallback(() => {
    if (tooltipTestIntervalRef.current) {
      clearInterval(tooltipTestIntervalRef.current);
      tooltipTestIntervalRef.current = null;
    }
    setIsTooltipTesting(false);
    console.log("[Tooltip Test] Stopped");
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (tooltipTestIntervalRef.current) {
        clearInterval(tooltipTestIntervalRef.current);
      }
      if (fontScanIntervalRef.current) {
        clearInterval(fontScanIntervalRef.current);
      }
    };
  }, []);

  // ==================== FONT CHARACTER COLLECTOR ====================

  /**
   * Update font collector statistics
   */
  const updateFontCollectorStats = useCallback(() => {
    if (!fontCollectorRef.current) return;

    const stats = fontCollectorRef.current.getStats();
    setFontCollectorStats(stats);
  }, []);

  /**
   * Initialize the font character collector
   */
  const initFontCollector = useCallback(() => {
    if (fontCollectorRef.current) return fontCollectorRef.current;

    const collector = new FontCharacterCollector();
    fontCollectorRef.current = collector;

    // Set sprite cache for auto-recognition
    if (spriteCacheRef.current) {
      collector.setSpriteCache(spriteCacheRef.current);
    }

    // Listen for new characters
    collector.onCharacterCollected((char) => {
      console.log(`[FontCollector] New character: ${char.chr ?? 'unknown'} (hash: ${char.hash}, ${char.width}x${char.height})`);
      updateFontCollectorStats();
    });

    console.log("[FontCollector] Initialized");
    return collector;
  }, [updateFontCollectorStats]);

  /**
   * Scan once for font characters
   */
  const scanFontCharactersOnce = useCallback(async () => {
    if (!patchrs.native || !atlasRef.current) {
      setState(s => ({ ...s, error: "Not ready - native addon or atlas not loaded" }));
      return;
    }

    const collector = initFontCollector();
    if (!collector) {
      setState(s => ({ ...s, error: "Could not initialize font collector" }));
      return;
    }

    try {
      // Capture current frame
      const renders = await patchrs.native.recordRenderCalls({
        features: ["vertexarray", "uniforms", "texturesnapshot"],
      });
      const uiState = getUIState(renders, atlasRef.current);

      // Pass raw elements to preserve basetex for pHash computation
      const newChars = collector.scanForCharacters(uiState.elements);
      console.log(`[FontCollector] Found ${newChars.length} new characters`);
      updateFontCollectorStats();
    } catch (err) {
      console.error("[FontCollector] Scan error:", err);
      setState(s => ({ ...s, error: `Font scan error: ${err}` }));
    }
  }, [initFontCollector, updateFontCollectorStats]);

  /**
   * Start continuous font character scanning
   */
  const startFontScanning = useCallback(async () => {
    if (isFontScanning) return;

    if (!patchrs.native || !atlasRef.current) {
      setState(s => ({ ...s, error: "Not ready - native addon or atlas not loaded" }));
      return;
    }

    const collector = initFontCollector();
    if (!collector) {
      setState(s => ({ ...s, error: "Could not initialize font collector" }));
      return;
    }

    setIsFontScanning(true);
    console.log("[FontCollector] Starting continuous scanning...");

    fontScanIntervalRef.current = setInterval(async () => {
      try {
        if (!atlasRef.current) return;

        const renders = await patchrs.native.recordRenderCalls({
          features: ["vertexarray", "uniforms", "texturesnapshot"],
        });
        const uiState = getUIState(renders, atlasRef.current);

        // Pass raw elements to preserve basetex for pHash computation
        collector.scanForCharacters(uiState.elements);
        updateFontCollectorStats();
      } catch (err) {
        console.error("[FontCollector] Scan frame error:", err);
      }
    }, 500);
  }, [isFontScanning, initFontCollector, updateFontCollectorStats]);

  /**
   * Stop continuous font scanning
   */
  const stopFontScanning = useCallback(() => {
    if (fontScanIntervalRef.current) {
      clearInterval(fontScanIntervalRef.current);
      fontScanIntervalRef.current = null;
    }
    setIsFontScanning(false);
    console.log("[FontCollector] Stopped scanning");
  }, []);

  /**
   * Label a collected character
   */
  const labelFontCharacter = useCallback((hash: number, chr: string) => {
    if (!fontCollectorRef.current) return;

    if (fontCollectorRef.current.labelCharacter(hash, chr)) {
      console.log(`[FontCollector] Labeled hash ${hash} as "${chr}"`);
      updateFontCollectorStats();
      setSelectedFontChar(null);
      setFontLabelInput('');
    }
  }, [updateFontCollectorStats]);

  /**
   * Export collected characters to JSON
   */
  const exportFontCharactersJson = useCallback(() => {
    if (!fontCollectorRef.current) return;

    const json = fontCollectorRef.current.exportToJsonString(-1, true);

    // Copy to clipboard
    navigator.clipboard.writeText(json).then(() => {
      console.log("[FontCollector] JSON copied to clipboard");
    }).catch((err) => {
      console.error("[FontCollector] Failed to copy:", err);
    });

    // Also log to console for easy access
    console.log("[FontCollector] Exported JSON:");
    console.log(json);
  }, []);

  /**
   * Download collected characters as JSON file
   */
  const downloadFontCharactersJson = useCallback(() => {
    if (!fontCollectorRef.current) return;

    const json = fontCollectorRef.current.exportToJsonString(-1, true);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `font-characters-${Date.now()}.json`;
    a.click();

    URL.revokeObjectURL(url);
    console.log("[FontCollector] Downloaded JSON file");
  }, []);

  /**
   * Clear all collected font characters
   */
  const clearFontCharacters = useCallback(() => {
    if (!fontCollectorRef.current) return;

    fontCollectorRef.current.clear();
    updateFontCollectorStats();
    setSelectedFontChar(null);
    console.log("[FontCollector] Cleared all characters");
  }, [updateFontCollectorStats]);

  /**
   * Auto-label unlabeled characters using perceptual hash matching
   */
  const autoLabelFontCharacters = useCallback(() => {
    if (!fontCollectorRef.current) return;

    const matches = fontCollectorRef.current.autoLabelByPHash(pHashThreshold);
    updateFontCollectorStats();

    if (matches.length > 0) {
      console.log(`[FontCollector] Auto-labeled ${matches.length} characters:`);
      matches.forEach((m) => {
        console.log(`  "${m.matchedTo.chr}" (distance: ${m.distance})`);
      });
    }
    // Detailed feedback is now logged by autoLabelByPHash itself
  }, [updateFontCollectorStats, pHashThreshold]);

  /**
   * Cascade auto-label: match across atlas regions (cross-size)
   */
  const cascadeAutoLabelCharacters = useCallback(() => {
    if (!fontCollectorRef.current) return;

    // First do cascade (cross-size within regions)
    const cascadeMatches = fontCollectorRef.current.cascadeAutoLabel(pHashThreshold + 3);
    // Then do standard (same-size)
    const standardMatches = fontCollectorRef.current.autoLabelByPHash(pHashThreshold);

    updateFontCollectorStats();

    const totalMatches = cascadeMatches.length + standardMatches.length;
    if (totalMatches > 0) {
      console.log(`[FontCollector] Total auto-labeled: ${totalMatches} (cascade: ${cascadeMatches.length}, standard: ${standardMatches.length})`);
    }
  }, [updateFontCollectorStats, pHashThreshold]);

  /**
   * Analyze atlas pattern and infer labels
   */
  const analyzeAndInferPattern = useCallback(() => {
    if (!fontCollectorRef.current) return;

    // First analyze the pattern
    const pattern = fontCollectorRef.current.analyzeAtlasPattern();

    // Infer labels from pattern (if available)
    let patternInferred = 0;
    if (pattern) {
      const inferred = fontCollectorRef.current.inferFromAtlasPattern(pattern);
      patternInferred = inferred.length;
    }

    // Also do position-based inference for ALL regions
    const positionInferred = fontCollectorRef.current.inferAllByPosition();

    // Also get region info for display
    const regions = fontCollectorRef.current.getAtlasRegionInfo();

    const totalInferred = patternInferred + positionInferred.length;
    if (totalInferred > 0) {
      console.log(`[FontCollector] Pattern inference: ${patternInferred}, Position inference: ${positionInferred.length}`);
    }
    console.log('[FontCollector] Atlas regions:', regions);

    updateFontCollectorStats();
  }, [updateFontCollectorStats]);

  /**
   * Run full auto-label pipeline - the one-click solution
   */
  const runFullAutoLabel = useCallback(() => {
    if (!fontCollectorRef.current) return;

    const results = fontCollectorRef.current.fullAutoLabel();

    console.log('[SpriteDiscovery] Full auto-label results:', results);

    updateFontCollectorStats();
  }, [updateFontCollectorStats]);

  /**
   * Run safe auto-label - only pHash matching, no position inference
   */
  const runSafeAutoLabel = useCallback(() => {
    if (!fontCollectorRef.current) return;

    const results = fontCollectorRef.current.safeAutoLabel();

    console.log('[SpriteDiscovery] Safe auto-label results:', results);

    updateFontCollectorStats();
  }, [updateFontCollectorStats]);

  /**
   * Get low-confidence labels for review
   */
  const getLowConfidenceLabels = useCallback(() => {
    if (!fontCollectorRef.current) return [];
    return fontCollectorRef.current.getLowConfidenceLabels();
  }, []);

  /**
   * Clear low-confidence labels
   */
  const clearLowConfLabels = useCallback(() => {
    if (!fontCollectorRef.current) return;
    fontCollectorRef.current.clearLowConfidenceLabels(0.75);
    updateFontCollectorStats();
  }, [updateFontCollectorStats]);

  /**
   * Import labels from JSON file - applies saved labels to current scan
   */
  const importLabelsFromFile = useCallback((file: File) => {
    if (!fontCollectorRef.current) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target?.result as string);
        const result = fontCollectorRef.current!.importLabelsFromJson(data);
        console.log('[SpriteDiscovery] Import results:', result);
        updateFontCollectorStats();
      } catch (err) {
        console.error('[SpriteDiscovery] Failed to parse JSON:', err);
      }
    };
    reader.readAsText(file);
  }, [updateFontCollectorStats]);

  /**
   * Get unlabeled characters for display
   */
  const getUnlabeledChars = useCallback((): CollectedCharacter[] => {
    if (!fontCollectorRef.current) return [];
    return fontCollectorRef.current.getUnlabeledCharacters();
  }, []);

  /**
   * Get ALL collected characters (both labeled and unlabeled)
   */
  const getAllCollectedChars = useCallback((): CollectedCharacter[] => {
    if (!fontCollectorRef.current) return [];
    return fontCollectorRef.current.getCollectedCharacters();
  }, []);

  /**
   * Capture and display preview of selected font character
   */
  const updateFontCharPreview = useCallback(() => {
    if (!selectedFontChar || !fontPreviewCanvasRef.current) return;

    // Find the element in state.elements that matches this character's position
    const matchingEl = state.elements.find(el =>
      Math.abs(el.x - selectedFontChar.screenX) < 2 &&
      Math.abs(el.y - selectedFontChar.screenY) < 2 &&
      el.width === selectedFontChar.width &&
      el.height === selectedFontChar.height
    );

    if (!matchingEl) {
      console.log("[FontPreview] Could not find matching element for preview");
      return;
    }

    const previewCanvas = fontPreviewCanvasRef.current;
    const ctx = previewCanvas.getContext("2d");
    if (!ctx) return;

    // Try to capture the sprite image
    try {
      const sprite = matchingEl.sprite;
      if (sprite.basetex) {
        const imgData = sprite.basetex.capture(
          sprite.x,
          sprite.y,
          sprite.width,
          sprite.height
        );

        // Scale up for visibility (8x zoom)
        const zoom = 8;
        previewCanvas.width = imgData.width * zoom;
        previewCanvas.height = imgData.height * zoom;

        ctx.imageSmoothingEnabled = false;

        // Create temp canvas for the image data
        const tempCanvas = document.createElement("canvas");
        tempCanvas.width = imgData.width;
        tempCanvas.height = imgData.height;
        const tempCtx = tempCanvas.getContext("2d")!;
        tempCtx.putImageData(imgData, 0, 0);

        // Draw scaled up
        ctx.drawImage(tempCanvas, 0, 0, previewCanvas.width, previewCanvas.height);

        console.log(`[FontPreview] Captured ${imgData.width}x${imgData.height} character`);
      }
    } catch (e) {
      console.error("[FontPreview] Error capturing sprite:", e);
      // Draw placeholder
      previewCanvas.width = 64;
      previewCanvas.height = 64;
      ctx.fillStyle = "#333";
      ctx.fillRect(0, 0, 64, 64);
      ctx.fillStyle = "#888";
      ctx.font = "10px monospace";
      ctx.fillText("No preview", 5, 35);
    }
  }, [selectedFontChar, state.elements]);

  // Update preview when selected char changes
  useEffect(() => {
    updateFontCharPreview();
  }, [selectedFontChar, updateFontCharPreview]);

  // ==================== END FONT CHARACTER COLLECTOR ====================

  /**
   * Compute image hash using same algorithm as game (CRC32 of pixel data)
   * Matches the imgcrc function from spritecache.ts
   */
  const computeImageHash = (imageData: ImageData): number => {
    const data = new Uint8ClampedArray(imageData.data);
    // Apply same quirk fix as game: blue=0 becomes blue=1
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 2] === 0) {
        data[i + 2] = 1;
      }
    }
    return crc32(data);
  };

  /**
   * Handle dropped image file - compute its hash
   */
  const handleImageDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();

    const file = e.dataTransfer.files[0];
    if (!file || !file.type.startsWith('image/')) {
      console.log("[ImageHash] Not an image file");
      return;
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = () => {
        // Draw to canvas to get pixel data
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, img.width, img.height);
        const hash = computeImageHash(imageData);

        console.log(`[ImageHash] File: ${file.name}`);
        console.log(`[ImageHash] Size: ${img.width}×${img.height}`);
        console.log(`[ImageHash] Hash: ${hash}`);

        setDroppedImageHash({
          hash,
          name: file.name,
          size: `${img.width}×${img.height}`,
        });
      };
      img.src = event.target?.result as string;
    };
    reader.readAsDataURL(file);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  // Get unique sprite IDs from captured elements
  const getUniqueSprites = useCallback(() => {
    const ids = new Map<number, { count: number; example: RenderRect }>();

    for (const el of state.elements) {
      const id = el.sprite?.known?.id;
      if (id !== undefined) {
        const existing = ids.get(id);
        if (existing) {
          existing.count++;
        } else {
          ids.set(id, { count: 1, example: el });
        }
      }
    }

    return Array.from(ids.entries())
      .sort(([a], [b]) => a - b)
      .map(([id, data]) => ({ id, ...data }));
  }, [state.elements]);

  const sel = state.selectedElement;

  return (
    <div style={{ display: "flex", height: "100vh", background: "#1a1a2e", color: "#fff" }}>
      {/* Canvas */}
      <canvas
        ref={canvasRef}
        width={800}
        height={600}
        style={{ flex: 1, cursor: "crosshair", minWidth: 400 }}
        onClick={handleCanvasClick}
        onMouseDown={handleMouseDown}
      />

      {/* Controls */}
      <div style={{ width: 300, padding: 10, overflowY: "auto", background: "#2a2a4a" }}>
        <h3 style={{ margin: "0 0 10px" }}>Sprite Discovery</h3>

        {state.error && (
          <div style={{ color: "#f66", marginBottom: 10 }}>{state.error}</div>
        )}

        <div style={{ marginBottom: 10 }}>
          <button
            onClick={captureFrame}
            disabled={state.isCapturing}
            style={{ padding: "8px 16px", marginRight: 5 }}
          >
            {state.isCapturing ? "Capturing..." : "Capture"}
          </button>
          <span style={{ fontSize: 12 }}>{state.elements.length} elements</span>
        </div>

        <div style={{ marginBottom: 10, display: "flex", gap: 5, flexWrap: "wrap" }}>
          <button
            onClick={exportJSON}
            disabled={state.elements.length === 0}
            style={{ padding: "6px 12px", fontSize: 12 }}
          >
            Export JSON
          </button>
          <button
            onClick={testDetection}
            disabled={state.elements.length === 0}
            style={{ padding: "6px 12px", fontSize: 12 }}
          >
            Test Detection
          </button>
          <button
            onClick={testColorChannels}
            disabled={state.elements.length === 0}
            style={{ padding: "6px 12px", fontSize: 12, background: "#4a4a8a" }}
          >
            Test Colors
          </button>
          <button
            onClick={testInventory}
            disabled={state.elements.length === 0}
            style={{ padding: "6px 12px", fontSize: 12, background: "#4a8a4a" }}
          >
            Test Inventory
          </button>
        </div>

        {/* Tooltip Test Section */}
        <div style={{ marginBottom: 10, padding: 8, background: "#3a3a6a", borderRadius: 4 }}>
          <div style={{ fontWeight: "bold", marginBottom: 5, fontSize: 12 }}>Tooltip Item Learner</div>
          <div style={{ display: "flex", gap: 5, marginBottom: 8 }}>
            <button
              onClick={testTooltipOnce}
              style={{ padding: "4px 8px", fontSize: 11, background: "#5a5aaa" }}
            >
              Test Once
            </button>
            <button
              onClick={isTooltipTesting ? stopTooltipTest : startTooltipTest}
              style={{
                padding: "4px 8px",
                fontSize: 11,
                background: isTooltipTesting ? "#aa5a5a" : "#5aaa5a"
              }}
            >
              {isTooltipTesting ? "Stop" : "Start Continuous"}
            </button>
          </div>
          {tooltipTestResult && (
            <div style={{ fontSize: 11, lineHeight: 1.4 }}>
              <div>Mouse: {tooltipTestResult.mousePos
                ? `(${tooltipTestResult.mousePos.x.toFixed(0)}, ${tooltipTestResult.mousePos.y.toFixed(0)})`
                : <span style={{ color: "#f88" }}>not found</span>}
              </div>
              <div>Tooltip: {tooltipTestResult.tooltipVisible
                ? <span style={{ color: "#8f8" }}>"{tooltipTestResult.tooltipText}"</span>
                : <span style={{ color: "#888" }}>none</span>}
              </div>
              <div>Slot: {tooltipTestResult.hoveredSlot !== null
                ? <span style={{ color: "#8ff" }}>{tooltipTestResult.hoveredSlot}</span>
                : <span style={{ color: "#888" }}>none</span>}
              </div>
              <div>Confidence: <span style={{
                color: tooltipTestResult.confidence > 0.9 ? "#8f8" :
                       tooltipTestResult.confidence > 0.7 ? "#ff8" : "#f88"
              }}>{(tooltipTestResult.confidence * 100).toFixed(0)}%</span></div>
              <div>Learned Items: <span style={{ color: "#8ff" }}>{tooltipTestResult.learnedItems}</span></div>
            </div>
          )}
        </div>

        {/* Font Character Collector Section */}
        <div style={{ marginBottom: 10, padding: 8, background: "#3a6a3a", borderRadius: 4 }}>
          <div style={{ fontWeight: "bold", marginBottom: 5, fontSize: 12 }}>Font Character Collector</div>
          <div style={{ display: "flex", gap: 5, marginBottom: 8, flexWrap: "wrap" }}>
            <button
              onClick={scanFontCharactersOnce}
              style={{ padding: "4px 8px", fontSize: 11, background: "#5aaa5a" }}
            >
              Scan Once
            </button>
            <button
              onClick={isFontScanning ? stopFontScanning : startFontScanning}
              style={{
                padding: "4px 8px",
                fontSize: 11,
                background: isFontScanning ? "#aa5a5a" : "#5a8a5a"
              }}
            >
              {isFontScanning ? "Stop" : "Continuous"}
            </button>
            <button
              onClick={exportFontCharactersJson}
              disabled={!fontCollectorStats || fontCollectorStats.total === 0}
              style={{ padding: "4px 8px", fontSize: 11, background: "#5a5aaa" }}
            >
              Copy JSON
            </button>
            <button
              onClick={downloadFontCharactersJson}
              disabled={!fontCollectorStats || fontCollectorStats.total === 0}
              style={{ padding: "4px 8px", fontSize: 11, background: "#5a5aaa" }}
            >
              Download
            </button>
            <button
              onClick={clearFontCharacters}
              disabled={!fontCollectorStats || fontCollectorStats.total === 0}
              style={{ padding: "4px 8px", fontSize: 11, background: "#aa5a5a" }}
            >
              Clear
            </button>
            <button
              onClick={() => {
                const unlabeled = getUnlabeledChars();
                console.log(`[FontCollector] ${unlabeled.length} unlabeled characters:`);
                unlabeled.slice(0, 20).forEach((c, i) => {
                  console.log(`  ${i}: (${c.screenX.toFixed(0)}, ${c.screenY.toFixed(0)}) ${c.width}x${c.height} hash=${c.hash} pHash=${c.pHashHex ?? 'none'}`);
                });
              }}
              style={{ padding: "4px 8px", fontSize: 11, background: "#5a5a8a" }}
            >
              Log
            </button>
            <label
              title="Import labels from saved JSON file"
              style={{
                padding: "4px 8px",
                fontSize: 11,
                background: "#5a8a5a",
                border: "1px solid #6a6",
                borderRadius: 3,
                cursor: "pointer"
              }}
            >
              📥 Import
              <input
                type="file"
                accept=".json"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) {
                    importLabelsFromFile(file);
                    e.target.value = ''; // Reset so same file can be imported again
                  }
                }}
                style={{ display: "none" }}
              />
            </label>
          </div>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4, alignItems: "center" }}>
            <button
              onClick={autoLabelFontCharacters}
              disabled={!fontCollectorStats || fontCollectorStats.autoMatchable === 0}
              title="Auto-label unlabeled characters using perceptual hash matching (same size only)"
              style={{
                padding: "4px 8px",
                fontSize: 11,
                background: fontCollectorStats && fontCollectorStats.autoMatchable > 0 ? "#8a5aaa" : "#4a4a4a"
              }}
            >
              Auto-Label ({fontCollectorStats?.autoMatchable ?? 0})
            </button>
            <button
              onClick={cascadeAutoLabelCharacters}
              disabled={!fontCollectorStats || fontCollectorStats.unlabeled === 0}
              title="Cascade auto-label: match across sizes within same atlas region (uses threshold +3)"
              style={{
                padding: "4px 8px",
                fontSize: 11,
                background: fontCollectorStats && fontCollectorStats.unlabeled > 0 ? "#aa8a5a" : "#4a4a4a"
              }}
            >
              Cascade
            </button>
            <button
              onClick={analyzeAndInferPattern}
              disabled={!fontCollectorStats || fontCollectorStats.labeled < 3}
              title="Analyze atlas grid pattern and infer labels based on character positions"
              style={{
                padding: "4px 8px",
                fontSize: 11,
                background: fontCollectorStats && fontCollectorStats.labeled >= 3 ? "#5aaa8a" : "#4a4a4a"
              }}
            >
              Pattern
            </button>
            <button
              onClick={runSafeAutoLabel}
              disabled={!fontCollectorStats || fontCollectorStats.unlabeled === 0}
              title="Safe auto-label: pHash matching only (high accuracy, lower coverage)"
              style={{
                padding: "4px 8px",
                fontSize: 11,
                background: fontCollectorStats && fontCollectorStats.unlabeled > 0 ? "#3a7a3a" : "#4a4a4a",
                border: "1px solid #6f6"
              }}
            >
              🔒 Safe
            </button>
            <button
              onClick={runFullAutoLabel}
              disabled={!fontCollectorStats || fontCollectorStats.unlabeled === 0}
              title="Full auto-label: pHash + pattern + position inference (higher coverage, may include some guesses)"
              style={{
                padding: "4px 8px",
                fontSize: 11,
                fontWeight: "bold",
                background: fontCollectorStats && fontCollectorStats.unlabeled > 0 ? "#2a8a2a" : "#4a4a4a",
                border: "1px solid #4f4"
              }}
            >
              ⚡ Full
            </button>
            <span style={{ fontSize: 10, color: "#aaa" }}>threshold:</span>
            <input
              type="range"
              min={0}
              max={20}
              value={pHashThreshold}
              onChange={(e) => setPHashThreshold(Number(e.target.value))}
              style={{ width: 60 }}
              title={`pHash distance threshold (${pHashThreshold}). Lower = stricter matching, higher = more lenient`}
            />
            <span style={{ fontSize: 10, color: "#8af", minWidth: 16 }}>{pHashThreshold}</span>
          </div>
          {fontCollectorStats && (
            <div style={{ fontSize: 11, lineHeight: 1.4, marginTop: 4 }}>
              <div>Total: <span style={{ color: "#8ff" }}>{fontCollectorStats.total}</span></div>
              <div>Labeled: <span style={{ color: "#8f8" }}>{fontCollectorStats.labeled}</span></div>
              <div>Unlabeled: <span style={{ color: "#ff8" }}>{fontCollectorStats.unlabeled}</span></div>
              <div>With pHash: <span style={{ color: "#f8f" }}>{fontCollectorStats.withPHash}</span></div>
              {fontCollectorStats.autoMatchable > 0 && (
                <div style={{ color: "#aaf" }}>
                  Can auto-match: {fontCollectorStats.autoMatchable}
                </div>
              )}
              {fontCollectorStats.bySize.length > 0 && (
                <div style={{ marginTop: 4 }}>
                  <div style={{ color: "#aaa" }}>By size:</div>
                  {fontCollectorStats.bySize.slice(0, 5).map((s, i) => (
                    <div key={i} style={{ paddingLeft: 8 }}>{s.size}: {s.count}</div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Low-confidence labels for review */}
          {fontCollectorStats && getLowConfidenceLabels().length > 0 && (
            <div style={{ marginTop: 8, borderTop: "1px solid #aa8a5a", paddingTop: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 11, color: "#fa8" }}>
                  ⚠️ Low Confidence ({getLowConfidenceLabels().length}):
                </span>
                <button
                  onClick={clearLowConfLabels}
                  title="Clear all low-confidence labels (confidence < 75%)"
                  style={{
                    padding: "2px 6px",
                    fontSize: 9,
                    background: "#8a4a4a",
                    border: "1px solid #a66"
                  }}
                >
                  Clear
                </button>
              </div>
              <div style={{ maxHeight: 80, overflowY: "auto", fontSize: 10 }}>
                {getLowConfidenceLabels().slice(0, 15).map((item, i) => (
                  <div key={i} style={{
                    padding: "2px 4px",
                    marginBottom: 1,
                    background: item.confidence < 0.6 ? "#4a2a2a" : "#4a3a2a",
                    borderRadius: 2
                  }}>
                    "{item.inferred}" <span style={{ color: "#888" }}>conf:</span>
                    <span style={{ color: item.confidence < 0.6 ? "#f88" : "#fa8" }}>
                      {(item.confidence * 100).toFixed(0)}%
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* All collected characters - green = labeled, yellow = unlabeled */}
          {fontCollectorStats && fontCollectorStats.total > 0 && (
            <div style={{ marginTop: 8, borderTop: "1px solid #5a8a5a", paddingTop: 8 }}>
              <div style={{ fontSize: 11, marginBottom: 4 }}>
                Characters: <span style={{ color: "#8f8" }}>{fontCollectorStats.labeled} found</span>
                {" / "}<span style={{ color: "#fa8" }}>{fontCollectorStats.unlabeled} unknown</span>
              </div>
              <div style={{ maxHeight: 150, overflowY: "auto", fontSize: 10 }}>
                {getAllCollectedChars().slice(0, 50).map((char) => {
                  const isLabeled = char.chr !== undefined;
                  const isSelected = selectedFontChar?.hash === char.hash;
                  return (
                    <div
                      key={char.hash}
                      onClick={() => {
                        setSelectedFontChar(char);
                        console.log(`[FontCollector] Selected char "${char.chr ?? '?'}" at (${char.screenX}, ${char.screenY}) size ${char.width}x${char.height} hash ${char.hash} pHash=${char.pHashHex ?? 'none'}`);
                      }}
                      style={{
                        padding: "2px 4px",
                        marginBottom: 2,
                        background: isSelected ? "#8a8aff" : (isLabeled ? "#2a4a2a" : "#4a3a2a"),
                        border: isLabeled ? "1px solid #4a8a4a" : "1px solid #8a6a4a",
                        borderRadius: 2,
                        cursor: "pointer",
                      }}
                    >
                      {isLabeled ? (
                        <span style={{ color: "#8f8", fontWeight: "bold", marginRight: 4 }}>"{char.chr}"</span>
                      ) : (
                        <span style={{ color: "#fa8", marginRight: 4 }}>???</span>
                      )}
                      <span style={{ color: "#888" }}>{char.width}x{char.height}</span>
                      {char.matchConfidence !== undefined && (
                        <span style={{
                          color: char.matchConfidence >= 0.9 ? "#8f8" : (char.matchConfidence >= 0.7 ? "#fa8" : "#f88"),
                          marginLeft: 4,
                          fontSize: 9
                        }}>
                          {(char.matchConfidence * 100).toFixed(0)}%
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
              {selectedFontChar && (
                <div style={{ marginTop: 8, padding: 6, background: "#2a2a4a", borderRadius: 4 }}>
                  <div style={{ fontSize: 11, marginBottom: 4 }}>
                    Selected: <span style={{ color: "#aaf" }}>
                      ({selectedFontChar.screenX.toFixed(0)}, {selectedFontChar.screenY.toFixed(0)})
                    </span>
                    {" "}{selectedFontChar.width}x{selectedFontChar.height}
                  </div>
                  {selectedFontChar.pHashHex && (
                    <div style={{ fontSize: 10, color: "#a8a", marginBottom: 4 }}>
                      pHash: {selectedFontChar.pHashHex}
                    </div>
                  )}
                  {/* Jump to location button */}
                  <button
                    onClick={() => {
                      setViewOrigin({
                        x: selectedFontChar.screenX + selectedFontChar.width / 2,
                        y: selectedFontChar.screenY + selectedFontChar.height / 2,
                      });
                      setScale(3); // Zoom in
                    }}
                    style={{
                      padding: "6px 12px",
                      fontSize: 12,
                      background: "#5a5aaa",
                      color: "#fff",
                      border: "none",
                      borderRadius: 4,
                      cursor: "pointer",
                      marginBottom: 8,
                      width: "100%",
                    }}
                  >
                    Jump to Location
                  </button>

                  {/* Atlas position info */}
                  {selectedFontChar.atlasX !== undefined && (
                    <div style={{ fontSize: 10, color: "#88a", marginBottom: 4 }}>
                      Atlas: ({selectedFontChar.atlasX}, {selectedFontChar.atlasY}) | Size: {selectedFontChar.width}x{selectedFontChar.height}
                    </div>
                  )}

                  {/* Debug: Show all possible matches from font files */}
                  {fontCollectorRef.current && selectedFontChar.atlasX !== undefined && (
                    <details style={{ fontSize: 10, marginBottom: 8 }}>
                      <summary style={{ cursor: "pointer", color: "#aaa" }}>Debug: Possible matches</summary>
                      <div style={{ background: "#1a1a3a", padding: 4, borderRadius: 4, maxHeight: 100, overflow: "auto" }}>
                        {(() => {
                          const debug = fontCollectorRef.current!.debugCharacterMatch(selectedFontChar);
                          if (debug.possibleMatches.length === 0) {
                            return <div style={{ color: "#f88" }}>No font chars match size {debug.size}</div>;
                          }
                          // Group by offset
                          const byOffset = new Map<string, typeof debug.possibleMatches>();
                          for (const m of debug.possibleMatches) {
                            if (!byOffset.has(m.offset)) byOffset.set(m.offset, []);
                            byOffset.get(m.offset)!.push(m);
                          }
                          return Array.from(byOffset.entries()).map(([offset, matches]) => (
                            <div key={offset} style={{ marginBottom: 4 }}>
                              <div style={{ color: "#8af" }}>Offset {offset}:</div>
                              {matches.slice(0, 5).map((m, i) => (
                                <div key={i} style={{ color: "#8f8", paddingLeft: 8 }}>
                                  "{m.chr}" at {m.fontPos} ({m.fontName})
                                </div>
                              ))}
                              {matches.length > 5 && <div style={{ color: "#888", paddingLeft: 8 }}>...and {matches.length - 5} more</div>}
                            </div>
                          ));
                        })()}
                      </div>
                    </details>
                  )}

                  {/* Labeling UI */}
                  <div style={{
                    display: "flex",
                    gap: 4,
                    alignItems: "center",
                    background: "#2a2a4a",
                    padding: 8,
                    borderRadius: 4,
                    marginBottom: 8,
                  }}>
                    <span style={{ fontSize: 12, fontWeight: "bold" }}>Label:</span>
                    <input
                      type="text"
                      value={fontLabelInput}
                      onChange={(e) => setFontLabelInput(e.target.value)}
                      placeholder="?"
                      maxLength={1}
                      style={{
                        width: 40,
                        padding: "8px",
                        fontSize: 18,
                        fontWeight: "bold",
                        textAlign: "center",
                        background: "#1a1a3a",
                        color: "#fff",
                        border: "2px solid #5a5a8a",
                        borderRadius: 4,
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && fontLabelInput.length === 1) {
                          labelFontCharacter(selectedFontChar.hash, fontLabelInput);
                        }
                      }}
                      autoFocus
                    />
                    <button
                      onClick={() => labelFontCharacter(selectedFontChar.hash, fontLabelInput)}
                      disabled={fontLabelInput.length !== 1}
                      style={{
                        padding: "8px 16px",
                        fontSize: 12,
                        fontWeight: "bold",
                        background: fontLabelInput.length === 1 ? "#5aaa5a" : "#4a4a4a",
                        color: "#fff",
                        border: "none",
                        borderRadius: 4,
                        cursor: fontLabelInput.length === 1 ? "pointer" : "default",
                      }}
                    >
                      Set
                    </button>
                  </div>
                  <div style={{ fontSize: 10, color: "#888" }}>
                    Screen: ({selectedFontChar.screenX.toFixed(0)}, {selectedFontChar.screenY.toFixed(0)})
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        <div style={{ marginBottom: 10 }}>
          <label style={{ fontSize: 12 }}>
            <input
              type="checkbox"
              checked={state.showBorders}
              onChange={(e) => setState((s) => ({ ...s, showBorders: e.target.checked }))}
            />{" "}
            Show borders
          </label>
        </div>

        {/* Hide large elements filter (like map) */}
        <div style={{ marginBottom: 10 }}>
          <label style={{ fontSize: 12 }}>
            <input
              type="checkbox"
              checked={hideLargeElements}
              onChange={(e) => setHideLargeElements(e.target.checked)}
            />{" "}
            Hide large elements (map)
          </label>
          {hideLargeElements && (
            <div style={{ marginTop: 4, display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 11, color: "#aaa" }}>Max size:</span>
              <input
                type="range"
                min={50}
                max={1000}
                step={50}
                value={maxElementSize}
                onChange={(e) => setMaxElementSize(parseInt(e.target.value))}
                style={{ width: 80 }}
              />
              <span style={{ fontSize: 11, minWidth: 35 }}>{maxElementSize}px</span>
            </div>
          )}
        </div>

        {/* Filter slider */}
        <div style={{ marginBottom: 10 }}>
          <label style={{ fontSize: 12 }}>
            Filter: {state.filterStart} - {state.filterEnd === Infinity ? "∞" : state.filterEnd}
          </label>
          <div style={{ display: "flex", gap: 5 }}>
            <input
              type="range"
              min={0}
              max={state.elements.length}
              value={state.filterStart}
              onChange={(e) => setState((s) => ({ ...s, filterStart: parseInt(e.target.value) }))}
              style={{ flex: 1 }}
            />
            <input
              type="range"
              min={0}
              max={state.elements.length}
              value={Math.min(state.filterEnd, state.elements.length)}
              onChange={(e) => setState((s) => ({ ...s, filterEnd: parseInt(e.target.value) }))}
              style={{ flex: 1 }}
            />
          </div>
        </div>

        {/* Selected element info */}
        {sel && (
          <div style={{ marginBottom: 10, padding: 8, background: "#3a3a5a", borderRadius: 4 }}>
            <div style={{ fontWeight: "bold", marginBottom: 5 }}>
              Selected Element
              {elementsAtClick.length > 1 && (
                <span style={{ fontWeight: "normal", fontSize: 11, marginLeft: 5 }}>
                  ({clickIndex + 1}/{elementsAtClick.length} - Shift+click to cycle)
                </span>
              )}
            </div>
            <div style={{ fontSize: 12 }}>
              <div>ID: {sel.sprite?.known?.id ?? "unknown"}</div>
              <div>SubID: {sel.sprite?.known?.subid ?? "-"}</div>
              <div>Hash: {sel.sprite?.pixelhash ?? "-"}</div>
              {/* Show pHash - either from matched sprite or computed */}
              {(() => {
                // If already matched, show the matched pHash
                if (sel.sprite?.known?.pHash) {
                  return <div style={{ color: "#5c5" }}>pHash: {sel.sprite.known.pHash}</div>;
                }
                // Otherwise compute pHash for item-sized sprites (30-40px)
                if (sel.sprite && sel.sprite.width >= 20 && sel.sprite.width <= 50 &&
                    sel.sprite.height >= 20 && sel.sprite.height <= 50) {
                  try {
                    const imgData = sel.sprite.basetex.capture(
                      sel.sprite.x, sel.sprite.y, sel.sprite.width, sel.sprite.height
                    );
                    const computed = hashToHex(dHash(imgData.data, imgData.width, imgData.height));
                    return <div style={{ color: "#6af" }}>pHash: {computed} (computed)</div>;
                  } catch {
                    return null;
                  }
                }
                return null;
              })()}
              {sel.sprite?.known?.itemName && (
                <div style={{ color: "#5c5" }}>Item: {sel.sprite.known.itemName}</div>
              )}
              <div>Position: ({Math.round(sel.x)}, {Math.round(sel.y)})</div>
              <div>Size: {Math.round(sel.width)} × {Math.round(sel.height)}</div>
              {sel.sprite?.known?.fontchr && (
                <div>Font char: "{typeof sel.sprite.known.fontchr === 'string' ? sel.sprite.known.fontchr : sel.sprite.known.fontchr.chr}"</div>
              )}
            </div>
          </div>
        )}

        {/* Collected sprites */}
        <div style={{ marginBottom: 10, padding: 8, background: "#3a3a5a", borderRadius: 4 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 5 }}>
            <span style={{ fontWeight: "bold" }}>Collected ({state.collectedSprites.length})</span>
            <div>
              <button onClick={copyCollected} style={{ marginRight: 5, fontSize: 11 }}>
                Copy
              </button>
              <button
                onClick={() => setState((s) => ({ ...s, collectedSprites: [] }))}
                style={{ fontSize: 11 }}
              >
                Clear
              </button>
            </div>
          </div>
          <div style={{ fontSize: 11, maxHeight: 100, overflowY: "auto" }}>
            {state.collectedSprites.map((id, i) => (
              <div key={i} style={{ display: "flex", justifyContent: "space-between" }}>
                <span>{id}</span>
                <span
                  style={{ cursor: "pointer", color: "#f66" }}
                  onClick={() =>
                    setState((s) => ({
                      ...s,
                      collectedSprites: s.collectedSprites.filter((_, idx) => idx !== i),
                    }))
                  }
                >
                  ×
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Unique sprite IDs */}
        {state.elements.length > 0 && (
          <div style={{ padding: 8, background: "#3a3a5a", borderRadius: 4 }}>
            <div style={{ fontWeight: "bold", marginBottom: 5 }}>
              Unique Sprite IDs ({getUniqueSprites().length})
            </div>
            <div style={{ fontSize: 10, maxHeight: 200, overflowY: "auto" }}>
              {getUniqueSprites().map(({ id, count }) => (
                <div
                  key={id}
                  style={{
                    cursor: "pointer",
                    padding: "2px 4px",
                    background: sel?.sprite?.known?.id === id ? "#555" : "transparent",
                  }}
                  onClick={() => {
                    const el = state.elements.find((e) => e.sprite?.known?.id === id);
                    if (el) {
                      setState((s) => ({ ...s, selectedElement: el }));
                      setViewOrigin({ x: el.x + el.width / 2, y: el.y + el.height / 2 });
                    }
                  }}
                >
                  {id} ({count}×)
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Instructions */}
        <div style={{ marginTop: 10, fontSize: 11, color: "#888" }}>
          <p>• Open Quest Journal in RS3</p>
          <p>• Click Capture to record UI</p>
          <p>• Click elements to inspect</p>
          <p>• Shift+click to cycle overlapping</p>
          <p>• Ctrl+click to collect IDs</p>
          <p>• Scroll to zoom, drag to pan</p>
          <p>• Export JSON for unit tests</p>
          <p>• Test Detection to verify bounds</p>
        </div>

        {/* Pending Items - New items not yet in DB */}
        {pendingItems.size > 0 && (
          <div style={{ marginTop: 10, padding: 8, background: "#3a3a5a", borderRadius: 4 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
              <span style={{ fontWeight: "bold", fontSize: 12 }}>
                New Items ({pendingItems.size})
              </span>
              <button
                onClick={async () => {
                  // Get items with names
                  const itemsToSave = Array.from(pendingItems.values())
                    .filter(item => item.name && item.name.trim().length > 0);

                  if (itemsToSave.length === 0) {
                    console.log("[Items] No named items to save");
                    return;
                  }

                  setIsSaving(true);
                  try {
                    await saveItemHashesToApi(new Map(
                      itemsToSave.map(item => [item.pHash, item])
                    ));

                    // Move saved items to known, remove from pending
                    const newKnown = new Map(knownItems);
                    const newPending = new Map(pendingItems);
                    for (const item of itemsToSave) {
                      newKnown.set(item.pHash, item.name);
                      newPending.delete(item.pHash);
                    }
                    setKnownItems(newKnown);
                    setPendingItems(newPending);
                    console.log(`[Items] Saved ${itemsToSave.length} items to DB`);
                  } catch (err) {
                    console.error("[Items] Failed to save:", err);
                  } finally {
                    setIsSaving(false);
                  }
                }}
                disabled={isSaving}
                style={{
                  padding: "4px 12px",
                  background: isSaving ? "#555" : "#5c5",
                  color: "#000",
                  border: "none",
                  borderRadius: 4,
                  cursor: isSaving ? "not-allowed" : "pointer",
                  fontSize: 11,
                  fontWeight: "bold",
                }}
              >
                {isSaving ? "Saving..." : "Save"}
              </button>
            </div>
            <div style={{ maxHeight: 200, overflowY: "auto", fontSize: 11 }}>
              {Array.from(pendingItems.entries()).map(([key, item]) => {
                // Find matching element in current capture by position (within 5px tolerance)
                const matchingElement = state.elements.find(el =>
                  Math.abs(el.x - item.x) < 5 && Math.abs(el.y - item.y) < 5
                );
                const isInView = !!matchingElement;

                return (
                  <div
                    key={item.pHash}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 5,
                      padding: "4px",
                      borderBottom: "1px solid #555",
                      background: selectedItemHash === key
                        ? "#4a4a7a"
                        : "rgba(255, 200, 80, 0.15)",
                      borderLeft: "3px solid #fa0",
                    }}
                    onClick={() => {
                      setSelectedItemHash(key);
                      if (matchingElement) {
                        setState(s => ({ ...s, selectedElement: matchingElement }));
                      }
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "monospace",
                        color: "#fa0",
                        width: 80,
                        fontSize: 9,
                        flexShrink: 0,
                      }}
                      title={`pHash: ${item.pHash}`}
                    >
                      {isInView ? "●" : "○"} {item.pHash.substring(0, 6)}…
                    </span>
                    <input
                      type="text"
                      placeholder="Enter item name..."
                      value={item.name}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => {
                        const newPending = new Map(pendingItems);
                        newPending.set(key, { ...item, name: e.target.value });
                        setPendingItems(newPending);
                      }}
                      style={{
                        flex: 1,
                        padding: "2px 5px",
                        background: "#2a2a4a",
                        border: "1px solid #666",
                        borderRadius: 3,
                        color: "#fff",
                        fontSize: 11,
                        minWidth: 0,
                      }}
                    />
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        const newPending = new Map(pendingItems);
                        newPending.delete(key);
                        setPendingItems(newPending);
                      }}
                      style={{
                        padding: "2px 6px",
                        background: "#633",
                        color: "#faa",
                        border: "none",
                        borderRadius: 3,
                        cursor: "pointer",
                        fontSize: 10,
                        flexShrink: 0,
                      }}
                      title="Remove from list"
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>
            <div style={{ fontSize: 10, color: "#888", marginTop: 5 }}>
              ● In view • Name items and click Save
            </div>
          </div>
        )}

        {/* Known Items (already in DB) */}
        {knownItems.size > 0 && (
          <div style={{ marginTop: 10, padding: 8, background: "#3a3a5a", borderRadius: 4 }}>
            <div style={{ fontWeight: "bold", fontSize: 12, marginBottom: 5 }}>
              Known Items ({knownItems.size})
            </div>
            <div style={{ maxHeight: 100, overflowY: "auto", fontSize: 10, color: "#8f8" }}>
              {Array.from(knownItems.entries()).slice(0, 20).map(([pHash, name]) => (
                <div key={pHash} style={{ padding: "2px 0" }}>
                  <span style={{ fontFamily: "monospace", color: "#5c5" }}>
                    {pHash.substring(0, 8)}…
                  </span>
                  {" "}{name}
                </div>
              ))}
              {knownItems.size > 20 && (
                <div style={{ color: "#888" }}>...and {knownItems.size - 20} more</div>
              )}
            </div>
          </div>
        )}

        {/* pHash Lookup */}
        <div style={{ marginTop: 10, padding: 8, background: "#3a3a5a", borderRadius: 4 }}>
          <div style={{ fontWeight: "bold", marginBottom: 5, fontSize: 12 }}>
            pHash Lookup
          </div>
          <input
            type="text"
            placeholder="Enter pHash (16-char hex)..."
            style={{
              width: "100%",
              padding: 5,
              marginBottom: 5,
              background: "#2a2a4a",
              border: "1px solid #666",
              color: "#fff",
              borderRadius: 4,
              fontFamily: "monospace",
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const input = (e.target as HTMLInputElement).value.trim().toLowerCase();
                const spriteCache = spriteCacheRef.current;
                if (!spriteCache) {
                  console.log("[Lookup] Sprite cache not loaded");
                  return;
                }

                if (!/^[0-9a-f]{16}$/.test(input)) {
                  console.log("[Lookup] Invalid pHash format (must be 16 hex characters)");
                  return;
                }

                const match = spriteCache.findItemByPHash(input, 10);
                if (match) {
                  console.log(`[Lookup] pHash ${input} = "${match.name}" (distance: ${match.distance})`);
                } else {
                  console.log(`[Lookup] pHash ${input} not found`);
                }
              }
            }}
          />
          <div style={{ fontSize: 10, color: "#888" }}>
            Enter 16-character hex pHash
          </div>
        </div>

        {/* Image Hash Drop Zone */}
        <div
          onDrop={handleImageDrop}
          onDragOver={handleDragOver}
          style={{
            marginTop: 10,
            padding: 15,
            border: "2px dashed #666",
            borderRadius: 8,
            textAlign: "center",
            background: "#3a3a5a",
            cursor: "pointer",
          }}
        >
          <div style={{ fontSize: 12, marginBottom: 5 }}>
            Drop image here to compute hash
          </div>
          {droppedImageHash ? (
            <div style={{ fontSize: 11 }}>
              <div style={{ color: "#8f8" }}>✓ {droppedImageHash.name}</div>
              <div>Size: {droppedImageHash.size}</div>
              <div style={{
                fontFamily: "monospace",
                fontSize: 14,
                color: "#ff0",
                marginTop: 5,
                userSelect: "all",
              }}>
                Hash: {droppedImageHash.hash}
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 10, color: "#888" }}>
              PNG/JPG from Wiki
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default SpriteDiscovery;
