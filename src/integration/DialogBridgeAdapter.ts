/**
 * Dialog Bridge Adapter
 *
 * Bridges RS3QuestBuddyBeta's DialogBoxReader with QuestStateEngine's DialogTracker.
 * Allows QuestStateEngine to receive dialog detection events from the GL-based reader.
 *
 * Architecture:
 * - RS3QuestBuddyBeta's DialogBoxReader handles low-level GL dialog detection
 * - This adapter converts DialogBoxResult to QuestStateEngine's DialogDetectionResult format
 * - QuestStateEngine can use this data for quest step completion tracking
 */

import { DialogBoxReader, DialogBoxResult, DialogButton, DIALOG_IDS } from "../gl/injection/DialogBoxReader/reader";

/**
 * QuestStateEngine-compatible dialog detection result
 */
export interface QSEDialogResult {
  isOpen: boolean;
  npcName: string | null;
  dialogText: string;
  buttons: QSEDialogButton[];
  headerText: string | null;
  /** Raw result from DialogBoxReader for advanced usage */
  rawResult?: DialogBoxResult;
}

/**
 * QuestStateEngine-compatible button format
 */
export interface QSEDialogButton {
  text: string;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  isPressed: boolean;
  isContinueButton: boolean;
  confidence: number;
}

/**
 * Dialog event types
 */
export type DialogEventType =
  | 'dialog_opened'
  | 'dialog_closed'
  | 'button_pressed'
  | 'continue_pressed'
  | 'option_selected';

/**
 * Dialog event for tracking
 */
export interface DialogEvent {
  type: DialogEventType;
  timestamp: number;
  buttonText?: string;
  allOptions?: string[];
  isQuestRelevant?: boolean;
}

/**
 * Callback for dialog detection
 */
export type DialogDetectionCallback = (result: QSEDialogResult | null, event?: DialogEvent) => void;

/**
 * DialogBridgeAdapter - connects RS3QuestBuddyBeta dialog detection to QuestStateEngine
 */
export class DialogBridgeAdapter {
  private reader: DialogBoxReader;
  private callbacks: DialogDetectionCallback[] = [];
  private lastResult: QSEDialogResult | null = null;
  private dialogHistory: DialogEvent[] = [];
  private historyLimit: number = 100;

  // Expected dialog options from quest step (for matching)
  private expectedOptions: string[] = [];
  private completedOptions: Map<string, number> = new Map();

  constructor() {
    this.reader = new DialogBoxReader();
  }

  /**
   * Initialize the dialog reader
   */
  async init(): Promise<void> {
    await this.reader.init();
  }

  /**
   * Check if initialized
   */
  isInitialized(): boolean {
    return this.reader.isInitialized();
  }

  /**
   * Check if running
   */
  isRunning(): boolean {
    return this.reader.isRunning();
  }

  /**
   * Set expected dialog options from quest step
   * These are used for matching and completion tracking
   */
  setExpectedOptions(options: string[]): void {
    this.expectedOptions = [...options];
    this.completedOptions.clear();
  }

  /**
   * Get completed option count for a specific option text
   */
  getCompletedCount(optionText: string): number {
    return this.completedOptions.get(optionText) ?? 0;
  }

  /**
   * Get total expected count for an option text
   */
  getExpectedCount(optionText: string): number {
    return this.expectedOptions.filter(opt => opt === optionText).length;
  }

  /**
   * Mark an option as completed
   */
  markOptionCompleted(optionText: string): void {
    const current = this.completedOptions.get(optionText) ?? 0;
    this.completedOptions.set(optionText, current + 1);
  }

  /**
   * Check if all expected options have been completed
   */
  areAllOptionsCompleted(): boolean {
    if (this.expectedOptions.length === 0) return true;

    for (const opt of this.expectedOptions) {
      const completed = this.completedOptions.get(opt) ?? 0;
      const expected = this.getExpectedCount(opt);
      if (completed < expected) return false;
    }
    return true;
  }

  /**
   * Register a callback for dialog detection events
   */
  onDetect(callback: DialogDetectionCallback): void {
    this.callbacks.push(callback);
  }

  /**
   * Remove a callback
   */
  offDetect(callback: DialogDetectionCallback): void {
    const idx = this.callbacks.indexOf(callback);
    if (idx !== -1) {
      this.callbacks.splice(idx, 1);
    }
  }

