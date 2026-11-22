//! Pluggable novel-source system

mod books;
mod stub;

#[cfg(has_source1)]
#[path = "../../../private/source1/mod.rs"]
mod source1;

#[cfg(has_source2)]
#[path = "../../../private/source2/mod.rs"]
mod source2;

#[cfg(has_source3)]
#[path = "../../../private/source3/mod.rs"]
mod source3;

#[cfg(has_source4)]
#[path = "../../../private/source4/mod.rs"]
mod source4;

#[cfg(has_source5)]
#[path = "../../../private/source5/mod.rs"]
mod source5;

#[cfg(has_source6)]
#[path = "../../../private/source6/mod.rs"]
mod source6;

#[cfg(has_source7)]
#[path = "../../../private/source7/mod.rs"]
mod source7;

#[cfg(has_source8)]
#[path = "../../../private/source8/mod.rs"]
mod source8;

use serde::Serialize;
use std::sync::Arc;
use tauri::State;

#[derive(Serialize, Clone)]
pub struct SourceInfo {
    pub id: String,
    pub name: String,
    /// "novel" (chaptered web novels) or "book" (whole-file downloads).
    pub kind: String,
}

#[derive(Serialize, Clone)]
pub struct SearchResult {
    pub source_id: String,
    pub novel_url: String,
    pub title: String,
    pub author: Option<String>,
    pub cover_url: Option<String>,
    pub chapter_count: Option<u32>,
    pub status: Option<String>,
}

/// Chapter body plus the real chapter title when the page provides one
/// (used to upgrade placeholder titles like "Chapter 205").
#[derive(Serialize, Clone)]
pub struct ChapterContent {
    pub title: Option<String>,
    pub html: String,
}

#[derive(Serialize, Clone)]
pub struct ChapterRef {
    pub chapter_url: String,
    pub index: u32,
    pub title: String,
}

#[derive(Serialize, Clone)]
pub struct NovelDetails {
    pub source_id: String,
    pub novel_url: String,
    pub title: String,
    pub author: Option<String>,
    pub cover_url: Option<String>,
    pub status: Option<String>,
    pub summary: Option<String>,
    pub chapters: Vec<ChapterRef>,
}

/// Every novel source implements this trait.
///
/// Implementations are synchronous (blocking I/O is fine): the Tauri commands
/// below run them via `spawn_blocking`, never on the async runtime itself.
pub trait NovelSource: Send + Sync {
    fn id(&self) -> &'static str;
    fn name(&self) -> &'static str;
    fn kind(&self) -> &'static str {
        "novel"
    }
    /// Empty query = "browse popular/ranking" when the source supports it.
    fn search(&self, query: &str) -> Result<Vec<SearchResult>, String>;
    fn novel_details(&self, novel_url: &str) -> Result<NovelDetails, String>;
    /// Returns cleaned chapter HTML ready for segmentation.
    fn chapter_content(&self, chapter_url: &str) -> Result<ChapterContent, String>;
    /// Book sources: the whole epub/pdf as (file name, bytes).
    fn download_book(&self, _book_url: &str) -> Result<(String, Vec<u8>), String> {
        Err("this source serves chapters, not book files".into())
    }
}

pub struct SourceRegistry {
    sources: Vec<Arc<dyn NovelSource>>,
}

impl SourceRegistry {
    pub fn new() -> Self {
        // Real sources in numeric order — source1 is the default in Browse —
        // with the stub last.
        #[allow(unused_mut)]
        let mut sources: Vec<Arc<dyn NovelSource>> = Vec::new();
        #[cfg(has_source1)]
        sources.push(Arc::new(source1::Src::new()));
        #[cfg(has_source2)]
        sources.push(Arc::new(source2::Src::new()));
        #[cfg(has_source3)]
        sources.push(Arc::new(source3::Src::new()));
        #[cfg(has_source4)]
        sources.push(Arc::new(source4::Src::new()));
        #[cfg(has_source5)]
        sources.push(Arc::new(source5::Src::new()));
        #[cfg(has_source6)]
        sources.push(Arc::new(source6::Src::new()));
        #[cfg(has_source7)]
        sources.push(Arc::new(source7::Src::new()));
        #[cfg(has_source8)]
        sources.push(Arc::new(source8::Src::new()));
        sources.push(Arc::new(books::StandardEbooks::new()));
        sources.push(Arc::new(books::Gutenberg::new()));
        sources.push(Arc::new(stub::StubSource));

        Self { sources }
    }

