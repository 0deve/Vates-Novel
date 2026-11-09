import Database from "@tauri-apps/plugin-sql";
import type {
  ChapterMeta,
  ImportedNovel,
  LibraryNovel,
  NovelDetails,
  NovelRow,
} from "../types";
import { schedulePush } from "./sync";

let dbPromise: Promise<Database> | null = null;

/** Lazily open the app database (migrations run on the Rust side). */
export function getDb(): Promise<Database> {
  dbPromise ??= Database.load("sqlite:novel.db");
  return dbPromise;
}

export async function fetchLibrary(): Promise<LibraryNovel[]> {
  const db = await getDb();
  return db.select<LibraryNovel[]>(
    `SELECT n.id, n.source_id, n.novel_url, n.title, n.author, n.cover_url,
            n.status, n.summary, n.last_read_chapter, n.new_chapters_count,
            n.added_at, n.last_read_at,
            (SELECT COUNT(*) FROM chapters c WHERE c.novel_id = n.id) AS chapter_count
     FROM novels n
     ORDER BY n.added_at DESC`,
  );
}

export interface LibraryStats {
  totalNovels: number;
  totalChapters: number;
  chaptersRead: number;
  chaptersUnread: number;
  chaptersDownloaded: number;
  chaptersNotDownloaded: number;
  novelsCompleted: number;
  novelsInProgress: number;
  novelsNotStarted: number;
  downloadedBytes: number;
}

/** Aggregate reading/download stats across the whole library. */
export async function fetchLibraryStats(): Promise<LibraryStats> {
  const db = await getDb();

  const novels = await db.select<{ id: number; last_read_chapter: number | null }[]>(
    `SELECT id, last_read_chapter FROM novels`,
  );
  const perNovelCounts = await db.select<{ novel_id: number; count: number }[]>(
    `SELECT novel_id, COUNT(*) AS count FROM chapters GROUP BY novel_id`,
  );
  const countByNovel = new Map(perNovelCounts.map((c) => [c.novel_id, c.count]));

  const totalsRows = await db.select<
    { total_chapters: number; downloaded: number; bytes: number | null }[]
  >(
    `SELECT COUNT(*) AS total_chapters,
            SUM(CASE WHEN content IS NOT NULL THEN 1 ELSE 0 END) AS downloaded,
            SUM(LENGTH(content)) AS bytes
     FROM chapters`,
  );
  const totalChapters = totalsRows[0]?.total_chapters ?? 0;
  const chaptersDownloaded = totalsRows[0]?.downloaded ?? 0;
  const downloadedBytes = totalsRows[0]?.bytes ?? 0;

  let chaptersRead = 0;
  let novelsCompleted = 0;
  let novelsInProgress = 0;
  let novelsNotStarted = 0;
  for (const n of novels) {
    const count = countByNovel.get(n.id) ?? 0;
    const read = Math.min(n.last_read_chapter ?? 0, count);
    chaptersRead += read;
    if (read <= 0) novelsNotStarted++;
    else if (count > 0 && read >= count) novelsCompleted++;
    else novelsInProgress++;
  }

  return {
    totalNovels: novels.length,
    totalChapters,
    chaptersRead,
    chaptersUnread: Math.max(0, totalChapters - chaptersRead),
    chaptersDownloaded,
    chaptersNotDownloaded: Math.max(0, totalChapters - chaptersDownloaded),
    novelsCompleted,
    novelsInProgress,
    novelsNotStarted,
    downloadedBytes,
  };
}

export async function fetchNovel(id: number): Promise<NovelRow> {
  const db = await getDb();
  const rows = await db.select<NovelRow[]>(
    `SELECT n.*,
            (SELECT COUNT(*) FROM chapters c WHERE c.novel_id = n.id) AS chapter_count
     FROM novels n WHERE n.id = $1`,
    [id],
  );
  if (!rows[0]) throw new Error(`novel ${id} not found`);
  return rows[0];
}

export async function fetchChapterMeta(novelId: number): Promise<ChapterMeta[]> {
  const db = await getDb();
  return db.select<ChapterMeta[]>(
    `SELECT id, idx, title, (content IS NOT NULL) AS downloaded
     FROM chapters WHERE novel_id = $1 ORDER BY idx ASC`,
    [novelId],
  );
}

