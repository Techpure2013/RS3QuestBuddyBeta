/**
 * NPC Buffer Hash Utilities
 *
 * Computes buffer hashes from NPC mesh data for identification.
 * Uses the same approach as renderprogram.ts generateMeshMeta for compatibility.
 * Returns hex strings like "0x1A2B3C4D" for easy JSON/code use.
 */

import { RenderInvocation } from "../util/patchrs_napi";
import { generateMeshMeta, getProgramMeta } from "../render/renderprogram";
import { NpcBufferHashes, NpcMeshGroupInfo } from "./npcTypes";
import { CrcBuilder } from "../util/crc32";
import type { NpcMeshGroup } from "./npcOverlay";

/**
 * Convert a 32-bit number to a hex string with 0x prefix
 * Handles unsigned 32-bit values correctly (avoids negative number issues)
 */
export function toHexHash(num: number): string {
  // Use >>> 0 to convert to unsigned 32-bit, then pad to 8 chars
  return "0x" + ((num >>> 0).toString(16).toUpperCase().padStart(8, "0"));
}

/**
 * Parse a hex hash string back to a number
 * Handles both "0x..." and plain hex strings
 */
export function fromHexHash(hex: string): number {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return parseInt(clean, 16) >>> 0; // >>> 0 ensures unsigned
}

/**
 * Compute the position buffer hash using the same method as npcview/renderprogram
 * This uses CrcBuilder with addUint16 for each x,y,z vertex component
 * Returns hex string like "0x1A2B3C4D"
 */
export function computePosBufferHash(render: RenderInvocation): string | null {
  const progmeta = getProgramMeta(render.program);
  if (!progmeta.aPos) {
    return null;
  }

  try {
    const meshMeta = generateMeshMeta(render, progmeta);
    return toHexHash(meshMeta.posbufferhash);
  } catch {
    return null;
  }
}

/**
 * Extract all buffer hashes from a render invocation
 * Uses generateMeshMeta for compatibility with npcview
 * Returns hex strings like "0x1A2B3C4D" and numeric hash for fast comparison
 */
export function extractBufferHashes(
  render: RenderInvocation
): NpcBufferHashes & { posBufferHashNum: number } {
  const progmeta = getProgramMeta(render.program);

  if (!progmeta.aPos) {
    // No position attribute, return empty hashes
    return {
      posBufferHash: "0x00000000",
      posBufferHashNum: 0,
      vertexCount: 0,
    };
  }

  try {
    const meshMeta = generateMeshMeta(render, progmeta);
    const hashNum = meshMeta.posbufferhash >>> 0; // Ensure unsigned
    return {
      posBufferHash: toHexHash(hashNum),
      posBufferHashNum: hashNum,
      vertexCount: meshMeta.vertexcount,
    };
  } catch (e) {
    // Fallback if mesh meta generation fails
    console.warn("[extractBufferHashes] Failed to generate mesh meta:", e);
    return {
      posBufferHash: "0x00000000",
      posBufferHashNum: 0,
      vertexCount: render.vertexArray.indexBuffer?.length || 0,
    };
  }
}

/**
 * Check if two buffer hash sets match
 * Primary identification is via posBufferHash (same as npcview)
 * Now uses fast numeric comparison
 */
export function hashesMatch(
  a: NpcBufferHashes & { posBufferHashNum?: number },
  b: NpcBufferHashes & { posBufferHashNum?: number },
  useVertexCountFallback = true
): boolean {
  // Primary match: position buffer hash using fast numeric comparison
  // Use numeric if available, fallback to string comparison
  if (a.posBufferHashNum !== undefined && b.posBufferHashNum !== undefined) {
    if (a.posBufferHashNum !== 0 && b.posBufferHashNum !== 0) {
      if (a.posBufferHashNum === b.posBufferHashNum) return true;
    }
  } else if (a.posBufferHash !== "0x00000000" && b.posBufferHash !== "0x00000000") {
    // Fallback to string comparison if numeric not available
    if (a.posBufferHash.toLowerCase() === b.posBufferHash.toLowerCase()) return true;
  }

  // Fallback: vertex count (less reliable but useful for edge cases)
  if (useVertexCountFallback) {
    return a.vertexCount === b.vertexCount && a.vertexCount > 0;
  }

  return false;
}

/**
 * Get a simple hash identifier string for debugging
 */
export function getHashId(hashes: NpcBufferHashes): string {
  return `pos:${hashes.posBufferHash}_vc:${hashes.vertexCount}`;
}

