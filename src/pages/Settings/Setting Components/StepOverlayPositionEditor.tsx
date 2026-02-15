/**
 * StepOverlayPositionEditor - Visual drag-to-position editor for the quest step overlay
 *
 * Displays a preview of the overlay position on a miniature game screen representation.
 * Users can drag the overlay box to reposition it with snap-to-edge functionality.
 * Can detect actual RS3 UI element positions from GL render data.
 */

import React, { useCallback, useRef, useState, useEffect, useMemo } from "react";
import { Box, Text, Button, Group, Stack, Paper, Switch, Loader } from "@mantine/core";
import {
  initUIBoundsDetector,
  detectUIBounds,
  type UIBounds,
  type UIBoundsResult,
  isUIBoundsDetectorInitialized,
} from "../../../gl/UIBoundsDetector";
import { isGlInjectionAvailable } from "../../../api/glInjection";

// Snap distance threshold in preview pixels (not screen pixels)
// This makes snapping feel consistent regardless of screen resolution
const SNAP_THRESHOLD_PREVIEW = 12;

// Snap point types
type SnapType = "edge" | "center" | "quarter" | "ui";

interface SnapPoint {
  position: number;  // Position in screen coordinates
  type: SnapType;
  axis: "x" | "y";
  label?: string;
}

// RS3 UI element approximate positions (relative to screen)
// These are common positions for default RS3 interface layouts
interface UIElement {
  name: string;
  x: number;       // Percentage from left (0-1)
  y: number;       // Percentage from top (0-1)
  width: number;   // Percentage of screen width
  height: number;  // Percentage of screen height
  color: string;   // Color for preview display
}

interface ActiveSnap {
  x: SnapPoint | null;
  y: SnapPoint | null;
}

interface StepOverlayPositionEditorProps {
  /** Current X position */
  positionX: number;
  /** Current Y position */
  positionY: number;
  /** Callback when position changes */
  onPositionChange: (x: number, y: number) => void;
  /** Assumed screen width for scaling */
  screenWidth?: number;
  /** Assumed screen height for scaling */
  screenHeight?: number;
  /** Overlay width */
  overlayWidth?: number;
  /** Overlay height */
  overlayHeight?: number;
}

