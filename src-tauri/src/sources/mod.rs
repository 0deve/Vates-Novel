//! Pluggable novel-source system

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
    /// Empty query = "browse popular/ranking" when the source supports it.
    fn search(&self, query: &str) -> Result<Vec<SearchResult>, String>;
    fn novel_details(&self, novel_url: &str) -> Result<NovelDetails, String>;
    /// Returns cleaned chapter HTML ready for segmentation.
    fn chapter_content(&self, chapter_url: &str) -> Result<ChapterContent, String>;
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
        })
        .collect()
}

#[tauri::command]
pub async fn search_novels(
    registry: State<'_, SourceRegistry>,
    source_id: String,
    query: String,
) -> Result<Vec<SearchResult>, String> {
    let src = registry.get(&source_id)?;
    tauri::async_runtime::spawn_blocking(move || src.search(&query))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_novel_details(
    registry: State<'_, SourceRegistry>,
    source_id: String,
    novel_url: String,
) -> Result<NovelDetails, String> {
    let src = registry.get(&source_id)?;
    tauri::async_runtime::spawn_blocking(move || src.novel_details(&novel_url))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn get_chapter_content(
    registry: State<'_, SourceRegistry>,
    source_id: String,
    chapter_url: String,
) -> Result<ChapterContent, String> {
    let src = registry.get(&source_id)?;
    tauri::async_runtime::spawn_blocking(move || src.chapter_content(&chapter_url))
        .await
        .map_err(|e| e.to_string())?
}
