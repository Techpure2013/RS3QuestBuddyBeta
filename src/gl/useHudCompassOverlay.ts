/**
 * useHudCompassOverlay - React hook for managing the HUD compass overlay
 *
 * Provides:
 * - Automatic overlay creation/cleanup
 * - Target setting from quest objectives
 * - Position management with persistence
 * - Integration with settings
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { HudCompassOverlay, HudCompassPosition, getHudCompassOverlay } from "./HudCompassOverlay";

export interface UseHudCompassOverlayOptions {
  /** Whether the overlay is enabled */
  enabled?: boolean;
  /** Initial X position in pixels from left */
  positionX?: number;
  /** Initial Y position in pixels from top */
  positionY?: number;
}

export interface UseHudCompassOverlayReturn {
  /** Set target position to point toward (lat/lng in tile coordinates) */
  setTarget: (lat: number, lng: number) => void;
  /** Clear current target */
  clearTarget: () => void;
  /** Update overlay position */
  setPosition: (x: number, y: number) => void;
  /** Get current position */
  getPosition: () => HudCompassPosition;
  /** Get overlay size */
  getSize: () => { width: number; height: number };
  /** Whether overlay is available (native addon loaded) */
  isAvailable: boolean;
  /** Whether overlay is currently showing */
  isShowing: boolean;
}

export function useHudCompassOverlay(
  options: UseHudCompassOverlayOptions = {}
): UseHudCompassOverlayReturn {
  const { enabled = true, positionX, positionY } = options;

  const overlayRef = useRef<HudCompassOverlay | null>(null);
  const [isShowing, setIsShowing] = useState(false);
  const [isAvailable, setIsAvailable] = useState(false);

  // Initialize overlay on mount
  useEffect(() => {
    if (!enabled) {
      return;
    }

    const initOverlay = async () => {
      try {
        // Get singleton instance
        overlayRef.current = getHudCompassOverlay();

        // Initialize if needed
        if (!overlayRef.current.isInitialized()) {
          const success = await overlayRef.current.init();
          if (!success) {
            console.warn("[useHudCompassOverlay] Failed to initialize overlay");
            return;
          }
        }

        setIsAvailable(true);

        // Apply initial position if provided
        if (positionX !== undefined && positionY !== undefined) {
          overlayRef.current.setPosition(positionX, positionY);
        }

        console.log("[useHudCompassOverlay] Initialized");
      } catch (e) {
        console.error("[useHudCompassOverlay] Failed to initialize:", e);
      }
    };

    initOverlay();

    return () => {
      // Don't dispose singleton - just hide it
      if (overlayRef.current) {
        overlayRef.current.setVisible(false);
      }
      setIsAvailable(false);
      setIsShowing(false);
    };
  }, [enabled]);

  // Update position when props change
  useEffect(() => {
    if (overlayRef.current && positionX !== undefined && positionY !== undefined) {
      overlayRef.current.setPosition(positionX, positionY);
    }
  }, [positionX, positionY]);

  // Set target
  const setTarget = useCallback((lat: number, lng: number) => {
    if (!overlayRef.current || !isAvailable) return;

    overlayRef.current.setTarget(lat, lng);

    // Show overlay when target is set
    if (!overlayRef.current.isVisible()) {
      overlayRef.current.setVisible(true);
      setIsShowing(true);
    }
  }, [isAvailable]);

  // Clear target
  const clearTarget = useCallback(() => {
    if (!overlayRef.current) return;

    overlayRef.current.clearTarget();

    // Optionally hide overlay when no target
    // For now, keep it visible but with no glow
  }, []);

  // Set position
  const setPosition = useCallback((x: number, y: number) => {
    if (overlayRef.current) {
      overlayRef.current.setPosition(x, y);
    }
  }, []);

  // Get position
  const getPosition = useCallback((): HudCompassPosition => {
    return overlayRef.current?.getPosition() ?? { x: 1700, y: 900 };
  }, []);

  // Get size
  const getSize = useCallback((): { width: number; height: number } => {
    return overlayRef.current?.getSize() ?? { width: 100, height: 100 };
  }, []);

  return {
    setTarget,
    clearTarget,
    setPosition,
    getPosition,
    getSize,
    isAvailable,
    isShowing,
  };
}
