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
    let head = git_head(&dest).await;
    let tree = top_level_tree(&dest);
    // Push repo context to the backend so the agent loop can inject it into
    // the system prompt for repo-bound conversations. Best-effort: a failure
    // here (e.g. not signed in yet) doesn't fail the clone.
    let _ = push_repo_context(&st, &full_name, &dest, &branch, &head, &tree).await;
    json_ok(&serde_json::json!({
        "ok": true,
        "name": full_name,
        "path": dest.display().to_string(),
        "branch": branch,
        "head": head,
        "tree": tree,
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

// --- File-tool executor (Phase 3: codebase agent) -------------------------

const MAX_OBS_CHARS: usize = 4000;

#[derive(Deserialize)]
struct ExecBody {
    repo: String,
    tool: String,
    args: String,
    #[serde(default)]
    approved: bool,
}

#[derive(Serialize, Default)]
struct ExecResult {
    observation: String,
    preview: String,
    is_error: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    needs_approval: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    approval_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    approval_preview: Option<String>,
}

// repos_exec receives a file-tool call from the renderer (which got it from the
// toolExec SSE event), runs the tool against the local clone, and returns the
// observation. All tools are scoped to the repo root with path-traversal guards.
async fn repos_exec(State(st): State<AppState>, Json(body): Json<ExecBody>) -> Response {
    let repo_name = body.repo.trim().to_string();
    let dest = workspace_dir(&st.data_dir).join(safe_name(&repo_name));
    if !dest.is_dir() {
        return json_ok(&ExecResult {
            observation: format!("Repository {repo_name} is not cloned locally."),
            preview: "repo not found".into(),
            is_error: true,
            ..Default::default()
        });
    }
    let root = match std::fs::canonicalize(&dest) {
        Ok(r) => r,
        Err(e) => return json_ok(&ExecResult { observation: format!("repo dir: {e}"), preview: "error".into(), is_error: true, ..Default::default() }),
    };
    let result = match body.tool.as_str() {
        "read_file" => exec_read_file(&root, &body.args),
        "list_files" => exec_list_files(&root, &body.args),
        "glob" => exec_glob(&root, &body.args),
        "grep" => exec_grep(&root, &body.args),
        "git_status" => exec_git_status(&root).await,
        "apply_patch" => exec_apply_patch(&root, &body.args, body.approved).await,
        "run_command" => exec_run_command(&root, &body.args, body.approved).await,
        other => ExecResult { observation: format!("Unknown tool: {other}"), preview: "unknown tool".into(), is_error: true, ..Default::default() },
    };
    json_ok(&result)
}

// safe_path resolves a repo-relative path and guards against traversal outside
// the repo root. Returns the canonicalized absolute path, or an error.
fn safe_path(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let cleaned = rel.trim_start_matches(['/', '.']);
    let candidate = root.join(cleaned);
    let canon = std::fs::canonicalize(&candidate).map_err(|e| format!("path not found: {e}"))?;
    if !canon.starts_with(root) {
        return Err("path is outside the repository root".into());
    }
    Ok(canon)
}

fn cap(s: &str) -> String {
    if s.len() <= MAX_OBS_CHARS {
        s.to_string()
    } else {
        format!("{}\n...[truncated, {} more chars]", &s[..MAX_OBS_CHARS], s.len() - MAX_OBS_CHARS)
    }
}

fn exec_read_file(root: &Path, args: &str) -> ExecResult {
    let p = match serde_json::from_str::<serde_json::Value>(args) {
        Ok(v) => v.get("path").and_then(|p| p.as_str()).unwrap_or("").to_string(),
        Err(_) => return ExecResult { observation: "Invalid args for read_file.".into(), preview: "bad args".into(), is_error: true,
            ..Default::default()
        },
    };
    if p.is_empty() {
        return ExecResult { observation: "No path provided.".into(), preview: "no path".into(), is_error: true,
            ..Default::default()
        };
    }
    let path = match safe_path(root, &p) {
        Ok(p) => p,
        Err(e) => return ExecResult { observation: e.clone(), preview: e, is_error: true,
            ..Default::default()
        },
    };
    match std::fs::read_to_string(&path) {
        Ok(content) => ExecResult { observation: cap(&content), preview: format!("read {} ({} bytes)", p, content.len()), is_error: false, ..Default::default() },
        Err(e) => ExecResult { observation: format!("Could not read {p}: {e}"), preview: format!("read error: {p}"), is_error: true, ..Default::default() },
    }
}

fn exec_list_files(root: &Path, args: &str) -> ExecResult {
    let subdir = serde_json::from_str::<serde_json::Value>(args)
        .ok()
        .and_then(|v| v.get("path").and_then(|p| p.as_str()).map(String::from))
        .unwrap_or_default();
    let dir = if subdir.trim().is_empty() || subdir == "." {
        root.to_path_buf()
    } else {
        match safe_path(root, &subdir) {
            Ok(p) => p,
            Err(e) => return ExecResult { observation: e.clone(), preview: e, is_error: true,
            ..Default::default()
        },
        }
    };
    if !dir.is_dir() {
        return ExecResult { observation: format!("{subdir} is not a directory."), preview: "not a dir".into(), is_error: true, ..Default::default() };
    }
    let mut entries: Vec<String> = std::fs::read_dir(&dir)
        .map(|rd| rd.filter_map(|e| e.ok())
            .map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                if e.file_type().map(|t| t.is_dir()).unwrap_or(false) { format!("{name}/") } else { name }
            })
            .collect())
        .unwrap_or_default();
    entries.sort();
    let listing = entries.join("\n");
    ExecResult { observation: cap(&listing), preview: format!("{} entries", entries.len()), is_error: false, ..Default::default() }
}

fn exec_glob(root: &Path, args: &str) -> ExecResult {
    let pattern = match serde_json::from_str::<serde_json::Value>(args) {
        Ok(v) => v.get("pattern").and_then(|p| p.as_str()).unwrap_or("").to_string(),
        Err(_) => return ExecResult { observation: "Invalid args for glob.".into(), preview: "bad args".into(), is_error: true,
            ..Default::default()
        },
    };
    if pattern.is_empty() {
        return ExecResult { observation: "No pattern provided.".into(), preview: "no pattern".into(), is_error: true,
            ..Default::default()
        };
    }
    let matches = glob_walk(root, root, &pattern, 0, 1000);
    let result = matches.join("\n");
    ExecResult { observation: cap(&result), preview: format!("{} matches", matches.len()), is_error: false, ..Default::default() }
}

// glob_walk recursively walks the tree and collects paths matching a simple
// glob pattern (supports ** and * wildcards). Capped at max_results.
fn glob_walk(root: &Path, dir: &Path, pattern: &str, depth: usize, max: usize) -> Vec<String> {
    if depth > 15 {
        return vec![];
    }
    let mut out = Vec::new();
    let skip = |name: &str| name.starts_with('.') || name == "node_modules" || name == "target" || name == ".git";
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            if out.len() >= max {
                break;
            }
            let name = e.file_name().to_string_lossy().to_string();
            if skip(&name) {
                continue;
            }
            let path = e.path();
            let rel = path.strip_prefix(root).unwrap_or(&path).display().to_string();
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                out.extend(glob_walk(root, &path, pattern, depth + 1, max - out.len()));
            } else if glob_match(&pattern, &rel) {
                out.push(rel);
            }
        }
    }
    out
}

