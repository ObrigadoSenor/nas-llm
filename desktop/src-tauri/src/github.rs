// GitHub integration + local repo workspace (Phase 2).
//
// Auth is token-based for the first cut: the user pastes a GitHub Personal
// Access Token (classic or fine-grained, with `repo` / contents read) into the
// Repos panel; it's stored in the OS keychain (macOS Keychain via the `keyring`
// crate) — never on disk in plaintext, never sent to the NAS. A device-flow
// OAuth upgrade can drop in behind the same /__sidecar/github/* surface later
// (it needs a registered OAuth App client_id, which the user would provide).
//
// Git operations shell out to the system `git` (the user has it). Clones land
// in a managed workspace dir under app-data/repos. The token is injected into
// the clone URL as https://x-access-token:<token>@github.com/… and scrubbed
// from any captured git output before it's returned to the renderer.

use axum::{
    body::Body,
    extract::State,
    http::{header, HeaderValue, StatusCode},
    response::Response,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::sidecar::AppState;

const KEYRING_SERVICE: &str = "nas-llm-desktop";
const KEYRING_USER: &str = "github-token";
const GH_API: &str = "https://api.github.com";
const USER_AGENT: &str = "nas-llm-desktop";

// --- keychain token storage ------------------------------------------------

fn token_get() -> Option<String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .ok()?
        .get_password()
        .ok()
        .filter(|s| !s.is_empty())
}

fn token_set(token: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|e| format!("keychain open: {e}"))?;
    entry
        .set_password(token)
        .map_err(|e| format!("keychain set: {e}"))
}

fn token_delete() {
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER) {
        let _ = entry.delete_credential();
    }
}

// --- workspace -------------------------------------------------------------

fn workspace_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("repos")
}

// A filesystem-safe directory name for a repo's full_name (owner/repo -> owner--repo).
fn safe_name(full_name: &str) -> String {
    full_name.replace('/', "--")
}

// --- GitHub API ------------------------------------------------------------

fn gh_headers(token: &str) -> reqwest::header::HeaderMap {
    let mut h = reqwest::header::HeaderMap::new();
    if let Ok(v) = HeaderValue::from_str(&format!("Bearer {token}")) {
        h.insert(reqwest::header::AUTHORIZATION, v);
    }
    h.insert(
        reqwest::header::ACCEPT,
        HeaderValue::from_static("application/vnd.github+json"),
    );
    h.insert("X-GitHub-Api-Version", HeaderValue::from_static("2022-11-28"));
    h.insert(reqwest::header::USER_AGENT, HeaderValue::from_static(USER_AGENT));
    h
}

async fn gh_get_user(client: &reqwest::Client, token: &str) -> Result<serde_json::Value, String> {
    let resp = client
        .get(format!("{GH_API}/user"))
        .headers(gh_headers(token))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("github unreachable: {e}"))?;
    if resp.status() == StatusCode::UNAUTHORIZED {
        return Err("invalid or expired token".into());
    }
    if !resp.status().is_success() {
        return Err(format!("github returned {}", resp.status()));
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|e| format!("bad github response: {e}"))
}

async fn gh_list_repos(
    client: &reqwest::Client,
    token: &str,
) -> Result<Vec<serde_json::Value>, String> {
    let resp = client
        .get(format!(
            "{GH_API}/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator"
        ))
        .headers(gh_headers(token))
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("github unreachable: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("github returned {}", resp.status()));
    }
    resp.json::<Vec<serde_json::Value>>()
        .await
        .map_err(|e| format!("bad github response: {e}"))
}

// --- git operations (system git) ------------------------------------------

// Build an authenticated clone URL from a public https clone URL by injecting
// the token as the username/password. Handles https://github.com/owner/repo.git.
fn authed_clone_url(clone_url: &str, token: &str) -> Result<String, String> {
    let mut u = url::Url::parse(clone_url).map_err(|e| format!("bad clone url: {e}"))?;
    if u.scheme() != "https" {
        return Err("only https clone URLs are supported".into());
    }
    u.set_username("x-access-token").ok();
    u.set_password(Some(token)).ok();
    Ok(u.to_string())
}

// Scrub the token out of any captured git output before returning it.
fn scrub(out: String, token: &str) -> String {
    if token.is_empty() {
        out
    } else {
        out.replace(token, "<token>")
    }
}

