// bottom-right download progress popups; text and audio stack independently,
// since both can run at once.
import { useSyncExternalStore } from "react";
import {
  cancelDownload,
  dismissDownload,
  getDownloadJob,
  subscribeDownloads,
} from "../lib/downloads";
import {
  cancelAudioDownload,
  dismissAudioDownload,
  getAudioDownloadJob,
  subscribeAudioDownloads,
} from "../lib/audioDownloads";

interface CardProps {
  title: string;
  subtitle: string;
  message: string;
  pct: number;
  active: boolean;
  warn: boolean;
  onCancel: () => void;
  onDismiss: () => void;
}

function ProgressCard({
  title,
  subtitle,
  message,
  pct,
  active,
  warn,
  onCancel,
  onDismiss,
}: CardProps) {
  return (
    <div className="w-80 max-w-[calc(100vw-2rem)] rounded-lg border border-zinc-700 bg-zinc-900 p-3 shadow-xl">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="truncate text-sm font-medium">{title}</span>
        {active ? (
          <button
            onClick={onCancel}
            className="shrink-0 rounded px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-red-400"
          >
            Stop
          </button>
        ) : (
          <button
            onClick={onDismiss}
            className="shrink-0 rounded px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800"
          >
            Dismiss
          </button>
        )}
      </div>

      <div className="mb-1 h-1.5 overflow-hidden rounded-full bg-zinc-800">
        <div
          className={`h-full transition-all ${
            warn ? "bg-red-500/70" : "bg-orange-600"
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="flex justify-between gap-2 text-xs text-zinc-500">
        <span className="truncate">{subtitle}</span>
        <span className="shrink-0 tabular-nums">{pct}%</span>
      </div>
      {message && !active && <p className="mt-1 text-xs text-zinc-500">{message}</p>}
    </div>
  );
}

/** raised lifts the stack clear of the reader's player bar. */
export default function DownloadToast({ raised = false }: { raised?: boolean }) {
  const job = useSyncExternalStore(subscribeDownloads, getDownloadJob);
  const audio = useSyncExternalStore(
    subscribeAudioDownloads,
    getAudioDownloadJob,
  );
  if (!job && !audio) return null;

  return (
    <div
      className={`fixed right-4 z-40 flex flex-col gap-2 ${
        raised ? "bottom-20" : "bottom-4"
      }`}
    >
      {job &&
        (() => {
          const finished = job.done + job.failed;
          const active = job.state === "running" || job.state === "retrying";
          return (
            <ProgressCard
              title={job.novelTitle}
              subtitle={
                (job.state === "retrying"
                  ? "Retrying failed chapters…"
                  : active
                    ? `Downloading ${finished}/${job.total}`
                    : `${job.done}/${job.total} downloaded`) +
                (job.failed > 0 ? ` · ${job.failed} failed` : "")
              }
              message={job.message}
              pct={job.total > 0 ? Math.round((finished / job.total) * 100) : 100}
              active={active}
              warn={job.failed > 0}
              onCancel={cancelDownload}
              onDismiss={dismissDownload}
            />
          );
        })()}

      {audio &&
        (() => {
          const finished = audio.done + audio.failed;
          const active = audio.state === "running";
          return (
            <ProgressCard
              title={`Audio · ${audio.novelTitle}`}
              subtitle={
                active
                  ? `Chapter ${finished + 1}/${audio.total}${
                      audio.currentTitle ? ` · ${audio.currentTitle}` : ""
                    }`
                  : `${audio.done}/${audio.total} downloaded`
              }
              message={audio.message}
              pct={
                audio.total > 0 ? Math.round((finished / audio.total) * 100) : 100
              }
              active={active}
              warn={audio.failed > 0}
              onCancel={cancelAudioDownload}
              onDismiss={dismissAudioDownload}
            />
          );
        })()}
    </div>
  );
}