export interface ChapterRow {
  id: number;
  idx: number;
  title: string;
  chapter_url: string;
  content: string | null;
}

export async function getChapterRow(
  novelId: number,
  idx: number,
): Promise<ChapterRow | null> {
  const db = await getDb();
  if (document.hidden) return getChapterRowChunked(db, novelId, idx);
  const rows = await db.select<ChapterRow[]>(
    `SELECT id, idx, title, chapter_url, content
     FROM chapters WHERE novel_id = $1 AND idx = $2`,
    [novelId, idx],
  );
  return rows[0] ?? null;
}

// chars per piece; keeps even escape-heavy text under tauri's 8kb inline limit
const CONTENT_CHUNK = 1200;

/**
 * Same row, with the content read in small pieces. Tauri on Android hands
 * responses over 8kb to the webview through a fetch, which a hidden, silent
 * page defers until it's visible again; this kept device-voice playback from
 * crossing into the next chapter with the screen off.
 */
async function getChapterRowChunked(
  db: Database,
  novelId: number,
  idx: number,
): Promise<ChapterRow | null> {
  const rows = await db.select<(Omit<ChapterRow, "content"> & { len: number | null })[]>(
    `SELECT id, idx, title, chapter_url, length(content) AS len
     FROM chapters WHERE novel_id = $1 AND idx = $2`,
    [novelId, idx],
  );
  const row = rows[0];
  if (!row) return null;
  const { len, ...rest } = row;
  if (len === null) return { ...rest, content: null };
  let content = "";
  for (let start = 1; start <= len; start += CONTENT_CHUNK) {
    const part = await db.select<{ c: string }[]>(
      `SELECT substr(content, $1, $2) AS c FROM chapters WHERE id = $3`,
      [start, CONTENT_CHUNK, row.id],
    );
    content += part[0]?.c ?? "";
  }
  return { ...rest, content };
}

export async function saveChapterContent(
  chapterId: number,
  content: string,
  realTitle?: string | null,
): Promise<void> {
  const db = await getDb();
  if (realTitle) {
    // Upgrade synthesized "Chapter N" placeholders with the real title.
    await db.execute(
      `UPDATE chapters SET content = $1, downloaded_at = datetime('now'), title = $2 WHERE id = $3`,
      [content, realTitle, chapterId],
    );
  } else {
    await db.execute(
      `UPDATE chapters SET content = $1, downloaded_at = datetime('now') WHERE id = $2`,
      [content, chapterId],
    );
  }
}

/** A chapter's offline audio download and the settings it was made at. */
export interface AudioDownload {
  chapter_id: number;
  voice: string;
  rate: number;
  pitch: number;
  bytes: number;
  segments: number;
}

/** Record (or replace) a chapter's offline audio download at given settings. */
export async function recordAudioDownload(
  chapterId: number,
  novelId: number,
  voice: string,
  rate: number,
  pitch: number,
  bytes: number,
  segments: number,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO audio_downloads
       (chapter_id, novel_id, voice, rate, pitch, bytes, segments, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, datetime('now'))
     ON CONFLICT (chapter_id) DO UPDATE SET
       novel_id = excluded.novel_id, voice = excluded.voice, rate = excluded.rate,
       pitch = excluded.pitch, bytes = excluded.bytes, segments = excluded.segments,
       created_at = excluded.created_at`,
    [chapterId, novelId, voice, rate, pitch, bytes, segments],
  );
}

/** Audio-download records for one novel (to mark chapters in the reader). */
export async function fetchAudioDownloads(
  novelId: number,
): Promise<AudioDownload[]> {
  const db = await getDb();
  return db.select<AudioDownload[]>(
    `SELECT chapter_id, voice, rate, pitch, bytes, segments
     FROM audio_downloads WHERE novel_id = $1`,
    [novelId],
  );
}

/** Library-wide offline audio total, for the Settings readout. */
export async function fetchAudioCacheTotal(): Promise<{
  chapters: number;
  bytes: number;
}> {
  const db = await getDb();
  const rows = await db.select<{ chapters: number; bytes: number | null }[]>(
    `SELECT COUNT(*) AS chapters, COALESCE(SUM(bytes), 0) AS bytes
     FROM audio_downloads`,
  );
  return { chapters: rows[0]?.chapters ?? 0, bytes: rows[0]?.bytes ?? 0 };
}

/** Forget all audio-download records (the MP3s are cleared separately). */
export async function clearAudioDownloads(): Promise<void> {
  const db = await getDb();
  await db.execute(`DELETE FROM audio_downloads`);
}

/**
 * Bump "last read" recency without touching the confirmed chapter/segment —
 * called once when a reader session opens, so simply reading (no TTS, no
 * finished chapter yet) still surfaces the novel in the sidebar's recents.
 */
export async function touchLastRead(novelId: number): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE novels SET last_read_at = datetime('now') WHERE id = $1`,
    [novelId],
  );
}

