// Shelf view: layout prefs (localStorage), themes, deterministic book sizing, cover colors.
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { fetchImage } from "./api";
import type { ShelfAsset } from "./db";
import type { LibraryNovel } from "../types";

export type BuiltinDecoration =
  | "plant"
  | "succulent"
  | "bookend"
  | "lamp"
  | "candle"
  | "frame"
  | "globe"
  | "hourglass"
  | "vase";

export interface Decoration {
  id: string;
  type: BuiltinDecoration | "custom";
  /** Image asset for custom decorations. */
  assetId?: string;
  /** Natural size at scale 1 (custom decorations). */
  w?: number;
  h?: number;
  /** Size multiplier. */
  size?: number;
  /** Placed anywhere over the bookcase instead of on a shelf (px at scale 1). */
  float?: { x: number; y: number };
}

export interface FreeItem {
  key: string;
  /** Left edge in px at scale 1. */
  x: number;
}

export interface FreeRow {
  id: string;
  items: FreeItem[];
}

export interface CustomTheme {
  id: string;
  name: string;
  wall?: string;
  wallMode: "cover" | "tile";
  plank?: string;
  side?: string;
  /** Fallback colors when an image is missing. */
  plankColor: string;
  sideColor: string;
  wallColor: string;
}

export interface ShelfPrefs {
  view: "grid" | "shelf";
  /** Built-in style key or "custom:<themeId>". */
  style: string;
  wall: WallStyle;
  scale: number;
  layout: "auto" | "free";
  /** Auto layout: item keys in order, "n:<novelId>" or "d:<decorationId>". */
  order: string[];
  /** Free layout: explicit shelves with positioned items. */
  rows: FreeRow[];
  decorations: Decoration[];
  themes: CustomTheme[];
}

export type WallStyle = "dark" | "light" | "brick" | "stripes" | "panel";

const KEY = "shelf-prefs";

const DEFAULT_PREFS: ShelfPrefs = {
  view: "grid",
  style: "oak",
  wall: "dark",
  scale: 1,
  layout: "auto",
  order: [],
  rows: [],
  decorations: [],
  themes: [],
};

export function loadShelfPrefs(): ShelfPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULT_PREFS, ...JSON.parse(raw) } : DEFAULT_PREFS;
  } catch {
    return DEFAULT_PREFS;
  }
}

export function saveShelfPrefs(p: ShelfPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    // storage full or blocked; the shelf still works for this session
  }
}

export const newId = () => Math.random().toString(36).slice(2, 10);

export interface Theme {
  plank: string;
  edge: string;
  wall: string;
  side: string;
}

export const SHELF_STYLES: Record<string, Theme & { label: string }> = {
  oak: {
    label: "Oak",
    plank: "linear-gradient(180deg,#d29a62 0%,#b07842 45%,#8a5a2e 100%)",
    edge: "#6e4522",
    wall: "#2e2119",
    side: "#7a4e28",
  },
  walnut: {
    label: "Walnut",
    plank: "linear-gradient(180deg,#7a5134 0%,#5b3a22 50%,#3f2716 100%)",
    edge: "#2b1a0e",
    wall: "#1c130d",
    side: "#3f2716",
  },
  white: {
    label: "White",
    plank: "linear-gradient(180deg,#fbfbf9 0%,#e7e6e1 55%,#cfcdc6 100%)",
    edge: "#b5b2aa",
    wall: "#d8d4cc",
    side: "#e2e0da",
  },
  metal: {
    label: "Black metal",
    plank: "linear-gradient(180deg,#4a4a50 0%,#2c2c31 50%,#1a1a1e 100%)",
    edge: "#0e0e10",
    wall: "#141417",
    side: "#232328",
  },
  glass: {
    label: "Glass",
    plank:
      "linear-gradient(180deg,rgba(220,240,255,.55) 0%,rgba(170,200,220,.25) 60%,rgba(120,150,170,.35) 100%)",
    edge: "rgba(200,230,255,.5)",
    wall: "#18181b",
    side: "rgba(200,230,255,.25)",
  },
};

