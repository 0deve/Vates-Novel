//! Cover search (Open Library, Google Books) and image fetch for the shelf's cover picker.

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::time::Duration;

const MAX_IMAGE_BYTES: usize = 15 * 1024 * 1024;

fn client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
        .timeout(Duration::from_secs(30))
        .build()
        .expect("failed to build http client")
}

#[derive(Serialize)]
pub struct CoverHit {
    pub url: String,
    pub title: String,
    pub author: Option<String>,
    pub source: String,
}

#[derive(Deserialize)]
struct OlPage {
    docs: Vec<OlDoc>,
}
#[derive(Deserialize)]
struct OlDoc {
    title: String,
    #[serde(default)]
    author_name: Vec<String>,
    cover_i: Option<u64>,
}

#[derive(Deserialize)]
struct GbPage {
    #[serde(default)]
    items: Vec<GbItem>,
}
#[derive(Deserialize)]
struct GbItem {
    #[serde(rename = "volumeInfo")]
    info: GbInfo,
}
#[derive(Deserialize)]
struct GbInfo {
    title: String,
    #[serde(default)]
    authors: Vec<String>,
    #[serde(rename = "imageLinks")]
    links: Option<GbLinks>,
}
#[derive(Deserialize)]
struct GbLinks {
    thumbnail: Option<String>,
}

fn open_library(c: &reqwest::blocking::Client, q: &str) -> Result<Vec<CoverHit>, String> {
    let page: OlPage = c
        .get("https://openlibrary.org/search.json")
        .query(&[("q", q), ("limit", "24"), ("fields", "title,author_name,cover_i")])
        .send()
        .and_then(|r| r.error_for_status())
        .and_then(|r| r.json())
        .map_err(|e| format!("Open Library: {e}"))?;
    Ok(page
        .docs
        .into_iter()
        .filter_map(|d| {
            Some(CoverHit {
                url: format!("https://covers.openlibrary.org/b/id/{}-L.jpg", d.cover_i?),
                title: d.title,
                author: d.author_name.first().cloned(),
                source: "Open Library".into(),
            })
        })
        .collect())
}

fn google_books(c: &reqwest::blocking::Client, q: &str) -> Result<Vec<CoverHit>, String> {
    let page: GbPage = c
        .get("https://www.googleapis.com/books/v1/volumes")
        .query(&[("q", q), ("maxResults", "20")])
        .send()
        .and_then(|r| r.error_for_status())
        .and_then(|r| r.json())
        .map_err(|e| format!("Google Books: {e}"))?;
    Ok(page
        .items
        .into_iter()
        .filter_map(|i| {
            let t = i.info.links?.thumbnail?;
            // Thumbnails are tiny by default; fife asks for a larger rendition.
            let url = format!("{}&fife=w800", t.replace("http://", "https://").replace("&edge=curl", ""));
            Some(CoverHit {
                url,
                title: i.info.title,
                author: i.info.authors.first().cloned(),
                source: "Google Books".into(),
            })
        })
        .collect())
}

/// Both providers in parallel; one failing (e.g. Google's keyless quota) doesn't fail the search.
#[tauri::command]
pub async fn search_covers(query: String) -> Result<Vec<CoverHit>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let c = client();
        let (ol, gb) = std::thread::scope(|s| {
            let a = s.spawn(|| open_library(&c, &query));
            let b = s.spawn(|| google_books(&c, &query));
            (a.join().unwrap_or_else(|_| Err("panic".into())), b.join().unwrap_or_else(|_| Err("panic".into())))
        });
        let mut out = Vec::new();
        let mut errors = Vec::new();
        for r in [ol, gb] {
            match r {
                Ok(v) => out.extend(v),
                Err(e) => errors.push(e),
            }
        }
        for e in &errors {
            crate::applog::write("warn", "covers", e);
        }
        if out.is_empty() && !errors.is_empty() {
            return Err(errors.join("; "));
        }
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Download an image as a data: URL, so the webview can draw it to a canvas untainted.
#[tauri::command]
pub async fn fetch_image(url: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let resp = client()
            .get(&url)
            .send()
            .and_then(|r| r.error_for_status())
            .map_err(|e| format!("image fetch failed: {e}"))?;
        let mime = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("image/jpeg")
            .split(';')
            .next()
            .unwrap_or("image/jpeg")
            .to_string();
        if !mime.starts_with("image/") {
            return Err(format!("not an image ({mime})"));
        }
        let bytes = resp.bytes().map_err(|e| e.to_string())?;
        if bytes.len() > MAX_IMAGE_BYTES {
            return Err("image too large".into());
        }
        Ok(format!(
            "data:{mime};base64,{}",
            base64::engine::general_purpose::STANDARD.encode(&bytes)
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}
