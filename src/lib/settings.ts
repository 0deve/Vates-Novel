// Reader appearance settings, persisted in localStorage.

export type ChapterInfoKey = "percent" | "words" | "read" | "listen";

export const CHAPTER_INFO_LABELS: Record<ChapterInfoKey, string> = {
  percent: "% read",
  words: "Word count",
  read: "Reading time",
  listen: "Listening time",
};

export interface ReaderSettings {
  fontSize: number; // px
  lineHeight: number; // multiplier
  font: string; // key into FONT_FAMILIES
  width: "narrow" | "medium" | "full";
  color: string; // key into TEXT_COLORS
  /** Chapters to silently download ahead of your reading position. 0 = off. */
  prefetch: number;
  bookmarksEnabled: boolean;
  findEnabled: boolean;
  progressEnabled: boolean;
  /** Where the chapter % sits: 0 = left/top edge, 1 = right/bottom edge. */
  progressX: number;
  progressY: number;
  /** Chapter info label items, in display order. */
  chapterInfo: { key: ChapterInfoKey; on: boolean }[];
  /** One item per line instead of one line joined with dots. */
  chapterInfoStacked: boolean;
  /** Times for the whole chapter, or only what's left after the current spot. */
  chapterTimeMode: "total" | "left";
  /** Show hidden paragraphs dimmed (to unhide them) instead of removing them. */
  showHidden: boolean;
  /** Silent reading speed for time estimates. */
  readingWpm: number;
}

export const DEFAULT_READER_SETTINGS: ReaderSettings = {
  fontSize: 18,
  lineHeight: 1.7,
  font: "serif",
  width: "full",
  color: "default",
  prefetch: 0,
  bookmarksEnabled: true,
  findEnabled: true,
  progressEnabled: true,
  progressX: 1,
  progressY: 1,
  chapterInfo: [
    { key: "percent", on: true },
    { key: "words", on: false },
    { key: "read", on: false },
    { key: "listen", on: false },
  ],
  chapterInfoStacked: true,
  chapterTimeMode: "total",
  showHidden: false,
  readingWpm: 238,
};

export const PROGRESS_POSITIONS = [
  { label: "Top left", x: 0, y: 0 },
  { label: "Top center", x: 0.5, y: 0 },
  { label: "Top right", x: 1, y: 0 },
  { label: "Bottom left", x: 0, y: 1 },
  { label: "Bottom center", x: 0.5, y: 1 },
  { label: "Bottom right", x: 1, y: 1 },
];

const KEY = "reader-settings";

export function loadReaderSettings(): ReaderSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_READER_SETTINGS;
    const parsed = { ...DEFAULT_READER_SETTINGS, ...JSON.parse(raw) };
    if (!FONT_FAMILIES[parsed.font]) parsed.font = DEFAULT_READER_SETTINGS.font;
    if (!TEXT_COLORS[parsed.color]) parsed.color = DEFAULT_READER_SETTINGS.color;
    // Keep every item exactly once, in the saved order.
    const saved = Array.isArray(parsed.chapterInfo) ? parsed.chapterInfo : [];
    const keys = DEFAULT_READER_SETTINGS.chapterInfo.map((i) => i.key);
    parsed.chapterInfo = [
      ...saved.filter((i: any, n: number) => keys.includes(i?.key) && saved.findIndex((j: any) => j?.key === i.key) === n),
      ...DEFAULT_READER_SETTINGS.chapterInfo.filter((d) => !saved.some((i: any) => i?.key === d.key)),
    ];
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

// How often (hours) the app auto-checks sources for new chapters on launch.
// 0 = off. Persisted separately from ReaderSettings since it's not about
// the reader.
const UPDATE_CHECK_KEY = "update-check-hours";

export function loadUpdateCheckHours(): number {
  const raw = localStorage.getItem(UPDATE_CHECK_KEY);
  if (raw === null) return 6;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : 6;
}

export function saveUpdateCheckHours(hours: number): void {
  localStorage.setItem(UPDATE_CHECK_KEY, String(hours));
}

/** How imported epub/pdf/txt files are cleaned up (see import_clean.rs). */
export interface ImportSettings {
  /** Remove repeated contents lists, running headers, page numbers, title echoes. */
  clean: boolean;
  /** Skip cover, copyright, praise, dedication and ad pages. */
  skipExtras: boolean;
}

const IMPORT_KEY = "import-settings";

export function loadImportSettings(): ImportSettings {
  try {
    return { clean: true, skipExtras: true, ...JSON.parse(localStorage.getItem(IMPORT_KEY) || "{}") };
  } catch {
    return { clean: true, skipExtras: true };
  }
}

export function saveImportSettings(s: ImportSettings): void {
  localStorage.setItem(IMPORT_KEY, JSON.stringify(s));
}
