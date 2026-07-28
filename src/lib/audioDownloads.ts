// global offline tts audio download manager, at module scope (like
// lib/downloads.ts) so a batch survives leaving the reader or backgrounding
// the app; on android AudioDownloadService holds the wake lock for it.
import { cacheSegments, getChapterContent } from "./api";
import {
  getChapterRow,
  recordAudioDownload,
  saveChapterContent,
  type DictRule,
} from "./db";
import { applyRules } from "./dictionary";
import { hasSpeakableText } from "./highlight";
import {
  audioDownloadEnd,
  audioDownloadUpdate,
  hasNativeMedia,
  onMediaAction,
} from "./nativeMedia";
import { segmentChapter } from "./segment";
import type { ChapterMeta, NovelRow } from "../types";

/** voice settings a batch is pinned to; the audio cache is keyed by these. */
export interface AudioSettings {
  voice: string;
  rate: number;
  pitch: number;
}

export interface AudioDownloadJob {
  novelId: number;
  novelTitle: string;
  total: number;
  done: number;
  failed: number;
  state: "running" | "done" | "stopped";
  message: string;
  /** chapter being synthesized now, for per-row spinners. */
  currentChapterId: number | null;
  currentTitle: string;
  /** bumped when a chapter finishes, so screens can refresh their marks. */
  revision: number;
}

let job: AudioDownloadJob | null = null;
let cancelled = false;
const listeners = new Set<() => void>();

// stop button on the android notification.
if (typeof window !== "undefined") {
  onMediaAction((a) => {
    if (a === "audio-download-stop") cancelAudioDownload();
  });
}

export function subscribeAudioDownloads(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getAudioDownloadJob(): AudioDownloadJob | null {
  return job;
}

export function cancelAudioDownload(): void {
  cancelled = true;
}

export function dismissAudioDownload(): void {
  if (job && job.state !== "running") {
    job = null;
    emit();
  }
}

function emit() {
  for (const fn of listeners) fn();
}

function update(patch: Partial<AudioDownloadJob>) {
  if (!job) return;
  job = { ...job, ...patch };
  emit();
  // mirror into the android notification (no-op on desktop).
  if (hasNativeMedia()) {
    if (job.state === "running") {
      audioDownloadUpdate(
        job.novelTitle,
        job.currentTitle,
        job.done + job.failed,
        job.total,
      );
    } else {
      audioDownloadEnd();
    }
  }
}

/** synthesize one chapter's segments into the offline cache and record it. */
async function cacheChapter(
  novel: NovelRow,
  chapter: ChapterMeta,
  a: AudioSettings,
  rules: DictRule[],
): Promise<void> {
  const row = await getChapterRow(novel.id, chapter.idx);
  if (!row) throw new Error("chapter not found");
  let content = row.content;
  if (!content) {
    const cc = await getChapterContent(novel.source_id, row.chapter_url);
    content = cc.html;
    await saveChapterContent(row.id, content, cc.title);
  }
  // mirror playback so cache keys match: filter, then apply the dictionary.
  const texts = segmentChapter(content)
    .filter(hasSpeakableText)
    .map((s) => applyRules(s, rules));
  if (texts.length === 0) throw new Error("nothing to synthesize");
  const report = await cacheSegments(texts, a.voice, a.rate, a.pitch);
  await recordAudioDownload(
    chapter.id,
    novel.id,
    a.voice,
    a.rate,
    a.pitch,
    report.bytes,
    report.segments,
  );
}

/** download offline audio for `chapters` in order; false if one is already
 * running. stops at the first failure, which usually means the network went. */
export async function startAudioDownload(
  novel: NovelRow,
  chapters: ChapterMeta[],
  settings: AudioSettings,
  rules: DictRule[],
): Promise<boolean> {
  if (job?.state === "running") return false;

  cancelled = false;
  job = {
    novelId: novel.id,
    novelTitle: novel.title,
    total: chapters.length,
    done: 0,
    failed: 0,
    state: "running",
    message: "",
    currentChapterId: chapters[0]?.id ?? null,
    currentTitle: chapters[0]?.title ?? "",
    revision: 0,
  };
  emit();
  if (chapters.length === 0) {
    update({ state: "done", message: "Nothing to download." });
    return true;
  }

  for (const c of chapters) {
    if (cancelled) break;
    update({ currentChapterId: c.id, currentTitle: c.title });
    try {
      await cacheChapter(novel, c, settings, rules);
      update({ done: job.done + 1, revision: job.revision + 1 });
    } catch (e) {
      update({
        failed: job.failed + 1,
        state: "stopped",
        currentChapterId: null,
        message: `Stopped at ${c.title}: ${e}`,
      });
      return true;
    }
  }

  update({
    state: cancelled ? "stopped" : "done",
    currentChapterId: null,
    currentTitle: "",
    message: cancelled
      ? `Stopped — ${job.done} chapter${job.done === 1 ? "" : "s"} kept.`
      : `${job.done} chapter${job.done === 1 ? "" : "s"} ready for offline listening.`,
  });
  return true;
}
