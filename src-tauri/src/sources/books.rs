//! Whole-book sources: free, public-domain libraries that serve real epub files.
//!   - Standard Ebooks: /ebooks?query=  -> li[typeof="schema:Book"]; detail page has
//!     #description [property="schema:description"]; file at <book>/downloads/<a>_<t>.epub
//!   - Project Gutenberg: gutendex.com JSON for search/details; file at /ebooks/<id>.epub3.images

use crate::sources::{ChapterContent, NovelDetails, NovelSource, SearchResult};
use scraper::{Html, Selector};
use serde::Deserialize;
use std::time::Duration;

const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
                  (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const MAX_BOOK_BYTES: usize = 80 * 1024 * 1024;

fn client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .user_agent(UA)
        .timeout(Duration::from_secs(60))
        .build()
        .expect("failed to build http client")
}

fn sel(s: &str) -> Selector {
    Selector::parse(s).expect("static selector")
}

fn get_text(c: &reqwest::blocking::Client, url: &str) -> Result<String, String> {
    let resp = c.get(url).send().map_err(|e| format!("request failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HTTP {status} for {url}"));
    }
    resp.text().map_err(|e| e.to_string())
}

fn get_bytes(c: &reqwest::blocking::Client, url: &str) -> Result<Vec<u8>, String> {
    let resp = c.get(url).send().map_err(|e| format!("request failed: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HTTP {status} for {url}"));
    }
    let bytes = resp.bytes().map_err(|e| e.to_string())?;
    if bytes.len() > MAX_BOOK_BYTES {
        return Err("file is too large to import".into());
    }
    if !bytes.starts_with(b"PK\x03\x04") && !bytes.starts_with(b"%PDF-") {
        return Err(format!("{url} did not return an epub/pdf file"));
    }
    Ok(bytes.to_vec())
}

fn no_chapters() -> Result<ChapterContent, String> {
    Err("book sources download the whole file; there are no chapters to fetch".into())
}

fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            b' ' => "+".into(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

// ---------- Standard Ebooks ----------

const SE: &str = "https://standardebooks.org";

pub struct StandardEbooks {
    client: reqwest::blocking::Client,
}

impl StandardEbooks {
    pub fn new() -> Self {
        Self { client: client() }
    }

    fn abs(href: &str) -> String {
        if href.starts_with("http") {
            href.to_string()
        } else {
            format!("{SE}/{}", href.trim_start_matches('/'))
        }
    }
}

fn parse_se_list(html: &str) -> Vec<SearchResult> {
    let doc = Html::parse_document(html);
    let name = sel(r#"[property="schema:name"]"#);
    let author = sel(r#".author [property="schema:name"]"#);
    let img = sel("img");
    doc.select(&sel(r#"li[typeof="schema:Book"]"#))
        .filter_map(|li| {
            let about = li.value().attr("about")?;
            let title = li.select(&name).next()?.text().collect::<String>().trim().to_string();
            let authors: Vec<String> = li
                .select(&author)
                .map(|a| a.text().collect::<String>().trim().to_string())
                .collect();
            Some(SearchResult {
                source_id: "standardebooks".into(),
                novel_url: StandardEbooks::abs(about),
                title,
                author: (!authors.is_empty()).then(|| authors.join(", ")),
                cover_url: li
                    .select(&img)
                    .next()
                    .and_then(|i| i.value().attr("src"))
                    .map(StandardEbooks::abs),
                chapter_count: None,
                status: Some("Book".into()),
            })
        })
        .collect()
}

impl NovelSource for StandardEbooks {
    fn id(&self) -> &'static str {
        "standardebooks"
    }
    fn name(&self) -> &'static str {
        "Standard Ebooks"
    }
    fn kind(&self) -> &'static str {
        "book"
    }

    fn search(&self, query: &str) -> Result<Vec<SearchResult>, String> {
        let q = query.trim();
        let url = if q.is_empty() {
            format!("{SE}/ebooks?sort=popularity&per-page=48")
        } else {
            format!("{SE}/ebooks?query={}&per-page=48", enc(q))
        };
        Ok(parse_se_list(&get_text(&self.client, &url)?))
    }

    fn novel_details(&self, novel_url: &str) -> Result<NovelDetails, String> {
        let html = get_text(&self.client, novel_url)?;
        let doc = Html::parse_document(&html);
        let title = doc
            .select(&sel(r#"h1[property="schema:name"], h1"#))
            .next()
            .map(|e| e.text().collect::<String>().trim().to_string())
            .ok_or("book title not found — page layout may have changed")?;
        let author = doc
            .select(&sel(r#"[property="schema:author"] [property="schema:name"]"#))
            .next()
            .map(|e| e.text().collect::<String>().trim().to_string());
        let cover_url = doc
            .select(&sel(r#"meta[property="og:image"]"#))
            .next()
            .and_then(|e| e.value().attr("content"))
            .map(Self::abs);
        let summary = doc
            .select(&sel(r#"#description [property="schema:description"] p"#))
            .map(|p| p.text().collect::<String>().trim().to_string())
            .filter(|t| !t.is_empty())
            .collect::<Vec<_>>();
        Ok(NovelDetails {
            source_id: "standardebooks".into(),
            novel_url: novel_url.to_string(),
            title,
            author,
            cover_url,
            status: Some("Book".into()),
            summary: (!summary.is_empty()).then(|| summary.join("\n\n")),
            chapters: Vec::new(),
        })
    }

    fn chapter_content(&self, _chapter_url: &str) -> Result<ChapterContent, String> {
        no_chapters()
    }

    fn download_book(&self, book_url: &str) -> Result<(String, Vec<u8>), String> {
        // /ebooks/<author>/<title>[/<translator>...] -> downloads/<author>_<title>[_...].epub
        let path = book_url.trim_end_matches('/').split("/ebooks/").nth(1).ok_or("not a book url")?;
        let file = format!("{}.epub", path.replace('/', "_"));
        let url = format!("{SE}/ebooks/{path}/downloads/{file}?source=download");
        Ok((file, get_bytes(&self.client, &url)?))
    }
}

// ---------- Project Gutenberg ----------

const GUTENDEX: &str = "https://gutendex.com";
const PG: &str = "https://www.gutenberg.org";

pub struct Gutenberg {
    client: reqwest::blocking::Client,
}

impl Gutenberg {
    pub fn new() -> Self {
        Self { client: client() }
    }
}

#[derive(Deserialize)]
struct GxPage {
    results: Vec<GxBook>,
}

#[derive(Deserialize)]
struct GxBook {
    id: u32,
    title: String,
    #[serde(default)]
    authors: Vec<GxPerson>,
    #[serde(default)]
    summaries: Vec<String>,
}

#[derive(Deserialize)]
struct GxPerson {
    name: String,
}

/// Gutenberg stores "Last, First"; show "First Last".
fn display_name(n: &str) -> String {
    match n.split_once(", ") {
        Some((last, first)) if !first.contains(',') => format!("{first} {last}"),
        _ => n.to_string(),
    }
}

fn gx_id(url: &str) -> Result<u32, String> {
    url.trim_end_matches('/')
        .rsplit('/')
        .next()
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| format!("not a Gutenberg book url: {url}"))
}

impl GxBook {
    fn authors(&self) -> Option<String> {
        let a: Vec<String> = self.authors.iter().map(|p| display_name(&p.name)).collect();
        (!a.is_empty()).then(|| a.join(", "))
    }
    fn cover(&self) -> String {
        format!("{PG}/cache/epub/{0}/pg{0}.cover.medium.jpg", self.id)
    }
}

impl NovelSource for Gutenberg {
    fn id(&self) -> &'static str {
        "gutenberg"
    }
    fn name(&self) -> &'static str {
        "Project Gutenberg"
    }
    fn kind(&self) -> &'static str {
        "book"
    }

    fn search(&self, query: &str) -> Result<Vec<SearchResult>, String> {
        let q = query.trim();
        let url = if q.is_empty() {
            format!("{GUTENDEX}/books/?languages=en")
        } else {
            format!("{GUTENDEX}/books/?search={}", enc(q))
        };
        let page: GxPage = serde_json::from_str(&get_text(&self.client, &url)?)
            .map_err(|e| format!("bad Gutenberg response: {e}"))?;
        Ok(page
            .results
            .into_iter()
            .map(|b| SearchResult {
                source_id: "gutenberg".into(),
                novel_url: format!("{PG}/ebooks/{}", b.id),
                author: b.authors(),
                cover_url: Some(b.cover()),
                title: b.title,
                chapter_count: None,
                status: Some("Book".into()),
            })
            .collect())
    }

    fn novel_details(&self, novel_url: &str) -> Result<NovelDetails, String> {
        let id = gx_id(novel_url)?;
        let b: GxBook = serde_json::from_str(&get_text(&self.client, &format!("{GUTENDEX}/books/{id}"))?)
            .map_err(|e| format!("bad Gutenberg response: {e}"))?;
        Ok(NovelDetails {
            source_id: "gutenberg".into(),
            novel_url: novel_url.to_string(),
            author: b.authors(),
            cover_url: Some(b.cover()),
            summary: b.summaries.first().cloned(),
            title: b.title,
            status: Some("Book".into()),
            chapters: Vec::new(),
        })
    }

    fn chapter_content(&self, _chapter_url: &str) -> Result<ChapterContent, String> {
        no_chapters()
    }

    fn download_book(&self, book_url: &str) -> Result<(String, Vec<u8>), String> {
        let id = gx_id(book_url)?;
        let bytes = get_bytes(&self.client, &format!("{PG}/ebooks/{id}.epub3.images"))
            .or_else(|_| get_bytes(&self.client, &format!("{PG}/ebooks/{id}.epub.images")))?;
        Ok((format!("pg{id}.epub"), bytes))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gutenberg_names_and_ids() {
        assert_eq!(display_name("Shelley, Mary Wollstonecraft"), "Mary Wollstonecraft Shelley");
        assert_eq!(gx_id("https://www.gutenberg.org/ebooks/84").unwrap(), 84);
    }

    #[test]
    fn standardebooks_smoke() {
        let s = StandardEbooks::new();
        let r = s.search("frankenstein").expect("search");
        let hit = r.iter().find(|b| b.title == "Frankenstein").expect("Frankenstein");
        let d = s.novel_details(&hit.novel_url).expect("details");
        assert!(d.summary.is_some());
        let (name, bytes) = s.download_book(&hit.novel_url).expect("download");
        assert!(name.ends_with(".epub") && bytes.len() > 100_000);
        let book = crate::import::import_bytes(&bytes, &name).expect("import");
        assert!(book.chapters.len() > 10, "chapters: {}", book.chapters.len());
        println!("se ok: {} chapters", book.chapters.len());
    }

    #[test]
    #[ignore = "Gutenberg/gutendex was down for maintenance when written; run manually"]
    fn gutenberg_smoke() {
        let s = Gutenberg::new();
        let r = s.search("frankenstein").expect("search");
        let (name, bytes) = s.download_book(&r[0].novel_url).expect("download");
        let book = crate::import::import_bytes(&bytes, &name).expect("import");
        assert!(book.chapters.len() > 5);
    }
}
