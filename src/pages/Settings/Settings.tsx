import {
	Accordion,
	AccordionControl,
	AccordionPanel,
	Button,
	Group,
	Select,
	Slider,
	Stack,
	Switch,
	Text,
	Tooltip,
	Divider,
} from "@mantine/core";
import { IconInfoCircle } from "@tabler/icons-react";
import { ColorPicker } from "../../Components/ColorPicker";
import { lazy, Suspense, useEffect, useState } from "react";
import { useDisclosure } from "@mantine/hooks";
import { useSettings } from "./../../Entrance/Entrance Components/SettingsContext";
import FontSizeControls from "./Setting Components/FontSizeInput";
import StepOverlayPositionEditor from "./Setting Components/StepOverlayPositionEditor";
import InventoryCalibration from "./Setting Components/InventoryCalibration";
import { getUIScaleInfo, onResolutionChange, type UIScaleInfo } from "../../gl/UIScaleManager";
import { isGlInjectionAvailable } from "../../api/glInjection";

const QuestStorageManager = lazy(
	() => import("./Setting Components/QuestStorageManager"),
);

/** Info icon with tooltip for GL feature descriptions */
const FeatureInfo: React.FC<{ info: string }> = ({ info }) => (
	<Tooltip label={info} multiline w={280} withArrow position="right">
		<IconInfoCircle size={16} style={{ opacity: 0.6, cursor: "help" }} />
	</Tooltip>
);

/** Switch with info icon for GL features */
const GlFeatureSwitch: React.FC<{
	label: string;
	checked: boolean;
	onChange: (checked: boolean) => void;
	info: string;
	textColor?: string;
}> = ({ label, checked, onChange, info, textColor }) => (
	<Group gap="xs" wrap="nowrap">
		<Switch
			styles={{ label: { color: textColor || "" } }}
			label={label}
			checked={checked}
			onChange={(e) => onChange(e.currentTarget.checked)}
		/>
		<FeatureInfo info={info} />
	</Group>
);

