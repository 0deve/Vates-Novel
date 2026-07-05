import { useEffect, useState } from "react";
import { getNovelDetails, listSources, searchNovels } from "../lib/api";
import { addToLibrary } from "../lib/db";
import type { SearchResult, SourceInfo } from "../types";

export default function BrowsePage() {
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [sourceId, setSourceId] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    listSources()
      .then((s) => {
        setSources(s);
        const first = s[0]?.id ?? "";
        setSourceId(first);
        // Empty query = popular/ranking novels as the initial view.
        if (first) void search(first, "");
      })
      .catch((e) => setStatus(`Failed to load sources: ${e}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function search(sid = sourceId, q = query) {
    setSearching(true);
    setStatus(q.trim() ? "Searching…" : "Loading popular novels…");
    try {
      const r = await searchNovels(sid, q);
      setResults(r);
      setStatus(r.length ? "" : "No results.");
    } catch (e) {
      setStatus(`Search failed: ${e}`);
    } finally {
      setSearching(false);
    }
  }

  async function add(r: SearchResult) {
    setBusy(r.novel_url);
    setStatus(`Adding "${r.title}"…`);
    try {
      const details = await getNovelDetails(r.source_id, r.novel_url);
      await addToLibrary(details);
      setStatus(`Added "${details.title}" (${details.chapters.length} chapters)`);
    } catch (e) {
      setStatus(`Add failed: ${e}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <h2 className="text-xl font-semibold">Browse</h2>
      <div className="flex gap-2">
        <select
          value={sourceId}
          onChange={(e) => {
            setSourceId(e.target.value);
            void search(e.target.value);
          }}
          className="rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
        >
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && search()}
          placeholder="Search by title — empty shows popular novels"
          className="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
        />
        <button
          onClick={() => search()}
          disabled={searching}
          className="rounded-md bg-orange-600 px-4 py-2 text-sm font-medium hover:bg-orange-500 disabled:opacity-50"
        >
          Search
        </button>
      </div>

      {status && <p className="text-sm text-zinc-500">{status}</p>}

      <div className="grid grid-cols-3 gap-4 lg:grid-cols-4 xl:grid-cols-5">
        {results.map((r) => (
          <div
            key={r.novel_url}
            className="flex flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900"
          >
            <div className="flex aspect-[2/3] w-full items-center justify-center bg-zinc-800">
              {r.cover_url ? (
                <img
                  src={r.cover_url}
                  alt={r.title}
                  loading="lazy"
                  className="h-full w-full object-cover"
                />
              ) : (
                <span className="text-5xl font-bold text-zinc-600">
                  {r.title.charAt(0)}
                </span>
              )}
            </div>
            <div className="flex flex-1 flex-col gap-1 p-3">
              <div className="truncate text-sm font-medium" title={r.title}>
                {r.title}
              </div>
              <div className="text-xs text-zinc-500">
                {[
                  r.chapter_count != null ? `${r.chapter_count} ch` : null,
                  r.status,
                  r.author,
                ]
                  .filter(Boolean)
                  .join(" · ") || " "}
              </div>
              <button
                onClick={() => add(r)}
                disabled={busy !== null}
                className="mt-2 rounded-md bg-zinc-800 px-3 py-1.5 text-sm hover:bg-zinc-700 disabled:opacity-50"
              >
                {busy === r.novel_url ? "Adding…" : "Add to Library"}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