export const WALL_STYLES: Record<WallStyle, { label: string; css: (base: string) => string }> = {
  dark: { label: "Match shelf", css: (b) => b },
  light: { label: "Light plaster", css: () => "#cfc9bf" },
  panel: {
    label: "Wood panels",
    css: (b) => `repeating-linear-gradient(90deg, rgba(0,0,0,.18) 0 2px, transparent 2px 90px), ${b}`,
  },
  stripes: {
    label: "Striped wallpaper",
    css: () => "repeating-linear-gradient(90deg,#2d3b36 0 18px,#33443e 18px 36px)",
  },
  brick: {
    label: "Brick",
    css: () =>
      `url("data:image/svg+xml,${encodeURIComponent(
        "<svg xmlns='http://www.w3.org/2000/svg' width='64' height='32'>" +
          "<rect width='64' height='32' fill='#3a1d15'/>" +
          "<rect x='1' y='1' width='62' height='14' fill='#7a3b2a'/>" +
          "<rect x='-31' y='17' width='62' height='14' fill='#713526'/>" +
          "<rect x='33' y='17' width='62' height='14' fill='#7f4130'/>" +
          "</svg>",
      )}")`,
  },
};

/** Resolve the active look; custom themes pull their images from the asset map. */
export function resolveTheme(prefs: ShelfPrefs, assets: Map<string, string>): Theme {
  if (prefs.style.startsWith("custom:")) {
    const t = prefs.themes.find((x) => `custom:${x.id}` === prefs.style);
    if (t) {
      const img = (id?: string) => (id ? assets.get(id) : undefined);
      const wall = img(t.wall);
      const plank = img(t.plank);
      const side = img(t.side);
      return {
        wall: wall
          ? t.wallMode === "tile"
            ? `url("${wall}") repeat`
            : `url("${wall}") center/cover no-repeat`
          : t.wallColor,
        plank: plank ? `url("${plank}") center/100% 100% no-repeat` : t.plankColor,
        side: side ? `url("${side}") center/cover` : t.sideColor,
        edge: "rgba(0,0,0,.35)",
      };
    }
  }
  const s = SHELF_STYLES[prefs.style] ?? SHELF_STYLES.oak;
  return { ...s, wall: WALL_STYLES[prefs.wall].css(s.wall) };
}

export const DECORATION_LABELS: Record<BuiltinDecoration, string> = {
  plant: "Plant",
  succulent: "Succulent",
  bookend: "Bookend",
  lamp: "Lamp",
  candle: "Candle",
  frame: "Photo frame",
  globe: "Globe",
  hourglass: "Hourglass",
  vase: "Vase",
};

/** Stable 32-bit hash, so a book keeps its height and style across renders. */
export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const SPINE_PALETTE = [
  "#7b2d26", "#2f4858", "#33658a", "#55443d", "#3d5a3b", "#86624a",
  "#5c3c66", "#1f3b4d", "#8c5b2b", "#4a4e69", "#6b2737", "#2e5e4e",
];

export const SWATCHES = [
  "#7b2d26", "#a23e2c", "#c97b2a", "#d9b44a", "#3d5a3b", "#2e5e4e",
  "#33658a", "#1f3b4d", "#4a4e69", "#5c3c66", "#55443d", "#1c1c1c",
  "#e9e1d0", "#8b8b8b",
];

export function fallbackColor(n: { title: string }): string {
  return SPINE_PALETTE[hash(n.title) % SPINE_PALETTE.length];
}

/** Black or cream text, whichever reads better on bg. */
export function textOn(bg: string): string {
  const m = bg.match(/^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i);
  if (!m) return "#f5efe2";
  const [r, g, b] = m.slice(1).map((x) => parseInt(x, 16) / 255);
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.55 ? "#1b1712" : "#f5efe2";
}

export interface BookSize {
  /** Spine thickness (width on the shelf when standing). */
  thickness: number;
  height: number;
  /** Spine decoration variant. */
  variant: number;
}

export function bookSize(n: LibraryNovel, scale: number): BookSize {
  const h = hash(n.title + n.id);
  const chapters = Math.max(1, n.chapter_count);
  const thick = 26 + Math.min(26, Math.log2(chapters) * 2.6) + (h % 7);
  const height = 150 + ((h >>> 3) % 36);
  return { thickness: Math.round(thick * scale), height: Math.round(height * scale), variant: (h >>> 7) % 4 };
}

export const FRONT_W = 118;
export const FRONT_H = 177;
export const ROW_H = 200;

