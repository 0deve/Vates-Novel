//! Mock source shipped in the public repo so anyone can clone, build, and
//! exercise the full UI without any real scraper (implementation.md §2).

use super::{ChapterContent, ChapterRef, NovelDetails, NovelSource, SearchResult};

pub struct StubSource;

const NOVELS: &[(&str, &str, &str)] = &[
    (
        "stub://ascending-heavens",
        "Ascending the Nine Heavens",
        "Cloud River Sage",
    ),
    (
        "stub://sword-of-dawn",
        "Sword of the Silent Dawn",
        "Moonlit Scribe",
    ),
    (
        "stub://reborn-merchant",
        "The Reborn Merchant's Empire",
        "Golden Abacus",
    ),
];

impl NovelSource for StubSource {
    fn id(&self) -> &'static str {
        "stub"
    }

    fn name(&self) -> &'static str {
        "Stub Source (mock data)"
    }

    fn search(&self, query: &str) -> Result<Vec<SearchResult>, String> {
        let q = query.to_lowercase();
        Ok(NOVELS
            .iter()
            .filter(|(_, title, _)| q.is_empty() || title.to_lowercase().contains(&q))
            .map(|(url, title, author)| SearchResult {
                source_id: "stub".into(),
                novel_url: (*url).into(),
                title: (*title).into(),
                author: Some((*author).into()),
                cover_url: None,
                chapter_count: Some(30),
                status: Some("Ongoing".into()),
            })
            .collect())
    }

    fn novel_details(&self, novel_url: &str) -> Result<NovelDetails, String> {
        let (url, title, author) = NOVELS
            .iter()
            .find(|(url, _, _)| *url == novel_url)
            .ok_or_else(|| format!("stub novel not found: {novel_url}"))?;

        let chapters = (1..=30)
            .map(|i| ChapterRef {
                chapter_url: format!("{url}/chapter-{i}"),
                index: i,
                title: format!("Chapter {i}: The Trial of the {i}th Gate"),
            })
            .collect();

        Ok(NovelDetails {
            source_id: "stub".into(),
            novel_url: (*url).into(),
            title: (*title).into(),
            author: Some((*author).into()),
            cover_url: None,
            status: Some("Ongoing".into()),
            summary: Some(
                "A mock novel served by StubSource so the UI can be developed \
                 and tested without any real scraping backend."
                    .into(),
            ),
            chapters,
        })
    }

    fn chapter_content(&self, chapter_url: &str) -> Result<ChapterContent, String> {
        let idx = chapter_url
            .rsplit('-')
            .next()
            .and_then(|s| s.parse::<u32>().ok())
            .unwrap_or(1);

        let mut paragraphs = Vec::new();
        for p in 1..=8 {
            paragraphs.push(format!(
                "<p>Paragraph {p} of chapter {idx}. Lin Feng drew a deep breath \
                 as the spiritual energy gathered around him. The {idx}th gate \
                 loomed ahead, its ancient runes pulsing with a cold light. He \
                 stepped forward without hesitation.</p>"
            ));
        }
        Ok(ChapterContent {
            title: None,
            html: paragraphs.join("\n"),
        })
    }
}
