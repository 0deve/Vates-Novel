//! Export a novel's downloaded chapters back out to .epub or .txt — the
//! reverse of `import`. Best-effort like import: real-world scraped HTML is
//! rarely perfectly strict XHTML, so a couple of common void elements are
//! patched up before being embedded in the EPUB's XHTML chapters.

use scraper::{Html, Selector};
use serde::Deserialize;
use std::io::Write as _;

#[derive(Deserialize)]
pub struct ExportChapter {
    pub title: String,
    pub html: String,
}

#[tauri::command]
pub fn export_novel(
    path: String,
    title: String,
    author: Option<String>,
    chapters: Vec<ExportChapter>,
) -> Result<(), String> {
    if chapters.is_empty() {
        return Err("no downloaded chapters to export".into());
    }
    let lower = path.to_lowercase();
    if lower.ends_with(".epub") {
        export_epub(&path, &title, author.as_deref(), &chapters)
    } else if lower.ends_with(".txt") {
        export_txt(&path, &title, author.as_deref(), &chapters)
    } else {
        Err("Unsupported export format — choose .epub or .txt".into())
    }
}

fn html_to_text(html: &str) -> String {
    let doc = Html::parse_fragment(html);
    let p_sel = Selector::parse("p").expect("static selector");
    let paras: Vec<String> = doc
        .select(&p_sel)
        .map(|p| p.text().collect::<String>().trim().to_string())
        .filter(|t| !t.is_empty())
        .collect();
    if paras.is_empty() {
        doc.root_element()
            .text()
            .collect::<String>()
            .trim()
            .to_string()
    } else {
        paras.join("\n\n")
    }
}

fn export_txt(
    path: &str,
    title: &str,
    author: Option<&str>,
    chapters: &[ExportChapter],
) -> Result<(), String> {
    let mut out = String::new();
    out.push_str(title);
    out.push('\n');
    if let Some(a) = author {
        out.push_str("by ");
        out.push_str(a);
        out.push('\n');
    }
    out.push('\n');
    for ch in chapters {
        out.push_str(&ch.title);
        out.push_str("\n\n");
        out.push_str(&html_to_text(&ch.html));
        out.push_str("\n\n\n");
    }
    std::fs::write(path, out).map_err(|e| e.to_string())
}

/// Self-close common void elements that scraped HTML often leaves bare
/// (`<br>` instead of `<br/>`), which strict XHTML parsers reject.
fn xhtml_safe(html: &str) -> String {
    html.replace("<br>", "<br/>")
        .replace("<hr>", "<hr/>")
        .replace("<img>", "<img/>")
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn simple_hash(s: &str) -> u64 {
    let mut h: u64 = 5381;
    for b in s.bytes() {
        h = h.wrapping_mul(33).wrapping_add(b as u64);
    }
    h
}

const CONTAINER_XML: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"#;

fn export_epub(
    path: &str,
    title: &str,
    author: Option<&str>,
    chapters: &[ExportChapter],
) -> Result<(), String> {
    let file = std::fs::File::create(path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let stored = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored);
    let deflated = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    zip.start_file("mimetype", stored)
        .map_err(|e| e.to_string())?;
    zip.write_all(b"application/epub+zip")
        .map_err(|e| e.to_string())?;

    zip.start_file("META-INF/container.xml", deflated)
        .map_err(|e| e.to_string())?;
    zip.write_all(CONTAINER_XML.as_bytes())
        .map_err(|e| e.to_string())?;

    let title_esc = xml_escape(title);
    let author_esc = author.map(xml_escape).unwrap_or_else(|| "Unknown".to_string());
    let uid = format!("urn:uuid:vates-novel-{:x}", simple_hash(title));

    let manifest_items: String = (0..chapters.len())
        .map(|i| format!(r#"<item id="chap{i}" href="chap{i}.xhtml" media-type="application/xhtml+xml"/>"#))
        .collect::<Vec<_>>()
        .join("\n    ");
    let spine_items: String = (0..chapters.len())
        .map(|i| format!(r#"<itemref idref="chap{i}"/>"#))
        .collect::<Vec<_>>()
        .join("\n    ");

    let opf = format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">{uid}</dc:identifier>
    <dc:title>{title_esc}</dc:title>
    <dc:creator>{author_esc}</dc:creator>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    {manifest_items}
  </manifest>
  <spine toc="ncx">
    {spine_items}
  </spine>
</package>
"#
    );
    zip.start_file("OEBPS/content.opf", deflated)
        .map_err(|e| e.to_string())?;
    zip.write_all(opf.as_bytes()).map_err(|e| e.to_string())?;

    let nav_items: String = chapters
        .iter()
        .enumerate()
        .map(|(i, c)| format!(r#"<li><a href="chap{i}.xhtml">{}</a></li>"#, xml_escape(&c.title)))
        .collect::<Vec<_>>()
        .join("\n      ");
    let nav = format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Contents</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Contents</h1>
    <ol>
      {nav_items}
    </ol>
  </nav>
</body>
</html>
"#
    );
    zip.start_file("OEBPS/nav.xhtml", deflated)
        .map_err(|e| e.to_string())?;
    zip.write_all(nav.as_bytes()).map_err(|e| e.to_string())?;

    let nav_points: String = chapters
        .iter()
        .enumerate()
        .map(|(i, c)| {
            format!(
                r#"<navPoint id="navpoint-{i}" playOrder="{order}"><navLabel><text>{label}</text></navLabel><content src="chap{i}.xhtml"/></navPoint>"#,
                order = i + 1,
                label = xml_escape(&c.title),
            )
        })
        .collect::<Vec<_>>()
        .join("\n    ");
    let ncx = format!(
        r#"<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="{uid}"/>
  </head>
  <docTitle><text>{title_esc}</text></docTitle>
  <navMap>
    {nav_points}
  </navMap>
</ncx>
"#
    );
    zip.start_file("OEBPS/toc.ncx", deflated)
        .map_err(|e| e.to_string())?;
    zip.write_all(ncx.as_bytes()).map_err(|e| e.to_string())?;

    for (i, ch) in chapters.iter().enumerate() {
        let title_esc = xml_escape(&ch.title);
        let body = xhtml_safe(&ch.html);
        let xhtml = format!(
            r#"<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>{title_esc}</title></head>
<body>
<h1>{title_esc}</h1>
{body}
</body>
</html>
"#
        );
        zip.start_file(format!("OEBPS/chap{i}.xhtml"), deflated)
            .map_err(|e| e.to_string())?;
        zip.write_all(xhtml.as_bytes()).map_err(|e| e.to_string())?;
    }

    zip.finish().map_err(|e| e.to_string())?;
    Ok(())
}
