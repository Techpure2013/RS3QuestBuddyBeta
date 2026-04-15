/**
 * useGlQuestIntegration - React hook for GL-based quest integration
 *
 * Provides a unified interface for:
 * - NPC/Object overlay management
 * - Dialog detection and solving
 *
 * NOTE: Dialog detection uses ts/DialogBoxReader/reader.ts directly.
 * Automatically detects if GL injection is available and falls back gracefully
 * when not available.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { isGlInjectionAvailable } from "../api/glInjection";
import type { QuestStep } from "../state/types";
import {
	activateStepOverlays,
	deactivateStepOverlays,
	isOverlayActive,
	setWanderRadiusEnabled,
	onPlayerFloorChanged,
} from "./QuestOverlayManager";
import { setFloorChangeCallback } from "./PlayerPositionTracker";
import { onResolutionChange } from "./UIScaleManager";
import { DialogBoxReader, DialogBoxResult } from "@injection/DialogBoxReader/reader";
import { SpriteOverlay } from "@injection/util/spriteOverlay";

interface GlQuestIntegrationOptions {
	/** Whether dialog solver/detection is enabled (controlled by settings) */
	dialogSolverEnabled?: boolean;
	/** Whether compass overlay on NPCs is enabled (controlled by settings) */
	compassOverlayEnabled?: boolean;
	/** Whether wander radius overlay is enabled */
	wanderRadiusEnabled?: boolean;
	/** Callback when a dialog option is completed (player clicked the highlighted button) */
	onDialogCompleted?: () => void;
}

interface GlQuestIntegrationReturn {
	onStepActivated: (step: QuestStep, stepIndex: number) => Promise<void>;
	onStepDeactivated: () => Promise<void>;
	/** Whether GL injection is available */
	isGlAvailable: boolean;
	/** Whether GL systems are fully initialized (dialog reader, overlays ready) */
	isGlReady: boolean;
	isOverlayActive: boolean;
}