/** Persist exact reading position (implementation.md §3E).
 * position_updated_at is the device-sync clock: only set here, never by
 * touchLastRead, so an opened-but-unread novel can't win a sync merge. */
export async function savePosition(
  novelId: number,
  chapterIdx: number,
  segment: number,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE novels SET last_read_chapter = $1, last_read_segment = $2,
                       last_read_at = datetime('now'),
                       position_updated_at = datetime('now')
     WHERE id = $3`,
    [chapterIdx, segment, novelId],
  );
  schedulePush();
}

export interface RecentNovel {
  id: number;
  title: string;
  last_read_chapter: number | null;
  last_read_segment: number | null;
}

/** Most recently read novels, for the sidebar. */
export async function fetchRecents(limit = 5): Promise<RecentNovel[]> {
  const db = await getDb();
  return db.select<RecentNovel[]>(
    `SELECT id, title, last_read_chapter, last_read_segment
     FROM novels WHERE last_read_at IS NOT NULL
     ORDER BY last_read_at DESC LIMIT $1`,
    [limit],
  );
}

/** Delete one chapter's downloaded content (the chapter entry stays). */
export async function clearChapterContent(chapterId: number): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE chapters SET content = NULL, downloaded_at = NULL WHERE id = $1`,
    [chapterId],
  );
}

/** Delete all downloaded content of a novel (library entry stays). */
export async function clearNovelDownloads(novelId: number): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE chapters SET content = NULL, downloaded_at = NULL WHERE novel_id = $1`,
    [novelId],
  );
}

/** Remove a novel from the library entirely (chapters + its dictionary rules). */
export async function removeNovel(novelId: number): Promise<void> {
  const db = await getDb();
  const rows = await db.select<{ source_id: string; novel_url: string }[]>(
    `SELECT source_id, novel_url FROM novels WHERE id = $1`,
    [novelId],
  );
  await deleteNovelRows(novelId);
  // Tombstone + immediate push: without it, another device that still lists
  // this novel adds it right back at the next sync (see lib/sync.ts).
  if (rows[0]) {
    await recordDeletion(rows[0].source_id, rows[0].novel_url);
    schedulePush();
  }
}

/** Remove a novel because another device deleted it, keeping that device's
 * tombstone clock — re-stamping it with "now" would let this device's copy
 * of the removal outrank a later re-add somewhere else. */
export async function removeNovelForSync(
  novelId: number,
  sourceId: string,
  novelUrl: string,
  deletedAt: string,
): Promise<void> {
  await deleteNovelRows(novelId);
  await recordDeletion(sourceId, novelUrl, deletedAt);
}

async function deleteNovelRows(novelId: number): Promise<void> {
  const db = await getDb();
  await db.execute(`DELETE FROM chapters WHERE novel_id = $1`, [novelId]);
  await db.execute(`DELETE FROM dictionary WHERE novel_id = $1`, [novelId]);
  await db.execute(`DELETE FROM bookmarks WHERE novel_id = $1`, [novelId]);
  await db.execute(`DELETE FROM novels WHERE id = $1`, [novelId]);
}

export interface Deletion {
  source_id: string;
  novel_url: string;
  deleted_at: string;
}

/** Record that a novel was removed, so sync treats it as deleted rather than
 * merely missing. Keeps the newest clock when one already exists. */
export async function recordDeletion(
  sourceId: string,
  novelUrl: string,
  deletedAt?: string,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO deletions (source_id, novel_url, deleted_at)
     VALUES ($1, $2, COALESCE($3, datetime('now')))
     ON CONFLICT (source_id, novel_url) DO UPDATE SET
       deleted_at = MAX(deletions.deleted_at, excluded.deleted_at)`,
    [sourceId, novelUrl, deletedAt ?? null],
  );
}

