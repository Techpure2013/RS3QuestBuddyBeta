/**
 * Sprite API - Fetches NPC sprites from the server for minimap markers
 */

import { getApiBase } from "./base";

export interface SpriteInfo {
  npcId?: number;
  name?: string;
  variant?: string;
}

/**
 * Fetch available chathead variants for an NPC
 */
export async function fetchAvailableVariants(info: { npcId?: number; name?: string }): Promise<string[]> {
  const params = new URLSearchParams();
  if (info.npcId) params.set("npcId", String(info.npcId));
  if (info.name) params.set("name", info.name);

  if (!info.npcId && !info.name) {
    return [];
  }

  try {
    const response = await fetch(
      `${getApiBase()}/chatheads/variants?${params}`,
      { credentials: "include" }
    );

    if (!response.ok) {
      return [];
    }

    const data = await response.json();
    return data.variants || [];
  } catch {
    return [];
  }
}

/**
 * Fetch NPC sprite from the chatheads API and convert to ImageData for GL textures
 * If no variant specified, tries to find any available variant
 */
export async function fetchNpcSprite(info: SpriteInfo): Promise<ImageData> {
  // Need at least npcId or name
  if (!info.npcId && !info.name) {
    throw new Error("Either npcId or name is required");
  }

  // If no variant specified, find available variants
  let variantToUse = info.variant;
  if (!variantToUse) {
    const variants = await fetchAvailableVariants({ npcId: info.npcId, name: info.name });
    if (variants.length === 0) {
      throw new Error(`No chathead variants found for: ${info.name || info.npcId}`);
    }
    // Prefer "default" if available, otherwise use first variant
    variantToUse = variants.includes("default") ? "default" : variants[0];
    console.log(`[SpriteAPI] Using variant "${variantToUse}" for ${info.name || info.npcId} (available: ${variants.join(", ")})`);
  }

  const params = new URLSearchParams();
  if (info.npcId) params.set("npcId", String(info.npcId));
  if (info.name) params.set("name", info.name);
  params.set("variant", variantToUse);

  const response = await fetch(
    `${getApiBase()}/chatheads/sprite?${params}`,
    { credentials: "include" }
  );

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`Sprite not found: ${info.name || info.npcId} (variant: ${variantToUse})`);
    }
    throw new Error(`Failed to fetch sprite: ${response.status}`);
  }

  // Convert webp blob to ImageData via OffscreenCanvas
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);

  // Use OffscreenCanvas to get pixel data
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Failed to get 2D context from OffscreenCanvas");
  }

  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
}

/**
 * Simple in-memory sprite cache
 *
 * Keys are based on npcId/name only (variant is auto-selected by fetchNpcSprite)
 */
class SpriteCache {
  private cache = new Map<string, ImageData>();
  private pending = new Map<string, Promise<ImageData>>();

  private makeKey(info: SpriteInfo): string {
    // Use npcId if available, otherwise name (variant is auto-selected)
    if (info.npcId) return `id:${info.npcId}`;
    if (info.name) return `name:${info.name.toLowerCase()}`;
    return "unknown";
  }

  /**
   * Get sprite from cache or fetch from API
   */
  async get(info: SpriteInfo): Promise<ImageData> {
    const key = this.makeKey(info);

    // Check cache
    const cached = this.cache.get(key);
    if (cached) return cached;

    // Check if already fetching
    const pending = this.pending.get(key);
    if (pending) return pending;

    // Fetch and cache (variant auto-selected by fetchNpcSprite)
    const promise = fetchNpcSprite(info)
      .then(imageData => {
        this.cache.set(key, imageData);
        this.pending.delete(key);
        return imageData;
      })
      .catch(err => {
        this.pending.delete(key);
        throw err;
      });

    this.pending.set(key, promise);
    return promise;
  }

  /**
   * Clear the cache
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Check if sprite is cached (without fetching)
   */
  has(info: SpriteInfo): boolean {
    return this.cache.has(this.makeKey(info));
  }
}

// Singleton cache instance
export const spriteCache = new SpriteCache();
