/**
 * useGlQuestIntegration - React hook for GL-based quest integration
 *
 * Provides a unified interface for:
 * - NPC/Object overlay management
 * - Pathfinding to step targets (with player position tracking)
 *
 * NOTE: Dialog detection uses ts/DialogBoxReader/reader.ts directly.
 * Automatically detects if GL injection is available and falls back gracefully
 * when not available.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { isGlInjectionAvailable } from "../api/glInjection";
import type { QuestStep, NpcLocation, NpcWanderRadius } from "../state/types";
import {
	activateStepOverlays,
	deactivateStepOverlays,
	isOverlayActive,
	retryPendingOverlays,
	hasPendingOverlays,
	setMinimapArrowEnabled,
	setMinimapMarkerEnabled,
	setHudCompassEnabled,
	setHudCompassPosition,
} from "./QuestOverlayManager";
import { onResolutionChange } from "./UIScaleManager";
import {
	drawPathTubes,
	clearPathTubes,
} from "./PathTubeOverlay";
import { findPathClient } from "../api/clientPathfinder";
import { latLngToGameCoords, gameCoordsToLatLng } from "../api/pathfindingApi";
import {
	startPlayerTracking,
	stopPlayerTracking,
	getPlayerPosition,
} from "./PlayerPositionTracker";
import { DialogBoxReader, DialogBoxResult } from "@injection/DialogBoxReader/reader";
import { SpriteOverlay } from "@injection/util/spriteOverlay";

interface PlayerPosition {
	location: NpcLocation;
	floor: number;
}

interface GlQuestIntegrationOptions {
	/** Whether pathfinding is enabled (controlled by settings) */
	pathfindingEnabled?: boolean;
	/** Whether dialog solver/detection is enabled (controlled by settings) */
	dialogSolverEnabled?: boolean;
	/** Whether compass overlay on NPCs is enabled (controlled by settings) */
	compassOverlayEnabled?: boolean;
	/** Whether minimap direction arrow is enabled (very taxing) */
	minimapArrowEnabled?: boolean;
	/** Whether minimap direction marker is enabled (light) */
	minimapMarkerEnabled?: boolean;
	/** Whether HUD compass overlay is enabled (controlled by settings) */
	hudCompassEnabled?: boolean;
	/** HUD compass X position */
	hudCompassX?: number;
	/** HUD compass Y position */
	hudCompassY?: number;
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
	setPlayerPosition: (position: PlayerPosition | null) => void;
	isPathfindingActive: boolean;
	playerPosition: PlayerPosition | null;
}

// Config

const PLAYER_TRACKING_INTERVAL = 1000;
const MIN_MOVE_DISTANCE = 3;
const MAX_PATH_TILES = 60;
const MAX_PATH_RANGE = 50;
const FAILED_PATH_CACHE_MS = 30000;

const failedPathCache = new Map<string, number>();
const OBJECT_ARRIVAL_DISTANCE = 3;

interface TargetWithMeta {
	lat: number;
	lng: number;
	floor: number;
	isNpc: boolean;
	wanderRadius?: NpcWanderRadius;
}

function isPlayerAtTarget(playerPos: PlayerPosition, target: TargetWithMeta): boolean {
	if (playerPos.floor !== target.floor) return false;

	const playerLat = playerPos.location.lat;
	const playerLng = playerPos.location.lng;

	if (target.isNpc && target.wanderRadius) {
		const { bottomLeft, topRight } = target.wanderRadius;
		return (
			playerLat >= bottomLeft.lat &&
			playerLat <= topRight.lat &&
			playerLng >= bottomLeft.lng &&
			playerLng <= topRight.lng
		);
	}

	const dx = Math.abs(playerLat - target.lat);
	const dy = Math.abs(playerLng - target.lng);
	const distance = Math.sqrt(dx * dx + dy * dy);
	return distance <= OBJECT_ARRIVAL_DISTANCE;
}

