/**
 * FontCharacterCollector - Automatic font character collection utility
 *
 * Detects unknown font sprites from the game, groups them by their spritesheet,
 * and allows labeling them with the characters they represent.
 * Exports to JSON in the alt1gl CustomJsonFont format.
 *
 * Uses perceptual hashing (pHash) to auto-match unlabeled characters to labeled ones.
 */

import type { RenderRect } from './GLBridgeAdapter';
import type { RenderRect as RS3RenderRect } from '../gl/injection/reflect2d/reflect2d';
import { fontHash, hashToHex, hexToHash, hammingDistance } from '../gl/injection/util/phash';
import type { SpriteCache, SpriteInfo } from '../gl/injection/reflect2d/spritecache';

/**
 * Font character data matching alt1gl format
 */
export interface FontCharacterData {
  chr: string;
  charcode: number;
  x: number;
  y: number;
  width: number;
  height: number;
  hash: number;
  bearingy: number;
  // Atlas position for 100% accurate matching across sessions
  atlasX?: number;
  atlasY?: number;
}

/**
 * Unknown character (position known, character unknown)
 */
export interface UnknownCharacter {
  x: number;
  y: number;
  width: number;
  height: number;
  hash: number;
  charcode?: number;  // Set when labeled
}

/**
 * Font sheet data matching alt1gl CustomJsonFont format
 */
export interface FontSheetData {
  sheetwidth: number;
  sheetheight: number;
  sheethash: number;
  spriteid: number;
  characters: FontCharacterData[];
  unknownchars: { x: number; y: number; charcode: number }[];
}

/**
 * Collected character with metadata
 */
export interface CollectedCharacter {
  // Sprite info
  hash: number;
  width: number;
  height: number;

  // Screen position when collected
  screenX: number;
  screenY: number;

  // Atlas position (for cascade matching)
  atlasX?: number;
  atlasY?: number;
  atlasRegion?: string;  // Identifier for the atlas region/font sheet

  // Character info (set when labeled)
  chr?: string;
  charcode?: number;

  // Perceptual hash for auto-matching
  pHash?: bigint;
  pHashHex?: string;

  // Metadata
  collectedAt: number;
  color?: number[];  // ABGR color

  // Size group for grouping similar characters
  sizeKey: string;

  // Confidence of auto-match (0-1, only set if auto-matched)
  matchConfidence?: number;
}

/**
 * Character group (represents a font/spritesheet by size)
 */
export interface CharacterGroup {
  id: string;
  name: string;
  sizeKey: string;
  characters: CollectedCharacter[];
}

/**
 * Interface for providing render data
 */
export interface FontCollectorDataProvider {
  getElements(): RenderRect[];
}

/**
 * FontCharacterCollector - Collects and manages font characters
 */
export class FontCharacterCollector {
  private collectedCharacters: Map<number, CollectedCharacter> = new Map(); // keyed by hash
  private groups: Map<string, CharacterGroup> = new Map();
  private listeners: Set<(char: CollectedCharacter) => void> = new Set();
  private dataProvider: FontCollectorDataProvider | null = null;
  private spriteCache: SpriteCache | null = null;

  // Maximum dimensions for font characters
  private readonly MAX_FONT_WIDTH = 16;
  private readonly MAX_FONT_HEIGHT = 16;

  // Debug logging flags (to avoid spam)
  private loggedNoBastex = false;
  private loggedCannotCapture = false;
  private loggedDebugInfo = false;
  private loggedEmptyCapture = false;
  private loggedCaptureError = false;
  private loggedNotRS3 = false;
  private loggedImageDebug = false;
  private loggedZeroPHash = false;
  private loggedSpriteCacheLookup = false;

  constructor(dataProvider?: FontCollectorDataProvider, spriteCache?: SpriteCache) {
    this.dataProvider = dataProvider ?? null;
    this.spriteCache = spriteCache ?? null;
  }

  /**
   * Set the sprite cache for automatic character recognition
   */
  setSpriteCache(spriteCache: SpriteCache): void {
    this.spriteCache = spriteCache;
    console.log('[FontCollector] SpriteCache set - will use for auto-recognition');
  }

  /**
   * FULLY AUTOMATIC font matching - no manual labeling needed!
   *
   * How it works:
   * 1. Group scanned chars by atlas region (chars from same font are usually close together)
   * 2. For each region, try to match against font files
   * 3. Use strict matching: EXACT size match required
   * 4. Require high vote count to avoid false positives
   *
   * @returns Number of characters matched
   */
  autoLabelByFontSheetDetection(): number {
    if (!this.spriteCache) {
      console.log('[FontCollector] No SpriteCache available');
      return 0;
    }

    // Get all unlabeled chars with atlas positions
    const unlabeled = this.getUnlabeledCharacters().filter(
      c => c.atlasX !== undefined && c.atlasY !== undefined
    );

    if (unlabeled.length === 0) {
      console.log('[FontCollector] No unlabeled characters with atlas positions');
      return 0;
    }

    console.log(`[FontCollector] Auto-detecting font sheets for ${unlabeled.length} characters...`);

    // Group unlabeled by atlas region
    const byRegion = new Map<string, CollectedCharacter[]>();
    for (const char of unlabeled) {
      const region = char.atlasRegion || 'unknown';
      if (!byRegion.has(region)) byRegion.set(region, []);
      byRegion.get(region)!.push(char);
    }

    let totalMatched = 0;

    // Process each region separately
    for (const [region, regionChars] of byRegion) {
      if (regionChars.length < 5) continue; // Need enough chars to detect pattern

      console.log(`[FontCollector] Processing region ${region} with ${regionChars.length} chars`);

      // Try each font in the sprite cache
      for (const font of (this.spriteCache as any).fonts.values()) {
        if (!font.subs || font.subs.size === 0) continue;

        // Build a map of EXACT (width, height) -> list of font characters
        const fontCharsBySize = new Map<string, Array<{ x: number; y: number; chr: string; charcode: number; width: number; height: number }>>();

        // Also build a position lookup for exact matching: "x,y,w,h" -> fontChar
        const fontCharsByPosition = new Map<string, { x: number; y: number; chr: string; charcode: number; width: number; height: number }>();

        for (const sub of font.subs.values()) {
          if (!sub.fontchr) continue;
          const fc = sub.fontchr;
          const sizeKey = `${fc.width}_${fc.height}`; // EXACT size key
          if (!fontCharsBySize.has(sizeKey)) {
            fontCharsBySize.set(sizeKey, []);
          }
          fontCharsBySize.get(sizeKey)!.push(fc);

          // Position key for direct lookup
          const posKey = `${fc.x},${fc.y},${fc.width},${fc.height}`;
          fontCharsByPosition.set(posKey, fc);
        }

        // PHASE 1: Vote for offset using only size matching
        const offsetVotes = new Map<string, number>();

        for (const char of regionChars) {
          if (char.chr !== undefined) continue;

          const sizeKey = `${char.width}_${char.height}`; // EXACT size match
          const candidates = fontCharsBySize.get(sizeKey);

          if (!candidates) continue;

          // Each candidate suggests a potential offset
          for (const fc of candidates) {
            const offsetX = char.atlasX! - fc.x;
            const offsetY = char.atlasY! - fc.y;
            const key = `${offsetX},${offsetY}`;

            offsetVotes.set(key, (offsetVotes.get(key) || 0) + 1);
          }
        }

        // Find the offset with the most votes - require at least 10 or 30% of chars
        const minVotes = Math.max(10, Math.floor(regionChars.length * 0.3));
        let bestOffset: { x: number; y: number } | null = null;
        let bestVotes = 0;

        for (const [key, count] of offsetVotes) {
          if (count > bestVotes && count >= minVotes) {
            bestVotes = count;
            const [x, y] = key.split(',').map(Number);
            bestOffset = { x, y };
          }
        }

        if (!bestOffset) continue;

        console.log(`[FontCollector] Found font sheet at offset (${bestOffset.x}, ${bestOffset.y}) with ${bestVotes} votes (min required: ${minVotes})`);

        // PHASE 2: Now that we have the offset, look up EACH character by its exact position
        let regionMatches = 0;
        for (const char of regionChars) {
          if (char.chr !== undefined) continue; // Already labeled

          // Calculate this character's position in the font sheet
          const fontX = char.atlasX! - bestOffset.x;
          const fontY = char.atlasY! - bestOffset.y;

          // Look up by EXACT position and size
          const posKey = `${fontX},${fontY},${char.width},${char.height}`;
          const matchedFc = fontCharsByPosition.get(posKey);

          if (matchedFc) {
            char.chr = matchedFc.chr;
            char.charcode = matchedFc.charcode;
            char.matchConfidence = 1.0;
            totalMatched++;
            regionMatches++;

            console.log(`[FontCollector] Matched "${matchedFc.chr}" (${matchedFc.width}x${matchedFc.height}) at font pos (${fontX}, ${fontY})`);
          } else {
            // Try with ±1 tolerance on position (but still exact size)
            for (let dx = -1; dx <= 1; dx++) {
              for (let dy = -1; dy <= 1; dy++) {
                if (dx === 0 && dy === 0) continue; // Already tried exact
                const fuzzyKey = `${fontX + dx},${fontY + dy},${char.width},${char.height}`;
                const fuzzyMatch = fontCharsByPosition.get(fuzzyKey);
                if (fuzzyMatch) {
                  char.chr = fuzzyMatch.chr;
                  char.charcode = fuzzyMatch.charcode;
                  char.matchConfidence = 0.99; // Slightly lower since position was off by 1
                  totalMatched++;
                  regionMatches++;
                  console.log(`[FontCollector] Fuzzy matched "${fuzzyMatch.chr}" (±1 pos) at font pos (${fontX + dx}, ${fontY + dy})`);
                  break;
                }
              }
              if (char.chr !== undefined) break;
            }
          }
        }

        // If we found matches for this region, stop trying other fonts
        if (regionMatches > 0) {
          console.log(`[FontCollector] Region ${region} matched ${regionMatches} chars with this font`);
          break;
        }
      }
    }

    console.log(`[FontCollector] Auto font sheet detection matched ${totalMatched} characters`);
    return totalMatched;
  }

