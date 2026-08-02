// Device-to-device reading-progress sync through a tiny self-hosted server
// (sync-server/ in the repo). Each device uploads its own progress document
// keyed by a random device id; merging happens here, client-side:
// last-write-wins per novel on the position_updated_at clock, which only
// savePosition ever sets — so merely opening a reader on one device never
// beats real reading done on another.
//
// Library membership is last-write-wins too, between a novel's presence clock
// (added, or read — see presenceOf) and the deletion tombstone another device
// wrote when it was removed. Without the tombstones a doc could only say what
// a device has, and any device still listing a novel would add it straight
// back after you removed it.
//
// Timestamps are SQLite's datetime('now') strings (UTC, "YYYY-MM-DD
// HH:MM:SS"), identical in format on every device, so plain string
// comparison orders them correctly.
import { invoke } from "@tauri-apps/api/core";
import { getNovelDetails } from "./api";
import {
  addToLibrary,
  fetchDeletions,
  getDb,
  pruneDeletions,
  removeNovelForSync,
} from "./db";
import { notifyLibraryUpdated } from "./libraryEvents";
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
  removed: number; // novels removed on another device
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
  removed = 0,
): SyncResult {
  const r: SyncResult = {
    at: new Date().toISOString(),
    ok,
    detail,
    applied,
    added,
    removed,
  };
  localStorage.setItem(RESULT_KEY, JSON.stringify(r));
  return r;
}

interface ProgressEntry {
  source_id: string;
  novel_url: string;
  title: string;
  added_at: string | null; // absent in docs from pre-tombstone builds
  last_read_chapter: number | null;
  last_read_segment: number | null;
  last_read_at: string | null;
  position_updated_at: string | null;
}

interface DeletionEntry {
  source_id: string;
  novel_url: string;
  deleted_at: string;
}

interface ProgressDoc {
  version: 1;
  device_id: string;
  device_name: string;
  pushed_at: string;
  novels: ProgressEntry[];
  deletions: DeletionEntry[];
}

const configured = (s: SyncSettings) =>
  s.enabled && s.url.trim() !== "" && s.token.trim() !== "";

const endpoint = (s: SyncSettings, path: string) =>
  s.url.trim().replace(/\/+$/, "") + path;

/** Sync clock of an entry; last_read_at only as a pre-migration fallback. */
const clockOf = (e: ProgressEntry) =>
  e.position_updated_at ?? e.last_read_at ?? "";

const newer = (a: string, b: string) => (a > b ? a : b);

/** When a device last claimed this novel belongs in the library — added, or
 * read. A tombstone older than this loses, so removing a novel on one device
 * never wipes one you have kept reading on another. */
const presenceOf = (e: ProgressEntry) => newer(e.added_at ?? "", clockOf(e));

const keyOf = (e: { source_id: string; novel_url: string }) =>
  `${e.source_id}\n${e.novel_url}`;

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
  for (const t of [e.last_read_at, e.position_updated_at, e.added_at]) {
    if (t != null && (typeof t !== "string" || !TS_FORMAT.test(t))) {
      return false;
    }
  }
  return true;
}

/** Same for a tombstone: a malformed clock must not be able to delete. */
function saneDeletion(d: DeletionEntry): boolean {
  return (
    typeof d.source_id === "string" &&
    typeof d.novel_url === "string" &&
    typeof d.deleted_at === "string" &&
    TS_FORMAT.test(d.deleted_at)
  );
}

