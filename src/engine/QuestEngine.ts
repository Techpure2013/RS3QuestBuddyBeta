import type { QuestStep, StepCompletionConditions } from "../state/types";
import type { DetectedInventoryItem } from "../integration/QuestStateEngineIntegration";

export interface QuestEngineConfig {
	onStepComplete: () => void;
	getPlayerPosition?: () => { lat: number; lng: number; floor: number } | null;
	getInventoryItems?: () => DetectedInventoryItem[];
	getItemPHash?: (name: string) => string | null;
}

export class QuestEngine {
	private config: QuestEngineConfig;
	private enabled = false;
	private activeStep: QuestStep | null = null;
	private conditions: StepCompletionConditions | null = null;

	// Condition state
	private dialogCompletedCount = 0;
	private locationsReached: Set<number> = new Set();
	private itemsSatisfied = false;
	private hasTriggered = false;

	constructor(config: QuestEngineConfig) {
		this.config = config;
	}

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		if (!enabled) {
			this.deactivateStep();
		}
	}

	isEnabled(): boolean {
		return this.enabled;
	}

	activateStep(step: QuestStep): void {
		this.activeStep = step;
		this.conditions = step.completionConditions ?? null;
		this.dialogCompletedCount = 0;
		this.locationsReached = new Set();
		this.itemsSatisfied = false;
		this.hasTriggered = false;

	}

	deactivateStep(): void {
		this.activeStep = null;
		this.conditions = null;
		this.dialogCompletedCount = 0;
		this.locationsReached = new Set();
		this.itemsSatisfied = false;
		this.hasTriggered = false;
	}

	markDialogCompleted(): void {
		if (!this.enabled || !this.conditions) return;
		this.dialogCompletedCount++;
		this.evaluate();
	}

	onPositionUpdate(pos: { lat: number; lng: number; floor: number }): void {
		if (!this.enabled || !this.conditions) return;
		if (!this.conditions.location || this.conditions.location.length === 0) return;

		// Check each location — track which ones have been reached (AND logic)
		for (let i = 0; i < this.conditions.location.length; i++) {
			if (this.locationsReached.has(i)) continue; // Already reached this one

			const loc = this.conditions.location[i];
			const targetFloor = loc.floor ?? 0;
			if (pos.floor !== targetFloor) continue;

			const dx = pos.lng - loc.lng;
			const dy = pos.lat - loc.lat;
			const distance = Math.sqrt(dx * dx + dy * dy);
			const radius = loc.radius ?? 1;

			if (distance <= radius) {
				this.locationsReached.add(i);
				this.evaluate();
			}
		}
	}

	/** Get which location indices have been reached (for UI feedback) */
	getReachedLocations(): Set<number> {
		return new Set(this.locationsReached);
	}

	checkInventory(): void {
		if (!this.enabled || !this.conditions) return;
		if (!this.conditions.items || this.conditions.items.length === 0) return;
		if (!this.config.getInventoryItems) return;

		const currentItems = this.config.getInventoryItems();
		if (currentItems.length === 0) return; // Inventory not calibrated/detected

		// Check ALL items present with sufficient quantity (AND logic)
		let allSatisfied = true;
		for (const required of this.conditions.items) {
			let totalQuantity = 0;

			// Primary: match by pHash (stable across sessions)
			const requiredPHash = this.config.getItemPHash?.(required.name);
			if (requiredPHash) {
				const pHashMatches = currentItems.filter(
					item => item.pHash === requiredPHash
				);
				totalQuantity = pHashMatches.reduce((sum, item) => sum + item.quantity, 0);
			}

			// Fallback: match by name if pHash unavailable or no matches
			if (totalQuantity === 0) {
				const nameMatches = currentItems.filter(
					item => item.name?.toLowerCase() === required.name.toLowerCase()
				);
				totalQuantity = nameMatches.reduce((sum, item) => sum + item.quantity, 0);
			}

			if (totalQuantity < required.quantity) {
				allSatisfied = false;
				break;
			}
		}

		if (allSatisfied !== this.itemsSatisfied) {
			this.itemsSatisfied = allSatisfied;
			this.evaluate();
		}
	}

	private evaluate(): void {
		if (!this.enabled || !this.conditions || this.hasTriggered) return;

		const type = this.conditions.type;
		let shouldComplete = false;

		switch (type) {
			case "dialog": {
				const requiredCount = this.conditions.dialog?.length ?? 0;
				shouldComplete = requiredCount > 0 && this.dialogCompletedCount >= requiredCount;
				break;
			}
			case "location": {
				const totalLocations = this.conditions.location?.length ?? 0;
				shouldComplete = totalLocations > 0 && this.locationsReached.size >= totalLocations;
				break;
			}
			case "items": {
				shouldComplete = this.itemsSatisfied;
				break;
			}
			case "mixed": {
				// ALL present condition types must pass
				let allMet = true;

				if (this.conditions.dialog && this.conditions.dialog.length > 0) {
					if (this.dialogCompletedCount < this.conditions.dialog.length) allMet = false;
				}
				if (this.conditions.location && this.conditions.location.length > 0) {
					if (this.locationsReached.size < this.conditions.location.length) allMet = false;
				}
				if (this.conditions.items && this.conditions.items.length > 0) {
					if (!this.itemsSatisfied) allMet = false;
				}

				shouldComplete = allMet;
				break;
			}
		}

		if (shouldComplete) {
			this.hasTriggered = true;
			this.config.onStepComplete();
		}
	}
}