  /**
   * Match characters using font file data from SpriteCache
   * This is the most accurate method when we have an anchor character.
   *
   * How it works:
   * 1. Take a labeled character as anchor
   * 2. Find which font sheet it belongs to (by looking up its chr in font data)
   * 3. Calculate the font sheet offset in atlas: offsetX = atlasX - fontChr.x
   * 4. For each unlabeled character, calculate its position in font sheet
   * 5. Look up that position in font data to identify the character
   *
   * @returns Number of characters matched
   */
  autoLabelByFontFileData(): number {
    if (!this.spriteCache) {
      console.log('[FontCollector] No SpriteCache available for font file matching');
      return 0;
    }

    // Get labeled chars with atlas positions (anchors)
    const anchors = this.getLabeledCharacters().filter(
      c => c.atlasX !== undefined && c.atlasY !== undefined && c.chr
    );

    if (anchors.length === 0) {
      console.log('[FontCollector] No labeled anchors with atlas positions');
      return 0;
    }

    // Get unlabeled chars with atlas positions
    const unlabeled = this.getUnlabeledCharacters().filter(
      c => c.atlasX !== undefined && c.atlasY !== undefined
    );

    if (unlabeled.length === 0) {
      return 0;
    }

    console.log(`[FontCollector] Font file matching: ${anchors.length} anchors, ${unlabeled.length} unlabeled`);

    let matched = 0;

    // For each anchor, try to find its font sheet and match others
    for (const anchor of anchors) {
      // Look up this character in the font data
      const anchorFontInfo = this.findCharInFontFiles(anchor.chr!, anchor.width, anchor.height);
      if (!anchorFontInfo) {
        continue;
      }

      const { font, fontChr } = anchorFontInfo;

      // Calculate font sheet offset in atlas
      const offsetX = anchor.atlasX! - fontChr.x;
      const offsetY = anchor.atlasY! - fontChr.y;

      console.log(`[FontCollector] Found anchor "${anchor.chr}" in font sheet, offset: (${offsetX}, ${offsetY})`);

      // Try to match unlabeled characters using this offset
      for (const unknown of unlabeled) {
        if (unknown.chr !== undefined) continue; // already labeled

        // Calculate this character's position in the font sheet
        const fontX = unknown.atlasX! - offsetX;
        const fontY = unknown.atlasY! - offsetY;

        // Look up this position in the font data
        const matchedChar = this.findCharAtPosition(font, fontX, fontY, unknown.width, unknown.height);
        if (matchedChar) {
          unknown.chr = matchedChar.chr;
          unknown.charcode = matchedChar.charcode;
          unknown.matchConfidence = 1.0; // 100% confident - exact position match

          matched++;
          console.log(`[FontCollector] Font file match: "${matchedChar.chr}" at font position (${fontX}, ${fontY})`);
        }
      }
    }

    console.log(`[FontCollector] Font file matching labeled ${matched} characters`);
    return matched;
  }

  /**
   * Find a character in the sprite cache font files
   */
  private findCharInFontFiles(chr: string, width: number, height: number): {
    font: any; // KnownSpriteSheet
    fontChr: { x: number; y: number; width: number; height: number; chr: string; charcode: number };
  } | null {
    if (!this.spriteCache) return null;

    // Iterate through all fonts in spriteCache
    for (const font of (this.spriteCache as any).fonts.values()) {
      for (const sub of font.subs.values()) {
        if (!sub.fontchr) continue;
        const fc = sub.fontchr;
        // Match by character and similar size
        if (fc.chr === chr && Math.abs(fc.width - width) <= 1 && Math.abs(fc.height - height) <= 1) {
          return { font, fontChr: fc };
        }
      }
    }
    return null;
  }

  /**
   * Find a character at a specific position in a font sheet
   */
  private findCharAtPosition(
    font: any, // KnownSpriteSheet
    x: number,
    y: number,
    width: number,
    height: number
  ): { chr: string; charcode: number } | null {
    for (const sub of font.subs.values()) {
      if (!sub.fontchr) continue;
      const fc = sub.fontchr;
      // Match by position (with small tolerance) and similar size
      if (
        Math.abs(fc.x - x) <= 2 &&
        Math.abs(fc.y - y) <= 2 &&
        Math.abs(fc.width - width) <= 1 &&
        Math.abs(fc.height - height) <= 1
      ) {
        return { chr: fc.chr, charcode: fc.charcode };
      }
    }
    return null;
  }

  /**
   * Set the data provider for getting render elements
   */
  setDataProvider(provider: FontCollectorDataProvider): void {
    this.dataProvider = provider;
  }

  /**
   * Scan elements for unknown font characters
   * Can be called directly with elements or will use data provider
   * Accepts either simplified RenderRect or raw RS3RenderRect (with basetex for pHash)
   */
  scanForCharacters(elements?: RenderRect[] | RS3RenderRect[]): CollectedCharacter[] {
    const els = elements ?? this.dataProvider?.getElements() ?? [];
    const newCharacters: CollectedCharacter[] = [];

    for (const el of els) {
      // Handle both simplified and raw RS3 types
      // Debug: Check what kind of element we got
      const hasSprite = 'sprite' in el;
      const spriteObj = hasSprite ? (el as any).sprite : null;
      const hasBastex = spriteObj && 'basetex' in spriteObj;
      const isRS3Rect = hasSprite && hasBastex;
      const rs3El = isRS3Rect ? el as RS3RenderRect : null;

      // Log first element's structure for debugging
      if (!this.loggedDebugInfo) {
        console.log('[FontCollector] First element debug:', {
          hasSprite,
          hasBastex,
          isRS3Rect,
          spriteKeys: spriteObj ? Object.keys(spriteObj) : 'no sprite',
          elementKeys: Object.keys(el),
        });
        this.loggedDebugInfo = true;
      }

      // Get sprite info - handle both formats
      const spriteHash = isRS3Rect
        ? rs3El!.sprite.pixelhash
        : (el as RenderRect).sprite.hash;
      const spriteKnown = isRS3Rect
        ? rs3El!.sprite.known
        : (el as RenderRect).sprite.known;

      // Skip if already known sprite (but not font characters)
      if (spriteKnown && !(spriteKnown as any).fontchr) {
        continue;
      }

      // Check if it looks like a font character (small size)
      if (el.width > this.MAX_FONT_WIDTH || el.height > this.MAX_FONT_HEIGHT) {
        continue;
      }

      // Skip very small or invalid
      if (el.width < 1 || el.height < 1) {
        continue;
      }

      // Skip UI elements based on color - font characters are typically white/gray/yellow text
      // Solid red, green, blue UI elements are not font characters
      const color = el.color as number[];
      if (color && color.length >= 4) {
        const [a, b, g, r] = color; // ABGR format

        // Skip if very saturated solid colors (UI elements, not text)
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const saturation = max > 0 ? (max - min) / max : 0;

        // Pure red, green, blue UI elements (saturation > 0.7 and one channel dominates)
        if (saturation > 0.7 && max > 150) {
          // Check if it's a highly saturated color (like pure red/green/blue UI)
          const isRedDominant = r > g + 50 && r > b + 50;
          const isGreenDominant = g > r + 50 && g > b + 50;
          const isBlueDominant = b > r + 50 && b > g + 50;

          if (isRedDominant || isGreenDominant || isBlueDominant) {
            // This looks like a colored UI element, not a font character
            continue;
          }
        }
      }

      const hash = spriteHash;

      // Skip if already collected
      if (this.collectedCharacters.has(hash)) {
        continue;
      }

      const sizeKey = `${el.width}x${el.height}`;

      // Try to compute pHash if we have access to texture data
      let pHashValue: bigint | undefined;
      let pHashHexValue: string | undefined;

      if (rs3El) {
        const sprite = rs3El.sprite;
        const basetex = sprite?.basetex;

        if (!basetex) {
          // Only log once per session to avoid spam
          if (!this.loggedNoBastex) {
            console.log('[FontCollector] No basetex available for pHash computation');
            console.log('[FontCollector] sprite:', sprite);
            this.loggedNoBastex = true;
          }
        } else {
          try {
            // Check if texture can be captured
            const canCapture = typeof basetex.canCapture === 'function' ? basetex.canCapture() : true;

            if (canCapture) {
              const imgData = basetex.capture(
                sprite.x,
                sprite.y,
                sprite.width,
                sprite.height
              );
              if (imgData && imgData.data && imgData.data.length > 0) {
                // Check if image has actual content and looks like a font character
                let hasContent = false;
                let nonZeroPixels = 0;
                let transparentPixels = 0;
                let partialAlphaPixels = 0;
                const totalPixels = imgData.data.length / 4;

                for (let i = 3; i < imgData.data.length; i += 4) {
                  const alpha = imgData.data[i];
                  if (alpha > 0) {
                    hasContent = true;
                    nonZeroPixels++;
                    if (alpha < 250) partialAlphaPixels++;
                  } else {
                    transparentPixels++;
                  }
                }

                // Font characters typically have a mix of transparent and opaque pixels
                // Solid fills (like UI elements) are either all opaque or all transparent
                const opaqueRatio = nonZeroPixels / totalPixels;
                const hasAlphaVariation = transparentPixels > 0 && nonZeroPixels > 0;
                const isSolidFill = opaqueRatio > 0.95 || opaqueRatio < 0.05;

                // Skip if it looks like a solid fill (not a font character)
                if (isSolidFill && !hasAlphaVariation) {
                  continue;
                }

                if (!this.loggedImageDebug) {
                  console.log('[FontCollector] Capture debug:', {
                    atlasPos: { x: sprite.x, y: sprite.y },
                    size: { w: sprite.width, h: sprite.height },
                    dataLength: imgData.data.length,
                    hasContent,
                    nonZeroPixels,
                    transparentPixels,
                    opaqueRatio: opaqueRatio.toFixed(2),
                    totalPixels,
                    samplePixels: [
                      imgData.data.slice(0, 4),
                      imgData.data.slice(4, 8),
                      imgData.data.slice(8, 12),
                    ]
                  });
                  this.loggedImageDebug = true;
                }

                pHashValue = fontHash(imgData.data, imgData.width, imgData.height);
                pHashHexValue = hashToHex(pHashValue);

                // Skip elements with pHash=0 - these are typically solid/empty UI elements, not characters
                if (pHashValue === 0n) {
                  if (!this.loggedZeroPHash) {
                    console.log('[FontCollector] Skipping element with pHash=0 (likely UI element, not character)', {
                      size: `${imgData.width}x${imgData.height}`,
                      opaqueRatio: opaqueRatio.toFixed(2)
                    });
                    this.loggedZeroPHash = true;
                  }
                  continue;
                }
              } else {
                if (!this.loggedEmptyCapture) {
                  console.warn('[FontCollector] capture returned empty data for', sprite.x, sprite.y, sprite.width, sprite.height);
                  this.loggedEmptyCapture = true;
                }
              }
            } else {
              if (!this.loggedCannotCapture) {
                console.log('[FontCollector] basetex.canCapture() returned false');
                this.loggedCannotCapture = true;
              }
            }
          } catch (e) {
            // Log capture failures for debugging
            if (!this.loggedCaptureError) {
              console.warn('[FontCollector] pHash capture failed:', e);
              this.loggedCaptureError = true;
            }
          }
        }
      } else {
        // Element is not RS3 format
        if (!this.loggedNotRS3) {
          console.log('[FontCollector] Element not RS3RenderRect - pHash not available');
          console.log('[FontCollector] Element sprite keys:', spriteObj ? Object.keys(spriteObj) : 'no sprite');
          this.loggedNotRS3 = true;
        }
      }

      // Check for fontchr in both formats
      const fontchrData = isRS3Rect
        ? (spriteKnown as any)?.fontchr
        : (spriteKnown as any)?.fontchr;

      // Get atlas position for cascade matching
      const atlasX = rs3El?.sprite?.x;
      const atlasY = rs3El?.sprite?.y;
      // Group into 256x256 regions for cascade matching
      const atlasRegion = (atlasX !== undefined && atlasY !== undefined)
        ? `${Math.floor(atlasX / 256)}_${Math.floor(atlasY / 256)}`
        : undefined;

      // If it has fontchr, it's a known character - extract info
      if (fontchrData) {
        // fontchr can be string or object with chr property
        const chr = typeof fontchrData === 'string'
          ? fontchrData
          : fontchrData.chr || String(fontchrData);
        const charcode = chr.charCodeAt(0);

        const collected: CollectedCharacter = {
          hash,
          width: el.width,
          height: el.height,
          screenX: el.x,
          screenY: el.y,
          atlasX,
          atlasY,
          atlasRegion,
          chr,
          charcode,
          pHash: pHashValue,
          pHashHex: pHashHexValue,
          collectedAt: Date.now(),
          color: el.color as number[],
          sizeKey,
        };

        this.collectedCharacters.set(hash, collected);
        newCharacters.push(collected);
        this.notifyListeners(collected);
        continue;
      }

      // Try to find character in SpriteCache by hash
      if (this.spriteCache) {
        // Log cache size once
        if (!this.loggedSpriteCacheLookup) {
          console.log(`[FontCollector] SpriteCache has ${this.spriteCache.hashes.size} hashes`);
          // Sample some entries to see what's there
          let sample = 0;
          for (const [h, sprite] of this.spriteCache.hashes) {
            if (sprite.fontchr) {
              console.log(`  Sample: hash=${h} chr="${sprite.fontchr.chr}"`);
              if (++sample >= 5) break;
            }
          }
          this.loggedSpriteCacheLookup = true;
        }

        const cachedSprite = this.spriteCache.hashes.get(hash);
        if (cachedSprite?.fontchr) {
          const fontchr = cachedSprite.fontchr;
          const chr = fontchr.chr;
          const charcode = fontchr.charcode;

          console.log('[FontCollector] Auto-labeled from SpriteCache:', chr, `(hash: ${hash})`);

          const collected: CollectedCharacter = {
            hash,
            width: el.width,
            height: el.height,
            screenX: el.x,
            screenY: el.y,
            atlasX,
            atlasY,
            atlasRegion,
            chr,
            charcode,
            pHash: pHashValue,
            pHashHex: pHashHexValue,
            collectedAt: Date.now(),
            color: el.color as number[],
            sizeKey,
            matchConfidence: 1.0, // From sprite cache = exact match
          };

          this.collectedCharacters.set(hash, collected);
          newCharacters.push(collected);
          this.notifyListeners(collected);
          continue;
        }
      }

      // Unknown character - collect it
      const collected: CollectedCharacter = {
        hash,
        width: el.width,
        height: el.height,
        screenX: el.x,
        screenY: el.y,
        atlasX,
        atlasY,
        atlasRegion,
        pHash: pHashValue,
        pHashHex: pHashHexValue,
        collectedAt: Date.now(),
        color: el.color as number[],
        sizeKey,
      };

      this.collectedCharacters.set(hash, collected);
      newCharacters.push(collected);
      this.notifyListeners(collected);
    }

    return newCharacters;
  }

