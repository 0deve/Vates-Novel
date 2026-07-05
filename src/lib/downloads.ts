// Global download manager. Lives at module scope so a batch download keeps
// running while the user navigates around the app; DownloadToast renders its
// progress bottom-right.
import { getChapterContent } from "./api";
import { getChapterRow, saveChapterContent } from "./db";
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
}

async function fetchOne(novel: NovelRow, m: ChapterMeta): Promise<void> {
  const row = await getChapterRow(novel.id, m.idx);
  if (!row) throw new Error("chapter row missing");
  if (row.content) return; // already downloaded
  const cc = await getChapterContent(novel.source_id, row.chapter_url);
  await saveChapterContent(row.id, cc.html, cc.title);
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

  for (const m of pending) {
    if (cancelled) break;
    try {
      await fetchOne(novel, m);
      consecutive = 0;
      update({ done: job.done + 1 });
    } catch {
      consecutive++;
      failedChapters.push(m);
      update({ failed: job.failed + 1 });
      if (consecutive >= 8) {
        update({
          state: "stopped",
          message:
            "The site is blocking requests — try again in a few minutes. Downloaded chapters are kept.",
        });
        return true;
      }
    }
  }

  // One automatic retry pass for the stragglers.
  if (!cancelled && failedChapters.length > 0) {
    update({ state: "retrying", message: `Retrying ${failedChapters.length} failed…` });
    const second = failedChapters;
    failedChapters = [];
    for (const m of second) {
      if (cancelled) break;
      try {
        await fetchOne(novel, m);
        update({ done: job.done + 1, failed: job.failed - 1 });
      } catch {
        failedChapters.push(m);
      }
    }
  }

  if (cancelled) {
    update({ state: "stopped", message: "Stopped. Downloaded chapters are kept." });
  } else if (failedChapters.length > 0) {
    update({
      state: "done",
      message: `${failedChapters.length} chapters failed — run Download All again to retry them.`,
    });
  } else {
    update({ state: "done", message: "All chapters downloaded." });
  }
  return true;
}