function extractNearestTarget(
	step: QuestStep,
	playerPos: PlayerPosition | null
): TargetWithMeta | null {
	const targets: TargetWithMeta[] = [];

	if (step.highlights?.npc) {
		for (const npc of step.highlights.npc) {
			if (npc.npcLocation) {
				targets.push({
					lat: npc.npcLocation.lat,
					lng: npc.npcLocation.lng,
					floor: npc.floor ?? step.floor ?? 0,
					isNpc: true,
					wanderRadius: npc.wanderRadius,
				});
			}
		}
	}

	if (step.highlights?.object) {
		for (const obj of step.highlights.object) {
			if (obj.objectLocation && obj.objectLocation.length > 0) {
				const loc = obj.objectLocation[0];
				targets.push({
					lat: loc.lat,
					lng: loc.lng,
					floor: obj.floor ?? step.floor ?? 0,
					isNpc: false,
				});
			}
		}
	}

	if (targets.length === 0) return null;

	if (playerPos) {
		let nearest = targets[0];
		let nearestDist = Infinity;

		for (const t of targets) {
			const floorPenalty = t.floor === playerPos.floor ? 0 : 1000;
			const dist =
				Math.abs(t.lat - playerPos.location.lat) +
				Math.abs(t.lng - playerPos.location.lng) +
				floorPenalty;

			if (dist < nearestDist) {
				nearestDist = dist;
				nearest = t;
			}
		}
		return nearest;
	}

	return targets[0];
}

