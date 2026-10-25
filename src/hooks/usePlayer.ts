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
import { hasSpeakableText } from "../lib/highlight";
import {
  deviceVoiceName,
  isDeviceVoice,
  speakDevice,
  splitWords,
  type SpeakHandle,
} from "../lib/nativeTts";
import type { SynthesizeResult, WordBoundary } from "../types";

export interface PlayerPosition {
  chapter: number; // ordinal
  segment: number;
}

interface PlayerOpts {
  voice: string;
  rate: number;
  pitch: number;
  getSegments: (chapterOrdinal: number) => Promise<string[] | null>;
  onSegmentStart?: (pos: PlayerPosition) => void;
  /** Applied to text before synthesis (pronunciation dictionary). */
  transform?: (text: string) => string;
}

// segments held in memory; enough for the prefetch and a replay or two, more
// is tens of mb of base64 the webview can't spare.
const CACHE_MAX = 12;

// device engines sometimes fail a single paragraph (odd characters, a voice
// hiccup); only a run of failures means the engine itself is gone.
const DEVICE_MAX_FAILS = 4;

export function usePlayer(opts: PlayerOpts) {
  const [pos, setPos] = useState<PlayerPosition | null>(null);
  const [playing, setPlaying] = useState(false);
  const [paused, setPaused] = useState(false);
  const [activeWord, setActiveWord] = useState(-1);
  const [boundaries, setBoundaries] = useState<WordBoundary[]>([]);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  // revoked when replaced: each url pins an mp3 in memory, and an hour of
  // playback leaks enough of them to get the renderer oom-killed.
  const audioUrlRef = useRef<string | null>(null);
  const deviceRef = useRef<SpeakHandle | null>(null);
  const tokenRef = useRef(0);
  const rafRef = useRef(0);
  const cacheRef = useRef(new Map<string, Promise<SynthesizeResult>>());
  const deviceFailsRef = useRef({ count: 0, last: "" });
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => () => stop(), []); // eslint-disable-line react-hooks/exhaustive-deps

  function cachedSynth(rawText: string): Promise<SynthesizeResult> {
    const { voice, rate, pitch, transform } = optsRef.current;
    const text = transform ? transform(rawText) : rawText;
    const key = `${voice}|${rate}|${pitch}|${text}`;
    const cache = cacheRef.current;
    let p = cache.get(key);
    if (!p) {
      p = synthesize(text, voice, rate, pitch);
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
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
    deviceRef.current?.stop();
    deviceRef.current = null;
    setActiveWord(-1);
  }

  function stop() {
    tokenRef.current++;
    deviceFailsRef.current = { count: 0, last: "" };
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

    // Load the next chapter's content from halfway through this one, so it's
    // ready well before the boundary even when loading is slow.
    if (segment >= segs.length / 2)
      void optsRef.current.getSegments(chapter + 1).catch(() => {});

    // Nothing to pronounce ("...", "* * *") → empty audio stalls the queue; skip.
    if (!hasSpeakableText(segs[segment])) return playAt(chapter, segment + 1);

    // Device (Android system) voices speak natively — no audio element, and
    // word highlighting comes from the engine's range callbacks instead of
    // synthesized word boundaries.
    if (isDeviceVoice(optsRef.current.voice)) {
      const { voice, rate, pitch, transform } = optsRef.current;
      const text = transform ? transform(segs[segment]) : segs[segment];
      const words = splitWords(text);
      setBoundaries(
        words.map((w) => ({ text: w.text, offset_ms: 0, duration_ms: 0 })),
      );
      const handle = speakDevice(text, deviceVoiceName(voice), rate, pitch, {
        onRange: (charStart) => {
          if (token !== tokenRef.current) return;
          let idx = -1;
          for (let i = 0; i < words.length; i++) {
            if (words[i].offset <= charStart) idx = i;
            else break;
          }
          setActiveWord(idx);
        },
        onDone: () => {
          if (token !== tokenRef.current) return;
          deviceFailsRef.current = { count: 0, last: "" };
          void playAt(chapter, segment + 1);
        },
        onError: () => {
          if (token !== tokenRef.current) return;
          // retry a paragraph once, then skip it
          const fails = deviceFailsRef.current;
          const key = `${chapter}:${segment}`;
          const retry = fails.last !== key;
          deviceFailsRef.current = { count: fails.count + 1, last: key };
          if (fails.count + 1 >= DEVICE_MAX_FAILS) stop();
          else void playAt(chapter, retry ? segment : segment + 1);
        },
      });
      if (!handle) {
        if (token === tokenRef.current) stop();
        return;
      }
      deviceRef.current = handle;
      return;
    }

    let res: SynthesizeResult;
    try {
      res = await cachedSynth(segs[segment]);
    } catch {
      if (token === tokenRef.current) stop();
      return;
    }
    if (token !== tokenRef.current) return;

    // Empty audio never fires `onended`; advance instead of stalling.
    if (!res.audio_base64) return playAt(chapter, segment + 1);

    setBoundaries(res.word_boundaries);
    const url = audioUrlFromBase64(res.audio_base64, res.mime);
    const audio = new Audio(url);
    audioRef.current = audio;
    audioUrlRef.current = url;

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
    // The device engine has no pause: pause stops speech but keeps the
    // position, resume re-speaks the current segment from its start.
    if (deviceRef.current) {
      tokenRef.current++;
      deviceRef.current.stop();
      deviceRef.current = null;
      cancelAnimationFrame(rafRef.current);
      setActiveWord(-1);
      setPaused(true);
      return;
    }
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
