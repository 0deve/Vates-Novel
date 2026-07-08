// Voice Test: try any voice/speed on arbitrary text with live word highlighting.
import { useEffect, useRef, useState } from "react";
import { audioUrlFromBase64, listVoices, synthesize } from "../lib/api";
import {
  DEVICE_VOICE_PREFIX,
  deviceVoiceName,
  hasDeviceTts,
  isDeviceVoice,
  listDeviceVoices,
  onDeviceTtsReady,
  speakDevice,
  splitWords,
  type DeviceVoice,
  type SpeakHandle,
} from "../lib/nativeTts";
import type { VoiceInfo, WordBoundary } from "../types";

const DEFAULT_TEXT =
  "The awakening had finally begun. Lin Feng opened his eyes and felt the " +
  "spiritual energy of heaven and earth flowing through his meridians.";

export default function SpikePage() {
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [deviceVoices, setDeviceVoices] = useState<DeviceVoice[]>([]);
  const [voice, setVoice] = useState<string>("");
  const [text, setText] = useState(DEFAULT_TEXT);
  const [rate, setRate] = useState(0); // percent offset: 0 = normal speed
  const [pitch, setPitch] = useState(0); // Hz offset: 0 = normal pitch
  const [status, setStatus] = useState<string>("");
  const [boundaries, setBoundaries] = useState<WordBoundary[]>([]);
  const [activeWord, setActiveWord] = useState(-1);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const deviceRef = useRef<SpeakHandle | null>(null);
  const rafRef = useRef(0);

  useEffect(() => {
    const loadDeviceVoices = () => {
      if (!hasDeviceTts()) return;
      const dev = listDeviceVoices().filter(
        (v) => v.locale.toLowerCase().startsWith("en") && !v.network,
      );
      setDeviceVoices(dev);
      // Offline (Edge list failed/empty): default to a device voice.
      if (dev.length > 0)
        setVoice((cur) => cur || DEVICE_VOICE_PREFIX + dev[0].name);
    };
    loadDeviceVoices();
    const offReady = onDeviceTtsReady(loadDeviceVoices);

    listVoices()
      .then((v) => {
        const en = v.filter((x) => x.locale.startsWith("en-"));
        setVoices(en);
        const aria = en.find((x) => x.short_name === "en-US-AriaNeural");
        setVoice((cur) =>
          isDeviceVoice(cur) ? cur : ((aria ?? en[0])?.name ?? cur),
        );
        setStatus(`${v.length} voices loaded (${en.length} English)`);
      })
      .catch((e) => setStatus(`Failed to load Edge voices (offline?): ${e}`));
    return () => {
      offReady();
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function stop() {
    cancelAnimationFrame(rafRef.current);
    audioRef.current?.pause();
    audioRef.current = null;
    deviceRef.current?.stop();
    deviceRef.current = null;
    setActiveWord(-1);
  }

  async function play() {
    stop();

    if (isDeviceVoice(voice)) {
      const words = splitWords(text);
      setBoundaries(
        words.map((w) => ({ text: w.text, offset_ms: 0, duration_ms: 0 })),
      );
      setStatus("Speaking with the device voice…");
      const handle = speakDevice(text, deviceVoiceName(voice), rate, pitch, {
        onRange: (charStart) => {
          let idx = -1;
          for (let i = 0; i < words.length; i++) {
            if (words[i].offset <= charStart) idx = i;
            else break;
          }
          setActiveWord(idx);
        },
        onDone: () => {
          deviceRef.current = null;
          setActiveWord(-1);
          setStatus("Done.");
        },
        onError: (m) => {
          deviceRef.current = null;
          setActiveWord(-1);
          setStatus(m);
        },
      });
      if (!handle) setStatus("Device TTS engine is not ready.");
      deviceRef.current = handle;
      return;
    }

    setStatus("Synthesizing…");
    try {
      const t0 = performance.now();
      const res = await synthesize(text, voice, rate, pitch);
      const ms = Math.round(performance.now() - t0);
      setBoundaries(res.word_boundaries);
      setStatus(
        `Synthesized in ${ms}ms — ${res.word_boundaries.length} word boundaries`,
      );

      const audio = new Audio(audioUrlFromBase64(res.audio_base64, res.mime));
      audioRef.current = audio;

      const tick = () => {
        const posMs = audio.currentTime * 1000;
        // Last boundary whose offset has passed = currently spoken word.
        let idx = -1;
        for (let i = 0; i < res.word_boundaries.length; i++) {
          if (res.word_boundaries[i].offset_ms <= posMs) idx = i;
          else break;
        }
        setActiveWord(idx);
        if (!audio.ended) rafRef.current = requestAnimationFrame(tick);
        else setActiveWord(-1);
      };
      audio.onplay = () => (rafRef.current = requestAnimationFrame(tick));
      await audio.play();
    } catch (e) {
      setStatus(`Synthesis failed: ${e}`);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <h2 className="text-xl font-semibold">Voice Test</h2>
      <p className="text-sm text-zinc-500">
        Preview any voice and speed before using it in the reader.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <select
          value={voice}
          onChange={(e) => setVoice(e.target.value)}
          className="w-full min-w-0 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm sm:w-auto sm:flex-1"
        >
          {voices.length > 0 && (
            <optgroup label="Edge voices (online)">
              {voices.map((v) => (
                <option key={v.short_name} value={v.name}>
                  {v.short_name} ({v.gender})
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
        </select>
        <label className="flex items-center gap-2 text-sm text-zinc-400">
          Speed
          <input
            type="range"
            min={-50}
            max={200}
            step={10}
            value={rate}
            onChange={(e) => setRate(Number(e.target.value))}
            className="w-28"
          />
          <span className="w-12 tabular-nums">
            {(1 + rate / 100).toFixed(1)}x
          </span>
        </label>
        <label className="flex items-center gap-2 text-sm text-zinc-400">
          Pitch
          <input
            type="range"
            min={-50}
            max={50}
            step={5}
            value={pitch}
            onChange={(e) => setPitch(Number(e.target.value))}
            className="w-28"
          />
          <span className="w-12 tabular-nums">
            {pitch > 0 ? `+${pitch}Hz` : `${pitch}Hz`}
          </span>
        </label>
      </div>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        className="w-full rounded-md border border-zinc-700 bg-zinc-900 p-3 text-sm"
      />

      <div className="flex gap-2">
        <button
          onClick={play}
          disabled={!voice}
          className="rounded-md bg-orange-600 px-4 py-2 text-sm font-medium hover:bg-orange-500 disabled:opacity-50"
        >
          Synthesize &amp; Play
        </button>
        <button
          onClick={stop}
          className="rounded-md bg-zinc-800 px-4 py-2 text-sm hover:bg-zinc-700"
        >
          Stop
        </button>
      </div>

      {status && <p className="text-sm text-zinc-500">{status}</p>}

      {boundaries.length > 0 && (
        <p className="rounded-md bg-zinc-900 p-4 leading-8">
          {boundaries.map((b, i) => (
            <span
              key={i}
              className={`rounded px-0.5 transition-colors ${
                i === activeWord ? "bg-orange-600 text-white" : ""
              }`}
            >
              {b.text}{" "}
            </span>
          ))}
        </p>
      )}
    </div>
  );
}
