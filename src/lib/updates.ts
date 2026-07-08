// Automatic new-chapter checks: on app launch (throttled to the interval
// chosen in Settings), silently re-fetch every library novel's chapter list
// and merge in anything new. Found chapters surface through the existing
// "+N new" badges in the Library; subscribers are notified so an open
// Library screen refreshes itself.
import { getNovelDetails } from "./api";
import { fetchLibrary, mergeChapters } from "./db";

const LAST_CHECK_KEY = "last-update-check";

let running = false;
const listeners = new Set<() => void>();

/** Notified when a background check found new chapters. */
export function subscribeLibraryUpdates(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export async function maybeCheckForUpdates(intervalHours: number): Promise<void> {
  if (intervalHours <= 0 || running) return;
  const last = Number(localStorage.getItem(LAST_CHECK_KEY) ?? 0);
  if (Date.now() - last < intervalHours * 3_600_000) return;

  running = true;
  localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
  try {
    const novels = (await fetchLibrary()).filter((n) => n.source_id !== "local");
    let foundNew = false;
    for (const n of novels) {
      try {
        const details = await getNovelDetails(n.source_id, n.novel_url);
        if ((await mergeChapters(n.id, details)) > 0) foundNew = true;
      } catch {
        // Offline / rate-limited / site changed — skip this novel silently;
        // the manual "Check Updates" button reports errors when wanted.
      }
    }
    if (foundNew) for (const fn of listeners) fn();
  } finally {
    running = false;
  }
}