export async function fetchDeletions(): Promise<Deletion[]> {
  const db = await getDb();
  return db.select<Deletion[]>(
    `SELECT source_id, novel_url, deleted_at FROM deletions`,
  );
}

/** Forget tombstones this old. A device offline for longer than this can still
 * resurrect a novel — the trade-off for not growing the sync doc forever. */
export async function pruneDeletions(days = 180): Promise<void> {
  const db = await getDb();
  await db.execute(
    `DELETE FROM deletions WHERE deleted_at < datetime('now', $1)`,
    [`-${days} days`],
  );
}

/** Drop a novel's tombstone, so deliberately adding it again sticks. */
async function clearDeletion(sourceId: string, novelUrl: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    `DELETE FROM deletions WHERE source_id = $1 AND novel_url = $2`,
    [sourceId, novelUrl],
  );
}

/** Persist per-novel TTS settings (implementation.md §6). */
export async function saveTtsSettings(
  novelId: number,
  voice: string,
  rate: number,
  pitch: number,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE novels SET tts_voice = $1, tts_rate = $2, tts_pitch = $3 WHERE id = $4`,
    [voice, rate, pitch, novelId],
  );
}

/** Insert a novel + its chapter refs (content is downloaded separately). */
export async function addToLibrary(details: NovelDetails): Promise<void> {
  const db = await getDb();
  // An add outranks any earlier removal of the same novel.
  await clearDeletion(details.source_id, details.novel_url);
  const res = await db.execute(
    `INSERT OR IGNORE INTO novels
       (source_id, novel_url, title, author, cover_url, status, summary)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      details.source_id,
      details.novel_url,
      details.title,
      details.author,
      details.cover_url,
      details.status,
      details.summary,
    ],
  );
  if (res.rowsAffected === 0) return; // already in library

  await insertChapters(res.lastInsertId as number, details);
  // Publish the add promptly: until it lands, another device still sees only
  // the tombstone this add just cleared and would delete the novel again.
  schedulePush();
}

/** Batched chapter insert — thousands of rows would be far too slow one-by-one. */
async function insertChapters(
  novelId: number,
  details: NovelDetails,
): Promise<number> {
  const db = await getDb();
  const CHUNK = 200; // 4 params/row, well under SQLite's variable limit
  let affected = 0;
  for (let i = 0; i < details.chapters.length; i += CHUNK) {
    const chunk = details.chapters.slice(i, i + CHUNK);
    const placeholders = chunk
      .map(
        (_, j) => `($${j * 4 + 1}, $${j * 4 + 2}, $${j * 4 + 3}, $${j * 4 + 4})`,
      )
      .join(", ");
    const values = chunk.flatMap((ch) => [
      novelId,
      ch.chapter_url,
      ch.index,
      ch.title,
    ]);
    const res = await db.execute(
      `INSERT OR IGNORE INTO chapters (novel_id, chapter_url, idx, title)
       VALUES ${placeholders}`,
      values,
    );
    affected += res.rowsAffected;
  }
  return affected;
}

/**
 * Insert a locally-imported novel (epub/pdf/txt) with every chapter's content
 * already filled in — there's no live source to download the rest from.
 */
