//! Post-import cleanup shared by EPUB/PDF/TXT: drops tables of contents, front/back
//! matter, title/author echoes and repeated boilerplate that TTS would read aloud.

use crate::import::{ImportedChapter, ImportedNovel};
use serde::Deserialize;
use std::collections::{HashMap, HashSet};

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub struct ImportOptions {
    #[serde(default = "yes")]
    pub clean: bool,
    #[serde(default = "yes")]
    pub skip_extras: bool,
}

fn yes() -> bool {
    true
}

impl Default for ImportOptions {
    fn default() -> Self {
        Self { clean: true, skip_extras: true }
    }
}

/// Plain text of an HTML fragment, entities decoded, whitespace collapsed.
pub fn block_text(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => {
                in_tag = true;
                out.push(' ');
            }
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    let out = out
        .replace("&nbsp;", " ")
        .replace("&#160;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&amp;", "&");
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Lowercase letters and digits only, for fuzzy equality.
pub fn norm(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

fn blocks(html: &str) -> Vec<String> {
    html.split('\n').map(str::trim).filter(|b| !b.is_empty()).map(String::from).collect()
}

/// A run of entries like "To Mars ........ 3" (dot leaders + page numbers).
fn is_toc_block(text: &str) -> bool {
    let leaders = text.matches("....").count() + text.matches("\u{2026}\u{2026}").count();
    let numbered_entries = text
        .split(|c: char| c == '.' || c == '\u{2026}')
        .filter(|seg| {
            let t = seg.trim();
            !t.is_empty() && t.split_whitespace().next().is_some_and(|w| w.chars().all(|c| c.is_ascii_digit()))
        })
        .count();
    leaders >= 3 && numbered_entries >= 3
}

/// One "Title ........ 12" line.
fn is_toc_entry(text: &str) -> bool {
    let t = text.trim_end();
    let has_leader = t.contains("....") || t.contains("\u{2026}\u{2026}") || t.contains(". . . .");
    let ends_number = t
        .rsplit(|c: char| c.is_whitespace() || c == '.' || c == '\u{2026}')
        .next()
        .is_some_and(|w| !w.is_empty() && w.len() <= 4 && w.chars().all(|c| c.is_ascii_digit() || "ivxlcdm".contains(c)));
    has_leader && ends_number && t.chars().count() <= 200
}

fn is_contents_heading(text: &str) -> bool {
    matches!(norm(text).as_str(), "contents" | "tableofcontents" | "toc" | "index")
}

const EXTRA_TITLES: [&str; 20] = [
    "cover",
    "titlepage",
    "title",
    "halftitle",
    "copyright",
    "copyrightpage",
    "contents",
    "tableofcontents",
    "dedication",
    "epigraph",
    "praise",
    "alsoby",
    "otherbooksby",
    "booksby",
    "newsletter",
    "signup",
    "moreinformation",
    "aboutthepublisher",
    "frontmatter",
    "backads",
];

fn title_says_extra(title: &str) -> bool {
    let n = norm(title);
    EXTRA_TITLES.iter().any(|t| n == *t)
        || n.starts_with("praisefor")
        || n.starts_with("alsoby")
        || n.starts_with("otherbooksby")
        || n.starts_with("morefrom")
        || n.starts_with("copyright")
}

/// Content-based detection for untitled front/back matter.
fn content_says_extra(texts: &[String], book_words: &HashSet<String>) -> bool {
    let all = texts.join(" ");
    let len = all.chars().count();
    if len == 0 {
        return true;
    }
    let lower = all.to_lowercase();
    if len < 3000 && is_copyright_text(&lower) {
        return true;
    }
    if len > 1500 {
        return false;
    }
    // Title page: nothing but the book's title and author words.
    let words: Vec<String> = all
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(|w| w.to_lowercase())
        .collect();
    if !words.is_empty() && words.iter().all(|w| book_words.contains(w) || w.len() <= 2) {
        return true;
    }
    // Dedication: one short line starting "for"/"to".
    if len < 200 && texts.len() <= 3 && (lower.starts_with("for ") || lower.starts_with("to ")) {
        return true;
    }
    // Ads for other books.
    if lower.contains("www.") && (lower.contains("look out for") || lower.contains("also available") || lower.contains("coming soon")) {
        return true;
    }
    // Praise: mostly quotations followed by attributions.
    let quoted = texts.iter().filter(|t| t.starts_with(['\u{201C}', '"'])).count();
    quoted >= 3 && quoted * 3 >= texts.len()
}

/// Expects lowercase text.
fn is_copyright_text(lower: &str) -> bool {
    (lower.contains('©') || lower.contains("copyright"))
        && ["all rights reserved", "isbn", "published by", "first published", "printed in", "library of congress"]
            .iter()
            .filter(|k| lower.contains(*k))
            .count()
            >= 2
}

fn is_number_title(t: &str) -> bool {
    let t = t.trim();
    !t.is_empty()
        && (t.chars().all(|c| c.is_ascii_digit())
            || (t.len() <= 6 && t.chars().all(|c| "IVXLCDM".contains(c))))
}

pub fn clean(novel: &mut ImportedNovel, opts: ImportOptions) {
    if opts.clean {
        let title_n = norm(&novel.title);
        let author_n = novel.author.as_deref().map(norm).unwrap_or_default();
        let book_words: HashSet<String> = format!("{} {}", novel.title, novel.author.as_deref().unwrap_or(""))
            .split(|c: char| !c.is_alphanumeric())
            .filter(|w| !w.is_empty())
            .map(|w| w.to_lowercase())
            .chain(["by", "the", "a", "and", "of", "novel", "book"].map(String::from))
            .collect();

        let mut kept: Vec<ImportedChapter> = Vec::new();
        for mut ch in std::mem::take(&mut novel.chapters) {
            let mut bl = blocks(&ch.html);
            let texts: Vec<String> = bl.iter().map(|b| block_text(b)).collect();

            // Repeated tables of contents (and the "Contents" label before them).
            let mut drop = vec![false; bl.len()];
            let mut i = 0;
            while i < bl.len() {
                // One block holding the whole list, or a run of one-entry lines.
                let run = (i..bl.len()).take_while(|&k| is_toc_entry(&texts[k])).count();
                let end = if is_toc_block(&texts[i]) { i + 1 } else if run >= 3 { i + run } else { i };
                if end > i {
                    drop[i..end].iter_mut().for_each(|d| *d = true);
                    if i > 0 && is_contents_heading(&texts[i - 1]) {
                        drop[i - 1] = true;
                    }
                    i = end;
                } else {
                    i += 1;
                }
            }

            // Title/author lines echoed at the start of a chapter, plus anything between them (subtitles).
            let echo = |t: &str| {
                let n = norm(t);
                !n.is_empty()
                    && (n == title_n
                        || n == author_n
                        || n == format!("{title_n}{author_n}")
                        || n == format!("by{author_n}")
                        || n == norm(&ch.title))
            };
            let first_text = (0..bl.len()).filter(|&i| !drop[i]).take(8).collect::<Vec<_>>();
            if let Some(&last_echo) = first_text.iter().rev().find(|&&i| echo(&texts[i])) {
                let all_short = first_text
                    .iter()
                    .take_while(|&&i| i <= last_echo)
                    .all(|&i| texts[i].chars().count() <= 160);
                if all_short {
                    for &i in first_text.iter().take_while(|&&i| i <= last_echo) {
                        drop[i] = true;
                    }
                }
            }

            let mut i = 0;
            bl.retain(|_| {
                let keep = !drop[i];
                i += 1;
                keep
            });
            let texts: Vec<String> = bl.iter().map(|b| block_text(b)).collect();

            if opts.skip_extras && (ch.extra || title_says_extra(&ch.title) || content_says_extra(&texts, &book_words)) {
                continue;
            }
            if !texts.iter().any(|t| t.chars().any(char::is_alphabetic)) {
                continue;
            }
            ch.html = bl.join("\n");
            kept.push(ch);
        }

        remove_boilerplate(&mut kept);
        novel.chapters = kept;
    }

    // Titles: "1" -> "Chapter 1", blanks numbered in reading order.
    for (i, ch) in novel.chapters.iter_mut().enumerate() {
        let t = ch.title.split_whitespace().collect::<Vec<_>>().join(" ");
        ch.title = if t.is_empty() {
            format!("Chapter {}", i + 1)
        } else if is_number_title(&t) {
            format!("Chapter {t}")
        } else {
            t
        };
    }
}

/// Short non-sentence lines repeated across many chapters (running headers, site names).
fn remove_boilerplate(chapters: &mut [ImportedChapter]) {
    if chapters.len() < 4 {
        return;
    }
    let mut seen: HashMap<String, usize> = HashMap::new();
    for ch in chapters.iter() {
        let unique: HashSet<String> = blocks(&ch.html).iter().map(|b| norm(&block_text(b))).collect();
        for n in unique {
            *seen.entry(n).or_default() += 1;
        }
    }
    let threshold = (chapters.len() * 3 / 10).max(3);
    let candidate = |text: &str| {
        let words = text.split_whitespace().count();
        words >= 2
            && text.chars().count() <= 100
            && !text.ends_with(['.', '!', '?', '"', '\u{201D}', '\u{2019}'])
            && !text.starts_with(['"', '\u{201C}', '\u{2018}'])
    };
    for ch in chapters.iter_mut() {
        let kept: Vec<String> = blocks(&ch.html)
            .into_iter()
            .filter(|b| {
                let t = block_text(b);
                !(candidate(&t) && seen.get(&norm(&t)).is_some_and(|&n| n >= threshold))
            })
            .collect();
        ch.html = kept.join("\n");
    }
}

// ---------- PDF page cleanup ----------

fn page_number_line(line: &str) -> bool {
    let t = line.trim().trim_matches(|c: char| "-–—|•·[]()".contains(c)).trim();
    if t.is_empty() {
        return false;
    }
    let lower = t.to_lowercase();
    let lower = lower.strip_prefix("page ").unwrap_or(&lower);
    let first = lower.split(" of ").next().unwrap_or(lower).trim();
    first.chars().all(|c| c.is_ascii_digit()) && first.len() <= 4
        || (first.len() <= 6 && !first.is_empty() && first.chars().all(|c| "ivxlcdm".contains(c)))
}

/// Mostly symbols/noise, typical of OCR on images and decorations.
fn junk_line(line: &str) -> bool {
    let chars: Vec<char> = line.chars().filter(|c| !c.is_whitespace()).collect();
    if chars.is_empty() {
        return false;
    }
    let letters = chars.iter().filter(|c| c.is_alphabetic()).count();
    let has_word = line
        .split_whitespace()
        .any(|w| w.chars().filter(|c| c.is_alphabetic()).count() >= 3);
    letters * 10 < chars.len() * 6 || (!has_word && chars.len() <= 4 && !matches!(line.trim(), "I" | "a" | "A"))
}

fn header_key(line: &str) -> String {
    line.chars()
        .map(|c| if c.is_ascii_digit() { '#' } else { c })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// Strip running headers/footers, page numbers and OCR junk from each page.
pub fn clean_pdf_pages(pages: &[String], skip_extras: bool) -> Vec<String> {
    const EDGE: usize = 3;
    let lines: Vec<Vec<&str>> = pages
        .iter()
        .map(|p| p.lines().map(str::trim).filter(|l| !l.is_empty()).collect())
        .collect();

    // Lines that keep showing up at the top or bottom of pages.
    let mut counts: HashMap<String, usize> = HashMap::new();
    // Pages this short have no room for a header; their one line is the content.
    for page in lines.iter().filter(|p| p.len() > EDGE * 2) {
        let edge: HashSet<String> = page
            .iter()
            .take(EDGE)
            .chain(page.iter().rev().take(EDGE))
            .map(|l| header_key(l))
            .collect();
        for k in edge {
            *counts.entry(k).or_default() += 1;
        }
    }
    let threshold = (pages.len() / 8).max(3);
    let running: HashSet<String> = counts
        .into_iter()
        .filter(|(k, n)| *n >= threshold && k.chars().count() <= 120)
        .map(|(k, _)| k)
        .collect();

    pages
        .iter()
        .zip(&lines)
        .map(|(raw, page)| {
            if skip_extras && raw.len() < 5000 && is_copyright_text(&raw.to_lowercase()) {
                return String::new();
            }
            let n = page.len();
            let keep_line = |i: usize, l: &str| {
                let at_edge = i < EDGE || i + EDGE >= n;
                !(at_edge && running.contains(&header_key(l))) && !page_number_line(l) && !junk_line(l)
            };
            // Keep blank lines (paragraph breaks) from the raw page.
            let mut idx = 0;
            let mut out = String::new();
            for line in raw.lines() {
                let t = line.trim();
                if t.is_empty() {
                    out.push('\n');
                    continue;
                }
                if keep_line(idx, t) {
                    out.push_str(&fix_ocr(t));
                    out.push('\n');
                }
                idx += 1;
            }
            out
        })
        .collect()
}

/// Common OCR slips: "lam" for "I am", a lone "l" for "I".
fn fix_ocr(line: &str) -> String {
    let mut s = line.to_string();
    if let Some(rest) = s.strip_prefix("lam ") {
        s = format!("I am {rest}");
    } else if s == "lam" {
        s = "I am".into();
    }
    s.replace(" l ", " I ")
}

/// Rejoin paragraphs a PDF/OCR split mid-sentence.
pub fn merge_broken_paragraphs(paras: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for p in paras {
        let p = p.split_whitespace().collect::<Vec<_>>().join(" ");
        if p.is_empty() {
            continue;
        }
        if let Some(prev) = out.last_mut() {
            let ends_open = !prev.ends_with(['.', '!', '?', ':', ';', '"', '\u{201D}', '\u{2019}', ')', ']']);
            let starts_lower = p.starts_with(|c: char| c.is_lowercase());
            if prev.ends_with('-') && starts_lower {
                prev.pop();
                prev.push_str(&p);
                continue;
            }
            if ends_open && (starts_lower || prev.ends_with(',')) {
                prev.push(' ');
                prev.push_str(&p);
                continue;
            }
        }
        out.push(p);
    }
    out
}

// ---------- titles from file names ----------

/// "Title (Author) (z-library.sk, ...)" or "Title -- Author -- 2008 -- ..." -> (title, author).
pub fn parse_file_name(file_name: &str) -> (String, Option<String>) {
    let stem = std::path::Path::new(file_name)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();

    if stem.contains(" -- ") {
        let parts: Vec<&str> = stem.split(" -- ").map(str::trim).collect();
        let author = parts.get(1).filter(|a| !a.is_empty()).map(|a| flip_name(a));
        return (parts[0].to_string(), author);
    }

    let mut title = stem.replace('_', " ");
    let mut author = None;
    // Peel trailing (...) / [...] groups: site tags are dropped, a name-like one is the author.
    loop {
        let t = title.trim_end();
        let Some(open) = (if t.ends_with(')') { t.rfind('(') } else if t.ends_with(']') { t.rfind('[') } else { None }) else {
            break;
        };
        let inner = t[open + 1..t.len() - 1].trim().to_string();
        title = t[..open].trim_end().to_string();
        let lower = inner.to_lowercase();
        let is_site = lower.contains("lib") || lower.contains(".org") || lower.contains(".com") || lower.contains(".sk") || lower.contains("z-") || lower.contains("annas") || lower.contains("archive");
        let looks_like_name = !is_site
            && (1..=5).contains(&inner.split_whitespace().count())
            && inner.chars().next().is_some_and(char::is_uppercase)
            && !inner.chars().any(|c| c.is_ascii_digit());
        if author.is_none() && looks_like_name {
            author = Some(inner);
        }
        if title.is_empty() {
            break;
        }
    }
    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    (if title.is_empty() { "Imported Book".into() } else { title }, author)
}

/// "Collins, Suzanne" -> "Suzanne Collins".
pub fn flip_name(a: &str) -> String {
    let first = a.split(';').next().unwrap_or(a).trim();
    match first.split_once(", ") {
        Some((last, given)) if !given.contains(',') && given.split_whitespace().count() <= 3 => format!("{given} {last}"),
        _ => first.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ch(title: &str, paras: &[&str]) -> ImportedChapter {
        ImportedChapter {
            title: title.into(),
            html: paras.iter().map(|p| format!("<p>{p}</p>")).collect::<Vec<_>>().join("\n"),
            extra: false,
        }
    }

    #[test]
    fn file_names_lose_site_tags_and_yield_authors() {
        assert_eq!(
            parse_file_name("Prosperity (Richard Rudd) (z-library.sk, 1lib.sk, z-lib.sk).pdf"),
            ("Prosperity".into(), Some("Richard Rudd".into()))
        );
        assert_eq!(
            parse_file_name("The Hunger Games -- Collins, Suzanne -- Hunger Games 1, 2008 -- Scholastic.epub"),
            ("The Hunger Games".into(), Some("Suzanne Collins".into()))
        );
        assert_eq!(parse_file_name("my_story.txt").0, "my story");
    }

    #[test]
    fn removes_toc_title_echo_and_front_matter() {
        let mut n = ImportedNovel {
            title: "All Tomorrows".into(),
            author: Some("Nemo Ramjet".into()),
            cover_base64: None,
            chapters: vec![
                ch("", &["ALL TOMORROWS", "Nemo Ramjet"]),
                ch("Copyright", &["Text copyright 2008"]),
                ch("To Mars", &["Nemo Ramjet", "All Tomorrows", "A subtitle line", "Nemo Ramjet", "To Mars", "It began.", "Contents", "To Mars ........ 3<br>Worms ........ 19<br>Titans ........ 21<br>Qu ........ 15"]),
                ch("1", &["Real text here."]),
            ],
        };
        clean(&mut n, ImportOptions::default());
        assert_eq!(n.chapters.len(), 2);
        assert_eq!(n.chapters[0].html, "<p>It began.</p>");
        assert_eq!(n.chapters[1].title, "Chapter 1");
    }

    #[test]
    fn pdf_pages_lose_running_headers_and_page_numbers() {
        let pages: Vec<String> = (1..=10)
            .map(|i| {
                let words = ["river", "mountain", "lantern", "harbor", "orchard", "meadow", "glacier"];
                let body: String = (0..6).map(|k| format!("The {} rose over the {}.\n", words[(i + k) % 7], words[(i * 3 + k) % 7])).collect();
                format!("The Golden Path\n{i}\n{body}")
            })
            .collect();
        let cleaned = clean_pdf_pages(&pages, true);
        assert!(!cleaned[3].contains("Golden Path"));
        assert!(cleaned[3].contains("rose over"));
        assert!(!cleaned[3].lines().any(|l| l.trim() == "4"));
    }

    #[test]
    fn broken_lines_are_rejoined() {
        let merged = merge_broken_paragraphs(vec!["I choose to feel".into(), "good about my-".into(), "self each day.".into(), "Next one.".into()]);
        assert_eq!(merged, vec!["I choose to feel good about myself each day.", "Next one."]);
    }
}
