// Fan-out for background changes to the library (update checks, sync merges)
// so an open Library screen refreshes itself.
const listeners = new Set<() => void>();

export function subscribeLibraryUpdates(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function notifyLibraryUpdated(): void {
  for (const fn of listeners) fn();
}