const StepOverlayPositionEditor: React.FC<StepOverlayPositionEditorProps> = ({
  positionX,
  positionY,
  onPositionChange,
  screenWidth = 1920,
  screenHeight = 1080,
  overlayWidth = 350,
  overlayHeight = 120,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragOffset, setDragOffset] = useState({ x: 0, y: 0 });
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [activeSnap, setActiveSnap] = useState<ActiveSnap>({ x: null, y: null });

  // UI detection state
  const [detectedBounds, setDetectedBounds] = useState<UIBoundsResult | null>(null);
  const [isDetecting, setIsDetecting] = useState(false);
  const [detectionError, setDetectionError] = useState<string | null>(null);
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);

  // Preview canvas dimensions (scaled down)
  const previewWidth = 400;
  const previewHeight = (screenHeight / screenWidth) * previewWidth;

  // Scale factors
  const scaleX = previewWidth / screenWidth;
  const scaleY = previewHeight / screenHeight;

  // Scaled overlay dimensions
  const scaledOverlayWidth = overlayWidth * scaleX;
  const scaledOverlayHeight = overlayHeight * scaleY;

  // Convert ImageData to data URL for display
  const imageDataToUrl = useCallback((imageData: ImageData): string => {
    const canvas = document.createElement("canvas");
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.putImageData(imageData, 0, 0);
    }
    return canvas.toDataURL("image/png");
  }, []);

  // Capture screenshot handler
  const handleDetectUI = useCallback(async () => {
    setIsDetecting(true);
    setDetectionError(null);

    try {
      // Initialize detector if needed
      if (!isUIBoundsDetectorInitialized()) {
        const initialized = await initUIBoundsDetector();
        if (!initialized) {
          throw new Error("Failed to initialize. Is the game running?");
        }
      }

      // Capture screenshot
      const result = await detectUIBounds();
      if (result?.screenshot) {
        setDetectedBounds(result);
        // Convert screenshot to data URL for display
        const url = imageDataToUrl(result.screenshot.imageData);
        setScreenshotUrl(url);
        console.log(`[PositionEditor] Captured screenshot: ${result.screenWidth}x${result.screenHeight}`);
      } else {
        setDetectionError("Failed to capture screen. Is the game running?");
      }
    } catch (e: any) {
      console.error("[PositionEditor] Capture failed:", e);
      setDetectionError(e.message || "Capture failed");
    } finally {
      setIsDetecting(false);
    }
  }, [imageDataToUrl]);

  // Color mapping for UI elements
  const uiColorMap: Record<string, string> = {
    "Minimap": "rgba(100, 150, 100, 0.4)",
    "Chat": "rgba(100, 100, 150, 0.4)",
    "Action Bar": "rgba(150, 100, 100, 0.4)",
    "Inventory": "rgba(150, 150, 100, 0.4)",
    "Ribbon": "rgba(100, 100, 100, 0.4)",
  };

  // Default fallback positions (approximate percentages for default RS3 interface)
  const defaultUIElements: UIElement[] = useMemo(() => [
    { name: "Minimap", x: 0.85, y: 0.78, width: 0.15, height: 0.22, color: uiColorMap["Minimap"] },
    { name: "Chat", x: 0, y: 0, width: 0.30, height: 0.20, color: uiColorMap["Chat"] },
    { name: "Action Bar", x: 0.20, y: 0, width: 0.60, height: 0.08, color: uiColorMap["Action Bar"] },
    { name: "Inventory", x: 0.80, y: 0.25, width: 0.20, height: 0.35, color: uiColorMap["Inventory"] },
    { name: "Ribbon", x: 0.25, y: 0.96, width: 0.50, height: 0.04, color: uiColorMap["Ribbon"] },
  ], []);

  // Convert detected bounds to UIElement format, or use fallback
  // Note: GL coordinates have Y=0 at bottom, but our preview has Y=0 at top
  const rsUIElements = useMemo((): UIElement[] => {
    if (!detectedBounds || detectedBounds.components.length === 0) {
      return defaultUIElements;
    }

    const { components, screenWidth: detectedWidth, screenHeight: detectedHeight } = detectedBounds;

    return components.map(comp => {
      // Convert from GL UI coordinates (Y=0 at bottom) to screen coordinates (Y=0 at top)
      // Also convert to percentage-based positions
      const xPct = comp.x / detectedWidth;
      const widthPct = comp.width / detectedWidth;
      // Flip Y: in GL coords, high Y = top. In screen coords, low Y = top
      const yPct = 1 - (comp.y + comp.height) / detectedHeight;
      const heightPct = comp.height / detectedHeight;

      return {
        name: comp.name + (comp.confidence < 0.5 ? " (?)" : ""),
        x: xPct,
        y: yPct,
        width: widthPct,
        height: heightPct,
        color: uiColorMap[comp.name] || "rgba(128, 128, 128, 0.4)",
      };
    });
  }, [detectedBounds, defaultUIElements]);

  // Generate snap points based on screen dimensions and overlay size
  const snapPoints = useMemo((): SnapPoint[] => {
    const points: SnapPoint[] = [];

    // Edge snap points (X axis - left/right edges)
    points.push({ position: 10, type: "edge", axis: "x", label: "Left Edge" });
    points.push({ position: screenWidth - overlayWidth - 10, type: "edge", axis: "x", label: "Right Edge" });

    // Edge snap points (Y axis - top/bottom edges)
    points.push({ position: 10, type: "edge", axis: "y", label: "Top Edge" });
    points.push({ position: screenHeight - overlayHeight - 10, type: "edge", axis: "y", label: "Bottom Edge" });

    // Center snap points
    points.push({ position: (screenWidth - overlayWidth) / 2, type: "center", axis: "x", label: "H Center" });
    points.push({ position: (screenHeight - overlayHeight) / 2, type: "center", axis: "y", label: "V Center" });

    // Quarter snap points (useful for avoiding minimap/chat/inventory areas)
    points.push({ position: screenWidth * 0.25 - overlayWidth / 2, type: "quarter", axis: "x", label: "25%" });
    points.push({ position: screenWidth * 0.75 - overlayWidth / 2, type: "quarter", axis: "x", label: "75%" });
    points.push({ position: screenHeight * 0.25 - overlayHeight / 2, type: "quarter", axis: "y", label: "25%" });
    points.push({ position: screenHeight * 0.75 - overlayHeight / 2, type: "quarter", axis: "y", label: "75%" });

    // RS UI element snap points - snap to avoid overlapping UI elements
    for (const ui of rsUIElements) {
      const uiLeft = ui.x * screenWidth;
      const uiRight = (ui.x + ui.width) * screenWidth;
      const uiTop = ui.y * screenHeight;
      const uiBottom = (ui.y + ui.height) * screenHeight;

      // Snap to left edge of UI element (place overlay to the left of it)
      if (uiLeft > overlayWidth + 20) {
        points.push({ position: uiLeft - overlayWidth - 10, type: "ui", axis: "x", label: `L of ${ui.name}` });
      }
      // Snap to right edge of UI element (place overlay to the right of it)
      if (uiRight < screenWidth - overlayWidth - 20) {
        points.push({ position: uiRight + 10, type: "ui", axis: "x", label: `R of ${ui.name}` });
      }
      // Snap above UI element
      if (uiTop > overlayHeight + 20) {
        points.push({ position: uiTop - overlayHeight - 10, type: "ui", axis: "y", label: `Above ${ui.name}` });
      }
      // Snap below UI element
      if (uiBottom < screenHeight - overlayHeight - 20) {
        points.push({ position: uiBottom + 10, type: "ui", axis: "y", label: `Below ${ui.name}` });
      }
    }

    return points;
  }, [screenWidth, screenHeight, overlayWidth, overlayHeight, rsUIElements]);

  // Find nearest snap point within threshold
  // Threshold is defined in preview pixels, so we convert to screen pixels for comparison
  const findSnap = useCallback(
    (value: number, axis: "x" | "y"): SnapPoint | null => {
      if (!snapEnabled) return null;

      // Convert preview pixel threshold to screen pixels
      // Use the appropriate scale factor for the axis
      const scale = axis === "x" ? scaleX : scaleY;
      const screenThreshold = SNAP_THRESHOLD_PREVIEW / scale;

      const axisPoints = snapPoints.filter((p) => p.axis === axis);
      let nearestSnap: SnapPoint | null = null;
      let nearestDistance = screenThreshold;

      for (const point of axisPoints) {
        const distance = Math.abs(value - point.position);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestSnap = point;
        }
      }

      return nearestSnap;
    },
    [snapEnabled, snapPoints, scaleX, scaleY]
  );

  // Scaled position - clamp to ensure the preview box stays visible within canvas
  const maxPosX = screenWidth - overlayWidth;
  const maxPosY = screenHeight - overlayHeight;
  const clampedPosX = Math.max(0, Math.min(positionX, maxPosX));
  const clampedPosY = Math.max(0, Math.min(positionY, maxPosY));
  const scaledX = clampedPosX * scaleX;
  const scaledY = clampedPosY * scaleY;

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      // Use currentTarget (the element with the handler) instead of target
      // This ensures we always get the overlay box, not a child element like Text
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      setDragOffset({
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      });
      setIsDragging(true);
    },
    []
  );

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isDragging || !containerRef.current) return;

      const containerRect = containerRef.current.getBoundingClientRect();

      // Calculate new position in preview coordinates
      let newScaledX = e.clientX - containerRect.left - dragOffset.x;
      let newScaledY = e.clientY - containerRect.top - dragOffset.y;

      // Clamp to preview bounds
      newScaledX = Math.max(0, Math.min(newScaledX, previewWidth - scaledOverlayWidth));
      newScaledY = Math.max(0, Math.min(newScaledY, previewHeight - scaledOverlayHeight));

      // Convert back to screen coordinates
      let newX = Math.round(newScaledX / scaleX);
      let newY = Math.round(newScaledY / scaleY);

      // Apply snap detection
      const snapX = findSnap(newX, "x");
      const snapY = findSnap(newY, "y");

      if (snapX) {
        newX = snapX.position;
      }
      if (snapY) {
        newY = snapY.position;
      }

      // Update active snap state for visual feedback
      setActiveSnap({ x: snapX, y: snapY });

      onPositionChange(newX, newY);
    },
    [isDragging, dragOffset, previewWidth, previewHeight, scaledOverlayWidth, scaledOverlayHeight, scaleX, scaleY, onPositionChange, findSnap]
  );

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
    setActiveSnap({ x: null, y: null });
  }, []);

  // Add/remove global mouse listeners for dragging
  useEffect(() => {
    if (isDragging) {
      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
    }
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, handleMouseMove, handleMouseUp]);

  // Auto-capture screenshot on mount when GL injection is available
  useEffect(() => {
    if (isGlInjectionAvailable() && !screenshotUrl && !isDetecting) {
      // Small delay to ensure component is fully mounted
      const timer = setTimeout(() => {
        handleDetectUI();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, []); // Only run once on mount

  // Auto-correct position if it's out of bounds
  useEffect(() => {
    const maxX = screenWidth - overlayWidth;
    const maxY = screenHeight - overlayHeight;
    const correctedX = Math.max(0, Math.min(positionX, maxX));
    const correctedY = Math.max(0, Math.min(positionY, maxY));

    if (correctedX !== positionX || correctedY !== positionY) {
      console.log(`[PositionEditor] Auto-correcting position from (${positionX}, ${positionY}) to (${correctedX}, ${correctedY})`);
      onPositionChange(correctedX, correctedY);
    }
  }, [screenWidth, screenHeight, overlayWidth, overlayHeight, positionX, positionY, onPositionChange]);

  // Preset positions
  const presets = [
    { label: "Top Left", x: 10, y: 10 },
    { label: "Top Right", x: screenWidth - overlayWidth - 10, y: 10 },
    { label: "Bottom Left", x: 10, y: screenHeight - overlayHeight - 10 },
    { label: "Bottom Right", x: screenWidth - overlayWidth - 10, y: screenHeight - overlayHeight - 10 },
    { label: "Center", x: (screenWidth - overlayWidth) / 2, y: (screenHeight - overlayHeight) / 2 },
  ];

  // Helper to get snap line color based on type
  const getSnapLineColor = (type: SnapType): string => {
    switch (type) {
      case "edge":
        return "rgba(100, 200, 255, 0.8)";
      case "center":
        return "rgba(255, 200, 100, 0.8)";
      case "quarter":
        return "rgba(150, 255, 150, 0.6)";
      case "ui":
        return "rgba(255, 100, 150, 0.8)";
    }
  };

  return (
    <Stack gap="xs">
      {/* Controls row */}
      <Group gap="xs">
        {isGlInjectionAvailable() && (
          <Button
            variant="light"
            size="xs"
            onClick={handleDetectUI}
            disabled={isDetecting}
            leftSection={isDetecting ? <Loader size={12} /> : null}
          >
            {isDetecting ? "Capturing..." : "Refresh"}
          </Button>
        )}
        <Switch
          label="Snap"
          checked={snapEnabled}
          onChange={(e) => setSnapEnabled(e.currentTarget.checked)}
          size="xs"
        />
        <Text size="xs" c="dimmed" style={{ marginLeft: "auto" }}>
          {screenWidth}x{screenHeight}
          {screenshotUrl && <Text component="span" c="green" ml={4}>✓</Text>}
        </Text>
      </Group>
      {detectionError && (
        <Text size="xs" c="red">{detectionError}</Text>
      )}

      {/* Preview Canvas */}
      <Paper
        ref={containerRef}
        style={{
          width: previewWidth,
          height: previewHeight,
          position: "relative",
          backgroundColor: "#1a1a2e",
          border: "2px solid #444",
          borderRadius: 4,
          overflow: "hidden",
          cursor: isDragging ? "grabbing" : "default",
          userSelect: "none",
        }}
      >
        {/* Game screen background - screenshot or placeholder */}
        {screenshotUrl ? (
          <img
            src={screenshotUrl}
            alt="RS3 Screenshot"
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "cover",
              pointerEvents: "none",
            }}
          />
        ) : (
          <>
            {/* Placeholder gradient when no screenshot */}
            <Box
              style={{
                position: "absolute",
                inset: 0,
                background: "linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)",
                opacity: 0.8,
              }}
            />
            {/* Show UI element estimates only when no screenshot */}
            {rsUIElements.map((ui) => (
              <Box
                key={ui.name}
                style={{
                  position: "absolute",
                  left: ui.x * previewWidth,
                  top: ui.y * previewHeight,
                  width: ui.width * previewWidth,
                  height: ui.height * previewHeight,
                  backgroundColor: ui.color,
                  border: "1px dashed rgba(255,255,255,0.2)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  pointerEvents: "none",
                }}
              >
                <Text size="xs" c="rgba(255,255,255,0.5)" style={{ fontSize: 7, textAlign: "center" }}>
                  {ui.name}
                </Text>
              </Box>
            ))}
          </>
        )}

        {/* Grid lines for reference */}
        <svg
          style={{ position: "absolute", inset: 0, pointerEvents: "none" }}
          width={previewWidth}
          height={previewHeight}
        >
          {/* Vertical lines */}
          {[0.25, 0.5, 0.75].map((pct) => (
            <line
              key={`v-${pct}`}
              x1={previewWidth * pct}
              y1={0}
              x2={previewWidth * pct}
              y2={previewHeight}
              stroke="rgba(255,255,255,0.1)"
              strokeDasharray="4,4"
            />
          ))}
          {/* Horizontal lines */}
          {[0.25, 0.5, 0.75].map((pct) => (
            <line
              key={`h-${pct}`}
              x1={0}
              y1={previewHeight * pct}
              x2={previewWidth}
              y2={previewHeight * pct}
              stroke="rgba(255,255,255,0.1)"
              strokeDasharray="4,4"
            />
          ))}

          {/* Active snap lines */}
          {activeSnap.x && (
            <line
              x1={(activeSnap.x.position + overlayWidth / 2) * scaleX}
              y1={0}
              x2={(activeSnap.x.position + overlayWidth / 2) * scaleX}
              y2={previewHeight}
              stroke={getSnapLineColor(activeSnap.x.type)}
              strokeWidth={2}
            />
          )}
          {activeSnap.y && (
            <line
              x1={0}
              y1={(activeSnap.y.position + overlayHeight / 2) * scaleY}
              x2={previewWidth}
              y2={(activeSnap.y.position + overlayHeight / 2) * scaleY}
              stroke={getSnapLineColor(activeSnap.y.type)}
              strokeWidth={2}
            />
          )}
        </svg>

        {/* Draggable Overlay Preview */}
        <Box
          onMouseDown={handleMouseDown}
          style={{
            position: "absolute",
            left: scaledX,
            top: scaledY,
            width: scaledOverlayWidth,
            height: scaledOverlayHeight,
            backgroundColor: "rgba(20, 20, 30, 0.9)",
            border: "2px solid rgba(100, 150, 200, 0.8)",
            borderRadius: 4,
            cursor: isDragging ? "grabbing" : "grab",
            display: "flex",
            flexDirection: "column",
            padding: 4,
            boxShadow: isDragging
              ? "0 0 20px rgba(100, 150, 200, 0.5)"
              : "0 2px 8px rgba(0,0,0,0.3)",
            transition: isDragging ? "none" : "box-shadow 0.2s",
          }}
        >
          <Text size="xs" c="#88ccff" fw={700} style={{ fontSize: 8 }}>
            Step 1/10
          </Text>
          <Text size="xs" c="#fff" style={{ fontSize: 7, marginTop: 2 }}>
            Quest step preview...
          </Text>
        </Box>

        {/* Position indicator */}
        <Text
          size="xs"
          c="dimmed"
          style={{
            position: "absolute",
            bottom: 4,
            right: 8,
            fontSize: 10,
            backgroundColor: "rgba(0,0,0,0.5)",
            padding: "2px 6px",
            borderRadius: 3,
          }}
        >
          {Math.round(positionX)}, {Math.round(positionY)}
        </Text>

        {/* Snap indicator */}
        {(activeSnap.x || activeSnap.y) && (
          <Text
            size="xs"
            style={{
              position: "absolute",
              top: 4,
              left: 8,
              fontSize: 10,
              backgroundColor: "rgba(100, 200, 255, 0.8)",
              color: "#000",
              padding: "2px 6px",
              borderRadius: 3,
              fontWeight: 600,
            }}
          >
            Snap: {[activeSnap.x?.label, activeSnap.y?.label].filter(Boolean).join(" + ")}
          </Text>
        )}
      </Paper>

      {/* Preset Buttons */}
      <Group gap="xs">
        {presets.map((preset) => (
          <Button
            key={preset.label}
            variant="outline"
            size="xs"
            onClick={() => onPositionChange(Math.round(preset.x), Math.round(preset.y))}
          >
            {preset.label}
          </Button>
        ))}
      </Group>
    </Stack>
  );
};

export default StepOverlayPositionEditor;