// glob_match checks if a path matches a simple glob pattern with ** and *.
fn glob_match(pattern: &str, path: &str) -> bool {
    glob_match_segments(pattern.split('/').collect::<Vec<_>>().as_slice(), path.split('/').collect::<Vec<_>>().as_slice())
}

fn glob_match_segments(pat: &[&str], path: &[&str]) -> bool {
    if pat.is_empty() {
        return path.is_empty();
    }
    if pat[0] == "**" {
        if pat.len() == 1 {
            return true; // ** matches everything (including dirs)
        }
        for i in 0..=path.len() {
            if glob_match_segments(&pat[1..], &path[i..]) {
                return true;
            }
        }
        return false;
    }
    if path.is_empty() {
        return false;
    }
    if pat[0] == "*" || pat[0] == path[0] {
        glob_match_segments(&pat[1..], &path[1..])
    } else {
        false
    }
}

fn exec_grep(root: &Path, args: &str) -> ExecResult {
    let v = match serde_json::from_str::<serde_json::Value>(args) {
        Ok(v) => v,
        Err(_) => return ExecResult { observation: "Invalid args for grep.".into(), preview: "bad args".into(), is_error: true,
            ..Default::default()
        },
    };
    let pattern = v.get("pattern").and_then(|p| p.as_str()).unwrap_or("").to_string();
    if pattern.is_empty() {
        return ExecResult { observation: "No pattern provided.".into(), preview: "no pattern".into(), is_error: true,
            ..Default::default()
        };
    }
    let subdir = v.get("path").and_then(|p| p.as_str()).unwrap_or("").to_string();
    let search_root = if subdir.is_empty() { root.to_path_buf() } else { match safe_path(root, &subdir) { Ok(p) => p, Err(e) => return ExecResult { observation: e.clone(), preview: e, is_error: true,
            ..Default::default()
        } } };
    let mut matches = Vec::new();
    grep_walk(root, &search_root, &pattern, &mut matches, 0, 200);
    let result = matches.join("\n");
    ExecResult { observation: cap(&result), preview: format!("{} matches", matches.len()), is_error: false, ..Default::default() }
}

