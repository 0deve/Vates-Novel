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
use std::path::PathBuf;
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
        let key = cache_key(&voice, rate, pitch, &text);
        let mp3_path = cache_dir.join(format!("{key}.mp3"));
        let meta_path = cache_dir.join(format!("{key}.json"));

        if let Some(hit) = read_cache(&mp3_path, &meta_path) {
            return Ok(hit);
        }

        let config = SpeechConfig {
            voice_name: voice,
            audio_format: "audio-24khz-48kbitrate-mono-mp3".to_string(),
            pitch,
            rate,
            volume: 0,
        };
        let mut client = connect().map_err(|e| e.to_string())?;
        let audio = client
            .synthesize(&text, &config)
            .map_err(|e| e.to_string())?;

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
            let _ = fs::create_dir_all(&cache_dir);
            let _ = fs::write(&mp3_path, &audio.audio_bytes);
            if let Ok(json) = serde_json::to_vec(&word_boundaries) {
                let _ = fs::write(&meta_path, json);
            }
        }

        Ok(SynthesizeResult {
            audio_base64: base64::engine::general_purpose::STANDARD.encode(&audio.audio_bytes),
            mime: "audio/mpeg".to_string(),
            word_boundaries,
            cached: false,
        })
    })
    .await
    .map_err(|e| e.to_string())?
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

fn cache_key(voice: &str, rate: i32, pitch: i32, text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(format!("{voice}|{rate}|{pitch}|{text}"));
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn read_cache(mp3_path: &PathBuf, meta_path: &PathBuf) -> Option<SynthesizeResult> {
    let bytes = fs::read(mp3_path).ok()?;
    let word_boundaries: Vec<WordBoundary> =
        serde_json::from_slice(&fs::read(meta_path).ok()?).ok()?;
    if bytes.is_empty() {
        return None;
    }
    Some(SynthesizeResult {
        audio_base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        mime: "audio/mpeg".to_string(),
        word_boundaries,
        cached: true,
    })
}
