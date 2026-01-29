/**
 * Custom ColorPicker component
 * Replaces Mantine's ColorPicker with a lightweight custom implementation
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import "./ColorPicker.css";

interface ColorPickerProps {
  /** Current color value in hex format */
  value?: string;
  /** Called continuously while user is picking a color */
  onChange?: (color: string) => void;
  /** Called when user finishes picking (mouseup) */
  onChangeEnd?: (color: string) => void;
  /** Array of saved color swatches to display */
  swatches?: string[];
  /** Color format - currently only hex supported */
  format?: "hex";
}

// HSV to RGB conversion
function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;

  let r = 0, g = 0, b = 0;

  if (h < 60) { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }

  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

// RGB to HSV conversion
function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;

  let h = 0;
  const s = max === 0 ? 0 : d / max;
  const v = max;

  if (d !== 0) {
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) * 60; break;
      case g: h = ((b - r) / d + 2) * 60; break;
      case b: h = ((r - g) / d + 4) * 60; break;
    }
  }

  return [h, s, v];
}

// Hex to RGB
function hexToRgb(hex: string): [number, number, number] | null {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? [parseInt(result[1], 16), parseInt(result[2], 16), parseInt(result[3], 16)]
    : null;
}

// RGB to Hex
function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map(x => x.toString(16).padStart(2, "0")).join("")}`;
}

export const ColorPicker: React.FC<ColorPickerProps> = ({
  value = "#ffffff",
  onChange,
  onChangeEnd,
  swatches = [],
}) => {
  // Parse initial color
  const initialRgb = hexToRgb(value) || [255, 255, 255];
  const initialHsv = rgbToHsv(...initialRgb);

  const [hue, setHue] = useState(initialHsv[0]);
  const [saturation, setSaturation] = useState(initialHsv[1]);
  const [brightness, setBrightness] = useState(initialHsv[2]);

  const svPickerRef = useRef<HTMLDivElement>(null);
  const hueSliderRef = useRef<HTMLDivElement>(null);
  const isDraggingSV = useRef(false);
  const isDraggingHue = useRef(false);

  // Sync with external value changes
  useEffect(() => {
    const rgb = hexToRgb(value);
    if (rgb) {
      const [h, s, v] = rgbToHsv(...rgb);
      // Only update if significantly different to avoid loops
      if (Math.abs(h - hue) > 1 || Math.abs(s - saturation) > 0.01 || Math.abs(v - brightness) > 0.01) {
        setHue(h);
        setSaturation(s);
        setBrightness(v);
      }
    }
  }, [value]);

  // Get current color as hex
  const getCurrentHex = useCallback(() => {
    const [r, g, b] = hsvToRgb(hue, saturation, brightness);
    return rgbToHex(r, g, b);
  }, [hue, saturation, brightness]);

  // Emit color change
  const emitChange = useCallback(() => {
    const hex = getCurrentHex();
    onChange?.(hex);
  }, [getCurrentHex, onChange]);

  const emitChangeEnd = useCallback(() => {
    const hex = getCurrentHex();
    onChangeEnd?.(hex);
  }, [getCurrentHex, onChangeEnd]);

  // Handle SV picker interaction
  const handleSVPick = useCallback((e: React.MouseEvent | MouseEvent) => {
    if (!svPickerRef.current) return;
    const rect = svPickerRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    setSaturation(x);
    setBrightness(1 - y);
  }, []);

  // Handle hue slider interaction
  const handleHuePick = useCallback((e: React.MouseEvent | MouseEvent) => {
    if (!hueSliderRef.current) return;
    const rect = hueSliderRef.current.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    setHue(x * 360);
  }, []);

  // Mouse event handlers for SV picker
  const handleSVMouseDown = (e: React.MouseEvent) => {
    isDraggingSV.current = true;
    handleSVPick(e);
  };

  // Mouse event handlers for hue slider
  const handleHueMouseDown = (e: React.MouseEvent) => {
    isDraggingHue.current = true;
    handleHuePick(e);
  };

  // Global mouse move/up handlers
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isDraggingSV.current) {
        handleSVPick(e);
      }
      if (isDraggingHue.current) {
        handleHuePick(e);
      }
    };

    const handleMouseUp = () => {
      if (isDraggingSV.current || isDraggingHue.current) {
        isDraggingSV.current = false;
        isDraggingHue.current = false;
        emitChangeEnd();
      }
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [handleSVPick, handleHuePick, emitChangeEnd]);

  // Emit change when HSV values change
  useEffect(() => {
    emitChange();
  }, [hue, saturation, brightness]);

  // Calculate the pure hue color for the SV picker background
  const [hueR, hueG, hueB] = hsvToRgb(hue, 1, 1);
  const pureHueColor = `rgb(${hueR}, ${hueG}, ${hueB})`;

  // Calculate the current color for the preview
  const currentHex = getCurrentHex();

  return (
    <div className="color-picker">
      {/* Saturation/Brightness picker */}
      <div
        ref={svPickerRef}
        className="color-picker-sv"
        style={{ backgroundColor: pureHueColor }}
        onMouseDown={handleSVMouseDown}
      >
        <div className="color-picker-sv-white" />
        <div className="color-picker-sv-black" />
        <div
          className="color-picker-sv-cursor"
          style={{
            left: `${saturation * 100}%`,
            top: `${(1 - brightness) * 100}%`,
            borderColor: brightness > 0.5 ? "#000" : "#fff",
          }}
        />
      </div>

      {/* Hue slider */}
      <div
        ref={hueSliderRef}
        className="color-picker-hue"
        onMouseDown={handleHueMouseDown}
      >
        <div
          className="color-picker-hue-cursor"
          style={{ left: `${(hue / 360) * 100}%` }}
        />
      </div>

      {/* Preview and hex input */}
      <div className="color-picker-preview-row">
        <div
          className="color-picker-preview"
          style={{ backgroundColor: currentHex }}
        />
        <input
          type="text"
          className="color-picker-hex-input"
          value={currentHex}
          onChange={(e) => {
            const newHex = e.target.value;
            const rgb = hexToRgb(newHex);
            if (rgb) {
              const [h, s, v] = rgbToHsv(...rgb);
              setHue(h);
              setSaturation(s);
              setBrightness(v);
            }
          }}
          onBlur={emitChangeEnd}
        />
      </div>

      {/* Swatches */}
      {swatches.length > 0 && (
        <div className="color-picker-swatches">
          {swatches.map((swatch, index) => (
            <button
              key={`${swatch}-${index}`}
              className="color-picker-swatch"
              style={{ backgroundColor: swatch }}
              onClick={() => {
                const rgb = hexToRgb(swatch);
                if (rgb) {
                  const [h, s, v] = rgbToHsv(...rgb);
                  setHue(h);
                  setSaturation(s);
                  setBrightness(v);
                  onChange?.(swatch);
                  onChangeEnd?.(swatch);
                }
              }}
              title={swatch}
            />
          ))}
        </div>
      )}
    </div>
  );
};

export default ColorPicker;
