// Device-to-device reading-progress sync through a tiny self-hosted server
// (sync-server/ in the repo). Each device uploads its own progress document
// keyed by a random device id; merging happens here, client-side:
// last-write-wins per novel on the position_updated_at clock, which only
// savePosition ever sets — so merely opening a reader on one device never
// beats real reading done on another.
//
// Timestamps are SQLite's datetime('now') strings (UTC, "YYYY-MM-DD
// HH:MM:SS"), identical in format on every device, so plain string
// comparison orders them correctly.
import { invoke } from "@tauri-apps/api/core";
import { getNovelDetails } from "./api";
import { addToLibrary, getDb } from "./db";
import { isAndroid } from "./platform";

export interface SyncSettings {
  enabled: boolean;
  url: string;
  token: string;
  deviceId: string;
  deviceName: string;
}

const SETTINGS_KEY = "sync-settings";
const RESULT_KEY = "sync-last-result";

export function loadSyncSettings(): SyncSettings {
  let parsed: Partial<SyncSettings> = {};
  try {
    parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}");
  } catch {
    // fall through to defaults
  }
  const s: SyncSettings = {
    enabled: parsed.enabled ?? false,
    url: parsed.url ?? "",
    token: parsed.token ?? "",
    deviceId: parsed.deviceId ?? crypto.randomUUID(),
    deviceName: parsed.deviceName ?? (isAndroid() ? "Phone" : "PC"),
  };
  // Persist the generated device id so it stays stable across launches.
  if (!parsed.deviceId) localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  return s;
}

