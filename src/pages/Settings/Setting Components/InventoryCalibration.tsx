/**
 * InventoryCalibration - Settings component for inventory mouse calibration.
 *
 * Runs the entire calibration flow visually in the settings UI:
 * - Shows current calibration status
 * - Displays a 3-2-1 countdown per slot
 * - Shows which slot to hover with row/col info
 * - Captures mouse samples and shows progress
 * - Saves to localStorage when complete
 *
 * Uses getGLBridge() for mouse position capture and getTooltipLearner()
 * for inventory grid detection and calibration import.
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import {
	Button,
	Group,
	Stack,
	Text,
	Badge,
	Progress,
	Alert,
	Paper,
	RingProgress,
	Center,
	Select,
	TextInput,
	ActionIcon,
	Collapse,
} from "@mantine/core";
import { IconInfoCircle, IconTrash, IconChevronRight } from "@tabler/icons-react";

const CALIBRATION_KEY = "inventoryMouseCalibration";
const PROFILES_KEY = "inventoryCalibrationProfiles";
const ACTIVE_PROFILE_KEY = "inventoryCalibrationActiveProfile";

/**
 * Get or create a GLBridge for calibration.
 * Tries the QSE integration first, then falls back to creating its own
 * (same pattern as test-tooltip-learner.ts getOrCreateGLBridge).
 */
async function getOrCreateBridge(): Promise<any> {
	// Try the integration singleton first
	try {
		const { getGLBridge } = require("../../../integration");
		const bridge = getGLBridge();
		if (bridge) return bridge;
	} catch {
		/* QSE not initialized */
	}

	// Try the shared global bridge (created by standalone learner or previous calibration)
	if ((window as any)._sharedGLBridge) return (window as any)._sharedGLBridge;

	const { GLBridgeAdapter } = require("../../../integration/GLBridgeAdapter");
	const { SpriteCache } = require("../../../gl/injection/reflect2d/spritecache");
	const patchrs = require("../../../gl/injection/util/patchrs_napi");
	const { getUIState } = require("../../../gl/injection/reflect2d/reflect2d");

	const spriteCache = new SpriteCache();
	await spriteCache.downloadCacheData();
	const bridge = new GLBridgeAdapter(spriteCache);
	const atlasTracker = bridge.getAtlasTracker();

	// Warm up atlas tracker (5 frames)
	for (let i = 0; i < 5; i++) {
		try {
			const renders = await patchrs.native.recordRenderCalls({
				features: ["vertexarray", "uniforms", "texturesnapshot"],
			});
			getUIState(renders, atlasTracker);
		} catch {
			/* ignore warm-up errors */
		}
	}

	// Initialize mouse tracking
	const mouseOk = await bridge.initMouseTracking();

	console.log(`[Calibration] GLBridge created, mouse tracking: ${mouseOk ? "OK" : "FAILED"}`);
	(window as any)._sharedGLBridge = bridge;
	return bridge;
}
const SAMPLES_PER_SLOT = 2;
const COUNTDOWN_SECONDS = 3;

interface CalibrationEntry {
	slot: number;
	x: number;
	y: number;
}

interface CalibrationProfile {
	name: string;
	data: CalibrationEntry[];
	createdAt: number;
}

interface CalibrationStatus {
	loaded: boolean;
	slotCount: number;
	data: CalibrationEntry[];
}

interface SlotTarget {
	slot: number;
	row: number;
	col: number;
	hasItem: boolean;
}

function loadCalibrationStatus(): CalibrationStatus {
	try {
		const saved = localStorage.getItem(CALIBRATION_KEY);
		if (saved) {
			const data = JSON.parse(saved) as CalibrationEntry[];
			return { loaded: true, slotCount: data.length, data };
		}
	} catch {
		/* ignore parse errors */
	}
	return { loaded: false, slotCount: 0, data: [] };
}

function loadProfiles(): CalibrationProfile[] {
	try {
		const saved = localStorage.getItem(PROFILES_KEY);
		if (saved) {
			return JSON.parse(saved) as CalibrationProfile[];
		}
	} catch {
		/* ignore parse errors */
	}
	return [];
}

