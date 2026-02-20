/**
 * Integration Module
 *
 * Dev tools and external system integrations.
 */


// GLBridge adapter for QuestStateEngine
export {
  GLBridgeAdapter,
  createGLBridge,
  type GLBridge,
  type RenderRect,
  type SpriteInfo,
  type KnownSprite,
  type RGBAColor,
  type UIState,
  type RenderRecordOptions,
} from './GLBridgeAdapter';

// QuestStateEngine integration
export {
  IntegratedInventoryMonitor,
  initializeQuestStateEngine,
  getInventoryMonitor,
  getGLBridge,
  getDialogBridge,
  getTooltipLearner,
  getOrCreateTooltipLearner,
  type DetectedInventoryItem,
  type InventoryChangeEvent,
  type InventoryDetectionResult,
  type InventoryGridConfig,
} from './QuestStateEngineIntegration';

// Tooltip Item Learner for auto-learning item names
export {
  TooltipItemLearner,
  createTooltipLearner,
  TOOLTIP_SPRITE_IDS,
  getMousePositionFromRender,
  findMousePosition,
  debugUniformNames,
  type LearnedItem,
  type InventorySlotInfo,
  type TooltipDetectionResult,
  type CalibrationState,
} from './TooltipItemLearner';


// Dialog Bridge adapter for QuestStateEngine
export {
  DialogBridgeAdapter,
  createDialogBridge,
  type QSEDialogResult,
  type QSEDialogButton,
  type DialogEvent,
  type DialogEventType,
  type DialogDetectionCallback,
} from './DialogBridgeAdapter';

// Font Character Collector for auto-collecting font characters
export {
  FontCharacterCollector,
  createFontCharacterCollector,
  getFontCharacterCollector,
  type FontCharacterData,
  type UnknownCharacter,
  type FontSheetData,
  type CollectedCharacter,
  type CharacterGroup,
} from './FontCharacterCollector';
