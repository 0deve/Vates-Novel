mod export;
mod import;
mod media;
pub mod sources;
mod tts;

use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_sql::{Migration, MigrationKind};

/// Open the folder holding the app's SQLite database (all library data and
/// downloaded chapter content lives there) in the OS file manager.
#[tauri::command]
fn open_data_folder(app: tauri::AppHandle) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("explorer").arg(&dir).spawn();
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(&dir).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let result = std::process::Command::new("xdg-open").arg(&dir).spawn();

    result.map(|_| ()).map_err(|e| e.to_string())
}

/// Generic text file write/read, used for the library export/import backup.
#[tauri::command]
fn write_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(path, contents).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| e.to_string())
}

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
        Migration {
            version: 3,
            description: "track newly-discovered chapters for the library badge",
            sql: "ALTER TABLE novels ADD COLUMN new_chapters_count INTEGER NOT NULL DEFAULT 0;",
            kind: MigrationKind::Up,
        },
        Migration {
            version: 4,
            description: "collections for organizing the library",
            sql: "CREATE TABLE IF NOT EXISTS collections (
                      id INTEGER PRIMARY KEY AUTOINCREMENT,
                      name TEXT NOT NULL UNIQUE
                  );
                  CREATE TABLE IF NOT EXISTS novel_collections (
                      novel_id INTEGER NOT NULL REFERENCES novels (id) ON DELETE CASCADE,
                      collection_id INTEGER NOT NULL REFERENCES collections (id) ON DELETE CASCADE,
                      PRIMARY KEY (novel_id, collection_id)
                  );",
            kind: MigrationKind::Up,
        },
    ];

    tauri::Builder::default()
        .plugin(
            tauri_plugin_sql::Builder::default()
                .add_migrations("sqlite:novel.db", migrations)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
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
            open_data_folder,
            write_text_file,
            read_text_file,
            import::import_local_novel,
            export::export_novel,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
