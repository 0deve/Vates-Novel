// Small shared formatters.

/** Human-readable byte size (B / KB / MB). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** "842 words", "12,345 words", "1.2M words". */
export function formatWords(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M words`;
  if (n >= 100_000) return `${Math.round(n / 1000)}k words`;
  return `${n.toLocaleString()} words`;
}

/** "under 1 min", "45 min", "3 h 20 min", "52 h". */
export function formatMinutes(min: number): string {
  if (min < 1) return "under 1 min";
  if (min < 60) return `${Math.round(min)} min`;
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h >= 24 || m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** Neural voices speak about this many words a minute at 1.0x. */
export const TTS_BASE_WPM = 160;

/** Listening speed for a TTS rate offset (-50..200 = 0.5x..3x). */
export const ttsWpm = (rate: number) => TTS_BASE_WPM * Math.max(0.1, 1 + rate / 100);

export const countWords = (text: string) => (text.match(/\S+/g) ?? []).length;
