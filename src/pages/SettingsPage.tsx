// Settings: global pronunciation dictionary (implementation.md §5) and
// audio-cache management.
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { addRule, deleteRule, fetchRules, type DictRule } from "../lib/db";
import {
  DEFAULT_READER_SETTINGS,
  FONT_FAMILIES,
  loadReaderSettings,
  saveReaderSettings,
  TEXT_COLORS,
  type ReaderSettings,
} from "../lib/settings";

function ReadingSection() {
  const [rs, setRs] = useState<ReaderSettings>(loadReaderSettings);

  function update(patch: Partial<ReaderSettings>) {
    const next = { ...rs, ...patch };
    setRs(next);
    saveReaderSettings(next);
  }

  const selectCls =
    "rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm";

  return (
    <section className="space-y-3">
      <h2 className="text-xl font-semibold">Reading</h2>
      <p className="text-sm text-zinc-500">
        Appearance of the reader screen. Applies the next time a reader is
        opened.
      </p>

      <div className="grid max-w-xl grid-cols-[8rem_1fr] items-center gap-x-4 gap-y-3 text-sm">
        <span className="text-zinc-400">Text size</span>
        <span className="flex items-center gap-3">
          <input
            type="range"
            min={14}
            max={28}
            step={1}
            value={rs.fontSize}
            onChange={(e) => update({ fontSize: Number(e.target.value) })}
            className="w-48"
          />
          <span className="tabular-nums text-zinc-400">{rs.fontSize}px</span>
        </span>

        <span className="text-zinc-400">Line spacing</span>
        <span className="flex items-center gap-3">
          <input
            type="range"
            min={1.3}
            max={2.4}
            step={0.1}
            value={rs.lineHeight}
            onChange={(e) => update({ lineHeight: Number(e.target.value) })}
            className="w-48"
          />
          <span className="tabular-nums text-zinc-400">
            {rs.lineHeight.toFixed(1)}
          </span>
        </span>

        <span className="text-zinc-400">Font</span>
        <select
          value={rs.font}
          onChange={(e) => update({ font: e.target.value })}
          className={selectCls}
        >
          {Object.entries(FONT_FAMILIES).map(([key, f]) => (
            <option key={key} value={key}>
              {f.label}
            </option>
          ))}
        </select>

        <span className="text-zinc-400">Text width</span>
        <select
          value={rs.width}
          onChange={(e) =>
            update({ width: e.target.value as ReaderSettings["width"] })
          }
          className={selectCls}
        >
          <option value="full">Full window</option>
          <option value="medium">Medium</option>
          <option value="narrow">Narrow</option>
        </select>

        <span className="text-zinc-400">Text color</span>
        <select
          value={rs.color}
          onChange={(e) => update({ color: e.target.value })}
          className={selectCls}
        >
          {Object.entries(TEXT_COLORS).map(([key, c]) => (
            <option key={key} value={key}>
              {c.label}
            </option>
          ))}
        </select>
      </div>

      <div
        className="max-w-xl rounded-lg border border-zinc-800 bg-zinc-950 p-4"
        style={{
          fontSize: rs.fontSize,
          lineHeight: rs.lineHeight,
          fontFamily: FONT_FAMILIES[rs.font]?.css,
          color: TEXT_COLORS[rs.color]?.css,
        }}
      >
        Preview: Lin Feng drew a deep breath as the spiritual energy gathered
        around him, the ancient runes pulsing with a cold light.
      </div>

      <button
        onClick={() => {
          setRs(DEFAULT_READER_SETTINGS);
          saveReaderSettings(DEFAULT_READER_SETTINGS);
        }}
        className="rounded-md bg-zinc-800 px-3 py-1.5 text-sm hover:bg-zinc-700"
      >
        Reset to defaults
      </button>
    </section>
  );
}

export default function SettingsPage() {
  const [rules, setRules] = useState<DictRule[]>([]);
  const [pattern, setPattern] = useState("");
  const [replacement, setReplacement] = useState("");
  const [isRegex, setIsRegex] = useState(false);
  const [status, setStatus] = useState("");

  const reload = () =>
    fetchRules()
      .then(setRules)
      .catch((e) => setStatus(String(e)));

  useEffect(() => {
    void reload();
  }, []);

  async function add() {
    if (!pattern) return;
    await addRule(pattern, replacement, isRegex, null);
    setPattern("");
    setReplacement("");
    setIsRegex(false);
    await reload();
  }

  async function clearCache() {
    try {
      const n = await invoke<number>("clear_tts_cache");
      setStatus(`Cleared ${n} cached audio files.`);
    } catch (e) {
      setStatus(`Cache clear failed: ${e}`);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-10">
      <ReadingSection />

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Pronunciation Dictionary</h2>
        <p className="text-sm text-zinc-500">
          Global find/replace rules applied to text before it is spoken —
          fix names, honorifics, or anything the voice mispronounces. The
          displayed text is not changed.
        </p>

        <div className="flex gap-2">
          <input
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            placeholder="Find (e.g. Lin Feng)"
            className="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
          />
          <input
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            placeholder="Speak as (e.g. Lin Fung)"
            className="flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
          />
          <label className="flex items-center gap-1.5 text-xs text-zinc-400">
            <input
              type="checkbox"
              checked={isRegex}
              onChange={(e) => setIsRegex(e.target.checked)}
            />
            regex
          </label>
          <button
            onClick={add}
            disabled={!pattern}
            className="rounded-md bg-orange-600 px-4 py-2 text-sm font-medium hover:bg-orange-500 disabled:opacity-50"
          >
            Add
          </button>
        </div>

        {rules.length > 0 ? (
          <ul className="divide-y divide-zinc-800/60 rounded-lg border border-zinc-800">
            {rules.map((r) => (
              <li key={r.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="font-mono">{r.pattern}</span>
                <span className="text-zinc-600">to</span>
                <span className="font-mono">{r.replacement || "(nothing)"}</span>
                {r.is_regex ? (
                  <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400">
                    regex
                  </span>
                ) : null}
                <button
                  onClick={() => deleteRule(r.id).then(reload)}
                  className="ml-auto rounded px-2 py-0.5 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-red-400"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-zinc-600">No rules yet.</p>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Audio Cache</h2>
        <p className="text-sm text-zinc-500">
          Synthesized audio is cached on disk so re-listening is instant and
          works offline. Clear it to free space or after changing dictionary
          rules.
        </p>
        <button
          onClick={clearCache}
          className="rounded-md bg-zinc-800 px-4 py-2 text-sm hover:bg-zinc-700"
        >
          Clear audio cache
        </button>
      </section>

      {status && <p className="text-sm text-zinc-500">{status}</p>}
    </div>
  );
}
