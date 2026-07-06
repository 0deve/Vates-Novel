# Compiling Vates Novel to Android via Tauri Mobile

## Context

The existing Kotlin prototype (`androidapp/`) shares almost nothing with the
desktop app under the hood (different TTS backend — a self-hosted AllTalk
HTTP server instead of Edge TTS — different DB layer, different scraper), so
bringing it to parity would mean rewriting nearly everything anyway. Since
the desktop app is already Tauri 2, and Tauri 2 has a real Android build
target, the better path is to compile the *existing* Rust + React codebase
for Android directly: one codebase, the same reading-position tracking,
download manager, scraper, TTS engine, and DB schema, instead of two apps
drifting apart.

The risk areas below were checked against the actual `Cargo.toml` of
`msedge-tts` and `souvlaki` in the local registry cache rather than assumed.

## Verified facts driving this plan

- **`msedge-tts`'s `blocking` feature (what we use) already depends on
  `rustls`, not OpenSSL/native-tls.** No cross-compilation blocker there.
- **Our own `reqwest` dependency currently has no explicit TLS feature**,
  so it pulls reqwest's crate default (`default-tls` → native-tls → OpenSSL
  on Android). This needs to switch to `rustls-tls` to avoid a painful
  OpenSSL-for-Android cross-compile.
- **`souvlaki` has no *functional* Android support, but it does compile
  there.** (Corrected 2026-07-06 against souvlaki 0.8.3's actual sources:
  `src/platform/mod.rs` has an `empty` fallback backend whose cfg matches
  Android, with every native dependency — dbus, windows, cocoa — target-gated
  away from Android.) `MediaControls::new/attach/set_metadata/set_playback`
  all exist as no-ops, so `media.rs` needs **no cfg-gating at all**; it
  compiles as-is and `media_update` is naturally inert on Android. A real
  Android media-session integration is separate, later work (Phase 5).
- **`lib.rs`'s `run()` is missing `#[cfg_attr(mobile, tauri::mobile_entry_point)]`**
  — required for the Android build to find the app's entry point (the
  project was scaffolded desktop-only by hand). The `crate-type` list
  already includes `staticlib`/`cdylib`, so that part is done.
- **`msedge-tts`'s TLS stack uses `rustls-platform-verifier`**, which on
  Android verifies certs through the OS trust store via JNI and needs
  platform initialization. This may make the TTS websocket connection fail
  on-device even though it cross-compiles fine — check explicitly during the
  Phase 0 spike. (Our own `reqwest` with `rustls-tls` uses compiled-in
  webpki roots and is unaffected.)
- **Android's file picker (Storage Access Framework) returns `content://`
  URIs, not real filesystem paths.** Our current `import_local_novel`,
  `export_novel`, `write_text_file`, `read_text_file` (`src-tauri/src/{import,export,lib}.rs`)
  call `std::fs::read`/`std::fs::write`/`zip::ZipArchive::new(File::open(path))`
  directly on a path string handed over from the dialog plugin. That works on
  Windows/Linux/macOS but cannot work on Android, since plain Rust `std::fs`
  has no access to Android's `ContentResolver`. These commands need to switch
  to byte-based I/O (frontend reads/writes bytes via `@tauri-apps/plugin-fs`,
  which *does* handle `content://` URIs on Android; Rust operates on
  `Vec<u8>`/`Cursor` instead of a path). This change is worth making
  uniformly (desktop included) rather than forking the logic per platform.
- **The biggest genuine unknown is background audio.** Android suspends
  webview JS/audio when the app is backgrounded unless a foreground service
  + notification keeps it alive (the same pattern the old Kotlin app already
  uses for downloads via `WorkManager`/`DownloadWorker`). This needs a small
  custom Android plugin and is scoped as its own phase — it should not block
  shipping a foreground-only v1.

## What does NOT need to change

