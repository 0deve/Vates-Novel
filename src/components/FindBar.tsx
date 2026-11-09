// Search bar under the reader header: step through matches in this chapter,
// or list every downloaded chapter containing the text.
import { useEffect, useRef } from "react";
import type { FindResult } from "../lib/db";
import { ChevronDownIcon, ChevronUpIcon, CloseIcon } from "./icons";

interface Props {
  query: string;
  current: number;
  total: number;
  allChapters: boolean;
  results: FindResult[] | null;
  searching: boolean;
  onQuery: (q: string) => void;
  onStep: (delta: 1 | -1) => void;
  onAllChapters: (all: boolean) => void;
  onPick: (r: FindResult) => void;
  onClose: () => void;
}

export default function FindBar({
  query,
  current,
  total,
  allChapters,
  results,
  searching,
  onQuery,
  onStep,
  onAllChapters,
  onPick,
  onClose,
}: Props) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => inputRef.current?.focus(), []);

  const stepCls = "rounded p-2 text-zinc-400 hover:bg-zinc-800 disabled:opacity-40";

  return (
    <div className="border-b border-zinc-800 bg-zinc-900">
      <div className="flex items-center gap-1.5 px-3 py-1.5 md:px-4">
        <input
          id="reader-find"
          ref={inputRef}
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (!allChapters) onStep(e.shiftKey ? -1 : 1);
            } else if (e.key === "Escape") {
              onClose();
            }
          }}
          placeholder={allChapters ? "Find in downloaded chapters" : "Find in this chapter"}
          className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-sm"
        />
        {!allChapters && (
          <>
            <span className="shrink-0 px-1 text-xs tabular-nums text-zinc-500">
              {total > 0 ? `${current + 1}/${total}` : query.trim() ? "0/0" : ""}
            </span>
            <button
              onClick={() => onStep(-1)}
              disabled={total === 0}
              className={stepCls}
              title="Previous match (Shift+Enter)"
              aria-label="Previous match"
            >
              <ChevronUpIcon />
            </button>
            <button
              onClick={() => onStep(1)}
              disabled={total === 0}
              className={stepCls}
              title="Next match (Enter)"
              aria-label="Next match"
            >
              <ChevronDownIcon />
            </button>
          </>
        )}
        <button
          onClick={() => onAllChapters(!allChapters)}
          className={`shrink-0 rounded border px-2 py-1 text-xs ${
            allChapters
              ? "border-orange-500 text-orange-400"
              : "border-zinc-700 text-zinc-400 hover:text-zinc-200"
          }`}
          title="Search every downloaded chapter of this novel"
        >
          All
        </button>
        <button onClick={onClose} className={stepCls} title="Close (Esc)" aria-label="Close find">
          <CloseIcon />
        </button>
      </div>

      {allChapters && query.trim().length >= 2 && (
        <div className="max-h-64 overflow-y-auto border-t border-zinc-800">
          {searching && !results && <p className="px-4 py-2 text-xs text-zinc-500">Searching…</p>}
          {results?.length === 0 && (
            <p className="px-4 py-2 text-xs text-zinc-500">
              No matches in downloaded chapters.
            </p>
          )}
          {results?.map((r) => (
            <button
              key={r.idx}
              onClick={() => onPick(r)}
              className="block w-full px-4 py-2 text-left hover:bg-zinc-800/60"
            >
              <span className="block truncate text-sm text-zinc-300">{r.title}</span>
              <span className="block truncate text-xs text-zinc-500">{r.snippet}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
