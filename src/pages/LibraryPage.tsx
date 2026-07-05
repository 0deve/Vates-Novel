import { useEffect, useState } from "react";
import { fetchLibrary } from "../lib/db";
import type { LibraryNovel } from "../types";

interface Props {
  onOpen: (novelId: number) => void;
}

export default function LibraryPage({ onOpen }: Props) {
  const [novels, setNovels] = useState<LibraryNovel[]>([]);
  const [status, setStatus] = useState("Loading…");

  useEffect(() => {
    fetchLibrary()
      .then((n) => {
        setNovels(n);
        setStatus(n.length ? "" : "Library is empty — add novels from Browse.");
      })
      .catch((e) => setStatus(`Failed to load library: ${e}`));
  }, []);

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <h2 className="text-xl font-semibold">Library</h2>
      {status && <p className="text-sm text-zinc-500">{status}</p>}
      <div className="grid grid-cols-3 gap-4 lg:grid-cols-4">
        {novels.map((n) => (
          <button
            key={n.id}
            onClick={() => onOpen(n.id)}
            className="flex flex-col overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900 text-left transition-colors hover:border-zinc-600"
          >
            <div className="flex aspect-[2/3] w-full items-center justify-center bg-zinc-800">
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
            </div>
            <div className="w-full p-3">
              <div className="truncate text-sm font-medium" title={n.title}>
                {n.title}
              </div>
              <div className="truncate text-xs text-zinc-500">
                {n.author ?? "Unknown"} · {n.chapter_count} ch
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
