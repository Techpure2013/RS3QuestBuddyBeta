/**
 * usePathfinding - React hook for pathfinding integration
 *
 * Provides pathfinding capabilities for quest steps:
 * - Calculate paths to NPC/object locations
 * - Track player position and update paths
 * - Visualize path waypoints
 */

import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import type { NpcLocation, QuestStep, NpcHighlight, ObjectHighlight } from "../state/types";
import {
  calculatePath,
  findPath,
  latLngToGameCoords,
  gameCoordsToLatLng,
  calculateDistance,
  type PathResult,
  type PathNode,
  type PathCoordinate,
} from "../api/pathfindingApi";
import {
  findPathClient,
  preloadCollisionData,
  clearCollisionCache,
} from "../api/clientPathfinder";
// Lazy import GL overlay functions
let glOverlays: {
  // 2D tile markers
  drawPathOverlay: typeof import("../gl").drawPathOverlay;
  clearPathOverlay: typeof import("../gl").clearPathOverlay;
  updatePathOverlayFloor: typeof import("../gl").updatePathOverlayFloor;
  drawWaypointMarker: typeof import("../gl").drawWaypointMarker;
  // 3D connected tube markers (used with pathfinding)
  drawPathTubes: typeof import("../gl").drawPathTubes;
  clearPathTubes: typeof import("../gl").clearPathTubes;
} | null = null;

async function getGlOverlays() {
  if (glOverlays) return glOverlays;

  try {
    const gl = await import("../gl");
    glOverlays = {
      drawPathOverlay: gl.drawPathOverlay,
      clearPathOverlay: gl.clearPathOverlay,
      updatePathOverlayFloor: gl.updatePathOverlayFloor,
      drawWaypointMarker: gl.drawWaypointMarker,
      drawPathTubes: gl.drawPathTubes,
      clearPathTubes: gl.clearPathTubes,
    };
    return glOverlays;
  } catch (e) {
    console.warn("[usePathfinding] GL overlays not available:", e);
    return null;
  }
}

// ============================================================================
// Types
// ============================================================================

export interface PathfindingState {
  /** Whether pathfinding is currently computing */
  isComputing: boolean;
  /** The computed path nodes */
  path: PathNode[];
  /** Total distance of the path */
  distance: number;
  /** Estimated travel time (ticks) */
  estimatedTime: number;
  /** Transports used in the path */
  transportsUsed: string[];
  /** Error message if pathfinding failed */
  error: string | null;
  /** Whether pathfinding was successful */
  success: boolean;
}

export interface PathfindingTarget {
  /** Target location in lat/lng */
  location: NpcLocation;
  /** Target floor */
  floor: number;
  /** Target name (NPC or object name) */
  name: string;
  /** Whether this is an NPC or object */
  type: "npc" | "object";
}

export interface UsePathfindingOptions {
  /** Whether to use transports in pathfinding */
  useTransports?: boolean;
  /** Maximum path distance (tiles) */
  maxDistance?: number;
  /** Auto-recalculate when player moves more than this distance */
  recalculateThreshold?: number;
  /** Callback when path is calculated */
  onPathCalculated?: (result: PathResult) => void;
  /** Callback when player reaches destination */
  onDestinationReached?: () => void;
  /** Callback when player uses a transport (teleport, stairs, etc.) */
  onTransportUsed?: (from: PathCoordinate, to: PathCoordinate) => void;
  /** Enable GL overlay visualization (Electron only) */
  enableOverlay?: boolean;
  /** Highlight destination tile */
  highlightDestination?: boolean;
  /** Use client-side pathfinding (faster, but no transport support) */
  useClientPathfinding?: boolean;
  /** Use 3D connected tube markers instead of flat tiles */
  use3DTubes?: boolean;
}

