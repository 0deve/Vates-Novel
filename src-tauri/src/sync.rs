//! HTTP client for the progress-sync server (sync-server/ in the repo).
//! Requests go through reqwest rather than the webview's fetch so they are
//! not subject to CORS or Android's cleartext policy — identical behavior
//! on desktop and Android. The payload is opaque here; building and
//! merging progress documents lives in src/lib/sync.ts.

use std::time::Duration;

fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())
}

fn check(resp: reqwest::blocking::Response) -> Result<String, String> {
    let status = resp.status();
    let body = resp.text().map_err(|e| e.to_string())?;
    if status.is_success() {
        Ok(body)
    } else {
        let snippet: String = body.chars().take(200).collect();
        Err(format!("server returned {status}: {snippet}"))
    }
}

#[tauri::command]
pub async fn sync_get(url: String, token: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let resp = client()?
            .get(&url)
            .bearer_auth(&token)
            .send()
            .map_err(|e| e.to_string())?;
        check(resp)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn sync_put(url: String, token: String, body: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let resp = client()?
            .put(&url)
            .bearer_auth(&token)
            .header("content-type", "application/json")
            .body(body)
            .send()
            .map_err(|e| e.to_string())?;
        check(resp).map(|_| ())
    })
    .await
    .map_err(|e| e.to_string())?
}
