// Novel Details screen: metadata, completion bar, chapter search, downloads
// (via the global download manager), per-chapter and bulk deletion.
import { useCallback, useEffect, useMemo, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import {
  exportNovel,
  getChapterContent,
  getNovelDetails,
  openDataFolder,
} from "../lib/api";
import {
  clearChapterContent,
  clearNewChaptersBadge,
  clearNovelDownloads,
  createCollection,
  fetchChapterMeta,
  fetchChaptersForExport,
  fetchCollections,
  fetchNovel,
  fetchNovelCollectionIds,
  getChapterRow,
  mergeChapters,
  removeNovel,
  saveChapterContent,
  setNovelCollection,
  type Collection,
} from "../lib/db";
import {
  getDownloadJob,
  startDownloadAll,
  subscribeDownloads,
} from "../lib/downloads";
import { useSyncExternalStore } from "react";
import type { ChapterMeta, NovelRow } from "../types";
import { CheckIcon, DownloadIcon } from "../components/icons";

interface Props {
  novelId: number;
  onBack: () => void;
  onRead: (chapterIdx: number | null, segment: number | null) => void;
}

export default function NovelPage({ novelId, onBack, onRead }: Props) {
  const [novel, setNovel] = useState<NovelRow | null>(null);
  const [chapters, setChapters] = useState<ChapterMeta[]>([]);
  const [asc, setAsc] = useState(true);
  const [filter, setFilter] = useState("");
  const [status, setStatus] = useState("");
  const [busyIdx, setBusyIdx] = useState<number | null>(null);
  const [summaryExpanded, setSummaryExpanded] = useState(false);
  const [visibleCount, setVisibleCount] = useState(100);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [myCollections, setMyCollections] = useState<number[]>([]);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    setVisibleCount(100);
  }, [filter, asc, novelId]);

  const job = useSyncExternalStore(subscribeDownloads, getDownloadJob);
  const batchBusy =
    job?.novelId === novelId &&
    (job.state === "running" || job.state === "retrying");

  const reload = useCallback(async () => {
    const [n, ch, cols, myCols] = await Promise.all([
      fetchNovel(novelId),
      fetchChapterMeta(novelId),
      fetchCollections(),
      fetchNovelCollectionIds(novelId),
    ]);
    setNovel(n);
    setChapters(ch);
    setCollections(cols);
    setMyCollections(myCols);
  }, [novelId]);

  useEffect(() => {
    reload().catch((e) => setStatus(String(e)));
  }, [reload]);

  // Viewing the novel acknowledges any newly-discovered chapters.
  useEffect(() => {
    if (novel && novel.new_chapters_count > 0) void clearNewChaptersBadge(novelId);
  }, [novel, novelId]);

  // Refresh the chapter list when a batch download for this novel finishes.
  useEffect(() => {
    if (job && job.novelId === novelId && job.state === "done") {
      void reload();
    }
  }, [job, novelId, reload]);

  async function downloadOne(m: ChapterMeta) {
    if (!novel) return;
    setBusyIdx(m.idx);
    try {
      const row = await getChapterRow(novelId, m.idx);
      if (row && !row.content) {
        const cc = await getChapterContent(novel.source_id, row.chapter_url);
        await saveChapterContent(row.id, cc.html, cc.title);
      }
      await reload();
    } catch (e) {
      setStatus(`Download failed: ${e}`);
    } finally {
      setBusyIdx(null);
    }
  }

  async function deleteOne(m: ChapterMeta) {
    await clearChapterContent(m.id);
    await reload();
  }

  async function clearDownloads() {
    if (!window.confirm("Delete all downloaded chapters of this novel?")) return;
    await clearNovelDownloads(novelId);
    setStatus("Downloaded chapters deleted.");
    await reload();
  }

  async function removeFromLibrary() {
    if (
      !window.confirm(
        "Remove this novel from the library? This also deletes all downloaded chapters and reading progress.",
      )
    )
      return;
    await removeNovel(novelId);
    onBack();
  }

  async function toggleCollection(c: Collection) {
    const member = myCollections.includes(c.id);
    await setNovelCollection(novelId, c.id, !member);
    setMyCollections((prev) =>
      member ? prev.filter((id) => id !== c.id) : [...prev, c.id],
    );
  }

  async function addNewCollection() {
    const name = window.prompt("New collection name:");
    if (!name || !name.trim()) return;
    const id = await createCollection(name);
    await setNovelCollection(novelId, id, true);
    const cols = await fetchCollections();
    setCollections(cols);
    setMyCollections((prev) => [...prev, id]);
  }

  async function exportBook() {
    if (!novel) return;
    const safeName = novel.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60);
    const path = await save({
      title: "Export novel",
      defaultPath: `${safeName || "novel"}.epub`,
      filters: [
        { name: "EPUB", extensions: ["epub"] },
        { name: "Plain text", extensions: ["txt"] },
      ],
    });
    if (!path) return;
    setExporting(true);
    setStatus("Exporting…");
    try {
      const forExport = await fetchChaptersForExport(novelId);
      if (forExport.length === 0) {
        setStatus("No downloaded chapters to export — download some first.");
        return;
      }
      await exportNovel(path, novel.title, novel.author, forExport);
      setStatus(
        forExport.length < chapters.length
          ? `Exported ${forExport.length} of ${chapters.length} chapters (only downloaded ones) to ${path}.`
          : `Exported all ${forExport.length} chapters to ${path}.`,
      );
    } catch (e) {
      setStatus(`Export failed: ${e}`);
    } finally {
      setExporting(false);
    }
  }

  async function openFolder() {
    try {
      await openDataFolder();
    } catch (e) {
      setStatus(`Could not open folder: ${e}`);
    }
  }

  /** Re-fetch the novel's chapter list from its source and add any new ones. */
  async function checkForNewChapters() {
    if (!novel) return;
    setStatus("Checking for new chapters…");
    try {
      const details = await getNovelDetails(novel.source_id, novel.novel_url);
      const added = await mergeChapters(novelId, details);
      setStatus(
        added
          ? `${added} new chapter${added === 1 ? "" : "s"} found.`
          : "No new chapters — you're up to date.",
      );
      await reload();
    } catch (e) {
      setStatus(`Check for new chapters failed: ${e}`);
    }
  }

  const sorted = useMemo(() => {
    const f = filter.trim().toLowerCase();
    let list = chapters;
    if (f) {
      list = chapters.filter(
        (c) => c.title.toLowerCase().includes(f) || String(c.idx) === f,
      );
    }
    return asc ? list : [...list].reverse();
  }, [chapters, filter, asc]);

  if (!novel)
    return <p className="text-sm text-zinc-500">{status || "Loading…"}</p>;

  const downloadedCount = chapters.filter((c) => c.downloaded).length;
  const readOrdinal = chapters.findIndex(
    (c) => c.idx === novel.last_read_chapter,
  );
  const progressPct =
    chapters.length > 0 && readOrdinal >= 0
      ? Math.round(((readOrdinal + 1) / chapters.length) * 100)
      : 0;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <button onClick={onBack} className="text-sm text-zinc-400 hover:text-white">
        Back to Library
      </button>

      <div className="flex gap-5">
        <div className="flex h-48 w-32 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-zinc-800">
          {novel.cover_url ? (
            <img
              src={novel.cover_url}
              alt={novel.title}
              className="h-full w-full object-cover"
            />
          ) : (
            <span className="text-5xl font-bold text-zinc-600">
              {novel.title.charAt(0)}
            </span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-semibold">{novel.title}</h2>
          <p className="text-sm text-zinc-400">
            {novel.author ?? "Unknown"} · {novel.status ?? "?"} ·{" "}
            {chapters.length} chapters ({downloadedCount} downloaded)
          </p>

          {/* Completion */}
          <div className="mt-2 flex items-center gap-3">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-800">
              <div
                className="h-full bg-orange-600 transition-all"
                style={{ width: `${progressPct}%` }}
              />
            </div>
            <span className="shrink-0 text-xs tabular-nums text-zinc-400">
              {progressPct}%
            </span>
          </div>

          {/* Collections */}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {collections.map((c) => {
              const member = myCollections.includes(c.id);
              return (
                <button
                  key={c.id}
                  onClick={() => toggleCollection(c)}
                  className={`rounded-full px-3 py-1 text-xs ${
                    member
                      ? "bg-orange-600 text-white"
                      : "bg-zinc-800 text-zinc-500 hover:bg-zinc-700"
                  }`}
                >
                  {c.name}
                </button>
              );
            })}
            <button
              onClick={addNewCollection}
              className="rounded-full bg-zinc-800 px-3 py-1 text-xs text-zinc-500 hover:bg-zinc-700"
            >
              + New Collection
            </button>
          </div>

          {novel.summary && (
            <div className="mt-2">
              <p
                className={`text-sm text-zinc-500 ${
                  summaryExpanded ? "" : "line-clamp-3"
                }`}
              >
                {novel.summary}
              </p>
              {novel.summary.length > 200 && (
                <button
                  onClick={() => setSummaryExpanded((v) => !v)}
                  className="mt-1 text-xs font-medium text-orange-400 hover:text-orange-300"
                >
                  {summaryExpanded ? "Show less" : "Read more"}
                </button>
              )}
            </div>
          )}

          <div className="mt-4 space-y-2">
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() =>
                  onRead(novel.last_read_chapter, novel.last_read_segment)
                }
                className="rounded-md bg-orange-600 px-4 py-2 text-sm font-medium hover:bg-orange-500"
              >
                {novel.last_read_chapter != null
                  ? "Continue Reading"
                  : "Start Reading"}
              </button>
              {novel.source_id !== "local" && (
                <>
                  <button
                    onClick={checkForNewChapters}
                    className="rounded-md bg-zinc-800 px-4 py-2 text-sm hover:bg-zinc-700"
                    title="Re-fetch the chapter list from the source and add any new chapters"
                  >
                    Check for New Chapters
                  </button>
                  <button
                    onClick={() => {
                      void startDownloadAll(novel, chapters).then((ok) => {
                        if (!ok) setStatus("Another download is already running.");
                      });
                    }}
                    disabled={batchBusy || downloadedCount === chapters.length}
                    className="rounded-md bg-zinc-800 px-4 py-2 text-sm hover:bg-zinc-700 disabled:opacity-50"
                  >
                    {batchBusy ? "Downloading…" : "Download All"}
                  </button>
                </>
              )}
              <button
                onClick={openFolder}
                className="rounded-md bg-zinc-800 px-4 py-2 text-sm hover:bg-zinc-700"
                title="Open the folder containing the app's database"
              >
                Open Data Folder
              </button>
              <button
                onClick={exportBook}
                disabled={exporting || downloadedCount === 0}
                className="rounded-md bg-zinc-800 px-4 py-2 text-sm hover:bg-zinc-700 disabled:opacity-50"
                title="Export downloaded chapters to an .epub or .txt file"
              >
                {exporting ? "Exporting…" : "Export Novel"}
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={clearDownloads}
                disabled={batchBusy || downloadedCount === 0}
                className="rounded-md bg-zinc-800 px-4 py-2 text-sm text-red-400 hover:bg-zinc-700 disabled:opacity-50"
              >
                Delete Downloads
              </button>
              <button
                onClick={removeFromLibrary}
                disabled={batchBusy}
                className="rounded-md bg-zinc-800 px-4 py-2 text-sm text-red-400 hover:bg-zinc-700 disabled:opacity-50"
              >
                Remove from Library
              </button>
            </div>
          </div>
        </div>
      </div>

      {status && <p className="text-sm text-zinc-500">{status}</p>}

      <div>
        <div className="mb-2 flex items-center gap-2">
          <h3 className="font-medium">Chapters</h3>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Jump to chapter (number or title)…"
            className="ml-2 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-sm"
          />
          <button
            onClick={() => setAsc((a) => !a)}
            className="rounded px-2 py-1 text-sm text-zinc-400 hover:bg-zinc-800"
          >
            {asc ? "Ascending" : "Descending"}
          </button>
        </div>
        <ul className="divide-y divide-zinc-800/60 rounded-lg border border-zinc-800">
          {sorted.slice(0, visibleCount).map((c) => (
            <li
              key={c.id}
              className="flex items-center gap-2 px-3 py-2 hover:bg-zinc-900"
            >
              <button
                onClick={() => onRead(c.idx, 0)}
                className="min-w-0 flex-1 truncate text-left text-sm"
              >
                {c.title}
                {novel.last_read_chapter === c.idx && (
                  <span className="ml-2 text-xs text-orange-400">reading</span>
                )}
              </button>
              {c.downloaded ? (
                <>
                  <span className="text-emerald-500" title="Downloaded">
                    <CheckIcon width={14} height={14} />
                  </span>
                  <button
                    onClick={() => deleteOne(c)}
                    className="rounded px-1.5 py-0.5 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-red-400"
                    title="Delete downloaded content"
                  >
                    Delete
                  </button>
                </>
              ) : (
                <button
                  onClick={() => downloadOne(c)}
                  disabled={busyIdx === c.idx || batchBusy}
                  className="rounded p-1 text-zinc-400 hover:bg-zinc-800 disabled:opacity-50"
                  title="Download chapter"
                >
                  {busyIdx === c.idx ? (
                    <span className="text-xs">…</span>
                  ) : (
                    <DownloadIcon width={14} height={14} />
                  )}
                </button>
              )}
            </li>
          ))}
        </ul>
        {sorted.length > visibleCount && (
          <div className="mt-2 flex items-center justify-between gap-2">
            <p className="text-xs text-zinc-600">
              Showing {visibleCount} of {sorted.length}
            </p>
            <button
              onClick={() => setVisibleCount((v) => v + 100)}
              className="rounded-md bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700"
            >
              Load 100 more
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