Everything that's pure business logic keeps working unmodified: the
reading-position tracking (`ReaderPage.tsx`'s scroll/TTS confirm rules), the
download manager (`lib/downloads.ts`), chapter pagination, Settings,
pronunciation dictionary, Statistics queries, the private scraper
(`private/source1/mod.rs` — same `build.rs` detection pattern, same
`reqwest`/`scraper` calls, no OS dependency), the stub source, and the SQL
schema/migrations. This is the majority of the app.

## Prerequisites

- Android Studio (provides the SDK + emulator/AVD manager)
- Android NDK (installable via Android Studio's SDK Manager)
- A JDK (17+; Android Studio bundles one)
- Rust Android targets: `rustup target add aarch64-linux-android armv7-linux-androideabi i686-linux-android x86_64-linux-android`
- `ANDROID_HOME` / `NDK_HOME` environment variables set (Tauri's CLI checks for these)
- `@tauri-apps/cli` already present (`npm run tauri`) — mobile subcommands
  (`tauri android init`, `tauri android dev`, `tauri android build`) come
  from the same CLI, no separate install

### Environment status on this machine (checked 2026-07-06)

- Rust Android targets: **all four installed** ✓
- Android SDK at `C:\Users\stefa\AppData\Local\Android\Sdk` with
  platforms 35/36/36.1, platform-tools, emulator, system-images ✓
- JDK 17+: Android Studio's bundled JBR is JDK 21 at
  `C:\Program Files\Android\Android Studio\jbr` ✓ (but `JAVA_HOME`
  currently points at Corretto JDK 1.8 — the build needs it pointed at
  the JBR instead)
- Android NDK: **not installed** — install via Android Studio → SDK
  Manager → SDK Tools → "NDK (Side by side)", it lands in
  `%LOCALAPPDATA%\Android\Sdk\ndk\<version>`
- `ANDROID_HOME` / `NDK_HOME`: **not set** — after the NDK install:
  `ANDROID_HOME = %LOCALAPPDATA%\Android\Sdk`,
  `NDK_HOME = %LOCALAPPDATA%\Android\Sdk\ndk\<version>`

## Phase 0 — Spike: get the unmodified app running on Android at all

Goal: validate the core premise before investing further, matching this
project's existing "verify risky assumptions first" methodology (the TTS
and source spikes at project start).

- Run `npm run tauri android init` to scaffold `src-tauri/gen/android/`
  (an Android Studio project: `AndroidManifest.xml`, `MainActivity.kt`,
  `build.gradle`, generated mipmap icons from the existing `icons/` set).
  This is generated, not hand-authored.
- `npm run tauri android dev` against an emulator (AVD) or a physical device
  over USB. Confirm: the React UI renders, `tauri-plugin-sql` opens the
  SQLite DB and migrations run, the stub source and Browse/search work
  (plain `reqwest` calls), and the Reader renders a downloaded chapter with
  TTS playback while the app is in the foreground.
- Specifically test TTS synthesis on-device: `msedge-tts`'s
  `rustls-platform-verifier` panics on Android without JNI initialization
  against the system trust store. **Confirmed on-device and fixed
  (2026-07-06):** the generated `MainActivity.onCreate` calls a JNI export
  in `lib.rs` (`initTlsVerifier`) that initializes both semver-distinct
  copies in the graph (0.7 for the synthesis websocket, 0.6 via ureq for
  voice listing), and `gen/android/app/build.gradle.kts` packages the
  crate-shipped Kotlin AAR (`rustls:rustls-platform-verifier`), located via
  `cargo metadata` so it tracks Cargo.lock. Note: `ndk-context` is NOT an
  option here — Tauri/wry never initialize it (first attempt crashed on
  startup); the Kotlin-side call is the race-free path.
- **rustls crypto provider must be pinned at startup** (found on-device
  2026-07-06, affects desktop too): switching reqwest to `rustls-tls`
  feature-enabled `ring` while msedge-tts's rustls pulls `aws-lc-rs`; with
  both present, rustls panics at the first TLS connect instead of picking
  one. Fixed by `rustls::crypto::ring::default_provider().install_default()`
  at the top of `run()`.
- If `tauri-plugin-dialog`'s Android file picker or `tauri-plugin-sql`
  surface unexpected mobile-specific issues, resolve those here before
  moving on — they're foundational to later phases.

## Phase 1 — Cargo/toolchain changes for Android compilation

- `src-tauri/Cargo.toml`: switch `reqwest` to
  `{ version = "0.12", default-features = false, features = ["blocking", "gzip", "cookies", "json", "rustls-tls"] }`
  to drop the native-tls/OpenSSL dependency entirely.
- If the `zip` crate's default features (`bzip2`, `lzma`/`xz`, `aes-crypto` —
  all native-C-library bindings) cause NDK cross-compilation trouble, trim
  to `zip = { version = "2", default-features = false, features = ["deflate"] }`
  (the only compression method our own import/export code actually produces
  or expects to read).
- Re-run `cargo check --target aarch64-linux-android` (via the Tauri mobile
  build, which sets up the NDK toolchain/linker automatically) to confirm a
  clean cross-compile before touching app code.

## Phase 2 — Gate out desktop-only OS integration on Android

- `src-tauri/src/media.rs`: **no change needed** — souvlaki's `empty`
  backend already makes every call a compile-clean no-op on Android (see
  corrected Verified facts above).
- `src-tauri/src/lib.rs`: add `#[cfg_attr(mobile, tauri::mobile_entry_point)]`
  to `run()`.
- `src-tauri/src/lib.rs`'s `open_data_folder`: Android has no equivalent
  concept of "reveal in file manager." Gate the command to return a clear
  "not supported on this platform" error, and hide the "Open Data Folder"
  button in `NovelPage.tsx` when running on Android (detect via
  `@tauri-apps/plugin-os`'s `platform()`, or simplest: a small `isAndroid()`
  helper in a new `lib/platform.ts`).

## Phase 3 — Byte-based file I/O for import/export/backup

- Add `tauri-plugin-fs` (Rust) + `@tauri-apps/plugin-fs` (JS), with
  `fs:default`-equivalent permissions added to `capabilities/default.json`
  (Tauri v2 capability files support a `"platforms"` field to scope
  permissions per platform if desktop/mobile need to diverge).
- `src-tauri/src/import.rs`: change `import_local_novel` to accept
  `bytes: Vec<u8>` (plus the filename/extension for format dispatch) instead
  of a path; swap `std::fs::File::open` for `zip::ZipArchive::new(Cursor::new(bytes))`
  and `std::fs::read_to_string` for `String::from_utf8_lossy(&bytes)`.
- `src-tauri/src/export.rs`: change `export_novel` to build the EPUB/TXT into
  an in-memory `Cursor<Vec<u8>>` and return the bytes instead of writing to a
  path; the frontend writes them out via `plugin-fs`'s `writeFile`.
- `src-tauri/src/lib.rs`'s `write_text_file`/`read_text_file` (used by the
  library backup feature): same treatment — become pure byte-array
  pass-throughs, or are removed in favor of calling `plugin-fs` directly from
  the frontend, since Rust no longer needs to touch the path at all.