export async function addImportedNovel(imported: ImportedNovel): Promise<number> {
  const db = await getDb();
  const slug = imported.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 60);
  const novelUrl = `local://${Date.now()}-${slug || "novel"}`;

  const res = await db.execute(
    `INSERT INTO novels (source_id, novel_url, title, author, cover_url, status, summary)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      "local",
      novelUrl,
      imported.title,
      imported.author,
      imported.cover_base64,
      "Imported",
      null,
    ],
  );
  const novelId = res.lastInsertId as number;

  try {
    const CHUNK = 150; // 5 params/row, well under SQLite's variable limit
    for (let i = 0; i < imported.chapters.length; i += CHUNK) {
      const chunk = imported.chapters.slice(i, i + CHUNK);
      const placeholders = chunk
        .map(
          (_, j) =>
            `($${j * 5 + 1}, $${j * 5 + 2}, $${j * 5 + 3}, $${j * 5 + 4}, $${j * 5 + 5}, datetime('now'))`,
        )
        .join(", ");
      const values = chunk.flatMap((ch, j) => [
        novelId,
        `local-chapter-${i + j + 1}`,
        i + j + 1,
        ch.title,
        ch.html,
      ]);
      await db.execute(
        `INSERT INTO chapters (novel_id, chapter_url, idx, title, content, downloaded_at)
         VALUES ${placeholders}`,
        values,
      );
    }
  } catch (e) {
    // No partial novels: the plugin's pool can't span a transaction across calls.
    await deleteNovelRows(novelId);
    throw e;
  }

  return novelId;
}

const BACKUP_FORMAT = "vates-novel-backup";
// Chapters per line; keeps each IPC write and each parsed line small.
const BACKUP_CHAPTER_BATCH = 25;

export interface RestoreResult {
  novelsAdded: number;
  novelsSkipped: number;
}

interface BackupHeader {
  format: string;
  global_dictionary?: any[];
  collections?: string[];
}

export const isBackupHeader = (v: unknown): v is BackupHeader =>
  (v as BackupHeader | null)?.format === BACKUP_FORMAT;

/** Stream a full library backup as JSON lines: a header, then each novel
 * followed by its chapters in batches. */
export async function writeLibraryBackup(
  write: (line: string) => Promise<void>,
): Promise<void> {
  const db = await getDb();
  const novels = await db.select<any[]>(`SELECT * FROM novels ORDER BY id`);
  const dict = await db.select<any[]>(`SELECT * FROM dictionary ORDER BY id`);
  const collections = await fetchCollections();
  const memberships = await db.select<{ novel_id: number; name: string }[]>(
    `SELECT nc.novel_id, c.name FROM novel_collections nc
     JOIN collections c ON c.id = nc.collection_id`,
  );
  const bookmarks = await db.select<any[]>(`SELECT * FROM bookmarks ORDER BY id`);

  const collectionsByNovel = new Map<number, string[]>();
  for (const m of memberships) {
    const list = collectionsByNovel.get(m.novel_id) ?? [];
    list.push(m.name);
    collectionsByNovel.set(m.novel_id, list);
  }
  const bookmarksByNovel = new Map<number, any[]>();
  for (const b of bookmarks) {
    const list = bookmarksByNovel.get(b.novel_id) ?? [];
    list.push({
      chapter_idx: b.chapter_idx,
      segment: b.segment,
      excerpt: b.excerpt,
      created_at: b.created_at,
    });
    bookmarksByNovel.set(b.novel_id, list);
  }

  const dictByNovel = new Map<number, any[]>();
  const globalDictionary: any[] = [];
  for (const d of dict) {
    const entry = {
      pattern: d.pattern,
      replacement: d.replacement,
      is_regex: d.is_regex,
    };
    if (d.novel_id == null) {
      globalDictionary.push(entry);
    } else {
      const list = dictByNovel.get(d.novel_id) ?? [];
      list.push(entry);
      dictByNovel.set(d.novel_id, list);
    }
  }

  await write(
    JSON.stringify({
      format: BACKUP_FORMAT,
      version: 2,
      exported_at: new Date().toISOString(),
      global_dictionary: globalDictionary,
      collections: collections.map((c) => c.name),
    }),
  );

  for (const n of novels) {
    await write(
      JSON.stringify({
        novel: {
          source_id: n.source_id,
          novel_url: n.novel_url,
          title: n.title,
          author: n.author,
          cover_url: n.cover_url,
          status: n.status,
          summary: n.summary,
          last_read_chapter: n.last_read_chapter,
          last_read_segment: n.last_read_segment,
          position_updated_at: n.position_updated_at,
          tts_voice: n.tts_voice,
          tts_rate: n.tts_rate,
          tts_pitch: n.tts_pitch,
          dictionary: dictByNovel.get(n.id) ?? [],
          collections: collectionsByNovel.get(n.id) ?? [],
          bookmarks: bookmarksByNovel.get(n.id) ?? [],
        },
      }),
    );

    let afterId = 0;
    for (;;) {
      const rows = await db.select<any[]>(
        `SELECT id, chapter_url, idx, title, content FROM chapters
         WHERE novel_id = $1 AND id > $2 ORDER BY id LIMIT $3`,
        [n.id, afterId, BACKUP_CHAPTER_BATCH],
      );
      if (rows.length === 0) break;
      afterId = rows[rows.length - 1].id;
      await write(
        JSON.stringify({ chapters: rows.map(({ id: _id, ...c }) => c) }),
      );
    }
  }
}

/** Adds a backed-up novel; returns its new id, or null if already present. */
async function restoreNovel(n: any): Promise<number | null> {
  const db = await getDb();
  const res = await db.execute(
    `INSERT OR IGNORE INTO novels
       (source_id, novel_url, title, author, cover_url, status, summary,
        last_read_chapter, last_read_segment, position_updated_at,
        tts_voice, tts_rate, tts_pitch)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      n.source_id,
      n.novel_url,
      n.title,
      n.author ?? null,
      n.cover_url ?? null,
      n.status ?? null,
      n.summary ?? null,
      n.last_read_chapter ?? null,
      n.last_read_segment ?? null,
      n.position_updated_at ?? null,
      n.tts_voice ?? null,
      n.tts_rate ?? null,
      n.tts_pitch ?? null,
    ],
  );
  if (res.rowsAffected === 0) return null; // same source_id + novel_url
  // Restoring a novel beats an earlier removal of it, here and on sync.
  await clearDeletion(n.source_id, n.novel_url);
  const novelId = res.lastInsertId as number;

  const rules: any[] = Array.isArray(n.dictionary) ? n.dictionary : [];
  for (const r of rules) {
    await db.execute(
      `INSERT INTO dictionary (novel_id, pattern, replacement, is_regex)
       VALUES ($1, $2, $3, $4)`,
      [novelId, r.pattern, r.replacement, r.is_regex ? 1 : 0],
    );
  }
  return novelId;
}