export function coverOf(n: LibraryNovel): string | null {
  return n.shelf_cover || n.cover_url;
}

// ---- images ----

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image failed to load"));
    img.src = src;
  });
}

const MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  svg: "image/svg+xml",
};

/** Let the user pick an image file; returns a blob: URL or null if cancelled. */
export async function pickImage(title = "Choose an image"): Promise<string | null> {
  const path = await open({ title, filters: [{ name: "Images", extensions: Object.keys(MIME) }] });
  if (!path || Array.isArray(path)) return null;
  const bytes = await readFile(path);
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return URL.createObjectURL(new Blob([bytes], { type: MIME[ext] ?? "image/png" }));
}

/** Shrink to fit maxW x maxH; PNG keeps transparency (decorations), JPEG for photos. */
export async function downscale(
  src: string,
  maxW: number,
  maxH: number,
  format: "png" | "jpeg",
): Promise<{ data: string; w: number; h: number }> {
  const img = await loadImage(src);
  const k = Math.min(1, maxW / img.naturalWidth, maxH / img.naturalHeight);
  const w = Math.max(1, Math.round(img.naturalWidth * k));
  const h = Math.max(1, Math.round(img.naturalHeight * k));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.getContext("2d")!.drawImage(img, 0, 0, w, h);
  return { data: c.toDataURL(`image/${format}`, 0.85), w, h };
}

export function assetMap(assets: ShelfAsset[]): Map<string, string> {
  return new Map(assets.map((a) => [a.id, a.data]));
}

// ---- auto spine color sampled from the cover ----

const COLOR_CACHE_KEY = "shelf-colors";
let colorCache: Record<string, string> | null = null;

function cache(): Record<string, string> {
  if (!colorCache) {
    try {
      colorCache = JSON.parse(localStorage.getItem(COLOR_CACHE_KEY) || "{}");
    } catch {
      colorCache = {};
    }
  }
  return colorCache!;
}

const colorKey = (src: string) => String(hash(src));

export function cachedCoverColor(src: string | null): string | null {
  return src ? (cache()[colorKey(src)] ?? null) : null;
}

/** Saturation-weighted average of the cover, darkened enough to carry light text. */
function dominantColor(img: HTMLImageElement): string {
  const c = document.createElement("canvas");
  c.width = 24;
  c.height = 36;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img, 0, 0, c.width, c.height);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  let r = 0, g = 0, b = 0, w = 0;
  for (let i = 0; i < d.length; i += 4) {
    const max = Math.max(d[i], d[i + 1], d[i + 2]);
    const min = Math.min(d[i], d[i + 1], d[i + 2]);
    const weight = 0.15 + (max - min) / 255;
    r += d[i] * weight;
    g += d[i + 1] * weight;
    b += d[i + 2] * weight;
    w += weight;
  }
  const k = 0.8;
  const hex = (v: number) => Math.round((v / w) * k).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/** Remote covers go through Rust so the canvas isn't tainted by CORS. */
export async function coverColor(src: string): Promise<string> {
  const k = colorKey(src);
  const hit = cache()[k];
  if (hit) return hit;
  const usable = src.startsWith("data:") || src.startsWith("blob:") ? src : await fetchImage(src);
  const color = dominantColor(await loadImage(usable));
  cache()[k] = color;
  try {
    localStorage.setItem(COLOR_CACHE_KEY, JSON.stringify(cache()));
  } catch {
    // cache is only an optimization
  }
  return color;
}

/** Library books + on-shelf decorations in saved order; unknown items are appended. */
export function orderedKeys(prefs: ShelfPrefs, novels: LibraryNovel[], showDecorations: boolean): string[] {
  const present = new Set(novels.map((n) => `n:${n.id}`));
  const shelved = prefs.decorations.filter((d) => !d.float);
  const decos = new Set(shelved.map((d) => `d:${d.id}`));
  const keys = prefs.order.filter((k) => present.has(k) || (showDecorations && decos.has(k)));
  const seen = new Set(keys);
  for (const n of novels) if (!seen.has(`n:${n.id}`)) keys.push(`n:${n.id}`);
  if (showDecorations) for (const d of shelved) if (!seen.has(`d:${d.id}`)) keys.push(`d:${d.id}`);
  return keys;
}
