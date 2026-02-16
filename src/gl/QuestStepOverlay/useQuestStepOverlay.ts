/**
 * useQuestStepOverlay - React hook for managing the quest step GL overlay
 *
 * Provides:
 * - Automatic overlay creation/cleanup
 * - Step display updates
 * - Position management
 * - Integration with settings
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { QuestStepOverlay, OverlayPosition } from "./QuestStepOverlay";

export interface UseQuestStepOverlayOptions {
  /** Whether the overlay is enabled */
  enabled?: boolean;
  /** X position in pixels from left */
  positionX?: number;
  /** Y position in pixels from top */
  positionY?: number;
  /** Font size in pixels (14-22pt range) */
  fontSize?: number;
  /** Callback when all trackable requirements for the step are completed (e.g., all dialog options done) */
  onStepComplete?: () => void;
}

export interface UseQuestStepOverlayReturn {
  /** Show a specific step in the overlay */
  showStep: (
    stepIndex: number,
    totalSteps: number,
    description: string,
    dialogOptions?: string[],
    additionalInfo?: string[],
    requiredItems?: string[],
    recommendedItems?: string[]
  ) => void;
  /** Hide the overlay */
  hide: () => void;
  /** Update overlay position (saves to localStorage) */
  setPosition: (x: number, y: number) => void;
  /** Update position live without saving (for smooth dragging) */
  updatePositionLive: (x: number, y: number) => void;
  /** Commit position after dragging (saves to localStorage) */
  commitPosition: () => void;
  /** Get current position */
  getPosition: () => OverlayPosition;
  /** Get overlay size */
  getSize: () => { width: number; height: number };
  /** Get UI bounds for position clamping */
  getUIBounds: () => { width: number; height: number };
  /** Mark the next dialog option as completed */
  markDialogCompleted: () => void;
  /** Get number of completed dialog options */
  getCompletedDialogCount: () => number;
  /** Get total number of dialog options for current step */
  getTotalDialogCount: () => number;
  /** Whether overlay is available */
  isAvailable: boolean;
  /** Whether overlay is currently showing */
  isShowing: boolean;
}

export function useQuestStepOverlay(
  options: UseQuestStepOverlayOptions = {}
): UseQuestStepOverlayReturn {
  const { enabled = true, positionX = 50, positionY = 50, fontSize = 14, onStepComplete } = options;
  const onStepCompleteRef = useRef(onStepComplete);
  onStepCompleteRef.current = onStepComplete; // Keep ref updated

  const overlayRef = useRef<QuestStepOverlay | null>(null);
  const [isShowing, setIsShowing] = useState(false);
  const [isAvailable, setIsAvailable] = useState(false);

  // Initialize overlay on mount
  useEffect(() => {
    if (!enabled) {
      return;
    }

    const initOverlay = async () => {
      try {
        // Check if patchrs is available
        const patchrs = await import("@injection/util/patchrs_napi");
        if (!patchrs.native) {
          return;
        }

        overlayRef.current = new QuestStepOverlay();
        setIsAvailable(true);
      } catch (e) {
        console.error("[useQuestStepOverlay] Failed to initialize:", e);
      }
    };

    initOverlay();

    return () => {
      if (overlayRef.current) {
        overlayRef.current.dispose();
        overlayRef.current = null;
      }
      setIsAvailable(false);
      setIsShowing(false);
    };
  }, [enabled]);

  // Update overlay position when settings change
  useEffect(() => {
    if (overlayRef.current) {
      overlayRef.current.setPosition(positionX, positionY);
    }
  }, [positionX, positionY]);

  // Update font size when it changes
  useEffect(() => {
    if (overlayRef.current) {
      overlayRef.current.setFontSize(fontSize);
    }
  }, [fontSize]);

  // Show a step
  const showStep = useCallback(
    async (
      stepIndex: number,
      totalSteps: number,
      description: string,
      dialogOptions?: string[],
      additionalInfo?: string[],
      requiredItems?: string[],
      recommendedItems?: string[]
    ) => {
      if (!overlayRef.current || !enabled) {
        return;
      }

      try {
        await overlayRef.current.showStep(
          stepIndex,
          totalSteps,
          description,
          dialogOptions,
          additionalInfo,
          requiredItems,
          recommendedItems
        );
        setIsShowing(true);
      } catch (e) {
        console.error("[useQuestStepOverlay] Failed to show step:", e);
      }
    },
    [enabled]
  );

  // Hide the overlay
  const hide = useCallback(async () => {
    if (!overlayRef.current) {
      return;
    }

    try {
      await overlayRef.current.hide();
      setIsShowing(false);
    } catch (e) {
      console.error("[useQuestStepOverlay] Failed to hide:", e);
    }
  }, []);

  // Set position (saves to localStorage)
  const setPosition = useCallback((x: number, y: number) => {
    if (overlayRef.current) {
      overlayRef.current.setPosition(x, y);
    }
  }, []);

  // Update position live (for smooth dragging, doesn't save)
  const updatePositionLive = useCallback((x: number, y: number) => {
    if (overlayRef.current) {
      overlayRef.current.updatePositionLive(x, y);
    }
  }, []);

  // Commit position after dragging (saves to localStorage)
  const commitPosition = useCallback(() => {
    if (overlayRef.current) {
      overlayRef.current.commitPosition();
    }
  }, []);

  // Get position
  const getPosition = useCallback((): OverlayPosition => {
    return overlayRef.current?.getPosition() ?? { x: 50, y: 50 };
  }, []);

  // Get size
  const getSize = useCallback((): { width: number; height: number } => {
    return overlayRef.current?.getSize() ?? { width: 350, height: 100 };
  }, []);

  // Get UI bounds
  const getUIBounds = useCallback((): { width: number; height: number } => {
    return overlayRef.current?.getUIBounds() ?? { width: 1920, height: 1080 };
  }, []);

  // Mark dialog as completed and check if step is complete
  const markDialogCompleted = useCallback(() => {
    if (overlayRef.current) {
      overlayRef.current.markDialogCompleted();

      // Check if all trackable requirements are now complete
      const completed = overlayRef.current.getCompletedDialogCount();
      const total = overlayRef.current.getTotalDialogCount();

      if (total > 0 && completed >= total) {
        // Small delay to let the UI update show the completion before advancing
        setTimeout(() => {
          onStepCompleteRef.current?.();
        }, 500);
      }
    }
  }, []);

  // Get completed dialog count
  const getCompletedDialogCount = useCallback((): number => {
    return overlayRef.current?.getCompletedDialogCount() ?? 0;
  }, []);

  // Get total dialog count
  const getTotalDialogCount = useCallback((): number => {
    return overlayRef.current?.getTotalDialogCount() ?? 0;
  }, []);

  return {
    showStep,
    hide,
    setPosition,
    updatePositionLive,
    commitPosition,
    getPosition,
    getSize,
    getUIBounds,
    markDialogCompleted,
    getCompletedDialogCount,
    getTotalDialogCount,
    isAvailable,
    isShowing,
  };
}