  /**
   * Label a character by its hash
   */
  labelCharacter(hash: number, chr: string): boolean {
    const collected = this.collectedCharacters.get(hash);
    if (!collected) return false;

    collected.chr = chr;
    collected.charcode = chr.charCodeAt(0);
    return true;
  }

  /**
   * Label multiple characters at once
   */
  labelCharacters(labels: { hash: number; chr: string }[]): number {
    let count = 0;
    for (const { hash, chr } of labels) {
      if (this.labelCharacter(hash, chr)) {
        count++;
      }
    }
    return count;
  }

  /**
   * Create atlas key from position - uniquely identifies a character in the atlas
   * Same atlas position = same character (100% accurate)
   */
  private getAtlasKey(char: CollectedCharacter): string | null {
    if (char.atlasX === undefined || char.atlasY === undefined) {
      return null;
    }
    // Include size to handle edge cases where different sized chars overlap
    return `${char.atlasX}_${char.atlasY}_${char.width}_${char.height}`;
  }

  /**
   * Auto-label unlabeled characters by matching their exact atlas position
   * This is 100% accurate - same atlas position = same character
   * @returns Array of auto-labeled characters with their matches
   */
  autoLabelByAtlasPosition(): Array<{
    unlabeled: CollectedCharacter;
    matchedTo: CollectedCharacter;
  }> {
    const labeled = this.getLabeledCharacters().filter(c => c.atlasX !== undefined);
    const unlabeled = this.getUnlabeledCharacters().filter(c => c.atlasX !== undefined);

    // Build lookup map: atlasKey -> labeled character
    const labeledByAtlasKey = new Map<string, CollectedCharacter>();
    for (const char of labeled) {
      const key = this.getAtlasKey(char);
      if (key) {
        labeledByAtlasKey.set(key, char);
      }
    }

    console.log(`[FontCollector] Atlas matching: ${labeled.length} labeled with atlas pos, ${unlabeled.length} unlabeled, ${labeledByAtlasKey.size} unique atlas positions`);

    const matches: Array<{
      unlabeled: CollectedCharacter;
      matchedTo: CollectedCharacter;
    }> = [];

    for (const unknown of unlabeled) {
      const key = this.getAtlasKey(unknown);
      if (!key) continue;

      const match = labeledByAtlasKey.get(key);
      if (match) {
        // Exact match! Same atlas position = same character
        unknown.chr = match.chr;
        unknown.charcode = match.charcode;
        unknown.matchConfidence = 1.0; // 100% confident - exact atlas match

        matches.push({
          unlabeled: unknown,
          matchedTo: match,
        });

        console.log(`[FontCollector] Atlas match: "${match.chr}" at (${unknown.atlasX}, ${unknown.atlasY})`);
      }
    }

    console.log(`[FontCollector] Atlas matching labeled ${matches.length} characters (100% accurate)`);
    return matches;
  }

  /**
   * Match characters by relative atlas position
   * Uses labeled characters as anchors to identify others based on spacing
   *
   * The idea: if char A is at atlasX=100 and char B is at atlasX=110,
   * and we know A is "x" and the font has "x" at x=50 and "y" at x=60,
   * then B is likely "y" because the 10px offset matches.
   *
   * This is 100% accurate when we have the correct anchor.
   */
  autoLabelByRelativePosition(): Array<{
    unlabeled: CollectedCharacter;
    matchedTo: CollectedCharacter;
    inferred: string;
  }> {
    // Get labeled chars with atlas positions (these are our anchors)
    const anchors = this.getLabeledCharacters().filter(
      c => c.atlasX !== undefined && c.atlasY !== undefined
    );

    // Get unlabeled chars with atlas positions
    const unlabeled = this.getUnlabeledCharacters().filter(
      c => c.atlasX !== undefined && c.atlasY !== undefined
    );

    if (anchors.length === 0 || unlabeled.length === 0) {
      return [];
    }

    console.log(`[FontCollector] Relative position matching: ${anchors.length} anchors, ${unlabeled.length} unlabeled`);

    // Group anchors by atlas region (characters in same font are usually nearby)
    const anchorsByRegion = new Map<string, CollectedCharacter[]>();
    for (const anchor of anchors) {
      const region = anchor.atlasRegion || 'unknown';
      if (!anchorsByRegion.has(region)) {
        anchorsByRegion.set(region, []);
      }
      anchorsByRegion.get(region)!.push(anchor);
    }

    const matches: Array<{
      unlabeled: CollectedCharacter;
      matchedTo: CollectedCharacter;
      inferred: string;
    }> = [];

    // For each unlabeled character, find the closest anchor and use relative position
    for (const unknown of unlabeled) {
      const region = unknown.atlasRegion || 'unknown';
      const regionAnchors = anchorsByRegion.get(region) || [];

      if (regionAnchors.length === 0) continue;

      // Find all anchors on the same Y line (same row in font sheet)
      const sameRowAnchors = regionAnchors.filter(
        a => Math.abs(a.atlasY! - unknown.atlasY!) < 3 // within 3 pixels vertically
      );

      if (sameRowAnchors.length === 0) continue;

      // Sort by X position
      sameRowAnchors.sort((a, b) => a.atlasX! - b.atlasX!);

      // Find the closest anchor by X position
      let closestAnchor: CollectedCharacter | null = null;
      let closestDistance = Infinity;

      for (const anchor of sameRowAnchors) {
        const distance = Math.abs(anchor.atlasX! - unknown.atlasX!);
        if (distance < closestDistance) {
          closestDistance = distance;
          closestAnchor = anchor;
        }
      }

      if (!closestAnchor || closestDistance > 50) continue; // too far apart

      // Calculate the X offset from anchor to unknown
      const xOffset = unknown.atlasX! - closestAnchor.atlasX!;

      // Get the anchor's character code
      const anchorCharCode = closestAnchor.charcode!;

      // Try to infer the character based on sequential ordering
      // In most fonts, characters are laid out sequentially by charcode
      // So if anchor is 'a' and unknown is 10px to the right, it might be 'b' or 'c'

      // Calculate expected character offset based on typical character width
      const avgCharWidth = closestAnchor.width + 2; // character width + spacing
      const charOffset = Math.round(xOffset / avgCharWidth);

      if (charOffset === 0) continue; // same position as anchor, skip

      // Infer the character code
      const inferredCharCode = anchorCharCode + charOffset;

      // Validate the inferred character is reasonable (printable ASCII)
      if (inferredCharCode < 32 || inferredCharCode > 126) continue;

      const inferredChr = String.fromCharCode(inferredCharCode);

      // Check if this inference is consistent with the character's size
      // (e.g., 'i' should be narrower than 'm')
      const expectedWidth = this.getExpectedWidthForChar(inferredChr, closestAnchor.width);
      if (Math.abs(unknown.width - expectedWidth) > 3) {
        // Width doesn't match expected, might be wrong inference
        continue;
      }

      // Apply the label
      unknown.chr = inferredChr;
      unknown.charcode = inferredCharCode;
      unknown.matchConfidence = 0.9; // High but not 100% since it's inferred

      matches.push({
        unlabeled: unknown,
        matchedTo: closestAnchor,
        inferred: inferredChr,
      });

      console.log(`[FontCollector] Relative match: "${inferredChr}" (offset ${charOffset} from "${closestAnchor.chr}")`);
    }

    console.log(`[FontCollector] Relative position matched ${matches.length} characters`);
    return matches;
  }

  /**
   * Get expected width for a character based on an anchor width
   * Some characters are known to be narrow (i, l, 1) or wide (m, w)
   */
  private getExpectedWidthForChar(chr: string, anchorWidth: number): number {
    const narrowChars = 'il1!|\'.:;,';
    const wideChars = 'mwMW@';
    const normalChars = 'abcdefghjknopqrstuvxyzABCDEFGHJKLNOPQRSTUVXYZ0234567890';

    if (narrowChars.includes(chr)) {
      return Math.max(2, anchorWidth * 0.5);
    } else if (wideChars.includes(chr)) {
      return anchorWidth * 1.5;
    } else {
      return anchorWidth; // similar to anchor
    }
  }

