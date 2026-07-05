// TTS playback engine (implementation.md §4).
//
// Plays paragraph segments sequentially with:
//  - in-memory synthesis cache + next-segment prefetch (gapless playback)
//  - WordBoundary-driven active-word tracking
//  - automatic continuation into the next chapter
//
// Chapters are addressed by ORDINAL (0-based position in the sorted chapter
// list); the host supplies `getSegments(ordinal)` and returns null past the
// last chapter.
import { useEffect, useRef, useState } from "react";
import { audioUrlFromBase64, synthesize } from "../lib/api";
import type { SynthesizeResult, WordBoundary } from "../types";

export interface PlayerPosition {
  chapter: number; // ordinal
  segment: number;
}

interface PlayerOpts {
  voice: string;
  rate: number;
  getSegments: (chapterOrdinal: number) => Promise<string[] | null>;
  onSegmentStart?: (pos: PlayerPosition) => void;
  /** Applied to text before synthesis (pronunciation dictionary). */
  transform?: (text: string) => string;
}

const CACHE_MAX = 40;

export function usePlayer(opts: PlayerOpts) {
  const [pos, setPos] = useState<PlayerPosition | null>(null);
  const [playing, setPlaying] = useState(false);
  const [paused, setPaused] = useState(false);
  const [activeWord, setActiveWord] = useState(-1);
  const [boundaries, setBoundaries] = useState<WordBoundary[]>([]);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const tokenRef = useRef(0);
  const rafRef = useRef(0);
  const cacheRef = useRef(new Map<string, Promise<SynthesizeResult>>());
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => () => stop(), []); // eslint-disable-line react-hooks/exhaustive-deps

  function cachedSynth(rawText: string): Promise<SynthesizeResult> {
    const { voice, rate, transform } = optsRef.current;
    const text = transform ? transform(rawText) : rawText;
    const key = `${voice}|${rate}|${text}`;
    const cache = cacheRef.current;
    let p = cache.get(key);
    if (!p) {
      p = synthesize(text, voice, rate, 0);
      // Drop failed synths so retries re-request instead of replaying an error.
      p.catch(() => cache.delete(key));
      if (cache.size >= CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(key, p);
    }
    return p;
  }

  function stopAudio() {
    cancelAnimationFrame(rafRef.current);
    audioRef.current?.pause();
    audioRef.current = null;
    setActiveWord(-1);
  }

  function stop() {
    tokenRef.current++;
    stopAudio();
    setPlaying(false);
    setPaused(false);
  }

  async function playAt(chapter: number, segment: number): Promise<void> {
    const token = ++tokenRef.current;
    stopAudio();
    setPlaying(true);
    setPaused(false);

    let segs: string[] | null = null;
    try {
      segs = await optsRef.current.getSegments(chapter);
    } catch {
      segs = null;
    }
    if (token !== tokenRef.current) return;
    if (!segs || segs.length === 0) {
      stop(); // past the last chapter (or it failed to load)
      return;
    }
    if (segment >= segs.length) return playAt(chapter + 1, 0);
    if (segment < 0) segment = 0;

    setPos({ chapter, segment });
    optsRef.current.onSegmentStart?.({ chapter, segment });

    let res: SynthesizeResult;
    try {
      res = await cachedSynth(segs[segment]);
    } catch {
      if (token === tokenRef.current) stop();
      return;
    }
    if (token !== tokenRef.current) return;

    setBoundaries(res.word_boundaries);
    const audio = new Audio(audioUrlFromBase64(res.audio_base64, res.mime));
    audioRef.current = audio;

    const tick = () => {
      const ms = audio.currentTime * 1000;
      let idx = -1;
      for (let i = 0; i < res.word_boundaries.length; i++) {
        if (res.word_boundaries[i].offset_ms <= ms) idx = i;
        else break;
      }
      setActiveWord(idx);
      if (!audio.ended && token === tokenRef.current)
        rafRef.current = requestAnimationFrame(tick);
    };
    audio.onplay = () => (rafRef.current = requestAnimationFrame(tick));
    audio.onended = () => {
      if (token === tokenRef.current) void playAt(chapter, segment + 1);
    };
    try {
      await audio.play();
    } catch {
      if (token === tokenRef.current) stop();
      return;
    }

    // Prefetch: next segment, or first segment of the next chapter when at
    // the end (this also pre-loads the next chapter's content).
    const nextText =
      segs[segment + 1] ??
      (await optsRef.current
        .getSegments(chapter + 1)
        .then((s) => s?.[0])
        .catch(() => undefined));
    if (nextText && token === tokenRef.current)
      void cachedSynth(nextText).catch(() => {});
  }

  function toggle() {
    const audio = audioRef.current;
    if (!audio) {
      if (pos) void playAt(pos.chapter, pos.segment);
      return;
    }
    if (audio.paused) {
      void audio.play();
      setPaused(false);
    } else {
      audio.pause();
      setPaused(true);
    }
  }

  function next() {
    if (pos) void playAt(pos.chapter, pos.segment + 1);
  }

  function prev() {
    if (!pos) return;
    if (pos.segment > 0) void playAt(pos.chapter, pos.segment - 1);
    else void playAt(pos.chapter, 0);
  }

  return {
    pos,
    playing,
    paused,
    activeWord,
    boundaries,
    playAt,
    stop,
    toggle,
    next,
    prev,
  };
}
