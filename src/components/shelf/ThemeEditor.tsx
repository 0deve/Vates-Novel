// Build a custom shelf look from your own images: back wall, shelf plank, frame.
import { useState } from "react";
import type { ShelfAsset } from "../../lib/db";
import { logError } from "../../lib/log";
import { downscale, newId, pickImage, type CustomTheme } from "../../lib/shelf";
import { CloseIcon } from "../icons";

type Slot = "wall" | "plank" | "side";

const SLOTS: { slot: Slot; label: string; hint: string; max: [number, number] }[] = [
  { slot: "wall", label: "Back wall", hint: "Wallpaper, wood or anything behind the books.", max: [1600, 1600] },
  { slot: "plank", label: "Shelf plank", hint: "A wide, thin wood strip; it's stretched along each shelf.", max: [1600, 120] },
  { slot: "side", label: "Frame", hint: "The bookcase's outer sides and top.", max: [800, 1600] },
];

interface Props {
  theme: CustomTheme | null;
  assets: Map<string, string>;
  onClose: () => void;
  onSaved: (theme: CustomTheme, added: ShelfAsset[], removed: string[]) => void;
  onDelete: (theme: CustomTheme) => void;
}

export default function ThemeEditor({ theme, assets, onClose, onSaved, onDelete }: Props) {
  const [t, setT] = useState<CustomTheme>(
    theme ?? {
      id: newId(),
      name: "My shelf",
      wallMode: "cover",
      plankColor: "#9a6a3c",
      sideColor: "#6e4522",
      wallColor: "#2b211b",
    },
  );
  const [pending, setPending] = useState<ShelfAsset[]>([]);
  const [removed, setRemoved] = useState<string[]>([]);
  const [error, setError] = useState("");

  const imageOf = (slot: Slot) => {
    const id = t[slot];
    return id ? (pending.find((p) => p.id === id)?.data ?? assets.get(id)) : undefined;
  };

  async function choose(slot: Slot, max: [number, number]) {
    setError("");
    try {
      const src = await pickImage();
      if (!src) return;
      const img = await downscale(src, max[0], max[1], slot === "plank" ? "png" : "jpeg");
      URL.revokeObjectURL(src);
      const id = newId();
      clear(slot);
      setPending((p) => [...p, { id, kind: slot, name: slot, data: img.data }]);
      setT((x) => ({ ...x, [slot]: id }));
    } catch (e) {
      logError("shelf", e);
      setError(`Could not use that image: ${e}`);
    }
  }

  function clear(slot: Slot) {
    const id = t[slot];
    if (!id) return;
    if (pending.some((p) => p.id === id)) setPending((p) => p.filter((x) => x.id !== id));
    else setRemoved((r) => [...r, id]);
    setT((x) => ({ ...x, [slot]: undefined }));
  }

  const wall = imageOf("wall");
  const plank = imageOf("plank");
  const side = imageOf("side");
  const btn = "rounded-md bg-zinc-800 px-3 py-1.5 text-xs hover:bg-zinc-700";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3" onClick={onClose}>
      <div
        className="flex max-h-[92vh] w-full max-w-lg flex-col rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-zinc-800 p-3">
          <h2 className="mr-auto font-semibold">Custom shelf look</h2>
          <button onClick={onClose} aria-label="Close" className="rounded p-1 text-zinc-400 hover:bg-zinc-800">
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          {/* live preview */}
          <div className="rounded-md p-3" style={{ background: side ? `url("${side}") center/cover` : t.sideColor }}>
            <div
              className="h-24"
              style={{
                background: wall
                  ? t.wallMode === "tile"
                    ? `url("${wall}") repeat`
                    : `url("${wall}") center/cover no-repeat`
                  : t.wallColor,
              }}
            />
            <div className="h-3.5" style={{ background: plank ? `url("${plank}") center/100% 100% no-repeat` : t.plankColor }} />
          </div>

          <label className="block space-y-1 text-xs text-zinc-400">
            Name
            <input
              value={t.name}
              onChange={(e) => setT({ ...t, name: e.target.value })}
              className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100"
            />
          </label>

          {SLOTS.map(({ slot, label, hint, max }) => {
            const colorKey = slot === "wall" ? "wallColor" : slot === "plank" ? "plankColor" : "sideColor";
            return (
              <div key={slot} className="space-y-1.5">
                <p className="text-xs font-medium text-zinc-300">{label}</p>
                <p className="text-[11px] text-zinc-600">{hint}</p>
                <div className="flex flex-wrap items-center gap-1.5">
                  <button onClick={() => choose(slot, max)} className={btn}>
                    {imageOf(slot) ? "Replace image" : "Choose image"}
                  </button>
                  {imageOf(slot) && (
                    <button onClick={() => clear(slot)} className={btn}>Remove image</button>
                  )}
                  <span className="ml-2 text-[11px] text-zinc-500">or color</span>
                  <input
                    type="color"
                    value={t[colorKey]}
                    onChange={(e) => setT({ ...t, [colorKey]: e.target.value })}
                    className="h-7 w-9 cursor-pointer rounded border border-zinc-700 bg-transparent"
                  />
                  {slot === "wall" && imageOf("wall") && (
                    <select
                      value={t.wallMode}
                      onChange={(e) => setT({ ...t, wallMode: e.target.value as "cover" | "tile" })}
                      className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs"
                    >
                      <option value="cover">Stretch to fill</option>
                      <option value="tile">Repeat (tile)</option>
                    </select>
                  )}
                </div>
              </div>
            );
          })}
          {error && <p className="text-xs text-red-400">{error}</p>}
        </div>
        <div className="flex gap-2 border-t border-zinc-800 p-3">
          {theme && (
            <button
              onClick={() => window.confirm(`Delete "${theme.name}"?`) && onDelete(theme)}
              className="rounded-md bg-zinc-800 px-4 py-2 text-sm text-red-400 hover:bg-zinc-700"
            >
              Delete
            </button>
          )}
          <button onClick={onClose} className="ml-auto rounded-md bg-zinc-800 px-4 py-2 text-sm hover:bg-zinc-700">
            Cancel
          </button>
          <button
            onClick={() => onSaved({ ...t, name: t.name.trim() || "My shelf" }, pending, removed)}
            className="rounded-md bg-orange-600 px-4 py-2 text-sm font-medium hover:bg-orange-500"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
