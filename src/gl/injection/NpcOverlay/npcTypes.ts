/**
 * NPC Types for VAO Collection
 *
 * Types for identifying NPCs by their buffer hashes and integrating
 * with the RS3QuestBuddy NPC database.
 */

/**
 * Location entry for an NPC
 */
export interface NpcLocationEntry {
  lat: number;
  lng: number;
  floor: number;
}

/**
 * Action entry - maps index to action name
 */
export type NpcAction = Record<`${number}`, string | null>;

/**
 * Action cursor entry - maps index to cursor type
 */
export type NpcActionCursor = Record<`${number}`, number | null>;

/**
 * NPC data from the RS3QuestBuddy database
 */
export interface NpcDbEntry {
  /** RuneScape NPC ID */
  id: number;
  /** NPC display name */
  name: string;
  /** Model IDs used by this NPC */
  models?: number[];
  /** Head model IDs (for chatheads) */
  head_models?: number[];
  /** Color replacement pairs [original, replacement] */
  color_replacements?: [number, number][];
  /** Material replacement pairs [original, replacement] */
  material_replacements?: [number, number][];
  /** NPC actions (right-click menu) */
  actions?: NpcAction[];
  /** Cursor types for each action */
  action_cursors?: NpcActionCursor[];
  /** Known locations */
  location?: NpcLocationEntry[];
  /** Combat levels (can vary) */
  npc_combat_level?: number[];
  /** Animation group IDs */
  animation_group?: number[];
  /** Movement capability flags */
  movement_capabilities?: number[];
  /** Size in tiles */
  bound_size?: number;
  /** Position buffer hash - hex string like "0x1A2B3C4D" */
  buffer_hash?: string;
  /** Created timestamp */
  created_at?: string;
  /** Updated timestamp */
  updated_at?: string;
}

/**
 * Simplified NPC search result from the API
 * Note: Server returns one entry per location, so same NPC may appear multiple times
 */
export interface NpcSearchResult {
  id: number;
  name: string;
  lat: number;
  lng: number;
  floor: number;
}

/**
 * Grouped NPC search result - all locations for a single NPC
 */
export interface NpcSearchResultGrouped {
  id: number;
  name: string;
  locations: NpcLocationEntry[];
}

/**
 * NPC identification result - combines mesh data with DB lookup
 */
export interface NpcIdentification {
  /** The scanned mesh data */
  mesh: import("./npcOverlay").NpcMesh;
  /** Matched database entry (if found) */
  dbEntry?: NpcDbEntry;
  /** Whether identification was successful */
  identified: boolean;
  /** Confidence level (based on match type) */
  confidence: "high" | "medium" | "low" | "none";
  /** How the NPC was identified */
  matchType?: "buffer_hash" | "vertex_count" | "combined";
}

/**
 * Buffer hash info extracted from an NPC mesh
 */
export interface NpcBufferHashes {
  /** CRC32 of the position buffer as hex string (e.g., "0x1A2B3C4D") */
  posBufferHash: string;
  /** CRC32 of the index buffer as hex string */
  indexBufferHash?: string;
  /** Combined hash of all vertex data as hex string */
  combinedHash?: string;
  /** Vertex count (for fallback identification) */
  vertexCount: number;
}

/**
 * NPC collection entry - for building the local database
 */
export interface NpcCollectionEntry {
  /** Buffer hashes for this NPC */
  hashes: NpcBufferHashes;
  /** RS NPC ID (if known) */
  npcId?: number;
  /** NPC name (if known) */
  name?: string;
  /** Screen position when captured */
  screenPos?: { x: number; y: number };
  /** World position when captured */
  worldPos?: { x: number; y: number; z: number };
  /** Timestamp of capture */
  capturedAt: string;
  /** Additional notes */
  notes?: string;
}

/**
 * Local NPC collection database
 */
export interface NpcCollection {
  version: number;
  lastUpdated: string;
  entries: NpcCollectionEntry[];
}

/**
 * API configuration for RS3QuestBuddy
 */
export interface NpcApiConfig {
  /** Base URL for the API */
  baseUrl: string;
  /** Request timeout in ms */
  timeout?: number;
}

/**
 * Response from NPC lookup by buffer hash
 */
export interface NpcLookupResponse {
  found: boolean;
  npc?: NpcDbEntry;
  matchType?: "buffer_hash" | "vertex_count";
}

/**
 * Lightweight NPC mesh group info - stores only computed data, no buffer data.
 * Use this for React state to avoid memory issues from storing RenderInvocation objects.
 */
export interface NpcMeshGroupInfo {
  /** Combined hash (pre-computed from all meshes) */
  combinedHash: string;
  /** Number of meshes in this group */
  meshCount: number;
  /** Total vertex count across all meshes */
  totalVertexCount: number;
  /** VAO ID of the main mesh (for identification) */
  mainMeshVaoId: number;
  /** Position of the main mesh */
  position: { x: number; y: number; z: number };
  /** Individual mesh hashes (for detailed view if needed) */
  meshHashes?: string[];
}

/**
 * Batch lookup request (hex strings)
 */
export interface NpcBatchLookupRequest {
  hashes: string[];
}

/**
 * Batch lookup response
 */
export interface NpcBatchLookupResponse {
  results: {
    hash: string;
    found: boolean;
    npc?: NpcDbEntry;
  }[];
}