async function restoreChapters(novelId: number, chs: any[]): Promise<void> {
  const db = await getDb();
  const CHUNK = 100; // 5 params/row, well under SQLite's variable limit
  for (let i = 0; i < chs.length; i += CHUNK) {
    const chunk = chs.slice(i, i + CHUNK);
    const placeholders = chunk
      .map(
        (_, j) =>
          `($${j * 5 + 1}, $${j * 5 + 2}, $${j * 5 + 3}, $${j * 5 + 4}, $${j * 5 + 5})`,
      )
      .join(", ");
    const values = chunk.flatMap((c) => [
      novelId,
      c.chapter_url,
      c.idx,
      c.title,
      c.content ?? null,
    ]);
    await db.execute(
      `INSERT OR IGNORE INTO chapters (novel_id, chapter_url, idx, title, content)
       VALUES ${placeholders}`,
      values,
    );
  }
}

/** Collections and bookmarks merge even into a novel already in the library,
 * which sync may have added without them. */
async function restoreNovelLinks(n: any): Promise<void> {
  const db = await getDb();
  const rows = await db.select<{ id: number }[]>(
    `SELECT id FROM novels WHERE source_id = $1 AND novel_url = $2`,
    [n.source_id, n.novel_url],
  );
  const novelId = rows[0]?.id;
  if (novelId === undefined) return;

  for (const name of Array.isArray(n.collections) ? n.collections : []) {
    await setNovelCollection(novelId, await createCollection(name), true);
  }
  for (const b of Array.isArray(n.bookmarks) ? n.bookmarks : []) {
    await db.execute(
      `INSERT OR IGNORE INTO bookmarks (novel_id, chapter_idx, segment, excerpt, created_at)
       VALUES ($1, $2, $3, $4, COALESCE($5, datetime('now')))`,
      [novelId, b.chapter_idx, b.segment, b.excerpt ?? "", b.created_at ?? null],
    );
  }
}

async function restoreGlobalDictionary(rules: unknown): Promise<void> {
  const db = await getDb();
  for (const r of Array.isArray(rules) ? (rules as any[]) : []) {
    const existing = await db.select<any[]>(
      `SELECT id FROM dictionary WHERE novel_id IS NULL AND pattern = $1 AND replacement = $2`,
      [r.pattern, r.replacement],
    );
    if (existing.length === 0) {
      await db.execute(
        `INSERT INTO dictionary (novel_id, pattern, replacement, is_regex)
         VALUES (NULL, $1, $2, $3)`,
        [r.pattern, r.replacement, r.is_regex ? 1 : 0],
      );
    }
  }
}

/** Restore a backup from writeLibraryBackup. Existing novels (matched by
 * source_id + novel_url) keep their chapters and position. */
