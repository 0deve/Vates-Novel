// Cross-source search and chapter remapping for "Migrate" (switch a novel's source).
import { listSources, searchNovels } from "./api";
import type { ChapterRef, SearchResult, SourceInfo } from "../types";

/** Chapter number from a title like "Chapter 50 - Diagnosis" or "Ch. 12.5". */
export function chapterNumber(title: string): number | null {
  const m =
    title.match(/\b(?:chapter|chap|ch|episode|ep)\.?\s*(\d+(?:\.\d+)?)/i) ??
    title.match(/^\s*(\d+(?:\.\d+)?)\b/);
  return m ? Number(m[1]) : null;
}

/** Maps an old chapter idx onto the new list: by chapter number, else by position. */
export function makeChapterMapper(
  oldChapters: { idx: number; title: string }[],
  newChapters: ChapterRef[],
): (oldIdx: number) => number | null {
  if (newChapters.length === 0) return () => null;
  const byNumber = new Map<number, number>();
  for (const c of newChapters) {
    const n = chapterNumber(c.title) ?? c.index;
    if (!byNumber.has(n)) byNumber.set(n, c.index);
  }
  const oldOrdinal = new Map(oldChapters.map((c, i) => [c.idx, i]));
  const oldTitle = new Map(oldChapters.map((c) => [c.idx, c.title]));
  return (oldIdx) => {
    const t = oldTitle.get(oldIdx);
    const n = t != null ? chapterNumber(t) : null;
    if (n != null && byNumber.has(n)) return byNumber.get(n)!;
    const ord = oldOrdinal.get(oldIdx);
    if (ord == null) return null;
    return newChapters[Math.min(ord, newChapters.length - 1)].index;
  };
}

const norm = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** 0..1 title similarity, good enough to sort cross-source hits. */
export function titleScore(query: string, title: string): number {
  const a = norm(query);
  const b = norm(title);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (b.includes(a) || a.includes(b)) return 0.85;
  const at = new Set(a.split(" "));
  const bt = b.split(" ");
  const shared = bt.filter((t) => at.has(t)).length;
  return (0.7 * shared) / Math.max(at.size, bt.length);
}

export interface SourceHits {
  source: SourceInfo;
  results: SearchResult[];
  error: string | null;
}

/** Search every novel source in parallel; onUpdate fires as each one finishes. */
export async function searchAllSources(
  query: string,
  onUpdate: (hits: SourceHits[]) => void,
  opts: { kinds?: string[] } = {},
): Promise<SourceHits[]> {
  const kinds = opts.kinds ?? ["novel"];
  const sources = (await listSources()).filter(
    (s) => s.id !== "stub" && kinds.includes(s.kind ?? "novel"),
  );
  const hits: SourceHits[] = sources.map((source) => ({ source, results: [], error: null }));
  const emit = () => onUpdate(hits.map((h) => ({ ...h })));
  emit();
  await Promise.all(
    hits.map(async (h) => {
      try {
        const r = await searchNovels(h.source.id, query);
        h.results = r
          .map((x) => ({ x, s: titleScore(query, x.title) }))
          .filter(({ s }) => s > 0.2)
          .sort((p, q) => q.s - p.s)
          .slice(0, 8)
          .map(({ x }) => x);
      } catch (e) {
        h.error = String(e);
      }
      emit();
    }),
  );
  return hits;
}
