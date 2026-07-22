// Settings: global pronunciation dictionary (implementation.md §5) and
// audio-cache management.
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import {
  addRule,
  clearAudioDownloads,
  deleteRule,
  exportLibraryJson,
  fetchAudioCacheTotal,
  fetchRules,
  importLibraryJson,
  type DictRule,
} from "../lib/db";
import { formatBytes } from "../lib/format";
import {
  DEFAULT_READER_SETTINGS,
  FONT_FAMILIES,
  loadReaderSettings,
  loadUpdateCheckHours,
  saveReaderSettings,
  saveUpdateCheckHours,
  TEXT_COLORS,
  type ReaderSettings,
} from "../lib/settings";
import {
  lastSyncResult,
  loadSyncSettings,
  saveSyncSettings,
  syncNow,
  type SyncResult,
  type SyncSettings,
} from "../lib/sync";

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

      <div className="grid max-w-xl grid-cols-[6.5rem_1fr] items-center gap-x-3 gap-y-3 text-sm sm:grid-cols-[8rem_1fr] sm:gap-x-4">
        <span className="text-zinc-400">Text size</span>
        <span className="flex items-center gap-3">
          <input
            type="range"
            min={14}
            max={28}
            step={1}
            value={rs.fontSize}
            onChange={(e) => update({ fontSize: Number(e.target.value) })}
            className="min-w-0 max-w-48 flex-1"
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
            className="min-w-0 max-w-48 flex-1"
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

        <span className="text-zinc-400">Auto-download ahead</span>
        <select
          value={rs.prefetch}
          onChange={(e) => update({ prefetch: Number(e.target.value) })}
          className={selectCls}
          title="Silently download upcoming chapters in the background while you read, so you don't hit an offline wall"
        >
          <option value={0}>Off</option>
          <option value={3}>Next 3 chapters</option>
          <option value={5}>Next 5 chapters</option>
          <option value={10}>Next 10 chapters</option>
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

function LibrarySection() {
  const [hours, setHours] = useState(loadUpdateCheckHours);

  return (
    <section className="space-y-3">
      <h2 className="text-xl font-semibold">Library</h2>
      <p className="text-sm text-zinc-500">
        Automatically check your novels' sources for new chapters when the
        app starts (at most once per chosen interval). New chapters show as
        "+N new" badges in the Library.
      </p>
      <label className="flex items-center gap-3 text-sm text-zinc-400">
        Check for new chapters
        <select
          value={hours}
          onChange={(e) => {
            const h = Number(e.target.value);
            setHours(h);
            saveUpdateCheckHours(h);
          }}
          className="rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-sm"
        >
          <option value={0}>Off</option>
          <option value={6}>Every 6 hours</option>
          <option value={12}>Every 12 hours</option>
          <option value={24}>Once a day</option>
        </select>
      </label>
    </section>
  );
}

function SyncSection() {
  const [ss, setSs] = useState<SyncSettings>(loadSyncSettings);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<SyncResult | null>(lastSyncResult);

  function update(patch: Partial<SyncSettings>) {
    const next = { ...ss, ...patch };
    setSs(next);
    saveSyncSettings(next);
  }

  async function runSync() {
    setBusy(true);
    const r = await syncNow();
    if (r) setLast(r);
    setBusy(false);
  }

  const ready = ss.enabled && ss.url.trim() !== "" && ss.token.trim() !== "";
  const inputCls =
    "min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm";

  return (
    <section className="space-y-3">
      <h2 className="text-xl font-semibold">Sync</h2>
      <p className="text-sm text-zinc-500">
        Keep your library and reading positions in sync between devices
        through your own server (see{" "}
        <code className="rounded bg-zinc-900 px-1">sync-server/</code> in the
        repo). Novels added on another device are added here automatically
        and the newest position per novel wins. Chapter downloads stay
        per-device, and novels imported from local files still need a
        one-time transfer via Library Backup.
      </p>

      <label className="flex items-center gap-2 text-sm text-zinc-400">
        <input
          type="checkbox"
          checked={ss.enabled}
          onChange={(e) => update({ enabled: e.target.checked })}
        />
        Enable sync
      </label>

      <div className="grid max-w-xl grid-cols-[6.5rem_1fr] items-center gap-x-3 gap-y-3 text-sm sm:grid-cols-[8rem_1fr] sm:gap-x-4">
        <span className="text-zinc-400">Server URL</span>
        <input
          value={ss.url}
          onChange={(e) => update({ url: e.target.value })}
          placeholder="https://sync.example.com"
          className={inputCls}
        />

        <span className="text-zinc-400">Token</span>
        <input
          type="password"
          value={ss.token}
          onChange={(e) => update({ token: e.target.value })}
          placeholder="from the server's .env"
          className={inputCls}
        />

        <span className="text-zinc-400">Device name</span>
        <input
          value={ss.deviceName}
          onChange={(e) => update({ deviceName: e.target.value })}
          className={inputCls}
        />
      </div>

      <div className="flex items-center gap-3">
        <button
          onClick={runSync}
          disabled={!ready || busy}
          className="rounded-md bg-zinc-800 px-4 py-2 text-sm hover:bg-zinc-700 disabled:opacity-50"
        >
          {busy ? "Syncing..." : "Sync now"}
        </button>
        {last && (
          <span
            className={`text-xs ${last.ok ? "text-zinc-500" : "text-red-400"}`}
          >
            {new Date(last.at).toLocaleString()}: {last.detail}
          </span>
        )}
      </div>
    </section>
  );
}

