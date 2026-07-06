//! Local file import: turns a user-supplied .epub or .txt file into a fully
//! self-contained "novel" (all chapters already have content — there's no
//! live source to download the rest from later).

use base64::Engine;
use scraper::{Html, Selector};
use serde::Serialize;
use std::collections::HashMap;
use std::io::Read as _;

#[derive(Serialize)]
pub struct ImportedChapter {
    pub title: String,
    pub html: String,
}

#[derive(Serialize)]
pub struct ImportedNovel {
    pub title: String,
    pub author: Option<String>,
    /// A `data:` URL, ready to use directly as an `<img src>`.
    pub cover_base64: Option<String>,
    pub chapters: Vec<ImportedChapter>,
}

/// The frontend sends the picked file's raw bytes as the IPC body (a path
/// would be useless on Android, where the picker hands back `content://`
/// URIs that `std::fs` can't open) plus a percent-encoded `file-name`
/// header for format dispatch and the .txt fallback title. When the name is
/// an opaque SAF document id with no extension, EPUBs are still recognized
/// by their zip magic bytes.
#[tauri::command]
pub fn import_local_novel(request: tauri::ipc::Request<'_>) -> Result<ImportedNovel, String> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw file bytes".into());
    };
    let file_name = request
        .headers()
        .get("file-name")
        .and_then(|v| v.to_str().ok())
        .map(percent_decode)
        .unwrap_or_default();

    let lower = file_name.to_lowercase();
    if lower.ends_with(".epub") || (!lower.ends_with(".txt") && bytes.starts_with(b"PK\x03\x04")) {
        import_epub(bytes)
    } else {
        import_txt(bytes, &file_name)
    }
}

fn sel(s: &str) -> Selector {
    Selector::parse(s).expect("static selector")
}

// ---------- EPUB ----------

struct OpfData {
    title: String,
    author: Option<String>,
    /// id -> (href, media_type, properties)
    manifest: HashMap<String, (String, String, Option<String>)>,
    /// idrefs in spine (reading) order.
    spine: Vec<String>,
    cover_item_id: Option<String>,
}

type EpubArchive<'a> = zip::ZipArchive<std::io::Cursor<&'a [u8]>>;

fn zip_read_text(zip: &mut EpubArchive, name: &str) -> Result<String, String> {
    let mut file = zip
        .by_name(name)
        .map_err(|e| format!("{name} not found in epub: {e}"))?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

fn zip_read_bytes(zip: &mut EpubArchive, name: &str) -> Result<Vec<u8>, String> {
    let mut file = zip
        .by_name(name)
        .map_err(|e| format!("{name} not found in epub: {e}"))?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf).map_err(|e| e.to_string())?;
    Ok(buf)
}

/// Resolve an OPF-relative href (which may be percent-encoded and use `../`)
/// against the OPF file's own directory, producing a path usable with
/// `zip.by_name`.
fn resolve_href(opf_dir: &str, href: &str) -> String {
    let href_no_frag = href.split('#').next().unwrap_or(href);
    let decoded = percent_decode(href_no_frag);

    let mut segments: Vec<&str> = if opf_dir.is_empty() {
        Vec::new()
    } else {
        opf_dir.split('/').collect()
    };
    for seg in decoded.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                segments.pop();
            }
            s => segments.push(s),
        }
    }
    segments.join("/")
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn parse_opf(xml: &str) -> OpfData {
    let doc = Html::parse_document(xml);

    let title = doc
        .select(&sel("dc\\:title, title"))
        .next()
        .map(|e| e.text().collect::<String>().trim().to_string())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "Imported Novel".to_string());

    let author = doc
        .select(&sel("dc\\:creator, creator"))
        .next()
        .map(|e| e.text().collect::<String>().trim().to_string())
        .filter(|t| !t.is_empty());

    let mut manifest = HashMap::new();
    for item in doc.select(&sel("manifest item")) {
        let v = item.value();
        let (Some(id), Some(href)) = (v.attr("id"), v.attr("href")) else {
            continue;
        };
        let media_type = v.attr("media-type").unwrap_or("").to_string();
        let properties = v.attr("properties").map(String::from);
        manifest.insert(id.to_string(), (href.to_string(), media_type, properties));
    }

    let spine: Vec<String> = doc
        .select(&sel("spine itemref"))
        .filter_map(|e| e.value().attr("idref").map(String::from))
        .collect();

    let cover_item_id = doc
        .select(&sel(r#"meta[name="cover"]"#))
        .next()
        .and_then(|e| e.value().attr("content"))
        .map(String::from)
        .or_else(|| {
            manifest.iter().find_map(|(id, (_, _, props))| {
                props
                    .as_ref()
                    .filter(|p| p.split(' ').any(|w| w == "cover-image"))
                    .map(|_| id.clone())
            })
        });

    OpfData {
        title,
        author,
        manifest,
        spine,
        cover_item_id,
    }
}

pub(crate) fn import_epub(bytes: &[u8]) -> Result<ImportedNovel, String> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|e| format!("not a valid EPUB (zip) file: {e}"))?;

    let container_xml = zip_read_text(&mut zip, "META-INF/container.xml")?;
    let container_doc = Html::parse_document(&container_xml);
    let opf_path = container_doc
        .select(&sel("rootfile"))
        .next()
        .and_then(|e| e.value().attr("full-path"))
        .ok_or("container.xml has no rootfile — not a valid EPUB")?
        .to_string();

    let opf_xml = zip_read_text(&mut zip, &opf_path)?;
    let opf_dir = opf_path.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
    let opf = parse_opf(&opf_xml);

    let cover_base64 = opf
        .cover_item_id
        .as_ref()
        .and_then(|id| opf.manifest.get(id))
        .and_then(|(href, media_type, _)| {
            let full = resolve_href(opf_dir, href);
            zip_read_bytes(&mut zip, &full).ok().map(|bytes| {
                let mime = if media_type.is_empty() {
                    "image/jpeg"
                } else {
                    media_type
                };
                format!(
                    "data:{mime};base64,{}",
                    base64::engine::general_purpose::STANDARD.encode(bytes)
                )
            })
        });

    let mut chapters = Vec::new();
    for idref in &opf.spine {
        let Some((href, media_type, properties)) = opf.manifest.get(idref) else {
            continue;
        };
        if !media_type.is_empty()
            && media_type != "application/xhtml+xml"
            && media_type != "text/html"
        {
            continue;
        }
        if properties
            .as_ref()
            .is_some_and(|p| p.split(' ').any(|w| w == "nav"))
        {
            continue;
        }

        let full = resolve_href(opf_dir, href);
        let Ok(xhtml) = zip_read_text(&mut zip, &full) else {
            continue;
        };
        let doc = Html::parse_document(&xhtml);

        let title = doc
            .select(&sel("h1, h2, h3"))
            .next()
            .map(|e| e.text().collect::<String>().trim().to_string())
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| format!("Chapter {}", chapters.len() + 1));

        let paras: Vec<String> = doc
            .select(&sel("body p"))
            .map(|p| p.inner_html().trim().to_string())
            .filter(|t| !t.is_empty())
            .map(|t| format!("<p>{t}</p>"))
            .collect();

        let html = if paras.is_empty() {
            let text = doc
                .select(&sel("body"))
                .next()
                .map(|b| b.text().collect::<Vec<_>>().join(" "))
                .unwrap_or_default();
            paragraphs_to_html(text.trim())
        } else {
            paras.join("\n")
        };

        if html.trim().is_empty() {
            continue;
        }
        chapters.push(ImportedChapter { title, html });
    }

    if chapters.is_empty() {
        return Err("no readable chapters found in this EPUB".into());
    }

    Ok(ImportedNovel {
        title: opf.title,
        author: opf.author,
        cover_base64,
        chapters,
    })
}