  /**
   * Auto-label unlabeled characters by matching their pHash to labeled characters
   * @param threshold - Maximum Hamming distance for matching (default: 5, lower = stricter)
   * @returns Array of auto-labeled characters with their matches
   */
  autoLabelByPHash(threshold: number = 5): Array<{
    unlabeled: CollectedCharacter;
    matchedTo: CollectedCharacter;
    distance: number;
  }> {
    const labeled = this.getLabeledCharacters().filter(c => c.pHash !== undefined);
    const unlabeled = this.getUnlabeledCharacters().filter(c => c.pHash !== undefined);

    console.log(`[FontCollector] Auto-label: ${labeled.length} labeled with pHash, ${unlabeled.length} unlabeled with pHash, threshold=${threshold}`);

    // Group labeled by size for efficient lookup
    const labeledBySize = new Map<string, CollectedCharacter[]>();
    for (const char of labeled) {
      if (!labeledBySize.has(char.sizeKey)) {
        labeledBySize.set(char.sizeKey, []);
      }
      labeledBySize.get(char.sizeKey)!.push(char);
    }

    // Log size coverage
    const unlabeledSizes = new Set(unlabeled.map(c => c.sizeKey));
    const missingSizes: string[] = [];
    for (const size of unlabeledSizes) {
      if (!labeledBySize.has(size) || labeledBySize.get(size)!.length === 0) {
        missingSizes.push(size);
      }
    }
    if (missingSizes.length > 0) {
      console.log(`[FontCollector] Missing labeled chars for sizes: ${missingSizes.join(', ')}`);
    }

    const matches: Array<{
      unlabeled: CollectedCharacter;
      matchedTo: CollectedCharacter;
      distance: number;
    }> = [];

    // Track closest non-matching for feedback
    let closestNonMatch: { char: CollectedCharacter; distance: number; match: CollectedCharacter } | null = null;

    for (const unknown of unlabeled) {
      if (!unknown.pHash) continue;

      const sameSize = labeledBySize.get(unknown.sizeKey) || [];
      if (sameSize.length === 0) continue;

      let bestMatch: CollectedCharacter | null = null;
      let bestDistance = Infinity;

      // Find closest match among labeled characters of same size
      for (const known of sameSize) {
        if (!known.pHash || !known.chr) continue;

        const distance = hammingDistance(unknown.pHash, known.pHash);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestMatch = known;
        }
      }

      if (bestMatch) {
        if (bestDistance <= threshold) {
          // Auto-label the character
          unknown.chr = bestMatch.chr;
          unknown.charcode = bestMatch.charcode;
          unknown.matchConfidence = 1 - (bestDistance / 64); // 64 bits max

          matches.push({
            unlabeled: unknown,
            matchedTo: bestMatch,
            distance: bestDistance,
          });
        } else {
          // Track closest non-match for feedback
          if (!closestNonMatch || bestDistance < closestNonMatch.distance) {
            closestNonMatch = { char: unknown, distance: bestDistance, match: bestMatch };
          }
        }
      }
    }

    // Log results
    if (matches.length > 0) {
      console.log(`[FontCollector] Auto-labeled ${matches.length} characters`);
    } else if (closestNonMatch) {
      console.log(
        `[FontCollector] No matches within threshold ${threshold}. ` +
        `Closest was distance ${closestNonMatch.distance} to "${closestNonMatch.match.chr}" ` +
        `(try increasing threshold to ${closestNonMatch.distance + 1} or higher)`
      );
    } else if (missingSizes.length > 0) {
      console.log(`[FontCollector] No matches - need to label some chars of sizes: ${missingSizes.join(', ')}`);
    }

