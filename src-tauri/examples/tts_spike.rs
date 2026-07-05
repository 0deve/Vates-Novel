//! Headless Phase 0 smoke test: proves Edge TTS synthesis + WordBoundary
//! metadata work end-to-end without the GUI.
//!
//! Run: cargo run --example tts_spike

use msedge_tts::tts::client::connect;
use msedge_tts::tts::SpeechConfig;
use msedge_tts::voice::get_voices_list;

fn main() {
    println!("[1/3] Fetching voice list…");
    let voices = get_voices_list().expect("failed to fetch voices");
    println!("      {} voices available", voices.len());

    let aria = voices
        .iter()
        .find(|v| v.short_name.as_deref() == Some("en-US-AriaNeural"))
        .expect("en-US-AriaNeural not found");
    println!("      picked {}", aria.short_name.as_deref().unwrap());

    println!("[2/3] Synthesizing…");
    let config = SpeechConfig {
        voice_name: aria.name.clone(),
        audio_format: "audio-24khz-48kbitrate-mono-mp3".to_string(),
        pitch: 0,
        rate: 0,
        volume: 0,
    };
    let mut client = connect().expect("websocket connect failed");
    let audio = client
        .synthesize(
            "The awakening had finally begun. Lin Feng opened his eyes.",
            &config,
        )
        .expect("synthesis failed");

    println!("[3/3] Results:");
    println!("      audio bytes: {}", audio.audio_bytes.len());
    let boundaries: Vec<_> = audio
        .audio_metadata
        .iter()
        .filter(|m| m.metadata_type.as_deref() == Some("WordBoundary"))
        .collect();
    println!("      word boundaries: {}", boundaries.len());
    for b in boundaries.iter().take(5) {
        println!(
            "        {:>6}ms +{:>4}ms  {:?}",
            b.offset / 10_000,
            b.duration / 10_000,
            b.text.as_deref().unwrap_or("")
        );
    }

    assert!(!audio.audio_bytes.is_empty(), "no audio returned");
    assert!(!boundaries.is_empty(), "no word boundaries returned");
    println!("\nPHASE 0 TTS SPIKE: PASS");
}
