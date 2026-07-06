// Typed wrappers around the Tauri commands exposed by the Rust backend.
import { invoke } from "@tauri-apps/api/core";
import type {
  ChapterContent,
  ImportedNovel,
  NovelDetails,
  SearchResult,
  SourceInfo,
  SynthesizeResult,
  VoiceInfo,
} from "../types";

export const listSources = () => invoke<SourceInfo[]>("list_sources");

export const searchNovels = (sourceId: string, query: string) =>
  invoke<SearchResult[]>("search_novels", { sourceId, query });

export const getNovelDetails = (sourceId: string, novelUrl: string) =>
  invoke<NovelDetails>("get_novel_details", { sourceId, novelUrl });

export const getChapterContent = (sourceId: string, chapterUrl: string) =>
  invoke<ChapterContent>("get_chapter_content", { sourceId, chapterUrl });

export const listVoices = () => invoke<VoiceInfo[]>("list_voices");

export const synthesize = (
  text: string,
  voice: string,
  rate: number,
  pitch: number,
) => invoke<SynthesizeResult>("synthesize", { text, voice, rate, pitch });

/** Update the OS media overlay (SMTC/MPRIS). */
export const mediaUpdate = (title: string, artist: string, playing: boolean) =>
  invoke<void>("media_update", { title, artist, playing }).catch(() => {});

/** Open the folder holding the app's database (downloaded chapters live there). */
export const openDataFolder = () => invoke<void>("open_data_folder");

/** Parse a local .epub/.txt file into a fully self-contained novel.
 * Takes the file's raw bytes — the Rust side never sees a path, so this
 * works with Android's content:// picker URIs too. The name rides along in
 * a header (percent-encoded, since IPC headers must be ASCII). */
export const importLocalNovel = (fileName: string, bytes: Uint8Array) =>
  invoke<ImportedNovel>("import_local_novel", bytes, {
    headers: { "file-name": encodeURIComponent(fileName) },
  });

/** Export downloaded chapters to .epub or .txt; returns the file's bytes
 * for the caller to write out via plugin-fs. */
export const exportNovel = (
  format: "epub" | "txt",
  title: string,
  author: string | null,
  chapters: { title: string; html: string }[],
) => invoke<ArrayBuffer>("export_novel", { format, title, author, chapters });

/** Decode a base64 audio payload into an object URL playable by <audio>. */
export function audioUrlFromBase64(b64: string, mime: string): string {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}