    return matches;
  }

  /**
   * Cascade auto-label: match characters in the same atlas region
   * This allows cross-size matching for characters from the same font sheet
   * @param threshold - pHash threshold (default: 8, more lenient than standard)
   * @returns Array of auto-labeled characters with their matches
   */
  cascadeAutoLabel(threshold: number = 8): Array<{
    unlabeled: CollectedCharacter;
    matchedTo: CollectedCharacter;
    distance: number;
    region: string;
  }> {
    const labeled = this.getLabeledCharacters().filter(c => c.pHash !== undefined && c.atlasRegion);
    const unlabeled = this.getUnlabeledCharacters().filter(c => c.pHash !== undefined && c.atlasRegion);

    console.log(`[FontCollector] Cascade: ${labeled.length} labeled with region, ${unlabeled.length} unlabeled with region`);

    // Group labeled by atlas region
    const labeledByRegion = new Map<string, CollectedCharacter[]>();
    for (const char of labeled) {
      if (!char.atlasRegion) continue;
      if (!labeledByRegion.has(char.atlasRegion)) {
        labeledByRegion.set(char.atlasRegion, []);
      }
      labeledByRegion.get(char.atlasRegion)!.push(char);
    }

    console.log(`[FontCollector] Found ${labeledByRegion.size} atlas regions with labeled chars`);

    const matches: Array<{
      unlabeled: CollectedCharacter;
      matchedTo: CollectedCharacter;
      distance: number;
      region: string;
    }> = [];

    // For each unlabeled character, try to match within same atlas region
    for (const unknown of unlabeled) {
      if (!unknown.pHash || !unknown.atlasRegion) continue;

      // Get labeled chars from same region
      const sameRegion = labeledByRegion.get(unknown.atlasRegion) || [];
      if (sameRegion.length === 0) {
        // Try neighboring regions (within 1 region distance)
        const [rx, ry] = unknown.atlasRegion.split('_').map(Number);
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            if (dx === 0 && dy === 0) continue;
            const neighborRegion = `${rx + dx}_${ry + dy}`;
            const neighbors = labeledByRegion.get(neighborRegion) || [];
            sameRegion.push(...neighbors);
          }
        }
      }

      if (sameRegion.length === 0) continue;

      let bestMatch: CollectedCharacter | null = null;
      let bestDistance = Infinity;

      // Find closest match in region (cross-size allowed!)
      for (const known of sameRegion) {
        if (!known.pHash || !known.chr) continue;

        const distance = hammingDistance(unknown.pHash, known.pHash);
        if (distance < bestDistance && distance <= threshold) {
          bestDistance = distance;
          bestMatch = known;
        }
      }

      if (bestMatch && bestMatch.chr) {
        // Auto-label the character
        unknown.chr = bestMatch.chr;
        unknown.charcode = bestMatch.charcode;
        unknown.matchConfidence = 1 - (bestDistance / 64);

        matches.push({
          unlabeled: unknown,
          matchedTo: bestMatch,
          distance: bestDistance,
          region: unknown.atlasRegion,
        });
      }
    }

    if (matches.length > 0) {
      console.log(`[FontCollector] Cascade auto-labeled ${matches.length} characters across regions`);
      // Log unique chars matched
      const uniqueChars = new Set(matches.map(m => m.matchedTo.chr));
      console.log(`[FontCollector] Matched characters: ${[...uniqueChars].join(', ')}`);
    } else {
      // Find regions that have unlabeled but no labeled
      const unlabeledRegions = new Set(unlabeled.map(c => c.atlasRegion).filter(Boolean));
      const labeledRegions = new Set(labeledByRegion.keys());
      const missingRegions = [...unlabeledRegions].filter(r => !labeledRegions.has(r!));
      if (missingRegions.length > 0) {
        console.log(`[FontCollector] Regions with unlabeled but no labeled chars: ${missingRegions.slice(0, 5).join(', ')}${missingRegions.length > 5 ? '...' : ''}`);
      }
    }

    return matches;
  }

  /**
   * Get character by hash
   */
  getCharacter(hash: number): CollectedCharacter | undefined {
    return this.collectedCharacters.get(hash);
  }

  /**
   * Find characters similar to a given pHash
   */
  findSimilarByPHash(pHashHex: string, threshold: number = 10): CollectedCharacter[] {
    const targetHash = hexToHash(pHashHex);
    const similar: CollectedCharacter[] = [];

    for (const char of this.collectedCharacters.values()) {
      if (!char.pHash) continue;

      const distance = hammingDistance(targetHash, char.pHash);
      if (distance <= threshold) {
        similar.push(char);
      }
    }

    return similar.sort((a, b) => {
      const distA = hammingDistance(targetHash, a.pHash!);
      const distB = hammingDistance(targetHash, b.pHash!);
      return distA - distB;
    });
  }

  /**
   * Get all collected characters
   */
  getCollectedCharacters(): CollectedCharacter[] {
    return Array.from(this.collectedCharacters.values());
  }

  /**
   * Get labeled characters only
   */
  getLabeledCharacters(): CollectedCharacter[] {
    return this.getCollectedCharacters().filter(c => c.chr !== undefined);
  }

  /**
   * Get unlabeled characters only
   */
  getUnlabeledCharacters(): CollectedCharacter[] {
    return this.getCollectedCharacters().filter(c => c.chr === undefined);
  }

  /**
   * Group characters by size (width x height)
   */
  groupBySize(): Map<string, CollectedCharacter[]> {
    const groups = new Map<string, CollectedCharacter[]>();

    for (const char of this.collectedCharacters.values()) {
      const sizeKey = char.sizeKey;
      if (!groups.has(sizeKey)) {
        groups.set(sizeKey, []);
      }
      groups.get(sizeKey)!.push(char);
    }

    return groups;
  }

  /**
   * Group characters by color (ABGR)
   */
  groupByColor(): Map<string, CollectedCharacter[]> {
    const groups = new Map<string, CollectedCharacter[]>();

    for (const char of this.collectedCharacters.values()) {
      const colorKey = char.color ? char.color.join(',') : 'unknown';
      if (!groups.has(colorKey)) {
        groups.set(colorKey, []);
      }
      groups.get(colorKey)!.push(char);
    }

    return groups;
  }

  /**
   * Export to alt1gl CustomJsonFont format
   */
  exportToJsonFormat(spriteid: number = -1): FontSheetData {
    const labeled = this.getLabeledCharacters();
    const unlabeled = this.getUnlabeledCharacters();

    // Calculate sheet bounds from all characters using screen positions
    let minX = Infinity, minY = Infinity;
    let maxX = -Infinity, maxY = -Infinity;

    for (const char of this.collectedCharacters.values()) {
      minX = Math.min(minX, char.screenX);
      minY = Math.min(minY, char.screenY);
      maxX = Math.max(maxX, char.screenX + char.width);
      maxY = Math.max(maxY, char.screenY + char.height);
    }

    // Handle empty case
    if (minX === Infinity) {
      minX = minY = maxX = maxY = 0;
    }

    const sheetwidth = maxX - minX;
    const sheetheight = maxY - minY;

    // Convert to CustomJsonFont format
    const characters: FontCharacterData[] = labeled.map(char => ({
      chr: char.chr!,
      charcode: char.charcode!,
      x: char.screenX - minX,  // Relative to sheet origin
      y: char.screenY - minY,
      width: char.width,
      height: char.height,
      hash: char.hash,
      bearingy: 0,
      // Include atlas position for 100% accurate matching
      atlasX: char.atlasX,
      atlasY: char.atlasY,
    }));

    const unknownchars = unlabeled
      .filter(char => char.charcode !== undefined)
      .map(char => ({
        x: char.screenX - minX,
        y: char.screenY - minY,
        charcode: char.charcode!,
      }));

    return {
      sheetwidth,
      sheetheight,
      sheethash: 0,  // Would need to compute from actual texture
      spriteid,
      characters,
      unknownchars,
    };
  }

  /**
   * Export to JSON string
   */
  exportToJsonString(spriteid: number = -1, pretty: boolean = true): string {
    const data = this.exportToJsonFormat(spriteid);
    return pretty ? JSON.stringify(data, null, '\t') : JSON.stringify(data);
  }

  /**
   * Import from JSON data (creates new entries)
   */
  importFromJson(data: FontSheetData): number {
    let count = 0;

    for (const char of data.characters) {
      const collected: CollectedCharacter = {
        hash: char.hash,
        width: char.width,
        height: char.height,
        screenX: char.x,
        screenY: char.y,
        chr: char.chr,
        charcode: char.charcode,
        collectedAt: Date.now(),
        sizeKey: `${char.width}x${char.height}`,
      };

      this.collectedCharacters.set(char.hash, collected);
      count++;
    }

    return count;
  }

  /**
   * Import labels from JSON data - creates new characters or labels existing ones
   * Uses atlas position matching (100% accurate) when available, falls back to hash
   * @returns { labeled: number, created: number, alreadyLabeled: number, atlasMatched: number }
   */
  importLabelsFromJson(data: FontSheetData): {
    labeled: number;
    created: number;
    alreadyLabeled: number;
    atlasMatched: number;
  } {
    let labeled = 0;
    let created = 0;
    let alreadyLabeled = 0;
    let atlasMatched = 0;

    // Build atlas lookup for current characters
    const byAtlasKey = new Map<string, CollectedCharacter>();
    for (const char of this.collectedCharacters.values()) {
      if (char.atlasX !== undefined && char.atlasY !== undefined) {
        const key = `${char.atlasX}_${char.atlasY}_${char.width}_${char.height}`;
        byAtlasKey.set(key, char);
      }
    }

    for (const char of data.characters) {
      // First try atlas position matching (100% accurate)
      if (char.atlasX !== undefined && char.atlasY !== undefined) {
        const atlasKey = `${char.atlasX}_${char.atlasY}_${char.width}_${char.height}`;
        const atlasMatch = byAtlasKey.get(atlasKey);

        if (atlasMatch && atlasMatch.chr === undefined) {
          // Found exact atlas match - label it
          atlasMatch.chr = char.chr;
          atlasMatch.charcode = char.charcode;
          atlasMatch.matchConfidence = 1.0;
          atlasMatched++;
          continue;
        } else if (atlasMatch && atlasMatch.chr !== undefined) {
          alreadyLabeled++;
          continue;
        }
      }

      // Fall back to hash matching
      const existing = this.collectedCharacters.get(char.hash);

      if (!existing) {
        // Create new character entry from the JSON data
        const collected: CollectedCharacter = {
          hash: char.hash,
          width: char.width,
          height: char.height,
          screenX: char.x,
          screenY: char.y,
          atlasX: char.atlasX,
          atlasY: char.atlasY,
          chr: char.chr,
          charcode: char.charcode,
          matchConfidence: 1.0, // From saved data = confirmed
          collectedAt: Date.now(),
          sizeKey: `${char.width}x${char.height}`,
        };
        this.collectedCharacters.set(char.hash, collected);
        created++;
        continue;
      }

      if (existing.chr !== undefined) {
        alreadyLabeled++;
        continue;
      }

      // Label the existing character
      existing.chr = char.chr;
      existing.charcode = char.charcode;
      existing.matchConfidence = 1.0; // From saved data = confirmed
      labeled++;
    }

    console.log(`[FontCollector] Import: ${atlasMatched} atlas-matched, ${labeled} hash-matched, ${created} created, ${alreadyLabeled} already labeled`);

    return { labeled, created, alreadyLabeled, atlasMatched };
  }

  /**
   * Clear all collected characters
   */
  clear(): void {
    this.collectedCharacters.clear();
    this.groups.clear();
  }

  /**
   * Remove a character by hash
   */
  remove(hash: number): boolean {
    return this.collectedCharacters.delete(hash);
  }

  /**
   * Register callback for new characters
   */
  onCharacterCollected(callback: (char: CollectedCharacter) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  private notifyListeners(char: CollectedCharacter): void {
    for (const listener of this.listeners) {
      try {
        listener(char);
      } catch (e) {
        console.error('[FontCharacterCollector] Listener error:', e);
      }
    }
  }

  /**
   * Get statistics about collected characters
   */
  getStats(): {
    total: number;
    labeled: number;
    unlabeled: number;
    withPHash: number;
    autoMatchable: number;
    bySize: { size: string; count: number }[];
  } {
    const all = this.getCollectedCharacters();
    const sizeGroups = this.groupBySize();
    const withPHash = all.filter(c => c.pHash !== undefined).length;
    const labeled = this.getLabeledCharacters();
    const unlabeled = this.getUnlabeledCharacters();

    // Count how many unlabeled have pHash and could potentially be auto-matched
    const unlabeledWithPHash = unlabeled.filter(c => c.pHash !== undefined).length;
    const labeledWithPHash = labeled.filter(c => c.pHash !== undefined).length;

    return {
      total: all.length,
      labeled: labeled.length,
      unlabeled: unlabeled.length,
      withPHash,
      autoMatchable: labeledWithPHash > 0 ? unlabeledWithPHash : 0,
      bySize: Array.from(sizeGroups.entries())
        .map(([size, chars]) => ({ size, count: chars.length }))
        .sort((a, b) => b.count - a.count),
    };
  }

  /**
   * Debug method to show what a character SHOULD match based on font files
   * Helps identify mismatches
   */
  debugCharacterMatch(char: CollectedCharacter): {
    atlasPos: string;
    size: string;
    currentLabel: string;
    possibleMatches: Array<{
      fontName: string;
      chr: string;
      fontPos: string;
      offset: string;
      exactMatch: boolean;
    }>;
  } {
    const result = {
      atlasPos: `(${char.atlasX ?? '?'}, ${char.atlasY ?? '?'})`,
      size: `${char.width}x${char.height}`,
      currentLabel: char.chr ?? '(unlabeled)',
      possibleMatches: [] as Array<{
        fontName: string;
        chr: string;
        fontPos: string;
        offset: string;
        exactMatch: boolean;
      }>,
    };

    if (!this.spriteCache || char.atlasX === undefined || char.atlasY === undefined) {
      return result;
    }

    // Search all fonts for characters with matching size
    for (const [fontName, font] of (this.spriteCache as any).fonts.entries()) {
      if (!font.subs) continue;

      for (const sub of font.subs.values()) {
        if (!sub.fontchr) continue;
        const fc = sub.fontchr;

        // Only consider exact size matches
        if (fc.width !== char.width || fc.height !== char.height) continue;

        const offsetX = char.atlasX - fc.x;
        const offsetY = char.atlasY - fc.y;

        result.possibleMatches.push({
          fontName,
          chr: fc.chr,
          fontPos: `(${fc.x}, ${fc.y})`,
          offset: `(${offsetX}, ${offsetY})`,
          exactMatch: true,
        });
      }
    }

    return result;
  }

  /**
   * Analyze atlas pattern from labeled characters
   * Detects character grid layout, spacing, and ordering
   */
  analyzeAtlasPattern(): AtlasPatternInfo | null {
    const labeled = this.getLabeledCharacters().filter(c => c.atlasX !== undefined && c.atlasY !== undefined);

    if (labeled.length < 3) {
      console.log(`[FontCollector] Need at least 3 labeled chars with atlas positions to detect pattern (have ${labeled.length})`);
      return null;
    }

    // Group by atlas region
    const byRegion = new Map<string, CollectedCharacter[]>();
    for (const char of labeled) {
      const region = char.atlasRegion || 'unknown';
      if (!byRegion.has(region)) byRegion.set(region, []);
      byRegion.get(region)!.push(char);
    }

    // Find the region with most labeled characters
    let bestRegion = '';
    let bestCount = 0;
    for (const [region, chars] of byRegion) {
      if (chars.length > bestCount) {
        bestCount = chars.length;
        bestRegion = region;
      }
    }

    const regionChars = byRegion.get(bestRegion) || [];
    if (regionChars.length < 3) {
      console.log(`[FontCollector] Best region ${bestRegion} only has ${regionChars.length} chars`);
      return null;
    }

    // Sort by atlas position (Y first, then X) to find rows
    const sorted = [...regionChars].sort((a, b) => {
      const yDiff = (a.atlasY || 0) - (b.atlasY || 0);
      if (Math.abs(yDiff) > 2) return yDiff; // Different row
      return (a.atlasX || 0) - (b.atlasX || 0); // Same row, sort by X
    });

    // Detect rows (characters with similar Y values)
    const rows: CollectedCharacter[][] = [];
    let currentRow: CollectedCharacter[] = [];
    let lastY = -Infinity;

    for (const char of sorted) {
      const y = char.atlasY || 0;
      if (Math.abs(y - lastY) > 3) { // New row (3px tolerance)
        if (currentRow.length > 0) rows.push(currentRow);
        currentRow = [];
      }
      currentRow.push(char);
      lastY = y;
    }
    if (currentRow.length > 0) rows.push(currentRow);

    // Analyze character spacing in each row
    const spacings: number[] = [];
    for (const row of rows) {
      for (let i = 1; i < row.length; i++) {
        const spacing = (row[i].atlasX || 0) - (row[i - 1].atlasX || 0);
        if (spacing > 0 && spacing < 50) { // Reasonable spacing
          spacings.push(spacing);
        }
      }
    }

    // Calculate median spacing
    spacings.sort((a, b) => a - b);
    const medianSpacing = spacings.length > 0 ? spacings[Math.floor(spacings.length / 2)] : 0;

    // Analyze character order pattern
    let asciiOrder = 0;
    let reverseOrder = 0;
    for (const row of rows) {
      for (let i = 1; i < row.length; i++) {
        const prev = row[i - 1].charcode || 0;
        const curr = row[i].charcode || 0;
        if (curr === prev + 1) asciiOrder++;
        else if (curr === prev - 1) reverseOrder++;
      }
    }

    const orderPattern = asciiOrder > reverseOrder ? 'ascending' : (reverseOrder > asciiOrder ? 'descending' : 'unknown');

    // Calculate row height
    const rowHeights: number[] = [];
    for (let i = 1; i < rows.length; i++) {
      const prevY = rows[i - 1][0]?.atlasY || 0;
      const currY = rows[i][0]?.atlasY || 0;
      const height = currY - prevY;
      if (height > 0 && height < 100) rowHeights.push(height);
    }
    rowHeights.sort((a, b) => a - b);
    const medianRowHeight = rowHeights.length > 0 ? rowHeights[Math.floor(rowHeights.length / 2)] : 0;

    // Build character map: position -> charcode
    const charMap = new Map<string, number>();
    for (const char of regionChars) {
      const key = `${char.atlasX},${char.atlasY}`;
      if (char.charcode !== undefined) {
        charMap.set(key, char.charcode);
      }
    }

    const pattern: AtlasPatternInfo = {
      region: bestRegion,
      charCount: regionChars.length,
      rowCount: rows.length,
      medianSpacing,
      medianRowHeight,
      orderPattern,
      rows: rows.map(row => ({
        y: row[0]?.atlasY || 0,
        chars: row.map(c => ({
          x: c.atlasX || 0,
          chr: c.chr || '?',
          charcode: c.charcode || 0,
        })),
      })),
      charMap,
    };

    console.log(`[FontCollector] Atlas pattern detected in region ${bestRegion}:`);
    console.log(`  - ${rows.length} rows, ${regionChars.length} chars`);
    console.log(`  - Spacing: ${medianSpacing}px, Row height: ${medianRowHeight}px`);
    console.log(`  - Order: ${orderPattern}`);
    for (const row of pattern.rows) {
      const chars = row.chars.map(c => c.chr).join('');
      console.log(`  - Row Y=${row.y}: "${chars}"`);
    }

    return pattern;
  }

  /**
   * Infer character labels from atlas pattern
   * Uses position-based inference to label unlabeled characters
   */
  inferFromAtlasPattern(pattern: AtlasPatternInfo | null = null): Array<{
    char: CollectedCharacter;
    inferred: string;
    charcode: number;
    confidence: number;
    method: string;
  }> {
    if (!pattern) {
      pattern = this.analyzeAtlasPattern();
    }
    if (!pattern) {
      console.log('[FontCollector] No pattern available for inference');
      return [];
    }

    const unlabeled = this.getUnlabeledCharacters().filter(
      c => c.atlasX !== undefined && c.atlasY !== undefined && c.atlasRegion === pattern!.region
    );

    if (unlabeled.length === 0) {
      console.log('[FontCollector] No unlabeled chars in pattern region');
      return [];
    }

    const inferred: Array<{
      char: CollectedCharacter;
      inferred: string;
      charcode: number;
      confidence: number;
      method: string;
    }> = [];

    for (const char of unlabeled) {
      const x = char.atlasX || 0;
      const y = char.atlasY || 0;

      // Method 1: Exact position match in charMap
      const exactKey = `${x},${y}`;
      if (pattern.charMap.has(exactKey)) {
        const charcode = pattern.charMap.get(exactKey)!;
        char.chr = String.fromCharCode(charcode);
        char.charcode = charcode;
        char.matchConfidence = 1.0;
        inferred.push({ char, inferred: char.chr, charcode, confidence: 1.0, method: 'exact' });
        continue;
      }

      // Method 2: Find row and interpolate position
      for (const row of pattern.rows) {
        if (Math.abs(y - row.y) > 3) continue; // Not in this row

        // Find neighboring characters in the row
        const sorted = [...row.chars].sort((a, b) => a.x - b.x);

        for (let i = 0; i < sorted.length; i++) {
          const known = sorted[i];
          const xDiff = x - known.x;

          if (Math.abs(xDiff) < 2) {
            // Very close match
            char.chr = known.chr;
            char.charcode = known.charcode;
            char.matchConfidence = 0.95;
            inferred.push({ char, inferred: known.chr, charcode: known.charcode, confidence: 0.95, method: 'near' });
            break;
          }

          // Check if it's a neighbor based on spacing
          if (pattern.medianSpacing > 0) {
            const steps = Math.round(xDiff / pattern.medianSpacing);
            if (Math.abs(steps) <= 26 && Math.abs(steps) >= 1) { // Reasonable range
              const positionError = Math.abs(xDiff - (steps * pattern.medianSpacing));
              if (positionError < pattern.medianSpacing * 0.3) { // Within 30% tolerance
                const charOffset = pattern.orderPattern === 'ascending' ? steps : -steps;
                const inferredCharcode = known.charcode + charOffset;

                // Validate charcode is printable
                if (inferredCharcode >= 32 && inferredCharcode <= 126) {
                  const confidence = 0.8 - (positionError / pattern.medianSpacing) * 0.3;
                  char.chr = String.fromCharCode(inferredCharcode);
                  char.charcode = inferredCharcode;
                  char.matchConfidence = confidence;
                  inferred.push({
                    char,
                    inferred: char.chr,
                    charcode: inferredCharcode,
                    confidence,
                    method: `offset:${steps}`
                  });
                  break;
                }
              }
            }
          }
        }

        if (char.chr) break; // Already labeled
      }
    }

    if (inferred.length > 0) {
      console.log(`[FontCollector] Pattern-inferred ${inferred.length} characters:`);
      for (const inf of inferred.slice(0, 10)) {
        console.log(`  - "${inf.inferred}" (${inf.charcode}) confidence=${inf.confidence.toFixed(2)} method=${inf.method}`);
      }
      if (inferred.length > 10) {
        console.log(`  ... and ${inferred.length - 10} more`);
      }
    }

    return inferred;
  }

  /**
   * Aggressive position-based inference for ALL regions
   * Uses any labeled character as an anchor and infers neighbors based on typical font layout
   */
  inferAllByPosition(): Array<{
    char: CollectedCharacter;
    inferred: string;
    charcode: number;
    confidence: number;
    method: string;
  }> {
    const all = this.getCollectedCharacters().filter(c => c.atlasX !== undefined && c.atlasY !== undefined);

    // Group by region
    const byRegion = new Map<string, CollectedCharacter[]>();
    for (const char of all) {
      const region = char.atlasRegion || 'unknown';
      if (!byRegion.has(region)) byRegion.set(region, []);
      byRegion.get(region)!.push(char);
    }

    const inferred: Array<{
      char: CollectedCharacter;
      inferred: string;
      charcode: number;
      confidence: number;
      method: string;
    }> = [];

    // For each region, try position-based inference
    for (const [region, chars] of byRegion) {
      const labeled = chars.filter(c => c.chr !== undefined);
      const unlabeled = chars.filter(c => c.chr === undefined);

      if (labeled.length === 0 || unlabeled.length === 0) continue;

      // Group chars by row (similar Y position, within 3px)
      const rows: CollectedCharacter[][] = [];
      const sortedByY = [...chars].sort((a, b) => (a.atlasY || 0) - (b.atlasY || 0));

      let currentRow: CollectedCharacter[] = [];
      let lastY = -Infinity;

      for (const char of sortedByY) {
        const y = char.atlasY || 0;
        if (Math.abs(y - lastY) > 4) { // New row
          if (currentRow.length > 0) rows.push(currentRow);
          currentRow = [];
        }
        currentRow.push(char);
        lastY = y;
      }
      if (currentRow.length > 0) rows.push(currentRow);

      // Process each row
      for (const row of rows) {
        const rowLabeled = row.filter(c => c.chr !== undefined);
        const rowUnlabeled = row.filter(c => c.chr === undefined);

        if (rowLabeled.length === 0 || rowUnlabeled.length === 0) continue;

        // Sort row by X position
        row.sort((a, b) => (a.atlasX || 0) - (b.atlasX || 0));

        // Calculate spacing from labeled characters
        let spacing = 0;
        if (rowLabeled.length >= 2) {
          const spacings: number[] = [];
          const sortedLabeled = [...rowLabeled].sort((a, b) => (a.atlasX || 0) - (b.atlasX || 0));
          for (let i = 1; i < sortedLabeled.length; i++) {
            const dx = (sortedLabeled[i].atlasX || 0) - (sortedLabeled[i-1].atlasX || 0);
            const dChar = (sortedLabeled[i].charcode || 0) - (sortedLabeled[i-1].charcode || 0);
            if (dChar !== 0 && dx > 0) {
              spacings.push(dx / Math.abs(dChar));
            }
          }
          if (spacings.length > 0) {
            spacings.sort((a, b) => a - b);
            spacing = spacings[Math.floor(spacings.length / 2)];
          }
        }

        // If no spacing calculated, estimate from row
        if (spacing === 0 && row.length >= 2) {
          const totalWidth = (row[row.length-1].atlasX || 0) - (row[0].atlasX || 0);
          spacing = totalWidth / (row.length - 1);
        }

        if (spacing < 3 || spacing > 30) continue; // Unreasonable spacing

        // Use each labeled char as anchor
        for (const anchor of rowLabeled) {
          const anchorX = anchor.atlasX || 0;
          const anchorCode = anchor.charcode || 0;

          for (const unknown of rowUnlabeled) {
            if (unknown.chr) continue; // Already labeled

            const unknownX = unknown.atlasX || 0;
            const xDiff = unknownX - anchorX;
            const steps = Math.round(xDiff / spacing);

            if (Math.abs(steps) > 40) continue; // Too far

            const posError = Math.abs(xDiff - (steps * spacing));
            if (posError > spacing * 0.4) continue; // Position doesn't match grid

            const inferredCode = anchorCode + steps;

            // Validate - must be common printable ASCII (exclude rare chars)
            // Allowed: space(32), 0-9(48-57), A-Z(65-90), a-z(97-122), common punctuation
            const isCommonChar = (code: number) => {
              if (code === 32) return true; // space
              if (code >= 48 && code <= 57) return true; // 0-9
              if (code >= 65 && code <= 90) return true; // A-Z
              if (code >= 97 && code <= 122) return true; // a-z
              // Common punctuation: ! " ' ( ) , - . / : ; ?
              if ([33, 34, 39, 40, 41, 44, 45, 46, 47, 58, 59, 63].includes(code)) return true;
              return false;
            };

            if (isCommonChar(inferredCode)) {
              const inferredChr = String.fromCharCode(inferredCode);
              // Use stricter confidence - position inference is error-prone
              const confidence = 0.65 - (posError / spacing) * 0.25;

              // Only accept if confidence is reasonable
              if (confidence >= 0.5) {
                unknown.chr = inferredChr;
                unknown.charcode = inferredCode;
                unknown.matchConfidence = confidence;

                inferred.push({
                  char: unknown,
                  inferred: inferredChr,
                  charcode: inferredCode,
                  confidence,
                  method: `pos:${anchor.chr}+${steps}`
                });
                break; // Only label once
              }
            }
          }
        }
      }
    }

    if (inferred.length > 0) {
      console.log(`[FontCollector] Position-inferred ${inferred.length} characters:`);
      for (const inf of inferred.slice(0, 15)) {
        console.log(`  - "${inf.inferred}" via ${inf.method} (conf: ${inf.confidence.toFixed(2)})`);
      }
      if (inferred.length > 15) {
        console.log(`  ... and ${inferred.length - 15} more`);
      }
    }

    return inferred;
  }

  /**
   * Detect likely character spacing from just positions (no labels needed)
   * Uses statistical analysis of inter-character distances
   */
  private detectSpacingFromPositions(chars: CollectedCharacter[]): number {
    if (chars.length < 3) return 0;

    // Group by rows
    const sortedByY = [...chars].sort((a, b) => (a.atlasY || 0) - (b.atlasY || 0));
    const rows: CollectedCharacter[][] = [];
    let currentRow: CollectedCharacter[] = [];
    let lastY = -Infinity;

    for (const char of sortedByY) {
      const y = char.atlasY || 0;
      if (Math.abs(y - lastY) > 4) {
        if (currentRow.length > 0) rows.push(currentRow);
        currentRow = [];
      }
      currentRow.push(char);
      lastY = y;
    }
    if (currentRow.length > 0) rows.push(currentRow);

    // Collect all inter-character distances
    const distances: number[] = [];
    for (const row of rows) {
      if (row.length < 2) continue;
      row.sort((a, b) => (a.atlasX || 0) - (b.atlasX || 0));
      for (let i = 1; i < row.length; i++) {
        const dx = (row[i].atlasX || 0) - (row[i-1].atlasX || 0);
        if (dx > 0 && dx < 50) distances.push(dx);
      }
    }

    if (distances.length === 0) return 0;

    // Find the most common spacing (likely single-char width)
    distances.sort((a, b) => a - b);
    const median = distances[Math.floor(distances.length / 2)];

    // Count how many are close to median
    const closeToMedian = distances.filter(d => Math.abs(d - median) < median * 0.2).length;

    // If most distances are similar, the median is likely the spacing
    if (closeToMedian / distances.length > 0.3) {
      return median;
    }

    // Otherwise look for GCD-like pattern (might be multi-step spacing)
    const minDist = Math.min(...distances);
    if (minDist > 3 && minDist < 30) {
      return minDist;
    }

    return median;
  }

  /**
   * Cross-region inference: use labeled chars from ANY region to infer in regions with no labels
   * This helps bootstrap unlabeled regions
   */
  crossRegionInference(): Array<{
    char: CollectedCharacter;
    inferred: string;
    charcode: number;
    confidence: number;
    method: string;
  }> {
    const all = this.getCollectedCharacters().filter(c => c.atlasX !== undefined && c.atlasY !== undefined);

    // Group by region
    const byRegion = new Map<string, CollectedCharacter[]>();
    for (const char of all) {
      const region = char.atlasRegion || 'unknown';
      if (!byRegion.has(region)) byRegion.set(region, []);
      byRegion.get(region)!.push(char);
    }

    // Find regions with labeled chars and compute their spacing
    const regionSpacings = new Map<string, number>();
    let globalSpacing = 0;
    let spacingCount = 0;

    for (const [region, chars] of byRegion) {
      const labeled = chars.filter(c => c.chr !== undefined);
      if (labeled.length >= 2) {
        // Calculate spacing from this region
        const sortedLabeled = [...labeled].sort((a, b) => (a.atlasX || 0) - (b.atlasX || 0));
        const spacings: number[] = [];
        for (let i = 1; i < sortedLabeled.length; i++) {
          const dx = (sortedLabeled[i].atlasX || 0) - (sortedLabeled[i-1].atlasX || 0);
          const dChar = Math.abs((sortedLabeled[i].charcode || 0) - (sortedLabeled[i-1].charcode || 0));
          if (dChar > 0 && dx > 0) {
            spacings.push(dx / dChar);
          }
        }
        if (spacings.length > 0) {
          spacings.sort((a, b) => a - b);
          const medianSpacing = spacings[Math.floor(spacings.length / 2)];
          regionSpacings.set(region, medianSpacing);
          globalSpacing += medianSpacing;
          spacingCount++;
        }
      }
    }

    // Calculate average global spacing
    if (spacingCount > 0) {
      globalSpacing /= spacingCount;
    } else {
      // Try to detect from positions alone
      globalSpacing = this.detectSpacingFromPositions(all);
    }

    if (globalSpacing < 4 || globalSpacing > 25) {
      console.log(`[FontCollector] Cross-region: no valid spacing detected (${globalSpacing.toFixed(1)})`);
      return [];
    }

    console.log(`[FontCollector] Cross-region: using global spacing ${globalSpacing.toFixed(1)}px`);

    // Get ALL labeled characters for pHash lookup
    const allLabeled = this.getLabeledCharacters().filter(c => c.pHash !== undefined);

    const inferred: Array<{
      char: CollectedCharacter;
      inferred: string;
      charcode: number;
      confidence: number;
      method: string;
    }> = [];

    // For regions with NO labeled chars, try to find anchors via pHash
    for (const [region, chars] of byRegion) {
      const labeled = chars.filter(c => c.chr !== undefined);
      const unlabeled = chars.filter(c => c.chr === undefined);

      if (labeled.length > 0 || unlabeled.length === 0) continue;

      // Try to find an anchor via pHash matching to chars from other regions
      let bestAnchor: { char: CollectedCharacter; match: CollectedCharacter; distance: number } | null = null;

      for (const unknown of unlabeled) {
        if (!unknown.pHash) continue;

        for (const known of allLabeled) {
          if (!known.pHash) continue;
          const distance = hammingDistance(unknown.pHash, known.pHash);
          if (distance <= 5) { // Slightly lenient for cross-region
            if (!bestAnchor || distance < bestAnchor.distance) {
              bestAnchor = { char: unknown, match: known, distance };
            }
          }
        }
      }

      if (!bestAnchor) continue;

      // Label the anchor
      const anchor = bestAnchor.char;
      anchor.chr = bestAnchor.match.chr;
      anchor.charcode = bestAnchor.match.charcode;
      anchor.matchConfidence = 1 - (bestAnchor.distance / 64);

      inferred.push({
        char: anchor,
        inferred: anchor.chr!,
        charcode: anchor.charcode!,
        confidence: anchor.matchConfidence!,
        method: `cross-region:pHash(${bestAnchor.distance})`
      });

      console.log(`[FontCollector] Cross-region: found anchor "${anchor.chr}" in region ${region} via pHash`);

      // Now use this anchor to infer neighbors using global spacing
      const anchorX = anchor.atlasX || 0;
      const anchorY = anchor.atlasY || 0;

      for (const unknown of unlabeled) {
        if (unknown.chr) continue;
        if (!unknown.atlasX || !unknown.atlasY) continue;

        // Must be in same row (within 4px Y)
        if (Math.abs((unknown.atlasY || 0) - anchorY) > 4) continue;

        const xDiff = (unknown.atlasX || 0) - anchorX;
        const steps = Math.round(xDiff / globalSpacing);

        if (Math.abs(steps) > 40) continue;

        const posError = Math.abs(xDiff - (steps * globalSpacing));
        if (posError > globalSpacing * 0.4) continue;

        const inferredCode = (anchor.charcode || 0) + steps;

        // Validate - must be common printable ASCII (exclude rare chars)
        const isCommonChar = (code: number) => {
          if (code === 32) return true; // space
          if (code >= 48 && code <= 57) return true; // 0-9
          if (code >= 65 && code <= 90) return true; // A-Z
          if (code >= 97 && code <= 122) return true; // a-z
          // Common punctuation: ! " ' ( ) , - . / : ; ?
          if ([33, 34, 39, 40, 41, 44, 45, 46, 47, 58, 59, 63].includes(code)) return true;
          return false;
        };

        if (isCommonChar(inferredCode)) {
          const inferredChr = String.fromCharCode(inferredCode);
          const confidence = 0.55 - (posError / globalSpacing) * 0.2;

          // Only accept if confidence is reasonable
          if (confidence >= 0.45) {
            unknown.chr = inferredChr;
            unknown.charcode = inferredCode;
            unknown.matchConfidence = confidence;

            inferred.push({
              char: unknown,
              inferred: inferredChr,
              charcode: inferredCode,
              confidence,
              method: `cross-region:pos(${anchor.chr}+${steps})`
            });
          }
        }
      }
    }

    if (inferred.length > 0) {
      console.log(`[FontCollector] Cross-region inferred ${inferred.length} characters`);
    }

    return inferred;
  }

  /**
   * Global pHash matching - matches across ALL characters regardless of size or region
   * Uses a stricter threshold since we're ignoring size constraints
   * @param threshold - Maximum Hamming distance (default: 3, very strict)
   */
  globalPHashMatch(threshold: number = 3): Array<{
    unlabeled: CollectedCharacter;
    matchedTo: CollectedCharacter;
    distance: number;
  }> {
    const labeled = this.getLabeledCharacters().filter(c => c.pHash !== undefined);
    const unlabeled = this.getUnlabeledCharacters().filter(c => c.pHash !== undefined);

    if (labeled.length === 0 || unlabeled.length === 0) {
      console.log(`[FontCollector] Global pHash: ${labeled.length} labeled, ${unlabeled.length} unlabeled with pHash`);
      return [];
    }

    const matches: Array<{
      unlabeled: CollectedCharacter;
      matchedTo: CollectedCharacter;
      distance: number;
    }> = [];

    // Build pHash lookup from all labeled chars
    const labeledByPHash = new Map<string, CollectedCharacter[]>();
    for (const char of labeled) {
      if (!char.pHashHex) continue;
      if (!labeledByPHash.has(char.pHashHex)) {
        labeledByPHash.set(char.pHashHex, []);
      }
      labeledByPHash.get(char.pHashHex)!.push(char);
    }

    for (const unknown of unlabeled) {
      if (!unknown.pHash || !unknown.pHashHex) continue;

      // First try exact pHash match
      const exact = labeledByPHash.get(unknown.pHashHex);
      if (exact && exact.length > 0) {
        const match = exact[0];
        unknown.chr = match.chr;
        unknown.charcode = match.charcode;
        unknown.matchConfidence = 1.0;
        matches.push({ unlabeled: unknown, matchedTo: match, distance: 0 });
        continue;
      }

      // Fuzzy match against ALL labeled
      let bestMatch: CollectedCharacter | null = null;
      let bestDistance = Infinity;

      for (const known of labeled) {
        if (!known.pHash || !known.chr) continue;

        const distance = hammingDistance(unknown.pHash, known.pHash);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestMatch = known;
        }
      }

      if (bestMatch && bestDistance <= threshold) {
        unknown.chr = bestMatch.chr;
        unknown.charcode = bestMatch.charcode;
        unknown.matchConfidence = 1 - (bestDistance / 64);
        matches.push({ unlabeled: unknown, matchedTo: bestMatch, distance: bestDistance });
      }
    }

    if (matches.length > 0) {
      console.log(`[FontCollector] Global pHash matched ${matches.length} characters (threshold=${threshold})`);
      // Group by character for summary
      const byChr = new Map<string, number>();
      for (const m of matches) {
        byChr.set(m.matchedTo.chr!, (byChr.get(m.matchedTo.chr!) || 0) + 1);
      }
      const summary = [...byChr.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([chr, cnt]) => `"${chr}":${cnt}`)
        .join(', ');
      console.log(`  Top matches: ${summary}`);
    }

    return matches;
  }

  /**
   * Verify position-inferred labels by checking if they have pHash matches to confirmed chars
   * Returns array of labels that should be REMOVED (failed verification)
   */
  private verifyPositionInferences(): Array<{
    char: CollectedCharacter;
    reason: string;
  }> {
    // Get chars that were labeled via position inference (low confidence)
    const positionInferred = this.getLabeledCharacters().filter(
      c => c.matchConfidence !== undefined &&
           c.matchConfidence < 0.8 &&
           c.matchConfidence >= 0.5 &&
           c.pHash !== undefined
    );

    if (positionInferred.length === 0) return [];

    // Get high-confidence labels (pHash matches, sprite cache, etc)
    const confirmed = this.getLabeledCharacters().filter(
      c => c.matchConfidence === undefined || c.matchConfidence >= 0.9
    );

    // Group confirmed by character
    const confirmedByChar = new Map<string, CollectedCharacter[]>();
    for (const c of confirmed) {
      if (!c.chr || !c.pHash) continue;
      if (!confirmedByChar.has(c.chr)) confirmedByChar.set(c.chr, []);
      confirmedByChar.get(c.chr)!.push(c);
    }

    const toRemove: Array<{ char: CollectedCharacter; reason: string }> = [];

    for (const char of positionInferred) {
      if (!char.chr || !char.pHash) continue;

      // Check if this char's pHash matches any confirmed instance of the same character
      const confirmedInstances = confirmedByChar.get(char.chr) || [];

      if (confirmedInstances.length === 0) {
        // No confirmed instances of this character - can't verify
        // Keep it but note the uncertainty
        continue;
      }

      // Find closest pHash match to any confirmed instance
      let closestDistance = Infinity;
      for (const confirmed of confirmedInstances) {
        if (!confirmed.pHash) continue;
        const dist = hammingDistance(char.pHash, confirmed.pHash);
        if (dist < closestDistance) closestDistance = dist;
      }

      // If pHash is very different from all confirmed instances, this inference is likely wrong
      if (closestDistance > 15) {
        toRemove.push({
          char,
          reason: `pHash mismatch (distance ${closestDistance} to nearest confirmed "${char.chr}")`
        });
      }
    }

    // Remove bad inferences
    for (const { char, reason } of toRemove) {
      console.log(`[FontCollector] Removing bad inference: "${char.chr}" - ${reason}`);
      char.chr = undefined;
      char.charcode = undefined;
      char.matchConfidence = undefined;
    }

    if (toRemove.length > 0) {
      console.log(`[FontCollector] Verification removed ${toRemove.length} bad position inferences`);
    }

    return toRemove;
  }

  /**
   * Full auto-label pipeline - runs all methods in optimal order
   * This is the main entry point for fully automatic labeling
   */
  fullAutoLabel(): {
    spriteCacheMatches: number;
    fontSheetMatches: number;
    atlasMatches: number;
    fontFileMatches: number;
    pHashMatches: number;
    cascadeMatches: number;
    globalMatches: number;
    patternMatches: number;
    positionMatches: number;
    crossRegionMatches: number;
    verificationRejected: number;
    total: number;
    remaining: number;
  } {
    console.log('[FontCollector] === Starting Full Auto-Label Pipeline ===');
    const startUnlabeled = this.getUnlabeledCharacters().length;
    const startLabeled = this.getLabeledCharacters().length;
    console.log(`[FontCollector] Starting: ${startLabeled} labeled, ${startUnlabeled} unlabeled`);

    // 0. FONT SHEET AUTO-DETECTION - 100% ACCURATE, NO MANUAL LABELING NEEDED
    // Automatically finds font sheets in atlas and labels all matching characters
    const fontSheetMatches = this.autoLabelByFontSheetDetection();

    // 0.5. ATLAS POSITION MATCHING - 100% ACCURATE (same atlas position = same character)
    const atlasResults = this.autoLabelByAtlasPosition();
    const atlasMatches = atlasResults.length;

    // 0.75. FONT FILE MATCHING with anchors - 100% ACCURATE (uses labeled chars as anchors)
    const fontFileMatches = this.autoLabelByFontFileData();

    // 1. Standard pHash matching (same size) - for chars without atlas position
    const pHashResults = this.autoLabelByPHash(5);
    const pHashMatches = pHashResults.length;

    // 2. Cascade matching (cross-size within region)
    const cascadeResults = this.cascadeAutoLabel(8);
    const cascadeMatches = cascadeResults.length;

    // 3. Global pHash matching (any size, strict threshold)
    const globalResults = this.globalPHashMatch(3);
    const globalMatches = globalResults.length;

    // 4. Pattern-based inference
    const pattern = this.analyzeAtlasPattern();
    let patternMatches = 0;
    if (pattern) {
      const patternResults = this.inferFromAtlasPattern(pattern);
      patternMatches = patternResults.length;
    }

    // 5. Position-based inference (uses any labeled as anchor)
    const positionResults = this.inferAllByPosition();
    const positionMatches = positionResults.length;

    // 5.5. VERIFY position inferences against pHash
    const rejected1 = this.verifyPositionInferences();

    // 6. Run again - newly labeled chars can be anchors for more inference
    const positionResults2 = this.inferAllByPosition();
    const positionMatches2 = positionResults2.length;

    // 7. Cross-region inference (bootstrap unlabeled regions)
    const crossRegionResults = this.crossRegionInference();
    const crossRegionMatches = crossRegionResults.length;

    // 8. Position inference again after cross-region bootstrapped some anchors
    const positionResults3 = this.inferAllByPosition();
    const positionMatches3 = positionResults3.length;

    // 8.5. Verify again
    const rejected2 = this.verifyPositionInferences();

    // 9. One more global match with remaining unlabeled (slightly more lenient)
    const globalResults2 = this.globalPHashMatch(4);
    const globalMatches2 = globalResults2.length;

    // 10. Final position pass
    const positionResults4 = this.inferAllByPosition();
    const positionMatches4 = positionResults4.length;

    // 10.5. Final verification
    const rejected3 = this.verifyPositionInferences();

    const verificationRejected = rejected1.length + rejected2.length + rejected3.length;

    const endLabeled = this.getLabeledCharacters().length;
    const endUnlabeled = this.getUnlabeledCharacters().length;

    const totalNewlyLabeled = endLabeled - startLabeled;
    console.log('[FontCollector] === Full Auto-Label Complete ===');
    console.log(`[FontCollector] Final: ${endLabeled} labeled, ${endUnlabeled} unlabeled`);
    console.log(`[FontCollector] Labeled ${totalNewlyLabeled} new characters (${((endLabeled / (endLabeled + endUnlabeled)) * 100).toFixed(1)}%)`);
    if (verificationRejected > 0) {
      console.log(`[FontCollector] Verification rejected ${verificationRejected} bad inferences`);
    }

    return {
      spriteCacheMatches: 0, // Counted during scanForCharacters
      fontSheetMatches,
      atlasMatches,
      fontFileMatches,
      pHashMatches,
      cascadeMatches,
      globalMatches: globalMatches + globalMatches2,
      patternMatches,
      positionMatches: positionMatches + positionMatches2 + positionMatches3 + positionMatches4,
      crossRegionMatches,
      verificationRejected,
      total: totalNewlyLabeled,
      remaining: endUnlabeled,
    };
  }

  /**
   * Safe auto-label - ONLY uses high-confidence pHash matching
   * No position inference, no cross-region guessing
   * Use this when you want maximum accuracy over coverage
   */
  safeAutoLabel(): {
    fontSheetMatches: number;
    atlasMatches: number;
    fontFileMatches: number;
    pHashMatches: number;
    cascadeMatches: number;
    globalMatches: number;
    total: number;
    remaining: number;
  } {
    console.log('[FontCollector] === Safe Auto-Label (font sheet detection + pHash) ===');
    const startLabeled = this.getLabeledCharacters().length;

    // 0. FONT SHEET AUTO-DETECTION - 100% accurate, no manual labeling needed
    const fontSheetMatches = this.autoLabelByFontSheetDetection();

    // 0.5. ATLAS MATCHING - 100% accurate (same atlas position = same char)
    const atlasResults = this.autoLabelByAtlasPosition();
    const atlasMatches = atlasResults.length;

    // 0.75. FONT FILE MATCHING with anchors
    const fontFileMatches = this.autoLabelByFontFileData();

    // 1. Standard pHash matching (same size, strict threshold)
    const pHashResults = this.autoLabelByPHash(3); // stricter threshold
    const pHashMatches = pHashResults.length;

    // 2. Cascade matching with strict threshold
    const cascadeResults = this.cascadeAutoLabel(5);
    const cascadeMatches = cascadeResults.length;

    // 3. Global pHash with very strict threshold
    const globalResults = this.globalPHashMatch(2);
    const globalMatches = globalResults.length;

    // 4. Run again to cascade discoveries
    this.autoLabelByFontSheetDetection();
    this.autoLabelByAtlasPosition();
    this.autoLabelByFontFileData();
    this.autoLabelByPHash(3);
    this.cascadeAutoLabel(5);
    this.globalPHashMatch(2);

    const endLabeled = this.getLabeledCharacters().length;
    const endUnlabeled = this.getUnlabeledCharacters().length;

    console.log(`[FontCollector] Safe mode: ${endLabeled} labeled, ${endUnlabeled} unlabeled`);
    console.log(`[FontCollector] Labeled ${endLabeled - startLabeled} new (fontSheet: ${fontSheetMatches}, atlas: ${atlasMatches}, fontFile: ${fontFileMatches})`);

    return {
      fontSheetMatches,
      atlasMatches,
      fontFileMatches,
      pHashMatches,
      cascadeMatches,
      globalMatches,
      total: endLabeled - startLabeled,
      remaining: endUnlabeled,
    };
  }

  /**
   * Get low-confidence labels for review
   * Returns chars that were labeled via position inference and might be wrong
   */
  getLowConfidenceLabels(): Array<{
    char: CollectedCharacter;
    confidence: number;
    inferred: string;
  }> {
    return this.getLabeledCharacters()
      .filter(c => c.matchConfidence !== undefined && c.matchConfidence < 0.8)
      .map(c => ({
        char: c,
        confidence: c.matchConfidence!,
        inferred: c.chr!,
      }))
      .sort((a, b) => a.confidence - b.confidence);
  }

  /**
   * Remove all low-confidence labels
   * Use this to clean up and start fresh with only high-confidence labels
   */
  clearLowConfidenceLabels(threshold: number = 0.75): number {
    const lowConf = this.getLabeledCharacters().filter(
      c => c.matchConfidence !== undefined && c.matchConfidence < threshold
    );

    for (const char of lowConf) {
      char.chr = undefined;
      char.charcode = undefined;
      char.matchConfidence = undefined;
    }

    console.log(`[FontCollector] Cleared ${lowConf.length} low-confidence labels (threshold: ${threshold})`);
    return lowConf.length;
  }

  /**
   * Get info about all atlas regions
   */
  getAtlasRegionInfo(): Array<{
    region: string;
    labeled: number;
    unlabeled: number;
    chars: string[];
    bounds: { minX: number; maxX: number; minY: number; maxY: number };
  }> {
    const all = this.getCollectedCharacters().filter(c => c.atlasRegion);

    const byRegion = new Map<string, CollectedCharacter[]>();
    for (const char of all) {
      const region = char.atlasRegion!;
      if (!byRegion.has(region)) byRegion.set(region, []);
      byRegion.get(region)!.push(char);
    }

    const result: Array<{
      region: string;
      labeled: number;
      unlabeled: number;
      chars: string[];
      bounds: { minX: number; maxX: number; minY: number; maxY: number };
    }> = [];

    for (const [region, chars] of byRegion) {
      const labeled = chars.filter(c => c.chr !== undefined);
      const unlabeled = chars.filter(c => c.chr === undefined);

      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const c of chars) {
        minX = Math.min(minX, c.atlasX || 0);
        maxX = Math.max(maxX, (c.atlasX || 0) + c.width);
        minY = Math.min(minY, c.atlasY || 0);
        maxY = Math.max(maxY, (c.atlasY || 0) + c.height);
      }

      result.push({
        region,
        labeled: labeled.length,
        unlabeled: unlabeled.length,
        chars: labeled.map(c => c.chr!).sort(),
        bounds: { minX, maxX, minY, maxY },
      });
    }

    return result.sort((a, b) => (b.labeled + b.unlabeled) - (a.labeled + a.unlabeled));
  }
}

/**
 * Atlas pattern analysis result
 */
export interface AtlasPatternInfo {
  region: string;
  charCount: number;
  rowCount: number;
  medianSpacing: number;
  medianRowHeight: number;
  orderPattern: 'ascending' | 'descending' | 'unknown';
  rows: Array<{
    y: number;
    chars: Array<{ x: number; chr: string; charcode: number }>;
  }>;
  charMap: Map<string, number>;
}

/**
 * Create a configured FontCharacterCollector instance
 */
export function createFontCharacterCollector(dataProvider?: FontCollectorDataProvider): FontCharacterCollector {
  return new FontCharacterCollector(dataProvider);
}

// Singleton instance
let fontCharacterCollectorInstance: FontCharacterCollector | null = null;

export function getFontCharacterCollector(): FontCharacterCollector {
  if (!fontCharacterCollectorInstance) {
    fontCharacterCollectorInstance = new FontCharacterCollector();
  }
  return fontCharacterCollectorInstance;
}
