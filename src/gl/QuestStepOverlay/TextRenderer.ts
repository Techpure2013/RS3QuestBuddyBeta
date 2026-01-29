/**
 * TextRenderer - Renders text to a Canvas2D for use as a GL texture
 *
 * Creates a canvas with wrapped text, semi-transparent background,
 * and returns ImageData for texture creation.
 */

export interface TextRenderConfig {
  /** Maximum width in pixels */
  maxWidth: number;
  /** Font size in pixels */
  fontSize: number;
  /** Padding around text */
  padding: number;
  /** Background color (RGBA) */
  backgroundColor: string;
  /** Text color */
  textColor: string;
  /** Font family */
  fontFamily: string;
  /** Border color */
  borderColor: string;
  /** Border width */
  borderWidth: number;
}

export interface TextRenderResult {
  /** The rendered ImageData for texture creation */
  imageData: ImageData;
  /** Actual width of the rendered content */
  width: number;
  /** Actual height of the rendered content */
  height: number;
}

// RS3-style colors - cleaner rendering approach (from XP Reader ChartRenderer)
const DEFAULT_CONFIG: TextRenderConfig = {
  maxWidth: 350,
  fontSize: 14,
  padding: 12,
  // Higher opacity for cleaner text rendering - matches ChartRenderer approach
  backgroundColor: "rgba(40, 45, 55, 0.95)",
  textColor: "#ffffff",
  fontFamily: "'Segoe UI', Arial, sans-serif",
  // Accent border drawn ON TOP for cleaner look
  borderColor: "#88ccff",
  borderWidth: 2,
};

/** A text segment with optional color */
interface TextSegment {
  text: string;
  color?: string; // If undefined, use default color
}

/** A line of text segments for rendering */
type TextLine = TextSegment[];

/**
 * Strip formatting markers that Canvas2D can't render, preserving color codes
 * Removes: bold, italic, underline, strikethrough, superscript, links, images
 * Keeps: color codes [#XXX]{text} and [r,g,b]{text}
 */
function stripNonColorFormatting(text: string): string {
  let result = text;
  let prev = "";

  // Keep stripping until no more changes (handles nested formatting)
  while (result !== prev) {
    prev = result;

    // Images: ![alt|size](url) -> alt, ![alt](url) -> alt, {{img:url}} -> ""
    result = result.replace(/!\[([^\]|]*)\|\d+\]\((https?:\/\/[^)]+)\)/g, "$1");
    result = result.replace(/!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g, "$1");
    result = result.replace(/\{\{img:(https?:\/\/[^|}]+)(?:\|\d+)?\}\}/g, "");

    // Links: [text](url) -> text
    result = result.replace(/\[([^\]]+)\]\((https:\/\/[^)]+)\)/g, "$1");

    // Bold italic: ***text*** -> text
    result = result.replace(/\*\*\*(.+?)\*\*\*/g, "$1");

    // Bold: **text** -> text
    result = result.replace(/\*\*(.+?)\*\*/g, "$1");

    // Italic: *text* -> text (but not **)
    result = result.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, "$1");

    // Underline: __text__ -> text
    result = result.replace(/__(.+?)__/g, "$1");

    // Strikethrough: ~~text~~ -> text
    result = result.replace(/~~(.+?)~~/g, "$1");

    // Superscript: ^(text) -> text, ^word -> word
    result = result.replace(/\^\(([^)]+)\)/g, "$1");
    result = result.replace(/\^(\S+)/g, "$1");
  }

  return result;
}

/**
 * Parse text for color codes in format [#XXXXXX]{text} or [r,g,b]{text}
 * First strips non-color formatting, then extracts colored segments
 */