export interface UsePathfindingReturn {
  /** Current pathfinding state */
  state: PathfindingState;
  /** Calculate path from player position to target */
  calculatePathTo: (target: PathfindingTarget) => Promise<void>;
  /** Calculate path from arbitrary start to target */
  calculatePathBetween: (from: PathCoordinate, to: PathCoordinate) => Promise<void>;
  /** Clear current path */
  clearPath: () => void;
  /** Update player position (triggers recalculation if needed) */
  updatePlayerPosition: (position: NpcLocation, floor: number) => void;
  /** Get the next waypoint on the path */
  nextWaypoint: PathNode | null;
  /** Convert path to lat/lng coordinates for visualization */
  pathAsLatLng: Array<{ lat: number; lng: number; floor: number }>;
  /** Extract all targets from a quest step */
  extractTargets: (step: QuestStep) => PathfindingTarget[];
  /** Calculate path to the nearest target in a step */
  calculatePathToStep: (step: QuestStep, playerPosition: NpcLocation, playerFloor: number) => Promise<void>;
  /** Clear collision cache (useful when changing areas) */
  clearCache: () => void;
  /** Preload collision data for an area */
  preloadArea: (x: number, y: number, floor: number, radius?: number) => Promise<void>;
}

// ============================================================================
// Initial State
// ============================================================================

const initialState: PathfindingState = {
  isComputing: false,
  path: [],
  distance: 0,
  estimatedTime: 0,
  transportsUsed: [],
  error: null,
  success: false,
};

// ============================================================================
// Hook Implementation
// ============================================================================

