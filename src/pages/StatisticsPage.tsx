// Statistics: aggregate reading/download stats across the whole library.
import { useEffect, useState, type ReactNode } from "react";
import {
  fetchAudioCacheTotal,
  fetchLibraryStats,
  type LibraryStats,
} from "../lib/db";
import { formatBytes } from "../lib/format";

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900 p-4">
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="mt-1 text-xs text-zinc-500">{label}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
        {title}
      </h3>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{children}</div>
    </section>
  );
}

export default function StatisticsPage() {
  const [stats, setStats] = useState<LibraryStats | null>(null);
  const [audio, setAudio] = useState<{ chapters: number; bytes: number } | null>(
    null,
  );
  const [status, setStatus] = useState("Loading…");

  useEffect(() => {
    fetchLibraryStats()
      .then((s) => {
        setStats(s);
        setStatus("");
      })
      .catch((e) => setStatus(`Failed to load statistics: ${e}`));
    fetchAudioCacheTotal().then(setAudio).catch(() => {});
  }, []);

  if (!stats)
    return <p className="text-sm text-zinc-500">{status || "Loading…"}</p>;

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <h2 className="text-xl font-semibold">Statistics</h2>
      {status && <p className="text-sm text-zinc-500">{status}</p>}

      <Section title="Library">
        <StatCard label="Novels" value={stats.totalNovels} />
        <StatCard label="Completed" value={stats.novelsCompleted} />
        <StatCard label="In Progress" value={stats.novelsInProgress} />
        <StatCard label="Not Started" value={stats.novelsNotStarted} />
      </Section>

      <Section title="Chapters">
        <StatCard label="Total" value={stats.totalChapters} />
        <StatCard label="Read" value={stats.chaptersRead} />
        <StatCard label="Unread" value={stats.chaptersUnread} />
        <StatCard label="Downloaded" value={stats.chaptersDownloaded} />
        <StatCard label="Not Downloaded" value={stats.chaptersNotDownloaded} />
      </Section>

      <Section title="Storage">
        <StatCard label="Downloaded Text" value={formatBytes(stats.downloadedBytes)} />
        <StatCard label="Downloaded TTS Size" value={formatBytes(audio?.bytes ?? 0)} />
        <StatCard label="Downloaded TTS Chapters" value={audio?.chapters ?? 0} />
      </Section>
    </div>
  );
}
