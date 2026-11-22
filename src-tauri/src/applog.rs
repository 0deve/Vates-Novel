//! App-wide log file (logs/app.log in the data dir) shared by Rust and the frontend.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_BYTES: u64 = 1024 * 1024;

static LOG_DIR: OnceLock<PathBuf> = OnceLock::new();
static WRITE_LOCK: Mutex<()> = Mutex::new(());

pub fn init(dir: PathBuf) {
    let _ = fs::create_dir_all(&dir);
    let _ = LOG_DIR.set(dir);
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        write("error", "panic", &info.to_string());
        prev(info);
    }));
}

fn current() -> Option<PathBuf> {
    LOG_DIR.get().map(|d| d.join("app.log"))
}

fn previous() -> Option<PathBuf> {
    LOG_DIR.get().map(|d| d.join("app.log.1"))
}

/// UTC "YYYY-MM-DD HH:MM:SS" without pulling in a date crate.
fn timestamp() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let (days, rem) = (secs / 86_400, secs % 86_400);
    // Civil-from-days (Howard Hinnant).
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!(
        "{y:04}-{m:02}-{d:02} {:02}:{:02}:{:02}",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

pub fn write(level: &str, scope: &str, message: &str) {
    let line = format!(
        "{} [{}] {}: {}\n",
        timestamp(),
        level.to_uppercase(),
        scope,
        message.replace('\n', "\n    ")
    );
    eprint!("{line}");
    let Some(path) = current() else { return };
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if fs::metadata(&path).map(|m| m.len() > MAX_BYTES).unwrap_or(false) {
        if let Some(prev) = previous() {
            let _ = fs::rename(&path, prev);
        }
    }
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(&path) {
        let _ = f.write_all(line.as_bytes());
    }
}

pub fn error(scope: &str, message: &str) {
    write("error", scope, message);
}

#[tauri::command]
pub fn log_write(level: String, scope: String, message: String) {
    write(&level, &scope, &message);
}

/// Previous rotation followed by the current file, oldest first.
#[tauri::command]
pub fn log_read() -> String {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut out = String::new();
    for p in [previous(), current()].into_iter().flatten() {
        if let Ok(s) = fs::read_to_string(p) {
            out.push_str(&s);
        }
    }
    out
}

#[tauri::command]
pub fn log_clear() {
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    for p in [previous(), current()].into_iter().flatten() {
        let _ = fs::remove_file(p);
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn timestamp_is_well_formed() {
        let t = super::timestamp();
        assert_eq!(t.len(), 19);
        assert!(t.starts_with("20"));
    }
}