export function usePathfinding(options: UsePathfindingOptions = {}): UsePathfindingReturn {
  const {
    useTransports = true,
    maxDistance,
    recalculateThreshold = 10,
    onPathCalculated,
    onDestinationReached,
    onTransportUsed,
    enableOverlay = true,
    highlightDestination = true,
    useClientPathfinding = true, // Default to client-side for speed
    use3DTubes = false, // Use flat tiles by default, set true for connected tube path
  } = options;

  const [state, setState] = useState<PathfindingState>(initialState);
  const playerPositionRef = useRef<{ position: NpcLocation; floor: number } | null>(null);
  const targetRef = useRef<PathfindingTarget | null>(null);
  const lastCalculationRef = useRef<{ x: number; y: number; floor: number } | null>(null);

  // Calculate path between two coordinates
  const calculatePathBetween = useCallback(
    async (from: PathCoordinate, to: PathCoordinate) => {
      setState((prev) => ({ ...prev, isComputing: true, error: null }));

      try {
        let result: PathResult;

        // Use client-side pathfinding for same-floor paths (faster)
        // Fall back to server for floor changes (requires transport data)
        const sameFloor = from.floor === to.floor;

        if (useClientPathfinding && sameFloor) {
          // Try client-side pathfinding first for same-floor paths
          console.log("[usePathfinding] Using client-side pathfinding");
          const startTime = performance.now();
          result = await findPathClient(from, to, { maxDistance });
          const elapsed = performance.now() - startTime;
          console.log(`[usePathfinding] Client path: ${result.success ? "found" : "failed"} in ${elapsed.toFixed(1)}ms`);

          // If client pathfinding fails and transports are enabled, try server
          if (!result.success && useTransports && result.error !== "Distance exceeds maximum") {
            console.log("[usePathfinding] Falling back to server pathfinding (with transports)");
            result = await calculatePath(from, to, { useTransports, maxDistance });
          }
        } else {
          // Use server pathfinding for floor changes (needs transport routing)
          console.log("[usePathfinding] Using server pathfinding (floor change or client disabled)");
          result = await calculatePath(from, to, { useTransports, maxDistance });
        }

        setState({
          isComputing: false,
          path: result.path,
          distance: result.distance,
          estimatedTime: result.estimatedTime,
          transportsUsed: result.transportsUsed,
          error: result.error || null,
          success: result.success,
        });

        if (result.success) {
          lastCalculationRef.current = from;
          onPathCalculated?.(result);

          // Draw path overlay in Electron
          if (enableOverlay && result.path.length > 0) {
            const gl = await getGlOverlays();
            if (gl) {
              // Convert path nodes to lat/lng for overlay
              const pathLatLng = result.path.map((node) => {
                const coords = gameCoordsToLatLng(node.x, node.y);
                return {
                  lat: coords.lat,
                  lng: coords.lng,
                  floor: node.floor,
                  isTransport: node.isTransport,
                };
              });

              // Use either 3D tubes or flat tile markers
              if (use3DTubes) {
                await gl.drawPathTubes(pathLatLng);
              } else {
                await gl.drawPathOverlay(pathLatLng, {
                  highlightDestination,
                });
              }
            }
          }
        }
      } catch (error) {
        setState({
          ...initialState,
          isComputing: false,
          error: error instanceof Error ? error.message : "Unknown error",
          success: false,
        });
      }
    },
    [useTransports, maxDistance, onPathCalculated, enableOverlay, highlightDestination, useClientPathfinding, use3DTubes]
  );

  // Calculate path to a target
  const calculatePathTo = useCallback(
    async (target: PathfindingTarget) => {
      if (!playerPositionRef.current) {
        setState((prev) => ({
          ...prev,
          error: "Player position not set",
          success: false,
        }));
        return;
      }

      targetRef.current = target;

      const { position, floor } = playerPositionRef.current;
      const from = latLngToGameCoords(position.lat, position.lng);

      const to = latLngToGameCoords(target.location.lat, target.location.lng);

      await calculatePathBetween(
        { x: from.x, y: from.y, floor },
        { x: to.x, y: to.y, floor: target.floor }
      );
    },
    [calculatePathBetween]
  );

  // Clear current path
  const clearPath = useCallback(async () => {
    setState(initialState);
    targetRef.current = null;
    lastCalculationRef.current = null;

    // Clear overlay (both types to be safe)
    if (enableOverlay) {
      const gl = await getGlOverlays();
      if (gl) {
        if (use3DTubes) {
          await gl.clearPathTubes();
        } else {
          await gl.clearPathOverlay();
        }
      }
    }
  }, [enableOverlay, use3DTubes]);

  // Track previous position to detect transport usage
  const prevPositionRef = useRef<{ x: number; y: number; floor: number } | null>(null);

  // Update player position
  const updatePlayerPosition = useCallback(
    (position: NpcLocation, floor: number) => {
      const coords = latLngToGameCoords(position.lat, position.lng);
      const prev = prevPositionRef.current;

      // Detect if player used a transport (large position jump or floor change)
      const usedTransport = prev && (
        Math.abs(coords.x - prev.x) > 15 ||
        Math.abs(coords.y - prev.y) > 15 ||
        floor !== prev.floor
      );

      if (usedTransport && prev) {
        console.log(`[usePathfinding] Transport detected: (${prev.x},${prev.y},${prev.floor}) → (${coords.x},${coords.y},${floor})`);
        onTransportUsed?.(
          { x: prev.x, y: prev.y, floor: prev.floor },
          { x: coords.x, y: coords.y, floor }
        );
      }

      // Update refs
      playerPositionRef.current = { position, floor };
      prevPositionRef.current = { x: coords.x, y: coords.y, floor };

      // Preload collision data around player for faster pathfinding
      if (useClientPathfinding) {
        preloadCollisionData(coords.x, coords.y, floor, 2).catch(() => {
          // Ignore preload errors
        });
      }

      // Check if we have an active path
      if (targetRef.current) {
        // If player used transport, always recalculate from new position
        if (usedTransport) {
          console.log("[usePathfinding] Recalculating path after transport");
          calculatePathTo(targetRef.current);
          return;
        }

        // Normal movement - check if we need to recalculate
        if (lastCalculationRef.current) {
          const last = lastCalculationRef.current;
          const distanceMoved = Math.abs(coords.x - last.x) + Math.abs(coords.y - last.y);

          if (distanceMoved > recalculateThreshold) {
            calculatePathTo(targetRef.current);
          }
        }

        // Check if reached destination
        if (state.path.length > 0) {
          const dest = state.path[state.path.length - 1];
          const distToDest = Math.abs(coords.x - dest.x) + Math.abs(coords.y - dest.y);
          const sameFloor = dest.floor === floor;

          if (distToDest <= 2 && sameFloor) {
            onDestinationReached?.();
          }
        }
      }
    },
    [recalculateThreshold, calculatePathTo, onDestinationReached, onTransportUsed, state.path, useClientPathfinding]
  );

  // Get next waypoint
  const nextWaypoint = useMemo((): PathNode | null => {
    if (!playerPositionRef.current || state.path.length === 0) {
      return null;
    }

    const { position, floor } = playerPositionRef.current;
    const playerCoords = latLngToGameCoords(position.lat, position.lng);

    // Find the next waypoint that hasn't been reached
    for (const node of state.path) {
      const dist = Math.abs(node.x - playerCoords.x) + Math.abs(node.y - playerCoords.y);
      if (dist > 2 || node.floor !== floor) {
        return node;
      }
    }

    // All waypoints reached, return last one
    return state.path[state.path.length - 1] || null;
  }, [state.path]);

  // Convert path to lat/lng for visualization
  const pathAsLatLng = useMemo(() => {
    return state.path.map((node) => {
      const latLng = gameCoordsToLatLng(node.x, node.y);
      return {
        lat: latLng.lat,
        lng: latLng.lng,
        floor: node.floor,
      };
    });
  }, [state.path]);

  // Extract targets from a quest step
  const extractTargets = useCallback((step: QuestStep): PathfindingTarget[] => {
    const targets: PathfindingTarget[] = [];

    // Extract NPC targets
    if (step.highlights.npc) {
      for (const npc of step.highlights.npc) {
        if (npc.npcLocation) {
          targets.push({
            location: npc.npcLocation,
            floor: npc.floor ?? step.floor ?? 0,
            name: npc.npcName,
            type: "npc",
          });
        }
      }
    }

    // Extract object targets
    if (step.highlights.object) {
      for (const obj of step.highlights.object) {
        if (obj.objectLocation && obj.objectLocation.length > 0) {
          // Use first location point
          const loc = obj.objectLocation[0];
          targets.push({
            location: { lat: loc.lat, lng: loc.lng },
            floor: obj.floor ?? step.floor ?? 0,
            name: obj.name,
            type: "object",
          });
        }
      }
    }

    return targets;
  }, []);

  // Calculate path to nearest target in a step
  const calculatePathToStep = useCallback(
    async (step: QuestStep, playerPosition: NpcLocation, playerFloor: number) => {
      playerPositionRef.current = { position: playerPosition, floor: playerFloor };

      const targets = extractTargets(step);

      if (targets.length === 0) {
        setState((prev) => ({
          ...prev,
          error: "No targets found in step",
          success: false,
        }));
        return;
      }

      // Find nearest target on same floor first, then other floors
      let nearestTarget: PathfindingTarget | null = null;
      let nearestDistance = Infinity;

      for (const target of targets) {
        const dist = calculateDistance(playerPosition, target.location);
        // Prioritize same-floor targets
        const floorPenalty = target.floor === playerFloor ? 0 : 1000;
        const adjustedDist = dist + floorPenalty;

        if (adjustedDist < nearestDistance) {
          nearestDistance = adjustedDist;
          nearestTarget = target;
        }
      }

      if (nearestTarget) {
        await calculatePathTo(nearestTarget);
      }
    },
    [extractTargets, calculatePathTo]
  );

  // Clear collision cache
  const clearCache = useCallback(() => {
    clearCollisionCache();
  }, []);

  // Preload collision data for an area
  const preloadArea = useCallback(
    async (x: number, y: number, floor: number, radius: number = 2) => {
      await preloadCollisionData(x, y, floor, radius);
    },
    []
  );

  return {
    state,
    calculatePathTo,
    calculatePathBetween,
    clearPath,
    updatePlayerPosition,
    nextWaypoint,
    pathAsLatLng,
    extractTargets,
    calculatePathToStep,
    clearCache,
    preloadArea,
  };
}

export default usePathfinding;