async function buildDoc(s: SyncSettings): Promise<ProgressDoc> {
  const db = await getDb();
  await pruneDeletions();
  // Every novel, read or not — the doc doubles as the library membership
  // list so other devices can auto-add what this one has, and the tombstones
  // say which novels are gone rather than never-had.
  const novels = await db.select<ProgressEntry[]>(
    `SELECT source_id, novel_url, title, added_at, last_read_chapter,
            last_read_segment, last_read_at, position_updated_at
     FROM novels`,
  );
  return {
    version: 1,
    device_id: s.deviceId,
    device_name: s.deviceName,
    pushed_at: new Date().toISOString(),
    novels,
    deletions: await fetchDeletions(),
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

/** Pull every device's doc, apply newer positions, auto-add novels this
 * device doesn't have yet (fetched fresh from their source), and drop novels
 * another device removed. */
async function pullAndMerge(
  s: SyncSettings,
): Promise<{ applied: number; added: number; removed: number }> {
  const raw = await invoke<string>("sync_get", {
    url: endpoint(s, "/sync"),
    token: s.token.trim(),
  });
  const parsed = JSON.parse(raw) as { devices?: ProgressDoc[] };

  // Per novel across all other devices: the best remote position, the newest
  // membership claim, and the newest removal. Clocks ahead of real time
  // (device with a broken clock, or a tampered doc) are ignored — they would
  // win every merge forever.
  const maxClock = new Date(Date.now() + 24 * 3600 * 1000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");
  const best = new Map<string, ProgressEntry>();
  const presence = new Map<string, string>();
  const tombstones = new Map<string, string>();
  const bump = (m: Map<string, string>, key: string, clock: string) => {
    if (clock !== "" && clock <= maxClock && clock > (m.get(key) ?? "")) {
      m.set(key, clock);
    }
  };

  for (const doc of parsed.devices ?? []) {
    if (!doc || doc.device_id === s.deviceId) continue;
    for (const e of Array.isArray(doc.novels) ? doc.novels : []) {
      if (!e?.source_id || !e?.novel_url || !saneEntry(e)) continue;
      if (clockOf(e) > maxClock) continue;
      const key = keyOf(e);
      const cur = best.get(key);
      if (!cur || clockOf(e) > clockOf(cur)) best.set(key, e);
      bump(presence, key, presenceOf(e));
    }
    for (const d of Array.isArray(doc.deletions) ? doc.deletions : []) {
      if (!d?.source_id || !d?.novel_url || !saneDeletion(d)) continue;
      bump(tombstones, keyOf(d), d.deleted_at);
    }
  }
  // This device's own removals count too: they are what stops a novel we
  // deleted from being re-added by a device that still lists it.
  for (const d of await fetchDeletions()) bump(tombstones, keyOf(d), d.deleted_at);

  if (best.size === 0 && tombstones.size === 0) {
    return { applied: 0, added: 0, removed: 0 };
  }

  const db = await getDb();
  const locals = await db.select<
    {
      id: number;
      source_id: string;
      novel_url: string;
      added_at: string | null;
      last_read_at: string | null;
      position_updated_at: string | null;
    }[]
  >(
    `SELECT id, source_id, novel_url, added_at, last_read_at, position_updated_at
     FROM novels`,
  );

  // Removals first. A tombstone is weighed against the newest membership
  // claim anywhere — this device's and every other device's — so a novel
  // re-added or read after the removal is never dropped here only to be
  // fetched back on the next sync.
  let removed = 0;
  const dropped = new Set<string>();
  for (const l of locals) {
    const key = keyOf(l);
    const tomb = tombstones.get(key) ?? "";
    if (tomb === "") continue;
    const claim = newer(
      newer(l.added_at ?? "", l.position_updated_at ?? l.last_read_at ?? ""),
      presence.get(key) ?? "",
    );
    if (tomb < claim) continue;
    await removeNovelForSync(l.id, l.source_id, l.novel_url, tomb);
    dropped.add(key);
    removed++;
  }

  let applied = 0;
  for (const l of locals) {
    const key = keyOf(l);
    if (dropped.has(key)) continue;
    const r = best.get(key);
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
  const localKeys = new Set(locals.map(keyOf));
  let added = 0;
  for (const [key, r] of best) {
    if (localKeys.has(key) || r.source_id === "local") continue;
    // Removed more recently than any claim that it belongs in the library —
    // adding it back is exactly the resurrection the tombstones prevent.
    const tomb = tombstones.get(key) ?? "";
    if (tomb !== "" && tomb >= (presence.get(key) ?? "")) continue;
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
  return { applied, added, removed };
}

let syncing = false;
let pushTimer: ReturnType<typeof setTimeout> | null = null;

/** Full sync (pull + merge + push). Silently a no-op when not configured. */
export async function syncNow(): Promise<SyncResult | null> {
  const s = loadSyncSettings();
  if (!configured(s) || syncing) return null;
  syncing = true;
  try {
    const { applied, added, removed } = await pullAndMerge(s);
    await push(s);
    if (added + removed > 0) notifyLibraryUpdated();
    const parts = [];
    if (added > 0) parts.push(`added ${added} novel(s)`);
    if (removed > 0) parts.push(`removed ${removed} novel(s)`);
    if (applied > 0) parts.push(`updated ${applied} position(s)`);
    return recordResult(
      true,
      parts.length > 0 ? parts.join(", ") : "up to date",
      applied,
      added,
      removed,
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
    if (!r?.ok) return;
    const changed = r.applied + r.added + (r.removed ?? 0);
    if (changed > 0) onApplied?.(changed);
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
