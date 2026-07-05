// Typed wrappers around the Tauri commands exposed by the Rust backend.
import { invoke } from "@tauri-apps/api/core";
import type {
  ChapterContent,
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

/** Decode a base64 audio payload into an object URL playable by <audio>. */
export function audioUrlFromBase64(b64: string, mime: string): string {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return URL.createObjectURL(new Blob([bytes], { type: mime }));
}
