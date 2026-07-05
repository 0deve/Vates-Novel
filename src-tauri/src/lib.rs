mod media;
pub mod sources;
mod tts;

use std::sync::Mutex;
use tauri_plugin_sql::{Migration, MigrationKind};

pub fn run() {
    let migrations = vec![
        Migration {
            version: 1,
            description: "initial schema",
            sql: include_str!("../migrations/001_init.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "track last read time for the recents list",
            sql: "ALTER TABLE novels ADD COLUMN last_read_at TEXT;",
            kind: MigrationKind::Up,
        },
    ];

    tauri::Builder::default()
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:novel.db", migrations)
                .build(),
        )
        .manage(sources::SourceRegistry::new())
        .manage(media::MediaState(Mutex::new(None)))
        .setup(|app| {
            // Media keys are a nice-to-have; never block startup on them
            // (WebKitGTK/MPRIS quirks on Linux, see implementation.md §1).
            if let Err(e) = media::init(app.handle()) {
                eprintln!("media session init failed: {e}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            sources::list_sources,
            sources::search_novels,
            sources::get_novel_details,
            sources::get_chapter_content,
            tts::list_voices,
            tts::synthesize,
            tts::clear_tts_cache,
            media::media_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