export async function readLibraryBackup(
  header: BackupHeader,
  lines: AsyncIterable<string>,
): Promise<RestoreResult> {
  await restoreGlobalDictionary(header.global_dictionary);
  for (const name of header.collections ?? []) await createCollection(name);

  let novelsAdded = 0;
  let novelsSkipped = 0;
  let restoring: number | null = null; // id of the novel taking chapters, if new
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (entry.novel) {
        restoring = await restoreNovel(entry.novel);
        if (restoring === null) novelsSkipped++;
        else novelsAdded++;
        await restoreNovelLinks(entry.novel);
      } else if (entry.chapters && restoring !== null) {
        await restoreChapters(restoring, entry.chapters);
      }
    }
  } catch (e) {
    if (restoring !== null) await deleteNovelRows(restoring);
    throw e;
  }

  if (novelsAdded > 0) schedulePush(); // same reason as in addToLibrary
  return { novelsAdded, novelsSkipped };
}

/** Restore a pre-streaming (single JSON document) backup. */
export async function importLibraryJson(json: string): Promise<RestoreResult> {
  const backup = JSON.parse(json);
  if (!backup || !Array.isArray(backup.novels)) {
    throw new Error("not a valid library backup file");
  }

  let novelsAdded = 0;
  let novelsSkipped = 0;

  for (const n of backup.novels) {
    const novelId = await restoreNovel(n);
    if (novelId === null) {
      novelsSkipped++;
      continue;
    }
    try {
      await restoreChapters(novelId, Array.isArray(n.chapters) ? n.chapters : []);
    } catch (e) {
      await deleteNovelRows(novelId);
      throw e;
    }
    novelsAdded++;
  }

  await restoreGlobalDictionary(backup.global_dictionary);

  if (novelsAdded > 0) schedulePush(); // same reason as in addToLibrary
  return { novelsAdded, novelsSkipped };
}

export interface Bookmark {
  id: number;
  chapter_idx: number;
  segment: number;
  excerpt: string;
}

export async function fetchBookmarks(novelId: number): Promise<Bookmark[]> {
  const db = await getDb();
  return db.select<Bookmark[]>(
    `SELECT id, chapter_idx, segment, excerpt FROM bookmarks
     WHERE novel_id = $1 ORDER BY chapter_idx, segment`,
    [novelId],
  );
}

