// Experimental bookshelf library view. Auto layout packs items into rows; free
// layout keeps user-placed positions on user-managed shelves. Decorations can
// also float anywhere over the bookcase.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  addShelfAsset,
  deleteShelfAssets,
  fetchShelfAssets,
  type ShelfAsset,
} from "../../lib/db";
import { logError } from "../../lib/log";
import {
  assetMap,
  bookSize,
  DECORATION_LABELS,
  downscale,
  loadShelfPrefs,
  newId,
  orderedKeys,
  pickImage,
  resolveTheme,
  ROW_H,
  saveShelfPrefs,
  SHELF_STYLES,
  WALL_STYLES,
  type BuiltinDecoration,
  type Decoration,
  type FreeRow,
  type ShelfPrefs,
  type WallStyle,
} from "../../lib/shelf";
import type { LibraryNovel } from "../../types";
import { ChevronDownIcon, ChevronUpIcon, CloseIcon } from "../icons";
import BookCustomizer from "./BookCustomizer";
import { DecorationArt, decoSize } from "./Decorations";
import { Front, frontWidth, Slab, slabWidth, Spine } from "./ShelfBook";
import ThemeEditor from "./ThemeEditor";

interface Props {
  novels: LibraryNovel[];
  /** Search/collection filter active: hide decorations, freeze positions. */
  filtered: boolean;
  onOpen: (novelId: number) => void;
  onChanged: () => void;
}

type Placed =
  | { kind: "book"; key: string; n: LibraryNovel; x: number; w: number }
  | { kind: "pile"; key: string; books: LibraryNovel[]; x: number; w: number }
  | { kind: "deco"; key: string; d: Decoration; x: number; w: number };

interface RenderRow {
  id: string;
  items: Placed[];
}

const SIDE = 14;
const GAP = 3;
const PILE_SNAP = 24;
const MAX_PILE = 6;

interface Drag {
  key: string;
  grabX: number;
  grabY: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  active: boolean;
  /** auto layout: insert relative to this item */
  target: { key: string; before: boolean } | null;
  /** free layout: proposed row + x (px at scale 1) */
  slot: { row: string; x: number } | null;
  /** floating decoration position (px at scale 1) */
  float: { x: number; y: number } | null;
}

