// Persistent bottom-right download progress popup.
import { useSyncExternalStore } from "react";
import {
  cancelDownload,
  dismissDownload,
  getDownloadJob,
  subscribeDownloads,
} from "../lib/downloads";

export default function DownloadToast() {
  const job = useSyncExternalStore(subscribeDownloads, getDownloadJob);
  if (!job) return null;

  const finished = job.done + job.failed;
  const pct = job.total > 0 ? Math.round((finished / job.total) * 100) : 100;
  const active = job.state === "running" || job.state === "retrying";

  return (
    <div className="fixed bottom-4 right-4 z-40 w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-zinc-700 bg-zinc-900 p-3 shadow-xl">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium">{job.novelTitle}</span>
        {active ? (
          <button
            onClick={cancelDownload}
            className="shrink-0 rounded px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-red-400"
          >
            Stop
          </button>
        ) : (
          <button
            onClick={dismissDownload}
            className="shrink-0 rounded px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800"
          >
            Dismiss
          </button>
        )}
      </div>

      <div className="mb-1 h-1.5 overflow-hidden rounded-full bg-zinc-800">
        <div
          className={`h-full transition-all ${
            job.failed > 0 ? "bg-amber-500" : "bg-orange-600"
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="flex justify-between text-xs text-zinc-500">
        <span>
          {job.state === "retrying"
            ? "Retrying failed chapters…"
            : active
              ? `Downloading ${finished}/${job.total}`
              : `${job.done}/${job.total} downloaded`}
          {job.failed > 0 && ` · ${job.failed} failed`}
        </span>
        <span className="tabular-nums">{pct}%</span>
      </div>
      {job.message && !active && (
        <p className="mt-1 text-xs text-zinc-500">{job.message}</p>
      )}
    </div>
  );
}