export async function addBookmark(
  novelId: number,
  chapterIdx: number,
  segment: number,
  excerpt: string,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT OR IGNORE INTO bookmarks (novel_id, chapter_idx, segment, excerpt)
     VALUES ($1, $2, $3, $4)`,
    [novelId, chapterIdx, segment, excerpt],
  );
}

export async function deleteBookmark(id: number): Promise<void> {
  const db = await getDb();
  await db.execute(`DELETE FROM bookmarks WHERE id = $1`, [id]);
}

export interface FindResult {
  idx: number;
  title: string;
  snippet: string;
}

// Chapter bodies are stored as HTML, so the query has to be escaped to match.
const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Downloaded chapters containing `query`, each with its first match in context. */
export async function findInChapters(
  novelId: number,
  query: string,
  limit = 200,
): Promise<FindResult[]> {
  const db = await getDb();
  const rows = await db.select<FindResult[]>(
    `SELECT idx, title, substr(content, MAX(pos - 60, 1), 240) AS snippet
     FROM (SELECT idx, title, content, instr(lower(content), lower($1)) AS pos
           FROM chapters WHERE novel_id = $2 AND content IS NOT NULL)
     WHERE pos > 0 ORDER BY idx LIMIT $3`,
    [escapeHtml(query), novelId, limit],
  );
  return rows.map((r) => ({ ...r, snippet: snippetText(r.snippet) }));
}

/** Plain text of an HTML excerpt that may start or end inside a tag. */
function snippetText(html: string): string {
  const whole = html.replace(/^[^<]*>/, "").replace(/<[^>]*$/, "");
  const text = new DOMParser().parseFromString(whole, "text/html").body.textContent ?? "";
  return text.replace(/\s+/g, " ").trim();
}

export interface Collection {
  id: number;
  name: string;
}

/** All collections, alphabetically. */
export async function fetchCollections(): Promise<Collection[]> {
  const db = await getDb();
  return db.select<Collection[]>(`SELECT id, name FROM collections ORDER BY name`);
}

/** novel_id -> collection_ids[], for filtering the Library grid client-side. */
export async function fetchAllNovelCollections(): Promise<Map<number, number[]>> {
  const db = await getDb();
  const rows = await db.select<{ novel_id: number; collection_id: number }[]>(
    `SELECT novel_id, collection_id FROM novel_collections`,
  );
  const map = new Map<number, number[]>();
  for (const r of rows) {
    const list = map.get(r.novel_id) ?? [];
    list.push(r.collection_id);
    map.set(r.novel_id, list);
  }
  return map;
}

export async function fetchNovelCollectionIds(novelId: number): Promise<number[]> {
  const db = await getDb();
  const rows = await db.select<{ collection_id: number }[]>(
    `SELECT collection_id FROM novel_collections WHERE novel_id = $1`,
    [novelId],
  );
  return rows.map((r) => r.collection_id);
}

/** Create a collection (or return the existing one of the same name). */
export async function createCollection(name: string): Promise<number> {
  const db = await getDb();
  const trimmed = name.trim();
  await db.execute(`INSERT OR IGNORE INTO collections (name) VALUES ($1)`, [trimmed]);
  const rows = await db.select<{ id: number }[]>(
    `SELECT id FROM collections WHERE name = $1`,
    [trimmed],
  );
  return rows[0].id;
}

export async function deleteCollection(collectionId: number): Promise<void> {
  const db = await getDb();
  await db.execute(`DELETE FROM collections WHERE id = $1`, [collectionId]);
}

export async function setNovelCollection(
  novelId: number,
  collectionId: number,
  member: boolean,
): Promise<void> {
  const db = await getDb();
  if (member) {
    await db.execute(
      `INSERT OR IGNORE INTO novel_collections (novel_id, collection_id) VALUES ($1, $2)`,
      [novelId, collectionId],
    );
  } else {
    await db.execute(
      `DELETE FROM novel_collections WHERE novel_id = $1 AND collection_id = $2`,
      [novelId, collectionId],
    );
  }
}

/** Downloaded chapters (with content) in reading order, for novel export. */
export async function fetchChaptersForExport(
  novelId: number,
): Promise<{ title: string; html: string }[]> {
  const db = await getDb();
  return db.select<{ title: string; html: string }[]>(
    `SELECT title, content AS html FROM chapters
     WHERE novel_id = $1 AND content IS NOT NULL
     ORDER BY idx ASC`,
    [novelId],
  );
}

export interface DictRule {
  id: number;
  novel_id: number | null;
  pattern: string;
  replacement: string;
  is_regex: number;
}

/** Global rules plus (optionally) the rules of one novel. */
export async function fetchRules(novelId?: number): Promise<DictRule[]> {
  const db = await getDb();
  return novelId == null
    ? db.select<DictRule[]>(
        `SELECT * FROM dictionary WHERE novel_id IS NULL ORDER BY id`,
      )
    : db.select<DictRule[]>(
        `SELECT * FROM dictionary WHERE novel_id IS NULL OR novel_id = $1 ORDER BY id`,
        [novelId],
      );
}

export async function addRule(
  pattern: string,
  replacement: string,
  isRegex: boolean,
  novelId: number | null,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO dictionary (novel_id, pattern, replacement, is_regex)
     VALUES ($1, $2, $3, $4)`,
    [novelId, pattern, replacement, isRegex ? 1 : 0],
  );
}

export async function deleteRule(id: number): Promise<void> {
  const db = await getDb();
  await db.execute(`DELETE FROM dictionary WHERE id = $1`, [id]);
}

/**
 * Merge newly-scraped chapter refs into an existing novel; returns # added.
 * Bumps new_chapters_count so the Library screen can badge it — cleared once
 * the novel is opened (see clearNewChaptersBadge).
 */
export async function mergeChapters(
  novelId: number,
  details: NovelDetails,
): Promise<number> {
  const added = await insertChapters(novelId, details);
  if (added > 0) {
    const db = await getDb();
    await db.execute(
      `UPDATE novels SET new_chapters_count = new_chapters_count + $1 WHERE id = $2`,
      [added, novelId],
    );
  }
  return added;
}

/** Acknowledge newly-discovered chapters (called when the novel is opened). */
export async function clearNewChaptersBadge(novelId: number): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE novels SET new_chapters_count = 0 WHERE id = $1`,
    [novelId],
  );
}
