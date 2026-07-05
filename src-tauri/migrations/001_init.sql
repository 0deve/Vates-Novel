-- Initial schema: novels, chapters, pronunciation dictionary.

CREATE TABLE IF NOT EXISTS novels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id TEXT NOT NULL,
    novel_url TEXT NOT NULL,
    title TEXT NOT NULL,
    author TEXT,
    cover_url TEXT,
    status TEXT,
    summary TEXT,
    added_at TEXT NOT NULL DEFAULT (datetime('now')),
    -- Exact reading position (implementation.md §3E)
    last_read_chapter INTEGER,
    last_read_segment INTEGER,
    last_read_scroll REAL,
    -- Per-novel TTS settings (fall back to global defaults when NULL)
    tts_voice TEXT,
    tts_rate INTEGER,
    tts_pitch INTEGER,
    UNIQUE (source_id, novel_url)
);

CREATE TABLE IF NOT EXISTS chapters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    novel_id INTEGER NOT NULL REFERENCES novels (id) ON DELETE CASCADE,
    chapter_url TEXT NOT NULL,
    idx INTEGER NOT NULL,
    title TEXT NOT NULL,
    -- Cleaned chapter text; NULL until downloaded
    content TEXT,
    downloaded_at TEXT,
    UNIQUE (novel_id, chapter_url)
);

CREATE INDEX IF NOT EXISTS idx_chapters_novel ON chapters (novel_id, idx);

-- Find/replace rules applied to TTS input (global when novel_id IS NULL).
CREATE TABLE IF NOT EXISTS dictionary (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    novel_id INTEGER REFERENCES novels (id) ON DELETE CASCADE,
    pattern TEXT NOT NULL,
    replacement TEXT NOT NULL,
    is_regex INTEGER NOT NULL DEFAULT 0
);
