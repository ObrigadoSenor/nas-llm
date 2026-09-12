// In-app updater (Tauri plugin-updater) — wraps the Rust updater API behind a
// few #[tauri::command]s so the renderer (desktop.js) never calls plugin IPC
// directly and no `updater:*` capability is needed. The renderer invokes these
// over the existing Tauri IPC bridge (window.__TAURI__.core.invoke).
//
//   app_version()                  -> "0.1.0" (from package_info)
//   check_for_updates()            -> { available, currentVersion, version?, date?, body? }
//   download_and_install_update()  -> downloads + installs + restarts; emits
//                                     `update://progress` events with a 0..100 int
//
// The updater endpoint + pubkey live in tauri.conf.json (plugins.updater). CI
// (tauri-action) publishes a signed `latest.json` to the latest GitHub Release;
// the endpoint points at it. Until the signing keypair is generated and the
// pubkey placeholder replaced, check/install will fail with a clear error.

use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

// Current app version, straight from the compiled package info (the `version`
// in tauri.conf.json). Used for the "Current version" line in the UI.
#[tauri::command]
pub fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

// Hit the configured endpoint and return whether a newer version exists. The
// returned shape matches what the renderer renders: `available` + the running
// `currentVersion`, and — when an update exists — the target `version`, its
// publish `date`, and the release notes `body` (plain text from the GitHub
// release body that tauri-action wrote into latest.json).
#[tauri::command]
pub async fn check_for_updates(app: AppHandle) -> Result<serde_json::Value, String> {
    let current = app.package_info().version.to_string();
    let updater = app.updater().map_err(|e| e.to_string())?;
    match updater.check().await {
        Ok(Some(update)) => {
            // `date` is Option<OffsetDateTime> and `body` is Option<String> in
            // tauri-plugin-updater; coerce both to plain strings for the renderer.
            let date = update.date.as_ref().map(|d| d.to_string());
            let body = update.body.clone().unwrap_or_default();
            Ok(serde_json::json!({
                "available": true,
                "currentVersion": current,
                "version": update.version,
                "date": date,
                "body": body,
            }))
        }
        Ok(None) => Ok(serde_json::json!({
            "available": false,
            "currentVersion": current,
        })),
        Err(e) => Err(e.to_string()),
    }
}

// Download and install the latest update (if any), streaming download progress
// as `update://progress` events (payload: an integer 0..100), then restart the
// app into the new version. Re-checks for the update so a stale check result
// can't install the wrong version.
#[tauri::command]
pub async fn download_and_install_update(app: AppHandle) -> Result<(), String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "No update available".to_string())?;

    // download_and_install(on_chunk: FnMut(usize, Option<u64>), on_download_finish: FnOnce()).
    // on_chunk fires per chunk with (chunk_length, total_content_length); we
    // accumulate downloaded bytes and emit a 0..100 progress event. The finish
    // closure fires when the download completes (before install).
    let progress_app = app.clone();
    let finish_app = app.clone();
    let mut downloaded: u64 = 0;
    update
        .download_and_install(
            move |chunk_length, content_length| {
                downloaded += chunk_length as u64;
                if let Some(total) = content_length {
                    if total > 0 {
                        let pct = ((downloaded as f64 / total as f64) * 100.0).min(100.0) as u64;
                        let _ = progress_app.emit("update://progress", pct);
                    }
                }
            },
            move || {
                let _ = finish_app.emit("update://progress", 100u64);
            },
        )
        .await
        .map_err(|e| e.to_string())?;

    // install() relaunches and the app exits; restart() returns `!`, which
    // coerces to this command's Result return type.
    app.restart()
}
