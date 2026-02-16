import { useEffect, useRef } from 'react';
import { isAlt1GL, getHotkeys } from 'alt1-launcher-api';

interface UseStepHotkeysOptions {
  onNextStep: () => void;
  onPrevStep: () => void;
  enabled?: boolean;
}

export function useStepHotkeys({ onNextStep, onPrevStep, enabled = true }: UseStepHotkeysOptions) {
  // Track registered hotkey IDs for cleanup
  const hotkeyIdsRef = useRef<number[]>([]);

  useEffect(() => {
    if (!enabled || !isAlt1GL()) {
      return;
    }

    const hotkeys = getHotkeys();
    if (!hotkeys) {
      console.warn('[useStepHotkeys] Hotkey API not available');
      return;
    }

    const registerHotkeys = async () => {
      try {
        // Register Shift+, for previous step (<) using accelerator string
        const prevId = await hotkeys.registerAccelerator(
          'Shift+,',
          'quest-step-prev',
          () => {
            onPrevStep();
          }
        );

        // Register Shift+. for next step (>) using accelerator string
        const nextId = await hotkeys.registerAccelerator(
          'Shift+.',
          'quest-step-next',
          () => {
            onNextStep();
          }
        );

        hotkeyIdsRef.current = [prevId, nextId].filter(id => id > 0);
      } catch (e) {
        console.error('[useStepHotkeys] Failed to register hotkeys:', e);
      }
    };

    registerHotkeys();

    return () => {
      // Cleanup: unregister hotkeys
      const ids = hotkeyIdsRef.current;
      if (ids.length > 0 && hotkeys) {
        ids.forEach(id => {
          hotkeys.unregister(id).catch(() => {});
        });
        hotkeyIdsRef.current = [];
      }
    };
  }, [enabled, onNextStep, onPrevStep]);
}
