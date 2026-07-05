import Database from "@tauri-apps/plugin-sql";
import type {
  ChapterMeta,
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
            n.status, n.summary,
            (SELECT COUNT(*) FROM chapters c WHERE c.novel_id = n.id) AS chapter_count
     FROM novels n
     ORDER BY n.added_at DESC`,
  );
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
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE novels SET tts_voice = $1, tts_rate = $2 WHERE id = $3`,
    [voice, rate, novelId],
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

/** Merge newly-scraped chapter refs into an existing novel; returns # added. */
export async function mergeChapters(
  novelId: number,
  details: NovelDetails,
): Promise<number> {
  return insertChapters(novelId, details);
}
