// Pan/zoom an image inside a 2:3 frame and export the framed area as a JPEG data URL.
import { useEffect, useRef, useState } from "react";
import { loadImage } from "../../lib/shelf";

interface Props {
  src: string;
  /** Frame size on screen; output is twice this. Default is a 2:3 cover. */
  frame?: { w: number; h: number };
  hint?: string;
  onCancel: () => void;
  onDone: (dataUrl: string) => void;
}

export default function CoverCropper({ src, frame = { w: 220, h: 330 }, hint, onCancel, onDone }: Props) {
  const FRAME_W = frame.w;
  const FRAME_H = frame.h;
  const OUT_W = frame.w * 2;
  const OUT_H = frame.h * 2;
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [error, setError] = useState("");
  const [zoom, setZoom] = useState(1);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  useEffect(() => {
    loadImage(src)
      .then((i) => {
        setImg(i);
        setZoom(1);
        setPos({ x: 0, y: 0 });
      })
      .catch((e) => setError(String(e)));
  }, [src]);

  // Base scale makes the image cover the frame at zoom 1.
  const base = img ? Math.max(FRAME_W / img.naturalWidth, FRAME_H / img.naturalHeight) : 1;
  const scale = base * zoom;
  const w = img ? img.naturalWidth * scale : 0;
  const h = img ? img.naturalHeight * scale : 0;

  const clamp = (p: { x: number; y: number }) => ({
    x: Math.min(0, Math.max(FRAME_W - w, p.x)),
    y: Math.min(0, Math.max(FRAME_H - h, p.y)),
  });

  // Center on load and keep the image covering the frame as zoom changes.
  useEffect(() => {
    if (!img) return;
    setPos((p) => clamp(p.x === 0 && p.y === 0 && zoom === 1 ? { x: (FRAME_W - w) / 2, y: (FRAME_H - h) / 2 } : p));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [img, zoom]);

  function exportCrop() {
    if (!img) return;
    const c = document.createElement("canvas");
    c.width = OUT_W;
    c.height = OUT_H;
    const ctx = c.getContext("2d")!;
    const k = OUT_W / FRAME_W;
    ctx.drawImage(img, pos.x * k, pos.y * k, w * k, h * k);
    try {
      onDone(c.toDataURL("image/jpeg", 0.85));
    } catch (e) {
      setError(`Could not crop this image: ${e}`);
    }
  }

  return (
    <div className="space-y-3">
      <div
        className="relative mx-auto touch-none overflow-hidden rounded bg-zinc-950 ring-1 ring-zinc-700"
        style={{ width: FRAME_W, height: FRAME_H, cursor: "grab" }}
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          drag.current = { x: e.clientX, y: e.clientY, px: pos.x, py: pos.y };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (d) setPos(clamp({ x: d.px + e.clientX - d.x, y: d.py + e.clientY - d.y }));
        }}
        onPointerUp={() => (drag.current = null)}
        onWheel={(e) => setZoom((z) => Math.min(5, Math.max(1, z - e.deltaY * 0.002)))}
      >
        {img && (
          <img
            src={src}
            alt=""
            draggable={false}
            className="pointer-events-none absolute max-w-none"
            style={{ left: pos.x, top: pos.y, width: w, height: h }}
          />
        )}
        {!img && !error && <p className="p-4 text-xs text-zinc-500">Loading…</p>}
      </div>
      <label className="flex items-center gap-3 text-xs text-zinc-400">
        Zoom
        <input
          type="range"
          min={1}
          max={5}
          step={0.01}
          value={zoom}
          onChange={(e) => setZoom(Number(e.target.value))}
          className="flex-1 accent-orange-500"
        />
      </label>
      <p className="text-center text-xs text-zinc-500">{hint ?? "Drag to position the cover in the frame."}</p>
      {error && <p className="text-xs text-red-400">{error}</p>}
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="rounded-md bg-zinc-800 px-4 py-2 text-sm hover:bg-zinc-700">
          Back
        </button>
        <button
          onClick={exportCrop}
          disabled={!img}
          className="rounded-md bg-orange-600 px-4 py-2 text-sm font-medium hover:bg-orange-500 disabled:opacity-50"
        >
          Use this crop
        </button>
      </div>
    </div>
  );
}
