// Tauri 2 entry point for the nas-llm desktop app.
//
// Phase 0 (shell + bridge): no static window is declared in tauri.conf.json.
// Instead we bind a local sidecar HTTP server (sidecar.rs) that serves the
// existing www/ chat UI and reverse-proxies /api/* to the NAS backend, then
// create the main window at runtime pointed at the sidecar origin. The WebView
// is therefore same-origin with the sidecar, so the existing www/app.js works
// unchanged (relative /api/*, SSE /events, etc.).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod github;
mod sidecar;
mod updater;

use std::path::PathBuf;
use tauri::{WebviewUrl, WebviewWindowBuilder};

const DEFAULT_PORT: u16 = 17543;

// Bind 127.0.0.1, walking up from `start` until a free port is found.
fn bind_listener(start: u16) -> std::net::TcpListener {
    let mut port = start;
    for _ in 0..64 {
        if let Ok(l) = std::net::TcpListener::bind(("127.0.0.1", port)) {
            return l;
        }
        port = port.wrapping_add(1);
    }
    // Last resort: let the OS pick.
    std::net::TcpListener::bind(("127.0.0.1", 0)).expect("bind sidecar port")
}

fn main() {
    let _ = env_logger::try_init();

    let data_dir = dirs::data_dir().expect("no data dir").join("nas-llm-desktop");
    std::fs::create_dir_all(&data_dir).ok();

    let cfg = sidecar::load_config(&data_dir);

    // Bind first so we know the real port before building the window URL. The
    // std bind needs no runtime; the conversion to a tokio listener happens
    // inside setup() where the Tauri async runtime is live.
    let std_listener = bind_listener(cfg.port.unwrap_or(DEFAULT_PORT));
    let port = std_listener.local_addr().unwrap().port();
    std_listener.set_nonblocking(true).ok();
    let origin = format!("http://127.0.0.1:{port}");

    let www_path = std::env::var("NASLLM_WWW")
        .map(PathBuf::from)
        .unwrap_or_else(|_| sidecar::default_www());
    let renderer_path = std::env::var("NASLLM_RENDERER")
        .map(PathBuf::from)
        .unwrap_or_else(|_| sidecar::default_renderer());

    let state = sidecar::AppState::new(
        cfg.backend_url.unwrap_or_default(),
        &data_dir,
        www_path,
        renderer_path,
        origin.clone(),
    );

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Native completion notifications (Phase: multi-agent concurrency):
        // the renderer fires one when a background chat's job finishes, since
        // notification actions are mobile-only in Tauri and the in-app badge
        // is the way to jump to the chat.
        .plugin(tauri_plugin_notification::init())
        .manage(state.clone())
        .setup(move |app| {
            // Run the sidecar HTTP server on the Tauri async runtime (tokio).
            // Merge the core sidecar router with the GitHub/repos router so all
            // /__sidecar/* routes are served from one axum app.
            let router = sidecar::router(state.clone()).merge(github::router(state.clone()));
            let origin_for_log = origin.clone();
            tauri::async_runtime::spawn(async move {
                // from_std needs an active Tokio 1.x runtime, which exists
                // inside this task spawned on the Tauri async runtime.
                let listener = tokio::net::TcpListener::from_std(std_listener).expect("listener");
                log::info!("nas-llm sidecar listening at {origin_for_log}");
                if let Err(e) = axum::serve(listener, router.into_make_service()).await {
                    log::error!("sidecar server: {e}");
                }
            });

            // Auto-start a local Ollama if it's installed but not running, so
            // local models are discoverable through the /__ollama proxy by the
            // time the web UI boots. Fire-and-forget; status is surfaced in the
            // ⚙ Desktop settings -> Ollama panel, and a manual Start is there if
            // this fails.
            let autostart = state.clone();
            tauri::async_runtime::spawn(async move {
                if sidecar::probe_ollama(&autostart.ollama).await.is_none()
                    && (sidecar::find_ollama_app().is_some() || sidecar::find_ollama_cli().is_some())
                {
                    match sidecar::start_ollama(&autostart.ollama).await {
                        Ok(via) => log::info!("auto-started local Ollama (via {via})"),
                        Err(e) => log::info!("local Ollama auto-start skipped: {e}"),
                    }
                }
            });

            let handle = app.handle().clone();
            WebviewWindowBuilder::new(
                &handle,
                "main",
                WebviewUrl::External(url::Url::parse(&origin).unwrap()),
            )
            .title("nas-llm")
            .inner_size(1100.0, 760.0)
            .min_inner_size(640.0, 480.0)
            .build()?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            updater::app_version,
            updater::check_for_updates,
            updater::download_and_install_update
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