function parseColorCodes(text: string): TextSegment[] {
  // First strip formatting that Canvas2D can't render
  const cleanText = stripNonColorFormatting(text);

  const segments: TextSegment[] = [];

  // Match both hex and RGB color formats
  const hexRegex = /\[(#[0-9A-Fa-f]{3,8})\]\{(.+?)\}(?!\})/g;
  const rgbRegex = /\[(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\]\{(.+?)\}(?!\})/g;

  // Collect all color code matches
  const allMatches: Array<{ index: number; length: number; text: string; color: string }> = [];
  let lastIndex = 0;

  // Find hex color matches
  let match: RegExpExecArray | null;
  while ((match = hexRegex.exec(cleanText)) !== null) {
    allMatches.push({
      index: match.index,
      length: match[0].length,
      text: match[2],
      color: match[1],
    });
  }

  // Find RGB color matches
  while ((match = rgbRegex.exec(cleanText)) !== null) {
    allMatches.push({
      index: match.index,
      length: match[0].length,
      text: match[4],
      color: `rgb(${match[1]}, ${match[2]}, ${match[3]})`,
    });
  }

  // Sort by index
  allMatches.sort((a, b) => a.index - b.index);

  // Build segments
  lastIndex = 0;
  for (const m of allMatches) {
    // Skip if this match overlaps with previous (shouldn't happen but safety check)
    if (m.index < lastIndex) continue;

    // Add text before the match
    if (m.index > lastIndex) {
      segments.push({ text: cleanText.slice(lastIndex, m.index) });
    }

    // Add the colored segment
    segments.push({ text: m.text, color: m.color });
    lastIndex = m.index + m.length;
  }

  // Add remaining text
  if (lastIndex < cleanText.length) {
    segments.push({ text: cleanText.slice(lastIndex) });
  }

  // If no segments found, return the whole text as one segment
  if (segments.length === 0 && cleanText.length > 0) {
    segments.push({ text: cleanText });
  }

  return segments;
}

/**
 * Wrap text with color codes to fit within maxWidth
 * Returns lines where each line is an array of segments
 */
function wrapTextWithColors(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number
): TextLine[] {
  const segments = parseColorCodes(text);
  const lines: TextLine[] = [];
  let currentLine: TextSegment[] = [];
  let currentLineWidth = 0;

  for (const segment of segments) {
    // Split segment text into words
    const words = segment.text.split(/( )/); // Keep spaces as separate elements

    for (const word of words) {
      if (!word) continue;

      const wordWidth = ctx.measureText(word).width;

      // Check if word fits on current line
      if (currentLineWidth + wordWidth > maxWidth && currentLine.length > 0) {
        // Start new line
        lines.push(currentLine);
        currentLine = [];
        currentLineWidth = 0;

        // Skip leading space on new line
        if (word === " ") continue;
      }

      // Add word to current line
      // Try to merge with last segment if same color
      const lastSeg = currentLine[currentLine.length - 1];
      if (lastSeg && lastSeg.color === segment.color) {
        lastSeg.text += word;
      } else {
        currentLine.push({ text: word, color: segment.color });
      }
      currentLineWidth += wordWidth;
    }
  }

  // Add final line
  if (currentLine.length > 0) {
    lines.push(currentLine);
  }

  return lines;
}

/**
 * Render a line of segments at the given position
 */
function renderTextLine(
  ctx: CanvasRenderingContext2D,
  line: TextLine,
  x: number,
  y: number,
  defaultColor: string
): void {
  let currentX = x;
  for (const segment of line) {
    ctx.fillStyle = segment.color || defaultColor;
    ctx.fillText(segment.text, currentX, y);
    currentX += ctx.measureText(segment.text).width;
  }
}

/**
 * Render a quest step to a canvas and return ImageData
 */
export function renderQuestStep(
  stepNumber: number,
  totalSteps: number,
  stepDescription: string,
  dialogOptions?: string[],
  additionalInfo?: string[],
  completedDialogCount: number = 0,
  config: Partial<TextRenderConfig> = {},
  requiredItems?: string[],
  recommendedItems?: string[]
): TextRenderResult {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const dpr = window.devicePixelRatio || 1;

  // Create canvas for measurement
  const measureCanvas = document.createElement("canvas");
  const measureCtx = measureCanvas.getContext("2d")!;
  measureCtx.font = `bold ${cfg.fontSize}px ${cfg.fontFamily}`;

  // Calculate content - ensure step number is valid (1-based display)
  const displayStepNum = Math.max(0, stepNumber) + 1;
  const headerText = `Step ${displayStepNum}/${totalSteps}`;
  const contentMaxWidth = cfg.maxWidth - cfg.padding * 2;

  // Wrap description text with color code support
  measureCtx.font = `${cfg.fontSize}px ${cfg.fontFamily}`;
  const descriptionLines = wrapTextWithColors(measureCtx, stepDescription, contentMaxWidth);

  // Calculate additional info lines if present
  let additionalLines: TextLine[] = [];
  const filteredInfo = additionalInfo?.filter(info => info.trim() !== "") || [];
  if (filteredInfo.length > 0) {
    measureCtx.font = `${cfg.fontSize - 1}px ${cfg.fontFamily}`;
    for (const info of filteredInfo) {
      const infoLines = wrapTextWithColors(measureCtx, `• ${info}`, contentMaxWidth);
      additionalLines.push(...infoLines);
    }
  }

  // Calculate dialog options if present
  // Track which dialogs are completed for rendering
  interface DialogLine {
    text: string;
    isCompleted: boolean;
    isHeader: boolean;
  }
  let dialogLines: DialogLine[] = [];
  if (dialogOptions && dialogOptions.length > 0) {
    measureCtx.font = `italic ${cfg.fontSize - 2}px ${cfg.fontFamily}`;
    dialogLines.push({ text: "— Dialog Options —", isCompleted: false, isHeader: true });
    for (let i = 0; i < dialogOptions.length; i++) {
      const isCompleted = i < completedDialogCount;
      const prefix = isCompleted ? "  ✓ " : "  ";
      dialogLines.push({ text: `${prefix}${dialogOptions[i]}`, isCompleted, isHeader: false });
    }
  }

  // Calculate required items lines if present
  let requiredItemLines: TextLine[] = [];
  const filteredRequired = requiredItems?.filter(item => item.trim() !== "") || [];
  if (filteredRequired.length > 0) {
    measureCtx.font = `${cfg.fontSize - 1}px ${cfg.fontFamily}`;
    for (const item of filteredRequired) {
      const itemLines = wrapTextWithColors(measureCtx, `• ${item}`, contentMaxWidth);
      requiredItemLines.push(...itemLines);
    }
  }

  // Calculate recommended items lines if present
  let recommendedItemLines: TextLine[] = [];
  const filteredRecommended = recommendedItems?.filter(item => item.trim() !== "") || [];
  if (filteredRecommended.length > 0) {
    measureCtx.font = `${cfg.fontSize - 1}px ${cfg.fontFamily}`;
    for (const item of filteredRecommended) {
      const itemLines = wrapTextWithColors(measureCtx, `• ${item}`, contentMaxWidth);
      recommendedItemLines.push(...itemLines);
    }
  }

  // Calculate dimensions
  const lineHeight = cfg.fontSize * 1.4;
  const headerHeight = cfg.fontSize * 1.6;
  const additionalSectionHeight = additionalLines.length > 0
    ? lineHeight * 0.8 + additionalLines.length * lineHeight  // gap + lines
    : 0;
  // Required items section: header line + item lines + gap
  const requiredSectionHeight = requiredItemLines.length > 0
    ? lineHeight * 1.3 + requiredItemLines.length * lineHeight  // header + gap + lines
    : 0;
  // Recommended items section: header line + item lines + gap
  const recommendedSectionHeight = recommendedItemLines.length > 0
    ? lineHeight * 1.3 + recommendedItemLines.length * lineHeight
    : 0;
  const dialogSectionHeight = dialogLines.length > 0
    ? lineHeight * 0.5 + dialogLines.length * lineHeight
    : 0;
  const totalContentHeight = headerHeight + descriptionLines.length * lineHeight +
    additionalSectionHeight + requiredSectionHeight + recommendedSectionHeight +
    dialogSectionHeight + cfg.padding;

  const logicalWidth = cfg.maxWidth;
  const logicalHeight = totalContentHeight + cfg.padding * 2;

  // Create final canvas at DPR resolution
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(logicalWidth * dpr);
  canvas.height = Math.round(logicalHeight * dpr);

  const ctx = canvas.getContext("2d", { alpha: true })!;
  ctx.scale(dpr, dpr);

  // Clear canvas to transparent (GL shader handles background/border via SDF)
  ctx.clearRect(0, 0, logicalWidth, logicalHeight);

  // Draw header
  ctx.fillStyle = "#88ccff";
  ctx.font = `bold ${cfg.fontSize}px ${cfg.fontFamily}`;
  ctx.fillText(headerText, cfg.padding, cfg.padding + cfg.fontSize);

  // Draw separator line (subtle, doesn't compete with border)
  const sepY = cfg.padding + headerHeight;
  ctx.strokeStyle = "rgba(136, 204, 255, 0.3)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cfg.padding, sepY);
  ctx.lineTo(logicalWidth - cfg.padding, sepY);
  ctx.stroke();

  // Draw description with color support
  ctx.font = `${cfg.fontSize}px ${cfg.fontFamily}`;
  let y = sepY + lineHeight;
  for (const line of descriptionLines) {
    renderTextLine(ctx, line, cfg.padding, y, cfg.textColor);
    y += lineHeight;
  }

  // Draw additional info section
  if (additionalLines.length > 0) {
    y += lineHeight * 0.3; // Small gap

    // Draw section separator (subtle gold/orange tint)
    ctx.strokeStyle = "rgba(255, 204, 119, 0.25)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cfg.padding, y - lineHeight * 0.2);
    ctx.lineTo(logicalWidth - cfg.padding, y - lineHeight * 0.2);
    ctx.stroke();

    y += lineHeight * 0.5;

    ctx.font = `${cfg.fontSize - 1}px ${cfg.fontFamily}`;
    for (const line of additionalLines) {
      renderTextLine(ctx, line, cfg.padding, y, "#ffcc77"); // Orange/gold color for additional info
      y += lineHeight;
    }
  }

  // Draw required items section
  if (requiredItemLines.length > 0) {
    y += lineHeight * 0.3; // Small gap

    // Draw section separator (subtle red tint for required)
    ctx.strokeStyle = "rgba(255, 120, 120, 0.3)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cfg.padding, y - lineHeight * 0.2);
    ctx.lineTo(logicalWidth - cfg.padding, y - lineHeight * 0.2);
    ctx.stroke();

    y += lineHeight * 0.5;

    // Draw section header
    ctx.fillStyle = "#ff9999";
    ctx.font = `bold ${cfg.fontSize - 1}px ${cfg.fontFamily}`;
    ctx.fillText("— Required Items —", cfg.padding, y);
    y += lineHeight;

    // Draw items
    ctx.font = `${cfg.fontSize - 1}px ${cfg.fontFamily}`;
    for (const line of requiredItemLines) {
      renderTextLine(ctx, line, cfg.padding, y, "#ffaaaa"); // Light red for required items
      y += lineHeight;
    }
  }

  // Draw recommended items section
  if (recommendedItemLines.length > 0) {
    y += lineHeight * 0.3; // Small gap

    // Draw section separator (subtle green tint for recommended)
    ctx.strokeStyle = "rgba(120, 200, 120, 0.3)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cfg.padding, y - lineHeight * 0.2);
    ctx.lineTo(logicalWidth - cfg.padding, y - lineHeight * 0.2);
    ctx.stroke();

    y += lineHeight * 0.5;

    // Draw section header
    ctx.fillStyle = "#99dd99";
    ctx.font = `bold ${cfg.fontSize - 1}px ${cfg.fontFamily}`;
    ctx.fillText("— Recommended Items —", cfg.padding, y);
    y += lineHeight;

    // Draw items
    ctx.font = `${cfg.fontSize - 1}px ${cfg.fontFamily}`;
    for (const line of recommendedItemLines) {
      renderTextLine(ctx, line, cfg.padding, y, "#aaddaa"); // Light green for recommended items
      y += lineHeight;
    }
  }

  // Draw dialog options
  if (dialogLines.length > 0) {
    ctx.font = `italic ${cfg.fontSize - 2}px ${cfg.fontFamily}`;
    y += lineHeight * 0.5; // Small gap before dialog section
    for (const line of dialogLines) {
      if (line.isHeader) {
        // Header line - light blue
        ctx.fillStyle = "#aaddff";
      } else if (line.isCompleted) {
        // Completed dialog - green
        ctx.fillStyle = "#66dd88";
      } else {
        // Pending dialog - light blue
        ctx.fillStyle = "#aaddff";
      }
      ctx.fillText(line.text, cfg.padding, y);
      y += lineHeight;
    }
  }

  // NOTE: Background and border are rendered by GL shader via SDF - not Canvas2D
  // This gives crisp, resolution-independent edges (ChartRenderer pattern)

  // Get image data
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

  return {
    imageData,
    width: logicalWidth,
    height: logicalHeight,
  };
}

/**
 * Render a simple message (for when no quest is active, etc.)
 * NOTE: Background/border rendered by GL shader via SDF
 */
export function renderSimpleMessage(
  message: string,
  config: Partial<TextRenderConfig> = {}
): TextRenderResult {
  const cfg = { ...DEFAULT_CONFIG, ...config, maxWidth: 200 };
  const dpr = window.devicePixelRatio || 1;

  const logicalWidth = cfg.maxWidth;
  const logicalHeight = cfg.fontSize * 2 + cfg.padding * 2;

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(logicalWidth * dpr);
  canvas.height = Math.round(logicalHeight * dpr);

  const ctx = canvas.getContext("2d", { alpha: true })!;
  ctx.scale(dpr, dpr);

  // Clear canvas to transparent (GL shader handles background/border)
  ctx.clearRect(0, 0, logicalWidth, logicalHeight);

  // Text only
  ctx.fillStyle = cfg.textColor;
  ctx.font = `${cfg.fontSize}px ${cfg.fontFamily}`;
  ctx.textAlign = "center";
  ctx.fillText(message, logicalWidth / 2, logicalHeight / 2 + cfg.fontSize / 3);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

  return {
    imageData,
    width: logicalWidth,
    height: logicalHeight,
  };
}
