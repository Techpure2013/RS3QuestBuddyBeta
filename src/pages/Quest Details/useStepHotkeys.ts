import { useEffect, useRef } from 'react';
import { isAlt1GL, getHotkeys } from 'alt1-launcher-api';

interface UseStepHotkeysOptions {
  onNextStep: () => void;
  onPrevStep: () => void;
  enabled?: boolean;
  /** Alt1 accelerator string for next step (e.g. "Shift+.") */
  nextStepHotkey?: string;
  /** Alt1 accelerator string for previous step (e.g. "Shift+,") */
  prevStepHotkey?: string;
}

export function useStepHotkeys({
  onNextStep,
  onPrevStep,
  enabled = true,
  nextStepHotkey = 'Shift+.',
  prevStepHotkey = 'Shift+,',
}: UseStepHotkeysOptions) {
  // Track registered hotkey IDs for cleanup
  const hotkeyIdsRef = useRef<number[]>([]);

  // Stabilize callbacks via refs to prevent re-registering on every render
  const onNextStepRef = useRef(onNextStep);
  onNextStepRef.current = onNextStep;
  const onPrevStepRef = useRef(onPrevStep);
  onPrevStepRef.current = onPrevStep;

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
        // Register previous step hotkey using user-configured accelerator
        const prevId = await hotkeys.registerAccelerator(
          prevStepHotkey,
          'quest-step-prev',
          () => {
            onPrevStepRef.current();
          }
        );

        // Register next step hotkey using user-configured accelerator
        const nextId = await hotkeys.registerAccelerator(
          nextStepHotkey,
          'quest-step-next',
          () => {
            onNextStepRef.current();
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
  }, [enabled, nextStepHotkey, prevStepHotkey]);
}
