//! OS media session integration (implementation.md §6): SMTC on Windows,
//! MPRIS on Linux, via `souvlaki`. Hardware/headset media keys and the OS
//! media overlay control playback; events are forwarded to the frontend as
//! `media-control` events.

use souvlaki::{
    MediaControlEvent, MediaControls, MediaMetadata, MediaPlayback, PlatformConfig,
};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

pub struct MediaState(pub Mutex<Option<MediaControls>>);

pub fn init(app: &AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    let hwnd = {
        let window = app
            .get_webview_window("main")
            .ok_or("main window not found")?;
        Some(window.hwnd().map_err(|e| e.to_string())?.0 as *mut std::ffi::c_void)
    };
    #[cfg(not(windows))]
    let hwnd = None;

    let config = PlatformConfig {
        dbus_name: "vates_novel",
        display_name: "Vates Novel",
        hwnd,
    };
    let mut controls = MediaControls::new(config).map_err(|e| format!("{e:?}"))?;

    let handle = app.clone();
    controls
        .attach(move |event: MediaControlEvent| {
            let action = match event {
                MediaControlEvent::Play => "play",
                MediaControlEvent::Pause => "pause",
                MediaControlEvent::Toggle => "toggle",
                MediaControlEvent::Next => "next",
                MediaControlEvent::Previous => "prev",
                MediaControlEvent::Stop => "stop",
                _ => return,
            };
            let _ = handle.emit("media-control", action);
        })
        .map_err(|e| format!("{e:?}"))?;

    app.state::<MediaState>().0.lock().unwrap().replace(controls);
    Ok(())
}

/// Update the OS media overlay with what's playing.
#[tauri::command]
pub fn media_update(
    state: State<'_, MediaState>,
    title: String,
    artist: String,
    playing: bool,
) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(controls) = guard.as_mut() {
        let _ = controls.set_metadata(MediaMetadata {
            title: Some(&title),
            artist: Some(&artist),
            ..Default::default()
        });
        let _ = controls.set_playback(if playing {
            MediaPlayback::Playing { progress: None }
        } else {
            MediaPlayback::Paused { progress: None }
        });
    }
    Ok(())
}