async fn git_clone(
    token: &str,
    clone_url: &str,
    dest: &Path,
) -> Result<(), String> {
    let authed = authed_clone_url(clone_url, token)?;
    let out = tokio::process::Command::new("git")
        .arg("clone")
        .arg("--progress")
        .arg(&authed)
        .arg(dest)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("could not run git: {e}"))?;
    if !out.status.success() {
        let msg = String::from_utf8_lossy(&out.stderr).to_string();
        return Err(scrub(msg.trim().to_string(), token));
    }
    Ok(())
}

async fn git_pull(path: &Path, token: &str) -> Result<String, String> {
    // Pull uses the remote URL already configured in the clone (which carries
    // the token), so no URL rewrite is needed; scrub anyway for safety.
    let out = tokio::process::Command::new("git")
        .arg("-C")
        .arg(path)
        .arg("pull")
        .arg("--ff-only")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("could not run git: {e}"))?;
    let combined = format!(
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    if !out.status.success() {
        return Err(scrub(combined.trim().to_string(), token));
    }
    Ok(scrub(combined.trim().to_string(), token))
}

async fn git_branch(path: &Path) -> String {
    let out = tokio::process::Command::new("git")
        .arg("-C")
        .arg(path)
        .arg("rev-parse")
        .arg("--abbrev-ref")
        .arg("HEAD")
        .output()
        .await;
    match out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        _ => "(unknown)".to_string(),
    }
}

async fn git_dirty_count(path: &Path) -> usize {
    let out = tokio::process::Command::new("git")
        .arg("-C")
        .arg(path)
        .arg("status")
        .arg("--porcelain")
        .output()
        .await;
    match out {
        Ok(o) if o.status.success() => {
            String::from_utf8_lossy(&o.stdout).lines().filter(|l| !l.is_empty()).count()
        }
        _ => 0,
    }
}

// --- response types --------------------------------------------------------

#[derive(Serialize)]
struct GhStatus {
    connected: bool,
    login: Option<String>,
    avatar_url: Option<String>,
}

#[derive(Deserialize)]
struct ConnectBody {
    token: String,
}

#[derive(Serialize)]
struct RepoRow {
    full_name: String,
    clone_url: String,
    private: bool,
    default_branch: String,
    updated_at: String,
}

#[derive(Serialize)]
struct LocalRepo {
    name: String,
    path: String,
    branch: String,
    dirty: usize,
}

#[derive(Deserialize)]
struct CloneBody {
    full_name: String,
    clone_url: Option<String>,
}

#[derive(Deserialize)]
struct NameBody {
    name: String,
}

// --- handlers --------------------------------------------------------------

async fn gh_status(State(st): State<AppState>) -> Response {
    match token_get() {
        Some(token) => match gh_get_user(&st.client, &token).await {
            Ok(u) => json_ok(&GhStatus {
                connected: true,
                login: u.get("login").and_then(|v| v.as_str()).map(String::from),
                avatar_url: u.get("avatar_url").and_then(|v| v.as_str()).map(String::from),
            }),
            Err(_) => json_ok(&GhStatus {
                connected: false,
                login: None,
                avatar_url: None,
            }),
        },
        None => json_ok(&GhStatus {
            connected: false,
            login: None,
            avatar_url: None,
        }),
    }
}

async fn gh_connect(State(st): State<AppState>, Json(body): Json<ConnectBody>) -> Response {
    let token = body.token.trim().to_string();
    if token.is_empty() {
        return json_err("token is required", StatusCode::BAD_REQUEST);
    }
    match gh_get_user(&st.client, &token).await {
        Ok(u) => {
            if let Err(e) = token_set(&token) {
                return json_err(&e, StatusCode::INTERNAL_SERVER_ERROR);
            }
            json_ok(&serde_json::json!({
                "ok": true,
                "login": u.get("login").and_then(|v| v.as_str()),
                "avatar_url": u.get("avatar_url").and_then(|v| v.as_str()),
            }))
        }
        Err(e) => json_err(&e, StatusCode::BAD_REQUEST),
    }
}

async fn gh_disconnect(State(_st): State<AppState>) -> Response {
    token_delete();
    json_ok(&serde_json::json!({ "ok": true }))
}