// ---------- TXT ----------

fn looks_like_chapter_heading(line: &str) -> bool {
    let t = line.trim();
    if t.is_empty() || t.len() > 80 {
        return false;
    }
    let lower = t.to_lowercase();
    const PREFIXES: [&str; 8] = [
        "chapter", "ch.", "ch ", "part ", "book ", "volume", "prologue", "epilogue",
    ];
    PREFIXES.iter().any(|p| lower.starts_with(p))
}

fn push_chapter(out: &mut Vec<ImportedChapter>, title: Option<String>, body: &str) {
    let text = body.trim();
    if text.is_empty() {
        return;
    }
    out.push(ImportedChapter {
        title: title.unwrap_or_else(|| format!("Chapter {}", out.len() + 1)),
        html: paragraphs_to_html(text),
    });
}

fn import_txt(bytes: &[u8], file_name: &str) -> Result<ImportedNovel, String> {
    let raw = String::from_utf8_lossy(bytes);
    let default_title = std::path::Path::new(file_name)
        .file_stem()
        .map(|s| s.to_string_lossy().replace(['_', '-'], " "))
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "Imported Novel".to_string());

    let mut chapters: Vec<ImportedChapter> = Vec::new();
    let mut current_title: Option<String> = None;
    let mut current_body = String::new();

    for line in raw.lines() {
        if looks_like_chapter_heading(line) {
            push_chapter(&mut chapters, current_title.take(), &current_body);
            current_body.clear();
            current_title = Some(line.trim().to_string());
        } else {
            current_body.push_str(line);
            current_body.push('\n');
        }
    }
    push_chapter(&mut chapters, current_title.take(), &current_body);

    if chapters.is_empty() {
        let text = raw.trim();
        if text.is_empty() {
            return Err("file is empty".into());
        }
        chapters.push(ImportedChapter {
            title: "Chapter 1".into(),
            html: paragraphs_to_html(text),
        });
    }

    Ok(ImportedNovel {
        title: default_title,
        author: None,
        cover_base64: None,
        chapters,
    })
}

fn paragraphs_to_html(text: &str) -> String {
    text.split("\n\n")
        .map(|p| p.trim())
        .filter(|p| !p.is_empty())
        .map(|p| format!("<p>{}</p>", html_escape(p)))
        .collect::<Vec<_>>()
        .join("\n")
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn txt_splits_on_chapter_headings_and_titles_from_file_name() {
        let text = "Chapter 1\nIt began.\n\nChapter 2\nIt ended.\n";
        let novel = import_txt(text.as_bytes(), "my_story.txt").unwrap();
        assert_eq!(novel.title, "my story");
        assert_eq!(novel.chapters.len(), 2);
        assert_eq!(novel.chapters[0].title, "Chapter 1");
        assert!(novel.chapters[0].html.contains("It began."));
        assert_eq!(novel.chapters[1].title, "Chapter 2");
    }

    #[test]
    fn txt_without_headings_becomes_single_escaped_chapter() {
        let novel = import_txt(b"a < b & c", "x.txt").unwrap();
        assert_eq!(novel.chapters.len(), 1);
        assert!(novel.chapters[0].html.contains("a &lt; b &amp; c"));
    }
}