    pub fn get(&self, id: &str) -> Result<Arc<dyn NovelSource>, String> {
        self.sources
            .iter()
            .find(|s| s.id() == id)
            .cloned()
            .ok_or_else(|| format!("unknown source '{id}'"))
    }
}

#[tauri::command]
pub fn list_sources(registry: State<'_, SourceRegistry>) -> Vec<SourceInfo> {
    registry
        .sources
        .iter()
        .map(|s| SourceInfo {
            id: s.id().to_string(),
            name: s.name().to_string(),
            kind: s.kind().to_string(),
        })
        .collect()
}

/// Record source failures with the request that caused them.
fn logged<T>(source_id: &str, ctx: &str, r: Result<T, String>) -> Result<T, String> {
    if let Err(e) = &r {
        crate::applog::error(&format!("source:{source_id}"), &format!("{ctx}: {e}"));
    }
    r
}

#[tauri::command]
pub async fn search_novels(
    registry: State<'_, SourceRegistry>,
    source_id: String,
    query: String,
) -> Result<Vec<SearchResult>, String> {
    let src = registry.get(&source_id)?;
    let ctx = format!("search {query:?}");
    let r = tauri::async_runtime::spawn_blocking(move || src.search(&query))
        .await
        .map_err(|e| e.to_string())?;
    logged(&source_id, &ctx, r)
}

#[tauri::command]
pub async fn get_novel_details(
    registry: State<'_, SourceRegistry>,
    source_id: String,
    novel_url: String,
) -> Result<NovelDetails, String> {
    let src = registry.get(&source_id)?;
    let ctx = format!("details {novel_url}");
    let r = tauri::async_runtime::spawn_blocking(move || src.novel_details(&novel_url))
        .await
        .map_err(|e| e.to_string())?;
    logged(&source_id, &ctx, r)
}

#[tauri::command]
pub async fn get_chapter_content(
    registry: State<'_, SourceRegistry>,
    source_id: String,
    chapter_url: String,
) -> Result<ChapterContent, String> {
    let src = registry.get(&source_id)?;
    let ctx = format!("chapter {chapter_url}");
    let r = tauri::async_runtime::spawn_blocking(move || src.chapter_content(&chapter_url))
        .await
        .map_err(|e| e.to_string())?;
    logged(&source_id, &ctx, r)
}

/// `get_chapter_content`, serialized into a JSON string. Tauri on Android sends
/// object/array responses over 8kb through a fetch that a hidden webview defers
/// until it's visible again, but always injects a bare string directly, so a
/// chapter fetched with the screen off isn't stuck waiting for the app to open.
#[tauri::command]
pub async fn get_chapter_content_inline(
    registry: State<'_, SourceRegistry>,
    source_id: String,
    chapter_url: String,
) -> Result<String, String> {
    let cc = get_chapter_content(registry, source_id, chapter_url).await?;
    serde_json::to_string(&cc).map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct BookImport {
    pub novel: crate::import::ImportedNovel,
    pub details: NovelDetails,
    /// Original file kept in the data dir, for "Export original".
    pub file_path: String,
}

/// Download a whole book from a book source, keep the file, and parse it into chapters.
#[tauri::command]
pub async fn add_book(
    app: tauri::AppHandle,
    registry: State<'_, SourceRegistry>,
    source_id: String,
    book_url: String,
) -> Result<BookImport, String> {
    use tauri::Manager;
    let src = registry.get(&source_id)?;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("books");
    let ctx = format!("book {book_url}");
    let r = tauri::async_runtime::spawn_blocking(move || {
        let details = src.novel_details(&book_url)?;
        let (name, bytes) = src.download_book(&book_url)?;
        let novel = crate::import::import_bytes(&bytes, &name)?;
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let safe: String = name
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' { c } else { '_' })
            .collect();
        let path = dir.join(format!("{}_{safe}", src.id()));
        std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
        Ok(BookImport { novel, details, file_path: path.to_string_lossy().into_owned() })
    })
    .await
    .map_err(|e| e.to_string())?;
    logged(&source_id, &ctx, r)
}

/// Bytes of a kept original book file (only inside the app's books dir).
#[tauri::command]
pub fn read_book_file(app: tauri::AppHandle, path: String) -> Result<Vec<u8>, String> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("books");
    let canon = std::path::PathBuf::from(&path).canonicalize().map_err(|e| e.to_string())?;
    if !canon.starts_with(dir.canonicalize().map_err(|e| e.to_string())?) {
        return Err("not a book file".into());
    }
    std::fs::read(canon).map_err(|e| e.to_string())
}
