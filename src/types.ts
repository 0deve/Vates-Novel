// Shared types mirroring the Rust structs in src-tauri/src/{sources,tts}.rs

export interface SourceInfo {
  id: string;
  name: string;
}

export interface SearchResult {
  source_id: string;
  novel_url: string;
  title: string;
  author: string | null;
  cover_url: string | null;
  chapter_count: number | null;
  status: string | null;
}

/** Chapter body plus its real title when the source page provides one. */
export interface ChapterContent {
  title: string | null;
  html: string;
}

export interface ChapterRef {
  chapter_url: string;
  index: number;
  title: string;
}

export interface NovelDetails {
  source_id: string;
  novel_url: string;
  title: string;
  author: string | null;
  cover_url: string | null;
  status: string | null;
  summary: string | null;
  chapters: ChapterRef[];
}

export interface VoiceInfo {
  /** Full voice name used by the Edge TTS API. */
  name: string;
  /** e.g. "en-US-AriaNeural" */
  short_name: string;
  locale: string;
  gender: string;
  friendly_name: string;
}

export interface WordBoundary {
  text: string;
  offset_ms: number;
  duration_ms: number;
}

export interface SynthesizeResult {
  audio_base64: string;
  mime: string;
  word_boundaries: WordBoundary[];
  /** True when served from the disk cache (no network involved). */
  cached: boolean;
}

/** A novel row as listed in the Library grid. */
export interface LibraryNovel {
  id: number;
  source_id: string;
  novel_url: string;
  title: string;
  author: string | null;
  cover_url: string | null;
  status: string | null;
  summary: string | null;
  chapter_count: number;
}

/** Full novel row including reading position and per-novel TTS settings. */
export interface NovelRow extends LibraryNovel {
  last_read_chapter: number | null;
  last_read_segment: number | null;
  tts_voice: string | null;
  tts_rate: number | null;
}

/** Chapter list entry on the Novel Details screen. */
export interface ChapterMeta {
  id: number;
  idx: number;
  title: string;
  downloaded: number; // sqlite boolean (0/1)
}
