// Reader appearance settings, persisted in localStorage.

export interface ReaderSettings {
  fontSize: number; // px
  lineHeight: number; // multiplier
  font: string; // key into FONT_FAMILIES
  width: "narrow" | "medium" | "full";
  color: string; // key into TEXT_COLORS
  /** Chapters to silently download ahead of your reading position. 0 = off. */
  prefetch: number;
}

export const DEFAULT_READER_SETTINGS: ReaderSettings = {
  fontSize: 18,
  lineHeight: 1.7,
  font: "serif",
  width: "full",
  color: "default",
  prefetch: 0,
};

const KEY = "reader-settings";

export function loadReaderSettings(): ReaderSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_READER_SETTINGS;
    const parsed = { ...DEFAULT_READER_SETTINGS, ...JSON.parse(raw) };
    if (!FONT_FAMILIES[parsed.font]) parsed.font = DEFAULT_READER_SETTINGS.font;
    if (!TEXT_COLORS[parsed.color]) parsed.color = DEFAULT_READER_SETTINGS.color;
    return parsed;
  } catch {
    return DEFAULT_READER_SETTINGS;
  }
}

export function saveReaderSettings(s: ReaderSettings): void {
  localStorage.setItem(KEY, JSON.stringify(s));
}

export const FONT_FAMILIES: Record<string, { label: string; css: string }> = {
  serif: { label: "Georgia", css: "Georgia, 'Times New Roman', serif" },
  palatino: {
    label: "Palatino",
    css: "'Palatino Linotype', 'Book Antiqua', Palatino, serif",
  },
  garamond: { label: "Garamond", css: "Garamond, 'EB Garamond', serif" },
  times: { label: "Times New Roman", css: "'Times New Roman', Times, serif" },
  cambria: { label: "Cambria", css: "Cambria, 'Liberation Serif', serif" },
  sans: { label: "Segoe UI", css: "'Segoe UI', system-ui, sans-serif" },
  verdana: { label: "Verdana", css: "Verdana, Geneva, sans-serif" },
  tahoma: { label: "Tahoma", css: "Tahoma, Geneva, sans-serif" },
  mono: { label: "Monospace", css: "Consolas, 'Courier New', monospace" },
};

export const TEXT_COLORS: Record<string, { label: string; css: string }> = {
  default: { label: "Default", css: "#e4e4e7" },
  white: { label: "Bright white", css: "#ffffff" },
  sepia: { label: "Sepia", css: "#d8c8a8" },
  amber: { label: "Warm amber", css: "#ddb88a" },
  gray: { label: "Soft gray", css: "#a1a1aa" },
  sage: { label: "Sage green", css: "#b6c7ad" },
  blue: { label: "Cool blue", css: "#a8bfd4" },
  rose: { label: "Dusty rose", css: "#d4b0b8" },
};

export const TEXT_WIDTHS: Record<ReaderSettings["width"], string> = {
  narrow: "38rem",
  medium: "52rem",
  full: "100%",
};