export function saveSyncSettings(s: SyncSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

export interface SyncResult {
  at: string; // ISO
  ok: boolean;
  detail: string;
  applied: number; // positions updated locally by the merge
  added: number; // novels auto-added from other devices
}

export function lastSyncResult(): SyncResult | null {
  try {
    return JSON.parse(localStorage.getItem(RESULT_KEY) ?? "null");
  } catch {
    return null;
  }
}

function recordResult(
  ok: boolean,
  detail: string,
  applied = 0,
  added = 0,
): SyncResult {
  const r: SyncResult = {
    at: new Date().toISOString(),
    ok,
    detail,
    applied,
    added,
  };
  localStorage.setItem(RESULT_KEY, JSON.stringify(r));
  return r;
}

interface ProgressEntry {
  source_id: string;
  novel_url: string;
  title: string;
  last_read_chapter: number | null;
  last_read_segment: number | null;
  last_read_at: string | null;
  position_updated_at: string | null;
}

interface ProgressDoc {
  version: 1;
  device_id: string;
  device_name: string;
  pushed_at: string;
  novels: ProgressEntry[];
}

const configured = (s: SyncSettings) =>
  s.enabled && s.url.trim() !== "" && s.token.trim() !== "";

const endpoint = (s: SyncSettings, path: string) =>
  s.url.trim().replace(/\/+$/, "") + path;

/** Sync clock of an entry; last_read_at only as a pre-migration fallback. */
const clockOf = (e: ProgressEntry) =>
  e.position_updated_at ?? e.last_read_at ?? "";

const TS_FORMAT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** Shape-check a remote entry before trusting it: the server stores docs
 * verbatim, so a tampered or corrupted doc must not be able to plant
 * non-numeric positions or malformed timestamps in the local DB. */
function saneEntry(e: ProgressEntry): boolean {
  if (typeof e.source_id !== "string" || typeof e.novel_url !== "string") {
    return false;
  }
  if (e.last_read_chapter != null && !Number.isInteger(e.last_read_chapter)) {
    return false;
  }
  if (e.last_read_segment != null && !Number.isInteger(e.last_read_segment)) {
    return false;
  }
  for (const t of [e.last_read_at, e.position_updated_at]) {
    if (t != null && (typeof t !== "string" || !TS_FORMAT.test(t))) {
      return false;
    }
  }
  return true;
}

async function buildDoc(s: SyncSettings): Promise<ProgressDoc> {
  const db = await getDb();
  // Every novel, read or not — the doc doubles as the library membership
  // list so other devices can auto-add what this one has.
  const novels = await db.select<ProgressEntry[]>(
    `SELECT source_id, novel_url, title, last_read_chapter, last_read_segment,
            last_read_at, position_updated_at
     FROM novels`,
  );
  return {
    version: 1,
    device_id: s.deviceId,
    device_name: s.deviceName,
    pushed_at: new Date().toISOString(),
    novels,
  };
}

async function push(s: SyncSettings): Promise<void> {
  const doc = await buildDoc(s);
  await invoke<void>("sync_put", {
    url: endpoint(s, `/sync/${s.deviceId}`),
    token: s.token.trim(),
    body: JSON.stringify(doc),
  });
}

/** Pull every device's doc, apply newer positions, and auto-add novels
 * this device doesn't have yet (fetched fresh from their source). */
async function pullAndMerge(
  s: SyncSettings,
): Promise<{ applied: number; added: number }> {
  const raw = await invoke<string>("sync_get", {
    url: endpoint(s, "/sync"),
    token: s.token.trim(),
  });
  const parsed = JSON.parse(raw) as { devices?: ProgressDoc[] };

  // Best remote position per novel across all other devices. Entries with a
  // clock ahead of real time (device with a broken clock, or a tampered doc)
  // are ignored — they would win every merge forever.
  const maxClock = new Date(Date.now() + 24 * 3600 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
  const best = new Map<string, ProgressEntry>();
  for (const doc of parsed.devices ?? []) {
    if (!doc || doc.device_id === s.deviceId || !Array.isArray(doc.novels)) {
      continue;
    }
    for (const e of doc.novels) {
      if (!e?.source_id || !e?.novel_url || !saneEntry(e)) continue;
      if (clockOf(e) > maxClock) continue;
      const key = `${e.source_id}\n${e.novel_url}`;
      const cur = best.get(key);
      if (!cur || clockOf(e) > clockOf(cur)) best.set(key, e);
    }
  }
  if (best.size === 0) return { applied: 0, added: 0 };

  const db = await getDb();
  const locals = await db.select<
    {
      id: number;
      source_id: string;
      novel_url: string;
      last_read_at: string | null;
      position_updated_at: string | null;
    }[]
  >(
    `SELECT id, source_id, novel_url, last_read_at, position_updated_at
     FROM novels`,
  );

  let applied = 0;
  for (const l of locals) {
    const r = best.get(`${l.source_id}\n${l.novel_url}`);
    if (!r) continue;
    const remoteClock = clockOf(r);
    const localClock = l.position_updated_at ?? l.last_read_at ?? "";
    if (!remoteClock || remoteClock <= localClock) continue;

    // Keep last_read_at monotonic too so the recents list surfaces novels
    // read on the other device without ever demoting a local entry.
    const lastReadAt =
      (l.last_read_at ?? "") > (r.last_read_at ?? "")
        ? l.last_read_at
        : r.last_read_at;
    await db.execute(
      `UPDATE novels SET last_read_chapter = $1, last_read_segment = $2,
                         position_updated_at = $3, last_read_at = $4
       WHERE id = $5`,
      [r.last_read_chapter, r.last_read_segment, remoteClock, lastReadAt, l.id],
    );
    applied++;
  }

  // Novels other devices have that this one doesn't: re-fetch the details
  // from the source and add them, then adopt the remote position. Imported
  // novels (source "local") are skipped — their content exists only on the
  // device that imported them, so there is nothing to fetch it from.
  const localKeys = new Set(locals.map((l) => `${l.source_id}\n${l.novel_url}`));
  let added = 0;
  for (const [key, r] of best) {
    if (localKeys.has(key) || r.source_id === "local") continue;
    try {
      const details = await getNovelDetails(r.source_id, r.novel_url);
      await addToLibrary(details);
      const clock = clockOf(r);
      if (clock) {
        await db.execute(
          `UPDATE novels SET last_read_chapter = $1, last_read_segment = $2,
                             position_updated_at = $3, last_read_at = $4
           WHERE source_id = $5 AND novel_url = $6`,
          [
            r.last_read_chapter,
            r.last_read_segment,
            clock,
            r.last_read_at,
            r.source_id,
            r.novel_url,
          ],
        );
      }
      added++;
    } catch {
      // source unreachable or unknown in this build — retried next sync
    }
  }
  return { applied, added };
}

let syncing = false;
let pushTimer: ReturnType<typeof setTimeout> | null = null;

/** Full sync (pull + merge + push). Silently a no-op when not configured. */
export async function syncNow(): Promise<SyncResult | null> {
  const s = loadSyncSettings();
  if (!configured(s) || syncing) return null;
  syncing = true;
  try {
    const { applied, added } = await pullAndMerge(s);
    await push(s);
    const parts = [];
    if (added > 0) parts.push(`added ${added} novel(s)`);
    if (applied > 0) parts.push(`updated ${applied} position(s)`);
    return recordResult(
      true,
      parts.length > 0 ? parts.join(", ") : "up to date",
      applied,
      added,
    );
  } catch (e) {
    return recordResult(false, String(e));
  } finally {
    syncing = false;
  }
}

async function pushQuietly(): Promise<void> {
  const s = loadSyncSettings();
  if (!configured(s) || syncing) return;
  syncing = true;
  try {
    await push(s);
    recordResult(true, "pushed");
  } catch (e) {
    recordResult(false, String(e));
  } finally {
    syncing = false;
  }
}

/** Debounced upload, called after every saved position (see db.savePosition). */
export function schedulePush(): void {
  if (!configured(loadSyncSettings())) return;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void pushQuietly();
  }, 5000);
}

let autoStarted = false;

/**
 * Launch-time sync plus lifecycle hooks: a full sync when the app starts or
 * regains focus (throttled), and an immediate flush of any pending push when
 * the app goes to the background (Android app switch, window minimize).
 */
export function startAutoSync(onApplied?: (applied: number) => void): void {
  if (autoStarted) return;
  autoStarted = true;

  let lastFull = 0;
  const full = async () => {
    lastFull = Date.now();
    const r = await syncNow();
    if (r?.ok && r.applied + r.added > 0) onApplied?.(r.applied + r.added);
  };

  void full();

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (pushTimer) {
        clearTimeout(pushTimer);
        pushTimer = null;
        void pushQuietly();
      }
    } else if (Date.now() - lastFull > 60_000) {
      void full();
    }
  });
  window.addEventListener("focus", () => {
    if (Date.now() - lastFull > 60_000) void full();
  });
}
