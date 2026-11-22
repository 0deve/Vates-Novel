// One book on the shelf, drawn as a spine, a front-facing cover, or a lying-flat slab.
import { useEffect, useState } from "react";
import {
  bookSize,
  cachedCoverColor,
  coverColor,
  coverOf,
  fallbackColor,
  FRONT_H,
  FRONT_W,
  textOn,
} from "../../lib/shelf";
import type { LibraryNovel } from "../../types";

/** Spine color: user override, else sampled from the cover, else a stable palette pick. */
export function useSpineColor(n: LibraryNovel): string {
  const src = coverOf(n);
  const [auto, setAuto] = useState<string | null>(() => cachedCoverColor(src));
  useEffect(() => {
    if (n.shelf_color || !src) return;
    let live = true;
    coverColor(src)
      .then((c) => live && setAuto(c))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [src, n.shelf_color]);
  return n.shelf_color || auto || fallbackColor(n);
}

const inProgress = (n: LibraryNovel) =>
  n.last_read_chapter != null && n.chapter_count > 0 && n.last_read_chapter < n.chapter_count;

const surname = (a: string | null) => (a ? (a.trim().split(/\s+/).pop() ?? "") : "");

/**
 * Largest font (7-14px) whose wrapped title fits the spine: lines stack across
 * the thickness, characters run along the height.
 */
export function fitTitle(title: string, thickness: number, length: number): { size: number; lines: number } {
  const across = thickness - 6;
  for (let size = 14; size >= 7; size -= 0.5) {
    const perLine = Math.max(1, Math.floor(length / (size * 0.56)));
    const words = title.split(/\s+/);
    let lines = 1;
    let cur = 0;
    for (const w of words) {
      const need = cur === 0 ? w.length : cur + 1 + w.length;
      if (need <= perLine) cur = need;
      else {
        lines += Math.ceil(Math.max(1, w.length) / perLine);
        cur = w.length % perLine || perLine;
      }
    }
    if (lines * size * 1.12 <= across) return { size, lines };
  }
  return { size: 7, lines: Math.max(1, Math.floor(across / (7 * 1.12))) };
}

const TOP = 18;
const BOTTOM = 22;

function Bands({ variant, fg }: { variant: number; fg: string }) {
  // Decorations stay inside the top band and just above the author zone, never over text.
  if (variant === 1)
    return (
      <>
        <div className="absolute inset-x-0 h-[2px] opacity-70" style={{ top: 6, background: fg }} />
        <div className="absolute inset-x-0 h-px opacity-50" style={{ top: 11, background: fg }} />
        <div className="absolute inset-x-0 h-[2px] opacity-70" style={{ bottom: BOTTOM, background: fg }} />
      </>
    );
  if (variant === 2)
    return (
      <>
        <div className="absolute inset-x-0 top-0 bg-black/30" style={{ height: TOP - 4 }} />
        <div className="absolute inset-x-0 h-px bg-black/40" style={{ bottom: BOTTOM }} />
      </>
    );
  if (variant === 3)
    return (
      <div
        className="absolute left-1/2 h-2.5 w-2.5 -translate-x-1/2 rotate-45 border opacity-60"
        style={{ top: 5, borderColor: fg }}
      />
    );
  return null;
}

export function Spine({ n, scale }: { n: LibraryNovel; scale: number }) {
  const { thickness, height, variant } = bookSize(n, scale);
  const bg = useSpineColor(n);
  const fg = textOn(bg);
  const titleLen = height - TOP - BOTTOM - 6;
  const { size } = fitTitle(n.title, thickness, titleLen);
  const author = surname(n.author);
  const authorSize = Math.max(6.5, Math.min(11, (thickness - 5) / Math.max(3, author.length) / 0.62));

  if (n.shelf_spine)
    return (
      <div
        className="relative overflow-hidden rounded-[3px] shadow-[2px_0_4px_rgba(0,0,0,0.45)]"
        style={{ width: thickness, height }}
        title={n.title}
      >
        <img src={n.shelf_spine} alt={n.title} draggable={false} className="h-full w-full object-cover" />
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(90deg,rgba(0,0,0,.3),rgba(255,255,255,.08)_20%,transparent_45%,rgba(0,0,0,.1)_80%,rgba(0,0,0,.35))]" />
        {inProgress(n) && <Ribbon />}
        {n.new_chapters_count > 0 && <NewDot />}
      </div>
    );

  return (
    <div
      className="relative overflow-hidden rounded-[3px] shadow-[2px_0_4px_rgba(0,0,0,0.45)]"
      style={{
        width: thickness,
        height,
        background: `linear-gradient(90deg, rgba(0,0,0,.35), rgba(255,255,255,.10) 18%, rgba(255,255,255,0) 40%, rgba(0,0,0,.12) 80%, rgba(0,0,0,.4)), ${bg}`,
        color: fg,
      }}
      title={n.title}
    >
      <Bands variant={variant} fg={fg} />
      <div
        className="absolute inset-x-0 flex items-center justify-center overflow-hidden"
        style={{ top: TOP, bottom: BOTTOM + 3 }}
      >
        <span
          className="block text-center font-serif font-semibold"
          style={{
            writingMode: "vertical-rl",
            fontSize: size,
            lineHeight: 1.12,
            maxHeight: "100%",
            maxWidth: thickness - 4,
            overflowWrap: "anywhere",
          }}
        >
          {n.title}
        </span>
      </div>
      {author && (
        <span
          className="absolute inset-x-0 flex items-center justify-center overflow-hidden whitespace-nowrap px-0.5 font-serif font-medium opacity-90"
          style={{ bottom: 0, height: BOTTOM, fontSize: authorSize }}
        >
          {author}
        </span>
      )}
      {inProgress(n) && <Ribbon />}
      {n.new_chapters_count > 0 && <NewDot />}
    </div>
  );
}

