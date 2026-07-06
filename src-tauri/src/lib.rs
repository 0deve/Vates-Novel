mod export;
mod import;
mod media;
pub mod sources;
mod tts;

use std::sync::Mutex;
// Only the desktop open_data_folder needs Manager (for app.path()).
#[cfg(not(target_os = "android"))]
use tauri::Manager;
use tauri_plugin_sql::{Migration, MigrationKind};

/// Open the folder holding the app's SQLite database (all library data and
/// downloaded chapter content lives there) in the OS file manager.
#[cfg(not(target_os = "android"))]
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

/// Android has no user-visible file manager path to reveal; the frontend
/// hides the button, this is just a guard if the command is invoked anyway.
#[cfg(target_os = "android")]
#[tauri::command]
fn open_data_folder(_app: tauri::AppHandle) -> Result<(), String> {
    Err("not supported on this platform".into())
}

/// msedge-tts verifies TLS certificates through Android's trust store via
/// rustls-platform-verifier, which panics unless it is handed the app's JNI
/// context before the first TTS network call. MainActivity.onCreate
/// (gen/android) calls this right after `super.onCreate()` has loaded the
/// Rust library — Tauri itself never exposes the JNI context to app code,
/// so a direct JNI export is the race-free way in. Two semver-distinct
/// copies of the verifier live in the dependency graph (0.7 for the
/// synthesis websocket, 0.6 via ureq for voice listing), each with its own
/// global and jni crate — initialize both from the one env Kotlin gives us.
/// The matching Kotlin component ships as an AAR wired up in
/// gen/android/app/build.gradle.kts.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_stefan_desktop_1novel_MainActivity_initTlsVerifier(
    mut env: jni021::JNIEnv,
    _this: jni021::objects::JObject,
    context: jni021::objects::JObject,
) {
    let raw_env = env.get_raw();
    let raw_ctx = context.as_raw();

    if let Err(e) = rustls_platform_verifier_06::android::init_with_env(&mut env, context) {
        eprintln!("rustls-platform-verifier 0.6 init failed (voice-list TLS broken): {e}");
    }

    let mut env22 = unsafe { jni022::EnvUnowned::from_raw(raw_env.cast()) };
    let outcome = env22.with_env(|env| {
        let ctx22 = unsafe { jni022::objects::JObject::from_raw(env, raw_ctx.cast()) };
        rustls_platform_verifier_07::android::init_with_env(env, ctx22)
    });
    match outcome.into_outcome() {
        jni022::Outcome::Ok(()) => {}
        jni022::Outcome::Err(e) => {
            eprintln!("rustls-platform-verifier 0.7 init failed (synthesis TLS broken): {e}")
        }
        jni022::Outcome::Panic(_) => {
            eprintln!("rustls-platform-verifier 0.7 init panicked (synthesis TLS broken)")
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Both of rustls's crypto backends are feature-enabled through
    // dependency unification (ring via reqwest's rustls-tls, aws-lc-rs via
    // msedge-tts), and rustls refuses to auto-pick when both are present —
    // the TTS websocket would panic at its first connect. Pin ring; an Err
    // only means a provider is already installed, which is fine.
    let _ = rustls::crypto::ring::default_provider().install_default();

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
        .plugin(tauri_plugin_fs::init())
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
            import::import_local_novel,
            export::export_novel,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
