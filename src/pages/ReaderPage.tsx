// Seamless reader (implementation.md §3D/E): infinite chapter scroll, TTS with
// word-level highlighting, auto-scroll, exact position persistence.
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { getChapterContent, listVoices, mediaUpdate } from "../lib/api";
import {
  fetchChapterMeta,
  fetchNovel,
  fetchRules,
  getChapterRow,
  saveChapterContent,
  savePosition,
  saveTtsSettings,
  touchLastRead,
  type DictRule,
} from "../lib/db";
import { applyRules } from "../lib/dictionary";
import { segmentChapter } from "../lib/segment";
import {
  FONT_FAMILIES,
  loadReaderSettings,
  TEXT_COLORS,
  TEXT_WIDTHS,
} from "../lib/settings";
import {
  NextIcon,
  PauseIcon,
  PlayIcon,
  PrevIcon,
  TuneIcon,
} from "../components/icons";
import { usePlayer } from "../hooks/usePlayer";
import {
  DEVICE_VOICE_PREFIX,
  hasDeviceTts,
  isDeviceVoice,
  listDeviceVoices,
  onDeviceTtsReady,
  type DeviceVoice,
} from "../lib/nativeTts";
import {
  onMediaAction,
  playbackStop,
  playbackUpdate,
} from "../lib/nativeMedia";
import type { ChapterMeta, NovelRow, VoiceInfo } from "../types";

interface LoadedChapter {
  ordinal: number;
  idx: number;
  title: string;
  segments: string[];
}

type SleepMode = "off" | "15" | "30" | "60" | "chapter";

interface Props {
  novelId: number;
  startChapterIdx: number | null; // source chapter idx (novels.last_read_chapter)
  startSegment: number | null;
  onBack: () => void;
}

