// Global download manager. Lives at module scope so a batch download keeps
// running while the user navigates around the app; DownloadToast renders its
// progress bottom-right.
import { getChapterContent } from "./api";
import { getChapterRow, saveChapterContent } from "./db";
import {
  downloadEnd,
  downloadUpdate,
  hasNativeMedia,
  onMediaAction,
} from "./nativeMedia";
import { logInfo, logWarn } from "./log";
import type { ChapterMeta, NovelRow } from "../types";

export interface DownloadJob {
  novelId: number;
  novelTitle: string;
  total: number;
  done: number;
  failed: number;
  state: "running" | "retrying" | "done" | "stopped";
  message: string;
}

let job: DownloadJob | null = null;
let cancelled = false;
const listeners = new Set<() => void>();

// The Android download notification's Stop button.
if (typeof window !== "undefined") {
  onMediaAction((a) => {
    if (a === "download-stop") cancelDownload();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function subscribeDownloads(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getDownloadJob(): DownloadJob | null {
  return job;
}

export function cancelDownload(): void {
  cancelled = true;
}

export function dismissDownload(): void {
  if (job && job.state !== "running" && job.state !== "retrying") {
    job = null;
    emit();
  }
}

function emit() {
  for (const fn of listeners) fn();
}

function update(patch: Partial<DownloadJob>) {
  if (!job) return;
  job = { ...job, ...patch };
  emit();
  // Mirror progress into the Android notification (no-op on desktop).
  if (hasNativeMedia()) {
    if (job.state === "running" || job.state === "retrying") {
      downloadUpdate(job.novelTitle, job.done + job.failed, job.total);
    } else {
      downloadEnd();
    }
  }
}

/** Returns how long the source fetch and the save took, for the log. */
async function fetchOne(novel: NovelRow, m: ChapterMeta): Promise<{ fetch: number; save: number }> {
  const row = await getChapterRow(novel.id, m.idx);
  if (!row) throw new Error("chapter row missing");
  if (row.content) return { fetch: 0, save: 0 }; // already downloaded
  const t0 = Date.now();
  const cc = await getChapterContent(novel.source_id, row.chapter_url);
  const t1 = Date.now();
  await saveChapterContent(row.id, cc.html, cc.title);
  return { fetch: t1 - t0, save: Date.now() - t1 };
}

/**
 * Start a batch download. Returns false if another batch is already running.
 * Failed chapters get one automatic retry pass at the end.
 */
export async function startDownloadAll(
  novel: NovelRow,
  chapters: ChapterMeta[],
): Promise<boolean> {
  if (job && (job.state === "running" || job.state === "retrying")) return false;

  const pending = chapters.filter((c) => !c.downloaded);
  cancelled = false;
  job = {
    novelId: novel.id,
    novelTitle: novel.title,
    total: pending.length,
    done: 0,
    failed: 0,
    state: "running",
    message: "",
  };
  emit();
  if (pending.length === 0) {
    update({ state: "done", message: "Nothing to download." });
    return true;
  }

  let failedChapters: ChapterMeta[] = [];
  let consecutive = 0;
  const started = Date.now();
  let fetchMs = 0;
  let saveMs = 0;
  const timed = async (m: ChapterMeta) => {
    const t = await fetchOne(novel, m);
    fetchMs += t.fetch;
    saveMs += t.save;
  };

  for (const m of pending) {
    if (cancelled) break;
    try {
      await timed(m);
      consecutive = 0;
      update({ done: job.done + 1 });
    } catch {
      consecutive++;
      failedChapters.push(m);
      update({ failed: job.failed + 1 });
      if (consecutive >= 8) {
        logWarn("download", `${novel.title}: stopped after 8 consecutive failures`);
        update({
          state: "stopped",
          message:
            "The site is blocking requests — try again in a few minutes. Downloaded chapters are kept.",
        });
        return true;
      }
      // A failure usually means the site is pushing back — give it a moment
      // before the next request instead of hammering on.
      await sleep(1500 * consecutive);
    }
  }

  // One automatic retry pass for the stragglers, after letting the site
  // cool down for a few seconds.
  if (!cancelled && failedChapters.length > 0) {
    update({ state: "retrying", message: `Retrying ${failedChapters.length} failed…` });
    await sleep(5000);
    const second = failedChapters;
    failedChapters = [];
    for (const m of second) {
      if (cancelled) break;
      try {
        await timed(m);
        update({ done: job.done + 1, failed: job.failed - 1 });
      } catch {
        failedChapters.push(m);
        await sleep(3000);
      }
    }
  }

  if (job.done > 0) {
    const secs = (Date.now() - started) / 1000;
    logInfo(
      "download",
      `${novel.title}: ${job.done} chapters in ${secs.toFixed(0)} s ` +
        `(${(secs / job.done).toFixed(1)} s each; source ${(fetchMs / job.done / 1000).toFixed(1)} s, ` +
        `saving ${(saveMs / job.done / 1000).toFixed(2)} s), ${failedChapters.length} failed`,
    );
  }
  if (cancelled) {
    update({ state: "stopped", message: "Stopped. Downloaded chapters are kept." });
  } else if (failedChapters.length > 0) {
    logWarn(
      "download",
      `${novel.title}: ${failedChapters.length} chapters still failing after retry:`,
      failedChapters.map((c) => c.idx).join(", "),
    );
    update({
      state: "done",
      message: `${failedChapters.length} chapters failed — run Download All again to retry them.`,
    });
  } else {
    update({ state: "done", message: "All chapters downloaded." });
  }
  return true;
}
