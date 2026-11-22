// Per-book shelf look: display mode, spine color, and a custom (cropped) cover.
import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { fetchImage, searchCovers, type CoverHit } from "../../lib/api";
import { saveShelfLook, type ShelfMode } from "../../lib/db";
import { logError } from "../../lib/log";
import { searchAllSources } from "../../lib/migrate";
import { SWATCHES } from "../../lib/shelf";
import type { LibraryNovel } from "../../types";
import { CloseIcon } from "../icons";
import CoverCropper from "./CoverCropper";
import { Front, Slab, slabWidth, Spine } from "./ShelfBook";

interface Props {
  novel: LibraryNovel;
  /** Grid view: only the cover controls, no shelf-specific options. */
  coverOnly?: boolean;
  onClose: () => void;
  onSaved: () => void;
}

type Target = "cover" | "spine";
type Step =
  | { kind: "main" }
  | { kind: "search"; target: Target }
  | { kind: "crop"; src: string; target: Target };

const SPINE_FRAME = { w: 64, h: 330 };

const MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
};

export default function BookCustomizer({ novel, coverOnly = false, onClose, onSaved }: Props) {
  const [mode, setMode] = useState<ShelfMode | null>(novel.shelf_mode);
  const [color, setColor] = useState<string | null>(novel.shelf_color);
  const [cover, setCover] = useState<string | null>(novel.shelf_cover);
  const [spine, setSpine] = useState<string | null>(novel.shelf_spine);
  const [step, setStep] = useState<Step>({ kind: "main" });
  const [query, setQuery] = useState(`${novel.title} ${novel.author ?? ""}`.trim());
  const [hits, setHits] = useState<CoverHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const preview: LibraryNovel = {
    ...novel,
    shelf_mode: mode,
    shelf_color: color,
    shelf_cover: cover,
    shelf_spine: spine,
  };
  const currentCover = cover || novel.cover_url;

  async function fromDevice(target: Target) {
    setError("");
    try {
      const path = await open({
        title: target === "spine" ? "Choose a spine image" : "Choose a cover image",
        filters: [{ name: "Images", extensions: Object.keys(MIME) }],
      });
      if (!path || Array.isArray(path)) return;
      const bytes = await readFile(path);
      const ext = path.split(".").pop()?.toLowerCase() ?? "";
      const blob = new Blob([bytes], { type: MIME[ext] ?? "image/jpeg" });
      setStep({ kind: "crop", src: URL.createObjectURL(blob), target });
    } catch (e) {
      setError(`Could not open image: ${e}`);
    }
  }

  async function runSearch() {
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    setError("");
    setHits([]);
    const fromSources = searchAllSources(novel.title, () => {}).then((all) =>
      all.flatMap((h) =>
        h.results
          .filter((r) => r.cover_url)
          .map((r) => ({
            url: r.cover_url!,
            title: r.title,
            author: r.author,
            source: h.source.name,
          })),
      ),
    );
    const [books, web] = await Promise.allSettled([searchCovers(q), fromSources]);
    const out: CoverHit[] = [];
    if (web.status === "fulfilled") out.push(...web.value);
    if (books.status === "fulfilled") out.push(...books.value);
    else setError(String(books.reason));
    const seen = new Set<string>();
    setHits(out.filter((h) => !seen.has(h.url) && seen.add(h.url)));
    setSearching(false);
  }

  async function pickHit(h: CoverHit, target: Target) {
    setBusy(h.url);
    setError("");
    try {
      setStep({ kind: "crop", src: await fetchImage(h.url), target });
    } catch (e) {
      setError(`Could not load that image: ${e}`);
    } finally {
      setBusy("");
    }
  }

  async function cropCurrent(target: Target) {
    const from = target === "spine" ? spine || currentCover : currentCover;
    if (!from) return;
    setBusy(`crop-${target}`);
    try {
      const src = from.startsWith("data:") ? from : await fetchImage(from);
      setStep({ kind: "crop", src, target });
    } catch (e) {
      setError(`Could not load the cover: ${e}`);
    } finally {
      setBusy("");
    }
  }

  async function save() {
    try {
      await saveShelfLook(novel.id, { cover, mode, color, spine });
      onSaved();
    } catch (e) {
      logError("shelf", e);
      setError(String(e));
    }
  }

  const seg = (active: boolean) =>
    `flex-1 rounded-md px-3 py-1.5 text-xs ${active ? "bg-orange-600 text-white" : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"}`;
  const btn = "rounded-md bg-zinc-800 px-3 py-1.5 text-xs hover:bg-zinc-700 disabled:opacity-50";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3"
      onClick={onClose}
    >
      <div
        className="flex max-h-[92vh] w-full max-w-lg flex-col rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-zinc-800 p-3">
          <h2 className="mr-auto truncate font-semibold">{novel.title}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-zinc-400 hover:bg-zinc-800"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {step.kind === "crop" && (
            <CoverCropper
              src={step.src}
              frame={step.target === "spine" ? SPINE_FRAME : undefined}
              hint={
                step.target === "spine" ? "Drag to choose the strip used as the spine." : undefined
              }
              onCancel={() => setStep({ kind: "main" })}
              onDone={(url) => {
                if (step.target === "spine") {
                  setSpine(url);
                  if (mode === "front") setMode(null);
                } else {
                  setCover(url);
                  if (!mode && !coverOnly) setMode("front");
                }
                setStep({ kind: "main" });
              }}
            />
          )}

          {step.kind === "search" && (
            <div className="space-y-3">
              <form
                className="flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void runSearch();
                }}
              >
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm"
                />
                <button className="rounded-md bg-orange-600 px-4 py-2 text-sm font-medium hover:bg-orange-500">
                  Search
                </button>
              </form>
              {searching && (
                <p className="text-xs text-zinc-500">
                  Searching Open Library, Google Books and your sources…
                </p>
              )}
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {hits.map((h) => (
                  <button
                    key={h.url}
                    onClick={() => pickHit(h, step.target)}
                    disabled={!!busy}
                    className="group text-left disabled:opacity-50"
                    title={`${h.title}${h.author ? ` — ${h.author}` : ""} (${h.source})`}
                  >
                    <div className="aspect-[2/3] overflow-hidden rounded bg-zinc-800 ring-orange-500 group-hover:ring-2">
                      <img
                        src={h.url}
                        alt=""
                        loading="lazy"
                        className="h-full w-full object-cover"
                      />
                    </div>
                    <p className="mt-1 truncate text-[10px] text-zinc-500">
                      {busy === h.url ? "Loading…" : h.source}
                    </p>
                  </button>
                ))}
              </div>
              {!searching && hits.length === 0 && (
                <p className="text-xs text-zinc-500">No covers yet. Try a different search.</p>
              )}
              <button onClick={() => setStep({ kind: "main" })} className={btn}>
                Back
              </button>
            </div>
          )}

          {step.kind === "main" && (
            <div className="space-y-5">
              <div className="flex h-52 items-end justify-center rounded-lg bg-[#2e2119] px-4 pb-2">
                {coverOnly && <Front n={preview} scale={1} />}
                {!coverOnly && (mode ?? "spine") === "spine" && <Spine n={preview} scale={1} />}
                {!coverOnly && mode === "front" && <Front n={preview} scale={1} />}
                {!coverOnly && mode === "stack" && (
                  <div className="flex flex-col gap-0">
                    <Slab
                      n={{ ...preview, id: preview.id + 1, title: " " }}
                      scale={1}
                      width={slabWidth(preview, 1) - 10}
                    />
                    <Slab n={preview} scale={1} width={slabWidth(preview, 1)} />
                  </div>
                )}
              </div>

              {!coverOnly && (
                <>
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-zinc-400">On the shelf</p>
                    <div className="flex gap-1.5">
                      <button
                        onClick={() => setMode(null)}
                        className={seg(mode === null || mode === "spine")}
                      >
                        Spine out
                      </button>
                      <button onClick={() => setMode("front")} className={seg(mode === "front")}>
                        Facing forward
                      </button>
                      <button onClick={() => setMode("stack")} className={seg(mode === "stack")}>
                        Stacked flat
                      </button>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <p className="text-xs font-medium text-zinc-400">Spine color</p>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        onClick={() => setColor(null)}
                        className={`${seg(color === null)} flex-none`}
                      >
                        From cover
                      </button>
                      {SWATCHES.map((c) => (
                        <button
                          key={c}
                          onClick={() => setColor(c)}
                          aria-label={c}
                          className={`h-7 w-7 rounded-full ring-offset-2 ring-offset-zinc-900 ${color === c ? "ring-2 ring-orange-500" : ""}`}
                          style={{ background: c }}
                        />
                      ))}
                      <input
                        type="color"
                        value={color ?? "#7b2d26"}
                        onChange={(e) => setColor(e.target.value)}
                        className="h-7 w-9 cursor-pointer rounded border border-zinc-700 bg-transparent"
                        title="Custom color"
                      />
                    </div>
                  </div>
                </>
              )}

              <div className="space-y-2">
                <p className="text-xs font-medium text-zinc-400">Cover</p>
                <div className="flex flex-wrap gap-1.5">
                  <button onClick={() => fromDevice("cover")} className={btn}>
                    From device
                  </button>
                  <button
                    onClick={() => {
                      setStep({ kind: "search", target: "cover" });
                      if (hits.length === 0) void runSearch();
                    }}
                    className={btn}
                  >
                    Search covers
                  </button>
                  <button
                    onClick={() => cropCurrent("cover")}
                    disabled={!currentCover || !!busy}
                    className={btn}
                  >
                    {busy === "crop-cover" ? "Loading…" : "Crop current"}
                  </button>
                  <button onClick={() => setCover(null)} disabled={!cover} className={btn}>
                    Use source cover
                  </button>
                </div>
              </div>

              {!coverOnly && (
                <div className="space-y-2">
                  <p className="text-xs font-medium text-zinc-400">Spine image</p>
                  <div className="flex flex-wrap gap-1.5">
                    <button onClick={() => fromDevice("spine")} className={btn}>
                      From device
                    </button>
                    <button
                      onClick={() => {
                        setStep({ kind: "search", target: "spine" });
                        if (hits.length === 0) void runSearch();
                      }}
                      className={btn}
                    >
                      Search images
                    </button>
                    <button
                      onClick={() => cropCurrent("spine")}
                      disabled={!(spine || currentCover) || !!busy}
                      className={btn}
                    >
                      {busy === "crop-spine" ? "Loading…" : spine ? "Re-crop" : "Strip from cover"}
                    </button>
                    <button onClick={() => setSpine(null)} disabled={!spine} className={btn}>
                      Generated spine
                    </button>
                  </div>
                  <p className="text-[11px] text-zinc-600">
                    A photo of the real spine looks best. Without one, the spine is drawn from the
                    title and color.
                  </p>
                </div>
              )}
            </div>
          )}
          {error && <p className="mt-3 break-words text-xs text-red-400">{error}</p>}
        </div>

        {step.kind === "main" && (
          <div className="flex justify-end gap-2 border-t border-zinc-800 p-3">
            <button
              onClick={onClose}
              className="rounded-md bg-zinc-800 px-4 py-2 text-sm hover:bg-zinc-700"
            >
              Cancel
            </button>
            <button
              onClick={save}
              className="rounded-md bg-orange-600 px-4 py-2 text-sm font-medium hover:bg-orange-500"
            >
              Save
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
