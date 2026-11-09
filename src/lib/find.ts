// In-chapter text search over the reader's display segments.

export interface FindMatch {
  segment: number;
  start: number;
  end: number;
}

/** Every case-insensitive occurrence of `query`, in reading order. */
export function findMatches(segments: string[], query: string): FindMatch[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const matches: FindMatch[] = [];
  segments.forEach((text, segment) => {
    const lower = text.toLowerCase();
    for (let at = lower.indexOf(q); at >= 0; at = lower.indexOf(q, at + q.length)) {
      matches.push({ segment, start: at, end: at + q.length });
    }
  });
  return matches;
}
