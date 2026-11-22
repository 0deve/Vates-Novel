// Migrate a library novel to another source: search all, pick, preview mapping, confirm.
import { useEffect, useRef, useState } from "react";
import { getNovelDetails } from "../lib/api";
import { fetchBookmarks, fetchChapterMeta, migrateNovel } from "../lib/db";
import { startDownloadAll } from "../lib/downloads";
import { logError, logInfo } from "../lib/log";
import { makeChapterMapper, searchAllSources, type SourceHits } from "../lib/migrate";
import type { ChapterMeta, NovelDetails, NovelRow, SearchResult } from "../types";
import { CloseIcon } from "./icons";

interface Props {
  novel: NovelRow;
  onClose: () => void;
  onDone: () => void;
}

interface Preview {
  details: NovelDetails;
  oldChapters: ChapterMeta[];
  newReadIdx: number | null;
  bookmarkMap: Map<number, number>;
  redownload: number[];
}

export default function MigrateDialog({ novel, onClose, onDone }: Props) {
  const [query, setQuery] = useState(novel.title);
  const [hits, setHits] = useState<SourceHits[]>([]);
  const [searching, setSearching] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loadingUrl, setLoadingUrl] = useState<string | null>(null);
  const [redownload, setRedownload] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const searchId = useRef(0);

  async function runSearch() {
    const q = query.trim();
    if (!q) return;
    const id = ++searchId.current;
    setSearching(true);
    setPreview(null);
    setError("");
    await searchAllSources(q, (h) => {
      if (id === searchId.current) setHits(h);
    });
    if (id === searchId.current) setSearching(false);
  }

  useEffect(() => {
    void runSearch();
  }, []);

  async function pick(r: SearchResult) {
    setLoadingUrl(r.novel_url);
    setError("");
    try {
      const [details, oldChapters, bookmarks] = await Promise.all([
        getNovelDetails(r.source_id, r.novel_url),
        fetchChapterMeta(novel.id),
        fetchBookmarks(novel.id),
      ]);
      if (details.chapters.length === 0) throw new Error("That source lists no chapters.");
      const map = makeChapterMapper(oldChapters, details.chapters);
      const bookmarkMap = new Map<number, number>();
      for (const b of bookmarks) {
        const to = map(b.chapter_idx);
        if (to != null) bookmarkMap.set(b.chapter_idx, to);
      }
      const redl = new Set<number>();
      for (const c of oldChapters) {
        if (!c.downloaded) continue;
        const to = map(c.idx);
        if (to != null) redl.add(to);
      }
      setPreview({
        details,
        oldChapters,
        newReadIdx: novel.last_read_chapter != null ? map(novel.last_read_chapter) : null,
        bookmarkMap,
        redownload: [...redl],
      });
    } catch (e) {
      setError(`Could not load that novel: ${e}`);
    } finally {
      setLoadingUrl(null);
    }
  }

  async function confirm() {
    if (!preview) return;
    setBusy(true);
    setError("");
    try {
      await migrateNovel(novel.id, {
        details: preview.details,
        lastReadChapter: preview.newReadIdx,
        bookmarkMap: preview.bookmarkMap,
      });
      logInfo(
        "migrate",
        `${novel.title}: ${novel.source_id} -> ${preview.details.source_id} (${preview.details.novel_url})`,
      );
      if (redownload && preview.redownload.length) {
        const fresh = await fetchChapterMeta(novel.id);
        const want = new Set(preview.redownload);
        void startDownloadAll(
          { ...novel, source_id: preview.details.source_id, novel_url: preview.details.novel_url },
          fresh.filter((c) => want.has(c.idx)),
        );
      }
      onDone();
    } catch (e) {
      logError("migrate", e);
      setError(String(e));
      setBusy(false);
    }
  }

  const oldTitleAt = (idx: number | null) =>
    idx == null ? null : preview?.oldChapters.find((c) => c.idx === idx)?.title ?? `#${idx}`;
  const newTitleAt = (idx: number | null) =>
    idx == null ? null : preview?.details.chapters.find((c) => c.index === idx)?.title ?? `#${idx}`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3" onClick={onClose}>
      <div
        className="flex max-h-[90vh] w-full max-w-xl flex-col rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-zinc-800 p-3">
          <h2 className="mr-auto font-semibold">Migrate source</h2>
          <button onClick={onClose} aria-label="Close" className="rounded p-1 text-zinc-400 hover:bg-zinc-800">
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>

        {!preview ? (
          <>
            <form
              className="flex gap-2 p-3"
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
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-3 pb-3">
              {hits.map((h) => (
                <div key={h.source.id}>
                  <div className="mb-1 flex items-center gap-2 text-xs text-zinc-500">
                    <span className="font-medium text-zinc-300">{h.source.name}</span>
                    {h.source.id === novel.source_id && <span>(current)</span>}
                    {searching && !h.error && h.results.length === 0 && <span>searching…</span>}
                    {h.error && <span className="truncate text-red-400/80">{h.error}</span>}
                    {!searching && !h.error && h.results.length === 0 && <span>no matches</span>}
                  </div>
                  <ul className="space-y-1">
                    {h.results.map((r) => {
                      const current = r.source_id === novel.source_id && r.novel_url === novel.novel_url;
                      return (
                        <li key={r.novel_url}>
                          <button
                            disabled={current || loadingUrl != null}
                            onClick={() => pick(r)}
                            className="flex w-full items-center gap-3 rounded-md p-2 text-left hover:bg-zinc-800 disabled:opacity-50"
                          >
                            <div className="h-14 w-10 shrink-0 overflow-hidden rounded bg-zinc-800">
                              {r.cover_url && <img src={r.cover_url} alt="" className="h-full w-full object-cover" />}
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm">{r.title}</p>
                              <p className="truncate text-xs text-zinc-500">
                                {[r.author, r.chapter_count != null ? `${r.chapter_count} chapters` : null, r.status]
                                  .filter(Boolean)
                                  .join(" · ") || " "}
                              </p>
                            </div>
                            {loadingUrl === r.novel_url && <span className="text-xs text-zinc-500">loading…</span>}
                            {current && <span className="text-xs text-zinc-500">this one</span>}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="space-y-3 overflow-y-auto p-4 text-sm">
            <p>
              <span className="text-zinc-500">To:</span> {preview.details.title}{" "}
              <span className="text-zinc-500">
                ({preview.details.chapters.length} chapters, was {preview.oldChapters.length})
              </span>
            </p>
            {novel.last_read_chapter != null && (
              <div className="rounded-md bg-zinc-950 p-3 text-xs">
                <p className="text-zinc-500">Current chapter</p>
                <p className="truncate">{oldTitleAt(novel.last_read_chapter)}</p>
                <p className="text-zinc-500">becomes</p>
                <p className="truncate text-orange-400">{newTitleAt(preview.newReadIdx) ?? "start"}</p>
              </div>
            )}
            <p className="text-xs text-zinc-500">
              Bookmarks, stats, voice settings, collections and pronunciation rules are kept.
              Downloaded chapters from the old source are removed.
            </p>
            {preview.redownload.length > 0 && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={redownload} onChange={(e) => setRedownload(e.target.checked)} />
                Re-download the same {preview.redownload.length} chapters from the new source
              </label>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setPreview(null)}
                disabled={busy}
                className="rounded-md bg-zinc-800 px-4 py-2 hover:bg-zinc-700"
              >
                Back
              </button>
              <button
                onClick={confirm}
                disabled={busy}
                className="rounded-md bg-orange-600 px-4 py-2 font-medium hover:bg-orange-500 disabled:opacity-50"
              >
                {busy ? "Migrating…" : "Migrate"}
              </button>
            </div>
          </div>
        )}
        {error && <p className="break-words px-4 pb-3 text-sm text-red-400">{error}</p>}
      </div>
    </div>
  );
}