export function useGlQuestIntegration(
	options: GlQuestIntegrationOptions = {}
): GlQuestIntegrationReturn {
	const {
		pathfindingEnabled = false,
		dialogSolverEnabled = false,
		compassOverlayEnabled = false,
		minimapArrowEnabled = false,
		minimapMarkerEnabled = true,
		hudCompassEnabled = false,
		hudCompassX = 1700,
		hudCompassY = 900,
		onDialogCompleted,
	} = options;
	const currentStepIndexRef = useRef<number>(-1);
	const currentStepRef = useRef<QuestStep | null>(null);
	const lastPathPositionRef = useRef<{ lat: number; lng: number; floor: number } | null>(null);
	// Track the destination we successfully pathed to - prevents re-pathing on floor detection changes
	const lastSuccessfulDestinationRef = useRef<{ lat: number; lng: number; floor: number } | null>(null);
	const [isPathfindingActive, setIsPathfindingActive] = useState(false);
	const [playerPosition, setPlayerPositionState] = useState<PlayerPosition | null>(null);

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

		return () => {
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
							const totalCompleted = Array.from(completedDialogCountsRef.current.values()).reduce((a, b) => a + b, 0);
							console.log(`[GlQuest] Button "${lastBtn.text}" PRESSED on close! (prevBr=${prevBr?.toFixed(3)}) (${currentCount + 1}/${expectedCount} for this text, ${totalCompleted} total)`);
							onDialogCompleted?.();
						}
					}

					await spriteOverlayRef.current.stop(dialogOverlayHandleRef.current);
					dialogOverlayHandleRef.current = null;
					lastHighlightedButtonRef.current = null;
					highlightTimestampRef.current = 0;
					prevHighlightBrightnessRef.current = null;

					// Dialog closed - log for debugging
					console.log(`[GlQuest] Dialog closed, hadHighlight: ${lastBtn !== null}, timeSince: ${timeSinceHighlight}ms${pressedHandledRef.current ? ' (detected)' : ''}`);
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
					console.log(`[GlQuest] Button released detected (brightness normal), clearing waitingForRelease after ${elapsed}ms`);
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

			// Only log when there's a state change (pressed detected or button missing)
			if (isPressed) {
				const method = transitionDetected ? 'transition' : 'brightness';
				console.log(`[GlQuest] Button "${lastBtn.text}" pressed detected! (${method}) br=${currBr?.toFixed(3)}`);
			} else if (!matchingButton) {
				console.log(`[GlQuest] Tracked button "${lastBtn.text}" disappeared from dialog`);
			}

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
					const totalCompleted = Array.from(completedDialogCountsRef.current.values()).reduce((a, b) => a + b, 0);
					console.log(`[GlQuest] Button "${lastBtn.text}" PRESSED detected! Marking complete. (${currentCount + 1}/${expectedCount} for this text, ${totalCompleted} total)`);
					await spriteOverlayRef.current?.stop(dialogOverlayHandleRef.current);
					dialogOverlayHandleRef.current = null;
					lastHighlightedButtonRef.current = null;
					onDialogCompleted?.();
				} else if (alreadyCompleted) {
					console.log(`[GlQuest] Button "${lastBtn.text}" already completed ${currentCount}/${expectedCount} times, ignoring repeat click`);
				}
				return;
			}
			// NOTE: We no longer reset pressedHandledRef/lastPressedButtonRef here
			// That's handled in the release detection block above

			if (!matchingButton) {
				// Our highlighted button disappeared - but did OTHER buttons remain?
				// If other buttons are still showing, user likely clicked our button
				// (clicking transitions to next dialog or closes just that option)
				const otherButtonsRemain = result.buttons.length > 0;

				console.log(`[GlQuest] Button "${lastBtn.text}" disappeared. Other buttons remain: ${otherButtonsRemain}, count: ${result.buttons.length}`);

				await spriteOverlayRef.current?.stop(dialogOverlayHandleRef.current);
				dialogOverlayHandleRef.current = null;
				lastHighlightedButtonRef.current = null;

				if (otherButtonsRemain) {
					// Other buttons still visible = user clicked our specific button
					console.log(`[GlQuest] Marking complete - button clicked (other buttons still visible)`);
					onDialogCompleted?.();
				} else {
					// All buttons gone at once = dialog transition or dismissal
					// Could be: click triggered full dialog close, or walk away
					// For single-option dialogs, still mark as complete
					console.log(`[GlQuest] All buttons gone - likely dialog transition, marking complete`);
					onDialogCompleted?.();
				}
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
					console.log(`[GlQuest] Matched button "${btn.text}" by number ${num}`);
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
					console.log(`[GlQuest] Matched button "${btn.text}" with option "${option}"`);
					await highlightButton(btn);
					return;
				}
			}
		}

		// No match found - but don't clear overlay immediately
		// The dialog is present but no matching option, keep existing highlight if any
		// Only log once per dialog change
		if (!lastHighlightedButtonRef.current) {
			console.log(`[GlQuest] No match found. Buttons: ${result.buttons.map(b => b.text).join(", ")}`);
		}
	}, [onDialogCompleted]);

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
				console.log(`[GlQuest] New button "${btn.text}" highlighted, clearing waitingForRelease from "${lastPressed.text}"`);
				waitingForReleaseRef.current = false;
				lastPressedButtonRef.current = null;
			} else {
				// Same button - keep waiting for release to prevent double-completion
				console.log(`[GlQuest] Same button re-highlighted, still waiting for release`);
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
			console.log(`[GlQuest] Highlighted button: "${btn.text}" at (${x}, ${y})`);
		} catch (e) {
			console.error("[GlQuest] Failed to highlight button:", e);
			// Clear the ref on failure so we can retry
			lastHighlightedButtonRef.current = null;
		}
	};

	// Start dialog detection for a step
	const startDialogDetection = useCallback((step: QuestStep) => {
		// Check if dialog solver is enabled
		if (!dialogSolverEnabled) {
			return;
		}

		const dialogOptions = step.dialogOptions ?? [];
		const prevOptions = currentDialogOptionsRef.current;

		// Check if dialog options changed (new step) - if so, clear the completed tracking
		// This allows re-completing the same dialogs if the step changes
		const optionsChanged = dialogOptions.length !== prevOptions.length ||
			dialogOptions.some((opt, i) => opt !== prevOptions[i]);
		if (optionsChanged && completedDialogCountsRef.current.size > 0) {
			console.log(`[GlQuest] Dialog options changed, clearing ${completedDialogCountsRef.current.size} completed dialogs`);
			completedDialogCountsRef.current.clear();
		}

		currentDialogOptionsRef.current = dialogOptions;

		if (dialogOptions.length === 0) {
			// No dialog options - stop if running
			if (dialogReaderRef.current?.isRunning()) {
				dialogReaderRef.current.stop();
			}
			return;
		}

		if (!dialogReaderRef.current?.isInitialized()) {
			console.warn("[GlQuest] Dialog reader not initialized");
			return;
		}

		// Stop existing and start fresh
		if (dialogReaderRef.current.isRunning()) {
			dialogReaderRef.current.stop();
		}

		// Register callback and start streaming
		dialogReaderRef.current.onDetect(handleDialogDetection);
		dialogReaderRef.current.start();
	}, [handleDialogDetection, dialogSolverEnabled]);

	// Stop dialog detection
	const stopDialogDetection = useCallback(async () => {
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
			deactivateStepOverlays();
			stopPlayerTracking(true);
			clearPathTubes();
		};
	}, []);

	const drawPathToTarget = useCallback(async (step: QuestStep, playerPos: PlayerPosition) => {
		const target = extractNearestTarget(step, playerPos);
		if (!target) {
			return;
		}

		if (isPlayerAtTarget(playerPos, target)) {
			await clearPathTubes();
			setIsPathfindingActive(false);
			lastPathPositionRef.current = null;
			lastSuccessfulDestinationRef.current = null;
			return;
		}

		// Check if we already have a path to the same destination
		// Skip re-pathing if destination hasn't changed - prevents wasted pathfinding on floor detection changes
		const destLat = target.lat;
		const destLng = target.lng;
		const destFloor = target.floor;

		if (lastSuccessfulDestinationRef.current && isPathfindingActive) {
			const destDx = Math.abs(destLat - lastSuccessfulDestinationRef.current.lat);
			const destDz = Math.abs(destLng - lastSuccessfulDestinationRef.current.lng);
			const destFloorSame = destFloor === lastSuccessfulDestinationRef.current.floor;

			// If destination is the same and we have an active path, skip re-pathing
			if (destFloorSame && destDx < 3 && destDz < 3) {
				// Still check if player moved enough to warrant a path update
				if (lastPathPositionRef.current) {
					const dx = Math.abs(playerPos.location.lat - lastPathPositionRef.current.lat);
					const dz = Math.abs(playerPos.location.lng - lastPathPositionRef.current.lng);
					if (dx < MIN_MOVE_DISTANCE && dz < MIN_MOVE_DISTANCE) {
						return; // Player hasn't moved much, keep existing path
					}
				}
			}
		}

		// Check if we should skip recalculation (player hasn't moved enough)
		let forceRedraw = false;
		if (lastPathPositionRef.current) {
			const dx = Math.abs(playerPos.location.lat - lastPathPositionRef.current.lat);
			const dz = Math.abs(playerPos.location.lng - lastPathPositionRef.current.lng);

			if (dx < MIN_MOVE_DISTANCE && dz < MIN_MOVE_DISTANCE) {
				return;
			}
			// Player moved significantly - force redraw to ensure path updates
			forceRedraw = true;
		}

		try {
			// Don't clear first - let drawPathTubes handle the update
			// Clearing first causes a race condition where the old overlay stops
			// before the new one is ready

			const fromCoords = latLngToGameCoords(playerPos.location.lat, playerPos.location.lng);
			const toCoords = latLngToGameCoords(target.lat, target.lng);

			const cacheKey = `${Math.floor(fromCoords.x / 10)},${Math.floor(fromCoords.y / 10)},${playerPos.floor}->${Math.floor(toCoords.x / 10)},${Math.floor(toCoords.y / 10)},${target.floor}`;

			const failedAt = failedPathCache.get(cacheKey);
			if (failedAt && Date.now() - failedAt < FAILED_PATH_CACHE_MS) {
				setIsPathfindingActive(false);
				return;
			}

			const pathResult = await findPathClient(
				{ x: fromCoords.x, y: fromCoords.y, floor: playerPos.floor },
				{ x: toCoords.x, y: toCoords.y, floor: target.floor },
				{ maxDistance: 500, allowDiagonals: true }
			);

			if (!pathResult.success || pathResult.path.length === 0) {
				failedPathCache.set(cacheKey, Date.now());
				if (failedPathCache.size > 20) {
					const now = Date.now();
					for (const [key, timestamp] of failedPathCache) {
						if (now - timestamp > FAILED_PATH_CACHE_MS) {
							failedPathCache.delete(key);
						}
					}
				}
				setIsPathfindingActive(false);
				return;
			}

			failedPathCache.delete(cacheKey);

			const allPathNodes = pathResult.path.map((node) => {
				const latLng = gameCoordsToLatLng(node.x, node.y);
				return {
					lat: latLng.lat,
					lng: latLng.lng,
					floor: node.floor,
					isTransport: node.isTransport,
				};
			});

			let pathToShow = allPathNodes;

			const firstTransportIdx = allPathNodes.findIndex(
				(node) => node.isTransport && node.floor === playerPos.floor
			);

			if (firstTransportIdx !== -1) {
				pathToShow = allPathNodes.slice(0, firstTransportIdx + 1);
			}

			const visibleNodes = pathToShow.filter((node) => {
				if (node.isTransport) return true;
				const dx = Math.abs(node.lat - playerPos.location.lat);
				const dy = Math.abs(node.lng - playerPos.location.lng);
				return Math.sqrt(dx * dx + dy * dy) <= MAX_PATH_RANGE;
			});

			let pathNodes = visibleNodes;
			if (visibleNodes.length > MAX_PATH_TILES) {
				const sampleRate = Math.ceil(visibleNodes.length / MAX_PATH_TILES);
				pathNodes = visibleNodes.filter((node, i) =>
					i % sampleRate === 0 || i === visibleNodes.length - 1 || node.isTransport
				);
			}

			const success = await drawPathTubes(pathNodes, { forceRedraw });
			setIsPathfindingActive(success);

			if (success) {
				lastPathPositionRef.current = {
					lat: playerPos.location.lat,
					lng: playerPos.location.lng,
					floor: playerPos.floor,
				};
				// Track successful destination to prevent re-pathing on floor detection changes
				lastSuccessfulDestinationRef.current = {
					lat: destLat,
					lng: destLng,
					floor: destFloor,
				};
			}
		} catch (e) {
			setIsPathfindingActive(false);
		}
	}, []);

	const handlePositionUpdate = useCallback(
		(position: PlayerPosition) => {
			setPlayerPositionState(position);

			if (pathfindingEnabled && currentStepRef.current) {
				drawPathToTarget(currentStepRef.current, position);
			}

			if (hasPendingOverlays()) {
				retryPendingOverlays().catch(() => {});
			}
		},
		[drawPathToTarget, pathfindingEnabled]
	);

	useEffect(() => {
		if (!pathfindingEnabled) {
			clearPathTubes();
			setIsPathfindingActive(false);
			lastPathPositionRef.current = null;
			lastSuccessfulDestinationRef.current = null;
		} else if (currentStepRef.current) {
			const pos = getPlayerPosition();
			const target = extractNearestTarget(currentStepRef.current, pos);

			if (!target) return;

			startPlayerTracking(handlePositionUpdate, PLAYER_TRACKING_INTERVAL, "pathfinding")
				.then(() => {
					const currentPos = getPlayerPosition();
					if (currentPos && currentStepRef.current) {
						drawPathToTarget(currentStepRef.current, currentPos);
					}
				})
				.catch(() => {});
		}
	}, [pathfindingEnabled, handlePositionUpdate, drawPathToTarget]);

	// Re-activate overlays when compassOverlayEnabled changes
	useEffect(() => {
		if (!isGlInjectionAvailable() || !currentStepRef.current) return;

		// Re-run overlay activation with the new setting
		activateStepOverlays(currentStepRef.current, {
			onNpcFound: () => {},
			compassOverlayEnabled,
		}).catch(() => {});
	}, [compassOverlayEnabled]);

	// Handle minimapArrowEnabled toggle
	useEffect(() => {
		if (!isGlInjectionAvailable()) return;
		setMinimapArrowEnabled(minimapArrowEnabled);
	}, [minimapArrowEnabled]);

	// Handle minimapMarkerEnabled toggle
	useEffect(() => {
		if (!isGlInjectionAvailable()) return;
		setMinimapMarkerEnabled(minimapMarkerEnabled);
	}, [minimapMarkerEnabled]);

	// Handle hudCompassEnabled toggle
	useEffect(() => {
		if (!isGlInjectionAvailable()) return;

		// Update the HUD compass overlay state in QuestOverlayManager
		setHudCompassEnabled(hudCompassEnabled);
	}, [hudCompassEnabled]);

	// Handle hudCompass position changes
	useEffect(() => {
		if (!isGlInjectionAvailable()) return;

		// Update the HUD compass position
		setHudCompassPosition(hudCompassX, hudCompassY);
	}, [hudCompassX, hudCompassY]);

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
				lastPathPositionRef.current = null;
				lastSuccessfulDestinationRef.current = null; // Clear destination when step changes

				if (!isGlInjectionAvailable()) return;

				await clearPathTubes();
				setIsPathfindingActive(false);

				if (pathfindingEnabled) {
					const initialPos = getPlayerPosition();
					const target = extractNearestTarget(step, initialPos);

					if (target) {
						try {
							await startPlayerTracking(handlePositionUpdate, PLAYER_TRACKING_INTERVAL, "pathfinding");
							const pos = getPlayerPosition();
							if (pos) {
								await drawPathToTarget(step, pos);
							}
						} catch (e) {
							// Ignore
						}
					}
				}

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
		[handlePositionUpdate, drawPathToTarget, pathfindingEnabled, startDialogDetection, compassOverlayEnabled]
	);

	const onStepDeactivated = useCallback(async () => {
		try {
			await deactivateStepOverlays();
			await stopPlayerTracking(true);
			await clearPathTubes();
			await stopDialogDetection();
			currentStepIndexRef.current = -1;
			currentStepRef.current = null;
			lastPathPositionRef.current = null;
			lastSuccessfulDestinationRef.current = null;
			setIsPathfindingActive(false);
		} catch (e) {
			// Ignore
		}
	}, [stopDialogDetection]);

	const setPlayerPosition = useCallback(
		(position: PlayerPosition | null) => {
			if (position) {
				handlePositionUpdate(position);
			}
		},
		[handlePositionUpdate]
	);

	return {
		onStepActivated,
		onStepDeactivated,
		isGlAvailable: isGlInjectionAvailable(),
		isGlReady,
		isOverlayActive: isOverlayActive(),
		setPlayerPosition,
		isPathfindingActive,
		playerPosition,
	};
}

export default useGlQuestIntegration;
