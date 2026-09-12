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
        }
    }

    async fn backend(&self) -> String {
        self.backend_url.read().await.clone()
    }

    async fn cookie_value(&self) -> Option<String> {
        self.cookie.read().await.clone()
    }

    async fn set_cookie(&self, val: Option<String>) {
        {
            *self.cookie.write().await = val.clone();
        }
        persist_cookie(&self.data_dir, val.as_deref());
    }
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
                    "<link rel=\"stylesheet\" href=\"/__sidecar/desktop.css?v=2\">\n</head>",
                    1,
                );
            }
            if !html.contains("/__sidecar/desktop.js") {
                html = html.replacen(
                    "</body>",
                    "<script type=\"module\" src=\"/__sidecar/desktop.js?v=2\"></script>\n</body>",
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

    // An empty Set-Cookie value (logout clears the cookie) empties the jar.
    let to_store = captured.and_then(|v| if v.is_empty() { None } else { Some(v) });
    st.set_cookie(to_store).await;

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
    error: Option<String>,
}

// The user pastes the magic-link URL from their email. The sidecar fetches it
// (SSRF-guarded: the host must match the configured backend), captures the
// session cookie into the jar, then confirms via /api/auth/me.
async fn sidecar_verify(State(st): State<AppState>, Json(body): Json<VerifyBody>) -> Response {
    let url = body.url.trim().to_string();
    let backend = st.backend().await;
    if !same_host(&url, &backend) {
        return json_ok(&VerifyResponse {
            ok: false,
            email: None,
            error: Some("link host does not match the configured backend".into()),
        });
    }
    let resp = match st.client.get(&url).timeout(std::time::Duration::from_secs(8)).send().await {
        Ok(r) => r,
        Err(e) => {
            return json_ok(&VerifyResponse {
                ok: false,
                email: None,
                error: Some(e.to_string()),
            })
        }
    };
    let mut captured: Option<String> = None;
    for v in resp.headers().get_all(reqwest::header::SET_COOKIE).iter() {
        if let Ok(s) = v.to_str() {
            if let Some(cv) = parse_session_cookie(s) {
                captured = Some(cv);
            }
        }
    }
    let to_store = captured.and_then(|v| if v.is_empty() { None } else { Some(v) });
    st.set_cookie(to_store.clone()).await;
    let email = if to_store.is_some() {
        probe_email(&st.client, &backend, to_store.as_deref()).await
    } else {
        None
    };
    let ok = email.is_some();
    json_ok(&VerifyResponse {
        ok,
        email,
        error: if ok { None } else { Some("no session cookie in the response".into()) },
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

fn same_host(a: &str, b: &str) -> bool {
    match (url::Url::parse(a), url::Url::parse(b)) {
        (Ok(ua), Ok(ub)) => ua.host_str() == ub.host_str()
            && ua.port_or_known_default() == ub.port_or_known_default(),
        _ => false,
    }
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
