//! Edge TTS integration (implementation.md §4).
//!
//! Uses the `msedge-tts` crate (blocking client) wrapped in `spawn_blocking`.
//! Synthesis returns MP3 bytes plus WordBoundary events extracted from the
//! Edge metadata stream — these drive exact highlighting in the reader; no
//! timing estimation anywhere.
//!
//! Synthesized audio is cached on disk (app cache dir), keyed by
//! hash(voice|rate|pitch|text), enabling offline re-listening and instant
//! replays (implementation.md §4 "Audio caching").

use base64::Engine;
use msedge_tts::tts::client::{connect, MSEdgeTTSClient, SynthesizedAudio};
use msedge_tts::tts::SpeechConfig;
use msedge_tts::voice::get_voices_list;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;

#[derive(Serialize, Clone)]
pub struct VoiceInfo {
    /// Full voice name understood by the Edge API — pass this to `synthesize`.
    pub name: String,
    /// e.g. "en-US-AriaNeural"
    pub short_name: String,
    pub locale: String,
    pub gender: String,
    pub friendly_name: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct WordBoundary {
    pub text: String,
    pub offset_ms: u64,
    pub duration_ms: u64,
}

#[derive(Serialize)]
pub struct SynthesizeResult {
    pub audio_base64: String,
    pub mime: String,
    pub word_boundaries: Vec<WordBoundary>,
    /// True when served from the disk cache (no network involved).
    pub cached: bool,
}

/// Result of a bulk offline-download (`cache_segments`).
#[derive(Serialize)]
pub struct CacheReport {
    /// Total bytes on disk for the segments.
    pub bytes: u64,
    /// Non-empty segments cached.
    pub segments: u32,
    /// How many needed fresh synthesis (rest were cached).
    pub synthesized: u32,
}

/// Edge metadata offsets/durations are in 100-nanosecond ticks.
const TICKS_PER_MS: u64 = 10_000;

/// parallel websockets per bulk download; each worker reuses its connection
/// across segments, since the handshake costs more than the synthesis.
const DOWNLOAD_WORKERS: usize = 4;

#[tauri::command]
pub async fn list_voices() -> Result<Vec<VoiceInfo>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let voices = get_voices_list().map_err(|e| e.to_string())?;
        Ok(voices
            .into_iter()
            .map(|v| VoiceInfo {
                short_name: v.short_name.clone().unwrap_or_else(|| v.name.clone()),
                locale: v.locale.clone().unwrap_or_default(),
                gender: v.gender.clone().unwrap_or_default(),
                friendly_name: v.friendly_name.clone().unwrap_or_default(),
                name: v.name,
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Synthesize one text segment (disk-cache first).
///
/// `rate`/`pitch` are percent/Hz offsets from the voice default (0 = normal);
/// e.g. rate 50 = 1.5x speed.
#[tauri::command]
pub async fn synthesize(
    app: tauri::AppHandle,
    text: String,
    voice: String,
    rate: i32,
    pitch: i32,
) -> Result<SynthesizeResult, String> {
    let dirs = TtsDirs::new(&app)?;

    tauri::async_runtime::spawn_blocking(move || {
        let (audio_bytes, word_boundaries, cached) =
            synth_and_cache(&dirs, &voice, rate, pitch, &text)?;
        Ok(SynthesizeResult {
            audio_base64: base64::engine::general_purpose::STANDARD.encode(&audio_bytes),
            mime: "audio/mpeg".to_string(),
            word_boundaries,
            cached,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Pre-synthesize a chapter's segments into the downloads dir `synthesize`
/// reads from, so they play back offline. Segments arrive already
/// dictionary-transformed and speakable-filtered, so keys match playback.
/// Pinned to voice/rate/pitch.
///
/// runs DOWNLOAD_WORKERS websockets over a shared queue, aborting the batch on
/// the first failure.
#[tauri::command]
pub async fn cache_segments(
    app: tauri::AppHandle,
    segments: Vec<String>,
    voice: String,
    rate: i32,
    pitch: i32,
) -> Result<CacheReport, String> {
    let dirs = TtsDirs::new(&app)?;

    tauri::async_runtime::spawn_blocking(move || {
        let next = AtomicUsize::new(0);
        let bytes = AtomicU64::new(0);
        let segments_cached = AtomicU32::new(0);
        let synthesized = AtomicU32::new(0);
        let failure: Mutex<Option<String>> = Mutex::new(None);
        let config = speech_config(&voice, rate, pitch);

        let workers = DOWNLOAD_WORKERS.min(segments.len().max(1));
        std::thread::scope(|scope| {
            for _ in 0..workers {
                scope.spawn(|| {
                    let mut client: Option<MSEdgeTTSClient<TcpStream>> = None;
                    loop {
                        if failure.lock().unwrap().is_some() {
                            return;
                        }
                        let Some(text) = segments.get(next.fetch_add(1, Ordering::Relaxed)) else {
                            return;
                        };
                        if text.trim().is_empty() {
                            continue;
                        }
                        match cache_one(&dirs, &mut client, &config, text) {
                            Ok((len, cached)) => {
                                bytes.fetch_add(len as u64, Ordering::Relaxed);
                                segments_cached.fetch_add(1, Ordering::Relaxed);
                                if !cached {
                                    synthesized.fetch_add(1, Ordering::Relaxed);
                                }
                            }
                            Err(e) => {
                                *failure.lock().unwrap() = Some(e);
                                return;
                            }
                        }
                    }
                });
            }
        });

        if let Some(e) = failure.into_inner().unwrap() {
            return Err(e);
        }
        Ok(CacheReport {
            bytes: bytes.into_inner(),
            segments: segments_cached.into_inner(),
            synthesized: synthesized.into_inner(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Where synthesized audio lives. Downloads go to app data, which the OS never
/// clears; audio made while listening goes to the cache dir, which Android may
/// wipe when storage runs low.
struct TtsDirs {
    downloads: PathBuf,
    cache: PathBuf,
}

impl TtsDirs {
    fn new(app: &tauri::AppHandle) -> Result<Self, String> {
        let path = app.path();
        Ok(Self {
            downloads: path.app_data_dir().map_err(|e| e.to_string())?.join("tts"),
            cache: path.app_cache_dir().map_err(|e| e.to_string())?.join("tts"),
        })
    }
}

/// Downloads used to share the cache dir. Move those files over once (the
/// downloads dir not existing yet marks a pre-split install) so existing
/// downloads stop being evictable; this also keeps audio that was only
/// listened to, which clearing the audio cache still removes.
pub fn adopt_legacy_downloads(app: &tauri::AppHandle) {
    let Ok(dirs) = TtsDirs::new(app) else { return };
    if dirs.downloads.exists() {
        return;
    }
    let Ok(entries) = fs::read_dir(&dirs.cache) else { return };
    if fs::create_dir_all(&dirs.downloads).is_err() {
        return;
    }
    for entry in entries.flatten() {
        let to = dirs.downloads.join(entry.file_name());
        if fs::rename(entry.path(), &to).is_err() && fs::copy(entry.path(), &to).is_ok() {
            let _ = fs::remove_file(entry.path());
        }
    }
}

fn key_paths(dir: &Path, key: &str) -> (PathBuf, PathBuf) {
    (dir.join(format!("{key}.mp3")), dir.join(format!("{key}.json")))
}

fn read_cached(dir: &Path, key: &str) -> Option<(Vec<u8>, Vec<WordBoundary>)> {
    let (mp3, meta) = key_paths(dir, key);
    read_cache_raw(&mp3, &meta)
}

/// Move a segment already heard while listening into the downloads dir, so a
/// download doesn't synthesize it again. Returns its size.
fn promote(dirs: &TtsDirs, key: &str) -> Option<usize> {
    let (bytes, _wb) = read_cached(&dirs.cache, key)?;
    let (from_mp3, from_meta) = key_paths(&dirs.cache, key);
    let (to_mp3, to_meta) = key_paths(&dirs.downloads, key);
    fs::create_dir_all(&dirs.downloads).ok()?;
    for (from, to) in [(&from_meta, &to_meta), (&from_mp3, &to_mp3)] {
        if fs::rename(from, to).is_err() {
            fs::copy(from, to).ok()?;
            let _ = fs::remove_file(from);
        }
    }
    Some(bytes.len())
}

/// cache one segment on a worker's pooled connection, returning its size and
/// whether it was already on disk. one reconnect covers a socket the server
/// dropped while the worker was busy elsewhere.
fn cache_one(
    dirs: &TtsDirs,
    client: &mut Option<MSEdgeTTSClient<TcpStream>>,
    config: &SpeechConfig,
    text: &str,
) -> Result<(usize, bool), String> {
    let key = cache_key(&config.voice_name, config.rate, config.pitch, text);
    if let Some((bytes, _wb)) = read_cached(&dirs.downloads, &key) {
        return Ok((bytes.len(), true));
    }
    if let Some(len) = promote(dirs, &key) {
        return Ok((len, true));
    }

    let mut last_err = String::from("synthesis failed");
    for _ in 0..2 {
        if client.is_none() {
            match connect() {
                Ok(c) => *client = Some(c),
                Err(e) => {
                    last_err = e.to_string();
                    continue;
                }
            }
        }
        match client.as_mut().unwrap().synthesize(text, config) {
            Ok(audio) => {
                let len = audio.audio_bytes.len();
                write_cache(&dirs.downloads, &key, &audio);
                return Ok((len, false));
            }
            Err(e) => {
                last_err = e.to_string();
                *client = None; // a failed exchange leaves the socket unusable
            }
        }
    }
    Err(last_err)
}

/// One segment's MP3 + word boundaries, synthesizing on a miss. The playback
/// path (`synthesize`); the bool is true on a disk hit.
fn synth_and_cache(
    dirs: &TtsDirs,
    voice: &str,
    rate: i32,
    pitch: i32,
    text: &str,
) -> Result<(Vec<u8>, Vec<WordBoundary>, bool), String> {
    let key = cache_key(voice, rate, pitch, text);
    for dir in [&dirs.downloads, &dirs.cache] {
        if let Some((bytes, wb)) = read_cached(dir, &key) {
            return Ok((bytes, wb, true));
        }
    }

    let audio = synth_live(&speech_config(voice, rate, pitch), text)?;
    write_cache(&dirs.cache, &key, &audio);
    let wb = word_boundaries(&audio);
    Ok((audio.audio_bytes, wb, false))
}

/// Idle websockets for live playback, reused because the handshake costs more
/// than a paragraph's synthesis. The socket's read timeout isn't reachable, and
/// a silently dead one (network switch) can block for minutes, so only
/// recently used ones are handed out again.
static LIVE_POOL: Mutex<Vec<(MSEdgeTTSClient<TcpStream>, Instant)>> = Mutex::new(Vec::new());
const LIVE_IDLE_MAX: Duration = Duration::from_secs(30);
// playback plus its one-ahead prefetch
const LIVE_POOL_MAX: usize = 2;

fn synth_live(config: &SpeechConfig, text: &str) -> Result<SynthesizedAudio, String> {
    let pooled = {
        let mut pool = LIVE_POOL.lock().unwrap();
        pool.retain(|(_, used)| used.elapsed() < LIVE_IDLE_MAX);
        pool.pop().map(|(client, _)| client)
    };
    if let Some(mut client) = pooled {
        if let Ok(audio) = client.synthesize(text, config) {
            return_live(client);
            return Ok(audio);
        }
        // server closed it while idle; fall through to a fresh connection
    }
    let mut client = connect().map_err(|e| e.to_string())?;
    let audio = client.synthesize(text, config).map_err(|e| e.to_string())?;
    return_live(client);
    Ok(audio)
}

fn return_live(client: MSEdgeTTSClient<TcpStream>) {
    let mut pool = LIVE_POOL.lock().unwrap();
    if pool.len() < LIVE_POOL_MAX {
        pool.push((client, Instant::now()));
    }
}

/// Settings' "Test Edge voice": one uncached synthesis on a fresh connection,
/// so the error text shows exactly what the service says. Returns elapsed ms.
#[tauri::command]
pub async fn test_edge_tts() -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let start = Instant::now();
        let config = speech_config(
            "Microsoft Server Speech Text to Speech Voice (en-US, AriaNeural)",
            0,
            0,
        );
        let mut client = connect().map_err(|e| e.to_string())?;
        let audio = client
            .synthesize("Edge voice test.", &config)
            .map_err(|e| e.to_string())?;
        if audio.audio_bytes.is_empty() {
            return Err("connected, but no audio came back".to_string());
        }
        Ok(start.elapsed().as_millis() as u64)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn speech_config(voice: &str, rate: i32, pitch: i32) -> SpeechConfig {
    SpeechConfig {
        voice_name: voice.to_string(),
        audio_format: "audio-24khz-48kbitrate-mono-mp3".to_string(),
        pitch,
        rate,
        volume: 0,
    }
}

fn word_boundaries(audio: &SynthesizedAudio) -> Vec<WordBoundary> {
    audio
        .audio_metadata
        .iter()
        .filter(|m| m.metadata_type.as_deref() == Some("WordBoundary"))
        .map(|m| WordBoundary {
            text: m.text.clone().unwrap_or_default(),
            offset_ms: m.offset / TICKS_PER_MS,
            duration_ms: m.duration / TICKS_PER_MS,
        })
        .collect()
}

/// Best-effort cache write; playback must not fail on disk errors.
fn write_cache(dir: &Path, key: &str, audio: &SynthesizedAudio) {
    if audio.audio_bytes.is_empty() {
        return;
    }
    let (mp3, meta) = key_paths(dir, key);
    let _ = fs::create_dir_all(dir);
    let _ = fs::write(mp3, &audio.audio_bytes);
    if let Ok(json) = serde_json::to_vec(&word_boundaries(audio)) {
        let _ = fs::write(meta, json);
    }
}

/// Delete all TTS audio, downloaded and cached; returns the number of files
/// removed.
#[tauri::command]
pub async fn clear_tts_cache(app: tauri::AppHandle) -> Result<u32, String> {
    let dirs = TtsDirs::new(&app)?;

    tauri::async_runtime::spawn_blocking(move || {
        let mut removed = 0;
        for dir in [&dirs.downloads, &dirs.cache] {
            if let Ok(entries) = fs::read_dir(dir) {
                for entry in entries.flatten() {
                    if fs::remove_file(entry.path()).is_ok() {
                        removed += 1;
                    }
                }
            }
        }
        Ok(removed)
    })
    .await
    .map_err(|e| e.to_string())?
}

// Live smoke test (network): `cargo test tts_cache -- --nocapture`
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tts_cache_roundtrip() {
        // run() installs this; without it the synthesis websocket panics.
        let _ = rustls::crypto::ring::default_provider().install_default();

        let dir = std::env::temp_dir().join(format!("tts_test_{}", std::process::id()));
        let dirs = test_dirs(&dir);
        let voice = "Microsoft Server Speech Text to Speech Voice (en-US, AriaNeural)";
        let text = "Offline download smoke test.";

        // First call synthesizes over the network and writes to disk.
        let (bytes1, wb1, cached1) = synth_and_cache(&dirs, voice, 0, 0, text).expect("synth");
        assert!(!cached1, "first call should not be a cache hit");
        assert!(!bytes1.is_empty(), "audio should be non-empty");
        assert!(!wb1.is_empty(), "should have word boundaries");

        // Second call must be served from disk with identical audio.
        let (bytes2, _wb2, cached2) = synth_and_cache(&dirs, voice, 0, 0, text).expect("cached");
        assert!(cached2, "second call should hit the disk cache");
        assert_eq!(bytes1, bytes2, "cached audio should match");

        // Downloading a segment already heard moves it out of the cache dir
        // instead of synthesizing it again.
        let mut client = None;
        let config = speech_config(voice, 0, 0);
        let (len, cached3) = cache_one(&dirs, &mut client, &config, text).expect("promote");
        assert!(cached3 && len == bytes1.len(), "should promote, not synthesize");
        assert!(client.is_none(), "promotion should not connect");
        let key = cache_key(voice, 0, 0, text);
        assert!(read_cached(&dirs.downloads, &key).is_some(), "now in downloads");
        assert!(read_cached(&dirs.cache, &key).is_none(), "gone from cache");

        let _ = fs::remove_dir_all(&dir);
        println!("tts cache ok: {} bytes, cached on replay", bytes1.len());
    }

    fn test_dirs(dir: &Path) -> TtsDirs {
        TtsDirs {
            downloads: dir.join("downloads"),
            cache: dir.join("cache"),
        }
    }

    // live playback: back-to-back segments reuse one pooled websocket.
    #[test]
    fn live_pool_reuses_connection() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let config = speech_config(
            "Microsoft Server Speech Text to Speech Voice (en-US, AriaNeural)",
            0,
            0,
        );
        let t = Instant::now();
        synth_live(&config, "First live paragraph.").expect("first");
        let cold = t.elapsed();
        // other tests share the pool when run in parallel, so no exact counts
        assert!(!LIVE_POOL.lock().unwrap().is_empty(), "socket kept for reuse");
        let t = Instant::now();
        synth_live(&config, "Second live paragraph.").expect("second");
        let warm = t.elapsed();
        assert!(LIVE_POOL.lock().unwrap().len() <= LIVE_POOL_MAX, "pool stays bounded");
        println!("live pool ok: cold {cold:?}, warm {warm:?}");
    }

    // bulk-download path: one websocket serving several segments in a row.
    #[test]
    fn pooled_client_synthesizes_several_segments() {
        let _ = rustls::crypto::ring::default_provider().install_default();

        let dir = std::env::temp_dir().join(format!("tts_pool_test_{}", std::process::id()));
        let dirs = test_dirs(&dir);
        let config = speech_config(
            "Microsoft Server Speech Text to Speech Voice (en-US, AriaNeural)",
            0,
            0,
        );
        let texts = [
            "First paragraph of the pooled download test.",
            "Second paragraph, same connection.",
            "Third paragraph, still the same connection.",
        ];

        let mut client = None;
        for text in texts {
            let (len, cached) = cache_one(&dirs, &mut client, &config, text).expect("synth");
            assert!(!cached, "first pass should synthesize");
            assert!(len > 0, "audio should be non-empty");
        }
        assert!(client.is_some(), "connection should be kept open for reuse");

        let (_len, cached) = cache_one(&dirs, &mut client, &config, texts[1]).expect("cached");
        assert!(cached, "second pass should hit the disk cache");

        let _ = fs::remove_dir_all(&dir);
        println!(
            "pooled client ok: {} segments over one websocket",
            texts.len()
        );
    }
}

fn cache_key(voice: &str, rate: i32, pitch: i32, text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("{voice}|{rate}|{pitch}|{text}"));
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// MP3 bytes + word boundaries for a key, or None if missing/empty.
fn read_cache_raw(mp3_path: &Path, meta_path: &Path) -> Option<(Vec<u8>, Vec<WordBoundary>)> {
    let bytes = fs::read(mp3_path).ok()?;
    if bytes.is_empty() {
        return None;
    }
    let word_boundaries: Vec<WordBoundary> =
        serde_json::from_slice(&fs::read(meta_path).ok()?).ok()?;
    Some((bytes, word_boundaries))
}
