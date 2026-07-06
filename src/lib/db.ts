import Database from "@tauri-apps/plugin-sql";
import type {
  ChapterMeta,
  ImportedNovel,
  LibraryNovel,
  NovelDetails,
  NovelRow,
} from "../types";

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
  const rows = await db.select<ChapterRow[]>(
    `SELECT id, idx, title, chapter_url, content
     FROM chapters WHERE novel_id = $1 AND idx = $2`,
    [novelId, idx],
  );
  return rows[0] ?? null;
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

/** Persist exact reading position (implementation.md §3E). */
export async function savePosition(
  novelId: number,
  chapterIdx: number,
  segment: number,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE novels SET last_read_chapter = $1, last_read_segment = $2,
                       last_read_at = datetime('now')
     WHERE id = $3`,
    [chapterIdx, segment, novelId],
  );
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
  await db.execute(`DELETE FROM chapters WHERE novel_id = $1`, [novelId]);
  await db.execute(`DELETE FROM dictionary WHERE novel_id = $1`, [novelId]);
  await db.execute(`DELETE FROM novels WHERE id = $1`, [novelId]);
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
 * Insert a locally-imported novel (epub/txt) with every chapter's content
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

  return novelId;
}

/** Full library backup (novels + their chapters + dictionary rules) as JSON. */
export async function exportLibraryJson(): Promise<string> {
  const db = await getDb();
  const novels = await db.select<any[]>(`SELECT * FROM novels ORDER BY id`);
  const chapters = await db.select<any[]>(
    `SELECT * FROM chapters ORDER BY novel_id, idx`,
  );
  const dict = await db.select<any[]>(`SELECT * FROM dictionary ORDER BY id`);

  const chaptersByNovel = new Map<number, any[]>();
  for (const c of chapters) {
    const list = chaptersByNovel.get(c.novel_id) ?? [];
    list.push({
      chapter_url: c.chapter_url,
      idx: c.idx,
      title: c.title,
      content: c.content,
    });
    chaptersByNovel.set(c.novel_id, list);
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

  const novelsOut = novels.map((n) => ({
    source_id: n.source_id,
    novel_url: n.novel_url,
    title: n.title,
    author: n.author,
    cover_url: n.cover_url,
    status: n.status,
    summary: n.summary,
    last_read_chapter: n.last_read_chapter,
    last_read_segment: n.last_read_segment,
    tts_voice: n.tts_voice,
    tts_rate: n.tts_rate,
    tts_pitch: n.tts_pitch,
    chapters: chaptersByNovel.get(n.id) ?? [],
    dictionary: dictByNovel.get(n.id) ?? [],
  }));

  return JSON.stringify(
    {
      version: 1,
      exported_at: new Date().toISOString(),
      novels: novelsOut,
      global_dictionary: globalDictionary,
    },
    null,
    2,
  );
}

/** Restore a backup produced by exportLibraryJson. Existing novels (matched by
 * source_id + novel_url) are left untouched — only new ones are added. */
export async function importLibraryJson(
  json: string,
): Promise<{ novelsAdded: number; novelsSkipped: number }> {
  const db = await getDb();
  const backup = JSON.parse(json);
  if (!backup || !Array.isArray(backup.novels)) {
    throw new Error("not a valid library backup file");
  }

  let novelsAdded = 0;
  let novelsSkipped = 0;

  for (const n of backup.novels) {
    const res = await db.execute(
      `INSERT OR IGNORE INTO novels
         (source_id, novel_url, title, author, cover_url, status, summary,
          last_read_chapter, last_read_segment, tts_voice, tts_rate, tts_pitch)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
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
        n.tts_voice ?? null,
        n.tts_rate ?? null,
        n.tts_pitch ?? null,
      ],
    );
    if (res.rowsAffected === 0) {
      novelsSkipped++;
      continue; // already in the library (same source_id + novel_url)
    }
    novelsAdded++;
    const novelId = res.lastInsertId as number;

    const chs: any[] = Array.isArray(n.chapters) ? n.chapters : [];
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

    const rules: any[] = Array.isArray(n.dictionary) ? n.dictionary : [];
    for (const r of rules) {
      await db.execute(
        `INSERT INTO dictionary (novel_id, pattern, replacement, is_regex)
         VALUES ($1, $2, $3, $4)`,
        [novelId, r.pattern, r.replacement, r.is_regex ? 1 : 0],
      );
    }
  }

  const globalRules: any[] = Array.isArray(backup.global_dictionary)
    ? backup.global_dictionary
    : [];
  for (const r of globalRules) {
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

  return { novelsAdded, novelsSkipped };
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