/** Reading bookmark: hangs from the top edge, clear of the title and author. */
function Ribbon() {
  return (
    <div className="absolute right-1 top-0 h-4 w-1.5 bg-orange-500 shadow [clip-path:polygon(0_0,100%_0,100%_100%,50%_75%,0_100%)]" />
  );
}

function NewDot() {
  return <div className="absolute left-1/2 top-1 h-2 w-2 -translate-x-1/2 rounded-full bg-orange-500 ring-2 ring-black/30" />;
}

export function frontWidth(scale: number): number {
  return Math.round(FRONT_W * scale) + 6;
}

export function Front({ n, scale }: { n: LibraryNovel; scale: number }) {
  const w = Math.round(FRONT_W * scale);
  const h = Math.round(FRONT_H * scale);
  const src = coverOf(n);
  const bg = useSpineColor(n);
  return (
    <div className="relative" style={{ width: w + 6, height: h }}>
      {/* page block peeking out on the right */}
      <div className="absolute bottom-1 right-0 top-1 w-2 rounded-r-sm bg-[repeating-linear-gradient(0deg,#efe8d8_0_1px,#d9d0bc_1px_2px)]" />
      <div
        className="absolute left-0 top-0 overflow-hidden rounded-[3px] shadow-[3px_3px_6px_rgba(0,0,0,0.5)]"
        style={{ width: w, height: h, background: bg }}
        title={n.title}
      >
        {src ? (
          <img src={src} alt={n.title} className="h-full w-full object-cover" draggable={false} />
        ) : (
          <div className="flex h-full flex-col justify-center p-2 text-center font-serif" style={{ color: textOn(bg) }}>
            <span className="text-sm font-semibold leading-tight">{n.title}</span>
            {n.author && <span className="mt-2 text-[11px] opacity-80">{n.author}</span>}
          </div>
        )}
        <div className="pointer-events-none absolute inset-y-0 left-0 w-2.5 bg-gradient-to-r from-black/40 to-transparent" />
      </div>
      {inProgress(n) && (
        <div className="absolute -bottom-1 left-4 h-6 w-1.5 bg-orange-500 [clip-path:polygon(0_0,100%_0,100%_100%,50%_80%,0_100%)]" />
      )}
      {n.new_chapters_count > 0 && (
        <div className="absolute -right-1 -top-1 h-3 w-3 rounded-full bg-orange-500 ring-2 ring-black/40" />
      )}
    </div>
  );
}

/** One book lying flat, as part of a pile. */
export function Slab({ n, scale, width }: { n: LibraryNovel; scale: number; width: number }) {
  const { thickness } = bookSize(n, scale);
  const bg = useSpineColor(n);
  const fg = textOn(bg);
  const h = Math.max(16, Math.round(thickness * 0.75));
  return (
    <div
      className="relative flex items-center justify-center overflow-hidden rounded-[3px] px-3 shadow-[0_2px_3px_rgba(0,0,0,0.45)]"
      style={{
        width,
        height: h,
        background: n.shelf_spine
          ? `url("${n.shelf_spine}") center/cover`
          : `linear-gradient(180deg, rgba(255,255,255,.12), rgba(0,0,0,0) 40%, rgba(0,0,0,.3)), ${bg}`,
        color: fg,
      }}
      title={n.title}
    >
      {!n.shelf_spine && (
        <span
          className="line-clamp-2 text-center font-serif font-semibold leading-tight"
          style={{ fontSize: Math.max(8, Math.min(12, h * 0.42)) }}
        >
          {n.title}
        </span>
      )}
      {inProgress(n) && <div className="absolute right-3 top-0 h-full w-1.5 bg-orange-500" />}
    </div>
  );
}

export function slabWidth(n: LibraryNovel, scale: number): number {
  const { height } = bookSize(n, scale);
  return Math.round(height * 0.78);
}