export default function ShelfView({ novels, filtered, onOpen, onChanged }: Props) {
  const [prefs, setPrefs] = useState<ShelfPrefs>(loadShelfPrefs);
  const [assets, setAssets] = useState<ShelfAsset[]>([]);
  const [editing, setEditing] = useState(false);
  const [customizing, setCustomizing] = useState<LibraryNovel | null>(null);
  const [decoPanel, setDecoPanel] = useState<string | null>(null);
  const [themeEditor, setThemeEditor] = useState<string | "new" | null>(null);
  const [width, setWidth] = useState(0);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [error, setError] = useState("");
  const dragRef = useRef<Drag | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const caseRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  const s = prefs.scale;
  const amap = useMemo(() => assetMap(assets), [assets]);
  const theme = resolveTheme(prefs, amap);
  const rowH = Math.round(ROW_H * s);
  const innerW = Math.max(120, width - SIDE * 2 - 8);
  const free = prefs.layout === "free" && !filtered;

  const update = (patch: Partial<ShelfPrefs> | ((p: ShelfPrefs) => Partial<ShelfPrefs>)) =>
    setPrefs((p) => {
      const next = { ...p, ...(typeof patch === "function" ? patch(p) : patch) };
      saveShelfPrefs(next);
      return next;
    });

  const reloadAssets = () =>
    fetchShelfAssets()
      .then(setAssets)
      .catch((e) => logError("shelf", e));

  useEffect(() => {
    void reloadAssets();
  }, []);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const byId = useMemo(() => new Map(novels.map((n) => [n.id, n])), [novels]);
  const decoById = useMemo(() => new Map(prefs.decorations.map((d) => [d.id, d])), [prefs.decorations]);

  /** Shelf footprint of an item at the current scale. */
  function widthOf(key: string): number {
    if (key.startsWith("d:")) {
      const d = decoById.get(key.slice(2));
      return d ? decoSize(d, s).w + GAP * 2 : 0;
    }
    const n = byId.get(Number(key.slice(2)));
    if (!n) return 0;
    if (n.shelf_mode === "front") return frontWidth(s) + GAP * 3;
    if (n.shelf_mode === "stack") return slabWidth(n, s) + GAP * 4;
    return bookSize(n, s).thickness + GAP;
  }

  const isStack = (key: string) => key.startsWith("n:") && byId.get(Number(key.slice(2)))?.shelf_mode === "stack";

  // ---- auto layout: greedy packing of the ordered keys ----
  function autoRows(keys: string[]): RenderRow[] {
    const rows: { id: string; items: { key: string; x: number }[] }[] = [];
    let row: { key: string; x: number }[] = [];
    let used = 0;
    let pile = 0;
    for (const key of keys) {
      const w = widthOf(key);
      if (!w) continue;
      // Consecutive stacked books share one pile footprint.
      const prev = row[row.length - 1];
      if (prev && isStack(key) && isStack(prev.key) && pile < MAX_PILE) {
        row.push({ key, x: prev.x });
        used = Math.max(used, prev.x + w);
        pile++;
        continue;
      }
      pile = 1;
      if (row.length && used + w > innerW) {
        rows.push({ id: `auto${rows.length}`, items: row });
        row = [];
        used = 0;
      }
      row.push({ key, x: used });
      used += w;
    }
    if (row.length || rows.length === 0) rows.push({ id: `auto${rows.length}`, items: row });
    return rows.map((r) => ({ id: r.id, items: place(r.items) }));
  }

  /** Turn keyed positions (scaled px) into renderable items, merging stacked books into piles. */
  function place(items: { key: string; x: number }[]): Placed[] {
    const out: Placed[] = [];
    const sorted = [...items].sort((a, b) => a.x - b.x);
    for (const { key, x } of sorted) {
      const w = widthOf(key);
      if (!w) continue;
      if (key.startsWith("d:")) {
        out.push({ kind: "deco", key, d: decoById.get(key.slice(2))!, x, w });
        continue;
      }
      const n = byId.get(Number(key.slice(2)))!;
      if (n.shelf_mode === "stack") {
        const pile = out.find(
          (p): p is Extract<Placed, { kind: "pile" }> =>
            p.kind === "pile" && Math.abs(p.x - x) <= PILE_SNAP && p.books.length < MAX_PILE,
        );
        if (pile) {
          pile.books.push(n);
          pile.w = Math.max(pile.w, w);
          continue;
        }
        out.push({ kind: "pile", key, books: [n], x, w });
        continue;
      }
      out.push({ kind: "book", key, n, x, w });
    }
    return out;
  }

  // ---- free layout: saved rows, with anything new appended ----
  function normalizedRows(p: ShelfPrefs): FreeRow[] {
    const valid = (k: string) =>
      k.startsWith("n:") ? byId.has(Number(k.slice(2))) : !!decoById.get(k.slice(2)) && !decoById.get(k.slice(2))!.float;
    let rows: FreeRow[] = p.rows.map((r) => ({ id: r.id, items: r.items.filter((i) => valid(i.key)) }));
    if (rows.length === 0) {
      rows = autoRows(orderedKeys(p, novels, true)).map((r) => ({
        id: newId(),
        items: r.items.flatMap((it) =>
          it.kind === "pile" ? it.books.map((b) => ({ key: `n:${b.id}`, x: it.x / s })) : [{ key: it.key, x: it.x / s }],
        ),
      }));
    }
    const placed = new Set(rows.flatMap((r) => r.items.map((i) => i.key)));
    const missing = [
      ...novels.map((n) => `n:${n.id}`),
      ...p.decorations.filter((d) => !d.float).map((d) => `d:${d.id}`),
    ].filter((k) => !placed.has(k));
    for (const key of missing) {
      const w = widthOf(key) / s;
      let last = rows[rows.length - 1];
      const right = last ? Math.max(0, ...last.items.map((i) => i.x + widthOf(i.key) / s)) : 0;
      if (!last || right + w > innerW / s) {
        last = { id: newId(), items: [] };
        rows.push(last);
        last.items.push({ key, x: 0 });
      } else {
        last.items.push({ key, x: right });
      }
    }
    return rows;
  }

  const keys = useMemo(
    () => (filtered ? novels.map((n) => `n:${n.id}`) : orderedKeys(prefs, novels, true)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [prefs, novels, filtered],
  );

  const freeRows = useMemo(
    () => (free ? normalizedRows(prefs) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [free, prefs, novels, width, s],
  );

  const rows: RenderRow[] = useMemo(() => {
    if (!free) return autoRows(keys);
    // Live preview: show the dragged item at its proposed slot.
    const d = drag?.active ? drag : null;
    return freeRows.map((r) => {
      let items = r.items.filter((i) => !(d?.slot && i.key === d.key));
      if (d?.slot && d.slot.row === r.id) items = [...items, { key: d.key, x: d.slot.x }];
      return { id: r.id, items: place(items.map((i) => ({ key: i.key, x: i.x * s }))) };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [free, keys, freeRows, drag, width, s, byId, decoById]);

  const contentW = Math.max(innerW, ...rows.map((r) => Math.max(0, ...r.items.map((i) => i.x + i.w))));
  const floats = prefs.decorations.filter((d) => d.float && !filtered);
  const minFloatTop = Math.min(0, ...floats.map((d) => (dragFloat(d)?.y ?? d.float!.y) * s));
  const topPad = Math.max(editing && !filtered ? Math.round(150 * s) : 0, -minFloatTop);

  function dragFloat(d: Decoration) {
    return drag?.active && drag.key === `d:${d.id}` ? drag.float : null;
  }

  // ---- mutations ----
  function moveAuto(from: string, to: string, before: boolean) {
    if (from === to) return;
    const list = keys.filter((k) => k !== from);
    const at = list.indexOf(to);
    list.splice(before ? at : at + 1, 0, from);
    update({ order: list });
  }

  /** Keep a dropped item from overlapping its neighbors when there's room nearby. */
  function resolveX(row: FreeRow, key: string, x: number): number {
    const w = widthOf(key) / s;
    const stack = isStack(key);
    const others = row.items.filter((i) => i.key !== key).map((i) => ({ ...i, w: widthOf(i.key) / s }));
    if (stack) {
      const pile = others.find((o) => isStack(o.key) && Math.abs(o.x - x) <= PILE_SNAP / s + 10);
      if (pile) return pile.x;
    }
    const clear = (cx: number) => others.every((o) => cx + w <= o.x + 0.5 || cx >= o.x + o.w - 0.5);
    if (clear(x)) return Math.max(0, x);
    const candidates = others
      .flatMap((o) => [o.x + o.w, o.x - w])
      .filter((c) => c >= 0 && clear(c))
      .sort((a, b) => Math.abs(a - x) - Math.abs(b - x));
    return candidates[0] ?? Math.max(0, x);
  }

  function dropFree(key: string, rowId: string, x: number) {
    const rows2 = freeRows.map((r) => ({ id: r.id, items: r.items.filter((i) => i.key !== key) }));
    const row = rows2.find((r) => r.id === rowId);
    if (!row) return;
    row.items.push({ key, x: resolveX(row, key, x) });
    update({ rows: rows2 });
  }

  function setDeco(id: string, patch: Partial<Decoration>) {
    update((p) => ({ decorations: p.decorations.map((d) => (d.id === id ? { ...d, ...patch } : d)) }));
  }

  function removeDeco(id: string) {
    update((p) => ({
      decorations: p.decorations.filter((d) => d.id !== id),
      order: p.order.filter((k) => k !== `d:${id}`),
      rows: p.rows.map((r) => ({ ...r, items: r.items.filter((i) => i.key !== `d:${id}`) })),
    }));
    setDecoPanel(null);
  }

  /** Detach a decoration to float at its current on-screen spot, or put it back on a shelf. */
  function toggleFloat(d: Decoration) {
    if (d.float) {
      setDeco(d.id, { float: undefined });
      return;
    }
    const el = caseRef.current?.querySelector(`[data-shelf-key="d:${d.id}"]`);
    const c = caseRef.current?.getBoundingClientRect();
    const r = el?.getBoundingClientRect();
    const pos = r && c ? { x: (r.left - c.left) / s, y: (r.top - c.top) / s } : { x: 20, y: -100 };
    update((p) => ({
      decorations: p.decorations.map((x) => (x.id === d.id ? { ...x, float: pos } : x)),
      rows: p.rows.map((row) => ({ ...row, items: row.items.filter((i) => i.key !== `d:${d.id}`) })),
    }));
  }

  function addDecoration(type: BuiltinDecoration) {
    update((p) => ({ decorations: [...p.decorations, { id: newId(), type }] }));
  }

  function addSavedDecoration(a: ShelfAsset) {
    const { w, h } = parseSize(a.name);
    update((p) => ({ decorations: [...p.decorations, { id: newId(), type: "custom", assetId: a.id, w, h }] }));
  }

  async function addCustomDecoration() {
    setError("");
    try {
      const src = await pickImage("Choose a decoration image (PNG with transparency works best)");
      if (!src) return;
      const img = await downscale(src, 500, 500, "png");
      URL.revokeObjectURL(src);
      const k = Math.min(1, 120 / img.h);
      const w = Math.round(img.w * k);
      const h = Math.round(img.h * k);
      const id = newId();
      await addShelfAsset({ id, kind: "decoration", name: `${w}x${h}`, data: img.data });
      await reloadAssets();
      update((p) => ({ decorations: [...p.decorations, { id: newId(), type: "custom", assetId: id, w, h }] }));
    } catch (e) {
      logError("shelf", e);
      setError(`Could not add image: ${e}`);
    }
  }

  async function forgetSavedDecoration(a: ShelfAsset) {
    if (!window.confirm("Delete this saved decoration image? Copies on the shelf are removed too.")) return;
    update((p) => ({ decorations: p.decorations.filter((d) => d.assetId !== a.id) }));
    await deleteShelfAssets([a.id]);
    await reloadAssets();
  }

  function moveRow(id: string, dir: -1 | 1) {
    const list = [...freeRows];
    const i = list.findIndex((r) => r.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    update({ rows: list });
  }

  function removeRow(id: string) {
    const row = freeRows.find((r) => r.id === id);
    if (row?.items.length && !window.confirm("Remove this shelf? Its books move to the end of the bookcase.")) return;
    update({ rows: freeRows.filter((r) => r.id !== id) });
  }

  function setLayout(layout: "auto" | "free") {
    if (layout === prefs.layout) return;
    if (layout === "free" && prefs.rows.length === 0) {
      update({ layout, rows: normalizedRows({ ...prefs, rows: [] }) });
    } else update({ layout });
  }

  // ---- pointer drag (mouse + touch) ----
  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const active = d.active || Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > 6;
      const next: Drag = { ...d, x: e.clientX, y: e.clientY, active };
      if (active) {
        const deco = d.key.startsWith("d:") ? decoById.get(d.key.slice(2)) : undefined;
        if (deco?.float) {
          const c = caseRef.current!.getBoundingClientRect();
          next.float = { x: (e.clientX - c.left - d.grabX) / s, y: (e.clientY - c.top - d.grabY) / s };
        } else if (free) {
          let best: { id: string; dist: number; left: number } | null = null;
          for (const [id, el] of rowRefs.current) {
            const r = el.getBoundingClientRect();
            const dist = e.clientY < r.top ? r.top - e.clientY : e.clientY > r.bottom ? e.clientY - r.bottom : 0;
            if (!best || dist < best.dist) best = { id, dist, left: r.left };
          }
          if (best) next.slot = { row: best.id, x: Math.max(0, (e.clientX - best.left - d.grabX) / s) };
        } else {
          const el = document
            .elementsFromPoint(e.clientX, e.clientY)
            .map((x) => (x as HTMLElement).closest?.("[data-shelf-key]") as HTMLElement | null)
            .find((x) => x && x.dataset.shelfKey !== d.key);
          next.target = null;
          if (el) {
            const r = el.getBoundingClientRect();
            const slab = el.dataset.slab === "1";
            next.target = {
              key: el.dataset.shelfKey!,
              before: slab ? e.clientY < r.top + r.height / 2 : e.clientX < r.left + r.width / 2,
            };
          }
        }
      }
      dragRef.current = next;
      setDrag(next);
    };
    const onUp = () => {
      const d = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!d) return;
      if (!d.active) {
        if (d.key.startsWith("n:")) {
          const n = byId.get(Number(d.key.slice(2)));
          if (n) setCustomizing(n);
        } else setDecoPanel(d.key.slice(2));
        return;
      }
      if (d.float) setDeco(d.key.slice(2), { float: d.float });
      else if (d.slot) dropFree(d.key, d.slot.row, d.slot.x);
      else if (d.target) moveAuto(d.key, d.target.key, d.target.before);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag !== null]);

  function handlers(key: string, novelId?: number) {
    return {
      "data-shelf-key": key,
      onPointerDown: (e: React.PointerEvent) => {
        if (!editing || e.button !== 0) return;
        if (filtered) return;
        e.preventDefault();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const d: Drag = {
          key,
          grabX: e.clientX - r.left,
          grabY: e.clientY - r.top,
          startX: e.clientX,
          startY: e.clientY,
          x: e.clientX,
          y: e.clientY,
          active: false,
          target: null,
          slot: null,
          float: null,
        };
        dragRef.current = d;
        setDrag(d);
      },
      onClick: () => {
        if (novelId == null) return;
        if (!editing) onOpen(novelId);
        else if (filtered) setCustomizing(byId.get(novelId) ?? null);
      },
      onContextMenu: (e: React.MouseEvent) => {
        if (novelId == null) return;
        e.preventDefault();
        setCustomizing(byId.get(novelId) ?? null);
      },
    };
  }

  const indicator = (key: string, slab = false) =>
    drag?.active && !free && drag.target?.key === key ? (
      <div
        className={`pointer-events-none absolute z-10 bg-orange-500 ${
          slab
            ? `inset-x-0 h-1 ${drag.target.before ? "-top-1" : "-bottom-1"}`
            : `inset-y-0 w-1 ${drag.target.before ? "-left-1" : "-right-1"}`
        }`}
      />
    ) : null;

  const dragging = (key: string) => drag?.active && drag.key === key;
  const dim = (key: string) => (dragging(key) ? (free ? "opacity-70 z-20" : "opacity-30") : "");
  const grab = editing && !filtered ? "cursor-grab touch-none" : "";

  const savedDecos = assets.filter((a) => a.kind === "decoration");
  const select = "rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs";
  const panelDeco = decoPanel ? decoById.get(decoPanel) : undefined;

  function renderItem(it: Placed) {
    const style = { left: it.x, bottom: 0 } as const;
    if (it.kind === "deco")
      return (
        <div key={it.key} {...handlers(it.key)} className={`absolute ${grab} ${dim(it.key)}`} style={{ ...style, paddingLeft: GAP }}>
          {indicator(it.key)}
          <DecorationArt deco={it.d} scale={s} assets={amap} />
        </div>
      );
    if (it.kind === "pile")
      return (
        <div key={it.key} className="absolute flex flex-col-reverse items-center" style={{ ...style, width: it.w }}>
          {it.books.map((n, i) => (
            <div
              key={n.id}
              {...handlers(`n:${n.id}`, n.id)}
              data-slab="1"
              className={`relative cursor-pointer ${grab} ${dim(`n:${n.id}`)}`}
              style={{ marginLeft: ((n.id * 7) % 9) - 4 + (i % 2 ? 3 : -3) }}
            >
              {indicator(`n:${n.id}`, true)}
              <Slab n={n} scale={s} width={slabWidth(n, s)} />
            </div>
          ))}
        </div>
      );
    const front = it.n.shelf_mode === "front";
    return (
      <div
        key={it.key}
        {...handlers(it.key, it.n.id)}
        className={`absolute cursor-pointer transition-transform ${editing ? grab : "hover:-translate-y-1"} ${dim(it.key)}`}
        style={{ ...style, paddingLeft: front ? GAP : 0 }}
      >
        {indicator(it.key)}
        {front ? <Front n={it.n} scale={s} /> : <Spine n={it.n} scale={s} />}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {editing ? (
          <>
            <select
              value={prefs.style}
              onChange={(e) =>
                e.target.value === "__new" ? setThemeEditor("new") : update({ style: e.target.value })
              }
              className={select}
            >
              {Object.entries(SHELF_STYLES).map(([k, v]) => (
                <option key={k} value={k}>{v.label}</option>
              ))}
              {prefs.themes.map((t) => (
                <option key={t.id} value={`custom:${t.id}`}>{t.name}</option>
              ))}
              <option value="__new">Custom look from images…</option>
            </select>
            {prefs.style.startsWith("custom:") ? (
              <button onClick={() => setThemeEditor(prefs.style.slice(7))} className={select}>
                Edit look
              </button>
            ) : (
              <select value={prefs.wall} onChange={(e) => update({ wall: e.target.value as WallStyle })} className={select}>
                {Object.entries(WALL_STYLES).map(([k, v]) => (
                  <option key={k} value={k}>{v.label}</option>
                ))}
              </select>
            )}
            <select value={s} onChange={(e) => update({ scale: Number(e.target.value) })} className={select}>
              <option value={0.75}>Small books</option>
              <option value={1}>Medium books</option>
              <option value={1.2}>Large books</option>
            </select>
            <select value={prefs.layout} onChange={(e) => setLayout(e.target.value as "auto" | "free")} className={select}>
              <option value="auto">Auto arrange</option>
              <option value="free">Free arrangement</option>
            </select>
            <select
              value=""
              disabled={filtered}
              onChange={(e) => {
                const v = e.target.value;
                if (v === "__custom") void addCustomDecoration();
                else if (v.startsWith("asset:")) {
                  const a = savedDecos.find((x) => x.id === v.slice(6));
                  if (a) addSavedDecoration(a);
                } else if (v) addDecoration(v as BuiltinDecoration);
              }}
              className={select}
            >
              <option value="">Add decoration…</option>
              {Object.entries(DECORATION_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
              {savedDecos.map((a, i) => (
                <option key={a.id} value={`asset:${a.id}`}>My image {i + 1}</option>
              ))}
              <option value="__custom">From an image…</option>
            </select>
            {free && (
              <>
                <button
                  onClick={() => update({ rows: [...freeRows, { id: newId(), items: [] }] })}
                  className={select}
                >
                  Add shelf
                </button>
                <button
                  onClick={() => {
                    if (window.confirm("Re-pack everything onto shelves automatically?"))
                      update({ rows: normalizedRows({ ...prefs, rows: [] }) });
                  }}
                  className={select}
                >
                  Tidy up
                </button>
              </>
            )}
            <button
              onClick={() => setEditing(false)}
              className="ml-auto rounded-md bg-orange-600 px-3 py-1.5 text-xs font-medium hover:bg-orange-500"
            >
              Done
            </button>
          </>
        ) : (
          <button onClick={() => setEditing(true)} className="rounded-md bg-zinc-800 px-3 py-1.5 text-xs hover:bg-zinc-700">
            Edit shelf
          </button>
        )}
      </div>
      {editing && (
        <p className="text-xs text-zinc-500">
          {filtered
            ? "Clear the search or collection filter to rearrange. Tap a book to change its look."
            : free
              ? "Drag books and decorations anywhere on any shelf. Tap a decoration to resize it or let it go anywhere (on top, over the sides). Tap a book to change its look."
              : "Drag to reorder. Tap a book to change its look; tap a decoration to resize or place it anywhere. Switch to Free arrangement for empty shelves and exact positions."}
        </p>
      )}
      {savedDecos.length > 0 && editing && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
          My decoration images:
          {savedDecos.map((a, i) => (
            <span key={a.id} className="flex items-center gap-1 rounded bg-zinc-800 py-0.5 pl-1 pr-0.5">
              <img src={a.data} alt="" className="h-5 w-5 object-contain" />
              {i + 1}
              <button onClick={() => forgetSavedDecoration(a)} className="px-1 hover:text-red-400" aria-label="Delete image">×</button>
            </span>
          ))}
        </div>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}

      <div
        ref={box}
        className={`select-none ${contentW > innerW + 1 ? "overflow-x-auto" : ""}`}
        style={{ paddingTop: topPad }}
      >
        <div
          ref={caseRef}
          className="relative rounded-lg"
          style={{ background: theme.side, padding: `${SIDE}px ${SIDE}px ${SIDE / 2}px`, width: contentW + SIDE * 2 + 8, minWidth: "100%" }}
        >
          <div className="overflow-hidden rounded-sm" style={{ background: theme.wall }}>
            {rows.map((row, ri) => (
              <div key={row.id} className="group/row relative">
                <div
                  ref={(el) => {
                    if (el) rowRefs.current.set(row.id, el);
                    else rowRefs.current.delete(row.id);
                  }}
                  className="relative mx-1 shadow-[inset_0_10px_14px_-8px_rgba(0,0,0,0.6)]"
                  style={{ height: rowH }}
                >
                  {row.items.map(renderItem)}
                  {free && editing && (
                    <div className="absolute right-1 top-1 z-30 flex gap-1 opacity-80">
                      <button onClick={() => moveRow(row.id, -1)} disabled={ri === 0} className="rounded bg-zinc-900/80 p-1 disabled:opacity-30" aria-label="Move shelf up">
                        <ChevronUpIcon width={14} height={14} />
                      </button>
                      <button onClick={() => moveRow(row.id, 1)} disabled={ri === rows.length - 1} className="rounded bg-zinc-900/80 p-1 disabled:opacity-30" aria-label="Move shelf down">
                        <ChevronDownIcon width={14} height={14} />
                      </button>
                      <button onClick={() => removeRow(row.id)} className="rounded bg-zinc-900/80 p-1 hover:text-red-400" aria-label="Remove shelf">
                        <CloseIcon width={14} height={14} />
                      </button>
                    </div>
                  )}
                </div>
                <div className="relative h-3.5 shadow-[0_6px_8px_rgba(0,0,0,0.55)]" style={{ background: theme.plank, borderBottom: `3px solid ${theme.edge}` }} />
              </div>
            ))}
          </div>

          {/* Free-floating decorations, positioned against the whole bookcase. */}
          {floats.map((d) => {
            const pos = dragFloat(d) ?? d.float!;
            return (
              <div
                key={d.id}
                {...handlers(`d:${d.id}`)}
                className={`absolute z-20 ${grab} ${editing ? "outline-dashed outline-1 outline-orange-500/40" : ""}`}
                style={{ left: pos.x * s, top: pos.y * s }}
              >
                <DecorationArt deco={d} scale={s} assets={amap} />
              </div>
            );
          })}
        </div>
      </div>

      {drag?.active && !free && !drag.float && (
        <div
          className="pointer-events-none fixed z-50 rounded bg-orange-500/80 px-2 py-1 text-xs font-medium text-white shadow-lg"
          style={{ left: drag.x + 12, top: drag.y + 12 }}
        >
          {drag.key.startsWith("n:") ? byId.get(Number(drag.key.slice(2)))?.title : "Decoration"}
        </div>
      )}

      {panelDeco && (
        <div className="fixed inset-x-0 bottom-0 z-50 flex justify-center p-3" onClick={() => setDecoPanel(null)}>
          <div
            className="w-full max-w-sm space-y-3 rounded-xl border border-zinc-700 bg-zinc-900 p-4 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center">
              <p className="mr-auto text-sm font-medium">
                {panelDeco.type === "custom" ? "Image decoration" : DECORATION_LABELS[panelDeco.type]}
              </p>
              <button onClick={() => setDecoPanel(null)} aria-label="Close" className="rounded p-1 text-zinc-400 hover:bg-zinc-800">
                <CloseIcon className="h-4 w-4" />
              </button>
            </div>
            <label className="flex items-center gap-3 text-xs text-zinc-400">
              Size
              <input
                type="range"
                min={0.4}
                max={2.5}
                step={0.05}
                value={panelDeco.size ?? 1}
                onChange={(e) => setDeco(panelDeco.id, { size: Number(e.target.value) })}
                className="flex-1 accent-orange-500"
              />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={!!panelDeco.float} onChange={() => toggleFloat(panelDeco)} />
              Place anywhere (on top of the bookcase, over the sides…)
            </label>
            <button onClick={() => removeDeco(panelDeco.id)} className="w-full rounded-md bg-zinc-800 px-3 py-2 text-sm text-red-400 hover:bg-zinc-700">
              Remove decoration
            </button>
          </div>
        </div>
      )}

      {themeEditor && (
        <ThemeEditor
          theme={themeEditor === "new" ? null : (prefs.themes.find((t) => t.id === themeEditor) ?? null)}
          assets={amap}
          onClose={() => setThemeEditor(null)}
          onSaved={async (t, added, removed) => {
            try {
              for (const a of added) await addShelfAsset(a);
              if (removed.length) await deleteShelfAssets(removed);
              await reloadAssets();
              update((p) => ({
                themes: p.themes.some((x) => x.id === t.id) ? p.themes.map((x) => (x.id === t.id ? t : x)) : [...p.themes, t],
                style: `custom:${t.id}`,
              }));
              setThemeEditor(null);
            } catch (e) {
              logError("shelf", e);
              setError(String(e));
            }
          }}
          onDelete={async (t) => {
            await deleteShelfAssets([t.wall, t.plank, t.side].filter((x): x is string => !!x));
            await reloadAssets();
            update((p) => ({
              themes: p.themes.filter((x) => x.id !== t.id),
              style: p.style === `custom:${t.id}` ? "oak" : p.style,
            }));
            setThemeEditor(null);
          }}
        />
      )}

      {customizing && (
        <BookCustomizer
          novel={customizing}
          onClose={() => setCustomizing(null)}
          onSaved={() => {
            setCustomizing(null);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function parseSize(name: string): { w: number; h: number } {
  const m = name.match(/^(\d+)x(\d+)$/);
  return m ? { w: Number(m[1]), h: Number(m[2]) } : { w: 80, h: 100 };
}