const Settings: React.FC = () => {
	const {
		settings,
		updateSetting,
		addColorToSwatch,
		toggleExpandedMode,
		toggleAutoScroll,
	} = useSettings();
	const [isOpen, { open, close }] = useDisclosure(false);

	// Track UI resolution from UIScaleManager (for overlay position editor)
	const [uiResolution, setUiResolution] = useState<{ width: number; height: number }>(() => {
		if (isGlInjectionAvailable()) {
			const info = getUIScaleInfo();
			return { width: info.uiWidth, height: info.uiHeight };
		}
		return { width: 1920, height: 1080 };
	});

	// Subscribe to resolution changes
	useEffect(() => {
		if (!isGlInjectionAvailable()) return;

		const unsubscribe = onResolutionChange((info: UIScaleInfo) => {
			setUiResolution({ width: info.uiWidth, height: info.uiHeight });
		});

		return unsubscribe;
	}, []);

	const hasTextColor = !!settings.textColor;
	const hasLabelColor = !!settings.labelColor;
	const hasButtonColor = !!settings.buttonColor;

	return (
		<div className="SettingsContainer">
			<Stack>
				<Button onClick={open}>Manage Saved Quest Progress</Button>
				<Suspense fallback={<div>Loading...</div>}>
					<QuestStorageManager opened={isOpen} onClose={close} />
				</Suspense>

				{/* General UI Settings */}
				<Switch
					styles={{ label: { color: hasTextColor ? settings.textColor : "" } }}
					label={settings.isCompact ? "Compact Mode On" : "Compact Mode Off"}
					checked={settings.isCompact}
					onChange={(e) => updateSetting("isCompact", e.currentTarget.checked)}
				/>
				<Switch
					styles={{ label: { color: hasTextColor ? settings.textColor : "" } }}
					label={settings.toolTipsEnabled ? "Tool Tips On" : "Tool Tips Off"}
					checked={settings.toolTipsEnabled}
					onChange={(e) => updateSetting("toolTipsEnabled", e.currentTarget.checked)}
				/>
				<Switch
					styles={{ label: { color: hasTextColor ? settings.textColor : "" } }}
					label={settings.isExpandedMode ? "Expanded Mode On" : "Expanded Mode Off"}
					checked={settings.isExpandedMode}
					onChange={toggleExpandedMode}
				/>
				<Switch
					styles={{ label: { color: hasTextColor ? settings.textColor : "" } }}
					label={settings.autoScrollEnabled ? "Auto-Scroll On" : "Auto-Scroll Off"}
					checked={settings.autoScrollEnabled}
					onChange={toggleAutoScroll}
				/>

				<Select
					label="Background Theme"
					value={settings.backgroundTheme}
					onChange={(value) => updateSetting("backgroundTheme", (value as "default" | "brown") || "default")}
					data={[
						{ value: "default", label: "Default (Blue)" },
						{ value: "brown", label: "Brown" },
					]}
					styles={{
						label: { color: hasLabelColor ? settings.labelColor : "" },
					}}
				/>

				{/* GL Features Section */}
				<Divider
					my="sm"
					label={
						<Text size="sm" fw={600}>
							GL Features
						</Text>
					}
					labelPosition="center"
				/>

				<GlFeatureSwitch
					label={settings.dialogSolverEnabled ? "Dialog Solver On" : "Dialog Solver Off"}
					checked={settings.dialogSolverEnabled}
					onChange={(checked) => updateSetting("dialogSolverEnabled", checked)}
					info="Highlights dialog options during quest conversations. Light resource usage."
					textColor={hasTextColor ? settings.textColor : undefined}
				/>

				<GlFeatureSwitch
					label={settings.compassOverlayEnabled ? "NPC Compass On" : "NPC Compass Off"}
					checked={settings.compassOverlayEnabled}
					onChange={(checked) => updateSetting("compassOverlayEnabled", checked)}
					info="Shows a 3D compass rose above quest NPCs. Light resource usage."
					textColor={hasTextColor ? settings.textColor : undefined}
				/>

				<GlFeatureSwitch
					label={settings.wanderRadiusEnabled ? "NPC Wander Radius On" : "NPC Wander Radius Off"}
					checked={settings.wanderRadiusEnabled}
					onChange={(checked) => updateSetting("wanderRadiusEnabled", checked)}
					info="Shows a shaded area around quest NPCs indicating their wander range. Light resource usage."
					textColor={hasTextColor ? settings.textColor : undefined}
				/>

				<GlFeatureSwitch
					label={settings.stepOverlayEnabled ? "Step Overlay On" : "Step Overlay Off"}
					checked={settings.stepOverlayEnabled}
					onChange={(checked) => updateSetting("stepOverlayEnabled", checked)}
					info="Displays current quest step text on the game screen. Light resource usage."
					textColor={hasTextColor ? settings.textColor : undefined}
				/>

				<GlFeatureSwitch
					label={settings.inventoryTrackingEnabled ? "Inventory Tracking On" : "Inventory Tracking Off"}
					checked={settings.inventoryTrackingEnabled}
					onChange={(checked) => {
						updateSetting("inventoryTrackingEnabled", checked);
						(async () => {
							try {
								const { getOrCreateTooltipLearner } = require("../../integration");
								const learner = await getOrCreateTooltipLearner();
								if (learner) {
									if (checked) {
										learner.startPolling(500);
										console.log('[Settings] Inventory tracking started');
									} else {
										learner.stopPolling();
										console.log('[Settings] Inventory tracking stopped');
									}
								}
							} catch (e) {
								console.warn('[Settings] Could not start inventory tracking:', e);
							}
						})();
					}}
					info="Passively learns item names by detecting tooltips when hovering inventory items. Requires mouse calibration. Light resource usage."
					textColor={hasTextColor ? settings.textColor : undefined}
				/>

				<GlFeatureSwitch
					label={settings.autoAdvanceEnabled ? "Auto-Advance On" : "Auto-Advance Off"}
					checked={settings.autoAdvanceEnabled}
					onChange={(checked) => updateSetting("autoAdvanceEnabled", checked)}
					info="Automatically advances to the next quest step when completion conditions are met (dialog, location, or items). Requires quest steps to have completion conditions defined."
					textColor={hasTextColor ? settings.textColor : undefined}
				/>
			</Stack>

			<Accordion mt="md">
				<Accordion.Item key="text-color" value="Color Your Text">
					<AccordionControl
						styles={{ control: { color: hasLabelColor ? settings.labelColor : "" } }}
					>
						Color Your Text
					</AccordionControl>
					<AccordionPanel>
						<ColorPicker
							format="hex"
							value={settings.textColor}
							onChange={(value) => updateSetting("textColor", value)}
							onChangeEnd={(value) => addColorToSwatch("textSwatches", value)}
							swatches={settings.textSwatches}
						/>
						<Button
							mt="xs"
							variant="outline"
							color={hasButtonColor ? settings.buttonColor : "blue"}
							onClick={() => updateSetting("textSwatches", [])}
						>
							Clear Swatches
						</Button>
					</AccordionPanel>
				</Accordion.Item>

				<Accordion.Item key="label-color" value="Color Your Labels">
					<AccordionControl
						styles={{ control: { color: hasLabelColor ? settings.labelColor : "" } }}
					>
						Color Your Labels
					</AccordionControl>
					<AccordionPanel>
						<ColorPicker
							format="hex"
							value={settings.labelColor}
							onChange={(value) => updateSetting("labelColor", value)}
							onChangeEnd={(value) => addColorToSwatch("labelSwatches", value)}
							swatches={settings.labelSwatches}
						/>
						<Button
							mt="xs"
							variant="outline"
							color={hasButtonColor ? settings.buttonColor : "blue"}
							onClick={() => updateSetting("labelSwatches", [])}
						>
							Clear Swatches
						</Button>
					</AccordionPanel>
				</Accordion.Item>

				<Accordion.Item key="button-color" value="Color Your Buttons">
					<AccordionControl
						styles={{ control: { color: hasLabelColor ? settings.labelColor : "" } }}
					>
						Color Your Buttons
					</AccordionControl>
					<AccordionPanel>
						<ColorPicker
							format="hex"
							value={settings.buttonColor}
							onChange={(value) => updateSetting("buttonColor", value)}
							onChangeEnd={(value) => addColorToSwatch("buttonSwatches", value)}
							swatches={settings.buttonSwatches}
						/>
						<Button
							mt="xs"
							variant="outline"
							color={hasButtonColor ? settings.buttonColor : "blue"}
							onClick={() => updateSetting("buttonSwatches", [])}
						>
							Clear Swatches
						</Button>
					</AccordionPanel>
				</Accordion.Item>

				<Accordion.Item key="font-size" value="Change Your FontSize">
					<AccordionControl
						styles={{ control: { color: hasLabelColor ? settings.labelColor : "" } }}
					>
						Change Font Size
					</AccordionControl>
					<AccordionPanel>
						<FontSizeControls />
					</AccordionPanel>
				</Accordion.Item>

				{/* GL Position Settings */}
				<Accordion.Item key="step-overlay-position" value="Step Overlay Position">
					<AccordionControl
						styles={{ control: { color: hasLabelColor ? settings.labelColor : "" } }}
					>
						Step Overlay Settings
					</AccordionControl>
					<AccordionPanel>
						<Stack gap="md">
							<div>
								<Text size="sm" mb="xs">Font Size: {settings.stepOverlayFontSize}pt</Text>
								<Slider
									value={settings.stepOverlayFontSize}
									onChange={(value) => updateSetting("stepOverlayFontSize", value)}
									min={14}
									max={22}
									step={1}
									marks={[
										{ value: 14, label: "14" },
										{ value: 18, label: "18" },
										{ value: 22, label: "22" },
									]}
								/>
							</div>
							<Divider />
							<StepOverlayPositionEditor
								positionX={settings.stepOverlayX}
								positionY={settings.stepOverlayY}
								onPositionChange={(x, y) => {
									updateSetting("stepOverlayX", x);
									updateSetting("stepOverlayY", y);
								}}
								screenWidth={uiResolution.width}
								screenHeight={uiResolution.height}
							/>
						</Stack>
					</AccordionPanel>
				</Accordion.Item>

				{/* Inventory Mouse Calibration — only available via alt1gl launcher */}
				{isGlInjectionAvailable() && (
					<Accordion.Item key="inventory-calibration" value="Inventory Calibration">
						<AccordionControl
							styles={{ control: { color: hasLabelColor ? settings.labelColor : "" } }}
						>
							Inventory Mouse Calibration
						</AccordionControl>
						<AccordionPanel>
							<InventoryCalibration />
						</AccordionPanel>
					</Accordion.Item>
				)}
			</Accordion>
		</div>
	);
};
export default Settings;
