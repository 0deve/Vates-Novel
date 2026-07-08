import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { readFile } from "@tauri-apps/plugin-fs";
import { getNovelDetails, importLocalNovel } from "../lib/api";
import {
  addImportedNovel,
  createCollection,
  deleteCollection,
  fetchAllNovelCollections,
  fetchCollections,
  fetchLibrary,
  mergeChapters,
  type Collection,
} from "../lib/db";
import { subscribeLibraryUpdates } from "../lib/updates";
import type { LibraryNovel } from "../types";

type SortBy = "recent" | "read" | "title" | "author" | "progress";

const SORT_LABELS: Record<SortBy, string> = {
  recent: "Recently Added",
  read: "Recently Read",
  title: "Title (A-Z)",
  author: "Author (A-Z)",
  progress: "Completion",
};

function completion(n: LibraryNovel): number {
  if (n.chapter_count <= 0 || n.last_read_chapter == null) return 0;
  return Math.min(1, n.last_read_chapter / n.chapter_count);
}

interface Props {
  onOpen: (novelId: number) => void;
}

export default function LibraryPage({ onOpen }: Props) {
  const [novels, setNovels] = useState<LibraryNovel[]>([]);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [collectionMap, setCollectionMap] = useState<Map<number, number[]>>(new Map());
  const [activeCollection, setActiveCollection] = useState<number | "all">("all");
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<SortBy>("recent");
  const [status, setStatus] = useState("Loading…");
  const [importing, setImporting] = useState(false);
  const [checkingUpdates, setCheckingUpdates] = useState(false);

  const reload = () =>
    Promise.all([fetchLibrary(), fetchCollections(), fetchAllNovelCollections()])
      .then(([n, c, m]) => {
        setNovels(n);
        setCollections(c);
        setCollectionMap(m);
        setStatus(n.length ? "" : "Library is empty — add novels from Browse.");
      })
      .catch((e) => setStatus(`Failed to load library: ${e}`));

  useEffect(() => {
    void reload();
    // Refresh badges if the background update check finds new chapters
    // while this screen is open.
    return subscribeLibraryUpdates(() => void reload());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function importNovel() {
    const path = await open({
      title: "Import a novel",
      filters: [{ name: "Novel files", extensions: ["epub", "txt"] }],
    });
    if (!path || Array.isArray(path)) return;
    setImporting(true);
    setStatus("Importing…");
    try {
      const bytes = await readFile(path);
      const fileName = path.replace(/\\/g, "/").split("/").pop() ?? "";
      const imported = await importLocalNovel(fileName, bytes);
      await addImportedNovel(imported);
      setStatus(`Imported "${imported.title}" (${imported.chapters.length} chapters).`);
      await reload();
    } catch (e) {
      setStatus(`Import failed: ${e}`);
    } finally {
      setImporting(false);
    }
  }

  async function checkAllForUpdates() {
    const targets = novels.filter((n) => n.source_id !== "local");
    if (targets.length === 0) return;
    setCheckingUpdates(true);
    let novelsWithNew = 0;
    let chaptersAdded = 0;
    for (let i = 0; i < targets.length; i++) {
      const n = targets[i];
      setStatus(`Checking for updates… (${i + 1}/${targets.length}) ${n.title}`);
      try {
        const details = await getNovelDetails(n.source_id, n.novel_url);
        const added = await mergeChapters(n.id, details);
        if (added > 0) {
          novelsWithNew++;
          chaptersAdded += added;
        }
      } catch {
        // Skip novels that fail (offline, rate-limited, site changed) —
        // the rest of the batch still gets checked.
      }
    }
    setStatus(
      novelsWithNew > 0
        ? `Found ${chaptersAdded} new chapter${chaptersAdded === 1 ? "" : "s"} across ${novelsWithNew} novel${novelsWithNew === 1 ? "" : "s"}.`
        : "No new chapters found — everything is up to date.",
    );
    setCheckingUpdates(false);
    await reload();
  }

  async function newCollection() {
    const name = window.prompt("New collection name:");
    if (!name || !name.trim()) return;
    await createCollection(name);
    await reload();
  }

  async function removeCollection(c: Collection) {
    if (!window.confirm(`Delete the collection "${c.name}"? Novels stay in your library.`))
      return;
    await deleteCollection(c.id);
    if (activeCollection === c.id) setActiveCollection("all");
    await reload();
  }

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = novels;
    if (activeCollection !== "all") {
      list = list.filter((n) => collectionMap.get(n.id)?.includes(activeCollection));
    }
    if (q) {
      list = list.filter(
        (n) =>
          n.title.toLowerCase().includes(q) ||
          (n.author ?? "").toLowerCase().includes(q),
      );
    }
    const sorted = [...list];
    switch (sortBy) {
      case "title":
        sorted.sort((a, b) => a.title.localeCompare(b.title));
        break;
      case "author":
        sorted.sort((a, b) => (a.author ?? "").localeCompare(b.author ?? ""));
        break;
      case "progress":
        sorted.sort((a, b) => completion(b) - completion(a));
        break;
      case "read":
        sorted.sort((a, b) => (b.last_read_at ?? "").localeCompare(a.last_read_at ?? ""));
        break;
      case "recent":
      default:
        sorted.sort((a, b) => b.added_at.localeCompare(a.added_at));
    }
    return sorted;
  }, [novels, activeCollection, collectionMap, search, sortBy]);

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xl font-semibold">Library</h2>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={checkAllForUpdates}
            disabled={checkingUpdates || novels.length === 0}
            className="rounded-md bg-zinc-800 px-3 py-1.5 text-sm hover:bg-zinc-700 disabled:opacity-50"
            title="Re-check every novel's source for new chapters"
          >
            {checkingUpdates ? "Checking…" : "Check Updates"}
          </button>
          <button
            onClick={importNovel}
            disabled={importing}
            className="rounded-md bg-zinc-800 px-3 py-1.5 text-sm hover:bg-zinc-700 disabled:opacity-50"
            title="Import a local .epub or .txt file"
          >
            {importing ? "Importing…" : "Import Novel"}
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search your library…"
          className="min-w-48 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm"
        />
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as SortBy)}
          className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm"
        >
          {Object.entries(SORT_LABELS).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <button
          onClick={() => setActiveCollection("all")}
          className={`rounded-full px-3 py-1.5 text-xs ${
            activeCollection === "all"
              ? "bg-orange-600 text-white"
              : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
          }`}
        >
          All
        </button>
        {collections.map((c) => (
          <span
            key={c.id}
            className={`flex items-center gap-1 rounded-full px-1 py-1 pl-3 text-xs ${
              activeCollection === c.id
                ? "bg-orange-600 text-white"
                : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"
            }`}
          >
            <button className="py-1" onClick={() => setActiveCollection(c.id)}>
              {c.name}
            </button>
            <button
              onClick={() => removeCollection(c)}
              className="rounded-full px-2 py-1 opacity-60 hover:opacity-100"
              title={`Delete "${c.name}"`}
            >
              ×
            </button>
          </span>
        ))}
        <button
          onClick={newCollection}
          className="rounded-full bg-zinc-800 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-700"
        >
          + New Collection
        </button>
      </div>

      {status && <p className="text-sm text-zinc-500">{status}</p>}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-4">
        {visible.map((n) => (
          <button
            key={n.id}
            onClick={() => onOpen(n.id)}
            className="flex flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900 text-left transition-colors hover:border-zinc-600"
          >
            <div className="relative flex aspect-[2/3] w-full items-center justify-center bg-zinc-800">
              {n.cover_url ? (
                <img
                  src={n.cover_url}
                  alt={n.title}
                  className="h-full w-full object-cover"
                />
              ) : (
                <span className="text-5xl font-bold text-zinc-600">
                  {n.title.charAt(0)}
                </span>
              )}
              {n.new_chapters_count > 0 && (
                <span className="absolute right-1.5 top-1.5 rounded-full bg-orange-600 px-2 py-0.5 text-[10px] font-semibold text-white shadow">
                  +{n.new_chapters_count} new
                </span>
              )}
            </div>
            <div className="w-full p-3">
              <div className="truncate text-sm font-medium" title={n.title}>
                {n.title}
              </div>
              <div className="truncate text-xs text-zinc-500">
                {n.author ?? "Unknown"} · {n.chapter_count} ch
              </div>
              {n.last_read_chapter != null && n.chapter_count > 0 && (
                <div className="mt-1.5">
                  <div className="flex items-center justify-between text-[10px] text-zinc-500">
                    <span>{Math.round(completion(n) * 100)}%</span>
                    <span className="tabular-nums">
                      {n.last_read_chapter}/{n.chapter_count}
                    </span>
                  </div>
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-zinc-800">
                    <div
                      className="h-full bg-orange-600"
                      style={{ width: `${Math.round(completion(n) * 100)}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
