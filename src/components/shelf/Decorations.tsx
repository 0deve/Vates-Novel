// Shelf decorations as flat SVGs. Sizes are in shelf px at scale 1.
import type { BuiltinDecoration, Decoration } from "../../lib/shelf";

export const DECORATION_SIZE: Record<BuiltinDecoration, { w: number; h: number }> = {
  plant: { w: 70, h: 110 },
  succulent: { w: 56, h: 60 },
  bookend: { w: 34, h: 120 },
  lamp: { w: 64, h: 150 },
  candle: { w: 40, h: 90 },
  frame: { w: 78, h: 100 },
  globe: { w: 72, h: 120 },
  hourglass: { w: 42, h: 80 },
  vase: { w: 50, h: 120 },
};

const art: Record<BuiltinDecoration, JSX.Element> = {
  plant: (
    <>
      <path d="M35 62 C20 40 8 38 4 22 C18 26 28 38 35 58Z" fill="#4f8a4a" />
      <path d="M35 60 C50 36 60 30 68 14 C52 20 42 34 35 56Z" fill="#3f7a3c" />
      <path d="M35 60 C30 34 34 16 40 2 C46 20 42 40 35 60Z" fill="#5f9e57" />
      <path d="M35 64 C24 54 12 56 6 50 C16 46 28 50 35 62Z" fill="#3a6e37" />
      <path d="M35 64 C46 54 58 58 66 50 C56 46 44 50 35 62Z" fill="#4a8545" />
      <path d="M14 66 H56 L50 110 H20Z" fill="#b5653f" />
      <rect x="11" y="62" width="48" height="9" rx="2" fill="#c9774d" />
    </>
  ),
  succulent: (
    <>
      <ellipse cx="28" cy="26" rx="8" ry="14" fill="#7fae8c" />
      <ellipse cx="17" cy="30" rx="7" ry="12" fill="#6c9e7b" transform="rotate(-35 17 30)" />
      <ellipse cx="39" cy="30" rx="7" ry="12" fill="#6c9e7b" transform="rotate(35 39 30)" />
      <ellipse cx="28" cy="32" rx="6" ry="9" fill="#93c2a0" />
      <path d="M10 38 H46 L42 60 H14Z" fill="#e8e2d6" />
      <rect x="8" y="35" width="40" height="6" rx="2" fill="#f4efe6" />
    </>
  ),
  bookend: (
    <>
      <path d="M2 120 V18 Q2 4 16 4 H22 Q32 4 32 14 V120Z" fill="#3c3c40" />
      <rect x="0" y="112" width="34" height="8" rx="1" fill="#2a2a2e" />
      <circle cx="17" cy="30" r="6" fill="#c9a24a" />
    </>
  ),
  lamp: (
    <>
      <path d="M10 52 L20 6 H44 L54 52Z" fill="#e9d9b8" />
      <path d="M10 52 H54" stroke="#cdb990" strokeWidth="3" />
      <rect x="30" y="52" width="4" height="78" fill="#8f7a52" />
      <ellipse cx="32" cy="140" rx="22" ry="7" fill="#6f5d3d" />
      <rect x="12" y="134" width="40" height="8" rx="3" fill="#8f7a52" />
      <ellipse cx="32" cy="54" rx="26" ry="6" fill="rgba(255,220,140,.18)" />
    </>
  ),
  candle: (
    <>
      <path d="M20 4 C26 12 26 20 20 24 C14 20 14 12 20 4Z" fill="#f6b73c" />
      <path d="M20 10 C23 15 23 19 20 21 C17 19 17 15 20 10Z" fill="#fff1c2" />
      <rect x="19" y="23" width="2" height="6" fill="#333" />
      <rect x="10" y="28" width="20" height="54" rx="3" fill="#f2ece1" />
      <path d="M10 34 q4 6 0 12" stroke="#e0d8c9" strokeWidth="3" fill="none" />
      <ellipse cx="20" cy="84" rx="18" ry="5" fill="#a88a5a" />
    </>
  ),
  frame: (
    <>
      <rect x="2" y="2" width="74" height="92" rx="3" fill="#2b2b2e" />
      <rect x="10" y="10" width="58" height="76" fill="#f2eee6" />
      <rect x="14" y="14" width="50" height="68" fill="#7d9bb5" />
      <path d="M14 82 L32 56 L44 70 L52 60 L64 76 V82Z" fill="#4e6b52" />
      <circle cx="52" cy="28" r="6" fill="#f4d27a" />
      <path d="M50 94 L64 100 H70 L60 94Z" fill="#1d1d20" />
    </>
  ),
  globe: (
    <>
      <circle cx="36" cy="46" r="30" fill="#3f7fae" />
      <path d="M18 34 q8 -6 14 2 q6 8 -4 14 q-8 4 -6 12 q-8 -6 -8 -16Z M42 22 q10 2 14 10 q-6 4 -12 0 q-4 -4 -2 -10Z M44 56 q8 -4 12 4 q-2 10 -10 12 q-4 -8 -2 -16Z" fill="#79b36b" />
      <path d="M8 46 A28 28 0 0 0 64 46" stroke="#b8923f" strokeWidth="4" fill="none" transform="rotate(-20 36 46)" />
      <rect x="33" y="78" width="6" height="26" fill="#8a6a2e" />
      <path d="M14 116 Q36 98 58 116Z" fill="#6e5223" />
    </>
  ),
  hourglass: (
    <>
      <rect x="2" y="2" width="38" height="6" rx="2" fill="#6e4a2a" />
      <rect x="2" y="72" width="38" height="6" rx="2" fill="#6e4a2a" />
      <rect x="5" y="8" width="3" height="64" fill="#8a6038" />
      <rect x="34" y="8" width="3" height="64" fill="#8a6038" />
      <path d="M10 10 H32 C32 26 24 34 21 40 C24 46 32 54 32 70 H10 C10 54 18 46 21 40 C18 34 10 26 10 10Z" fill="rgba(220,235,245,.35)" stroke="rgba(220,235,245,.6)" />
      <path d="M14 22 H28 C26 30 23 34 21 38 C19 34 16 30 14 22Z" fill="#e2c07a" />
      <path d="M12 69 C14 60 18 56 21 55 C24 56 28 60 30 69Z" fill="#e2c07a" />
    </>
  ),
  vase: (
    <>
      <path d="M25 40 C25 30 18 26 16 8 M25 40 C28 26 34 22 36 4 M25 40 C24 28 26 18 24 2" stroke="#6a8a4a" strokeWidth="2" fill="none" />
      <circle cx="16" cy="8" r="5" fill="#d96a5a" />
      <circle cx="36" cy="5" r="5" fill="#e8c35a" />
      <circle cx="24" cy="3" r="4" fill="#f0efe9" />
      <path d="M18 40 H32 C32 48 44 60 44 84 C44 106 36 118 25 118 C14 118 6 106 6 84 C6 60 18 48 18 40Z" fill="#3e6f8e" />
      <path d="M8 80 H42" stroke="#2f5670" strokeWidth="3" />
    </>
  ),
};