/**
 * Compute a combined hash from multiple render invocations.
 * This combines UNIQUE mesh parts into a single hash (deduplicates repeats).
 * Death has 4 unique meshes repeated 6x each - we only want the 4 unique ones.
 *
 * @param renders Array of render invocations belonging to the same entity (same model matrix)
 * @returns Combined hash as both hex string and number for fast comparison
 */
export function computeCombinedHash(renders: RenderInvocation[]): { hex: string; num: number } {
  if (renders.length === 0) {
    return { hex: "0x00000000", num: 0 };
  }

  // Collect UNIQUE hashes only (use Set to deduplicate)
  const uniqueHashes = new Set<number>();

  for (const render of renders) {
    const progmeta = getProgramMeta(render.program);
    if (!progmeta.aPos) continue;

    try {
      const meshMeta = generateMeshMeta(render, progmeta);
      uniqueHashes.add(meshMeta.posbufferhash >>> 0); // Ensure unsigned, Set dedupes
    } catch {
      // Skip meshes that fail to generate meta
    }
  }

  if (uniqueHashes.size === 0) {
    return { hex: "0x00000000", num: 0 };
  }

  // Convert to array and sort for consistent ordering
  const individualHashes = Array.from(uniqueHashes).sort((a, b) => a - b);

  // Combine all hashes into one using CRC
  const combined = new CrcBuilder();

  // Add each individual hash to the combined hash
  for (const hash of individualHashes) {
    combined.addUint32(hash);
  }

  const num = combined.get() >>> 0; // Ensure unsigned
  return { hex: toHexHash(num), num };
}

/**
 * Extract hashes from multiple renders (for grouped mesh data)
 * Returns both the main mesh hash and the combined hash of all parts
 * Includes numeric hashes for fast bitwise comparison
 */
export function extractGroupedHashes(
  renders: RenderInvocation[]
): NpcBufferHashes & { combinedHash: string; combinedHashNum: number; posBufferHashNum: number; meshCount: number } {
  // Find the "main" mesh (one with bones, or largest vertex count)
  let mainRender: RenderInvocation | null = null;
  let mainVertexCount = 0;

  for (const render of renders) {
    const progmeta = getProgramMeta(render.program);
    if (progmeta.uBones && progmeta.isMainMesh) {
      // Prefer mesh with bones (the body)
      const vc = render.vertexArray.indexBuffer?.length || 0;
      if (!mainRender || vc > mainVertexCount) {
        mainRender = render;
        mainVertexCount = vc;
      }
    }
  }

  // Fallback to largest mesh if no bones found
  if (!mainRender) {
    for (const render of renders) {
      const vc = render.vertexArray.indexBuffer?.length || 0;
      if (vc > mainVertexCount) {
        mainRender = render;
        mainVertexCount = vc;
      }
    }
  }

  // Get main mesh hash (now includes numeric version)
  const mainHashes = mainRender ? extractBufferHashes(mainRender) : {
    posBufferHash: "0x00000000",
    posBufferHashNum: 0,
    vertexCount: 0,
  };

  // Get combined hash from all meshes (now returns both hex and numeric)
  const combined = computeCombinedHash(renders);

  // Calculate total vertex count
  let totalVertexCount = 0;
  for (const render of renders) {
    totalVertexCount += render.vertexArray.indexBuffer?.length || 0;
  }

  return {
    posBufferHash: mainHashes.posBufferHash,
    posBufferHashNum: mainHashes.posBufferHashNum,
    combinedHash: combined.hex,
    combinedHashNum: combined.num,
    meshCount: renders.length,
    vertexCount: totalVertexCount,
  };
}

/**
 * Convert a full NpcMeshGroup to a lightweight NpcMeshGroupInfo.
 * This extracts only the computed data needed for the UI, avoiding
 * storage of large buffer data from RenderInvocation objects.
 */
export function toMeshGroupInfo(group: NpcMeshGroup): NpcMeshGroupInfo {
  const hashes = extractGroupedHashes(group.renders);

  return {
    combinedHash: hashes.combinedHash,
    meshCount: group.meshCount,
    totalVertexCount: group.totalVertexCount,
    mainMeshVaoId: group.mainMesh.vaoId,
    position: {
      x: group.mainMesh.position.x,
      y: group.mainMesh.position.y,
      z: group.mainMesh.position.z,
    },
  };
}

/**
 * Convert an array of NpcMeshGroups to lightweight NpcMeshGroupInfo array.
 * Use this when storing groups in React state to avoid memory leaks.
 */
export function toMeshGroupInfos(groups: NpcMeshGroup[]): NpcMeshGroupInfo[] {
  return groups.map(toMeshGroupInfo);
}