- `src/lib/api.ts`, `src/pages/LibraryPage.tsx`, `src/pages/SettingsPage.tsx`,
  `src/pages/NovelPage.tsx`: update the import/export/backup call sites to
  read the picked file's bytes via `@tauri-apps/plugin-fs` before invoking
  the Rust command, and to write returned bytes back out the same way. This
  is a mechanical change to existing call sites, not new features.

## Phase 4 — Responsive UI for phone screens

- `src/App.tsx`: the fixed-width left sidebar (`w-[15.6rem]`) doesn't fit a
  phone. Replace with a responsive layout: a bottom tab bar (Library,
  Browse, Statistics, Settings, Voice Test) below a Tailwind breakpoint,
  sidebar above it — driven by viewport width via Tailwind's responsive
  prefixes, not platform detection, so it also degrades gracefully on a
  narrow desktop window or a tablet.
- Audit touch target sizes across `NovelPage.tsx`/`LibraryPage.tsx`/
  `ReaderPage.tsx` buttons (many are already `px-4 py-2`-ish, but the dense
  chapter-list row actions and collection-chip delete `×` are small and
  mouse-tuned) and bump padding where needed for comfortable tapping.
- Wire Android's hardware/gesture back button to the existing `Route` stack
  in `App.tsx` (already a simple discriminated union with explicit
  `onBack`/`onRead` transitions) — confirm the exact Tauri mobile back-button
  event/API during Phase 0 and hook it to pop the same way the in-app Back
  buttons already do.
- Verify the Reader's keyboard shortcuts (Space/arrows/Escape) degrade
  gracefully — every one of them already has a visible on-screen button
  (Play/Pause, Prev/Next, Back), so no functional gap, just confirm nothing
  *requires* a hardware keyboard.

## Phase 5 — Background audio (own milestone, not a v1 blocker)

- Ship v1 with TTS playback working only while the app is foregrounded and
  explicitly document that as the current limitation.
- Follow-up: a small custom Android plugin (Kotlin, via Tauri's mobile
  plugin system) running a foreground service + `MediaSession` +
  notification, bridging play/pause/next/prev back into the existing
  `media-control` event the frontend already listens for in `ReaderPage.tsx`
  (today emitted by `souvlaki` on desktop) — so no frontend changes needed
  once this lands, only a new Android-specific emitter.

## Phase 6 — Icons, signing, distribution

- `npm run tauri icon` (already used for desktop) also generates Android's
  adaptive-icon mipmap set from the same source image once
  `gen/android/` exists.
- Debug builds auto-sign for local testing (`tauri android dev`/`build`).
  Release builds need a keystore (`keytool`-generated) referenced from
  `gen/android/app/build.gradle` — only needed once a release APK/AAB is
  wanted, not for development.
- Manifest permissions: `INTERNET` (scraping/TTS) at minimum; add
  `FOREGROUND_SERVICE`/`WAKE_LOCK` when Phase 5 lands. No broad storage
  permission needed since we stay within the SAF/plugin-fs model.

## Verification per phase

- Phase 0: app launches in the emulator, Library/Browse/Reader render, a
  stub-source chapter plays via TTS with word highlighting, confirmed via
  `tauri android dev` logs and on-screen interaction — no automated test
  substitutes for actually watching it run.
- Phase 1: `cargo check` (via Tauri's Android build) succeeds for all four
  Android ABI targets with no OpenSSL/native-lib link errors.
- Phase 2: desktop build and media keys still work unchanged; on Android
  the "Open Data Folder" button is hidden and the command errors clearly
  if invoked anyway.
- Phase 3: import an `.epub`/`.txt` file via the Android file picker, export
  a novel, and run a library backup export/import — all round-trip
  correctly using real device storage (not just the emulator's synthetic
  filesystem, since SAF behavior varies).
- Phase 4: manual pass on a real device (not just emulator) checking tap
  targets, bottom nav, and the hardware back button through a few
  navigation chains (Library → Novel → Reader → back → back).
- Phase 5: TTS keeps playing with the screen off and the app backgrounded;
  notification controls (play/pause/next) work from the lock screen.