fn grep_walk(root: &Path, dir: &Path, pattern: &str, out: &mut Vec<String>, depth: usize, max: usize) {
    if depth > 15 || out.len() >= max {
        return;
    }
    let skip = |name: &str| name.starts_with('.') || name == "node_modules" || name == "target" || name == ".git";
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            if out.len() >= max {
                break;
            }
            let name = e.file_name().to_string_lossy().to_string();
            if skip(&name) {
                continue;
            }
            let path = e.path();
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                grep_walk(root, &path, pattern, out, depth + 1, max);
            } else if let Ok(content) = std::fs::read_to_string(&path) {
                let rel = path.strip_prefix(root).unwrap_or(&path).display().to_string();
                for (i, line) in content.lines().enumerate() {
                    if line.contains(pattern) {
                        let snippet = if line.len() > 200 { format!("{}...", &line[..200]) } else { line.to_string() };
                        out.push(format!("{rel}:{}: {snippet}", i + 1));
                        if out.len() >= max {
                            break;
                        }
                    }
                }
            }
        }
    }
}

async fn exec_git_status(root: &Path) -> ExecResult {
    let out = tokio::process::Command::new("git")
        .arg("-C").arg(root)
        .arg("status").arg("--porcelain")
        .output().await;
    match out {
        Ok(o) if o.status.success() => {
            let s = String::from_utf8_lossy(&o.stdout).to_string();
            let trimmed = s.trim();
            if trimmed.is_empty() {
                ExecResult { observation: "Working tree clean.".into(), preview: "clean".into(), is_error: false, needs_approval: None, approval_kind: None, approval_preview: None }
            } else {
                ExecResult { observation: cap(trimmed), preview: format!("{} changes", trimmed.lines().count()), is_error: false, needs_approval: None, approval_kind: None, approval_preview: None }
            }
        }
        _ => ExecResult { observation: "git status failed.".into(), preview: "git error".into(), is_error: true, needs_approval: None, approval_kind: None, approval_preview: None },
    }
}

// --- Write tools (Phase 4: per-invocation approval required) ---

// apply_patch applies a unified diff to the repo via `git apply`. The user
// must approve each application: if not approved, returns needs_approval with
// the diff as the preview so the UI can show it. On approval, applies the
// patch and returns the result.
async fn exec_apply_patch(root: &Path, args: &str, approved: bool) -> ExecResult {
    let patch = match serde_json::from_str::<serde_json::Value>(args) {
        Ok(v) => v.get("patch").and_then(|p| p.as_str()).unwrap_or("").to_string(),
        Err(_) => return ExecResult { observation: "Invalid args for apply_patch.".into(), preview: "bad args".into(), is_error: true, needs_approval: None, approval_kind: None, approval_preview: None },
    };
    if patch.is_empty() {
        return ExecResult { observation: "No patch provided.".into(), preview: "no patch".into(), is_error: true, needs_approval: None, approval_kind: None, approval_preview: None };
    }
    if !approved {
        // Return a preview of the diff for the user to approve. Cap it so a
        // huge diff doesn't flood the UI.
        let preview = if patch.len() > 2000 { format!("{}\n...[{} more chars]", &patch[..2000], patch.len() - 2000) } else { patch.clone() };
        return ExecResult {
            observation: String::new(),
            preview: "awaiting approval".into(),
            is_error: false,
            needs_approval: Some(true),
            approval_kind: Some("apply_patch".into()),
            approval_preview: Some(preview),
        };
    }
    // Write the patch to a temp file and apply it with `git apply`.
    let patch_file = root.join(".nas-llm-patch.tmp");
    if let Err(e) = std::fs::write(&patch_file, &patch) {
        return ExecResult { observation: format!("Could not write patch file: {e}"), preview: "write error".into(), is_error: true, needs_approval: None, approval_kind: None, approval_preview: None };
    }
    let out = tokio::process::Command::new("git")
        .arg("-C").arg(root)
        .arg("apply").arg(&patch_file)
        .output().await;
    let _ = std::fs::remove_file(&patch_file);
    match out {
        Ok(o) if o.status.success() => {
            ExecResult { observation: "Patch applied successfully.".into(), preview: "applied".into(), is_error: false, needs_approval: None, approval_kind: None, approval_preview: None }
        }
        Ok(o) => {
            let stderr = String::from_utf8_lossy(&o.stderr).trim().to_string();
            ExecResult { observation: format!("git apply failed: {stderr}"), preview: "apply failed".into(), is_error: true, needs_approval: None, approval_kind: None, approval_preview: None }
        }
        Err(e) => ExecResult { observation: format!("Could not run git: {e}"), preview: "git error".into(), is_error: true, needs_approval: None, approval_kind: None, approval_preview: None },
    }
}