export default function ReaderPage({
  novelId,
  startChapterIdx,
  startSegment,
  onBack,
}: Props) {
  const [novel, setNovel] = useState<NovelRow | null>(null);
  const [meta, setMeta] = useState<ChapterMeta[]>([]);
  const [loaded, setLoaded] = useState<LoadedChapter[]>([]);
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [deviceVoices, setDeviceVoices] = useState<DeviceVoice[]>([]);
  const [voice, setVoice] = useState("");
  const [rate, setRate] = useState(0);
  const [pitch, setPitch] = useState(0);
  const [error, setError] = useState("");
  const [sleep, setSleep] = useState<SleepMode>("off");
  // Phone-width popover holding the voice/speed/pitch/sleep controls that
  // live inline in the footer on wider screens.
  const [ttsOpen, setTtsOpen] = useState(false);

  const rulesRef = useRef<DictRule[]>([]);
  const sleepRef = useRef<SleepMode>("off");
  const sleepTimerRef = useRef<number | undefined>(undefined);
  const sleepChapterRef = useRef<number | null>(null);
  const metaRef = useRef<ChapterMeta[]>([]);
  const novelRef = useRef<NovelRow | null>(null);
  // The chapter ordinal the reader has actually "committed" to as the
  // reading position (drives the completion bar / Continue Reading). Only
  // advances — see the scroll-tracking effect below for the two rules that
  // update it.
  const confirmedOrdinalRef = useRef(0);
  const chapterCache = useRef(new Map<number, Promise<string[] | null>>());
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const topSentinelRef = useRef<HTMLDivElement | null>(null);
  const prependAnchorRef = useRef<{ top: number; height: number } | null>(null);
  const prependingRef = useRef(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [rs] = useState(loadReaderSettings);

  /** Load chapter content (DB first, then live from source) and segment it. */
  const ensureChapter = useCallback(
    (ordinal: number): Promise<string[] | null> => {
      const cached = chapterCache.current.get(ordinal);
      if (cached) return cached;

      const p = (async () => {
        const m = metaRef.current[ordinal];
        const n = novelRef.current;
        if (!m || !n) return null;

        const row = await getChapterRow(novelId, m.idx);
        if (!row) return null;
        let content = row.content;
        let title = m.title;
        if (!content) {
          const cc = await getChapterContent(n.source_id, row.chapter_url);
          content = cc.html;
          void saveChapterContent(row.id, content, cc.title);
          // Upgrade synthesized "Chapter N" placeholders with the real title.
          if (cc.title && cc.title !== title) {
            title = cc.title;
            metaRef.current = metaRef.current.map((c, i) =>
              i === ordinal ? { ...c, title: cc.title! } : c,
            );
            setMeta(metaRef.current);
          }
        }
        const segments = segmentChapter(content);
        setLoaded((prev) =>
          prev.some((c) => c.ordinal === ordinal)
            ? prev
            : [...prev, { ordinal, idx: m.idx, title, segments }].sort(
                (a, b) => a.ordinal - b.ordinal,
              ),
        );
        return segments;
      })();
      // Allow retry after transient failures (e.g. offline).
      p.catch(() => chapterCache.current.delete(ordinal));
      chapterCache.current.set(ordinal, p);
      return p;
    },
    [novelId],
  );

  const player = usePlayer({
    voice,
    rate,
    pitch,
    getSegments: ensureChapter,
    transform: (text) => applyRules(text, rulesRef.current),
    onSegmentStart: ({ chapter, segment }) => {
      // Only persist position for the confirmed current chapter, or the
      // chapter immediately after it (a natural continuation). Playing a
      // segment in some other, jumped-to chapter is just a preview — it
      // doesn't touch the saved reading position until the reader actually
      // scrolls through to that chapter's end (handled below).
      if (chapter === confirmedOrdinalRef.current + 1) {
        confirmedOrdinalRef.current = chapter;
      }
      if (chapter === confirmedOrdinalRef.current) {
        const m = metaRef.current[chapter];
        if (m) void savePosition(novelId, m.idx, segment);
      }
      // "End of chapter" sleep timer: stop when playback crosses into a
      // chapter other than the one armed.
      if (
        sleepRef.current === "chapter" &&
        sleepChapterRef.current !== null &&
        chapter !== sleepChapterRef.current
      ) {
        setSleepMode("off");
        playerRef.current.stop();
      }
    },
  });
  const playerRef = useRef(player);
  playerRef.current = player;

  function setSleepMode(mode: SleepMode) {
    window.clearTimeout(sleepTimerRef.current);
    sleepChapterRef.current = null;
    sleepRef.current = mode;
    setSleep(mode);
    if (mode === "15" || mode === "30" || mode === "60") {
      sleepTimerRef.current = window.setTimeout(
        () => {
          sleepRef.current = "off";
          setSleep("off");
          playerRef.current.stop();
        },
        Number(mode) * 60_000,
      );
    } else if (mode === "chapter") {
      sleepChapterRef.current =
        playerRef.current.pos?.chapter ?? loaded[0]?.ordinal ?? null;
    }
  }

  // Clear any pending sleep timer on unmount.
  useEffect(() => () => window.clearTimeout(sleepTimerRef.current), []);

  // The device TTS engine initializes asynchronously at app start; if the
  // reader opened first, pick up its voice list once it's ready.
  useEffect(() => {
    if (!hasDeviceTts()) return;
    return onDeviceTtsReady(() =>
      setDeviceVoices(
        listDeviceVoices().filter(
          (v) => v.locale.toLowerCase().startsWith("en") && !v.network,
        ),
      ),
    );
  }, []);

  // OS media keys (SMTC/MPRIS) → player actions.
  useEffect(() => {
    const unlisten = listen<string>("media-control", (e) => {
      const p = playerRef.current;
      if (e.payload === "toggle" || e.payload === "play" || e.payload === "pause")
        p.toggle();
      else if (e.payload === "next") p.next();
      else if (e.payload === "prev") p.prev();
      else if (e.payload === "stop") p.stop();
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  // Android notification / lock-screen buttons → player actions.
  useEffect(
    () =>
      onMediaAction((a) => {
        const p = playerRef.current;
        if (a === "toggle") p.toggle();
        else if (a === "next") p.next();
        else if (a === "prev") p.prev();
        else if (a === "stop") p.stop();
      }),
    [],
  );

  // Remove the playback notification when the reader closes.
  useEffect(() => () => playbackStop(), []);

  // Keep the OS media overlay (desktop) and the Android playback
  // notification in sync with what's playing.
  useEffect(() => {
    if (!novel) return;
    const chapterTitle = player.pos
      ? (metaRef.current[player.pos.chapter]?.title ?? "")
      : "";
    void mediaUpdate(
      novel.title,
      chapterTitle,
      player.playing && !player.paused,
    );
    if (player.playing) {
      playbackUpdate(novel.title, chapterTitle, !player.paused);
    } else {
      playbackStop();
    }
  }, [novel, player.pos, player.playing, player.paused]);

  // Initial load: novel, chapter list, voices, TTS settings, start position.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [n, chapters, allVoices, rules] = await Promise.all([
          fetchNovel(novelId),
          fetchChapterMeta(novelId),
          // Voice listing needs the network; offline it must not take the
          // whole reader down — device voices still work.
          listVoices().catch(() => [] as VoiceInfo[]),
          fetchRules(novelId),
        ]);
        if (cancelled) return;
        rulesRef.current = rules;
        novelRef.current = n;
        metaRef.current = chapters;
        setNovel(n);
        setMeta(chapters);
        void touchLastRead(novelId);

        const en = allVoices.filter((v) => v.locale.startsWith("en-"));
        setVoices(en);
        const dev = hasDeviceTts()
          ? listDeviceVoices().filter(
              (v) => v.locale.toLowerCase().startsWith("en") && !v.network,
            )
          : [];
        setDeviceVoices(dev);
        // A saved device voice stays selected even before the engine has
        // reported its voice list — the engine falls back to its default if
        // the exact voice is gone.
        const savedName = n.tts_voice ?? "";
        const savedOk = savedName
          ? isDeviceVoice(savedName)
            ? hasDeviceTts()
            : en.some((v) => v.name === savedName)
          : false;
        const aria = en.find((v) => v.short_name === "en-US-AriaNeural");
        setVoice(
          savedOk
            ? savedName
            : ((aria ?? en[0])?.name ??
                (dev[0] ? DEVICE_VOICE_PREFIX + dev[0].name : "")),
        );
        setRate(n.tts_rate ?? 0);
        setPitch(n.tts_pitch ?? 0);

        const wantIdx = startChapterIdx ?? n.last_read_chapter;
        let ordinal = chapters.findIndex((c) => c.idx === wantIdx);
        if (ordinal < 0) ordinal = 0;
        confirmedOrdinalRef.current = ordinal;
        await ensureChapter(ordinal);

        // Restore exact position: scroll the saved segment into view.
        const seg = startSegment ?? n.last_read_segment ?? 0;
        requestAnimationFrame(() => {
          document
            .querySelector(`[data-seg="${ordinal}-${seg}"]`)
            ?.scrollIntoView({ block: "center" });
        });
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [novelId, startChapterIdx, startSegment, ensureChapter]);

  // Scroll UP: top sentinel loads the previous chapter; scroll position is
  // anchored (see useLayoutEffect below) so the view doesn't jump.
  useEffect(() => {
    const el = topSentinelRef.current;
    const container = containerRef.current;
    if (!el || !container || loaded.length === 0) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries[0].isIntersecting || prependingRef.current) return;
        const first = loaded[0];
        if (first.ordinal === 0) return;
        prependingRef.current = true;
        prependAnchorRef.current = {
          top: container.scrollTop,
          height: container.scrollHeight,
        };
        void ensureChapter(first.ordinal - 1)
          .catch(() => {
            prependAnchorRef.current = null;
          })
          .finally(() => {
            prependingRef.current = false;
          });
      },
      { root: container, rootMargin: "200px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [loaded, ensureChapter]);

  // After a prepend renders, restore the visual position.
  useLayoutEffect(() => {
    const container = containerRef.current;
    const anchor = prependAnchorRef.current;
    if (!container || !anchor) return;
    const delta = container.scrollHeight - anchor.height;
    if (delta > 0) container.scrollTop = anchor.top + delta;
    prependAnchorRef.current = null;
  }, [loaded]);

  // Track reading position from scrolling alone (not just TTS playback), with
  // two rules so a stray click into a far-off chapter can't clobber it:
  //  1. Reaching the true end of a chapter commits it as the current one.
  //  2. Scrolling from the confirmed chapter into the very next one commits
  //     that next chapter immediately — a natural continuation, not a jump.
  // The position only ever advances, never regresses (e.g. re-reading an
  // earlier chapter to its end doesn't roll progress backwards).
  useEffect(() => {
    const container = containerRef.current;
    if (!container || loaded.length === 0) return;

    const commit = (ordinal: number) => {
      if (!Number.isFinite(ordinal) || ordinal <= confirmedOrdinalRef.current)
        return;
      confirmedOrdinalRef.current = ordinal;
      const idx = metaRef.current[ordinal]?.idx;
      if (idx !== undefined) void savePosition(novelId, idx, 0);
    };

    const startIo = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const ordinal = Number((e.target as HTMLElement).dataset.chapterStart);
          if (ordinal === confirmedOrdinalRef.current + 1) commit(ordinal);
        }
      },
      { root: container, rootMargin: "-45% 0px -45% 0px" },
    );
    const endIo = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting)
            commit(Number((e.target as HTMLElement).dataset.chapterEnd));
        }
      },
      { root: container },
    );

    container
      .querySelectorAll<HTMLElement>("[data-chapter-start]")
      .forEach((el) => startIo.observe(el));
    container
      .querySelectorAll<HTMLElement>("[data-chapter-end]")
      .forEach((el) => endIo.observe(el));

    return () => {
      startIo.disconnect();
      endIo.disconnect();
    };
  }, [loaded, novelId]);

  // Infinite scroll: sentinel near the bottom loads the next chapter.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || loaded.length === 0) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          const last = loaded[loaded.length - 1];
          if (last.ordinal + 1 < metaRef.current.length)
            void ensureChapter(last.ordinal + 1);
        }
      },
      { root: containerRef.current, rootMargin: "600px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [loaded, ensureChapter]);

  // Auto-prefetch: silently download the next few chapters' content in the
  // background as the reading frontier advances, so an offline moment
  // doesn't hit a "not downloaded" wall. Off by default (Settings).
  useEffect(() => {
    if (rs.prefetch <= 0 || loaded.length === 0) return;
    const n = novelRef.current;
    if (!n) return;
    const lastOrdinal = loaded[loaded.length - 1].ordinal;
    let cancelled = false;
    (async () => {
      for (let o = lastOrdinal + 1; o <= lastOrdinal + rs.prefetch; o++) {
        if (cancelled) return;
        const m = metaRef.current[o];
        if (!m) break;
        try {
          const row = await getChapterRow(novelId, m.idx);
          if (cancelled || !row || row.content) continue;
          const cc = await getChapterContent(n.source_id, row.chapter_url);
          if (cancelled) return;
          await saveChapterContent(row.id, cc.html, cc.title);
        } catch {
          return; // offline / rate-limited / no live source — stop silently
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loaded, novelId, rs.prefetch]);

  // Auto-scroll: keep the active segment centered while playing.
  useEffect(() => {
    if (!player.pos || !player.playing) return;
    document
      .querySelector(`[data-seg="${player.pos.chapter}-${player.pos.segment}"]`)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [player.pos, player.playing]);

  // Persist per-novel TTS settings; restart current segment on change.
  useEffect(() => {
    if (!voice || !novel) return;
    void saveTtsSettings(novelId, voice, rate, pitch);
    const p = playerRef.current;
    if (p.playing && p.pos) void p.playAt(p.pos.chapter, p.pos.segment);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice, rate, pitch]);

  // Keyboard shortcuts (implementation.md §6).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && e.target.closest("input,select,textarea"))
        return;
      const p = playerRef.current;
      if (e.code === "Space") {
        e.preventDefault();
        p.toggle();
      } else if (e.key === "ArrowRight") p.next();
      else if (e.key === "ArrowLeft") p.prev();
      else if (e.key === "Escape") {
        p.stop();
        onBack();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  if (error)
    return (
      <div className="p-8 text-red-400">
        <button onClick={onBack} className="mb-4 text-zinc-400 hover:text-white">
          Back
        </button>
        <p>{error}</p>
      </div>
    );

  const active = player.pos;

  // Shared by the desktop inline select and the phone popover select.
  const voiceOptions = (
    <>
      {voices.length > 0 && (
        <optgroup label="Edge voices (online)">
          {voices.map((v) => (
            <option key={v.short_name} value={v.name}>
              {v.short_name}
            </option>
          ))}
        </optgroup>
      )}
      {deviceVoices.length > 0 && (
        <optgroup label="Device voices (offline)">
          {deviceVoices.map((d) => (
            <option key={d.name} value={DEVICE_VOICE_PREFIX + d.name}>
              {d.name}
            </option>
          ))}
        </optgroup>
      )}
    </>
  );

  return (
    <div className="flex h-screen flex-col">
      {/* Top bar */}
      <header className="flex items-center gap-3 border-b border-zinc-800 bg-zinc-900 px-4 py-2">
        <button
          onClick={() => {
            player.stop();
            onBack();
          }}
          className="rounded px-3 py-2 text-sm text-zinc-400 hover:bg-zinc-800 hover:text-white"
        >
          Back
        </button>
        <div className="truncate text-sm font-medium">{novel?.title}</div>
      </header>

      {/* Text column. The width setting caps the column with max-width on
          wide screens; on a phone every option is wider than the viewport,
          so there it maps to horizontal padding instead. */}
      <div ref={containerRef} className="flex-1 overflow-y-auto">
        <div
          className={`mx-auto w-full py-8 md:px-10 ${
            { full: "px-4", medium: "px-8", narrow: "px-12" }[rs.width]
          }`}
          style={{ maxWidth: TEXT_WIDTHS[rs.width] }}
        >
          <div ref={topSentinelRef} className="h-1" />
          {loaded.length > 0 && loaded[0].ordinal > 0 && (
            <p className="pb-6 text-center text-xs text-zinc-600">
              Scroll up to load the previous chapter
            </p>
          )}
          {loaded.map((ch) => (
            <section key={ch.ordinal} data-chapter-start={ch.ordinal}>
              <div className="my-10 flex items-center gap-4">
                <span className="h-px flex-1 bg-zinc-800" />
                <h3 className="shrink-0 text-sm font-semibold tracking-wide text-zinc-500">
                  {ch.title}
                </h3>
                <span className="h-px flex-1 bg-zinc-800" />
              </div>
              {ch.segments.map((text, si) => {
                const isActive =
                  active?.chapter === ch.ordinal && active?.segment === si;
                return (
                  <p
                    key={si}
                    data-seg={`${ch.ordinal}-${si}`}
                    onClick={() => void player.playAt(ch.ordinal, si)}
                    className={`mb-4 cursor-pointer rounded px-2 py-1 transition-colors ${
                      isActive ? "bg-zinc-900" : "hover:bg-zinc-900/50"
                    }`}
                    style={{
                      fontSize: rs.fontSize,
                      lineHeight: rs.lineHeight,
                      fontFamily: FONT_FAMILIES[rs.font]?.css,
                      color: TEXT_COLORS[rs.color]?.css,
                    }}
                  >
                    {isActive && player.boundaries.length > 0
                      ? player.boundaries.map((b, wi) => (
                          <span
                            key={wi}
                            className={
                              wi === player.activeWord
                                ? "rounded bg-orange-600 text-white"
                                : ""
                            }
                          >
                            {b.text}{" "}
                          </span>
                        ))
                      : text}
                  </p>
                );
              })}
              <div data-chapter-end={ch.ordinal} className="h-px" />
            </section>
          ))}
          <div ref={sentinelRef} className="h-8" />
          {loaded.length > 0 &&
            loaded[loaded.length - 1].ordinal + 1 >= meta.length && (
              <p className="py-8 text-center text-sm text-zinc-600">
                — End of available chapters —
              </p>
            )}
        </div>
      </div>

      {/* Player bar. Voice/speed/pitch/sleep sit inline on wide screens and
          fold into a popover panel above the bar on phone widths. */}
      <footer className="relative border-t border-zinc-800 bg-zinc-900">
        {ttsOpen && (
          <div className="absolute inset-x-0 bottom-full space-y-3 border-t border-zinc-800 bg-zinc-900 p-4 shadow-[0_-8px_24px_rgba(0,0,0,0.5)] md:hidden">
            <select
              value={voice}
              onChange={(e) => setVoice(e.target.value)}
              className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-2 text-sm"
            >
              {voiceOptions}
            </select>
            <label className="flex items-center gap-3 text-sm text-zinc-400">
              <span className="w-12 shrink-0">Speed</span>
              <input
                type="range"
                min={-50}
                max={200}
                step={10}
                value={rate}
                onChange={(e) => setRate(Number(e.target.value))}
                className="min-w-0 flex-1"
              />
              <span className="w-10 shrink-0 text-right tabular-nums">
                {(1 + rate / 100).toFixed(1)}x
              </span>
            </label>
            <label className="flex items-center gap-3 text-sm text-zinc-400">
              <span className="w-12 shrink-0">Pitch</span>
              <input
                type="range"
                min={-50}
                max={50}
                step={5}
                value={pitch}
                onChange={(e) => setPitch(Number(e.target.value))}
                className="min-w-0 flex-1"
              />
              <span className="w-10 shrink-0 text-right tabular-nums">
                {pitch > 0 ? `+${pitch}Hz` : `${pitch}Hz`}
              </span>
            </label>
            <label className="flex items-center gap-3 text-sm text-zinc-400">
              <span className="w-12 shrink-0">Sleep</span>
              <select
                value={sleep}
                onChange={(e) => setSleepMode(e.target.value as SleepMode)}
                className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-2 text-sm"
              >
                <option value="off">Off</option>
                <option value="15">15 min</option>
                <option value="30">30 min</option>
                <option value="60">60 min</option>
                <option value="chapter">End of chapter</option>
              </select>
            </label>
          </div>
        )}

        <div className="flex items-center gap-2 px-3 py-2 md:gap-3 md:px-4">
          <button
            onClick={() => {
              if (player.playing) player.toggle();
              else if (active) void player.playAt(active.chapter, active.segment);
              else if (loaded[0]) void player.playAt(loaded[0].ordinal, 0);
            }}
            className="flex items-center gap-2 rounded-md bg-orange-600 px-4 py-1.5 text-sm font-medium hover:bg-orange-500"
            title="Play/Pause (Space)"
          >
            {player.playing && !player.paused ? (
              <>
                <PauseIcon /> Pause
              </>
            ) : (
              <>
                <PlayIcon /> Play
              </>
            )}
          </button>
          <button
            onClick={() => player.prev()}
            className="rounded p-2.5 text-zinc-400 hover:bg-zinc-800"
            title="Previous segment (Left arrow)"
          >
            <PrevIcon />
          </button>
          <button
            onClick={() => player.next()}
            className="rounded p-2.5 text-zinc-400 hover:bg-zinc-800"
            title="Next segment (Right arrow)"
          >
            <NextIcon />
          </button>

          <div className="hidden min-w-0 flex-1 items-center gap-3 md:flex">
            <select
              value={voice}
              onChange={(e) => setVoice(e.target.value)}
              className="max-w-56 rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs"
            >
              {voiceOptions}
            </select>
            <label className="flex items-center gap-2 text-xs text-zinc-400">
              <input
                type="range"
                min={-50}
                max={200}
                step={10}
                value={rate}
                onChange={(e) => setRate(Number(e.target.value))}
                className="w-24"
              />
              <span className="w-8 tabular-nums">
                {(1 + rate / 100).toFixed(1)}x
              </span>
            </label>
            <label
              className="flex items-center gap-2 text-xs text-zinc-400"
              title="Voice pitch"
            >
              <input
                type="range"
                min={-50}
                max={50}
                step={5}
                value={pitch}
                onChange={(e) => setPitch(Number(e.target.value))}
                className="w-24"
              />
              <span className="w-10 tabular-nums">
                {pitch > 0 ? `+${pitch}Hz` : `${pitch}Hz`}
              </span>
            </label>
            <label
              className="flex items-center gap-1.5 text-xs text-zinc-400"
              title="Sleep timer"
            >
              Sleep
              <select
                value={sleep}
                onChange={(e) => setSleepMode(e.target.value as SleepMode)}
                className="rounded-md border border-zinc-700 bg-zinc-950 px-1 py-1.5 text-xs"
              >
                <option value="off">Off</option>
                <option value="15">15 min</option>
                <option value="30">30 min</option>
                <option value="60">60 min</option>
                <option value="chapter">End of chapter</option>
              </select>
            </label>
            {active && (
              <span className="ml-auto truncate text-xs text-zinc-500">
                {meta[active.chapter]?.title} · ¶{active.segment + 1}
              </span>
            )}
          </div>

          {active && (
            <span className="min-w-0 flex-1 truncate text-right text-xs text-zinc-500 md:hidden">
              {meta[active.chapter]?.title}
            </span>
          )}
          <button
            onClick={() => setTtsOpen((v) => !v)}
            className={`ml-auto rounded p-2.5 md:hidden ${
              ttsOpen
                ? "bg-zinc-800 text-orange-500"
                : "text-zinc-400 hover:bg-zinc-800"
            }`}
            title="Voice settings"
            aria-label="Voice settings"
          >
            <TuneIcon width={18} height={18} />
          </button>
        </div>
      </footer>
    </div>
  );
}
