/**
 * GL Module - OpenGL injection integration for quest features
 *
 * Provides:
 * - QuestOverlayManager: NPC arrows and object tile markers
 * - useGlQuestIntegration: React hook for quest page integration
 *
 * NOTE: Dialog detection uses ts/DialogBoxReader/reader.ts directly.
 * NOTE: Pathfinding integration is currently disabled due to memory/performance issues.
 */

export {
	activateStepOverlays,
	deactivateStepOverlays,
	refreshOverlays,
	getOverlayState,
	isOverlayActive,
	getActiveOverlayCount,
	getPendingNpcs,
	prefetchQuestNpcHashes,
	clearNpcHashCache,
	// Path overlay functions (2D tile markers) - available but not auto-triggered
	drawPathOverlay,
	clearPathOverlay,
	isPathOverlayActive,
	getPathOverlayCount,
	updatePathOverlayFloor,
	drawWaypointMarker,
} from "./QuestOverlayManager";

// Connected tube path markers (used with pathfinding)
export {
	drawPathTubes,
	clearPathTubes,
	isPathTubesActive,
	invalidateTubeAnchorVao,
} from "./PathTubeOverlay";

// Compass rose NPC markers
export {
	drawNpcCompassRose,
	drawNpcCompassRoseAttached,
	drawNpcCompassRoseAtLocation,
	clearNpcCompassRose,
	clearAllCompassRoses,
	isCompassRoseActive,
	getCompassRoseCount,
	invalidateCompassAnchorVao,
} from "./CompassRoseOverlay";

export { useGlQuestIntegration } from "./useGlQuestIntegration";

// Player position - simple state management (no auto-tracking)
export {
	startPlayerTracking,
	stopPlayerTracking,
	getPlayerPosition,
	isPlayerTrackingActive,
	setManualPlayerPosition,
	setPlayerFloor,
} from "./PlayerPositionTracker";

// UI scaling detection for high-DPI monitors (4K, etc.)
export {
	initUIScaleManager,
	stopUIScaleManager,
	getUIScaleInfo,
	getScreenDimensions,
	onResolutionChange,
	isUIScaled,
	isUIScaleManagerInitialized,
} from "./UIScaleManager";

// Quest step overlay - displays current step info on the game client
export {
	QuestStepOverlay,
	useQuestStepOverlay,
	renderQuestStep,
} from "./QuestStepOverlay";
export type { OverlayPosition, UseQuestStepOverlayOptions, UseQuestStepOverlayReturn } from "./QuestStepOverlay";

// HUD compass overlay - 2D compass that glows toward quest objectives
export {
	HudCompassOverlay,
	getHudCompassOverlay,
	initHudCompassOverlay,
} from "./HudCompassOverlay";
export type { HudCompassPosition } from "./HudCompassOverlay";
export { useHudCompassOverlay } from "./useHudCompassOverlay";
export type { UseHudCompassOverlayOptions, UseHudCompassOverlayReturn } from "./useHudCompassOverlay";

// HUD compass enable/disable/position control
export { setHudCompassEnabled, isHudCompassEnabled, setHudCompassPosition } from "./QuestOverlayManager";
