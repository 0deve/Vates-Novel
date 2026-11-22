// Typed wrappers around the Tauri commands exposed by the Rust backend.
import { invoke } from "@tauri-apps/api/core";
import type {
  CacheReport,
  ChapterContent,
  ImportedNovel,
  NovelDetails,
  SearchResult,
  SourceInfo,
  SynthesizeResult,
  VoiceInfo,
} from "../types";

let sourcesPromise: Promise<SourceInfo[]> | null = null;
/** Cached: the source set is fixed for the life of the build. */
export const listSources = (): Promise<SourceInfo[]> => {
  if (!sourcesPromise) {
    sourcesPromise = invoke<SourceInfo[]>("list_sources");
    sourcesPromise.catch(() => (sourcesPromise = null));
  }
  return sourcesPromise;
};

export const isBookSource = async (sourceId: string) =>
  (await listSources()).some((s) => s.id === sourceId && s.kind === "book");

export interface BookImport {
  novel: ImportedNovel;
  details: NovelDetails;
  file_path: string;
}

export const addBook = (sourceId: string, bookUrl: string) =>
  invoke<BookImport>("add_book", { sourceId, bookUrl });

export const readBookFile = (path: string) => invoke<number[]>("read_book_file", { path });

export const searchNovels = (sourceId: string, query: string) =>
  invoke<SearchResult[]>("search_novels", { sourceId, query });

export const getNovelDetails = (sourceId: string, novelUrl: string) =>
  invoke<NovelDetails>("get_novel_details", { sourceId, novelUrl });

/** Fetch a chapter from its source. With the page hidden it arrives as a JSON
 * string, which Android hands to a hidden webview right away instead of
 * deferring it (see get_chapter_content_inline). */
export async function getChapterContent(
  sourceId: string,
  chapterUrl: string,
): Promise<ChapterContent> {
  if (!document.hidden)
    return invoke<ChapterContent>("get_chapter_content", { sourceId, chapterUrl });
  const json = await invoke<string>("get_chapter_content_inline", {
    sourceId,
    chapterUrl,
  });
  return JSON.parse(json) as ChapterContent;
}

// the list is a network round-trip that rarely changes; fetch it once per run.
let voicesPromise: Promise<VoiceInfo[]> | null = null;
export const listVoices = (): Promise<VoiceInfo[]> => {
  if (!voicesPromise) {
    const p = invoke<VoiceInfo[]>("list_voices");
    p.catch(() => {
      if (voicesPromise === p) voicesPromise = null;
    });
    voicesPromise = p;
  }
  return voicesPromise;
};

export const synthesize = (
  text: string,
  voice: string,
  rate: number,
  pitch: number,
) => invoke<SynthesizeResult>("synthesize", { text, voice, rate, pitch });

/** Cache a chapter's segments for offline playback. Segments must be
 * dictionary-transformed and speakable-filtered so keys match playback. */
export const cacheSegments = (
  segments: string[],
  voice: string,
  rate: number,
  pitch: number,
) => invoke<CacheReport>("cache_segments", { segments, voice, rate, pitch });

/** Update the OS media overlay (SMTC/MPRIS). */
export const mediaUpdate = (title: string, artist: string, playing: boolean) =>
  invoke<void>("media_update", { title, artist, playing }).catch(() => {});

/** Open the folder holding the app's database (downloaded chapters live there). */
export const openDataFolder = () => invoke<void>("open_data_folder");

/** Chunked because spreading a whole file into fromCharCode overflows the stack. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** Parse a local .epub/.pdf/.txt file into a fully self-contained novel.
 * Takes the file's bytes — the Rust side never sees a path, so this works
 * with Android's content:// picker URIs too. Base64, since Android's IPC
 * can't carry a raw body. */
export const importLocalNovel = (
  fileName: string,
  bytes: Uint8Array,
  options: { clean: boolean; skipExtras: boolean },
) =>
  invoke<ImportedNovel>("import_local_novel", {
    fileName,
    dataBase64: bytesToBase64(bytes),
    options,
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

export interface CoverHit {
  url: string;
  title: string;
  author: string | null;
  source: string;
}

export const searchCovers = (query: string) => invoke<CoverHit[]>("search_covers", { query });

/** Remote image as a data: URL (canvas-safe). */
export const fetchImage = (url: string) => invoke<string>("fetch_image", { url });