  /**
   * Start continuous dialog detection
   */
  start(): void {
    this.reader.onDetect(this.handleDetection.bind(this));
    this.reader.start();
  }

  /**
   * Stop dialog detection
   */
  stop(): void {
    this.reader.stop();
  }

  /**
   * One-shot detection
   */
  async detect(): Promise<QSEDialogResult | null> {
    const rawResult = await this.reader.detect();
    return this.convertResult(rawResult);
  }

  /**
   * Get dialog history
   */
  getHistory(): DialogEvent[] {
    return [...this.dialogHistory];
  }

  /**
   * Clear dialog history
   */
  clearHistory(): void {
    this.dialogHistory = [];
  }

  /**
   * Get last detection result
   */
  getLastResult(): QSEDialogResult | null {
    return this.lastResult;
  }

  /**
   * Handle detection from DialogBoxReader and convert to QSE format
   */
  private handleDetection(rawResult: DialogBoxResult | null): void {
    const result = this.convertResult(rawResult);

    // Detect events
    let event: DialogEvent | undefined;

    if (result && !this.lastResult?.isOpen) {
      // Dialog opened
      event = {
        type: 'dialog_opened',
        timestamp: Date.now(),
        allOptions: result.buttons.map(b => b.text),
      };
      this.addToHistory(event);
    } else if (!result?.isOpen && this.lastResult?.isOpen) {
      // Dialog closed
      event = {
        type: 'dialog_closed',
        timestamp: Date.now(),
      };
      this.addToHistory(event);
    } else if (result) {
      // Check for button presses
      for (const btn of result.buttons) {
        if (btn.isPressed) {
          const eventType: DialogEventType = btn.isContinueButton
            ? 'continue_pressed'
            : 'button_pressed';

          event = {
            type: eventType,
            timestamp: Date.now(),
            buttonText: btn.text,
            isQuestRelevant: this.isQuestRelevantOption(btn.text),
          };
          this.addToHistory(event);

          // Track completion
          if (this.expectedOptions.includes(btn.text)) {
            this.markOptionCompleted(btn.text);
          }
          break;
        }
      }
    }

    this.lastResult = result;

    // Notify callbacks
    for (const callback of this.callbacks) {
      callback(result, event);
    }
  }

  /**
   * Convert DialogBoxResult to QSEDialogResult
   */
  private convertResult(rawResult: DialogBoxResult | null): QSEDialogResult | null {
    if (!rawResult || rawResult.buttons.length === 0) {
      return {
        isOpen: false,
        npcName: null,
        dialogText: '',
        buttons: [],
        headerText: null,
      };
    }

    const buttons: QSEDialogButton[] = rawResult.buttons.map(btn => ({
      text: btn.text,
      bounds: {
        x: btn.bg.x,
        y: btn.bg.y,
        width: btn.bg.width,
        height: btn.bg.height,
      },
      isPressed: btn.pressed,
      isContinueButton: this.isContinueButton(btn),
      confidence: btn.text ? 0.9 : 0.6,
    }));

    return {
      isOpen: true,
      npcName: null, // DialogBoxReader doesn't extract NPC name directly
      dialogText: rawResult.header ?? '',
      buttons,
      headerText: rawResult.header,
      rawResult,
    };
  }

  /**
   * Check if a button is a "Continue" type button
   * Continue buttons use sprite 18635 and have the fixed label "Click to continue"
   */
  private isContinueButton(btn: DialogButton): boolean {
    // The continue button has a fixed label assigned by the reader
    return btn.text === 'Click to continue';
  }

  /**
   * Check if an option is quest-relevant (matches expected options)
   */
  private isQuestRelevantOption(optionText: string): boolean {
    return this.expectedOptions.includes(optionText);
  }

  /**
   * Add event to history
   */
  private addToHistory(event: DialogEvent): void {
    this.dialogHistory.push(event);

    // Trim history if needed
    if (this.dialogHistory.length > this.historyLimit) {
      this.dialogHistory = this.dialogHistory.slice(-this.historyLimit);
    }
  }

  /**
   * Get exported sprite IDs for reference
   */
  static get SPRITE_IDS() {
    return DIALOG_IDS;
  }
}

/**
 * Create a configured DialogBridgeAdapter instance
 */
export async function createDialogBridge(): Promise<DialogBridgeAdapter> {
  const bridge = new DialogBridgeAdapter();
  await bridge.init();
  return bridge;
}