/** Rendered size of a decoration at the given shelf scale. */
export function decoSize(d: Decoration, scale: number): { w: number; h: number } {
  const base = d.type === "custom" ? { w: d.w ?? 80, h: d.h ?? 100 } : DECORATION_SIZE[d.type];
  const k = scale * (d.size ?? 1);
  return { w: Math.round(base.w * k), h: Math.round(base.h * k) };
}

export function DecorationArt({
  deco,
  scale,
  assets,
}: {
  deco: Decoration;
  scale: number;
  assets: Map<string, string>;
}) {
  const { w, h } = decoSize(deco, scale);
  const shadow = "block drop-shadow-[2px_3px_3px_rgba(0,0,0,0.45)]";
  if (deco.type === "custom") {
    const src = deco.assetId ? assets.get(deco.assetId) : undefined;
    return src ? (
      <img src={src} alt="" draggable={false} width={w} height={h} className={`${shadow} pointer-events-none`} style={{ width: w, height: h }} />
    ) : (
      <div className="rounded border border-dashed border-zinc-500" style={{ width: w, height: h }} />
    );
  }
  const base = DECORATION_SIZE[deco.type];
  return (
    <svg width={w} height={h} viewBox={`0 0 ${base.w} ${base.h}`} className={shadow}>
      {art[deco.type]}
    </svg>
  );
}