// run_command runs a shell command in the repo root. The user must approve each
// command: if not approved, returns needs_approval with the command as the
// preview. On approval, runs the command and returns its combined stdout+stderr
// (capped). Commands run via `sh -c` in the repo directory.
async fn exec_run_command(root: &Path, args: &str, approved: bool) -> ExecResult {
    let command = match serde_json::from_str::<serde_json::Value>(args) {
        Ok(v) => v.get("command").and_then(|p| p.as_str()).unwrap_or("").to_string(),
        Err(_) => return ExecResult { observation: "Invalid args for run_command.".into(), preview: "bad args".into(), is_error: true, needs_approval: None, approval_kind: None, approval_preview: None },
    };
    if command.is_empty() {
        return ExecResult { observation: "No command provided.".into(), preview: "no command".into(), is_error: true, needs_approval: None, approval_kind: None, approval_preview: None };
    }
    if !approved {
        return ExecResult {
            observation: String::new(),
            preview: "awaiting approval".into(),
            is_error: false,
            needs_approval: Some(true),
            approval_kind: Some("run_command".into()),
            approval_preview: Some(command.clone()),
        };
    }
    let out = tokio::process::Command::new("sh")
        .arg("-c")
        .arg(&command)
        .current_dir(root)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output().await;
    match out {
        Ok(o) => {
            let combined = format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr));
            let trimmed = combined.trim();
            let is_err = !o.status.success();
            let preview = if is_err { format!("exit {}", o.status.code().unwrap_or(-1)) } else { "command completed".into() };
            ExecResult { observation: cap(trimmed), preview, is_error: is_err, needs_approval: None, approval_kind: None, approval_preview: None }
        }
        Err(e) => ExecResult { observation: format!("Could not run command: {e}"), preview: "exec error".into(), is_error: true, needs_approval: None, approval_kind: None, approval_preview: None },
    }
}

// --- Repo context helpers ---

async fn git_head(path: &Path) -> String {
    let out = tokio::process::Command::new("git")
        .arg("-C").arg(path)
        .arg("rev-parse").arg("HEAD")
        .output().await;
    match out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        _ => String::new(),
    }
}

fn top_level_tree(root: &Path) -> Vec<String> {
    std::fs::read_dir(root)
        .map(|rd| rd.filter_map(|e| e.ok())
            .map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                if name.starts_with('.') { return None; }
                if e.file_type().map(|t| t.is_dir()).unwrap_or(false) { Some(format!("{name}/")) } else { Some(name) }
            })
            .flatten()
            .collect())
        .unwrap_or_default()
}

// push_repo_context POSTs the repo context to the backend's /api/repos so the
// agent loop can inject it into the system prompt. Uses the session cookie from
// the sidecar's jar. Best-effort: failures are logged but not surfaced.
async fn push_repo_context(st: &AppState, full_name: &str, dest: &Path, branch: &str, head: &str, tree: &[String]) -> Result<(), String> {
    let backend = st.backend().await;
    let cookie = st.cookie_value().await;
    let url = format!("{}/api/repos", backend.trim_end_matches('/'));
    let body = serde_json::json!({
        "fullName": full_name,
        "localPath": dest.display().to_string(),
        "branch": branch,
        "head": head,
        "tree": tree,
    });
    let mut req = st.client.post(&url).json(&body).timeout(std::time::Duration::from_secs(8));
    if let Some(cv) = cookie {
        req = req.header(reqwest::header::COOKIE, format!("{}={}", crate::sidecar::SESSION_COOKIE, cv));
    }
    match req.send().await {
        Ok(r) if r.status().is_success() => Ok(()),
        Ok(r) => Err(format!("backend returned {}", r.status())),
        Err(e) => Err(e.to_string()),
    }
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
        .route("/__sidecar/repos/exec", post(repos_exec))
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