function loadActiveProfileName(): string | null {
	try {
		return localStorage.getItem(ACTIVE_PROFILE_KEY);
	} catch {
		return null;
	}
}

const InventoryCalibration: React.FC = () => {
	const [status, setStatus] = useState<CalibrationStatus>(loadCalibrationStatus);
	const [profiles, setProfiles] = useState<CalibrationProfile[]>(loadProfiles);
	const [activeProfileName, setActiveProfileName] = useState<string | null>(loadActiveProfileName);
	const [newProfileName, setNewProfileName] = useState<string>("");

	// Calibration state
	const [isCalibrating, setIsCalibrating] = useState(false);
	const [countdown, setCountdown] = useState(0); // 3, 2, 1, 0=capture
	const [currentSlotIdx, setCurrentSlotIdx] = useState(0);
	const [slotTargets, setSlotTargets] = useState<SlotTarget[]>([]);
	const [samplesCollected, setSamplesCollected] = useState(0);
	const [completedSlots, setCompletedSlots] = useState(0);
	const [lastCapturedPos, setLastCapturedPos] = useState<{ x: number; y: number } | null>(null);
	const [errorMessage, setErrorMessage] = useState<string | null>(null);
	const [calibrationComplete, setCalibrationComplete] = useState(false);
	const [showProfiles, setShowProfiles] = useState(false);
	const [showDetails, setShowDetails] = useState(false);

	// Refs for intervals
	const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const captureRef = useRef<ReturnType<typeof setInterval> | null>(null);
	const calibrationDataRef = useRef<Map<number, { x: number; y: number }[]>>(new Map());

	// Function refs to break circular useCallback dependencies
	const startCaptureRef = useRef<() => void>(() => {});
	const startSlotCountdownRef = useRef<() => void>(() => {});
	const advanceToNextSlotRef = useRef<() => void>(() => {});
	const finishCalibrationRef = useRef<(targets: SlotTarget[]) => void>(() => {});
	const profilesRef = useRef(profiles);
	profilesRef.current = profiles;

	// Cleanup on unmount
	useEffect(() => {
		return () => {
			if (countdownRef.current) clearInterval(countdownRef.current);
			if (captureRef.current) clearInterval(captureRef.current);
		};
	}, []);

	// Refresh status from localStorage
	const refreshStatus = useCallback(() => {
		setStatus(loadCalibrationStatus());
		setProfiles(loadProfiles());
		setActiveProfileName(loadActiveProfileName());
	}, []);

	// Save a profile
	const saveProfile = useCallback((name: string, data: CalibrationEntry[]) => {
		const updatedProfiles = [...profiles];
		const existingIdx = updatedProfiles.findIndex(p => p.name === name);

		const profile: CalibrationProfile = {
			name,
			data,
			createdAt: Date.now(),
		};

		if (existingIdx >= 0) {
			updatedProfiles[existingIdx] = profile;
		} else {
			updatedProfiles.push(profile);
		}

		try {
			localStorage.setItem(PROFILES_KEY, JSON.stringify(updatedProfiles));
			setProfiles(updatedProfiles);
		} catch (e) {
			console.warn("[Calibration] Could not save profile:", e);
		}
	}, [profiles]);

	// Activate a profile
	const activateProfile = useCallback((profile: CalibrationProfile) => {
		try {
			// Write profile data to the active calibration key
			localStorage.setItem(CALIBRATION_KEY, JSON.stringify(profile.data));
			localStorage.setItem(ACTIVE_PROFILE_KEY, profile.name);

			// Import into tooltip learner
			try {
				const { getTooltipLearner } = require("../../../integration");
				const learner = getTooltipLearner();
				if (learner) {
					learner.importCalibration(profile.data);
				}
			} catch {
				/* ignore */
			}

			// Store globally
			(window as any)._mouseCalibrationData = profile.data;

			setActiveProfileName(profile.name);
			refreshStatus();
		} catch (e) {
			console.warn("[Calibration] Could not activate profile:", e);
		}
	}, [refreshStatus]);

	// Delete a profile
	const deleteProfile = useCallback((name: string) => {
		const updatedProfiles = profiles.filter(p => p.name !== name);
		try {
			localStorage.setItem(PROFILES_KEY, JSON.stringify(updatedProfiles));

			// If we deleted the active profile, clear active status
			if (activeProfileName === name) {
				localStorage.removeItem(ACTIVE_PROFILE_KEY);
				setActiveProfileName(null);
			}

			setProfiles(updatedProfiles);
		} catch (e) {
			console.warn("[Calibration] Could not delete profile:", e);
		}
	}, [profiles, activeProfileName]);

	// Clear calibration data
	const handleClear = useCallback(() => {
		try {
			localStorage.removeItem(CALIBRATION_KEY);
			delete (window as any)._mouseCalibrationData;

			// Also clear from the tooltip learner if available
			try {
				const { getTooltipLearner } = require("../../../integration");
				const learner = getTooltipLearner();
				if (learner) {
					learner.clearCalibration();
				}
			} catch {
				/* ignore */
			}
		} catch {
			/* ignore */
		}
		refreshStatus();
	}, [refreshStatus]);

	// Detect inventory and build slot target list
	const detectInventory = useCallback(async (): Promise<SlotTarget[]> => {
		try {
			const glBridge = await getOrCreateBridge();

			// Try to get the tooltip learner (may not exist if QSE not initialized)
			let learner: any = null;
			try {
				const { getTooltipLearner } = require("../../../integration");
				learner = getTooltipLearner();
			} catch {
				/* ignore */
			}

			// Use patchrs to capture a frame and detect UI elements
			const patchrs = require("../../../gl/injection/util/patchrs_napi");
			const { getUIState } = require("../../../gl/injection/reflect2d/reflect2d");

			const renders = await patchrs.native.recordRenderCalls({
				features: ["vertexarray", "uniforms", "texturesnapshot"],
			});

			const atlasTracker = glBridge.getAtlasTracker();
			const uiState = getUIState(renders, atlasTracker);

			// Convert to RenderRect format
			const elements = uiState.elements.map((el: any) => ({
				x: el.x,
				y: el.y,
				width: el.width,
				height: el.height,
				color: [
					Math.round(el.color[3] * 255),
					Math.round(el.color[2] * 255),
					Math.round(el.color[1] * 255),
					Math.round(el.color[0] * 255),
				],
				sprite: {
					hash: el.sprite.pixelhash,
					known: el.sprite.known
						? {
								id: el.sprite.known.id,
								subId: el.sprite.known.subid,
								fontchr: el.sprite.known.fontchr
									? { chr: el.sprite.known.fontchr.chr, charcode: el.sprite.known.fontchr.charcode }
									: undefined,
								font: el.sprite.known.font,
							}
						: undefined,
					basetex: el.sprite.basetex,
					pixelhash: el.sprite.pixelhash,
					x: el.sprite.x,
					y: el.sprite.y,
					width: el.sprite.width,
					height: el.sprite.height,
				},
			}));

			// Let the learner detect from elements to auto-calibrate its grid
			if (learner) {
				learner.detectFromElements(elements, renders, null);
			}

			// Find inventory slot sprites (ID 18266)
			const INVENTORY_SLOT_SPRITE_ID = 18266;
			const slotSprites = elements.filter(
				(el: any) => el.sprite?.known?.id === INVENTORY_SLOT_SPRITE_ID
			);

			if (slotSprites.length === 0) {
				throw new Error("No inventory slots detected. Make sure your inventory is open!");
			}

			// Cluster into columns and rows
			const xValues = slotSprites.map((s: any) => s.x);
			const yValues = slotSprites.map((s: any) => s.y);

			const xClusters = clusterValues(xValues, 8).filter((c) => c.count >= 2);
			const yClusters = clusterValues(yValues, 8).filter((c) => c.count >= 2);

			const colCenters = (xClusters.length >= 2 ? xClusters : clusterValues(xValues, 8)).map((c) => c.center);
			const rowCenters = (yClusters.length >= 2 ? yClusters : clusterValues(yValues, 8))
				.map((c) => c.center)
				.reverse(); // GL Y-up: row 0 = top = highest Y

			const numCols = colCenters.length;
			const SLOT_WIDTH = 40;
			const SLOT_HEIGHT = 36;

			const targets: SlotTarget[] = [];
			for (let row = 0; row < rowCenters.length; row++) {
				for (let col = 0; col < colCenters.length; col++) {
					const slotIndex = row * numCols + col;
					const slotX = colCenters[col];
					const slotY = rowCenters[row];

					// Check if slot has an item
					const hasItem = elements.some((el: any) => {
						if (el.sprite?.known?.id === INVENTORY_SLOT_SPRITE_ID) return false;
						if (el.sprite?.known?.fontchr) return false;
						if (el.width < 10 || el.height < 10) return false;
						return (
							el.x >= slotX - 2 &&
							el.y >= slotY - 2 &&
							el.x + el.width <= slotX + SLOT_WIDTH + 5 &&
							el.y + el.height <= slotY + SLOT_HEIGHT + 5
						);
					});

					if (hasItem) {
						targets.push({ slot: slotIndex, row: row + 1, col: col + 1, hasItem });
					}
				}
			}

			return targets;
		} catch (err) {
			throw err;
		}
	}, []);

	// Start countdown for current slot, then capture
	const startSlotCountdown = useCallback(() => {
		setCountdown(COUNTDOWN_SECONDS);
		setSamplesCollected(0);
		setLastCapturedPos(null);

		let remaining = COUNTDOWN_SECONDS;
		if (countdownRef.current) clearInterval(countdownRef.current);

		countdownRef.current = setInterval(() => {
			remaining--;
			setCountdown(remaining);

			if (remaining <= 0) {
				clearInterval(countdownRef.current!);
				countdownRef.current = null;
				startCaptureRef.current();
			}
		}, 1000);
	}, []);
	startSlotCountdownRef.current = startSlotCountdown;

	// Capture mouse samples for current slot
	const startCapture = useCallback(() => {
		if (captureRef.current) clearInterval(captureRef.current);

		let captured = 0;

		captureRef.current = setInterval(() => {
			try {
				if (!(window as any)._sharedGLBridge) return;

				const mousePos = (window as any)._sharedGLBridge.getMousePositionGL();
				if (!mousePos) return;

				setCurrentSlotIdx((idx) => {
					setSlotTargets((targets) => {
						if (idx >= targets.length) return targets;
						const target = targets[idx];
						let samples = calibrationDataRef.current.get(target.slot);
						if (!samples) {
							samples = [];
							calibrationDataRef.current.set(target.slot, samples);
						}
						samples.push({ x: mousePos.x, y: mousePos.y });
						captured = samples.length;
						setSamplesCollected(captured);
						setLastCapturedPos({ x: mousePos.x, y: mousePos.y });
						return targets;
					});
					return idx;
				});

				if (captured >= SAMPLES_PER_SLOT) {
					clearInterval(captureRef.current!);
					captureRef.current = null;
					advanceToNextSlotRef.current();
				}
			} catch {
				// Ignore frame errors
			}
		}, 300);
	}, []);
	startCaptureRef.current = startCapture;

	// Advance to next slot or finish
	const advanceToNextSlot = useCallback(() => {
		setCurrentSlotIdx((prevIdx) => {
			const nextIdx = prevIdx + 1;
			setCompletedSlots(nextIdx);

			setSlotTargets((targets) => {
				if (nextIdx >= targets.length) {
					finishCalibrationRef.current(targets);
					return targets;
				}

				setTimeout(() => {
					startSlotCountdownRef.current();
				}, 500);

				return targets;
			});

			return nextIdx;
		});
	}, []);
	advanceToNextSlotRef.current = advanceToNextSlot;

	// Finish calibration and save
	const finishCalibration = useCallback((_targets: SlotTarget[]) => {
		if (countdownRef.current) clearInterval(countdownRef.current);
		if (captureRef.current) clearInterval(captureRef.current);

		const exportData: CalibrationEntry[] = [];
		for (const [slot, samples] of calibrationDataRef.current) {
			if (samples.length > 0) {
				const avgX = samples.reduce((s, p) => s + p.x, 0) / samples.length;
				const avgY = samples.reduce((s, p) => s + p.y, 0) / samples.length;
				exportData.push({ slot, x: avgX, y: avgY });
			}
		}

		// Save to localStorage
		try {
			localStorage.setItem(CALIBRATION_KEY, JSON.stringify(exportData));
		} catch (e) {
			console.warn("[Calibration] Could not save to localStorage:", e);
		}

		// Import into tooltip learner
		try {
			const { getTooltipLearner } = require("../../../integration");
			const learner = getTooltipLearner();
			if (learner) {
				learner.importCalibration(exportData);
			}
		} catch {
			/* ignore */
		}

		// Store globally
		(window as any)._mouseCalibrationData = exportData;

		// Auto-save as a profile with default name (use ref for fresh profiles count)
		const currentProfiles = profilesRef.current;
		const defaultName = `Profile ${currentProfiles.length + 1}`;
		setNewProfileName(defaultName);

		// Save profile directly (avoid stale saveProfile closure)
		const updatedProfiles = [...currentProfiles];
		const existingIdx = updatedProfiles.findIndex(p => p.name === defaultName);
		const newProfile: CalibrationProfile = { name: defaultName, data: exportData, createdAt: Date.now() };
		if (existingIdx >= 0) {
			updatedProfiles[existingIdx] = newProfile;
		} else {
			updatedProfiles.push(newProfile);
		}
		try {
			localStorage.setItem(PROFILES_KEY, JSON.stringify(updatedProfiles));
			setProfiles(updatedProfiles);
		} catch (e) {
			console.warn("[Calibration] Could not save profile:", e);
		}

		// Set as active profile
		try {
			localStorage.setItem(ACTIVE_PROFILE_KEY, defaultName);
			setActiveProfileName(defaultName);
		} catch {
			/* ignore */
		}

		setIsCalibrating(false);
		setCalibrationComplete(true);
		refreshStatus();
	}, [refreshStatus]);
	finishCalibrationRef.current = finishCalibration;

	// Start calibration
	const handleStartCalibration = useCallback(async () => {
		setErrorMessage(null);
		setCalibrationComplete(false);
		setCompletedSlots(0);
		setCurrentSlotIdx(0);
		setSamplesCollected(0);
		setLastCapturedPos(null);
		calibrationDataRef.current = new Map();

		try {
			const targets = await detectInventory();
			if (targets.length === 0) {
				setErrorMessage("No slots with items found. Put items in your inventory first!");
				return;
			}

			setSlotTargets(targets);
			setIsCalibrating(true);

			// Start first slot countdown after a short delay
			setTimeout(() => {
				startSlotCountdownRef.current();
			}, 500);
		} catch (err) {
			setErrorMessage((err as Error).message);
		}
	}, [detectInventory]);

	// Stop calibration
	const handleStopCalibration = useCallback(() => {
		if (countdownRef.current) clearInterval(countdownRef.current);
		if (captureRef.current) clearInterval(captureRef.current);
		setIsCalibrating(false);
		setCalibrationComplete(false);
		refreshStatus();
	}, [refreshStatus]);

	const currentTarget = slotTargets[currentSlotIdx] ?? null;
	const totalTargets = slotTargets.length;
	const progressPct = totalTargets > 0 ? (completedSlots / totalTargets) * 100 : 0;

	return (
		<Stack gap="sm">
			<Alert
				variant="light"
				color="blue"
				icon={<IconInfoCircle size={16} />}
				p="xs"
			>
				<Text size="xs">
					Calibrates mouse tracking for inventory slots. Compensates for IPC drift. Saved between sessions — only recalibrate if resolution or monitor changes.
				</Text>
			</Alert>

			{/* Calibration in progress */}
			{isCalibrating && currentTarget && (
				<Paper p="md" withBorder style={{ borderColor: "var(--mantine-color-blue-6)" }}>
					<Stack gap="sm" align="center">
						{/* Overall progress */}
						<Group justify="space-between" w="100%">
							<Text size="xs" c="dimmed">
								Slot {completedSlots + 1} of {totalTargets}
							</Text>
							<Text size="xs" c="dimmed">
								{Math.round(progressPct)}%
							</Text>
						</Group>
						<Progress value={progressPct} size="sm" w="100%" animated />

						{/* Current slot instruction */}
						<Paper p="md" withBorder w="100%" style={{ textAlign: "center", background: "var(--mantine-color-dark-7, #1a1b1e)" }}>
							<Text size="lg" fw={700} c="blue">
								Hover Slot {currentTarget.slot + 1}
							</Text>
							<Text size="sm" c="dimmed">
								Row {currentTarget.row}, Column {currentTarget.col}
							</Text>
						</Paper>

						{/* Countdown or capture indicator */}
						{countdown > 0 ? (
							<Center>
								<RingProgress
									size={80}
									thickness={6}
									roundCaps
									sections={[{ value: ((COUNTDOWN_SECONDS - countdown) / COUNTDOWN_SECONDS) * 100, color: "blue" }]}
									label={
										<Text ta="center" size="xl" fw={700}>
											{countdown}
										</Text>
									}
								/>
							</Center>
						) : (
							<Stack gap={4} align="center">
								<Badge color="green" variant="filled" size="lg">
									CAPTURING — Hold Still!
								</Badge>
								<Text size="xs" c="dimmed">
									{samplesCollected}/{SAMPLES_PER_SLOT} samples
								</Text>
								{lastCapturedPos && (
									<Text size="xs" c="dimmed" style={{ fontFamily: "monospace" }}>
										Mouse: ({Math.round(lastCapturedPos.x)}, {Math.round(lastCapturedPos.y)})
									</Text>
								)}
							</Stack>
						)}
					</Stack>
				</Paper>
			)}

			{/* Status and controls when NOT calibrating */}
			{!isCalibrating && (
				<>
					{/* Compact status bar */}
					<Paper p="sm" withBorder>
						<Group justify="space-between" align="center" mb="xs">
							<Group gap="xs">
								<Badge
									color={status.loaded ? "green" : "yellow"}
									variant="light"
									size="sm"
								>
									{status.loaded ? "Active" : "Not Set"}
								</Badge>
								<Text size="sm" c="dimmed">
									{status.loaded ? `${status.slotCount} slots calibrated` : "No calibration data"}
								</Text>
							</Group>
						</Group>

						{profiles.length > 0 && (
							<Select
								label="Profile"
								placeholder="Select a profile"
								data={profiles.map(p => ({ value: p.name, label: p.name }))}
								value={activeProfileName}
								onChange={(value) => {
									const profile = profiles.find(p => p.name === value);
									if (profile) {
										activateProfile(profile);
									}
								}}
								size="xs"
							/>
						)}
					</Paper>

					{/* Success message with inline rename */}
					{calibrationComplete && newProfileName && (
						<Paper p="sm" withBorder style={{ borderColor: "var(--mantine-color-green-6)" }}>
							<Text size="sm" fw={500} c="green" mb="xs">
								✓ Calibration complete! {calibrationDataRef.current.size} slots
							</Text>
							<Group gap="xs" align="flex-end">
								<TextInput
									placeholder="Profile name"
									value={newProfileName}
									onChange={(e) => setNewProfileName(e.currentTarget.value)}
									size="xs"
									style={{ flex: 1 }}
								/>
								<Button
									size="xs"
									onClick={() => {
										if (newProfileName.trim()) {
											// Find the auto-created profile and rename it
											const autoProfile = profiles.find(p => p.name === `Profile ${profiles.length}`);
											if (autoProfile && newProfileName !== autoProfile.name) {
												// Delete old profile
												deleteProfile(autoProfile.name);
												// Save with new name
												saveProfile(newProfileName.trim(), autoProfile.data);
												// Activate with new name
												try {
													localStorage.setItem(ACTIVE_PROFILE_KEY, newProfileName.trim());
													setActiveProfileName(newProfileName.trim());
												} catch {
													/* ignore */
												}
											}
											setNewProfileName("");
											setCalibrationComplete(false);
											refreshStatus();
										}
									}}
								>
									Save
								</Button>
							</Group>
						</Paper>
					)}

					{/* Error message */}
					{errorMessage && (
						<Alert variant="light" color="red" p="xs">
							<Text size="sm">{errorMessage}</Text>
						</Alert>
					)}

					{/* Actions */}
					<Group gap="sm">
						<Button
							variant="filled"
							size="xs"
							onClick={handleStartCalibration}
						>
							{status.loaded ? "New Calibration" : "Start Calibration"}
						</Button>

						{status.loaded && (
							<Button
								variant="outline"
								size="xs"
								color="red"
								onClick={handleClear}
							>
								Clear
							</Button>
						)}
					</Group>

					{/* Collapsible saved profiles */}
					{profiles.length > 0 && (
						<Stack gap="xs">
							<Group
								gap="xs"
								style={{ cursor: "pointer" }}
								onClick={() => setShowProfiles(!showProfiles)}
							>
								<IconChevronRight
									size={14}
									style={{
										transform: showProfiles ? "rotate(90deg)" : "rotate(0deg)",
										transition: "transform 150ms ease",
									}}
								/>
								<Text size="sm" fw={500}>Saved Profiles ({profiles.length})</Text>
							</Group>
							<Collapse in={showProfiles}>
								<Stack gap="xs">
									{profiles.map((profile) => (
										<Paper key={profile.name} p="xs" withBorder style={{ background: "var(--mantine-color-dark-6, #2c2e33)" }}>
											<Group justify="space-between" align="center">
												<div style={{ flex: 1 }}>
													<Group gap="xs" align="center">
														<Text size="sm" fw={500}>
															{profile.name}
														</Text>
														{activeProfileName === profile.name && (
															<Badge size="xs" color="green" variant="filled">
																Active
															</Badge>
														)}
													</Group>
													<Text size="xs" c="dimmed">
														{profile.data.length} slots • {new Date(profile.createdAt).toLocaleDateString()}
													</Text>
												</div>
												<ActionIcon
													color="red"
													variant="subtle"
													size="sm"
													onClick={() => deleteProfile(profile.name)}
												>
													<IconTrash size={16} />
												</ActionIcon>
											</Group>
										</Paper>
									))}
								</Stack>
							</Collapse>
						</Stack>
					)}

					{/* Collapsible calibration details */}
					{status.loaded && status.data.length > 0 && (
						<Stack gap="xs">
							<Group
								gap="xs"
								style={{ cursor: "pointer" }}
								onClick={() => setShowDetails(!showDetails)}
							>
								<IconChevronRight
									size={14}
									style={{
										transform: showDetails ? "rotate(90deg)" : "rotate(0deg)",
										transition: "transform 150ms ease",
									}}
								/>
								<Text size="sm" fw={500}>Calibration Details</Text>
							</Group>
							<Collapse in={showDetails}>
								<Stack gap={2} mt="xs">
									{status.data
										.sort((a, b) => a.slot - b.slot)
										.map((entry) => (
											<Text key={entry.slot} size="xs" c="dimmed" style={{ fontFamily: "monospace" }}>
												Slot {entry.slot + 1}: ({Math.round(entry.x)}, {Math.round(entry.y)})
											</Text>
										))}
								</Stack>
							</Collapse>
						</Stack>
					)}
				</>
			)}
		</Stack>
	);
};

/**
 * Cluster numeric values within tolerance
 */
function clusterValues(
	values: number[],
	tolerance: number
): { center: number; count: number }[] {
	const sorted = [...values].sort((a, b) => a - b);
	const clusters: { sum: number; count: number; center: number }[] = [];

	for (const val of sorted) {
		let merged = false;
		for (const cluster of clusters) {
			if (Math.abs(val - cluster.center) <= tolerance) {
				cluster.sum += val;
				cluster.count++;
				cluster.center = cluster.sum / cluster.count;
				merged = true;
				break;
			}
		}
		if (!merged) {
			clusters.push({ sum: val, count: 1, center: val });
		}
	}

	return clusters
		.sort((a, b) => a.center - b.center)
		.map((c) => ({ center: c.center, count: c.count }));
}

export default InventoryCalibration;
