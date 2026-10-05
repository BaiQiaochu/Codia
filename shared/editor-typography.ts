const DEFAULT_MARKDOWN_TYPOGRAPHY = Object.freeze({
  fontPreset: "follow",
  bodyFontSize: 15,
  heading1FontSize: 24,
  heading2FontSize: 20,
  heading3FontSize: 18,
  heading4FontSize: 16,
  heading5FontSize: 15,
  heading6FontSize: 14,
  lineHeight: 1.72,
  contentPadding: 24,
  contentWidth: 720,
});

export const DEFAULT_EDITOR_TYPOGRAPHY = Object.freeze({
  markdown: DEFAULT_MARKDOWN_TYPOGRAPHY,
});

const LIMITS = Object.freeze({
  bodyFontSize: [12, 24],
  heading1FontSize: [16, 40],
  heading2FontSize: [15, 34],
  heading3FontSize: [14, 30],
  heading4FontSize: [13, 28],
  heading5FontSize: [12, 26],
  heading6FontSize: [12, 24],
  lineHeight: [1.2, 2.2],
  contentPadding: [0, 64],
});

const FONT_PRESET_VALUES = new Set(["follow", "serif", "sans"]);
const CONTENT_WIDTH_PRESETS = new Set([640, 720, 800]);
const UNLIMITED_CONTENT_WIDTH = "unlimited";

type FontSelectionId = "follow" | "serif" | "sans";
type EditorMarkdownContentWidth = 640 | 720 | 800 | "unlimited";

type MarkdownTypography = {
  fontPreset: FontSelectionId;
  bodyFontSize: number;
  heading1FontSize: number;
  heading2FontSize: number;
  heading3FontSize: number;
  heading4FontSize: number;
  heading5FontSize: number;
  heading6FontSize: number;
  lineHeight: number;
  contentPadding: number;
  contentWidth: EditorMarkdownContentWidth;
};

type EditorTypography = {
  markdown: MarkdownTypography;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) return Number(value);
  return NaN;
}

function clampNumber(value: unknown, fallback: number, [min, max]: readonly number[], decimals = 0): number {
  const parsed = readNumber(value);
  if (!Number.isFinite(parsed)) return fallback;
  const clamped = Math.min(max, Math.max(min, parsed));
  if (decimals > 0) return Number(clamped.toFixed(decimals));
  return Math.round(clamped);
}

function normalizeFontPreset(value: unknown, fallback: FontSelectionId): FontSelectionId {
  return typeof value === "string" && FONT_PRESET_VALUES.has(value) ? value as FontSelectionId : fallback;
}

function normalizeContentWidth(value: unknown, fallback: EditorMarkdownContentWidth): EditorMarkdownContentWidth {
  if (value === UNLIMITED_CONTENT_WIDTH) return UNLIMITED_CONTENT_WIDTH;
  const parsed = readNumber(value);
  return CONTENT_WIDTH_PRESETS.has(parsed) ? parsed as EditorMarkdownContentWidth : fallback;
}

export function normalizeEditorTypography(value: unknown): EditorTypography {
  const source = isRecord(value) ? value : {};
  const markdown = isRecord(source.markdown) ? source.markdown : {};
  const defaults = DEFAULT_EDITOR_TYPOGRAPHY.markdown;

  return {
    markdown: {
      fontPreset: normalizeFontPreset(markdown.fontPreset, defaults.fontPreset),
      bodyFontSize: clampNumber(markdown.bodyFontSize, defaults.bodyFontSize, LIMITS.bodyFontSize),
      heading1FontSize: clampNumber(markdown.heading1FontSize, defaults.heading1FontSize, LIMITS.heading1FontSize),
      heading2FontSize: clampNumber(markdown.heading2FontSize, defaults.heading2FontSize, LIMITS.heading2FontSize),
      heading3FontSize: clampNumber(markdown.heading3FontSize, defaults.heading3FontSize, LIMITS.heading3FontSize),
      heading4FontSize: clampNumber(markdown.heading4FontSize, defaults.heading4FontSize, LIMITS.heading4FontSize),
      heading5FontSize: clampNumber(markdown.heading5FontSize, defaults.heading5FontSize, LIMITS.heading5FontSize),
      heading6FontSize: clampNumber(markdown.heading6FontSize, defaults.heading6FontSize, LIMITS.heading6FontSize),
      lineHeight: clampNumber(markdown.lineHeight, defaults.lineHeight, LIMITS.lineHeight, 2),
      contentPadding: clampNumber(markdown.contentPadding, defaults.contentPadding, LIMITS.contentPadding),
      contentWidth: normalizeContentWidth(markdown.contentWidth, defaults.contentWidth),
    },
  };
}

export function mergeEditorTypography(base: unknown, patch: unknown): EditorTypography {
  const current = normalizeEditorTypography(base);
  const source = isRecord(patch) ? patch : {};
  const markdownPatch = isRecord(source.markdown) ? source.markdown : {};

  return normalizeEditorTypography({
    ...current,
    ...source,
    markdown: {
      ...current.markdown,
      ...markdownPatch,
    },
  });
}
