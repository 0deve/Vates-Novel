//! Local file import: turns a user-supplied .epub, .pdf or .txt file into a fully
//! self-contained "novel" (all chapters already have content — there's no
//! live source to download the rest from later).

use base64::Engine;
use scraper::{ElementRef, Html, Node, Selector};
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

/// The frontend sends the picked file's bytes rather than a path, since
/// Android's picker hands back `content://` URIs `std::fs` can't open. They're
/// base64 because Android's IPC is JSON-only and has no raw body. The name may
/// be an opaque SAF document id, so EPUBs and PDFs are also recognized by
/// their magic bytes.
#[tauri::command(async)]
pub fn import_local_novel(file_name: String, data_base64: String) -> Result<ImportedNovel, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|e| format!("corrupt file data: {e}"))?;
    // Android URIs arrive percent-encoded.
    let file_name = percent_decode(&file_name);

    let lower = file_name.to_lowercase();
    if lower.ends_with(".pdf") || bytes.starts_with(b"%PDF-") {
        import_pdf(&bytes, &file_name)
    } else if lower.ends_with(".epub")
        || (!lower.ends_with(".txt") && bytes.starts_with(b"PK\x03\x04"))
    {
        import_epub(&bytes)
    } else {
        import_txt(&bytes, &file_name)
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
        if bytes[i] == b'%' {
            // `get`, since a raw file name can have multibyte chars after a %.
            if let Some(byte) = s.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok()) {
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

const BLOCK_TAGS: [&str; 33] = [
    "address", "article", "aside", "blockquote", "center", "dd", "details", "div", "dl", "dt",
    "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "li", "main",
    "nav", "ol", "p", "pre", "section", "table", "tbody", "tfoot", "thead", "tr", "ul",
];
const SKIPPED_TAGS: [&str; 4] = ["script", "style", "svg", "head"];

#[derive(Default)]
struct Blocks {
    buf: String,
    has_text: bool,
    out: Vec<String>,
}

impl Blocks {
    fn flush(&mut self) {
        if self.has_text {
            self.out.push(format!("<p>{}</p>", self.buf.trim()));
        }
        self.buf.clear();
        self.has_text = false;
    }

    /// Walks the tree so text outside `<p>` (lists, tables, bare divs) survives.
    fn walk(&mut self, parent: ElementRef<'_>, skip: Option<ElementRef<'_>>) {
        for child in parent.children() {
            match child.value() {
                Node::Text(t) => {
                    self.has_text |= !t.trim().is_empty();
                    self.buf.push_str(&html_escape(t));
                }
                Node::Element(el) => {
                    let Some(e) = ElementRef::wrap(child) else { continue };
                    let name = el.name();
                    if skip == Some(e) || SKIPPED_TAGS.contains(&name) {
                        continue;
                    }
                    if name == "br" || name == "hr" {
                        self.flush();
                    } else if name == "tr" {
                        self.flush();
                        self.buf = table_row(e);
                        self.has_text = !self.buf.is_empty();
                        self.flush();
                    } else if is_block(e) {
                        self.flush();
                        self.walk(e, skip);
                        self.flush();
                    } else {
                        self.has_text |= e.text().any(|t| !t.trim().is_empty());
                        self.buf.push_str(&e.html());
                    }
                }
                _ => {}
            }
        }
    }
}

fn is_block(e: ElementRef<'_>) -> bool {
    e.descendants()
        .filter_map(ElementRef::wrap)
        .any(|d| BLOCK_TAGS.contains(&d.value().name()))
}

fn table_row(row: ElementRef<'_>) -> String {
    let cells: Vec<String> = row
        .children()
        .filter_map(ElementRef::wrap)
        .filter(|c| matches!(c.value().name(), "td" | "th"))
        .map(|c| c.text().collect::<Vec<_>>().join(" "))
        .map(|t| t.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|t| !t.is_empty())
        .collect();
    html_escape(&cells.join(" | "))
}

/// Every block of readable text in the chapter body, in document order.
fn chapter_blocks(doc: &Html, skip: Option<ElementRef<'_>>) -> Vec<String> {
    let mut blocks = Blocks::default();
    if let Some(body) = doc.select(&sel("body")).next() {
        blocks.walk(body, skip);
        blocks.flush();
    }
    blocks.out
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

        let heading = doc.select(&sel("h1, h2, h3")).next();
        let heading_text = heading
            .map(|e| e.text().collect::<String>().trim().to_string())
            .filter(|t| !t.is_empty());
        // The reader shows the title itself; don't repeat it in the body.
        let html = chapter_blocks(&doc, heading.filter(|_| heading_text.is_some())).join("\n");
        let title = heading_text.unwrap_or_else(|| format!("Chapter {}", chapters.len() + 1));

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

fn is_chapter_number(token: &str) -> bool {
    const WORDS: [&str; 28] = [
        "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven",
        "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen",
        "nineteen", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
        "hundred",
    ];
    token.chars().all(|c| c.is_ascii_digit())
        || token.chars().all(|c| "IVXLCDM".contains(c))
        || WORDS.contains(&token.to_lowercase().as_str())
}

/// A keyword only counts with a number after it, so "Part of the budget" stays prose.
fn looks_like_chapter_heading(line: &str) -> bool {
    let t = line.trim();
    if t.is_empty() || t.len() > 80 {
        return false;
    }
    let word_end = t.find(|c: char| !c.is_alphabetic()).unwrap_or(t.len());
    let (word, rest) = t.split_at(word_end);
    let word = word.to_lowercase();

    if word == "prologue" || word == "epilogue" {
        let rest = rest.trim_start();
        return rest.is_empty() || rest.starts_with([':', '-', '\u{2013}', '\u{2014}', '.']);
    }
    if !["chapter", "ch", "part", "book", "volume", "vol"].contains(&word.as_str()) {
        return false;
    }

    let rest = rest.trim_start_matches(['.', ' ']);
    let num_end = rest.find(|c: char| !c.is_alphanumeric()).unwrap_or(rest.len());
    let (num, after) = rest.split_at(num_end);
    !num.is_empty() && is_chapter_number(num) && !after.trim_start().starts_with(char::is_lowercase)
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
    let default_title = title_from_file_name(file_name);

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

// ---------- PDF ----------

/// Section size for PDFs with no chapter headings to split on.
const PDF_PAGES_PER_SECTION: usize = 10;

fn import_pdf(bytes: &[u8], file_name: &str) -> Result<ImportedNovel, String> {
    // pdf-extract panics on some malformed fonts instead of returning Err.
    let pages = std::panic::catch_unwind(|| pdf_extract::extract_text_from_mem_by_pages(bytes))
        .map_err(|_| "this PDF uses a format the importer can't read".to_string())?
        .map_err(|e| format!("could not read PDF: {e}"))?;
    if pages.iter().all(|p| p.trim().is_empty()) {
        return Err("no text found in this PDF (scanned pages aren't supported)".into());
    }

    // Only a page's first line counts: mid-page "Part of..." isn't a heading.
    let headings: Vec<Option<&str>> = pages
        .iter()
        .map(|p| p.lines().map(str::trim).find(|l| !l.is_empty()))
        .map(|l| l.filter(|l| looks_like_chapter_heading(l)))
        .collect();

    let mut chapters: Vec<ImportedChapter> = Vec::new();
    if headings.iter().flatten().count() >= 2 {
        let mut current_title: Option<String> = None;
        let mut current_body = String::new();
        for (page, heading) in pages.iter().zip(&headings) {
            let mut text = page.as_str();
            if let Some(h) = heading {
                push_chapter(&mut chapters, current_title.take(), &current_body);
                current_body.clear();
                current_title = Some(h.to_string());
                text = text.trim_start().strip_prefix(h).unwrap_or(text);
            }
            current_body.push_str(&unwrap_lines(text));
            current_body.push_str("\n\n");
        }
        push_chapter(&mut chapters, current_title.take(), &current_body);
    } else {
        for (i, section) in pages.chunks(PDF_PAGES_PER_SECTION).enumerate() {
            let first = i * PDF_PAGES_PER_SECTION + 1;
            let last = first + section.len() - 1;
            let title = if first == last {
                format!("Page {first}")
            } else {
                format!("Pages {first}-{last}")
            };
            let body: Vec<String> = section.iter().map(|p| unwrap_lines(p)).collect();
            push_chapter(&mut chapters, Some(title), &body.join("\n\n"));
        }
    }

    Ok(ImportedNovel {
        title: title_from_file_name(file_name),
        author: None,
        cover_base64: None,
        chapters,
    })
}

fn title_from_file_name(file_name: &str) -> String {
    std::path::Path::new(file_name)
        .file_stem()
        .map(|s| s.to_string_lossy().replace(['_', '-'], " "))
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "Imported Novel".to_string())
}

/// More lines than this per blank-separated block means blank lines aren't
/// marking paragraphs.
const MAX_LINES_PER_BLOCK: usize = 20;
/// Wider "lines" than this are whole paragraphs, not hard wrapping.
const MAX_WRAP_WIDTH: usize = 140;

/// 90th-percentile line length, since the longest line may be an outlier.
fn text_width(lines: &[&str]) -> usize {
    let mut lens: Vec<usize> = lines.iter().map(|l| l.chars().count()).collect();
    lens.sort_unstable();
    lens.get((lens.len() * 9 / 10).min(lens.len().saturating_sub(1)))
        .copied()
        .unwrap_or(0)
}

/// Rejoin hard-wrapped lines; a blank line or a line well short of the text
/// width ends a paragraph.
fn unwrap_lines(text: &str) -> String {
    let lines: Vec<&str> = text.lines().map(str::trim).collect();
    let filled: Vec<&str> = lines.iter().copied().filter(|l| !l.is_empty()).collect();
    let width = text_width(&filled);

    let mut out = String::new();
    let end_paragraph = |out: &mut String| {
        if !out.is_empty() && !out.ends_with("\n\n") {
            out.push_str("\n\n");
        }
    };
    for line in lines {
        if line.is_empty() {
            end_paragraph(&mut out);
            continue;
        }
        if out.is_empty() || out.ends_with('\n') {
            out.push_str(line);
        } else if out.ends_with('-') && line.starts_with(char::is_lowercase) {
            out.pop();
            out.push_str(line);
        } else {
            out.push(' ');
            out.push_str(line);
        }
        if line.chars().count() * 4 < width * 3 {
            end_paragraph(&mut out);
        }
    }
    out.trim_end().to_string()
}

/// Text whose paragraphs aren't blank-line separated: line breaks are the only
/// structure, either hard wrapping or one paragraph per line.
fn paragraphs_from_lines(text: &str) -> String {
    let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    let width = text_width(&lines);
    let near_full = lines.iter().filter(|l| l.chars().count() * 10 >= width * 7).count();
    if width <= MAX_WRAP_WIDTH && near_full * 2 >= lines.len() {
        unwrap_lines(text)
    } else {
        lines.join("\n\n")
    }
}

fn paragraphs_to_html(text: &str) -> String {
    let lines = text.lines().filter(|l| !l.trim().is_empty()).count();
    let blocks = text.split("\n\n").filter(|b| !b.trim().is_empty()).count();
    let reflowed;
    let text = if lines > blocks * MAX_LINES_PER_BLOCK {
        reflowed = paragraphs_from_lines(text);
        &reflowed
    } else {
        text
    };

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

    /// Smallest valid PDF with one text line per entry on each page.
    fn minimal_pdf(pages: &[Vec<&str>]) -> Vec<u8> {
        let kids: Vec<String> = (0..pages.len()).map(|i| format!("{} 0 R", 4 + i * 2)).collect();
        let mut objects = vec![
            "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
            format!("<< /Type /Pages /Kids [{}] /Count {} >>", kids.join(" "), pages.len()),
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
        ];
        for (i, lines) in pages.iter().enumerate() {
            let shown: String = lines.iter().map(|l| format!("({l}) Tj 0 -14 Td ")).collect();
            let stream = format!("BT /F1 12 Tf 72 720 Td {shown}ET");
            objects.push(format!(
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents {} 0 R \
                 /Resources << /Font << /F1 3 0 R >> >> >>",
                5 + i * 2
            ));
            objects.push(format!(
                "<< /Length {} >>\nstream\n{stream}\nendstream",
                stream.len()
            ));
        }

        let mut out = String::from("%PDF-1.4\n");
        let mut offsets = Vec::new();
        for (i, obj) in objects.iter().enumerate() {
            offsets.push(out.len());
            out.push_str(&format!("{} 0 obj\n{obj}\nendobj\n", i + 1));
        }
        let xref_at = out.len();
        out.push_str(&format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1));
        for off in offsets {
            out.push_str(&format!("{off:010} 00000 n \n"));
        }
        out.push_str(&format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref_at}\n%%EOF\n",
            objects.len() + 1
        ));
        out.into_bytes()
    }

    #[test]
    fn pdf_without_headings_groups_pages_into_sections() {
        let pages = vec![vec!["Quarterly results were strong."]; 12];
        let novel = import_pdf(&minimal_pdf(&pages), "annual_report.pdf").unwrap();
        assert_eq!(novel.title, "annual report");
        let titles: Vec<&str> = novel.chapters.iter().map(|c| c.title.as_str()).collect();
        assert_eq!(titles, ["Pages 1-10", "Pages 11-12"]);
        assert!(novel.chapters[0].html.contains("Quarterly results"));
    }

    #[test]
    fn pdf_splits_on_headings_at_the_top_of_a_page() {
        let pages = vec![
            vec!["Chapter 1", "It began."],
            vec!["It went on."],
            vec!["Chapter 2", "It ended."],
        ];
        let novel = import_pdf(&minimal_pdf(&pages), "book.pdf").unwrap();
        assert_eq!(novel.chapters.len(), 2);
        assert_eq!(novel.chapters[0].title, "Chapter 1");
        assert!(!novel.chapters[0].html.contains("Chapter 1"));
        assert!(novel.chapters[0].html.contains("It went on."));
        assert_eq!(novel.chapters[1].title, "Chapter 2");
    }

    #[test]
    fn pdf_with_no_text_is_rejected() {
        let err = import_pdf(&minimal_pdf(&[vec![]]), "scan.pdf").err().unwrap();
        assert!(err.contains("no text"), "{err}");
    }

    #[test]
    fn unwrap_joins_lines_and_repairs_hyphenation() {
        assert_eq!(unwrap_lines("a long exam-\nple here\n\nnext"), "a long example here\n\nnext");
    }

    #[test]
    fn prose_starting_with_a_keyword_is_not_a_heading() {
        for line in [
            "Part of the budget went to roads",
            "Book value fell",
            "Chapter 3 shows the trend",
            "Prologue to the plan",
        ] {
            assert!(!looks_like_chapter_heading(line), "{line}");
        }
        for line in [
            "Chapter 1",
            "CHAPTER IV",
            "Chapter Twenty-One: Dusk",
            "Ch. 5",
            "Part 2 The Return",
            "Prologue",
            "Epilogue: After",
        ] {
            assert!(looks_like_chapter_heading(line), "{line}");
        }
    }

    #[test]
    fn single_line_breaks_become_paragraphs_when_lines_are_paragraphs() {
        let long = "word ".repeat(60);
        let text = format!("{long}\n{}", format!("{long}x\n").repeat(29));
        assert_eq!(paragraphs_to_html(&text).matches("<p>").count(), 30);
    }

    #[test]
    fn hard_wrapped_text_without_blank_lines_is_rejoined() {
        let wrapped = "the report covers many things across this long line\n".repeat(29);
        let text = format!("{wrapped}and it ends here.\nA new thought begins on this line of the text ok\nand also ends.");
        let html = paragraphs_to_html(&text);
        assert_eq!(html.matches("<p>").count(), 2, "{html}");
    }

    #[test]
    fn blank_line_paragraphs_keep_their_breaks() {
        assert_eq!(paragraphs_to_html("one\ntwo\n\nthree").matches("<p>").count(), 2);
    }

    #[test]
    fn epub_body_keeps_text_outside_paragraphs_without_duplicates() {
        let doc = Html::parse_document(
            "<html><body><h1>Title</h1><p>Para <em>one</em></p><div>Bare div</div>\
             <ul><li>Item a</li><li><p>Item b</p></li></ul>\
             <blockquote><p>Quoted</p></blockquote>\
             <table><tr><th>Year</th><td>2024</td></tr></table><script>x()</script></body></html>",
        );
        let heading = doc.select(&sel("h1")).next();
        assert_eq!(
            chapter_blocks(&doc, heading),
            [
                "<p>Para <em>one</em></p>",
                "<p>Bare div</p>",
                "<p>Item a</p>",
                "<p>Item b</p>",
                "<p>Quoted</p>",
                "<p>Year | 2024</p>",
            ]
        );
    }

    #[test]
    fn percent_decode_survives_multibyte_after_percent() {
        assert_eq!(percent_decode("100%é a%20b"), "100%é a b");
    }
}
