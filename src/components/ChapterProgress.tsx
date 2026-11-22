// Small "% through this chapter" label over the reader. Owns its scroll
// listener so scrolling doesn't re-render the whole reader.
import { useEffect, useRef, useState, type RefObject } from "react";
import { loadReaderSettings, saveReaderSettings } from "../lib/settings";

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function chapterPercent(container: HTMLElement): { percent: number; ordinal: number } | null {
  const view = container.getBoundingClientRect();
  const middle = view.top + view.height / 2;
  let current: DOMRect | null = null;
  let ordinal = -1;
  for (const section of container.querySelectorAll<HTMLElement>("[data-chapter-start]")) {
    const rect = section.getBoundingClientRect();
    if (rect.top > middle) break;
    current = rect;
    ordinal = Number(section.dataset.chapterStart);
  }
  if (!current) return null;
  const travel = current.height - view.height;
  if (travel <= 0) return { percent: 100, ordinal };
  return { percent: Math.round(clamp01((view.top - current.top) / travel) * 100), ordinal };
}

interface Props {
  containerRef: RefObject<HTMLDivElement>;
  /** Changes whenever chapters are added or removed. */
  contentKey: unknown;
  /** Label lines for a chapter at a given %, in display order. */
  lines: (ordinal: number, percent: number) => string[];
  /** One item per line, else joined on one line. */
  stacked: boolean;
}

export default function ChapterProgress({ containerRef, contentKey, lines, stacked }: Props) {
  const [at, setAt] = useState<{ percent: number; ordinal: number } | null>(null);
  const percent = at?.percent ?? null;
  const [pos, setPos] = useState(() => {
    const s = loadReaderSettings();
    return { x: s.progressX, y: s.progressY };
  });
  const areaRef = useRef<HTMLDivElement | null>(null);
  const labelRef = useRef<HTMLDivElement | null>(null);
  const grabRef = useRef<{ dx: number; dy: number } | null>(null);
  const posRef = useRef(pos);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      setAt(chapterPercent(container));
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, [containerRef, contentKey]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    grabRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const grab = grabRef.current;
    const area = areaRef.current?.getBoundingClientRect();
    const label = labelRef.current?.getBoundingClientRect();
    if (!grab || !area || !label) return;
    const next = {
      x: clamp01((e.clientX - area.left - grab.dx) / (area.width - label.width)),
      y: clamp01((e.clientY - area.top - grab.dy) / (area.height - label.height)),
    };
    posRef.current = next;
    setPos(next);
  };

  const onPointerUp = () => {
    if (!grabRef.current) return;
    grabRef.current = null;
    saveReaderSettings({
      ...loadReaderSettings(),
      progressX: posRef.current.x,
      progressY: posRef.current.y,
    });
  };

  if (percent === null || !at) return null;
  const items = lines(at.ordinal, at.percent);
  if (items.length === 0) return null;

  // Translating by its own fraction keeps the label inside the area at both edges.
  return (
    <div
      ref={areaRef}
      className="pointer-events-none absolute inset-y-2 left-2 right-4"
    >
      <div
        ref={labelRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        // Keep a drag near the screen edge from opening the chapter panel.
        onTouchStart={(e) => e.stopPropagation()}
        onTouchEnd={(e) => e.stopPropagation()}
        title="Drag to move"
        className="pointer-events-auto absolute cursor-move touch-none select-none rounded bg-zinc-950/70 px-1.5 py-0.5 text-xs tabular-nums text-zinc-500"
        style={{
          left: `${pos.x * 100}%`,
          top: `${pos.y * 100}%`,
          transform: `translate(${-pos.x * 100}%, ${-pos.y * 100}%)`,
        }}
      >
        {stacked ? (
          items.map((t, i) => (
            <div key={i} className={i === 0 ? "" : "text-zinc-600"}>
              {t}
            </div>
          ))
        ) : (
          items.join(" · ")
        )}
      </div>
    </div>
  );
}