async fn gh_repos(State(st): State<AppState>) -> Response {
    let token = match token_get() {
        Some(t) => t,
        None => return json_err("not connected to github", StatusCode::UNAUTHORIZED),
    };
    match gh_list_repos(&st.client, &token).await {
        Ok(rows) => {
            let mapped: Vec<RepoRow> = rows
                .iter()
                .map(|r| RepoRow {
                    full_name: r.get("full_name").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    clone_url: r.get("clone_url").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    private: r.get("private").and_then(|v| v.as_bool()).unwrap_or(false),
                    default_branch: r.get("default_branch").and_then(|v| v.as_str()).unwrap_or("main").to_string(),
                    updated_at: r.get("updated_at").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                })
                .filter(|r| !r.full_name.is_empty())
                .collect();
            json_ok(&mapped)
        }
        Err(e) => json_err(&e, StatusCode::BAD_GATEWAY),
    }
}

async fn repos_local(State(st): State<AppState>) -> Response {
    let ws = workspace_dir(&st.data_dir);
    let mut out: Vec<LocalRepo> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&ws) {
        for e in entries.flatten() {
            let path = e.path();
            if !path.is_dir() || !path.join(".git").exists() {
                continue;
            }
            let name = e.file_name().to_string_lossy().replace("--", "/");
            let branch = git_branch(&path).await;
            let dirty = git_dirty_count(&path).await;
            out.push(LocalRepo {
                name,
                path: path.display().to_string(),
                branch,
                dirty,
            });
        }
    }
    json_ok(&out)
}

async fn repos_clone(State(st): State<AppState>, Json(body): Json<CloneBody>) -> Response {
    let token = match token_get() {
        Some(t) => t,
        None => return json_err("not connected to github", StatusCode::UNAUTHORIZED),
    };
    let full_name = body.full_name.trim().to_string();
    if full_name.is_empty() {
        return json_err("full_name is required", StatusCode::BAD_REQUEST);
    }
    let clone_url = body
        .clone_url
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("https://github.com/{full_name}.git"));
    let ws = workspace_dir(&st.data_dir);
    if let Err(e) = std::fs::create_dir_all(&ws) {
        return json_err(&format!("workspace dir: {e}"), StatusCode::INTERNAL_SERVER_ERROR);
    }
    let dest = ws.join(safe_name(&full_name));
    if dest.exists() {
        return json_err("already cloned", StatusCode::CONFLICT);
    }
    if let Err(e) = git_clone(&token, &clone_url, &dest).await {
        return json_err(&e, StatusCode::BAD_GATEWAY);
    }
    let branch = git_branch(&dest).await;
    json_ok(&serde_json::json!({
        "ok": true,
        "name": full_name,
        "path": dest.display().to_string(),
        "branch": branch,
    }))
}

async fn repos_refresh(State(st): State<AppState>, Json(body): Json<NameBody>) -> Response {
    let token = match token_get() {
        Some(t) => t,
        None => return json_err("not connected to github", StatusCode::UNAUTHORIZED),
    };
    let name = body.name.trim().to_string();
    let dest = workspace_dir(&st.data_dir).join(safe_name(&name));
    if !dest.is_dir() {
        return json_err("not cloned locally", StatusCode::NOT_FOUND);
    }
    match git_pull(&dest, &token).await {
        Ok(msg) => json_ok(&serde_json::json!({ "ok": true, "output": msg })),
        Err(e) => json_err(&e, StatusCode::BAD_GATEWAY),
    }
}

async fn repos_open(State(st): State<AppState>, Json(body): Json<NameBody>) -> Response {
    // Phase 2: return the local path (Phase 3 binds the repo to a conversation
    // via the backend's repos table + conversations.repo_id).
    let name = body.name.trim().to_string();
    let dest = workspace_dir(&st.data_dir).join(safe_name(&name));
    if !dest.is_dir() {
        return json_err("not cloned locally", StatusCode::NOT_FOUND);
    }
    let branch = git_branch(&dest).await;
    json_ok(&serde_json::json!({ "ok": true, "name": name, "path": dest.display().to_string(), "branch": branch }))
}

// --- router ----------------------------------------------------------------

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/__sidecar/github/status", get(gh_status))
        .route("/__sidecar/github/connect", post(gh_connect))
        .route("/__sidecar/github/disconnect", post(gh_disconnect))
        .route("/__sidecar/github/repos", get(gh_repos))
        .route("/__sidecar/repos/local", get(repos_local))
        .route("/__sidecar/repos/clone", post(repos_clone))
        .route("/__sidecar/repos/refresh", post(repos_refresh))
        .route("/__sidecar/repos/open", post(repos_open))
        .with_state(state)
}

// --- local json helpers ----------------------------------------------------

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

