//! Headless smoke test for any registered novel source.
//!
//! Run: cargo run --example source_spike [source_id] [query]
//! e.g. cargo run --example source_spike stub sword

use desktop_novel_lib::sources::SourceRegistry;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let source_id = args.get(1).map(String::as_str).unwrap_or("stub");
    let query = args.get(2).map(String::as_str).unwrap_or("");

    let registry = SourceRegistry::new();
    let src = registry
        .get(source_id)
        .expect("source not registered (private sources need /private present)");

    println!("[1/3] search({query:?}) on '{}'…", src.name());
    let results = src.search(query).expect("search failed");
    println!("      {} results", results.len());
    let first = results.first().expect("no results");
    println!("      first: {} — {}", first.title, first.novel_url);

    println!("[2/3] novel_details…");
    let details = src.novel_details(&first.novel_url).expect("details failed");
    println!(
        "      {} by {} [{}] — {} chapters",
        details.title,
        details.author.as_deref().unwrap_or("?"),
        details.status.as_deref().unwrap_or("?"),
        details.chapters.len()
    );

    println!("[3/3] chapter_content of chapter 1…");
    let ch = &details.chapters[0];
    let cc = src.chapter_content(&ch.chapter_url).expect("content failed");
    if let Some(t) = &cc.title {
        println!("      real title: {t}");
    }
    let content = cc.html;
    let plain: String = content
        .replace("<p>", "")
        .replace("</p>", " ")
        .chars()
        .take(220)
        .collect();
    println!("      [{}] {} chars", ch.title, content.len());
    println!("      {plain}…");

    println!("\nSOURCE SPIKE ({source_id}): PASS");
}
