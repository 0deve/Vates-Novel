//! Local file import: turns a user-supplied .epub, .pdf or .txt file into a fully
//! self-contained "novel" (all chapters already have content — there's no
//! live source to download the rest from later).

use crate::import_clean::{self, ImportOptions};
use base64::Engine;
use scraper::{ElementRef, Html, Node, Selector};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::io::Read as _;

#[derive(Serialize)]
pub struct ImportedChapter {
    pub title: String,
    pub html: String,
    /// Marked as cover/copyright/contents etc. by the book itself.
    #[serde(skip)]
    pub extra: bool,
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
pub fn import_local_novel(
    file_name: String,
    data_base64: String,
    options: Option<ImportOptions>,
) -> Result<ImportedNovel, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|e| format!("corrupt file data: {e}"))?;
    // Android URIs arrive percent-encoded.
    import_bytes_with(&bytes, &percent_decode(&file_name), options.unwrap_or_default())
}

/// Detect the format by name/magic bytes and parse it, with default cleanup.
pub(crate) fn import_bytes(bytes: &[u8], file_name: &str) -> Result<ImportedNovel, String> {
    import_bytes_with(bytes, file_name, ImportOptions::default())
}

pub(crate) fn import_bytes_with(
    bytes: &[u8],
    file_name: &str,
    opts: ImportOptions,
) -> Result<ImportedNovel, String> {
    let lower = file_name.to_lowercase();
    let mut novel = if lower.ends_with(".pdf") || bytes.starts_with(b"%PDF-") {
        import_pdf(bytes, file_name, opts)?
    } else if lower.ends_with(".epub")
        || (!lower.ends_with(".txt") && bytes.starts_with(b"PK\x03\x04"))
    {
        import_epub(bytes)?
    } else {
        import_txt(bytes, file_name)?
    };
    import_clean::clean(&mut novel, opts);
    if novel.chapters.is_empty() {
        return Err("no readable text left after cleanup; try again with import cleanup turned off in Settings".into());
    }
    Ok(novel)
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
    /// (type, href) from the EPUB2 <guide>.
    guide: Vec<(String, String)>,
    /// NCX manifest id named by <spine toc="...">.
    ncx_id: Option<String>,
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

    let guide = doc
        .select(&sel("guide reference"))
        .filter_map(|e| {
            let v = e.value();
            Some((v.attr("type")?.to_lowercase(), v.attr("href")?.to_string()))
        })
        .collect();
    let ncx_id = doc
        .select(&sel("spine"))
        .next()
        .and_then(|e| e.value().attr("toc"))
        .map(String::from);

    OpfData {
        title,
        author,
        manifest,
        spine,
        cover_item_id,
        guide,
        ncx_id,
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
    /// element id -> TOC label; reaching one starts a new section.
    anchors: HashMap<String, String>,
    cur_label: Option<String>,
    done: Vec<(Option<String>, Vec<String>)>,
}

impl Blocks {
    fn start_section(&mut self, label: String) {
        self.flush();
        let prev = (self.cur_label.take(), std::mem::take(&mut self.out));
        if prev.0.is_some() || !prev.1.is_empty() {
            self.done.push(prev);
        }
        self.cur_label = Some(label);
    }

    fn finish(mut self) -> Vec<(Option<String>, Vec<String>)> {
        self.flush();
        let last = (self.cur_label.take(), std::mem::take(&mut self.out));
        self.done.push(last);
        self.done
    }

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
                    if let Some(label) = el.attr("id").and_then(|id| self.anchors.get(id)).cloned() {
                        self.start_section(label);
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

/// Readable blocks of the chapter body in document order, split into one
/// section per TOC anchor (the first section is whatever precedes them).
fn chapter_sections(
    doc: &Html,
    skip: Option<ElementRef<'_>>,
    anchors: HashMap<String, String>,
) -> Vec<(Option<String>, Vec<String>)> {
    let mut blocks = Blocks { anchors, ..Blocks::default() };
    if let Some(body) = doc.select(&sel("body")).next() {
        blocks.walk(body, skip);
    }
    blocks.finish()
}

/// Text of an inline element with <br> kept as a space ("THE<br>HUNGER" -> "THE HUNGER").
fn inline_text(e: ElementRef<'_>) -> String {
    let mut out = String::new();
    for node in e.descendants() {
        match node.value() {
            Node::Text(t) => out.push_str(t),
            Node::Element(el) if el.name() == "br" => out.push(' '),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

struct TocEntry {
    path: String,
    frag: Option<String>,
    label: String,
}

fn dir_of(path: &str) -> &str {
    path.rsplit_once('/').map(|(d, _)| d).unwrap_or("")
}

fn split_href(base_dir: &str, href: &str) -> (String, Option<String>) {
    let frag = href
        .split_once('#')
        .map(|(_, f)| percent_decode(f))
        .filter(|f| !f.is_empty());
    (resolve_href(base_dir, href), frag)
}

/// Book-declared section types that aren't story text.
const EXTRA_TYPES: [&str; 11] = [
    "cover",
    "title-page",
    "titlepage",
    "halftitlepage",
    "copyright-page",
    "copyright",
    "toc",
    "dedication",
    "imprint",
    "colophon",
    "seriespage",
];

/// Reading-order TOC entries (NCX or EPUB3 nav) plus paths the book marks as front/back matter.
fn read_toc(zip: &mut EpubArchive, opf: &OpfData, opf_dir: &str) -> (Vec<TocEntry>, HashSet<String>) {
    let mut entries = Vec::new();
    let mut extra: HashSet<String> = opf
        .guide
        .iter()
        .filter(|(t, _)| EXTRA_TYPES.contains(&t.as_str()))
        .map(|(_, h)| resolve_href(opf_dir, h))
        .collect();

    // EPUB3 nav document.
    let nav = opf
        .manifest
        .values()
        .find(|(_, _, p)| p.as_ref().is_some_and(|p| p.split(' ').any(|w| w == "nav")));
    if let Some((href, _, _)) = nav {
        let path = resolve_href(opf_dir, href);
        if let Ok(xml) = zip_read_text(zip, &path) {
            let doc = Html::parse_document(&xml);
            let dir = dir_of(&path);
            for nav in doc.select(&sel("nav")) {
                let kind = nav.value().attr("epub:type").unwrap_or("");
                for a in nav.select(&sel("a[href]")) {
                    let (p, frag) = split_href(dir, a.value().attr("href").unwrap_or(""));
                    if kind.split(' ').any(|k| k == "toc") {
                        entries.push(TocEntry { path: p, frag, label: inline_text(a) });
                    } else if kind.split(' ').any(|k| k == "landmarks") {
                        let t = a.value().attr("epub:type").unwrap_or("").to_lowercase();
                        if t.split(' ').any(|t| EXTRA_TYPES.contains(&t)) {
                            extra.insert(p);
                        }
                    }
                }
            }
        }
    }

    // EPUB2 NCX.
    if entries.is_empty() {
        let ncx = opf
            .ncx_id
            .as_ref()
            .and_then(|id| opf.manifest.get(id))
            .or_else(|| opf.manifest.values().find(|(_, m, _)| m == "application/x-dtbncx+xml"));
        if let Some((href, _, _)) = ncx {
            let path = resolve_href(opf_dir, href);
            if let Ok(xml) = zip_read_text(zip, &path) {
                let doc = Html::parse_document(&xml);
                let dir = dir_of(&path);
                for np in doc.select(&sel("navpoint")) {
                    let children: Vec<ElementRef> = np.children().filter_map(ElementRef::wrap).collect();
                    let label = children
                        .iter()
                        .find(|c| c.value().name() == "navlabel")
                        .map(|c| inline_text(*c))
                        .unwrap_or_default();
                    let src = children
                        .iter()
                        .find(|c| c.value().name() == "content")
                        .and_then(|c| c.value().attr("src"));
                    if let Some(src) = src {
                        let (p, frag) = split_href(dir, src);
                        entries.push(TocEntry { path: p, frag, label });
                    }
                }
            }
        }
    }
    (entries, extra)
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

    let (toc, extra_paths) = read_toc(&mut zip, &opf, opf_dir);

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
        let extra = extra_paths.contains(&full);

        let here: Vec<&TocEntry> = toc.iter().filter(|e| e.path == full).collect();
        let file_label = here.iter().find(|e| e.frag.is_none()).map(|e| e.label.clone()).filter(|l| !l.is_empty());
        let ids: HashSet<&str> = doc
            .root_element()
            .descendants()
            .filter_map(ElementRef::wrap)
            .filter_map(|e| e.value().attr("id"))
            .collect();
        let anchors: HashMap<String, String> = here
            .iter()
            .filter_map(|e| Some((e.frag.clone()?, e.label.clone())))
            .filter(|(id, _)| ids.contains(id.as_str()))
            .collect();

        let heading = doc.select(&sel("h1, h2, h3")).next();
        let heading_text = heading.map(inline_text).filter(|t| !t.is_empty());
        // With TOC anchors the cleanup step strips repeated headings instead.
        let skip = if anchors.is_empty() { heading.filter(|_| heading_text.is_some()) } else { None };
        let first_title = file_label.or(heading_text).unwrap_or_default();

        for (i, (label, blocks)) in chapter_sections(&doc, skip, anchors).into_iter().enumerate() {
            let html = blocks.join("\n");
            if html.trim().is_empty() {
                continue;
            }
            let title = label.unwrap_or_else(|| if i == 0 { first_title.clone() } else { String::new() });
            chapters.push(ImportedChapter { title, html, extra });
        }
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
    push_chapter_with(out, title, body, false);
}

fn push_chapter_with(out: &mut Vec<ImportedChapter>, title: Option<String>, body: &str, merge: bool) {
    let text = body.trim();
    if text.is_empty() {
        return;
    }
    out.push(ImportedChapter {
        title: title.unwrap_or_else(|| format!("Chapter {}", out.len() + 1)),
        html: paragraphs_to_html_with(text, merge),
        extra: false,
    });
}

fn import_txt(bytes: &[u8], file_name: &str) -> Result<ImportedNovel, String> {
    let raw = String::from_utf8_lossy(bytes);
    let (default_title, author) = import_clean::parse_file_name(file_name);

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
            extra: false,
        });
    }

    Ok(ImportedNovel {
        title: default_title,
        author,
        cover_base64: None,
        chapters,
    })
}

// ---------- PDF ----------

/// Section size for PDFs with no chapter headings to split on.
const PDF_PAGES_PER_SECTION: usize = 10;

fn import_pdf(bytes: &[u8], file_name: &str, opts: ImportOptions) -> Result<ImportedNovel, String> {
    // pdf-extract panics on some malformed fonts instead of returning Err.
    let raw_pages = std::panic::catch_unwind(|| pdf_extract::extract_text_from_mem_by_pages(bytes))
        .map_err(|_| "this PDF uses a format the importer can't read".to_string())?
        .map_err(|e| format!("could not read PDF: {e}"))?;
    if raw_pages.iter().all(|p| p.trim().is_empty()) {
        return Err("no text found in this PDF (scanned pages aren't supported)".into());
    }
    let pages = if opts.clean { import_clean::clean_pdf_pages(&raw_pages, opts.skip_extras) } else { raw_pages };
    let meta = pdf_meta(bytes);

    let mut chapters: Vec<ImportedChapter> = Vec::new();
    let outline = meta.as_ref().map(|m| m.outline.as_slice()).unwrap_or_default();
    if outline.len() >= 2 {
        // The PDF's own bookmarks: each runs until the next one's page.
        let first_page = outline[0].1;
        if first_page > 1 {
            let body: Vec<String> = pages[..first_page - 1].iter().map(|p| unwrap_lines(p)).collect();
            push_chapter_with(&mut chapters, Some(String::new()), &body.join("\n\n"), opts.clean);
        }
        for (k, (title, start)) in outline.iter().enumerate() {
            let end = outline.get(k + 1).map(|(_, p)| *p).unwrap_or(pages.len() + 1).max(*start + 1);
            let range = (*start - 1).min(pages.len())..(end - 1).min(pages.len());
            let mut body: Vec<String> = pages[range].iter().map(|p| unwrap_lines(p)).collect();
            if let Some(first) = body.first_mut() {
                // Drop the heading line itself when the page opens with it.
                let t = first.trim_start();
                if import_clean::norm(t.lines().next().unwrap_or("")) == import_clean::norm(title) {
                    *first = t.split_once('\n').map(|(_, rest)| rest.to_string()).unwrap_or_default();
                }
            }
            push_chapter_with(&mut chapters, Some(title.clone()), &body.join("\n\n"), opts.clean);
        }
    } else {
        // Only a page's first line counts: mid-page "Part of..." isn't a heading.
        let first_lines: Vec<Option<&str>> = pages
            .iter()
            .map(|p| p.lines().map(str::trim).find(|l| !l.is_empty()))
            .collect();
        let mut headings: Vec<Option<&str>> =
            first_lines.iter().map(|l| l.filter(|l| looks_like_chapter_heading(l))).collect();
        if headings.iter().flatten().count() < 2 {
            // Fall back to short ALL-CAPS titles opening a page, if a sensible number of pages have one.
            let caps: Vec<Option<&str>> = first_lines.iter().map(|l| l.filter(|l| caps_heading(l))).collect();
            let n = caps.iter().flatten().count();
            if n >= 3 && n * 2 <= pages.len() {
                headings = caps;
            }
        }

        if headings.iter().flatten().count() >= 2 {
            let mut current_title: Option<String> = None;
            let mut current_body = String::new();
            for (page, heading) in pages.iter().zip(&headings) {
                let mut text = page.as_str();
                if let Some(h) = heading {
                    push_chapter_with(&mut chapters, current_title.take(), &current_body, opts.clean);
                    current_body.clear();
                    current_title = Some(title_case_if_caps(h));
                    text = text.trim_start().strip_prefix(h).unwrap_or(text);
                }
                current_body.push_str(&unwrap_lines(text));
                current_body.push_str("\n\n");
            }
            push_chapter_with(&mut chapters, current_title.take(), &current_body, opts.clean);
        } else {
            for (i, section) in pages.chunks(PDF_PAGES_PER_SECTION).enumerate() {
                let first = i * PDF_PAGES_PER_SECTION + 1;
                let last = first + section.len() - 1;
                let title = if first == last { format!("Page {first}") } else { format!("Pages {first}-{last}") };
                let body: Vec<String> = section.iter().map(|p| unwrap_lines(p)).collect();
                push_chapter_with(&mut chapters, Some(title), &body.join("\n\n"), opts.clean);
            }
        }
    }

    let (file_title, file_author) = import_clean::parse_file_name(file_name);
    let meta_title = meta.as_ref().and_then(|m| m.title.as_deref()).map(|t| t.replace(" : ", ": "));
    Ok(ImportedNovel {
        title: meta_title.unwrap_or(file_title),
        author: meta.and_then(|m| m.author).map(|a| import_clean::flip_name(&a)).or(file_author),
        cover_base64: None,
        chapters,
    })
}

struct PdfMeta {
    title: Option<String>,
    author: Option<String>,
    /// Top-level bookmarks: (title, 1-based start page), in page order.
    outline: Vec<(String, usize)>,
}

/// Title/author from the document info and its bookmarks, when the PDF has them.
fn pdf_meta(bytes: &[u8]) -> Option<PdfMeta> {
    let doc = std::panic::catch_unwind(|| lopdf::Document::load_mem(bytes)).ok()?.ok()?;
    let info = doc
        .trailer
        .get(b"Info")
        .ok()
        .and_then(|o| o.as_reference().ok())
        .and_then(|id| doc.get_dictionary(id).ok());
    let field = |key: &[u8]| {
        info.and_then(|d| d.get(key).ok())
            .and_then(|o| lopdf::decode_text_string(o).ok())
            .map(|s| s.trim().trim_start_matches("Microsoft Word - ").trim_end_matches(".docx").trim_end_matches(".doc").trim().to_string())
            .filter(|s| {
                let l = s.to_lowercase();
                s.chars().filter(|c| c.is_alphabetic()).count() >= 2
                    && !["untitled", "unknown", "anonymous", "user", "admin"].contains(&l.as_str())
                    && !l.ends_with(".pdf")
                    && !l.contains("z-lib")
            })
    };
    let (title, author) = (field(b"Title"), field(b"Author"));

    let outline = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| doc.get_toc()))
        .ok()
        .and_then(|r| r.ok())
        .map(|toc| {
            let top = toc.toc.iter().map(|t| t.level).min().unwrap_or(1);
            let mut v: Vec<(String, usize)> = toc
                .toc
                .iter()
                .filter(|t| t.level == top && t.page >= 1)
                .map(|t| (t.title.split_whitespace().collect::<Vec<_>>().join(" "), t.page))
                .filter(|(t, _)| !t.is_empty())
                .collect();
            v.sort_by_key(|(_, p)| *p);
            v.dedup_by_key(|(_, p)| *p);
            v
        })
        .unwrap_or_default();
    Some(PdfMeta { title, author, outline })
}

/// "LIBERATING YOUR PROSPERITY" style section titles.
fn caps_heading(line: &str) -> bool {
    let words = line.split_whitespace().count();
    let letters: Vec<char> = line.chars().filter(|c| c.is_alphabetic()).collect();
    (1..=8).contains(&words)
        && line.chars().count() <= 60
        && letters.len() >= 4
        && letters.iter().all(|c| c.is_uppercase())
}

/// Titles read better as "Liberating Your Prosperity" than shouted.
fn title_case_if_caps(t: &str) -> String {
    if !t.chars().any(char::is_lowercase) && t.chars().filter(|c| c.is_alphabetic()).count() > 3 {
        t.split_whitespace()
            .map(|w| {
                let mut c = w.chars();
                match c.next() {
                    Some(f) => f.to_uppercase().collect::<String>() + &c.as_str().to_lowercase(),
                    None => String::new(),
                }
            })
            .collect::<Vec<_>>()
            .join(" ")
    } else {
        t.to_string()
    }
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
    paragraphs_to_html_with(text, false)
}

/// `merge`: rejoin paragraphs split mid-sentence (PDF page/column breaks).
fn paragraphs_to_html_with(text: &str, merge: bool) -> String {
    let lines = text.lines().filter(|l| !l.trim().is_empty()).count();
    let blocks = text.split("\n\n").filter(|b| !b.trim().is_empty()).count();
    let reflowed;
    let text = if lines > blocks * MAX_LINES_PER_BLOCK {
        reflowed = paragraphs_from_lines(text);
        &reflowed
    } else {
        text
    };

    // One block per line: the cleanup step splits chapter HTML on newlines.
    let paras: Vec<String> = text
        .split("\n\n")
        .map(|p| p.trim().replace('\n', " "))
        .filter(|p| !p.is_empty())
        .collect();
    let paras = if merge { import_clean::merge_broken_paragraphs(paras) } else { paras };
    paras
        .iter()
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
        let novel = import_pdf(&minimal_pdf(&pages), "annual_report.pdf", ImportOptions::default()).unwrap();
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
        let novel = import_pdf(&minimal_pdf(&pages), "book.pdf", ImportOptions::default()).unwrap();
        assert_eq!(novel.chapters.len(), 2);
        assert_eq!(novel.chapters[0].title, "Chapter 1");
        assert!(!novel.chapters[0].html.contains("Chapter 1"));
        assert!(novel.chapters[0].html.contains("It went on."));
        assert_eq!(novel.chapters[1].title, "Chapter 2");
    }

    #[test]
    fn pdf_with_no_text_is_rejected() {
        let err = import_pdf(&minimal_pdf(&[vec![]]), "scan.pdf", ImportOptions::default()).err().unwrap();
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
            chapter_sections(&doc, heading, HashMap::new()).remove(0).1,
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

