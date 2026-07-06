//! Mock source shipped in the public repo so anyone can clone, build, and
//! exercise the full UI without any real scraper (implementation.md §2).

use super::{ChapterContent, ChapterRef, NovelDetails, NovelSource, SearchResult};

pub struct StubSource;

const NOVELS: &[(&str, &str, &str)] = &[
    (
        "stub://glass-house-murders",
        "The Glass House Murders",
        "Adrienne Voss",
    ),
    (
        "stub://signal-from-ceres",
        "Signal from Ceres",
        "Marcus Whitfield",
    ),
    (
        "stub://bookshop-on-elm-street",
        "The Bookshop on Elm Street",
        "Clara Nightingale",
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
            .map(|i| {
                let title = match *url {
                    "stub://glass-house-murders" => format!("Chapter {i}: Clue No. {i}"),
                    "stub://signal-from-ceres" => format!("Chapter {i}: Transmission {i}"),
                    "stub://bookshop-on-elm-street" => format!("Chapter {i}: A Quiet Evening"),
                    _ => format!("Chapter {i}"),
                };
                ChapterRef {
                    chapter_url: format!("{url}/chapter-{i}"),
                    index: i,
                    title,
                }
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

        let flavor = if chapter_url.starts_with("stub://glass-house-murders") {
            "Detective Voss knelt by the shattered window, turning the fragment \
             of glass over in gloved fingers. Something about the angle of the \
             break didn't add up."
        } else if chapter_url.starts_with("stub://signal-from-ceres") {
            "The relay chirped, then steadied. Commander Reyes leaned toward \
             the console as the waveform resolved into something that was, \
             unmistakably, not noise."
        } else if chapter_url.starts_with("stub://bookshop-on-elm-street") {
            "The bell above the door rang as rain swept in behind the last \
             customer of the evening. Clara set down her pen and looked up."
        } else {
            "A placeholder scene unfolds."
        };

        let mut paragraphs = Vec::new();
        for p in 1..=8 {
            paragraphs.push(format!(
                "<p>Paragraph {p} of chapter {idx}. {flavor}</p>"
            ));
        }
        Ok(ChapterContent {
            title: None,
            html: paragraphs.join("\n"),
        })
    }
}
