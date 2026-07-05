// Novel Details screen: metadata, completion bar, chapter search, downloads
// (via the global download manager), per-chapter and bulk deletion.
import { useCallback, useEffect, useMemo, useState } from "react";
import { getChapterContent, getNovelDetails } from "../lib/api";
import {
  clearChapterContent,
  clearNovelDownloads,
  fetchChapterMeta,
  fetchNovel,
  getChapterRow,
  mergeChapters,
  removeNovel,
  saveChapterContent,
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

  const job = useSyncExternalStore(subscribeDownloads, getDownloadJob);
  const batchBusy =
    job?.novelId === novelId &&
    (job.state === "running" || job.state === "retrying");

  const reload = useCallback(async () => {
    const [n, ch] = await Promise.all([
      fetchNovel(novelId),
      fetchChapterMeta(novelId),
    ]);
    setNovel(n);
    setChapters(ch);
  }, [novelId]);

  useEffect(() => {
    reload().catch((e) => setStatus(String(e)));
  }, [reload]);

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

  async function refresh() {
    if (!novel) return;
    setStatus("Refreshing chapter list…");
    try {
      const details = await getNovelDetails(novel.source_id, novel.novel_url);
      const added = await mergeChapters(novelId, details);
      setStatus(added ? `${added} new chapters found.` : "No new chapters.");
      await reload();
    } catch (e) {
      setStatus(`Refresh failed: ${e}`);
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

          {novel.summary && (
            <p className="mt-2 line-clamp-3 text-sm text-zinc-500">
              {novel.summary}
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={() =>
                onRead(novel.last_read_chapter, novel.last_read_segment)
              }
              className="rounded-md bg-orange-600 px-4 py-1.5 text-sm font-medium hover:bg-orange-500"
            >
              {novel.last_read_chapter != null
                ? "Continue Reading"
                : "Start Reading"}
            </button>
            <button
              onClick={refresh}
              className="rounded-md bg-zinc-800 px-3 py-1.5 text-sm hover:bg-zinc-700"
            >
              Refresh
            </button>
            <button
              onClick={() => {
                void startDownloadAll(novel, chapters).then((ok) => {
                  if (!ok) setStatus("Another download is already running.");
                });
              }}
              disabled={batchBusy || downloadedCount === chapters.length}
              className="rounded-md bg-zinc-800 px-3 py-1.5 text-sm hover:bg-zinc-700 disabled:opacity-50"
            >
              {batchBusy ? "Downloading…" : "Download All"}
            </button>
            <button
              onClick={clearDownloads}
              disabled={batchBusy || downloadedCount === 0}
              className="rounded-md bg-zinc-800 px-3 py-1.5 text-sm hover:bg-zinc-700 disabled:opacity-50"
            >
              Delete Downloads
            </button>
            <button
              onClick={removeFromLibrary}
              disabled={batchBusy}
              className="rounded-md bg-zinc-800 px-3 py-1.5 text-sm text-red-400 hover:bg-zinc-700 disabled:opacity-50"
            >
              Remove from Library
            </button>
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
          {sorted.slice(0, 500).map((c) => (
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
        {sorted.length > 500 && (
          <p className="mt-2 text-xs text-zinc-600">
            Showing first 500 of {sorted.length} — use the search box to narrow
            down.
          </p>
        )}
      </div>
    </div>
  );
}
