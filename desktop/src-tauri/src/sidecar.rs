// Local sidecar: a tiny axum HTTP server that makes the desktop WebView a
// same-origin front for the NAS backend.
//
//   WebView (origin http://127.0.0.1:<port>)
//     -> GET  /                       served www/index.html (bootstrap injected)
//     -> GET  /<asset>                served from www/ (hand-rolled, traversal-guarded)
//     -> ANY  /api/{*path}            reverse-proxied to the NAS backend
//     -> *    /__sidecar/*            control plane + desktop bridge assets
//
// The NAS sets a `Secure; HttpOnly; SameSite=Lax` session cookie, which a WebView
// on an http://127.0.0.1 origin will NOT store. So the sidecar holds the session
// cookie itself (cookie jar, persisted to app-data) and attaches it to every
// proxied /api/* request; Set-Cookie responses from the backend update the jar.
// The renderer therefore never holds the NAS cookie — auth state flows through
// the sidecar. This is the "sidecar holds the cookie and injects it" fallback the
// plan anticipated, and it keeps the existing www/app.js (which uses relative
// /api/* URLs) completely unchanged.

use axum::{
    body::{to_bytes, Body},
    extract::State,
    http::{header, HeaderName, HeaderValue, Request, StatusCode},
    response::{IntoResponse, Response},
    routing::{any, get, post},
    Json, Router,
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::RwLock;

const MANIFEST_DIR: &str = env!("CARGO_MANIFEST_DIR");
pub const SESSION_COOKIE: &str = "nas-llm-session";
const DEFAULT_BACKEND: &str = "https://chat.selected.systems";

pub fn default_www() -> PathBuf {
    Path::new(MANIFEST_DIR).join("..").join("..").join("www")
}
pub fn default_renderer() -> PathBuf {
    Path::new(MANIFEST_DIR).join("..").join("renderer")
}

// --- persisted config ------------------------------------------------------

#[derive(Deserialize, Default, Clone)]
pub struct ConfigFile {
    #[serde(default)]
    pub backend_url: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
}

pub struct LoadedConfig {
    pub backend_url: Option<String>,
    pub port: Option<u16>,
}

pub fn load_config(data_dir: &Path) -> LoadedConfig {
    let cfg = std::fs::read_to_string(data_dir.join("config.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<ConfigFile>(&s).ok());
    LoadedConfig {
        backend_url: cfg.as_ref().and_then(|c| c.backend_url.clone()),
        port: cfg.and_then(|c| c.port),
    }
}

fn persist_backend(data_dir: &Path, url: &str) {
    // Merge into the existing config so a saved port isn't clobbered.
    let existing = std::fs::read_to_string(data_dir.join("config.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());
    let mut obj = existing.unwrap_or(serde_json::json!({}));
    if let serde_json::Value::Object(ref mut m) = obj {
        m.insert("backend_url".into(), serde_json::json!(url));
    }
    let _ = std::fs::write(data_dir.join("config.json"), obj.to_string());
}

fn load_cookie(data_dir: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(data_dir.join("session.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    v.get("cookie")?.as_str().filter(|s| !s.is_empty()).map(|s| s.to_string())
}

fn persist_cookie(data_dir: &Path, val: Option<&str>) {
    let obj = serde_json::json!({ "cookie": val });
    let _ = std::fs::write(data_dir.join("session.json"), obj.to_string());
}

// --- shared state ----------------------------------------------------------

#[derive(Clone)]
pub struct AppState {
    pub backend_url: Arc<RwLock<String>>,
    pub cookie: Arc<RwLock<Option<String>>>,
    pub www_path: PathBuf,
    pub renderer_path: PathBuf,
    pub data_dir: PathBuf,
    pub origin: String,
    pub client: reqwest::Client,
    pub ollama: Arc<OllamaManager>,
}

impl AppState {
    pub fn new(
        backend_url: String,
        data_dir: &Path,
        www_path: PathBuf,
        renderer_path: PathBuf,
        origin: String,
    ) -> Self {
    let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            // Long bound: SSE /events streams can run for minutes.
            .timeout(std::time::Duration::from_secs(600))
            .build()
            .expect("reqwest client");
        let backend_url = if backend_url.trim().is_empty() {
            DEFAULT_BACKEND.to_string()
        } else {
            backend_url
        };
        Self {
            backend_url: Arc::new(RwLock::new(backend_url)),
            cookie: Arc::new(RwLock::new(load_cookie(data_dir))),
            www_path,
            renderer_path,
            data_dir: data_dir.to_path_buf(),
            origin,
            client,
            ollama: Arc::new(OllamaManager::new(11434)),
        }
    }

    pub async fn backend(&self) -> String {
        self.backend_url.read().await.clone()
    }

    pub async fn cookie_value(&self) -> Option<String> {
        self.cookie.read().await.clone()
    }

    async fn set_cookie(&self, val: Option<String>) {
        {
            *self.cookie.write().await = val.clone();
        }
        persist_cookie(&self.data_dir, val.as_deref());
    }
}

// --- Ollama lifecycle + local proxy ---------------------------------------
// The web UI talks to the visitor's Ollama at localhost:11434 directly from
// the browser. In a Tauri WebView that cross-origin http://localhost call trips
// CORS/CSP and Ollama's non-localhost-Host/Origin 403 (the web UI currently
// works around it with OLLAMA_ORIGINS + text/plain "simple request" tricks).
// The sidecar removes all of that: a /__ollama/* proxy talks to localhost
// server-side (Host derived from the localhost URL, Origin/Referer stripped),
// and a fetch shim in desktop.js rewrites localhost:11434 -> /__ollama same-
// origin. The manager also auto-starts an installed Ollama on app boot so local
// models appear in the picker without manual setup.

pub struct OllamaManager {
    // A CLI-spawned `ollama serve` we own (so stop can kill it). None when
    // Ollama is run by the macOS app or was already running externally.
    child: std::sync::Mutex<Option<tokio::process::Child>>,
    pub port: u16,
    pub client: reqwest::Client,
}

impl OllamaManager {
    pub fn new(port: u16) -> Self {
        // No total timeout: /v1/chat/completions and /api/pull stream for as
        // long as the model runs. A short connect timeout fails fast when
        // Ollama isn't up.
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(std::time::Duration::from_secs(3))
            .build()
            .expect("ollama reqwest client");
        Self {
            child: std::sync::Mutex::new(None),
            port,
            client,
        }
    }

    pub fn base_url(&self) -> String {
        format!("http://localhost:{}", self.port)
    }

    pub fn managed(&self) -> bool {
        self.child.lock().expect("ollama child lock").is_some()
    }
}

// probe_ollama returns the /api/tags JSON if Ollama is up on localhost:port, else
// None. The URL host is localhost so the Host header is exactly what Ollama's
// DNS-rebinding guard wants; no header rewrite needed.
pub async fn probe_ollama(mgr: &OllamaManager) -> Option<serde_json::Value> {
    let url = format!("{}/api/tags", mgr.base_url());
    let resp = mgr
        .client
        .get(&url)
        .timeout(std::time::Duration::from_secs(2))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    resp.json::<serde_json::Value>().await.ok()
}

// macOS: the Ollama app and the Homebrew/bundled CLI. Windows/Linux paths are
// a small follow-up; Phase 1 targets macOS (the authoring platform).
pub fn find_ollama_app() -> Option<PathBuf> {
    let p = PathBuf::from("/Applications/Ollama.app");
    if p.is_dir() {
        Some(p)
    } else {
        None
    }
}

pub fn find_ollama_cli() -> Option<PathBuf> {
    for c in [
        "/opt/homebrew/bin/ollama",
        "/usr/local/bin/ollama",
        "/Applications/Ollama.app/Contents/Resources/ollama",
    ] {
        let p = PathBuf::from(c);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

// start_ollama launches Ollama if installed and not already running. Prefers
// the macOS app (`open -a Ollama` starts its tray + server); falls back to
// `ollama serve` from a CLI binary, owning that child so stop can kill it.
// Returns a via tag ("already" | "app" | "cli") on success.
pub async fn start_ollama(mgr: &OllamaManager) -> Result<String, String> {
    if probe_ollama(mgr).await.is_some() {
        return Ok("already".into());
    }
    if let Some(app) = find_ollama_app() {
        std::process::Command::new("open")
            .arg("-a")
            .arg(&app)
            .spawn()
            .map_err(|e| format!("could not open Ollama app: {e}"))?;
        for _ in 0..30 {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            if probe_ollama(mgr).await.is_some() {
                return Ok("app".into());
            }
        }
        return Err("Ollama app opened but its API did not come up".into());
    }
    if let Some(cli) = find_ollama_cli() {
        let mut cmd = tokio::process::Command::new(&cli);
        cmd.arg("serve")
            .env("OLLAMA_HOST", format!("127.0.0.1:{}", mgr.port))
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        let child = cmd.spawn().map_err(|e| format!("could not start ollama: {e}"))?;
        {
            *mgr.child.lock().expect("ollama child lock") = Some(child);
        }
        for _ in 0..30 {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            if probe_ollama(mgr).await.is_some() {
                return Ok("cli".into());
            }
        }
        return Err("ollama serve started but its API did not come up".into());
    }
    Err("Ollama is not installed. Install it from https://ollama.com and reopen the app.".into())
}

// --- router ----------------------------------------------------------------

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/", get(index_html))
        .route("/__sidecar/health", get(sidecar_health))
        .route("/__sidecar/state", get(sidecar_state))
        .route("/__sidecar/backend", post(sidecar_set_backend))
        .route("/__sidecar/test", post(sidecar_test))
        .route("/__sidecar/verify", post(sidecar_verify))
        .route("/__sidecar/logout", post(sidecar_logout))
        .route("/__sidecar/desktop.js", get(desktop_js))
        .route("/__sidecar/desktop.css", get(desktop_css))
        .route("/__sidecar/ollama/status", get(ollama_status))
        .route("/__sidecar/ollama/start", post(ollama_start))
        .route("/__sidecar/ollama/stop", post(ollama_stop))
        .route("/__ollama/*path", any(proxy_ollama))
        .route("/api/*path", any(proxy_api))
        .fallback(serve_www)
        .with_state(state)
}

// --- static + injected index ----------------------------------------------

async fn index_html(State(st): State<AppState>) -> Response {
    let path = st.www_path.join("index.html");
    match std::fs::read_to_string(&path) {
        Ok(mut html) => {
            // Inject the desktop bridge once. Idempotent guards so a refresh
            // after the file was already patched in-process never double-injects.
            if !html.contains("/__sidecar/desktop.css") {
                html = html.replacen(
                    "</head>",
                    "<link rel=\"stylesheet\" href=\"/__sidecar/desktop.css?v=10\">\n</head>",
                    1,
                );
            }
            if !html.contains("/__sidecar/desktop.js") {
                html = html.replacen(
                    "</body>",
                    "<script type=\"module\" src=\"/__sidecar/desktop.js?v=10\"></script>\n</body>",
                    1,
                );
            }
            html_response(html, StatusCode::OK)
        }
        Err(_) => (StatusCode::NOT_FOUND, "index.html not found").into_response(),
    }
}

// Hand-rolled static file serving for www/ assets (no tower-http dependency,
// so no tower/hyper version coupling to fight).
async fn serve_www(State(st): State<AppState>, req: Request<Body>) -> Response {
    let path = req.uri().path().trim_start_matches('/');
    let candidate = st.www_path.join(path);
    let www_canon = match std::fs::canonicalize(&st.www_path) {
        Ok(c) => c,
        Err(_) => return index_html(State(st)).await,
    };
    let canonical = match std::fs::canonicalize(&candidate) {
        Ok(c) => c,
        Err(_) => return index_html(State(st)).await, // SPA fallback (injected)
    };
    if !canonical.starts_with(&www_canon) {
        return (StatusCode::FORBIDDEN, "forbidden").into_response();
    }
    if canonical.is_dir() {
        return index_html(State(st)).await;
    }
    match std::fs::read(&canonical) {
        Ok(b) => {
            let mut r = Response::new(Body::from(b));
            *r.status_mut() = StatusCode::OK;
            if let Ok(ct) = HeaderValue::from_str(content_type(&canonical)) {
                r.headers_mut().insert(header::CONTENT_TYPE, ct);
            }
            r
        }
        Err(_) => index_html(State(st)).await,
    }
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).map(|s| s.to_ascii_lowercase()).as_deref() {
        Some("html") => "text/html; charset=utf-8",
        Some("js" | "mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("ico") => "image/x-icon",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("map") => "application/json; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn html_response(body: String, status: StatusCode) -> Response {
    let mut r = Response::new(Body::from(body));
    *r.status_mut() = status;
    r.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"));
    r
}

fn serve_asset(path: &Path, ct: &'static str) -> Response {
    match std::fs::read(path) {
        Ok(b) => {
            let mut r = Response::new(Body::from(b));
            *r.status_mut() = StatusCode::OK;
            if let Ok(hv) = HeaderValue::from_str(ct) {
                r.headers_mut().insert(header::CONTENT_TYPE, hv);
            }
            r
        }
        Err(_) => (StatusCode::NOT_FOUND, "asset not found").into_response(),
    }
}

async fn desktop_js(State(st): State<AppState>) -> Response {
    serve_asset(&st.renderer_path.join("desktop.js"), "text/javascript; charset=utf-8")
}
async fn desktop_css(State(st): State<AppState>) -> Response {
    serve_asset(&st.renderer_path.join("desktop.css"), "text/css; charset=utf-8")
}

// --- reverse proxy: /api/* -> NAS backend ---------------------------------

async fn proxy_api(State(st): State<AppState>, req: Request<Body>) -> Response {
    let (parts, body) = req.into_parts();
    let path_and_query = parts
        .uri
        .path_and_query()
        .map(|p| p.as_str())
        .unwrap_or("/");
    let backend = st.backend().await;
    let url = format!("{}{}", backend.trim_end_matches('/'), path_and_query);

    let method =
        reqwest::Method::from_bytes(parts.method.as_str().as_bytes()).unwrap_or(reqwest::Method::GET);

    // Build outbound headers: copy everything except hop-by-hop, host, cookie
    // (we set the cookie from the jar), and content-length (streamed/rewritten).
    let mut req_h = reqwest::header::HeaderMap::new();
    for (k, v) in parts.headers.iter() {
        let name = k.as_str().to_ascii_lowercase();
        if is_hop_by_hop(&name) || name == "host" || name == "cookie" || name == "content-length" {
            continue;
        }
        if let (Ok(rk), Ok(rv)) = (
            reqwest::header::HeaderName::from_bytes(k.as_str().as_bytes()),
            reqwest::header::HeaderValue::from_bytes(v.as_bytes()),
        ) {
            req_h.insert(rk, rv);
        }
    }
    if let Some(cv) = st.cookie_value().await {
        if let Ok(hv) = reqwest::header::HeaderValue::from_str(&format!("{SESSION_COOKIE}={cv}")) {
            req_h.insert(reqwest::header::COOKIE, hv);
        }
    }

    let mut builder = st.client.request(method, &url).headers(req_h);
    let bytes = to_bytes(body, 50_000_000).await.unwrap_or_default();
    if !bytes.is_empty() {
        builder = builder.body(bytes);
    }

    let resp = match builder.send().await {
        Ok(r) => r,
        Err(e) => return proxy_error(&e),
    };

    let status =
        StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);

    let mut out_h = axum::http::HeaderMap::new();
    let mut captured: Option<String> = None;
    for (k, v) in resp.headers().iter() {
        let name = k.as_str().to_ascii_lowercase();
        if is_hop_by_hop(&name) || name == "content-length" {
            continue;
        }
        if name == "set-cookie" {
            if let Ok(s) = v.to_str() {
                if let Some(cv) = parse_session_cookie(s) {
                    captured = Some(cv);
                }
            }
            continue; // jar owns the cookie; never forward Set-Cookie to the WebView
        }
        if name == "location" {
            if let Ok(s) = v.to_str() {
                let rw = rewrite_location(s, &backend, &st.origin);
                if let Ok(hv) = HeaderValue::from_str(&rw) {
                    out_h.insert(header::LOCATION, hv);
                }
                continue;
            }
        }
        if let (Ok(an), Ok(av)) = (
            HeaderName::from_bytes(k.as_str().as_bytes()),
            HeaderValue::from_bytes(v.as_bytes()),
        ) {
            out_h.insert(an, av);
        }
    }

    // Only touch the jar when the backend actually sent a Set-Cookie for the
    // session. The vast majority of /api/* responses (auth/me, models, chats,
    // events…) carry NO Set-Cookie, and wiping the jar on those would log the
    // user out after the first post-login call. An explicit clear
    // (nas-llm-session=; MaxAge=-1, as sent by /api/auth/logout) empties the jar.
    match captured {
        Some(v) if v.is_empty() => st.set_cookie(None).await,
        Some(v) => st.set_cookie(Some(v)).await,
        None => { /* no Set-Cookie — leave the persisted jar untouched */ }
    }

    let stream = resp
        .bytes_stream()
        .map(|r| r.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e)));
    let mut out = Response::new(Body::from_stream(stream));
    *out.status_mut() = status;
    *out.headers_mut() = out_h;
    out
}

fn proxy_error(e: &reqwest::Error) -> Response {
    let body = serde_json::json!({ "error": e.to_string() });
    let mut r = Response::new(Body::from(body.to_string()));
    *r.status_mut() = StatusCode::BAD_GATEWAY;
    r.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    r
}

fn is_hop_by_hop(name: &str) -> bool {
    matches!(
        name,
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "trailers"
            | "transfer-encoding"
            | "upgrade"
    )
}

// Parse the value of the session cookie out of a Set-Cookie line.
fn parse_session_cookie(set_cookie: &str) -> Option<String> {
    let pair = set_cookie.split(';').next()?.trim();
    let (name, val) = pair.split_once('=')?;
    if name.trim() == SESSION_COOKIE {
        Some(val.trim().to_string())
    } else {
        None
    }
}

// Rewrite a backend-host Location (e.g. the /api/auth/verify 303) to the local
// origin so the WebView stays inside the sidecar instead of navigating to the
// public NAS URL.
fn rewrite_location(loc: &str, backend: &str, origin: &str) -> String {
    let b = backend.trim_end_matches('/');
    if loc == b || loc.starts_with(&format!("{b}/")) {
        let tail = &loc[b.len()..];
        format!("{origin}{tail}")
    } else {
        loc.to_string()
    }
}

// --- control plane: /__sidecar/* ------------------------------------------

#[derive(Serialize)]
struct StateResponse {
    backend_url: String,
    origin: String,
    authed: bool,
    email: Option<String>,
}

async fn sidecar_health() -> Response {
    json_ok(&serde_json::json!({ "ok": true }))
}

async fn sidecar_state(State(st): State<AppState>) -> Response {
    let backend = st.backend().await;
    let cookie = st.cookie_value().await;
    let email = if cookie.is_some() {
        probe_email(&st.client, &backend, cookie.as_deref()).await
    } else {
        None
    };
    json_ok(&StateResponse {
        backend_url: backend,
        origin: st.origin.clone(),
        authed: cookie.is_some(),
        email,
    })
}

#[derive(Deserialize)]
struct SetBackendBody {
    url: String,
}

async fn sidecar_set_backend(State(st): State<AppState>, Json(body): Json<SetBackendBody>) -> Response {
    let url = body.url.trim().to_string();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return json_err("url must start with http:// or https://", StatusCode::BAD_REQUEST);
    }
    {
        *st.backend_url.write().await = url.clone();
    }
    persist_backend(&st.data_dir, &url);
    json_ok(&serde_json::json!({ "ok": true, "backend_url": url }))
}

#[derive(Deserialize)]
struct TestBody {
    url: Option<String>,
}

#[derive(Serialize)]
struct TestResponse {
    ok: bool,
    status: u16,
    latency_ms: u64,
    error: Option<String>,
}

async fn sidecar_test(State(st): State<AppState>, Json(body): Json<TestBody>) -> Response {
    let url = match body.url.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()) {
        Some(u) => u,
        None => st.backend().await,
    };
    let target = format!("{}/api/health", url.trim_end_matches('/'));
    let start = std::time::Instant::now();
    match st.client.get(&target).timeout(std::time::Duration::from_secs(6)).send().await {
        Ok(r) => json_ok(&TestResponse {
            ok: r.status().is_success(),
            status: r.status().as_u16(),
            latency_ms: start.elapsed().as_millis() as u64,
            error: None,
        }),
        Err(e) => json_ok(&TestResponse {
            ok: false,
            status: 0,
            latency_ms: start.elapsed().as_millis() as u64,
            error: Some(e.to_string()),
        }),
    }
}

#[derive(Deserialize)]
struct VerifyBody {
    url: String,
}

#[derive(Serialize)]
struct VerifyResponse {
    ok: bool,
    email: Option<String>,
    backend_url: Option<String>,
    error: Option<String>,
}

fn verify_err(msg: &str) -> Response {
    json_ok(&VerifyResponse {
        ok: false,
        email: None,
        backend_url: None,
        error: Some(msg.into()),
    })
}

// The user pastes the magic-link URL from their email. Transactional email
// providers (Brevo here) wrap links in click-tracking redirects, so the pasted
// URL may be a tracking URL (https://r.noreply.../tr/cl/…) that 302s to the
// real verify URL, which itself 303s to / after Set-Cookie. We walk the
// redirect chain manually (the client has redirects off) so we can capture
// Set-Cookie at each hop — reqwest's built-in follow-redirects only exposes
// the final response's headers and would lose the cookie set on the 303. We
// require the chain to reach a /api/auth/verify URL (light guard that it's a
// magic link, not an arbitrary probe), derive the backend from that URL's
// origin, capture the session cookie, and confirm via /api/auth/me.
async fn sidecar_verify(State(st): State<AppState>, Json(body): Json<VerifyBody>) -> Response {
    let url = body.url.trim().to_string();
    let parsed = match url::Url::parse(&url) {
        Ok(u) => u,
        Err(_) => return verify_err("invalid URL"),
    };
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return verify_err("link must be an http(s) URL");
    }

    let mut current = parsed;
    let mut captured: Option<String> = None;
    let mut backend_origin: Option<String> = None;
    const MAX_HOPS: u8 = 12;
    for _ in 0..MAX_HOPS {
        // Record the backend origin the first time we see a verify URL in the
        // chain (the tracking redirect's destination, or the pasted link itself).
        if backend_origin.is_none() && current.path().starts_with("/api/auth/verify") {
            backend_origin = origin_of(&current);
        }
        let resp = match st
            .client
            .get(current.as_str())
            .timeout(std::time::Duration::from_secs(8))
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => return verify_err(&e.to_string()),
        };
        for v in resp.headers().get_all(reqwest::header::SET_COOKIE).iter() {
            if let Ok(s) = v.to_str() {
                if let Some(cv) = parse_session_cookie(s) {
                    captured = Some(cv);
                }
            }
        }
        match resp
            .headers()
            .get(reqwest::header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|loc| current.join(loc).ok())
        {
            Some(next) => current = next,
            None => break,
        }
    }

    let origin = match backend_origin {
        Some(o) => o,
        None => return verify_err("link did not reach a magic-link verify URL (/api/auth/verify)"),
    };
    // Only update the jar when we actually captured a NEW session cookie. A
    // failed/expired verify (no Set-Cookie on any hop) must NOT log the user
    // out of an existing valid session — clearing is the job of /__sidecar/logout.
    // This also keeps a bogus probe (e.g. a test against a host that returns no
    // nas-llm-session cookie) from wiping a real persisted session.
    let new_cookie = captured.and_then(|v| if v.is_empty() { None } else { Some(v) });
    // The cookie is scoped to the verify URL's origin, so all subsequent /api/*
    // calls must go there too. Persist it so a relaunch keeps talking to the
    // same host.
    {
        *st.backend_url.write().await = origin.clone();
    }
    persist_backend(&st.data_dir, &origin);
    let cookie_for_probe = if let Some(cv) = new_cookie.clone() {
        st.set_cookie(Some(cv.clone())).await;
        Some(cv)
    } else {
        // Leave the existing jar untouched on failure; probe with whatever's
        // already there so the response reflects the real auth state.
        st.cookie_value().await
    };
    let email = probe_email(&st.client, &origin, cookie_for_probe.as_deref()).await;
    let ok = email.is_some();
    json_ok(&VerifyResponse {
        ok,
        email,
        backend_url: Some(origin),
        error: if ok { None } else { Some("no session cookie in the response".into()) },
    })
}

// origin_of returns "scheme://host[:port]" for a URL, or None if it has no
// host. Used to derive the backend origin from the verify URL in a redirect
// chain.
fn origin_of(u: &url::Url) -> Option<String> {
    let host = u.host_str()?;
    if host.is_empty() {
        return None;
    }
    Some(match u.port() {
        Some(p) => format!("{}://{}:{}", u.scheme(), host, p),
        None => format!("{}://{}", u.scheme(), host),
    })
}

async fn sidecar_logout(State(st): State<AppState>) -> Response {
    let backend = st.backend().await;
    if let Some(cv) = st.cookie_value().await {
        let _ = st
            .client
            .post(format!("{}/api/auth/logout", backend.trim_end_matches('/')))
            .header(reqwest::header::COOKIE, format!("{SESSION_COOKIE}={cv}"))
            .timeout(std::time::Duration::from_secs(5))
            .send()
            .await;
    }
    st.set_cookie(None).await;
    json_ok(&serde_json::json!({ "ok": true }))
}

async fn probe_email(
    client: &reqwest::Client,
    backend: &str,
    cookie: Option<&str>,
) -> Option<String> {
    let cookie = cookie?;
    let resp = client
        .get(format!("{}/api/auth/me", backend.trim_end_matches('/')))
        .header(reqwest::header::COOKIE, format!("{SESSION_COOKIE}={cookie}"))
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let v: serde_json::Value = resp.json().await.ok()?;
    v.get("email")?.as_str().map(|s| s.to_string())
}

fn json_ok<T: Serialize>(v: &T) -> Response {
    let mut r = Response::new(Body::from(serde_json::to_vec(v).unwrap_or_default()));
    *r.status_mut() = StatusCode::OK;
    r.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    r
}

fn json_err(msg: &str, status: StatusCode) -> Response {
    let body = serde_json::json!({ "error": msg });
    let mut r = Response::new(Body::from(body.to_string()));
    *r.status_mut() = status;
    r.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    r
}

// --- Ollama proxy + lifecycle handlers ------------------------------------

// proxy_ollama forwards /__ollama/<path> to the local Ollama at
// localhost:11434. Strips the browser Origin/Referer (Ollama 403s them) and
// the inbound Host/Content-Length, lets reqwest set Host from the localhost
// URL, and streams the response back so /v1/chat/completions and /api/pull
// NDJSON flow through chunk-by-chunk. A connection failure (Ollama not up)
// yields a 502 with a hint to start it from the settings panel.
async fn proxy_ollama(State(st): State<AppState>, req: Request<Body>) -> Response {
    let (parts, body) = req.into_parts();
    let pq = parts.uri.path_and_query().map(|p| p.as_str()).unwrap_or("/");
    let target_path = pq.strip_prefix("/__ollama").unwrap_or(pq);
    let url = format!("{}{}", st.ollama.base_url(), target_path);
    let method =
        reqwest::Method::from_bytes(parts.method.as_str().as_bytes()).unwrap_or(reqwest::Method::GET);

    let mut req_h = reqwest::header::HeaderMap::new();
    for (k, v) in parts.headers.iter() {
        let name = k.as_str().to_ascii_lowercase();
        if is_hop_by_hop(&name)
            || name == "host"
            || name == "origin"
            || name == "referer"
            || name == "cookie"
            || name == "content-length"
        {
            continue;
        }
        if let (Ok(rk), Ok(rv)) = (
            reqwest::header::HeaderName::from_bytes(k.as_str().as_bytes()),
            reqwest::header::HeaderValue::from_bytes(v.as_bytes()),
        ) {
            req_h.insert(rk, rv);
        }
    }
    let bytes = to_bytes(body, 100_000_000).await.unwrap_or_default();
    let mut builder = st.ollama.client.request(method, &url).headers(req_h);
    if !bytes.is_empty() {
        builder = builder.body(bytes);
    }
    let resp = match builder.send().await {
        Ok(r) => r,
        Err(_) => return ollama_proxy_error(),
    };

    let status = StatusCode::from_u16(resp.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let mut out_h = axum::http::HeaderMap::new();
    for (k, v) in resp.headers().iter() {
        let name = k.as_str().to_ascii_lowercase();
        if is_hop_by_hop(&name) || name == "content-length" {
            continue;
        }
        if let (Ok(an), Ok(av)) = (
            HeaderName::from_bytes(k.as_str().as_bytes()),
            HeaderValue::from_bytes(v.as_bytes()),
        ) {
            out_h.insert(an, av);
        }
    }
    let stream = resp
        .bytes_stream()
        .map(|r| r.map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e)));
    let mut out = Response::new(Body::from_stream(stream));
    *out.status_mut() = status;
    *out.headers_mut() = out_h;
    out
}

fn ollama_proxy_error() -> Response {
    let body = serde_json::json!({ "error": "Ollama is not running on this computer. Open ⚙ Desktop settings -> Ollama to start it." });
    let mut r = Response::new(Body::from(body.to_string()));
    *r.status_mut() = StatusCode::BAD_GATEWAY;
    r.headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
    r
}

#[derive(Serialize)]
struct OllamaStatus {
    running: bool,
    installed: bool,
    app_installed: bool,
    cli: Option<String>,
    port: u16,
    managed: bool,
    models: Vec<String>,
}

async fn ollama_status(State(st): State<AppState>) -> Response {
    let probe = probe_ollama(&st.ollama).await;
    let models = probe
        .as_ref()
        .and_then(|v| v.get("models").and_then(|m| m.as_array()))
        .map(|a| {
            a.iter()
                .filter_map(|m| m.get("name").and_then(|n| n.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default();
    json_ok(&OllamaStatus {
        running: probe.is_some(),
        installed: find_ollama_app().is_some() || find_ollama_cli().is_some(),
        app_installed: find_ollama_app().is_some(),
        cli: find_ollama_cli().map(|p| p.display().to_string()),
        port: st.ollama.port,
        managed: st.ollama.managed(),
        models,
    })
}

async fn ollama_start(State(st): State<AppState>) -> Response {
    match start_ollama(&st.ollama).await {
        Ok(via) => json_ok(&serde_json::json!({ "ok": true, "via": via })),
        Err(e) => json_ok(&serde_json::json!({ "ok": false, "error": e })),
    }
}

async fn ollama_stop(State(st): State<AppState>) -> Response {
    // Take the child out of the lock and drop the guard before awaiting kill():
    // std::sync::MutexGuard is !Send, and holding it across an await would make
    // the handler future !Send (axum's Handler requires Send).
    let taken = {
        let mut guard = st.ollama.child.lock().expect("ollama child lock");
        guard.take()
    };
    let killed_managed = if let Some(mut child) = taken {
        let _ = child.kill().await;
        true
    } else {
        false
    };
    if killed_managed {
        return json_ok(&serde_json::json!({ "ok": true, "via": "cli" }));
    }
    // App-managed or external: quit the macOS app gently if present.
    if find_ollama_app().is_some() {
        let _ = std::process::Command::new("osascript")
            .args(["-e", "quit app \"Ollama\""])
            .spawn();
        return json_ok(&serde_json::json!({ "ok": true, "via": "app" }));
    }
    json_ok(&serde_json::json!({ "ok": false, "error": "Ollama is running but not managed by the desktop app" }))
}