export default function SettingsPage() {
  const [rules, setRules] = useState<DictRule[]>([]);
  const [pattern, setPattern] = useState("");
  const [replacement, setReplacement] = useState("");
  const [isRegex, setIsRegex] = useState(false);
  const [status, setStatus] = useState("");
  const [audioTotal, setAudioTotal] = useState<{
    chapters: number;
    bytes: number;
  } | null>(null);

  const reload = () =>
    fetchRules()
      .then(setRules)
      .catch((e) => setStatus(String(e)));

  const reloadAudioTotal = () =>
    fetchAudioCacheTotal()
      .then(setAudioTotal)
      .catch(() => {});

  useEffect(() => {
    void reload();
    void reloadAudioTotal();
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
      // MP3s and the manifest are separate stores; wipe both.
      await clearAudioDownloads();
      await reloadAudioTotal();
      setStatus(`Cleared ${n} cached audio files.`);
    } catch (e) {
      setStatus(`Cache clear failed: ${e}`);
    }
  }

  async function exportLibrary() {
    try {
      const path = await save({
        title: "Export library backup",
        defaultPath: "vates-novel-library-backup.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path) return;
      const json = await exportLibraryJson();
      await writeTextFile(path, json);
      setStatus(`Library exported to ${path}.`);
    } catch (e) {
      setStatus(`Export failed: ${e}`);
    }
  }

  async function importLibrary() {
    try {
      const path = await open({
        title: "Import library backup",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!path || Array.isArray(path)) return;
      const json = await readTextFile(path);
      const { novelsAdded, novelsSkipped } = await importLibraryJson(json);
      setStatus(
        `Imported ${novelsAdded} novel(s)` +
          (novelsSkipped > 0 ? ` (${novelsSkipped} already in library).` : "."),
      );
    } catch (e) {
      setStatus(`Import failed: ${e}`);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-10">
      <ReadingSection />

      <LibrarySection />

      <SyncSection />

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Pronunciation Dictionary</h2>
        <p className="text-sm text-zinc-500">
          Global find/replace rules applied to text before it is spoken —
          fix names, honorifics, or anything the voice mispronounces. The
          displayed text is not changed.
        </p>

        <div className="flex flex-wrap gap-2">
          <input
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            placeholder="Find (e.g. Lin Feng)"
            className="min-w-40 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
          />
          <input
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            placeholder="Speak as (e.g. Lin Fung)"
            className="min-w-40 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
          />
          <label
            className="flex items-center gap-1.5 text-xs text-zinc-400"
            title="Treat Find as a regular expression instead of literal text, e.g. Lin (Feng|Fung) to match either spelling, or use \1 in Speak as to reference a captured group."
          >
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
        <p className="text-xs text-zinc-600">
          By default Find is matched literally, anywhere it appears. Turn on{" "}
          <span className="text-zinc-400">regex</span> to match a pattern
          instead — e.g. a name with multiple spellings, an optional
          honorific, or a whole word only when followed by punctuation.
          Speak as can then use{" "}
          <code className="rounded bg-zinc-900 px-1">$1</code>,{" "}
          <code className="rounded bg-zinc-900 px-1">$2</code> etc. to reuse
          parts of the match.
        </p>

        {rules.length > 0 ? (
          <ul className="divide-y divide-zinc-800/60 rounded-lg border border-zinc-800">
            {rules.map((r) => (
              <li key={r.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="min-w-0 break-all font-mono">{r.pattern}</span>
                <span className="text-zinc-600">to</span>
                <span className="min-w-0 break-all font-mono">
                  {r.replacement || "(nothing)"}
                </span>
                {r.is_regex ? (
                  <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-400">
                    regex
                  </span>
                ) : null}
                <button
                  onClick={() => deleteRule(r.id).then(reload)}
                  className="ml-auto rounded px-2.5 py-1.5 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-red-400"
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
          works offline. Chapters you download for offline listening (from the
          reader's chapter list) live here too. Clear it to free space or after
          changing dictionary rules.
        </p>
        {audioTotal && audioTotal.chapters > 0 && (
          <p className="text-sm text-zinc-400">
            {audioTotal.chapters} chapter
            {audioTotal.chapters === 1 ? "" : "s"} downloaded for offline —{" "}
            {formatBytes(audioTotal.bytes)}.
          </p>
        )}
        <button
          onClick={clearCache}
          className="rounded-md bg-zinc-800 px-4 py-2 text-sm hover:bg-zinc-700"
        >
          Clear audio cache
        </button>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Library Backup</h2>
        <p className="text-sm text-zinc-500">
          Export every novel in your library — including downloaded chapter
          content and pronunciation rules — to a single JSON file, and restore
          it later or on another machine. Importing never overwrites a novel
          already in your library.
        </p>
        <div className="flex gap-2">
          <button
            onClick={exportLibrary}
            className="rounded-md bg-zinc-800 px-4 py-2 text-sm hover:bg-zinc-700"
          >
            Export Library
          </button>
          <button
            onClick={importLibrary}
            className="rounded-md bg-zinc-800 px-4 py-2 text-sm hover:bg-zinc-700"
          >
            Import Library
          </button>
        </div>
      </section>

      {status && <p className="break-words text-sm text-zinc-500">{status}</p>}
    </div>
  );
}