export function useGlQuestIntegration(
	options: GlQuestIntegrationOptions = {}
): GlQuestIntegrationReturn {
	const {
		dialogSolverEnabled = false,
		compassOverlayEnabled = false,
		wanderRadiusEnabled = true,
		onDialogCompleted,
	} = options;
	const currentStepIndexRef = useRef<number>(-1);
	const currentStepRef = useRef<QuestStep | null>(null);

	// Stabilize onDialogCompleted via ref to prevent cascading re-renders.
	// Without this, the inline arrow function from questpage creates a new reference
	// every render, which invalidates handleDialogDetection → startDialogDetection →
	// the effect that starts/stops the stream, causing an infinite stop/start cycle
	// where the dialog reader never processes any frames.
	const onDialogCompletedRef = useRef(onDialogCompleted);
	onDialogCompletedRef.current = onDialogCompleted;

	// Track when GL systems are fully initialized
	const [isGlReady, setIsGlReady] = useState(false);

	// Dialog detection refs
	const dialogReaderRef = useRef<DialogBoxReader | null>(null);
	const spriteOverlayRef = useRef<SpriteOverlay | null>(null);
	const dialogOverlayHandleRef = useRef<any>(null);
	const currentDialogOptionsRef = useRef<string[]>([]);
	const lastHighlightedButtonRef = useRef<{ text: string; x: number; y: number } | null>(null);
	const noDialogFrameCountRef = useRef<number>(0);
	const NO_DIALOG_CLEAR_THRESHOLD = 3; // Wait 3 frames before clearing
	// Track if we've already processed a pressed state for the current highlight
	// This prevents multiple completions while the button stays pressed across frames
	const pressedHandledRef = useRef<boolean>(false);
	// Track which button was just pressed with a timestamp for cooldown-based debouncing
	// Using cooldown instead of release detection because release detection was unreliable
	// (multiple buttons with same text could trigger false release detection)
	const lastPressedButtonRef = useRef<{ text: string; x: number; y: number; timestamp: number } | null>(null);
	const PRESS_COOLDOWN_MS = 500; // Minimum time before same button can trigger again
	// Track if we're waiting for the user to release the mouse button
	// After a press is detected, we need to see brightness return to NORMAL before allowing another detection
	// This prevents double-completion when user holds mouse for >500ms (cooldown alone isn't enough)
	const waitingForReleaseRef = useRef<boolean>(false);
	// Track when button was highlighted (for logging purposes)
	const highlightTimestampRef = useRef<number>(0);
	// Track previous brightness of highlighted button for transition detection
	// Only the highlighted button gets transition detection (normal→high = missed press)
	const prevHighlightBrightnessRef = useRef<number | null>(null);
	// Track completion counts for each dialog text
	// Uses Map<text, count> to handle duplicate options like ["Yes.", "Yes.", "Yes."]
	// Only marks "already completed" when count >= expected occurrences in dialog options
	const completedDialogCountsRef = useRef<Map<string, number>>(new Map());

	// Initialize dialog reader and sprite overlay
	useEffect(() => {
		if (!isGlInjectionAvailable()) return;

		let resolutionCleanup: (() => void) | null = null;

		const initDialog = async () => {
			try {
				const reader = new DialogBoxReader();
				await reader.init();
				dialogReaderRef.current = reader;
				console.log("[GlQuest] DialogBoxReader initialized");

				spriteOverlayRef.current = new SpriteOverlay();

				// Mark GL as ready now that core systems are initialized
				setIsGlReady(true);

				// Listen for resolution changes to invalidate sprite overlay cache
				resolutionCleanup = onResolutionChange((info) => {
					console.log(`[GlQuest] Resolution changed to ${info.screenWidth}x${info.screenHeight}, invalidating sprite overlay`);
					if (spriteOverlayRef.current) {
						// invalidateCache() now also calls stopAll() to prevent stacking
						spriteOverlayRef.current.invalidateCache();
					}
					// Clear our handle reference since invalidateCache() stopped all overlays
					dialogOverlayHandleRef.current = null;
					// Reset the last highlighted button so overlay will be recreated on next detection
					lastHighlightedButtonRef.current = null;
				});
			} catch (e) {
				console.error("[GlQuest] Failed to init dialog reader:", e);
			}
		};

		initDialog();

		// Register floor change callback to recreate tile overlays after ladder/stairs
		setFloorChangeCallback((newFloor, _oldFloor) => {
			onPlayerFloorChanged(newFloor).catch(e =>
				console.warn("[GlQuest] Floor change overlay refresh error:", e)
			);
		});

		return () => {
			// Cleanup floor change listener
			setFloorChangeCallback(null);
			// Cleanup resolution listener
			if (resolutionCleanup) {
				resolutionCleanup();
			}
			// Cleanup dialog reader
			if (dialogReaderRef.current?.isRunning()) {
				dialogReaderRef.current.stop();
			}
			// Cleanup overlay
			if (dialogOverlayHandleRef.current && spriteOverlayRef.current) {
				spriteOverlayRef.current.stop(dialogOverlayHandleRef.current);
				dialogOverlayHandleRef.current = null;
			}
			// Reset ready state
			setIsGlReady(false);
		};
	}, []);

	// Handle dialog detection results
	const handleDialogDetection = useCallback(async (result: DialogBoxResult | null) => {
		const options = currentDialogOptionsRef.current;

		// Clear overlay if no dialog detected, no options, or no buttons
		// But use debouncing to avoid flickering from intermittent detection failures
		if (!result || !options.length || !result.buttons.length) {
			noDialogFrameCountRef.current++;

			// Only clear after multiple consecutive frames of no dialog
			if (noDialogFrameCountRef.current >= NO_DIALOG_CLEAR_THRESHOLD) {
				if (dialogOverlayHandleRef.current && spriteOverlayRef.current) {
					const lastBtn = lastHighlightedButtonRef.current;
					const prevBr = prevHighlightBrightnessRef.current;
					const timeSinceHighlight = Date.now() - highlightTimestampRef.current;

					// TRANSITION DETECTION ON CLOSE: If we had a highlighted button with normal brightness,
					// and the dialog closed (sprites gone), the user clicked that button.
					// This catches fast clicks where the high-brightness frame was never captured.
					const NORMAL_MIN = 0.15;
					const NORMAL_MAX = 0.35;
					const wasNormal = prevBr !== null && prevBr >= NORMAL_MIN && prevBr <= NORMAL_MAX;

					if (lastBtn && wasNormal && !pressedHandledRef.current && !waitingForReleaseRef.current) {
						const currentCount = completedDialogCountsRef.current.get(lastBtn.text) ?? 0;
						const expectedCount = currentDialogOptionsRef.current.filter(opt => opt === lastBtn.text).length;
						const alreadyCompleted = currentCount >= expectedCount;

						if (!alreadyCompleted) {
							pressedHandledRef.current = true;
							waitingForReleaseRef.current = true;
							lastPressedButtonRef.current = { text: lastBtn.text, x: lastBtn.x, y: lastBtn.y, timestamp: Date.now() };
							completedDialogCountsRef.current.set(lastBtn.text, currentCount + 1);
							onDialogCompletedRef.current?.();
						}
					}

					await spriteOverlayRef.current.stop(dialogOverlayHandleRef.current);
					dialogOverlayHandleRef.current = null;
					lastHighlightedButtonRef.current = null;
					highlightTimestampRef.current = 0;
					prevHighlightBrightnessRef.current = null;
				}
			}
			return;
		}

		// Dialog detected - reset the no-dialog counter
		noDialogFrameCountRef.current = 0;

		// Check if we're waiting for user to release the mouse button
		// After a press is detected via brightness, we wait for brightness to return to NORMAL
		// before allowing another press detection. This handles long mouse holds (>500ms).
		if (waitingForReleaseRef.current && lastPressedButtonRef.current) {
			// Look for the button that was just pressed
			const lastPressed = lastPressedButtonRef.current;
			const sameButton = result.buttons.find(btn =>
				btn.text === lastPressed.text &&
				Math.abs(btn.bg.x - lastPressed.x) < 5 &&
				Math.abs(btn.bg.y - lastPressed.y) < 5
			);

			// If the button exists and is NOT pressed (brightness returned to normal),
			// the user has released the mouse
			if (sameButton && !sameButton.pressed) {
				const elapsed = Date.now() - lastPressed.timestamp;
				// Also require minimum cooldown time to prevent super-fast re-clicks
				if (elapsed > PRESS_COOLDOWN_MS) {
					waitingForReleaseRef.current = false;
					lastPressedButtonRef.current = null;
					pressedHandledRef.current = false;
				}
			}
			// If button is still pressed or doesn't exist, keep waiting
		}

		// Check if the highlighted button is in pressed state (pixel brightness detection)
		// This is the most reliable way to detect a click - the callback fires twice:
		// 1. Initial detection with pressed=false
		// 2. After async brightness sampling with pressed=true when clicked
		const lastBtn = lastHighlightedButtonRef.current;
		if (lastBtn && dialogOverlayHandleRef.current) {
			const matchingButton = result.buttons.find(btn =>
				btn.text === lastBtn.text &&
				Math.abs(btn.bg.x - lastBtn.x) < 5 &&
				Math.abs(btn.bg.y - lastBtn.y) < 5
			);

			// Transition detection for THIS specific highlighted button only
			// If brightness was normal (0.15-0.35) and is now high (>0.5), we missed the pressed frame
			const NORMAL_MIN = 0.15;
			const NORMAL_MAX = 0.35;
			const GONE_THRESHOLD = 0.5;
			const prevBr = prevHighlightBrightnessRef.current;
			const currBr = matchingButton?.brightness;

			const wasNormal = prevBr !== null && prevBr >= NORMAL_MIN && prevBr <= NORMAL_MAX;
			const isGone = currBr !== undefined && currBr > GONE_THRESHOLD;
			const transitionDetected = wasNormal && isGone;

			// Update previous brightness for next check
			if (currBr !== undefined) {
				prevHighlightBrightnessRef.current = currBr;
			}

			// Button is pressed via direct detection OR transition detection
			const isPressed = matchingButton?.pressed || transitionDetected;

			// Check if our highlighted button is in pressed state
			if (isPressed) {
				// Only trigger completion if:
				// 1. We haven't already handled this press
				// 2. We're not waiting for user to release from a previous press
				// 3. This dialog text hasn't reached its expected completion count
				// (handles cases like ["Yes.", "Yes.", "Yes."] where same text appears multiple times)
				const currentCount = completedDialogCountsRef.current.get(lastBtn.text) ?? 0;
				const expectedCount = currentDialogOptionsRef.current.filter(opt => opt === lastBtn.text).length;
				const alreadyCompleted = currentCount >= expectedCount;

				if (!pressedHandledRef.current && !waitingForReleaseRef.current && !alreadyCompleted) {
					pressedHandledRef.current = true;
					waitingForReleaseRef.current = true; // Wait for brightness to return to normal
					// Remember which button was pressed with timestamp for cooldown-based debouncing
					lastPressedButtonRef.current = { text: lastBtn.text, x: lastBtn.x, y: lastBtn.y, timestamp: Date.now() };
					// Increment completion count for this dialog text
					completedDialogCountsRef.current.set(lastBtn.text, currentCount + 1);
					await spriteOverlayRef.current?.stop(dialogOverlayHandleRef.current);
					dialogOverlayHandleRef.current = null;
					lastHighlightedButtonRef.current = null;
					onDialogCompletedRef.current?.();
				}
				return;
			}
			// NOTE: We no longer reset pressedHandledRef/lastPressedButtonRef here
			// That's handled in the release detection block above

			if (!matchingButton) {
				await spriteOverlayRef.current?.stop(dialogOverlayHandleRef.current);
				dialogOverlayHandleRef.current = null;
				lastHighlightedButtonRef.current = null;
				onDialogCompletedRef.current?.();
			}
		}

		// Find matching button
		for (let i = 0; i < result.buttons.length; i++) {
			const btn = result.buttons[i];
			const btnText = btn.text.toLowerCase().trim();

			// Skip if this is the button we just pressed - REGARDLESS of current pressed state
			// The async brightness detection means btn.pressed may be false in early callbacks
			// even though the button is still being held. We only clear lastPressedButtonRef
			// when we explicitly detect the button in released state (done above).
			const lastPressed = lastPressedButtonRef.current;
			if (lastPressed && btn.text === lastPressed.text &&
				Math.abs(btn.bg.x - lastPressed.x) < 5 && Math.abs(btn.bg.y - lastPressed.y) < 5) {
				// Button was just pressed, wait for explicit release detection
				continue;
			}

			for (const option of options) {
				const optLower = option.toLowerCase().trim();

				// Numeric match
				const num = parseInt(option, 10);
				if (!isNaN(num) && num > 0 && i === num - 1) {
					// Check if this is the same button we already highlighted
					const lastBtn = lastHighlightedButtonRef.current;
					if (lastBtn && lastBtn.text === btn.text &&
						Math.abs(lastBtn.x - btn.bg.x) < 5 && Math.abs(lastBtn.y - btn.bg.y) < 5) {
						return; // Same button, skip
					}
					await highlightButton(btn);
					return;
				}

				// Text match
				if (btnText.includes(optLower) || optLower.includes(btnText)) {
					// Check if this is the same button we already highlighted
					const lastBtn = lastHighlightedButtonRef.current;
					if (lastBtn && lastBtn.text === btn.text &&
						Math.abs(lastBtn.x - btn.bg.x) < 5 && Math.abs(lastBtn.y - btn.bg.y) < 5) {
						return; // Same button, skip
					}
					await highlightButton(btn);
					return;
				}
			}
		}

		// No match found - but don't clear overlay immediately
		// The dialog is present but no matching option, keep existing highlight if any
	}, []); // Stable: onDialogCompleted accessed via ref to prevent re-render cascade

	// Highlight a dialog button with overlay
	const highlightButton = async (btn: any) => {
		if (!spriteOverlayRef.current) return;

		// Set the ref IMMEDIATELY to prevent duplicate async calls from creating multiple overlays
		// This is checked before the async operations complete
		const buttonInfo = { text: btn.text, x: btn.bg.x, y: btn.bg.y };
		lastHighlightedButtonRef.current = buttonInfo;

		// Check if we're waiting for release from a DIFFERENT button
		// The "waiting for release" mechanism prevents the SAME button from double-triggering,
		// but should NOT block press detection on completely different buttons
		if (waitingForReleaseRef.current && lastPressedButtonRef.current) {
			const lastPressed = lastPressedButtonRef.current;
			const isSameButton = btn.text === lastPressed.text &&
				Math.abs(btn.bg.x - lastPressed.x) < 5 &&
				Math.abs(btn.bg.y - lastPressed.y) < 5;

			if (!isSameButton) {
				// Different button - clear the waiting state so we can detect presses on this new button
				waitingForReleaseRef.current = false;
				lastPressedButtonRef.current = null;
			}
		}

		// Reset pressed handling for any newly highlighted button (unless still waiting for same button's release)
		if (!waitingForReleaseRef.current) {
			pressedHandledRef.current = false;
		}

		// Reset brightness tracking for new button (transition detection starts fresh)
		prevHighlightBrightnessRef.current = null;

		// Track when we highlighted this button for timing-based click detection
		// If dialog closes shortly after highlighting, we assume the button was clicked
		highlightTimestampRef.current = Date.now();

		// Clear previous overlay
		if (dialogOverlayHandleRef.current) {
			await spriteOverlayRef.current.stop(dialogOverlayHandleRef.current);
			dialogOverlayHandleRef.current = null;
		}

		// Calculate button bounds
		let x = btn.bg.x;
		let y = btn.bg.y;
		let width = btn.bg.width;
		let height = btn.bg.height;

		if (btn.start) {
			x = Math.min(x, btn.start.x);
			width = Math.max(btn.bg.x + btn.bg.width, btn.start.x + btn.start.width) - x;
		}
		if (btn.end) {
			width = Math.max(x + width, btn.end.x + btn.end.width) - x;
		}

		// Add padding
		const padding = 2;
		x -= padding;
		y -= padding;
		width += padding * 2;
		height += padding * 2;

		try {
			dialogOverlayHandleRef.current = await spriteOverlayRef.current.renderRectAt(
				x, y, width, height,
				{ color: [0, 255, 0, 200], thickness: 3, mode: "outline" }
			);
		} catch (e) {
			console.error("[GlQuest] Failed to highlight button:", e);
			// Clear the ref on failure so we can retry
			lastHighlightedButtonRef.current = null;
		}
	};

	// Dialog proximity/movement tracking
	const dialogProximityTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const lastDialogPlayerPosRef = useRef<{ x: number; z: number } | null>(null);

	const DIALOG_PROXIMITY_TILES = 5;
	const DIALOG_MOVEMENT_THRESHOLD = 2; // tiles moved = "moving"
	const DIALOG_PROXIMITY_CHECK_MS = 1000; // check every 1s (uses cached position — zero GPU cost)

	/** Actually start the render stream (called when proximity + stationary conditions met) */
	const activateDialogStream = useCallback(() => {
		if (!dialogReaderRef.current?.isInitialized()) return;
		if (dialogReaderRef.current.isRunning()) return;

		dialogReaderRef.current.clearCallbacks();
		dialogReaderRef.current.onDetect(handleDialogDetection);
		dialogReaderRef.current.start();
		console.log("[GlQuest] Dialog stream activated (player near NPC and stationary)");
	}, [handleDialogDetection]);

	/** Stop the render stream (called when player moves away) */
	const deactivateDialogStream = useCallback(() => {
		if (dialogReaderRef.current?.isRunning()) {
			dialogReaderRef.current.stop();
			console.log("[GlQuest] Dialog stream deactivated (player moved away)");
		}
	}, []);

	// Start dialog detection for a step
	const startDialogDetection = useCallback((step: QuestStep) => {
		// Check if dialog solver is enabled
		if (!dialogSolverEnabled) {
			return;
		}

		const dialogOptions = step.dialogOptions ?? [];
		const prevOptions = currentDialogOptionsRef.current;

		// Check if dialog options changed (new step) - if so, clear the completed tracking
		const optionsChanged = dialogOptions.length !== prevOptions.length ||
			dialogOptions.some((opt, i) => opt !== prevOptions[i]);
		if (optionsChanged && completedDialogCountsRef.current.size > 0) {
			console.log(`[GlQuest] Dialog options changed, clearing ${completedDialogCountsRef.current.size} completed dialogs`);
			completedDialogCountsRef.current.clear();
		}

		currentDialogOptionsRef.current = dialogOptions;

		if (dialogOptions.length === 0) {
			// No dialog options - stop stream and proximity checker
			deactivateDialogStream();
			if (dialogProximityTimerRef.current) {
				clearInterval(dialogProximityTimerRef.current);
				dialogProximityTimerRef.current = null;
			}
			return;
		}

		if (!dialogReaderRef.current?.isInitialized()) {
			console.warn("[GlQuest] Dialog reader not initialized");
			return;
		}

		// Collect NPC locations for proximity checking
		const npcLocations = (step.highlights?.npc ?? [])
			.filter(n => n.npcLocation)
			.map(n => ({ x: n.npcLocation.lng, z: n.npcLocation.lat }));

		// Also include object locations as potential dialog triggers
		const objLocations = (step.highlights?.object ?? [])
			.filter((o: any) => o.objectLocation)
			.map((o: any) => ({ x: o.objectLocation.lng, z: o.objectLocation.lat }));

		const dialogLocations = [...npcLocations, ...objLocations];

		// If no known locations, fall back to starting stream immediately
		if (dialogLocations.length === 0) {
			activateDialogStream();
			return;
		}

		// Stop any existing proximity timer
		if (dialogProximityTimerRef.current) {
			clearInterval(dialogProximityTimerRef.current);
		}

		// Start lightweight proximity + movement checker (uses cached position — zero GPU cost)
		lastDialogPlayerPosRef.current = null;
		dialogProximityTimerRef.current = setInterval(() => {
			const { getPlayerPosition: getPos } = require("./PlayerPositionTracker");
			const pos = getPos();
			if (!pos) return;

			const playerX = pos.location.lng;
			const playerZ = pos.location.lat;

			// Check proximity to any dialog NPC/object
			const isNearby = dialogLocations.some(loc => {
				const dx = playerX - loc.x;
				const dz = playerZ - loc.z;
				return (dx * dx + dz * dz) <= DIALOG_PROXIMITY_TILES * DIALOG_PROXIMITY_TILES;
			});

			// Check if player is stationary
			const lastPos = lastDialogPlayerPosRef.current;
			let isStationary = true;
			if (lastPos) {
				const dx = playerX - lastPos.x;
				const dz = playerZ - lastPos.z;
				isStationary = (dx * dx + dz * dz) <= DIALOG_MOVEMENT_THRESHOLD * DIALOG_MOVEMENT_THRESHOLD;
			}
			lastDialogPlayerPosRef.current = { x: playerX, z: playerZ };

			if (isNearby && isStationary) {
				// Player is near NPC and standing still — start dialog stream
				activateDialogStream();
			} else if (!isNearby) {
				// Player moved away — stop the stream to save FPS
				deactivateDialogStream();
			}
			// If nearby but moving, keep current state (don't start/stop rapidly)
		}, DIALOG_PROXIMITY_CHECK_MS);

	}, [handleDialogDetection, dialogSolverEnabled, activateDialogStream, deactivateDialogStream]);

	// Stop dialog detection
	const stopDialogDetection = useCallback(async () => {
		// Stop proximity checker
		if (dialogProximityTimerRef.current) {
			clearInterval(dialogProximityTimerRef.current);
			dialogProximityTimerRef.current = null;
		}
		lastDialogPlayerPosRef.current = null;

		if (dialogReaderRef.current?.isRunning()) {
			dialogReaderRef.current.stop();
		}
		currentDialogOptionsRef.current = [];

		// Clear overlay
		if (dialogOverlayHandleRef.current && spriteOverlayRef.current) {
			await spriteOverlayRef.current.stop(dialogOverlayHandleRef.current);
			dialogOverlayHandleRef.current = null;
		}
	}, []);

	// Cleanup on unmount
	useEffect(() => {
		return () => {
			if (dialogProximityTimerRef.current) {
				clearInterval(dialogProximityTimerRef.current);
				dialogProximityTimerRef.current = null;
			}
			deactivateStepOverlays();
		};
	}, []);

	// NOTE: Teleport/floor-change overlay cleanup is intentionally disabled.
	// The z-fighting issue when teleporting to basements is a DLL-level problem
	// (stale VAO IDs after teleport). Clearing and recreating overlays from JS
	// causes frame drops and doesn't solve the underlying VAO matching issue.

	// Re-activate overlays when compassOverlayEnabled changes
	useEffect(() => {
		if (!isGlInjectionAvailable() || !currentStepRef.current) return;

		// Re-run overlay activation with the new setting
		activateStepOverlays(currentStepRef.current, {
			onNpcFound: () => {},
			compassOverlayEnabled,
		}).catch(() => {});
	}, [compassOverlayEnabled]);

	// Handle wanderRadiusEnabled toggle
	useEffect(() => {
		if (!isGlInjectionAvailable()) return;
		setWanderRadiusEnabled(wanderRadiusEnabled);
	}, [wanderRadiusEnabled]);

	// Handle dialogSolverEnabled toggle
	useEffect(() => {
		if (!isGlInjectionAvailable() || !currentStepRef.current) return;

		if (dialogSolverEnabled) {
			// Start dialog detection for current step
			startDialogDetection(currentStepRef.current);
		} else {
			// Stop dialog detection
			stopDialogDetection();
		}
	}, [dialogSolverEnabled, startDialogDetection, stopDialogDetection]);

	const onStepActivated = useCallback(
		async (step: QuestStep, stepIndex: number) => {
			try {
				currentStepIndexRef.current = stepIndex;
				currentStepRef.current = step;

				if (!isGlInjectionAvailable()) return;

				activateStepOverlays(step, {
					onNpcFound: () => {},
					compassOverlayEnabled,
				}).catch(() => {});

				// Start dialog detection if step has dialogOptions
				startDialogDetection(step);
			} catch (e) {
				// Ignore
			}
		},
		[startDialogDetection, compassOverlayEnabled]
	);

	const onStepDeactivated = useCallback(async () => {
		try {
			await deactivateStepOverlays();
			await stopDialogDetection();
			currentStepIndexRef.current = -1;
			currentStepRef.current = null;
		} catch (e) {
			// Ignore
		}
	}, [stopDialogDetection]);

	return {
		onStepActivated,
		onStepDeactivated,
		isGlAvailable: isGlInjectionAvailable(),
		isGlReady,
		isOverlayActive: isOverlayActive(),
	};
}

export default useGlQuestIntegration;
