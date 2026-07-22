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
use msedge_tts::tts::client::connect;
use msedge_tts::tts::SpeechConfig;
use msedge_tts::voice::get_voices_list;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;
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
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map(|d| d.join("tts"))
        .map_err(|e| e.to_string())?;

    tauri::async_runtime::spawn_blocking(move || {
        let (audio_bytes, word_boundaries, cached) =
            synth_and_cache(&cache_dir, &voice, rate, pitch, &text)?;
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

/// Pre-synthesize a chapter's segments into the cache `synthesize` reads from,
/// so they play back offline. Segments arrive already dictionary-transformed
/// and speakable-filtered, so keys match playback. Pinned to voice/rate/pitch.
#[tauri::command]
pub async fn cache_segments(
    app: tauri::AppHandle,
    segments: Vec<String>,
    voice: String,
    rate: i32,
    pitch: i32,
) -> Result<CacheReport, String> {
    let cache_dir = app
        .path()
        .app_cache_dir()
        .map(|d| d.join("tts"))
        .map_err(|e| e.to_string())?;

    tauri::async_runtime::spawn_blocking(move || {
        let mut bytes = 0u64;
        let mut segments_cached = 0u32;
        let mut synthesized = 0u32;
        for text in &segments {
            if text.trim().is_empty() {
                continue;
            }
            let (audio, _wb, cached) = synth_and_cache(&cache_dir, &voice, rate, pitch, text)?;
            bytes += audio.len() as u64;
            segments_cached += 1;
            if !cached {
                synthesized += 1;
            }
        }
        Ok(CacheReport {
            bytes,
            segments: segments_cached,
            synthesized,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// One segment's MP3 + word boundaries, synthesizing on a cache miss. Shared by
/// `synthesize` and `cache_segments`; the bool is true on a disk hit.
fn synth_and_cache(
    cache_dir: &Path,
    voice: &str,
    rate: i32,
    pitch: i32,
    text: &str,
) -> Result<(Vec<u8>, Vec<WordBoundary>, bool), String> {
    let key = cache_key(voice, rate, pitch, text);
    let mp3_path = cache_dir.join(format!("{key}.mp3"));
    let meta_path = cache_dir.join(format!("{key}.json"));

    if let Some((bytes, wb)) = read_cache_raw(&mp3_path, &meta_path) {
        return Ok((bytes, wb, true));
    }

    let config = SpeechConfig {
        voice_name: voice.to_string(),
        audio_format: "audio-24khz-48kbitrate-mono-mp3".to_string(),
        pitch,
        rate,
        volume: 0,
    };
    let mut client = connect().map_err(|e| e.to_string())?;
    let audio = client.synthesize(text, &config).map_err(|e| e.to_string())?;

    let word_boundaries: Vec<WordBoundary> = audio
        .audio_metadata
        .iter()
        .filter(|m| m.metadata_type.as_deref() == Some("WordBoundary"))
        .map(|m| WordBoundary {
            text: m.text.clone().unwrap_or_default(),
            offset_ms: m.offset / TICKS_PER_MS,
            duration_ms: m.duration / TICKS_PER_MS,
        })
        .collect();

    // Best-effort cache write; playback must not fail on disk errors.
    if !audio.audio_bytes.is_empty() {
        let _ = fs::create_dir_all(cache_dir);
        let _ = fs::write(&mp3_path, &audio.audio_bytes);
        if let Ok(json) = serde_json::to_vec(&word_boundaries) {
            let _ = fs::write(&meta_path, json);
        }
    }

    Ok((audio.audio_bytes, word_boundaries, false))
}

/// Delete all cached TTS audio; returns the number of files removed.
#[tauri::command]
pub async fn clear_tts_cache(app: tauri::AppHandle) -> Result<u32, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map(|d| d.join("tts"))
        .map_err(|e| e.to_string())?;

    tauri::async_runtime::spawn_blocking(move || {
        let mut removed = 0;
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                if fs::remove_file(entry.path()).is_ok() {
                    removed += 1;
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
        let voice = "Microsoft Server Speech Text to Speech Voice (en-US, AriaNeural)";
        let text = "Offline download smoke test.";

        // First call synthesizes over the network and writes to disk.
        let (bytes1, wb1, cached1) = synth_and_cache(&dir, voice, 0, 0, text).expect("synth");
        assert!(!cached1, "first call should not be a cache hit");
        assert!(!bytes1.is_empty(), "audio should be non-empty");
        assert!(!wb1.is_empty(), "should have word boundaries");

        // Second call must be served from disk with identical audio.
        let (bytes2, _wb2, cached2) = synth_and_cache(&dir, voice, 0, 0, text).expect("cached");
        assert!(cached2, "second call should hit the disk cache");
        assert_eq!(bytes1, bytes2, "cached audio should match");

        let _ = fs::remove_dir_all(&dir);
        println!("tts cache ok: {} bytes, cached on replay", bytes1.len());
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
