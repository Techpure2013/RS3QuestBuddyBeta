import { useState, useEffect, useCallback } from "react";

export type BackgroundTheme = "default" | "brown";

export interface SettingsState {
	isExpandedMode: boolean;
	isSettingsModalOpen: boolean;
	isCompact: boolean;
	// GL Features
	dialogSolverEnabled: boolean;
	compassOverlayEnabled: boolean;
	wanderRadiusEnabled: boolean;
	pathfindingEnabled: boolean;
	stepOverlayEnabled: boolean;
	stepOverlayX: number;
	stepOverlayY: number;
	stepOverlayFontSize: number; // 14-22pt
	// Minimap overlay split into arrow (taxing) and marker (light)
	minimapArrowEnabled: boolean;
	minimapMarkerEnabled: boolean;
	// Legacy: kept for migration, maps to minimapMarkerEnabled
	minimapOverlayEnabled?: boolean;
	hudCompassEnabled: boolean;
	hudCompassX: number;
	hudCompassY: number;
	inventoryTrackingEnabled: boolean;
	autoAdvanceEnabled: boolean;
	// UI Settings
	toolTipsEnabled: boolean;
	autoScrollEnabled: boolean;
	richTextEnabled: boolean;
	backgroundTheme: BackgroundTheme;
	textColor: string;
	labelColor: string;
	buttonColor: string;
	textSwatches: string[];
	labelSwatches: string[];
	buttonSwatches: string[];
}

const SETTINGS_KEY = "appSettings";
const MAX_SWATCHES = 7;

const defaultSettings: SettingsState = {
	isExpandedMode: false,
	autoScrollEnabled: true,
	isSettingsModalOpen: false,
	isCompact: false,
	// GL Features
	dialogSolverEnabled: false,
	compassOverlayEnabled: false,
	wanderRadiusEnabled: true,  // On by default
	pathfindingEnabled: false,
	stepOverlayEnabled: false,
	stepOverlayX: 50,
	stepOverlayY: 50,
	stepOverlayFontSize: 14,
	minimapArrowEnabled: false,  // Very taxing - off by default
	minimapMarkerEnabled: true,  // Light - on by default
	hudCompassEnabled: false,
	hudCompassX: 1700,
	hudCompassY: 900,
	inventoryTrackingEnabled: false,
	autoAdvanceEnabled: false,
	// UI Settings
	toolTipsEnabled: true,
	richTextEnabled: true,
	backgroundTheme: "default",
	textColor: "",
	labelColor: "",
	buttonColor: "",
	textSwatches: [],
	labelSwatches: [],
	buttonSwatches: [],
};

/**
 * Migrate legacy minimapOverlayEnabled to new split settings
 */
function migrateSettings(saved: Partial<SettingsState>): Partial<SettingsState> {
	// If legacy setting exists and new settings don't
	if (saved.minimapOverlayEnabled !== undefined &&
		saved.minimapArrowEnabled === undefined &&
		saved.minimapMarkerEnabled === undefined) {
		// Migrate: legacy "on" means marker on, arrow off (to not surprise with high resource usage)
		saved.minimapMarkerEnabled = saved.minimapOverlayEnabled;
		saved.minimapArrowEnabled = false;
		delete saved.minimapOverlayEnabled;
	}
	return saved;
}

export const useSettingsStore = () => {
	const [settings, setSettings] = useState<SettingsState>(() => {
		try {
			const savedSettings = localStorage.getItem(SETTINGS_KEY);
			if (savedSettings) {
				// Parse, migrate legacy settings, then merge with defaults
				const parsed = migrateSettings(JSON.parse(savedSettings));
				return { ...defaultSettings, ...parsed };
			}
		} catch (error) {
			console.error("Failed to parse settings from localStorage", error);
		}
		return defaultSettings;
	});
	const toggleExpandedMode = useCallback(() => {
		setSettings((prev) => ({
			...prev,
			isExpandedMode: !prev.isExpandedMode,
		}));
	}, []);
	const toggleAutoScroll = useCallback(() => {
		setSettings((prev) => ({
			...prev,
			autoScrollEnabled: !prev.autoScrollEnabled,
		}));
	}, []);

	useEffect(() => {
		try {
			localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
		} catch (error) {
			console.error("Failed to save settings to localStorage", error);
		}
	}, [settings]);

	// Apply background theme using data attribute on html element (CSS handles the styling)
	useEffect(() => {
		if (settings.backgroundTheme === "brown") {
			document.documentElement.setAttribute("data-theme", "brown");
		} else {
			document.documentElement.removeAttribute("data-theme");
		}
	}, [settings.backgroundTheme]);

	const updateSetting = useCallback(
		<K extends keyof SettingsState>(key: K, value: SettingsState[K]) => {
			setSettings((prev) => ({
				...prev,
				[key]: value,
			}));
		},
		[],
	);
	const openSettingsModal = useCallback(() => {
		updateSetting("isSettingsModalOpen", true);
	}, [updateSetting]);

	const closeSettingsModal = useCallback(() => {
		updateSetting("isSettingsModalOpen", false);
	}, [updateSetting]);

	const addColorToSwatch = useCallback(
		(
			swatchKey: "textSwatches" | "labelSwatches" | "buttonSwatches",
			colorToAdd: string,
		) => {
			setSettings((prev) => {
				const currentSwatches = prev[swatchKey];
				// If the color is already in our history, do nothing.
				if (currentSwatches.includes(colorToAdd)) {
					return prev;
				}
				// Otherwise, add the new color to the front and trim the array.
				const newSwatches = [colorToAdd, ...currentSwatches].slice(0, MAX_SWATCHES);
				return {
					...prev,
					[swatchKey]: newSwatches,
				};
			});
		},
		[],
	);

	return {
		settings,
		updateSetting,
		addColorToSwatch,
		openSettingsModal,
		closeSettingsModal,
		toggleExpandedMode,
		toggleAutoScroll,
	};
};
