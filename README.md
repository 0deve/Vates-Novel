# Vates Novel

A web-novel reader for **desktop (Windows/Linux/macOS)** and **Android**, built
from one codebase with [Tauri v2](https://v2.tauri.app/), [React](https://reactjs.org/),
[TypeScript](https://www.typescriptlang.org/), and [Vite](https://vitejs.dev/).

## Features

- Library with collections, search, sorting, reading progress, and update
  checks manual or automatic on launch
- Browse and download novels from sources; download everything or just the
  next 25/50/100 chapters from your reading position, with retry/backoff
  (and a progress notification on Android)
- Seamless reader: infinite chapter scroll, exact position tracking, a
  slide-in chapter list for jumping around, adjustable
  font/size/spacing/width/color
- Text-to-speech with word-level highlighting:
  - **Edge voices** (online) — high quality, cached on disk for offline re-listening
  - **Device / system voices** (offline) — the Android TTS engine or the
    desktop's built-in voices, so reading works with no connection
- Android: media notification with lock-screen controls, background playback
  and downloads with the screen off, slide-in navigation, hardware back support
- Import local `.epub`/`.txt` files, export novels to EPUB/TXT, full library
  backup/restore as JSON
- Pronunciation dictionary (global and per-novel find/replace before speech)

## Prerequisites

- [Node.js](https://nodejs.org/)
- [Rust](https://www.rust-lang.org/) and the Tauri prerequisites
  (see [Tauri documentation](https://v2.tauri.app/start/prerequisites/))

For Android builds additionally:

- Android Studio with the SDK and **NDK (Side by side)** installed
- JDK 17+ (Android Studio's bundled one works; `gradle.properties` pins its path)
- Rust Android targets:
  `rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`
- `ANDROID_HOME` and `NDK_HOME` environment variables set

## Run

```bash
npm install

# Desktop (dev / release build)
npm run tauri dev
npm run tauri build

# Android (dev on a connected device or emulator / release build)
npm run tauri android dev
npm run tauri android build
```

## Notes

- The Android project under `src-tauri/gen/android/` contains hand-maintained
  pieces (TLS init for the TTS websocket, system-TTS and notification bridges,
  foreground services) on top of the generated Tauri scaffolding.
