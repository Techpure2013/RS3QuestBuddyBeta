import { getApiBase } from "./base";

const API_BASE = getApiBase();

export type NpcSearchResult = {
  id: number;
  name: string;
  lat: number;
  lng: number;
  floor: number;
};

/**
 * Case-insensitive search is handled server-side via lower(name) like %term%.
 * Minimum length: enforce in UI; server also enforces >= 2 chars.
 */
export async function searchNpcs(
  name: string,
  limit = 15
): Promise<NpcSearchResult[]> {
  const params = new URLSearchParams({ name, limit: String(limit) });
  console.log(API_BASE);
  const res = await fetch(`${API_BASE}/npcs/search?${params.toString()}`);

  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(
      msg || `NPC search failed: ${res.status} ${res.statusText}`
    );
  }
  return (await res.json()) as NpcSearchResult[];
}

/**
 * NPC details including buffer hash
 */
export type NpcDetails = {
  id: number;
  name: string;
  buffer_hash: string | null;
  locations: Array<{ lat: number; lng: number; floor: number }>;
};

/**
 * Hash variant for an NPC
 */
export type NpcHashVariant = {
  id: number;
  npc_id: number;
  buffer_hash: string;
  variant_name: string | null;
};

/**
 * Get NPC details by ID
 */
export async function getNpcById(id: number): Promise<NpcDetails | null> {
  const res = await fetch(`${API_BASE}/npcs/${id}`);
  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(msg || `Get NPC failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

/**
 * Get all hash variants for an NPC by ID
 */
export async function getNpcVariants(id: number): Promise<NpcHashVariant[]> {
  const res = await fetch(`${API_BASE}/npcs/${id}/variants`);
  if (res.status === 404) {
    return [];
  }
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(msg || `Get NPC variants failed: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  return data.variants || [];
}

/**
 * Get all buffer hashes for an NPC (main hash + variants)
 * Returns array of hex hash strings
 */
export async function getAllNpcHashes(id: number): Promise<string[]> {
  const hashes: string[] = [];

  // Get main NPC details
  const npc = await getNpcById(id);
  if (npc?.buffer_hash) {
    hashes.push(npc.buffer_hash);
  }

  // Get variants
  const variants = await getNpcVariants(id);
  for (const variant of variants) {
    if (variant.buffer_hash && !hashes.includes(variant.buffer_hash)) {
      hashes.push(variant.buffer_hash);
    }
  }

  return hashes;
}

/**
 * Append a new location to an NPC. Server de-duplicates exact lat/lng/floor.
 */
export async function addNpcLocation(
  id: number,
  coord: { lat: number; lng: number; floor?: number }
): Promise<{
  success: true;
  locations: Array<{ lat: number; lng: number; floor: number }>;
}> {
  const res = await fetch(`${API_BASE}/npcs/${id}/locations`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(coord),
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    throw new Error(msg || `Add NPC location failed: ${res.statusText}`);
  }
  return res.json();
}
