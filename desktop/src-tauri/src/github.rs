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
    extract::{Query, State},
    http::{header, HeaderValue, StatusCode},
    response::{sse::{Event, Sse}, IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::convert::Infallible;
use std::path::{Path, PathBuf};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::sync::mpsc;

use futures_util::stream::{iter, unfold, StreamExt};

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

// parse_github_error extracts a human-readable error message from a GitHub API
// error response body (typically {"message": "...", "errors": [...]}).
fn parse_github_error(body: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(body).ok()?;
    if let Some(msg) = v.get("message").and_then(|m| m.as_str()) {
        if let Some(errors) = v.get("errors").and_then(|e| e.as_array()) {
            let details: Vec<String> = errors
                .iter()
                .filter_map(|e| e.get("message").and_then(|m| m.as_str()).map(String::from))
                .collect();
            if !details.is_empty() {
                return Some(format!("{}: {}", msg, details.join("; ")));
            }
        }
        return Some(msg.to_string());
    }
    None
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

// --- repo registry (linked + cloned repos) --------------------------------
//
// A persisted list of repos the desktop app knows about. Cloned (GitHub) repos
// live under workspace_dir; linked repos are existing folders on disk the user
// picked via the folder-picker wizard. Both are resolved by full_name so the
// agent toolExec relay (keyed by repo.FullName) and the file-tool executor
// share one lookup path.

#[derive(Serialize, Deserialize, Clone, Default)]
struct RepoRecord {
    full_name: String,
    path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    remote: Option<String>,
    #[serde(default)]
    branch: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    folder_id: Option<String>,
    #[serde(default)]
    linked: bool,
}

fn registry_path(data_dir: &Path) -> PathBuf {
    data_dir.join("repos.json")
}

fn load_registry(data_dir: &Path) -> Vec<RepoRecord> {
    std::fs::read_to_string(registry_path(data_dir))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("repos").cloned())
        .and_then(|r| serde_json::from_value::<Vec<RepoRecord>>(r).ok())
        .unwrap_or_default()
}

fn save_registry(data_dir: &Path, repos: &[RepoRecord]) {
    let _ = std::fs::write(
        registry_path(data_dir),
        serde_json::json!({ "repos": repos }).to_string(),
    );
}

// upsert_registry inserts or updates a record by full_name, preserving an
// existing folder_id when the record already exists.
fn upsert_registry(data_dir: &Path, rec: &RepoRecord) {
    let mut repos = load_registry(data_dir);
    if let Some(existing) = repos.iter_mut().find(|r| r.full_name == rec.full_name) {
        existing.path = rec.path.clone();
        existing.remote = rec.remote.clone();
        existing.branch = rec.branch.clone();
        existing.linked = rec.linked;
        if rec.folder_id.is_some() {
            existing.folder_id = rec.folder_id.clone();
        }
    } else {
        repos.push(rec.clone());
    }
    save_registry(data_dir, &repos);
}

// resolve_repo finds a repo's local root by full_name: linked/registered repos
// first, then a cloned workspace dir. Returns None if neither exists on disk.
fn resolve_repo(data_dir: &Path, name: &str) -> Option<PathBuf> {
    let trimmed = name.trim();
    for r in load_registry(data_dir) {
        if r.full_name == trimmed && !r.path.is_empty() {
            let p = PathBuf::from(&r.path);
            if p.is_dir() {
                return Some(p);
            }
        }
    }
    let ws = workspace_dir(data_dir).join(safe_name(trimmed));
    if ws.is_dir() {
        return Some(ws);
    }
    None
}

// --- Per-(repo, branch) worktrees (real branch isolation per chat) --------
//
// Two chats on different branches of the same repo used to share one
// checkout, so `repos_branch`/`repos_checkout` (git switch) on one chat would
// silently move another chat's tree too. Git guarantees a branch is checked
// out in at most one worktree, so giving each (repo, branch) pair its own
// worktree under <data_dir>/worktrees/<repo>/<branch> makes that isolation
// real instead of cosmetic. The main tree (the repo's original clone/linked
// folder) is reused whenever it already has the requested branch checked
// out — `git worktree add` would refuse a second checkout of that branch
// anyway, and reusing it is the correct answer, not a fallback.
//
// Known tradeoff, surfaced in the UI rather than worked around here: a fresh
// worktree has no untracked or ignored files, so node_modules, .env and build
// caches are absent until the agent (re-)creates them. Do not try to copy
// those files in — that would defeat the point of an isolated tree (an
// untracked file dropped in a worktree by another process could silently
// leak state between chats).

fn worktrees_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("worktrees")
}

// git_worktree_list parses `git worktree list --porcelain` (run against any
// worktree of a repo — git resolves the whole set from any member) into
// (path, branch) pairs. branch is None for a detached or bare entry.
async fn git_worktree_list(path: &Path) -> Vec<(PathBuf, Option<String>)> {
    let out = tokio::process::Command::new("git")
        .arg("-C").arg(path)
        .arg("worktree").arg("list").arg("--porcelain")
        .output().await;
    let mut result = Vec::new();
    let Ok(o) = out else { return result };
    if !o.status.success() {
        return result;
    }
    let mut cur_path: Option<PathBuf> = None;
    let mut cur_branch: Option<String> = None;
    for line in String::from_utf8_lossy(&o.stdout).lines() {
        if line.is_empty() {
            if let Some(p) = cur_path.take() {
                result.push((p, cur_branch.take()));
            }
            continue;
        }
        if let Some(p) = line.strip_prefix("worktree ") {
            cur_path = Some(PathBuf::from(p));
        } else if let Some(b) = line.strip_prefix("branch ") {
            cur_branch = Some(b.trim_start_matches("refs/heads/").to_string());
        }
    }
    if let Some(p) = cur_path.take() {
        result.push((p, cur_branch.take()));
    }
    result
}

// git_worktree_prune clears stale worktree registrations (e.g. a worktree dir
// that was deleted by hand) so a lookup below never returns a dead path.
async fn git_worktree_prune(path: &Path) {
    let _ = tokio::process::Command::new("git")
        .arg("-C").arg(path)
        .arg("worktree").arg("prune")
        .output().await;
}

// ensure_worktree resolves `branch` for `repo_name` (whose main tree is
// `main`) to a single checkout, creating a worktree on demand. Returns
// (path, created). Cases, in order:
//  1. `branch` is what the main tree (or some other existing worktree)
//     already has checked out -> reuse it. `git worktree list` reports the
//     main tree as an entry too, so this and case 2 share one lookup.
//  2. A worktree for `branch` already exists -> reuse it (after a prune, so a
//     hand-deleted worktree dir doesn't shadow a fresh `add`).
//  3. `branch` exists as a local ref -> `git worktree add <dest> <branch>`.
//  4. `branch` exists only on origin -> tracking checkout via
//     `git worktree add -b <branch> <dest> origin/<branch>`.
//  5. `branch` does not exist anywhere: if `create`, branch off the repo's
//     default branch; otherwise this is an error. Resolving a branch never
//     invents one unless the caller (the dedicated worktree route) asked for
//     that explicitly — repos_exec and the session-panel routes always pass
//     create=false, since a chat's branch should already exist by the time
//     they run.
async fn ensure_worktree(
    data_dir: &Path,
    repo_name: &str,
    main: &Path,
    branch: &str,
    create: bool,
) -> Result<(PathBuf, bool), String> {
    let branch = branch.trim();
    if branch.is_empty() {
        return Ok((main.to_path_buf(), false));
    }
    git_worktree_prune(main).await;
    for (p, b) in git_worktree_list(main).await {
        if b.as_deref() == Some(branch) && p.is_dir() {
            return Ok((p, false));
        }
    }
    let dest = worktrees_dir(data_dir).join(safe_name(repo_name)).join(safe_name(branch));
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("worktree dir: {e}"))?;
    }
    let out = if git_has_ref(main, &format!("refs/heads/{branch}")).await {
        tokio::process::Command::new("git")
            .arg("-C").arg(main)
            .arg("worktree").arg("add").arg(&dest).arg(branch)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output().await
    } else if git_has_ref(main, &format!("refs/remotes/origin/{branch}")).await {
        tokio::process::Command::new("git")
            .arg("-C").arg(main)
            .arg("worktree").arg("add").arg("-b").arg(branch).arg(&dest).arg(format!("origin/{branch}"))
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output().await
    } else if create {
        let base = git_default_branch(main).await;
        tokio::process::Command::new("git")
            .arg("-C").arg(main)
            .arg("worktree").arg("add").arg("-b").arg(branch).arg(&dest).arg(&base)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output().await
    } else {
        return Err(format!("branch '{branch}' does not exist locally or on origin"));
    };
    match out {
        Ok(o) if o.status.success() => Ok((dest, true)),
        Ok(o) => {
            let msg = String::from_utf8_lossy(&o.stderr).trim().to_string();
            Err(if msg.is_empty() { "git worktree add failed".to_string() } else { msg })
        }
        Err(e) => Err(format!("git worktree add: {e}")),
    }
}

// resolve_repo_branch is the shared entry point for branch-aware routes
// (contract 3): resolves `name` to its main tree, then — if `branch` is
// non-empty — to that branch's worktree. An empty branch (older clients, or
// a conversation with no repo_branch) returns exactly what resolve_repo
// returned before this feature existed, so nothing breaks for them. Never
// creates a branch (create=false); that is the dedicated worktree route's job.
async fn resolve_repo_branch(data_dir: &Path, name: &str, branch: &str) -> Result<PathBuf, (StatusCode, String)> {
    let main = match resolve_repo(data_dir, name) {
        Some(p) => p,
        None => return Err((StatusCode::NOT_FOUND, "not found locally".to_string())),
    };
    if branch.trim().is_empty() {
        return Ok(main);
    }
    ensure_worktree(data_dir, name, &main, branch, false)
        .await
        .map(|(p, _created)| p)
        .map_err(|e| (StatusCode::BAD_GATEWAY, e))
}

// --- git helpers: remote, ahead/behind, commit, push ----------------------

async fn git_toplevel(path: &Path) -> Option<PathBuf> {
    let out = tokio::process::Command::new("git")
        .arg("-C")
        .arg(path)
        .arg("rev-parse")
        .arg("--show-toplevel")
        .output()
        .await;
    match out {
        Ok(o) if o.status.success() => {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if s.is_empty() { None } else { Some(PathBuf::from(s)) }
        }
        _ => None,
    }
}

async fn git_remote_url(path: &Path) -> Option<String> {
    let out = tokio::process::Command::new("git")
        .arg("-C")
        .arg(path)
        .arg("remote")
        .arg("get-url")
        .arg("origin")
        .output()
        .await;
    match out {
        Ok(o) if o.status.success() => {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if s.is_empty() { None } else { Some(s) }
        }
        _ => None,
    }
}

async fn git_has_ref(path: &Path, reff: &str) -> bool {
    let out = tokio::process::Command::new("git")
        .arg("-C")
        .arg(path)
        .arg("rev-parse")
        .arg("--verify")
        .arg(reff)
        .output()
        .await;
    matches!(out, Ok(o) if o.status.success())
}

// git_rev_count returns the commit count for a rev-list range (e.g. "A..B"),
// or 0 if git errors (e.g. the range ref does not exist).
async fn git_rev_count(path: &Path, range: &str) -> usize {
    let out = tokio::process::Command::new("git")
        .arg("-C")
        .arg(path)
        .arg("rev-list")
        .arg("--count")
        .arg(range)
        .output()
        .await;
    match out {
        Ok(o) if o.status.success() => {
            String::from_utf8_lossy(&o.stdout).trim().parse::<usize>().unwrap_or(0)
        }
        _ => 0,
    }
}

// git_log_subjects returns up to 20 commit subjects for a rev-list range.
async fn git_log_subjects(path: &Path, range: &str) -> Vec<String> {
    let out = tokio::process::Command::new("git")
        .arg("-C")
        .arg(path)
        .arg("log")
        .arg("--pretty=format:%s")
        .arg(range)
        .output()
        .await;
    match out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout)
            .lines()
            .take(20)
            .map(|l| l.to_string())
            .collect(),
        _ => Vec::new(),
    }
}

// git_default_branch resolves the repo's default branch via
// `git symbolic-ref --short refs/remotes/origin/HEAD`, falling back to "main"
// then "master" if origin/HEAD is not set or git errors.
async fn git_default_branch(path: &Path) -> String {
    let out = tokio::process::Command::new("git")
        .arg("-C")
        .arg(path)
        .arg("symbolic-ref")
        .arg("--short")
        .arg("refs/remotes/origin/HEAD")
        .output()
        .await;
    match out {
        Ok(o) if o.status.success() => {
            let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if let Some(b) = s.strip_prefix("origin/") {
                if !b.is_empty() {
                    return b.to_string();
                }
            }
            if !s.is_empty() {
                return s;
            }
            "main".to_string()
        }
        _ => {
            if git_has_ref(path, "refs/heads/main").await {
                "main".to_string()
            } else if git_has_ref(path, "refs/heads/master").await {
                "master".to_string()
            } else {
                "main".to_string()
            }
        }
    }
}

// git_commit_all stages all changes and commits with the given message.
// token is only used to scrub any captured output. Returns an error string
// (e.g. "nothing to commit") when the commit does not succeed.
async fn git_commit_all(path: &Path, message: &str, token: &str) -> Result<(), String> {
    let add = tokio::process::Command::new("git")
        .arg("-C")
        .arg(path)
        .arg("add")
        .arg("-A")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("git add: {e}"))?;
    if !add.status.success() {
        return Err(scrub(String::from_utf8_lossy(&add.stderr).trim().to_string(), token));
    }
    let commit = tokio::process::Command::new("git")
        .arg("-C")
        .arg(path)
        .arg("commit")
        .arg("-m")
        .arg(message)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .await
        .map_err(|e| format!("git commit: {e}"))?;
    if !commit.status.success() {
        let combined = format!(
            "{}\n{}",
            String::from_utf8_lossy(&commit.stdout),
            String::from_utf8_lossy(&commit.stderr)
        );
        return Err(scrub(combined.trim().to_string(), token));
    }
    Ok(())
}

// git_push pushes HEAD to origin/<branch>. For a github.com https remote, if a
// token is available, push to a token-injected URL so a linked repo without a
// configured credential helper still works; otherwise push via the configured
// origin (SSH keys / credential helper). token is scrubbed from any output.
async fn git_push(path: &Path, branch: &str, token: &str) -> Result<String, String> {
    let remote = git_remote_url(path).await.unwrap_or_default();
    let push_ref = format!("HEAD:{}", branch);
    let out = if !token.is_empty() && is_github_https(&remote) {
        match authed_clone_url(&remote, token) {
            Ok(url) => tokio::process::Command::new("git")
                .arg("-C")
                .arg(path)
                .arg("push")
                .arg(&url)
                .arg(&push_ref)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .output()
                .await,
            Err(_) => tokio::process::Command::new("git")
                .arg("-C")
                .arg(path)
                .arg("push")
                .arg("origin")
                .arg(&push_ref)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .output()
                .await,
        }
    } else {
        tokio::process::Command::new("git")
            .arg("-C")
            .arg(path)
            .arg("push")
            .arg("origin")
            .arg(&push_ref)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output()
            .await
    };
    match out {
        Ok(o) => {
            let combined = format!(
                "{}\n{}",
                String::from_utf8_lossy(&o.stdout),
                String::from_utf8_lossy(&o.stderr)
            );
            if o.status.success() {
                Ok(scrub(combined.trim().to_string(), token))
            } else {
                Err(scrub(combined.trim().to_string(), token))
            }
        }
        Err(e) => Err(format!("git push: {e}")),
    }
}

// --- naming + changelog helpers -------------------------------------------

fn is_github_https(url: &str) -> bool {
    url.starts_with("https://") && url.contains("github.com")
}

// derive_full_name picks a backend key for a linked repo: owner/repo for a
// github.com origin (https or SSH), else the repo root's folder basename.
fn derive_full_name(remote: Option<&str>, root: &Path) -> String {
    if let Some(r) = remote {
        if let Ok(u) = url::Url::parse(r) {
            if u.host_str() == Some("github.com") {
                let path = u.path().trim_start_matches('/');
                let path = path.strip_suffix(".git").unwrap_or(path).trim_end_matches('/');
                if !path.is_empty() {
                    return path.to_string();
                }
            }
        }
        if let Some(rest) = r.strip_prefix("git@github.com:") {
            let path = rest.strip_suffix(".git").unwrap_or(rest).trim_end_matches('/');
            if !path.is_empty() {
                return path.to_string();
            }
        }
    }
    root.file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "repo".to_string())
}

// github_full_name returns Some("owner/repo") when the remote is a github.com
// origin (https or SSH), else None. Used to gate PR creation on github.com.
fn github_full_name(remote: &str) -> Option<String> {
    if let Ok(u) = url::Url::parse(remote) {
        if u.host_str() == Some("github.com") {
            let path = u.path().trim_start_matches('/');
            let path = path.strip_suffix(".git").unwrap_or(path).trim_end_matches('/');
            if !path.is_empty() {
                return Some(path.to_string());
            }
        }
    }
    if let Some(rest) = remote.strip_prefix("git@github.com:") {
        let path = rest.strip_suffix(".git").unwrap_or(rest).trim_end_matches('/');
        if !path.is_empty() {
            return Some(path.to_string());
        }
    }
    None
}

// slugify turns a chat title into a branch-safe slug: lowercase, non-[a-z0-9]
// replaced with `-`, leading/trailing `-` trimmed, fallback "chat", capped at
// ~40 chars. The result is ASCII-only so byte slicing for the cap is safe.
fn slugify(s: &str) -> String {
    let mut slug: String = s
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    slug = slug.trim_matches('-').to_string();
    if slug.is_empty() {
        return "chat".to_string();
    }
    if slug.len() > 40 {
        slug = slug[..40].trim_end_matches('-').to_string();
        if slug.is_empty() {
            slug = "chat".to_string();
        }
    }
    slug
}

// today_ymd returns the current UTC date as YYYY-MM-DD, computed from the Unix
// epoch without a calendar dependency (Howard Hinnant's civil_from_days).
fn today_ymd() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let days = secs.div_euclid(86400);
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = y + if m <= 2 { 1 } else { 0 };
    format!("{:04}-{:02}-{:02}", year, m, d)
}

// write_changelog_entry inserts a Keep-a-Changelog `## [version] - date` section
// with the given (already-bulleted) body above the first existing version
// section, or creates CHANGELOG.md with the standard header if absent.
fn write_changelog_entry(root: &Path, version: &str, date: &str, body: &str) -> Result<(), String> {
    let path = root.join("CHANGELOG.md");
    let section = format!("## [{}] - {}\n\n{}\n\n", version, date, body);
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let new_content = if let Some(idx) = existing.find("## [") {
        let mut s = String::with_capacity(existing.len() + section.len());
        s.push_str(&existing[..idx]);
        s.push_str(&section);
        s.push_str(&existing[idx..]);
        s
    } else if existing.trim().is_empty() {
        format!(
            "# Changelog\n\nAll notable changes to this project are documented in this file.\n\n{}\n",
            section
        )
    } else {
        format!("{}\n{}", existing.trim_end(), section)
    };
    std::fs::write(&path, new_content).map_err(|e| format!("write CHANGELOG.md: {e}"))
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
    #[serde(skip_serializing_if = "Option::is_none")]
    remote: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    full_name: Option<String>,
    #[serde(default)]
    linked: bool,
}

#[derive(Deserialize)]
struct CloneBody {
    full_name: String,
    clone_url: Option<String>,
}

#[derive(Deserialize)]
struct NameBody {
    name: String,
    // Optional per-chat branch (contract 3). Empty/absent preserves the
    // pre-worktree behaviour exactly: act on the repo's shared main tree.
    #[serde(default)]
    branch: String,
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
    let mut out: Vec<LocalRepo> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    // Linked/registered repos first (existing folders + cloned repos that have
    // been recorded in the registry).
    for r in load_registry(&st.data_dir) {
        let path = PathBuf::from(&r.path);
        if !path.is_dir() {
            continue;
        }
        let branch = if r.branch.is_empty() {
            git_branch(&path).await
        } else {
            r.branch.clone()
        };
        let dirty = git_dirty_count(&path).await;
        seen.insert(r.full_name.clone());
        out.push(LocalRepo {
            name: r.full_name.clone(),
            path: path.display().to_string(),
            branch,
            dirty,
            remote: r.remote.clone(),
            full_name: Some(r.full_name.clone()),
            linked: r.linked,
        });
    }
    // Cloned workspace repos not yet in the registry (e.g. cloned before this
    // change). Scanning the workspace dir keeps backward compatibility.
    let ws = workspace_dir(&st.data_dir);
    if let Ok(entries) = std::fs::read_dir(&ws) {
        for e in entries.flatten() {
            let path = e.path();
            if !path.is_dir() || !path.join(".git").exists() {
                continue;
            }
            let name = e.file_name().to_string_lossy().replace("--", "/");
            if seen.contains(&name) {
                continue;
            }
            let branch = git_branch(&path).await;
            let dirty = git_dirty_count(&path).await;
            out.push(LocalRepo {
                name: name.clone(),
                path: path.display().to_string(),
                branch,
                dirty,
                remote: None,
                full_name: Some(name),
                linked: false,
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
    // Record the clone in the sidecar registry and push repo context to the
    // backend so the agent loop can inject it into the system prompt for
    // repo-bound conversations. Best-effort: a failure here (e.g. not signed
    // in yet) doesn't fail the clone.
    upsert_registry(
        &st.data_dir,
        &RepoRecord {
            full_name: full_name.clone(),
            path: dest.display().to_string(),
            remote: Some(clone_url.clone()),
            branch: branch.clone(),
            folder_id: None,
            linked: false,
        },
    );
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
    let name = body.name.trim().to_string();
    let dest = match resolve_repo(&st.data_dir, &name) {
        Some(p) => p,
        None => return json_err("not found locally", StatusCode::NOT_FOUND),
    };
    // The token is only used to scrub captured output; pull uses the repo's
    // configured origin (a cloned repo's origin carries the token; a linked
    // repo uses the user's SSH keys / credential helper).
    let token = token_get().unwrap_or_default();
    match git_pull(&dest, &token).await {
        Ok(msg) => json_ok(&serde_json::json!({ "ok": true, "output": msg })),
        Err(e) => json_err(&e, StatusCode::BAD_GATEWAY),
    }
}

async fn repos_open(State(st): State<AppState>, Json(body): Json<NameBody>) -> Response {
    // Returns the local path and re-pushes repo context to the backend so the
    // agent loop can inject it into the system prompt for repo-bound chats.
    // createRepoChat calls this right before looking the repo up via /api/repos,
    // so re-pushing here makes a re-connect work in one click even when the
    // original clone/add-local push failed (e.g. the sidecar wasn't signed in
    // yet, so the requireAuth-gated POST /api/repos silently 401'd).
    let name = body.name.trim().to_string();
    let dest = match resolve_repo(&st.data_dir, &name) {
        Some(p) => p,
        None => return json_err("not found locally", StatusCode::NOT_FOUND),
    };
    let branch = git_branch(&dest).await;
    let head = git_head(&dest).await;
    let tree = top_level_tree(&dest);
    let _ = push_repo_context(&st, &name, &dest, &branch, &head, &tree).await;
    json_ok(&serde_json::json!({ "ok": true, "name": name, "path": dest.display().to_string(), "branch": branch, "head": head, "tree": tree }))
}

// --- Branch listing + checkout (UI branch switcher) -------------------------

// git_branches returns (current_branch, branches) where each branch is
// (name, is_remote). Uses `git branch -a` so remote-only branches (not yet
// checked out locally) appear too — the UI can offer to track+checkout them.
// Remote names are stripped of the `remotes/<remote>/` prefix; the HEAD symlink
// line and names already present locally are skipped (a local wins over its
// remote twin).
async fn git_branches(path: &Path) -> (String, Vec<(String, bool)>) {
    let out = tokio::process::Command::new("git")
        .arg("-C").arg(path)
        .arg("branch").arg("-a")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output().await;
    let mut current = String::new();
    let mut locals: Vec<String> = Vec::new();
    let mut remote_names: Vec<String> = Vec::new();
    match out {
        Ok(o) if o.status.success() => {
            for line in String::from_utf8_lossy(&o.stdout).lines() {
                let is_cur = line.starts_with("* ");
                let raw = line.trim_start_matches('*').trim().to_string();
                if raw.is_empty() || raw.contains(" -> ") { continue; }
                if let Some(rest) = raw.strip_prefix("remotes/") {
                    if let Some(name) = rest.split_once('/').map(|(_, n)| n.to_string()) {
                        if name == "HEAD" { continue; }
                        remote_names.push(name);
                    }
                    continue;
                }
                if is_cur { current = raw.clone(); }
                locals.push(raw);
            }
        }
        _ => {}
    }
    let local_set: std::collections::HashSet<String> = locals.iter().cloned().collect();
    let mut branches: Vec<(String, bool)> = locals.into_iter().map(|n| (n, false)).collect();
    let mut seen: std::collections::HashSet<String> = local_set;
    for n in remote_names {
        if seen.insert(n.clone()) {
            branches.push((n, true));
        }
    }
    (current, branches)
}

// repos_branches lists the local + remote-only branches of a connected repo,
// marking the current one. Each branch is {name, remote} where remote=true
// means it exists only on the remote (not yet checked out locally) and needs a
// tracking checkout. Used by the UI branch picker.
async fn repos_branches(State(st): State<AppState>, Json(body): Json<NameBody>) -> Response {
    let name = body.name.trim().to_string();
    let dest = match resolve_repo(&st.data_dir, &name) {
        Some(p) => p,
        None => return json_err("not found locally", StatusCode::NOT_FOUND),
    };
    let (current, branches) = git_branches(&dest).await;
    let entries: Vec<serde_json::Value> = branches
        .into_iter()
        .map(|(n, remote)| serde_json::json!({ "name": n, "remote": remote }))
        .collect();
    json_ok(&serde_json::json!({ "ok": true, "current": current, "branches": entries }))
}

#[derive(Deserialize)]
struct CheckoutBody {
    repo: String,
    branch: String,
    #[serde(default)]
    remote: bool,
}

// repos_checkout switches a local repo to a branch. For a local branch it runs
// `git checkout <branch>`; for a remote-only branch (remote=true) it runs
// `git checkout -t origin/<branch>` to create a local tracking branch. Refuses
// to force over a dirty tree (returns the git error so the UI can tell the user
// to commit/stash first). After checkout, re-pushes repo context to the backend
// so the agent loop sees the new branch, and updates the sidecar registry.
async fn repos_checkout(State(st): State<AppState>, Json(body): Json<CheckoutBody>) -> Response {
    let name = body.repo.trim().to_string();
    let branch = body.branch.trim().to_string();
    if branch.is_empty() {
        return json_err("branch is required", StatusCode::BAD_REQUEST);
    }
    let dest = match resolve_repo(&st.data_dir, &name) {
        Some(p) => p,
        None => return json_err("not found locally", StatusCode::NOT_FOUND),
    };
    // Strip any accidental origin/ prefix so we don't pass origin/origin/foo.
    let bare = branch.strip_prefix("origin/").unwrap_or(&branch).to_string();
    let out = if body.remote {
        tokio::process::Command::new("git")
            .arg("-C").arg(&dest)
            .arg("checkout").arg("-t").arg(format!("origin/{bare}"))
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output().await
    } else {
        tokio::process::Command::new("git")
            .arg("-C").arg(&dest)
            .arg("checkout").arg(&bare)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output().await
    };
    match out {
        Ok(o) if o.status.success() => {
            // Refresh registry + backend context so the agent loop + sidebar
            // reflect the new branch.
            let br = git_branch(&dest).await;
            let head = git_head(&dest).await;
            let tree = top_level_tree(&dest);
            if let Some(rec) = load_registry(&st.data_dir).into_iter().find(|r| r.full_name == name) {
                upsert_registry(&st.data_dir, &RepoRecord { branch: br.clone(), ..rec });
            }
            let _ = push_repo_context(&st, &name, &dest, &br, &head, &tree).await;
            json_ok(&serde_json::json!({ "ok": true, "branch": br, "head": head }))
        }
        Ok(o) => {
            let msg = String::from_utf8_lossy(&o.stderr).trim().to_string();
            json_ok(&serde_json::json!({ "ok": false, "error": if msg.is_empty() { "git checkout failed".into() } else { msg } }))
        }
        Err(e) => json_err(&format!("git checkout failed: {e}"), StatusCode::BAD_GATEWAY),
    }
}

// --- Review/undo endpoints (Phase 4: working changes) -----------------------

// repos_diff returns `git diff` (unstaged + staged) for a local clone so the
// user can review agent-made edits in the Working changes panel.
async fn repos_diff(State(st): State<AppState>, Json(body): Json<NameBody>) -> Response {
    let name = body.name.trim().to_string();
    let dest = match resolve_repo_branch(&st.data_dir, &name, &body.branch).await {
        Ok(p) => p,
        Err((status, e)) => return json_err(&e, status),
    };
    let out = tokio::process::Command::new("git")
        .arg("-C").arg(&dest)
        .arg("diff").arg("HEAD")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output().await;
    match out {
        Ok(o) => {
            let diff = String::from_utf8_lossy(&o.stdout).to_string();
            json_ok(&serde_json::json!({ "ok": true, "diff": diff }))
        }
        Err(e) => json_err(&format!("git diff failed: {e}"), StatusCode::BAD_GATEWAY),
    }
}

// repos_revert discards all working-tree changes in a local clone
// (git checkout -- . && git clean -fd) so the user can undo an approved
// patch without a terminal. Returns the git status after reverting.
async fn repos_revert(State(st): State<AppState>, Json(body): Json<NameBody>) -> Response {
    let name = body.name.trim().to_string();
    let dest = match resolve_repo_branch(&st.data_dir, &name, &body.branch).await {
        Ok(p) => p,
        Err((status, e)) => return json_err(&e, status),
    };
    let _ = tokio::process::Command::new("git")
        .arg("-C").arg(&dest)
        .arg("checkout").arg("--").arg(".")
        .output().await;
    let _ = tokio::process::Command::new("git")
        .arg("-C").arg(&dest)
        .arg("clean").arg("-fd")
        .output().await;
    json_ok(&serde_json::json!({ "ok": true }))
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
    // Optional per-chat branch (contract 3): sourced from the toolExec SSE
    // payload's `branch` field. Empty/absent means "use the repo's main tree",
    // matching today's exact behaviour for older clients and branchless chats.
    #[serde(default)]
    branch: String,
    // run_command timeout in milliseconds, carried on the toolExec payload so
    // the backend stays authoritative (RUN_COMMAND_TIMEOUT). 0 = use the
    // sidecar default (120s). Only read by run_command's buffered + streaming
    // executors.
    #[serde(default)]
    run_command_timeout_ms: u64,
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
    // exit_code is set by command-shaped tools (run_command) so the Warp-style
    // command block shows the real exit status; other tools leave it None and
    // the renderer infers it from is_error. 124 signals a run_command timeout.
    #[serde(skip_serializing_if = "Option::is_none")]
    exit_code: Option<i64>,
}

// repos_exec receives a file-tool call from the renderer (which got it from the
// toolExec SSE event), runs the tool against the local clone, and returns the
// observation. All tools are scoped to the repo root with path-traversal guards.
async fn repos_exec(State(st): State<AppState>, Json(body): Json<ExecBody>) -> Response {
    let repo_name = body.repo.trim().to_string();
    let main = match resolve_repo(&st.data_dir, &repo_name) {
        Some(p) => p,
        None => return json_ok(&ExecResult {
            observation: format!("Repository {repo_name} is not available locally."),
            preview: "repo not found".into(),
            is_error: true,
            ..Default::default()
        }),
    };
    // branch (contract 3): resolve to that chat's worktree so its tool calls
    // never land in another chat's checkout. Never auto-creates the branch
    // (create=false) — by the time a toolExec call carries a branch, the
    // renderer has already ensured the worktree exists via /repos/worktree.
    let dest = if body.branch.trim().is_empty() {
        main
    } else {
        match ensure_worktree(&st.data_dir, &repo_name, &main, &body.branch, false).await {
            Ok((p, _created)) => p,
            Err(e) => return json_ok(&ExecResult {
                observation: format!("Branch worktree unavailable: {e}"),
                preview: "worktree error".into(),
                is_error: true,
                ..Default::default()
            }),
        }
    };
    let root = match std::fs::canonicalize(&dest) {
        Ok(r) => r,
        Err(e) => return json_ok(&ExecResult { observation: format!("repo dir: {e}"), preview: "error".into(), is_error: true, ..Default::default() }),
    };
    let result = match body.tool.as_str() {
        "read_file" => exec_read_file(&root, &body.args).await,
        "list_files" => exec_list_files(&root, &body.args).await,
        "tree" => exec_tree(&root, &body.args).await,
        "glob" => exec_glob(&root, &body.args).await,
        "grep" => exec_grep(&root, &body.args).await,
        "git_status" => exec_git_status(&root).await,
        "git_log" => exec_git_log(&root, &body.args).await,
        "list_prs" => exec_list_prs(&st.client, &root, &body.args).await,
        "git_commit" => exec_git_commit(&root, &body.args, body.approved).await,
        "git_push" => exec_git_push(&root, &body.args, body.approved).await,
        "create_pr" => exec_create_pr(&st.client, &root, &body.args, body.approved).await,
        "merge_pr" => exec_merge_pr(&st.client, &root, &body.args, body.approved).await,
        "apply_patch" => exec_apply_patch(&root, &body.args, body.approved).await,
        "run_command" => exec_run_command(&root, &body.args, body.approved, body.run_command_timeout_ms).await,
        "write_file" => exec_write_file(&root, &body.args, body.approved).await,
        "edit_file" => exec_edit_file(&root, &body.args, body.approved).await,
        "delete_path" => exec_delete_path(&root, &body.args, body.approved).await,
        "move_path" => exec_move_path(&root, &body.args, body.approved).await,
        other => ExecResult { observation: format!("Unknown tool: {other}"), preview: "unknown tool".into(), is_error: true, ..Default::default() },
    };
    json_ok(&result)
}

// repos_exec_stream is the streaming variant of repos_exec for run_command
// only: it pipes the command's stdout+stderr to the renderer as SSE `chunk`
// events as they arrive (so the Warp-style command block fills live) and
// finishes with one terminal `exit` event carrying the exit code + wall-clock
// duration. stdin is null so a command that waits for input fails fast instead
// of parking the run until TOOL_EXEC_TIMEOUT. Approval is handled client-side
// (the renderer has the command from the toolExec args and shows Approve/Reject
// in the block); this route runs the command only when approved=true. The
// buffered /repos/exec stays for every other tool and as the fallback.
async fn repos_exec_stream(State(st): State<AppState>, Json(body): Json<ExecBody>) -> Response {
    if body.tool != "run_command" {
        return sse_error("Streaming exec is for run_command only.");
    }
    let repo_name = body.repo.trim().to_string();
    let main = match resolve_repo(&st.data_dir, &repo_name) {
        Some(p) => p,
        None => return sse_error(&format!("Repository {repo_name} is not available locally.")),
    };
    let dest = if body.branch.trim().is_empty() {
        main
    } else {
        match ensure_worktree(&st.data_dir, &repo_name, &main, &body.branch, false).await {
            Ok((p, _created)) => p,
            Err(e) => return sse_error(&format!("Branch worktree unavailable: {e}")),
        }
    };
    let root = match std::fs::canonicalize(&dest) {
        Ok(r) => r,
        Err(e) => return sse_error(&format!("repo dir: {e}")),
    };
    let command = match serde_json::from_str::<serde_json::Value>(&body.args) {
        Ok(v) => v.get("command").and_then(|p| p.as_str()).unwrap_or("").to_string(),
        Err(_) => return sse_error("Invalid args for run_command."),
    };
    if command.is_empty() {
        return sse_error("No command provided.");
    }
    if !body.approved {
        // Approval is handled client-side (inline in the block); refuse to run
        // an unapproved command. The renderer calls /stream only after approve.
        return sse_error("Command not approved.");
    }

    let (tx, rx) = mpsc::channel::<StreamMsg>(64);
    let root_for_task = root.clone();
    let command_for_task = command.clone();
    let timeout_for_task = if body.run_command_timeout_ms == 0 { 120_000 } else { body.run_command_timeout_ms };
    tokio::spawn(async move {
        let start = std::time::Instant::now();
        let mut child = match tokio::process::Command::new("sh")
            .arg("-c")
            .arg(&command_for_task)
            .current_dir(&root_for_task)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                let _ = tx.send(StreamMsg::Chunk(format!("Could not run command: {e}\n"))).await;
                let _ = tx.send(StreamMsg::Exit(-1, 0)).await;
                return;
            }
        };
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let stdout_task = tokio::spawn(pipe_lines(stdout, tx.clone()));
        let stderr_task = tokio::spawn(pipe_lines(stderr, tx.clone()));
        let limit = std::time::Duration::from_millis(timeout_for_task);
        let status = match tokio::time::timeout(limit, child.wait()).await {
            Ok(s) => s,
            Err(_) => {
                // Timed out: kill the child, flush a note, and emit exit 124.
                let _ = child.kill().await;
                let _ = stdout_task.await;
                let _ = stderr_task.await;
                let _ = tx.send(StreamMsg::Chunk(format!("\n[command timed out after {}s — killed]\n", timeout_for_task / 1000))).await;
                let _ = tx.send(StreamMsg::Exit(124, start.elapsed().as_millis() as i64)).await;
                return;
            }
        };
        let _ = stdout_task.await;
        let _ = stderr_task.await;
        let dur = start.elapsed().as_millis() as i64;
        let code = status.ok().and_then(|s| s.code()).unwrap_or(-1) as i64;
        let _ = tx.send(StreamMsg::Exit(code, dur)).await;
    });

    let sse_stream = unfold(rx, |mut rx| async move {
        rx.recv().await.map(|msg| (msg, rx))
    })
    .map(|msg| -> Result<Event, Infallible> { Ok(stream_msg_to_event(msg)) });
    Sse::new(sse_stream).into_response()
}

// StreamMsg is one frame of the streaming exec SSE: a piped output chunk, or the
// terminal exit carrying the command's exit code + wall-clock duration.
enum StreamMsg {
    Chunk(String),
    Exit(i64, i64),
}

fn stream_msg_to_event(msg: StreamMsg) -> Event {
    match msg {
        StreamMsg::Chunk(text) => Event::default().event("chunk").data(serde_json::json!({ "text": text }).to_string()),
        StreamMsg::Exit(code, dur) => Event::default().event("exit").data(serde_json::json!({ "code": code, "durationMs": dur }).to_string()),
    }
}

// sse_error short-circuits a pre-execution failure as a one-shot SSE stream
// (one chunk with the error text, then a terminal exit with no code) so the
// renderer always sees the same text/event-stream shape from /repos/exec/stream.
fn sse_error(msg: &str) -> Response {
    let sse_stream = iter(vec![
        StreamMsg::Chunk(format!("{msg}\n")),
        StreamMsg::Exit(-1, 0),
    ])
    .map(|msg| -> Result<Event, Infallible> { Ok(stream_msg_to_event(msg)) });
    Sse::new(sse_stream).into_response()
}

// pipe_lines reads a child's piped stream line-by-line and forwards each line
// (with its trailing newline) as a Chunk. Returns at EOF (the child closed the
// pipe), so joining the two pipe tasks before sending the terminal exit
// guarantees all output is flushed before the exit event.
async fn pipe_lines<R: AsyncRead + Unpin + Send>(reader: R, tx: mpsc::Sender<StreamMsg>) {
    let mut reader = BufReader::new(reader);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf).await {
            Ok(0) => break,
            Ok(_) => {
                let text = String::from_utf8_lossy(&buf).to_string();
                if tx.send(StreamMsg::Chunk(text)).await.is_err() {
                    break;
                }
            }
            Err(_) => break,
        }
    }
}

// safe_path resolves a repo-relative path and guards against traversal outside
// the repo root. Returns the canonicalized absolute path, or an error. Only
// resolves paths that already exist (it canonicalizes), so it suits read/edit/
// move-source tools; create-oriented tools (write_file, move destination) use
// resolve_new_path instead.
fn safe_path(root: &Path, rel: &str) -> Result<PathBuf, String> {
    // Strip a leading "/" and any "./" prefix, but keep a leading "." that is
    // part of a real name like ".gitignore" or ".env" (trim_start_matches(['/',
    // '.']) would eat the dot and turn ".env" into "env", making every
    // root-level dotfile unreadable). Mirrors resolve_new_path's dot handling.
    let stripped = rel.trim_start_matches('/');
    let cleaned = stripped.strip_prefix("./").unwrap_or(stripped);
    if cleaned.is_empty() {
        return Err("no path provided".into());
    }
    let norm = cleaned.replace('\\', "/");
    if norm == ".git" || norm.starts_with(".git/") {
        return Err("paths inside .git are not allowed".into());
    }
    for comp in std::path::Path::new(&norm).components() {
        if matches!(comp, std::path::Component::ParentDir) {
            return Err("path traversal (..) is not allowed".into());
        }
    }
    let candidate = root.join(cleaned);
    let canon = std::fs::canonicalize(&candidate).map_err(|e| format!("path not found: {e}"))?;
    if !canon.starts_with(root) {
        return Err("path is outside the repository root".into());
    }
    Ok(canon)
}

// resolve_new_path resolves a repo-relative path that may NOT yet exist (for
// create/overwrite/move-destination tools). Unlike safe_path it canonicalizes
// only the longest existing ancestor and rejoins the non-existent tail, so a
// path whose parent directories don't exist yet is still resolvable. Rejects
// any `..` component (a create tool must not escape the repo root via a
// relative traversal, and canonicalize can't catch it when the path doesn't
// exist yet) and any path inside `.git/`. Creates no directories.
fn resolve_new_path(root: &Path, rel: &str) -> Result<PathBuf, String> {
    // Strip a leading "/" and any "./" prefix, but keep a leading "." that is
    // part of a real name like ".git" or ".env" (trim_start_matches(['/','.'])
    // would eat the "." in ".git" and let the guard below miss it).
    let stripped = rel.trim_start_matches('/');
    let cleaned = stripped.strip_prefix("./").unwrap_or(stripped);
    if cleaned.is_empty() {
        return Err("no path provided".into());
    }
    let norm = cleaned.replace('\\', "/");
    if norm == ".git" || norm.starts_with(".git/") {
        return Err("paths inside .git are not allowed".into());
    }
    // Reject any `..` component — canonicalize can't guard a non-existent path.
    for comp in std::path::Path::new(&norm).components() {
        if matches!(comp, std::path::Component::ParentDir) {
            return Err("path traversal (..) is not allowed".into());
        }
    }
    let candidate = root.join(cleaned);
    // Walk existing ancestors upward until one canonicalizes, collecting the
    // non-existent tail. root itself always exists and is already canonical.
    let mut existing = candidate.clone();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    loop {
        match std::fs::canonicalize(&existing) {
            Ok(c) => {
                if !c.starts_with(root) {
                    return Err("path is outside the repository root".into());
                }
                let mut full = c;
                for part in tail.into_iter().rev() {
                    full.push(part);
                }
                return Ok(full);
            }
            Err(_) => {
                if existing.as_path() == root {
                    // None of the path exists yet; anchor at the (canonical) root.
                    return Ok(candidate.clone());
                }
                match existing.file_name() {
                    Some(name) => {
                        tail.push(name.to_os_string());
                        existing = match existing.parent() {
                            Some(p) => p.to_path_buf(),
                            None => return Err("path is outside the repository root".into()),
                        };
                    }
                    None => return Err("path is outside the repository root".into()),
                }
            }
        }
    }
}

// cap_preview truncates a string to max bytes on a UTF-8 char boundary and
// appends an overflow marker. Used for approval-dialog previews that could be
// large (diffs, file contents).
fn cap_preview(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n...[{} more chars]", &s[..end], s.len() - end)
}

// count_matches counts non-overlapping occurrences of needle in haystack.
fn count_matches(haystack: &str, needle: &str) -> usize {
    if needle.is_empty() {
        return 0;
    }
    let mut count = 0;
    let mut start = 0;
    while let Some(idx) = haystack[start..].find(needle) {
        count += 1;
        start += idx + needle.len();
        if start > haystack.len() {
            break;
        }
    }
    count
}

// unified_diff builds a unified-diff preview of old vs new file content for the
// approval dialog. It trims the common prefix and suffix lines and emits the
// differing middle as -/+ lines with up to one line of context on each side,
// so the existing colored-diff renderer (renderApprovalContent) works
// unchanged. Preview-only: the actual write uses the full content.
fn unified_diff(old: &str, new: &str, path: &str) -> String {
    fn to_lines<'a>(s: &'a str) -> Vec<&'a str> {
        let mut v: Vec<&'a str> = s.split('\n').collect();
        if s.ends_with('\n') {
            v.pop();
        }
        v
    }
    let ol = to_lines(old);
    let nl = to_lines(new);
    let mut pre = 0;
    while pre < ol.len() && pre < nl.len() && ol[pre] == nl[pre] {
        pre += 1;
    }
    let mut suf = 0;
    while suf < (ol.len() - pre) && suf < (nl.len() - pre) && ol[ol.len() - 1 - suf] == nl[nl.len() - 1 - suf] {
        suf += 1;
    }
    let old_mid = &ol[pre..ol.len() - suf];
    let new_mid = &nl[pre..nl.len() - suf];
    let mut out = String::new();
    out.push_str(&format!("--- a/{path}\n+++ b/{path}\n"));
    if old_mid.is_empty() && new_mid.is_empty() {
        return out; // identical — no hunk
    }
    let has_ctx_pre = pre > 0;
    let has_ctx_suf = suf > 0;
    let old_start = if has_ctx_pre { pre } else { pre + 1 };
    let new_start = old_start;
    let old_count = old_mid.len() + has_ctx_pre as usize + has_ctx_suf as usize;
    let new_count = new_mid.len() + has_ctx_pre as usize + has_ctx_suf as usize;
    out.push_str(&format!("@@ -{old_start},{old_count} +{new_start},{new_count} @@\n"));
    if has_ctx_pre {
        out.push(' ');
        out.push_str(ol[pre - 1]);
        out.push('\n');
    }
    for line in old_mid {
        out.push('-');
        out.push_str(line);
        out.push('\n');
    }
    for line in new_mid {
        out.push('+');
        out.push_str(line);
        out.push('\n');
    }
    if has_ctx_suf {
        out.push(' ');
        out.push_str(ol[ol.len() - suf]);
        out.push('\n');
    }
    out
}

fn cap(s: &str) -> String {
    if s.len() <= MAX_OBS_CHARS {
        s.to_string()
    } else {
        format!("{}\n...[truncated, {} more chars]", &s[..MAX_OBS_CHARS], s.len() - MAX_OBS_CHARS)
    }
}

// git_ignored_set returns (ignored_files, ignored_dirs) as repo-relative paths
// via `git ls-files --others -i --exclude-standard --directory -z`. `--directory`
// collapses a wholly-ignored directory into one `dir/` entry so a walk can prune
// it without enumerating its contents; individual ignored files in otherwise-
// tracked directories are listed by path. Empty on a fresh worktree (no ignored
// files are materialized) — correct, since those files aren't on disk to walk.
// A failed/missing git invocation yields empty sets (tools list everything),
// never an error, so a non-git repo degrades gracefully.
async fn git_ignored_set(root: &Path) -> (HashSet<String>, HashSet<String>) {
    let out = tokio::process::Command::new("git")
        .arg("-C").arg(root)
        .arg("ls-files").arg("--others").arg("-i")
        .arg("--exclude-standard").arg("--directory").arg("-z")
        .output().await;
    let mut files = HashSet::new();
    let mut dirs = HashSet::new();
    if let Ok(o) = out {
        if o.status.success() {
            for part in String::from_utf8_lossy(&o.stdout).split('\0') {
                let p = part.trim();
                if p.is_empty() {
                    continue;
                }
                if let Some(d) = p.strip_suffix('/') {
                    dirs.insert(d.to_string());
                } else {
                    files.insert(p.to_string());
                }
            }
        }
    }
    (files, dirs)
}

// git_check_ignore reports whether a single resolved path is gitignored, via
// `git check-ignore --quiet <rel>`. It classifies by name, so it catches a path
// that does not exist on disk (a fresh worktree has no .env, but .env is still
// ignored). Used by read_file to refuse secrets.
async fn git_check_ignore(root: &Path, abs_path: &Path) -> bool {
    let rel = match abs_path.strip_prefix(root) {
        Ok(r) => r.to_string_lossy().to_string(),
        Err(_) => return false,
    };
    let out = tokio::process::Command::new("git")
        .arg("-C").arg(root)
        .arg("check-ignore").arg("--quiet").arg(&rel)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status().await;
    matches!(out, Ok(s) if s.success())
}

// is_ignored reports whether a repo-relative path is gitignored, using a
// precomputed ignore set from git_ignored_set. A path is ignored if it is an
// ignored file, an ignored directory, or lives beneath an ignored directory.
fn is_ignored(rel: &str, files: &HashSet<String>, dirs: &HashSet<String>) -> bool {
    if files.contains(rel) || dirs.contains(rel) {
        return true;
    }
    let mut p = rel;
    while let Some(i) = p.rfind('/') {
        let ancestor = &p[..i];
        if dirs.contains(ancestor) {
            return true;
        }
        p = ancestor;
    }
    false
}

async fn exec_read_file(root: &Path, args: &str) -> ExecResult {
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
    // Refuse gitignored paths (e.g. .env): they are secrets, and in a per-branch
    // worktree they are absent anyway. git check-ignore classifies by name, so
    // this fires whether or not the file is materialized on disk.
    if git_check_ignore(root, &path).await {
        return ExecResult {
            observation: format!("{p} is gitignored and not materialized in this isolated worktree; it is a secret and won't be read. See .gitignore."),
            preview: "ignored (secret)".into(),
            is_error: true,
            ..Default::default()
        };
    }
    match std::fs::read_to_string(&path) {
        Ok(content) => ExecResult { observation: cap(&content), preview: format!("read {} ({} bytes)", p, content.len()), is_error: false, ..Default::default() },
        Err(e) => ExecResult { observation: format!("Could not read {p}: {e}"), preview: format!("read error: {p}"), is_error: true, ..Default::default() },
    }
}

async fn exec_list_files(root: &Path, args: &str) -> ExecResult {
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
    let (files, dirs) = git_ignored_set(root).await;
    let mut entries: Vec<String> = std::fs::read_dir(&dir)
        .map(|rd| rd.filter_map(|e| e.ok())
            .map(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
                let suffix = if is_dir { "/" } else { "" };
                let path = e.path();
                let rel = path.strip_prefix(root).unwrap_or(&path).display().to_string();
                if is_ignored(&rel, &files, &dirs) {
                    format!("{name}{suffix} (ignored)")
                } else {
                    format!("{name}{suffix}")
                }
            })
            .collect())
        .unwrap_or_default();
    entries.sort();
    let listing = entries.join("\n");
    ExecResult { observation: cap(&listing), preview: format!("{} entries", entries.len()), is_error: false, ..Default::default() }
}

async fn exec_glob(root: &Path, args: &str) -> ExecResult {
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
    let (files, dirs) = git_ignored_set(root).await;
    let matches = glob_walk(root, root, &pattern, 0, 1000, &files, &dirs);
    let result = matches.join("\n");
    ExecResult { observation: cap(&result), preview: format!("{} matches", matches.len()), is_error: false, ..Default::default() }
}

// glob_walk recursively walks the tree and collects paths matching a simple
// glob pattern (supports ** and * wildcards). Capped at max_results. Dotfiles
// are NOT skipped (so .gitignore/.env.example are findable); only .git,
// node_modules, and target are pruned as noise. Gitignored matches are returned
// with an " (ignored)" suffix so the agent learns they exist without reading
// them; ignored directories are not recursed into.
fn glob_walk(root: &Path, dir: &Path, pattern: &str, depth: usize, max: usize, files: &HashSet<String>, dirs: &HashSet<String>) -> Vec<String> {
    if depth > 15 {
        return vec![];
    }
    let mut out = Vec::new();
    let skip = |name: &str| name == ".git" || name == "node_modules" || name == "target";
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
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if is_ignored(&rel, files, dirs) {
                if glob_match(pattern, &rel) {
                    out.push(if is_dir { format!("{rel}/ (ignored)") } else { format!("{rel} (ignored)") });
                }
                continue;
            }
            if is_dir {
                out.extend(glob_walk(root, &path, pattern, depth + 1, max - out.len(), files, dirs));
            } else if glob_match(pattern, &rel) {
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

async fn exec_grep(root: &Path, args: &str) -> ExecResult {
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
    let (files, dirs) = git_ignored_set(root).await;
    let mut matches = Vec::new();
    grep_walk(root, &search_root, &pattern, &mut matches, 0, 200, &files, &dirs);
    let result = matches.join("\n");
    ExecResult { observation: cap(&result), preview: format!("{} matches", matches.len()), is_error: false, ..Default::default() }
}

fn grep_walk(root: &Path, dir: &Path, pattern: &str, out: &mut Vec<String>, depth: usize, max: usize, files: &HashSet<String>, dirs: &HashSet<String>) {
    if depth > 15 || out.len() >= max {
        return;
    }
    let skip = |name: &str| name == ".git" || name == "node_modules" || name == "target";
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
            // Never open gitignored files (secrets) and don't descend into
            // ignored directories.
            if is_ignored(&rel, files, dirs) {
                continue;
            }
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                grep_walk(root, &path, pattern, out, depth + 1, max, files, dirs);
            } else if let Ok(content) = std::fs::read_to_string(&path) {
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

async fn exec_tree(root: &Path, args: &str) -> ExecResult {
    let v = match serde_json::from_str::<serde_json::Value>(args) {
        Ok(v) => v,
        Err(_) => return ExecResult { observation: "Invalid args for tree.".into(), preview: "bad args".into(), is_error: true, ..Default::default() },
    };
    let subdir = v.get("path").and_then(|p| p.as_str()).unwrap_or("").trim().to_string();
    let depth = v
        .get("depth")
        .and_then(|d| d.as_u64())
        .filter(|d| *d > 0)
        .unwrap_or(3)
        .min(6) as usize;
    let dir = if subdir.is_empty() || subdir == "." {
        root.to_path_buf()
    } else {
        match safe_path(root, &subdir) {
            Ok(p) => p,
            Err(e) => return ExecResult { observation: e.clone(), preview: e, is_error: true, ..Default::default() },
        }
    };
    if !dir.is_dir() {
        return ExecResult { observation: format!("{subdir} is not a directory."), preview: "not a dir".into(), is_error: true, ..Default::default() };
    }
    let (files, dirs) = git_ignored_set(root).await;
    let mut out: Vec<String> = Vec::new();
    tree_walk(root, &dir, "", 0, depth, &mut out, &files, &dirs);
    out.sort();
    if out.len() > 1000 {
        out.truncate(1000);
    }
    let result = out.join("\n");
    ExecResult { observation: cap(&result), preview: format!("{} entries", out.len()), is_error: false, ..Default::default() }
}

// tree_walk collects a depth-limited recursive listing of repo-relative paths
// into out (directories suffixed with /). .git/node_modules/target are pruned
// as noise; gitignored entries are emitted with an " (ignored)" suffix and not
// recursed into. rel_prefix is the repo-relative path of dir ("" for root).
fn tree_walk(root: &Path, dir: &Path, rel_prefix: &str, depth: usize, max_depth: usize, out: &mut Vec<String>, files: &HashSet<String>, dirs: &HashSet<String>) {
    if depth >= max_depth {
        return;
    }
    let rd = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return,
    };
    let mut entries: Vec<(String, bool, PathBuf)> = Vec::new();
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name == ".git" || name == "node_modules" || name == "target" {
            continue;
        }
        let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
        entries.push((name, is_dir, e.path()));
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    for (name, is_dir, path) in entries {
        let rel = if rel_prefix.is_empty() { name.clone() } else { format!("{rel_prefix}/{name}") };
        if is_ignored(&rel, files, dirs) {
            out.push(if is_dir { format!("{rel}/ (ignored)") } else { format!("{rel} (ignored)") });
            continue;
        }
        if is_dir {
            out.push(format!("{rel}/"));
            tree_walk(root, &path, &rel, depth + 1, max_depth, out, files, dirs);
        } else {
            out.push(rel);
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
                ExecResult { observation: "Working tree clean.".into(), preview: "clean".into(), is_error: false, ..Default::default() }
            } else {
                ExecResult { observation: cap(trimmed), preview: format!("{} changes", trimmed.lines().count()), is_error: false, ..Default::default() }
            }
        }
        _ => ExecResult { observation: "git status failed.".into(), preview: "git error".into(), is_error: true, ..Default::default() },
    }
}

// exec_git_log returns the last N commits (sha, author, date, subject) on the
// current branch. Read-only — runs immediately, never approval-gated. Optional
// `count` (default 20, clamped 1..=100) and `path` (repo-relative pathspec).
async fn exec_git_log(root: &Path, args: &str) -> ExecResult {
    let (count, path) = match serde_json::from_str::<serde_json::Value>(args) {
        Ok(v) => {
            let count = v
                .get("count")
                .and_then(|c| c.as_u64())
                .filter(|c| *c > 0)
                .unwrap_or(20)
                .min(100) as usize;
            let path = v
                .get("path")
                .and_then(|p| p.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            (count, path)
        }
        Err(_) => return ExecResult {
            observation: "Invalid args for git_log.".into(),
            preview: "bad args".into(),
            is_error: true,
            ..Default::default()
        },
    };
    let count_str = count.to_string();
    let mut cmd = tokio::process::Command::new("git");
    cmd.arg("-C")
        .arg(root)
        .arg("log")
        .arg("-n")
        .arg(&count_str)
        .arg("--pretty=format:%H | %an | %ad | %s")
        .arg("--date=short");
    if !path.is_empty() {
        // The `--` separator keeps a pathspec that looks like a flag safe.
        cmd.arg("--").arg(&path);
    }
    let out = cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .await;
    match out {
        Ok(o) if o.status.success() => {
            let s = String::from_utf8_lossy(&o.stdout).to_string();
            let trimmed = s.trim();
            if trimmed.is_empty() {
                ExecResult {
                    observation: "No commits on this branch yet.".into(),
                    preview: "no commits".into(),
                    is_error: false,
                    ..Default::default()
                }
            } else {
                ExecResult {
                    observation: cap(trimmed),
                    preview: format!("{} commits", trimmed.lines().count()),
                    is_error: false,
                    ..Default::default()
                }
            }
        }
        Ok(o) => {
            let stderr = String::from_utf8_lossy(&o.stderr).trim().to_string();
            // An unborn branch (no commits yet) exits non-zero; surface the
            // same friendly message the empty-stdout path returns.
            if stderr.contains("does not have any commits yet") {
                return ExecResult {
                    observation: "No commits on this branch yet.".into(),
                    preview: "no commits".into(),
                    is_error: false,
                    ..Default::default()
                };
            }
            ExecResult {
                observation: format!(
                    "git log failed: {}",
                    if stderr.is_empty() { "unknown error" } else { &stderr }
                ),
                preview: "git error".into(),
                is_error: true,
                ..Default::default()
            }
        }
        Err(e) => ExecResult {
            observation: format!("Could not run git: {e}"),
            preview: "git error".into(),
            is_error: true,
            ..Default::default()
        },
    }
}

// --- Write tools (Phase 4: per-invocation approval required) ---

// normalize_patch cleans up a unified diff a small model emitted before
// handing it to `git apply`: normalizes CRLF to LF, strips markdown code fences
// and any prose preamble before the first `--- `/`diff --git ` header, and
// guarantees exactly one trailing newline. These are the routine small-model
// failure shapes that strict `git apply` rejects ("corrupt patch at line N").
fn normalize_patch(patch: &str) -> String {
    let mut s = patch.replace("\r\n", "\n").replace('\r', "\n");
    // Strip markdown code fences (``` or ```diff …), keeping their interior.
    let mut out = String::with_capacity(s.len());
    for line in s.split_inclusive('\n') {
        let body = line.strip_suffix('\n').unwrap_or(line);
        let t = body.trim_start();
        if t.starts_with("```")
            && t.trim().chars().all(|c| c == '`' || c.is_alphanumeric() || c == '_' || c == '-')
        {
            continue;
        }
        out.push_str(line);
    }
    s = out;
    // Drop prose preamble before the first diff header line.
    for needle in ["--- ", "diff --git "] {
        if let Some(pos) = s.find(needle) {
            if pos == 0 || s.as_bytes()[pos - 1] == b'\n' {
                s = s[pos..].to_string();
                break;
            }
        }
    }
    let trimmed = s.trim_end_matches('\n');
    format!("{trimmed}\n")
}

// first_failing_hunk extracts the first @@ hunk header mentioned in a git apply
// error message so the model can locate the failing hunk. Returns "" if none.
fn first_failing_hunk(err: &str) -> String {
    match err.find("@@ ") {
        Some(i) => err[i..].split('\n').next().unwrap_or("").to_string(),
        None => String::new(),
    }
}

// apply_patch applies a unified diff to the repo via `git apply`. The user
// must approve each application: if not approved, returns needs_approval with
// the normalized diff as the preview. On approval, normalizes the patch, tries
// an apply ladder (first success wins), and on success reports the files +
// line counts via `git apply --numstat`; on failure, returns the git error +
// the first failing hunk header and an explicit instruction to switch to
// write_file/edit_file rather than re-emitting the same diff.
async fn exec_apply_patch(root: &Path, args: &str, approved: bool) -> ExecResult {
    let patch = match serde_json::from_str::<serde_json::Value>(args) {
        Ok(v) => v.get("patch").and_then(|p| p.as_str()).unwrap_or("").to_string(),
        Err(_) => return ExecResult { observation: "Invalid args for apply_patch.".into(), preview: "bad args".into(), is_error: true, ..Default::default() },
    };
    if patch.is_empty() {
        return ExecResult { observation: "No patch provided.".into(), preview: "no patch".into(), is_error: true, ..Default::default() };
    }
    let normalized = normalize_patch(&patch);
    if !approved {
        return ExecResult {
            observation: String::new(),
            preview: "awaiting approval".into(),
            is_error: false,
            needs_approval: Some(true),
            approval_kind: Some("apply_patch".into()),
            approval_preview: Some(cap_preview(&normalized, 2000)),
            ..Default::default()
        };
    }
    let patch_file = root.join(".nas-llm-patch.tmp");
    if let Err(e) = std::fs::write(&patch_file, &normalized) {
        return ExecResult { observation: format!("Could not write patch file: {e}"), preview: "write error".into(), is_error: true, ..Default::default() };
    }
    // Apply ladder, first success wins: plain → --recount (fixes wrong hunk
    // line counts) → --3way (tolerates context drift via a 3-way merge) →
    // --recount --unidiff-zero -C0 (no-context hunks, ignores whitespace).
    let ladders: &[&[&str]] = &[
        &["apply"],
        &["apply", "--recount", "--whitespace=nowarn"],
        &["apply", "--3way"],
        &["apply", "--recount", "--unidiff-zero", "-C0"],
    ];
    let mut applied = false;
    let mut last_err = String::new();
    let mut succeeded_via = String::new();
    for rung in ladders {
        let out = tokio::process::Command::new("git")
            .arg("-C").arg(root)
            .args(*rung)
            .arg(&patch_file)
            .output().await;
        match out {
            Ok(o) if o.status.success() => { applied = true; succeeded_via = rung.join(" "); break; }
            Ok(o) => { last_err = String::from_utf8_lossy(&o.stderr).trim().to_string(); }
            Err(e) => { last_err = format!("Could not run git: {e}"); }
        }
    }
    let _ = std::fs::remove_file(&patch_file);
    if applied {
        // Report which files and line counts changed (--numstat is a dry-run
        // stat computed from the patch, not the worktree, so it's safe to run
        // after the apply already succeeded).
        let numstat = tokio::process::Command::new("git")
            .arg("-C").arg(root)
            .arg("apply").arg("--numstat").arg(&patch_file)
            .output().await;
        let stat = match numstat {
            Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).trim().to_string(),
            _ => String::new(),
        };
        let via = if succeeded_via == "apply" { String::new() } else { format!(" (via git {succeeded_via})") };
        let obs = if stat.is_empty() {
            format!("Patch applied successfully.{via}")
        } else {
            format!("Patch applied successfully.{via}\n{stat}")
        };
        ExecResult { observation: obs, preview: "applied".into(), is_error: false, ..Default::default() }
    } else {
        let hunk = first_failing_hunk(&last_err);
        let hunk_part = if hunk.is_empty() { String::new() } else { format!("\nFirst failing hunk: {hunk}") };
        ExecResult {
            observation: format!("git apply failed: {last_err}{hunk_part}\nThe file is unchanged. Repeating the identical patch will fail the same way. For a single-file edit, use edit_file (exact string replacement) or write_file (create/overwrite) instead of re-emitting a diff."),
            preview: "apply failed".into(),
            is_error: true,
            ..Default::default()
        }
    }
}

// write_file creates or overwrites a file, creating parent directories.
// Approval-gated: the first call returns a unified-diff preview (empty→content
// for a new file, old→new for an overwrite); on approval the write runs and the
// observation reports created-vs-overwritten plus byte and line counts.
async fn exec_write_file(root: &Path, args: &str, approved: bool) -> ExecResult {
    let v = match serde_json::from_str::<serde_json::Value>(args) {
        Ok(v) => v,
        Err(_) => return ExecResult { observation: "Invalid args for write_file.".into(), preview: "bad args".into(), is_error: true, ..Default::default() },
    };
    let path = v.get("path").and_then(|p| p.as_str()).unwrap_or("").trim().to_string();
    let content = v.get("content").and_then(|c| c.as_str()).unwrap_or("").to_string();
    if path.is_empty() {
        return ExecResult { observation: "No path provided.".into(), preview: "no path".into(), is_error: true, ..Default::default() };
    }
    let full = match resolve_new_path(root, &path) {
        Ok(p) => p,
        Err(e) => return ExecResult { observation: e.clone(), preview: e, is_error: true, ..Default::default() },
    };
    let existed = full.exists();
    let old = if existed { std::fs::read_to_string(&full).unwrap_or_default() } else { String::new() };
    if !approved {
        let preview = unified_diff(&old, &content, &path);
        return ExecResult {
            observation: String::new(),
            preview: "awaiting approval".into(),
            is_error: false,
            needs_approval: Some(true),
            approval_kind: Some("write_file".into()),
            approval_preview: Some(cap_preview(&preview, 4000)),
            ..Default::default()
        };
    }
    if let Some(parent) = full.parent() {
        if !parent.exists() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                return ExecResult { observation: format!("Could not create directory: {e}"), preview: "mkdir error".into(), is_error: true, ..Default::default() };
            }
        }
    }
    if let Err(e) = std::fs::write(&full, &content) {
        return ExecResult { observation: format!("Could not write {path}: {e}"), preview: "write error".into(), is_error: true, ..Default::default() };
    }
    let bytes = content.len();
    let lines = content.lines().count();
    let verb = if existed { "Overwrote" } else { "Created" };
    ExecResult {
        observation: format!("{verb} {path} ({bytes} bytes, {lines} lines)."),
        preview: format!("{} {path}", if existed { "overwrote" } else { "created" }),
        is_error: false,
        ..Default::default()
    }
}

// edit_file performs an exact string replacement in a file. When old_string is
// missing or matches more than once (and replace_all is not set), returns an
// error observation naming the match count and asking for more surrounding
// context; the file is unchanged. Approval-gated with an old→new unified-diff
// preview. This is the reliable substitute for diffs on small models.
async fn exec_edit_file(root: &Path, args: &str, approved: bool) -> ExecResult {
    let v = match serde_json::from_str::<serde_json::Value>(args) {
        Ok(v) => v,
        Err(_) => return ExecResult { observation: "Invalid args for edit_file.".into(), preview: "bad args".into(), is_error: true, ..Default::default() },
    };
    let path = v.get("path").and_then(|p| p.as_str()).unwrap_or("").trim().to_string();
    let old_string = v.get("old_string").and_then(|s| s.as_str()).unwrap_or("").to_string();
    let new_string = v.get("new_string").and_then(|s| s.as_str()).unwrap_or("").to_string();
    let replace_all = v.get("replace_all").and_then(|b| b.as_bool()).unwrap_or(false);
    if path.is_empty() {
        return ExecResult { observation: "No path provided.".into(), preview: "no path".into(), is_error: true, ..Default::default() };
    }
    if old_string.is_empty() {
        return ExecResult { observation: "old_string is empty — provide the exact text to replace.".into(), preview: "no old_string".into(), is_error: true, ..Default::default() };
    }
    let full = match safe_path(root, &path) {
        Ok(p) => p,
        Err(e) => return ExecResult { observation: e.clone(), preview: e, is_error: true, ..Default::default() },
    };
    let content = match std::fs::read_to_string(&full) {
        Ok(c) => c,
        Err(e) => return ExecResult { observation: format!("Could not read {path}: {e}"), preview: "read error".into(), is_error: true, ..Default::default() },
    };
    let matches = count_matches(&content, &old_string);
    if matches == 0 {
        return ExecResult {
            observation: format!("old_string was not found in {path} (0 matches). The file is unchanged. Re-check the exact text (indentation, whitespace) and try again, or use write_file to overwrite the whole file."),
            preview: "no match".into(),
            is_error: true,
            ..Default::default()
        };
    }
    if matches > 1 && !replace_all {
        return ExecResult {
            observation: format!("old_string matches {matches} times in {path}. The file is unchanged. Provide more surrounding context so the match is unique, or set replace_all=true to replace every occurrence."),
            preview: format!("{matches} matches"),
            is_error: true,
            ..Default::default()
        };
    }
    let new_content = if replace_all {
        content.replace(&old_string, &new_string)
    } else {
        content.replacen(&old_string, &new_string, 1)
    };
    if !approved {
        let preview = unified_diff(&content, &new_content, &path);
        return ExecResult {
            observation: String::new(),
            preview: "awaiting approval".into(),
            is_error: false,
            needs_approval: Some(true),
            approval_kind: Some("edit_file".into()),
            approval_preview: Some(cap_preview(&preview, 4000)),
            ..Default::default()
        };
    }
    if let Err(e) = std::fs::write(&full, &new_content) {
        return ExecResult { observation: format!("Could not write {path}: {e}"), preview: "write error".into(), is_error: true, ..Default::default() };
    }
    let n = if replace_all { matches } else { 1 };
    ExecResult {
        observation: format!("Edited {path} — {n} replacement(s)."),
        preview: format!("edited {path}"),
        is_error: false,
        ..Default::default()
    }
}

// delete_path removes a file or directory. Refuses the repo root and anything
// under .git/; a directory requires recursive=true. Approval-gated; always
// prompts (never auto-approved — it joins create_pr/merge_pr as a tool the
// auto-approve setting does not silence).
async fn exec_delete_path(root: &Path, args: &str, approved: bool) -> ExecResult {
    let v = match serde_json::from_str::<serde_json::Value>(args) {
        Ok(v) => v,
        Err(_) => return ExecResult { observation: "Invalid args for delete_path.".into(), preview: "bad args".into(), is_error: true, ..Default::default() },
    };
    let path = v.get("path").and_then(|p| p.as_str()).unwrap_or("").trim().to_string();
    let recursive = v.get("recursive").and_then(|b| b.as_bool()).unwrap_or(false);
    if path.is_empty() || path == "." || path == "/" {
        return ExecResult { observation: "Refusing to delete the repository root.".into(), preview: "refused".into(), is_error: true, ..Default::default() };
    }
    let full = match resolve_new_path(root, &path) {
        Ok(p) => p,
        Err(e) => return ExecResult { observation: e.clone(), preview: e, is_error: true, ..Default::default() },
    };
    if full == root {
        return ExecResult { observation: "Refusing to delete the repository root.".into(), preview: "refused".into(), is_error: true, ..Default::default() };
    }
    if !full.exists() {
        return ExecResult { observation: format!("{path} does not exist."), preview: "missing".into(), is_error: true, ..Default::default() };
    }
    let is_dir = full.is_dir();
    if is_dir && !recursive {
        return ExecResult { observation: format!("{path} is a directory — set recursive=true to delete it."), preview: "is a dir".into(), is_error: true, ..Default::default() };
    }
    if !approved {
        let preview = if is_dir { format!("delete {path}/ (recursive)") } else { format!("delete {path}") };
        return ExecResult {
            observation: String::new(),
            preview: "awaiting approval".into(),
            is_error: false,
            needs_approval: Some(true),
            approval_kind: Some("delete_path".into()),
            approval_preview: Some(preview),
            ..Default::default()
        };
    }
    let res = if is_dir { std::fs::remove_dir_all(&full) } else { std::fs::remove_file(&full) };
    match res {
        Ok(()) => ExecResult { observation: format!("Deleted {path}."), preview: format!("deleted {path}"), is_error: false, ..Default::default() },
        Err(e) => ExecResult { observation: format!("Could not delete {path}: {e}"), preview: "delete error".into(), is_error: true, ..Default::default() },
    }
}

// move_path renames or moves a file/directory, creating the destination's
// parent directories. Approval-gated with a "from → to" preview.
async fn exec_move_path(root: &Path, args: &str, approved: bool) -> ExecResult {
    let v = match serde_json::from_str::<serde_json::Value>(args) {
        Ok(v) => v,
        Err(_) => return ExecResult { observation: "Invalid args for move_path.".into(), preview: "bad args".into(), is_error: true, ..Default::default() },
    };
    let from = v.get("from").and_then(|p| p.as_str()).unwrap_or("").trim().to_string();
    let to = v.get("to").and_then(|p| p.as_str()).unwrap_or("").trim().to_string();
    if from.is_empty() || to.is_empty() {
        return ExecResult { observation: "move_path needs both `from` and `to`.".into(), preview: "missing path".into(), is_error: true, ..Default::default() };
    }
    let src = match safe_path(root, &from) {
        Ok(p) => p,
        Err(e) => return ExecResult { observation: e.clone(), preview: e, is_error: true, ..Default::default() },
    };
    if !src.exists() {
        return ExecResult { observation: format!("{from} does not exist."), preview: "missing".into(), is_error: true, ..Default::default() };
    }
    let dst = match resolve_new_path(root, &to) {
        Ok(p) => p,
        Err(e) => return ExecResult { observation: e.clone(), preview: e, is_error: true, ..Default::default() },
    };
    if dst == src {
        return ExecResult { observation: "from and to are the same path.".into(), preview: "no-op".into(), is_error: true, ..Default::default() };
    }
    if dst.exists() {
        return ExecResult { observation: format!("{to} already exists."), preview: "exists".into(), is_error: true, ..Default::default() };
    }
    if !approved {
        return ExecResult {
            observation: String::new(),
            preview: "awaiting approval".into(),
            is_error: false,
            needs_approval: Some(true),
            approval_kind: Some("move_path".into()),
            approval_preview: Some(format!("{from} → {to}")),
            ..Default::default()
        };
    }
    if let Some(parent) = dst.parent() {
        if !parent.exists() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                return ExecResult { observation: format!("Could not create directory: {e}"), preview: "mkdir error".into(), is_error: true, ..Default::default() };
            }
        }
    }
    match std::fs::rename(&src, &dst) {
        Ok(()) => ExecResult { observation: format!("Moved {from} → {to}."), preview: format!("moved {from} → {to}"), is_error: false, ..Default::default() },
        Err(e) => ExecResult { observation: format!("Could not move {from} → {to}: {e}"), preview: "move error".into(), is_error: true, ..Default::default() },
    }
}

// run_command runs a shell command in the repo root. The user must approve each
// command: if not approved, returns needs_approval with the command as the
// preview. On approval, runs the command (via `sh -c` in the repo directory)
// and returns its combined stdout+stderr (capped). A command that does not exit
// within timeout_ms (default 120s, carried on the toolExec payload from the
// backend's RUN_COMMAND_TIMEOUT) is killed and reported as a timeout so a
// dev server / watcher can't park the relay until TOOL_EXEC_TIMEOUT.
async fn exec_run_command(root: &Path, args: &str, approved: bool, timeout_ms: u64) -> ExecResult {
    let command = match serde_json::from_str::<serde_json::Value>(args) {
        Ok(v) => v.get("command").and_then(|p| p.as_str()).unwrap_or("").to_string(),
        Err(_) => return ExecResult { observation: "Invalid args for run_command.".into(), preview: "bad args".into(), is_error: true, ..Default::default() },
    };
    if command.is_empty() {
        return ExecResult { observation: "No command provided.".into(), preview: "no command".into(), is_error: true, ..Default::default() };
    }
    if !approved {
        return ExecResult {
            observation: String::new(),
            preview: "awaiting approval".into(),
            is_error: false,
            needs_approval: Some(true),
            approval_kind: Some("run_command".into()),
            approval_preview: Some(command.clone()),
            ..Default::default()
        };
    }
    let ms = if timeout_ms == 0 { 120_000 } else { timeout_ms };
    let limit = std::time::Duration::from_millis(ms);
    let run = tokio::process::Command::new("sh")
        .arg("-c")
        .arg(&command)
        .current_dir(root)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .output();
    match tokio::time::timeout(limit, run).await {
        Ok(Ok(o)) => {
            let combined = format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr));
            let trimmed = combined.trim();
            let is_err = !o.status.success();
            let code = o.status.code().unwrap_or(-1) as i64;
            let preview = if is_err { format!("exit {code}") } else { "command completed".into() };
            ExecResult { observation: cap(trimmed), preview, is_error: is_err, exit_code: Some(code), ..Default::default() }
        }
        Ok(Err(e)) => ExecResult { observation: format!("Could not run command: {e}"), preview: "exec error".into(), is_error: true, exit_code: Some(-1), ..Default::default() },
        Err(_) => ExecResult {
            observation: format!("Command timed out after {}s and was killed. A non-exiting command (dev server, watcher) can't run via run_command — redirect its output to a file and read that, or run it outside the agent.", ms / 1000),
            preview: "timed out".into(),
            is_error: true,
            exit_code: Some(124),
            ..Default::default()
        },
    }
}

// --- Git workflow tools (Phase 5: commit/push/PR, approval-gated) ---

// exec_git_commit stages all changes and commits with the provided message.
// Approval-gated: returns needs_approval with the commit message as the preview
// when not yet approved.
async fn exec_git_commit(root: &Path, args: &str, approved: bool) -> ExecResult {
    let message = match serde_json::from_str::<serde_json::Value>(args) {
        Ok(v) => v.get("message").and_then(|m| m.as_str()).unwrap_or("").to_string(),
        Err(_) => return ExecResult {
            observation: "Invalid args for git_commit.".into(),
            preview: "bad args".into(),
            is_error: true,
            ..Default::default()
        },
    };
    if message.is_empty() {
        return ExecResult {
            observation: "No commit message provided.".into(),
            preview: "no message".into(),
            is_error: true,
            ..Default::default()
        };
    }
    if !approved {
        return ExecResult {
            observation: String::new(),
            preview: "awaiting approval".into(),
            is_error: false,
            needs_approval: Some(true),
            approval_kind: Some("git_commit".into()),
            approval_preview: Some(message),
            ..Default::default()
        };
    }
    let token = token_get().unwrap_or_default();
    match git_commit_all(root, &message, &token).await {
        Ok(()) => {
            let head = git_head(root).await;
            ExecResult {
                observation: format!("Committed changes.\nHEAD: {}", head),
                preview: "committed".into(),
                is_error: false,
                ..Default::default()
            }
        }
        Err(e) => ExecResult {
            observation: format!("git commit failed: {}", e),
            preview: "commit failed".into(),
            is_error: true,
            ..Default::default()
        },
    }
}

// exec_git_push pushes HEAD to origin/<current-branch>. Approval-gated:
// returns needs_approval with "push HEAD:<branch> to origin" as the preview.
async fn exec_git_push(root: &Path, _args: &str, approved: bool) -> ExecResult {
    let branch = git_branch(root).await;
    if !approved {
        return ExecResult {
            observation: String::new(),
            preview: "awaiting approval".into(),
            is_error: false,
            needs_approval: Some(true),
            approval_kind: Some("git_push".into()),
            approval_preview: Some(format!("push HEAD:{} to origin", branch)),
            ..Default::default()
        };
    }
    let token = token_get().unwrap_or_default();
    match git_push(root, &branch, &token).await {
        Ok(out) => {
            let msg = if out.trim().is_empty() {
                format!("Pushed HEAD:{} to origin.", branch)
            } else {
                format!("Pushed HEAD:{} to origin.\n{}", branch, out.trim())
            };
            ExecResult {
                observation: cap(&msg),
                preview: "pushed".into(),
                is_error: false,
                ..Default::default()
            }
        }
        Err(e) => ExecResult {
            observation: format!("git push failed: {}", e),
            preview: "push failed".into(),
            is_error: true,
            ..Default::default()
        },
    }
}

// exec_create_pr opens a GitHub PR: head = current branch, base = repo default
// branch. Approval-gated: returns needs_approval with the PR title + base as
// the preview. Errors clearly when not a github.com repo, no token, no remote,
// or the push/PR call fails.
async fn exec_create_pr(client: &reqwest::Client, root: &Path, args: &str, approved: bool) -> ExecResult {
    let v = match serde_json::from_str::<serde_json::Value>(args) {
        Ok(v) => v,
        Err(_) => return ExecResult {
            observation: "Invalid args for create_pr.".into(),
            preview: "bad args".into(),
            is_error: true,
            ..Default::default()
        },
    };
    let title = v.get("title").and_then(|t| t.as_str()).unwrap_or("").to_string();
    let body_text = v.get("body").and_then(|b| b.as_str()).unwrap_or("").to_string();
    if title.is_empty() {
        return ExecResult {
            observation: "No PR title provided.".into(),
            preview: "no title".into(),
            is_error: true,
            ..Default::default()
        };
    }
    let head = git_branch(root).await;
    let base = git_default_branch(root).await;
    if !approved {
        return ExecResult {
            observation: String::new(),
            preview: "awaiting approval".into(),
            is_error: false,
            needs_approval: Some(true),
            approval_kind: Some("create_pr".into()),
            approval_preview: Some(format!("PR \"{}\": {} → {}", title, head, base)),
            ..Default::default()
        };
    }
    match create_pr_for_repo(client, root, &title, &body_text, &head, Some(&base)).await {
        Ok(url) => ExecResult {
            observation: format!("PR created: {}", url),
            preview: "PR opened".into(),
            is_error: false,
            ..Default::default()
        },
        Err(e) => ExecResult {
            observation: format!("create_pr failed: {}", e),
            preview: "PR failed".into(),
            is_error: true,
            ..Default::default()
        },
    }
}

// exec_list_prs returns the repo's open pull requests with CI + review state so
// the agent can find a PR and check whether it's safe to merge before calling
// merge_pr. Read-only — never approval-gated. github.com repos only.
async fn exec_list_prs(client: &reqwest::Client, root: &Path, _args: &str) -> ExecResult {
    match list_prs_for_repo(client, root).await {
        Ok(prs) if prs.is_empty() => ExecResult {
            observation: "No open pull requests.".into(),
            preview: "0 open PRs".into(),
            is_error: false,
            ..Default::default()
        },
        Ok(prs) => {
            let mut lines = Vec::with_capacity(prs.len());
            for pr in &prs {
                let mut s = format!("#{} \"{}\" {}→{}", pr.number, pr.title, pr.head, pr.base);
                if pr.draft {
                    s.push_str(" [draft]");
                }
                if let Some(ci) = &pr.ci_state {
                    s.push_str(&format!(" CI={}", ci));
                }
                if let Some(rv) = &pr.review_state {
                    s.push_str(&format!(" reviews={}", rv));
                }
                if let Some(ms) = &pr.mergeable_state {
                    s.push_str(&format!(" mergeable={}", ms));
                }
                lines.push(s);
            }
            ExecResult {
                observation: cap(&lines.join("\n")),
                preview: format!("{} open PRs", prs.len()),
                is_error: false,
                ..Default::default()
            }
        }
        Err(e) => ExecResult {
            observation: format!("list_prs failed: {}", e),
            preview: "PR list failed".into(),
            is_error: true,
            ..Default::default()
        },
    }
}

// exec_merge_pr merges a GitHub pull request by number. Approval-gated like
// create_pr — never auto-approved. The not-approved path fetches the PR so the
// approval dialog shows the title + head→base; a fetch failure falls back to a
// minimal by-number preview. github.com repos only.
async fn exec_merge_pr(client: &reqwest::Client, root: &Path, args: &str, approved: bool) -> ExecResult {
    let v = match serde_json::from_str::<serde_json::Value>(args) {
        Ok(v) => v,
        Err(_) => return ExecResult {
            observation: "Invalid args for merge_pr.".into(),
            preview: "bad args".into(),
            is_error: true,
            ..Default::default()
        },
    };
    let number = v.get("number").and_then(|n| n.as_u64()).unwrap_or(0);
    if number == 0 {
        return ExecResult {
            observation: "No PR number provided.".into(),
            preview: "no number".into(),
            is_error: true,
            ..Default::default()
        };
    }
    let method = v
        .get("method")
        .and_then(|m| m.as_str())
        .unwrap_or("merge")
        .to_string();
    if !approved {
        let preview = match pr_detail(client, root, number).await {
            Ok(d) => format!(
                "Merge PR #{} \"{}\": {} → {} ({})",
                number, d.title, d.head, d.base, method
            ),
            Err(_) => format!("Merge PR #{} ({})", number, method),
        };
        return ExecResult {
            observation: String::new(),
            preview: "awaiting approval".into(),
            is_error: false,
            needs_approval: Some(true),
            approval_kind: Some("merge_pr".into()),
            approval_preview: Some(preview),
            ..Default::default()
        };
    }
    match merge_pr_for_repo(client, root, number, &method).await {
        Ok(sha) => ExecResult {
            observation: format!("Merged PR #{} ({}).", number, sha),
            preview: "merged".into(),
            is_error: false,
            ..Default::default()
        },
        Err(e) => ExecResult {
            observation: format!("merge_pr failed: {}", e),
            preview: "merge failed".into(),
            is_error: true,
            ..Default::default()
        },
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

// --- Connect an existing local folder (folder-picker wizard) ----------------

#[derive(Deserialize)]
struct AddLocalBody {
    path: String,
}

// repos_add_local connects an existing on-disk git repo (picked via the native
// folder dialog) as a workspace. It resolves the repo root so a sub-folder
// selection still works, derives a full_name from the origin remote (owner/repo
// for github.com, else the folder basename), records it in the sidecar registry,
// and pushes repo context to the backend so agent runs can inject it.
async fn repos_add_local(State(st): State<AppState>, Json(body): Json<AddLocalBody>) -> Response {
    let raw = body.path.trim().to_string();
    if raw.is_empty() {
        return json_err("path is required", StatusCode::BAD_REQUEST);
    }
    let p = PathBuf::from(&raw);
    if !p.is_dir() {
        return json_err("path is not a directory", StatusCode::BAD_REQUEST);
    }
    let root = match git_toplevel(&p).await {
        Some(r) => r,
        None => {
            return json_err(
                "not a git repository (run `git init` first, or pick the repo root)",
                StatusCode::BAD_REQUEST,
            )
        }
    };
    let remote = git_remote_url(&root).await;
    let full_name = derive_full_name(remote.as_deref(), &root);
    let branch = git_branch(&root).await;
    let head = git_head(&root).await;
    let tree = top_level_tree(&root);
    upsert_registry(
        &st.data_dir,
        &RepoRecord {
            full_name: full_name.clone(),
            path: root.display().to_string(),
            remote: remote.clone(),
            branch: branch.clone(),
            folder_id: None,
            linked: true,
        },
    );
    // Best-effort: a failure here (e.g. not signed in yet) doesn't fail add.
    let _ = push_repo_context(&st, &full_name, &root, &branch, &head, &tree).await;
    json_ok(&serde_json::json!({
        "ok": true,
        "name": full_name,
        "fullName": full_name,
        "path": root.display().to_string(),
        "branch": branch,
        "head": head,
        "remote": remote,
        "tree": tree,
    }))
}

// --- Scan a folder for one or more git repos (sidebar connect wizard) ------

#[derive(Deserialize)]
struct ScanBody {
    path: String,
}

#[derive(Serialize, Clone)]
struct ScanCandidate {
    name: String,
    path: String,
}

// repos_scan_local resolves what a picked folder should connect as: if the
// folder itself is (or is inside) a git repo, that single repo is returned
// (preserves the original one-repo-root behavior). Otherwise its immediate
// subdirectories are scanned (one level deep) for a `.git` entry so a parent
// folder containing several repos (e.g. a projects directory) yields a list
// of candidates the renderer can offer as a checklist, instead of erroring.
async fn repos_scan_local(Json(body): Json<ScanBody>) -> Response {
    let raw = body.path.trim().to_string();
    if raw.is_empty() {
        return json_err("path is required", StatusCode::BAD_REQUEST);
    }
    let p = PathBuf::from(&raw);
    if !p.is_dir() {
        return json_err("path is not a directory", StatusCode::BAD_REQUEST);
    }
    if let Some(root) = git_toplevel(&p).await {
        let remote = git_remote_url(&root).await;
        let name = derive_full_name(remote.as_deref(), &root);
        return json_ok(&serde_json::json!({
            "ok": true,
            "repos": [ScanCandidate { name, path: root.display().to_string() }],
        }));
    }
    let mut candidates: Vec<ScanCandidate> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&p) {
        for e in entries.flatten() {
            let child = e.path();
            if !child.is_dir() || !child.join(".git").exists() {
                continue;
            }
            let remote = git_remote_url(&child).await;
            let name = derive_full_name(remote.as_deref(), &child);
            candidates.push(ScanCandidate { name, path: child.display().to_string() });
        }
    }
    candidates.sort_by(|a, b| a.name.cmp(&b.name));
    json_ok(&serde_json::json!({ "ok": true, "repos": candidates }))
}

// --- Ship changes: changelog preview + commit/push -------------------------

// repos_changelog returns the repo's push state (remote, ahead/behind, unpushed
// commit subjects) and the existing CHANGELOG.md text, so the ship wizard can
// pre-fill and gate the Push button (Push only makes sense with a remote).
async fn repos_changelog(State(st): State<AppState>, Json(body): Json<NameBody>) -> Response {
    let name = body.name.trim().to_string();
    let dest = match resolve_repo_branch(&st.data_dir, &name, &body.branch).await {
        Ok(p) => p,
        Err((status, e)) => return json_err(&e, status),
    };
    let remote = git_remote_url(&dest).await;
    let branch = git_branch(&dest).await;
    let upstream = format!("origin/{}", branch);
    let (ahead, behind, unpushed) = if git_has_ref(&dest, &upstream).await {
        (
            git_rev_count(&dest, &format!("{}..HEAD", upstream)).await,
            git_rev_count(&dest, &format!("HEAD..{}", upstream)).await,
            git_log_subjects(&dest, &format!("{}..HEAD", upstream)).await,
        )
    } else {
        // No upstream ref: every commit on the branch is "unpushed".
        (
            git_rev_count(&dest, "HEAD").await,
            0,
            git_log_subjects(&dest, "HEAD").await,
        )
    };
    let changelog = std::fs::read_to_string(dest.join("CHANGELOG.md")).unwrap_or_default();
    json_ok(&serde_json::json!({
        "ok": true,
        "remote": remote,
        "branch": branch,
        "ahead": ahead,
        "behind": behind,
        "unpushed": unpushed,
        "changelog": changelog,
    }))
}

#[derive(Deserialize)]
struct ShipBody {
    repo: String,
    version: String,
    changelog: String,
    #[serde(default)]
    message: String,
    #[serde(default)]
    push: bool,
    #[serde(default)]
    branch: String,
}

// repos_ship is the "final version" action: append a Keep-a-Changelog entry to
// CHANGELOG.md, stage all changes, commit, and optionally push. For a github.com
// https remote with a stored token, push uses a token-injected URL so a linked
// repo without a credential helper still works; otherwise it pushes via the
// configured origin. The token is scrubbed from any captured output.
async fn repos_ship(State(st): State<AppState>, Json(body): Json<ShipBody>) -> Response {
    let name = body.repo.trim().to_string();
    let dest = match resolve_repo_branch(&st.data_dir, &name, &body.branch).await {
        Ok(p) => p,
        Err((status, e)) => return json_err(&e, status),
    };
    let version = body.version.trim().to_string();
    if version.is_empty() {
        return json_err("version is required", StatusCode::BAD_REQUEST);
    }
    let bullets: Vec<String> = body
        .changelog
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .map(|l| if l.starts_with("- ") { l.to_string() } else { format!("- {}", l) })
        .collect();
    if let Err(e) = write_changelog_entry(&dest, &version, &today_ymd(), &bullets.join("\n")) {
        return json_err(&e, StatusCode::INTERNAL_SERVER_ERROR);
    }
    let token = token_get().unwrap_or_default();
    let message = if body.message.trim().is_empty() {
        format!("Release {}", version)
    } else {
        body.message.trim().to_string()
    };
    if let Err(e) = git_commit_all(&dest, &message, &token).await {
        return json_err(&e, StatusCode::BAD_GATEWAY);
    }
    let mut pushed = false;
    let mut push_err: Option<String> = None;
    if body.push {
        let branch = git_branch(&dest).await;
        match git_push(&dest, &branch, &token).await {
            Ok(_out) => pushed = true,
            Err(e) => push_err = Some(e),
        }
    }
    let head = git_head(&dest).await;
    if let Some(e) = push_err {
        return json_ok(&serde_json::json!({
            "ok": true,
            "head": head,
            "pushed": false,
            "remote": git_remote_url(&dest).await,
            "error": e,
        }));
    }
    json_ok(&serde_json::json!({
        "ok": true,
        "head": head,
        "pushed": pushed,
        "remote": git_remote_url(&dest).await,
        "error": null,
    }))
}

// --- Persist the workspace folder id for a repo ----------------------------

#[derive(Deserialize)]
struct SetFolderBody {
    repo: String,
    folder_id: String,
}

// repos_set_folder records the backend folder id bound to a repo's workspace,
// so the renderer can place new chats into the workspace folder reliably.
async fn repos_set_folder(State(st): State<AppState>, Json(body): Json<SetFolderBody>) -> Response {
    let name = body.repo.trim().to_string();
    if name.is_empty() {
        return json_err("repo is required", StatusCode::BAD_REQUEST);
    }
    let mut repos = load_registry(&st.data_dir);
    if let Some(r) = repos.iter_mut().find(|r| r.full_name == name) {
        r.folder_id = if body.folder_id.is_empty() { None } else { Some(body.folder_id.clone()) };
        save_registry(&st.data_dir, &repos);
        json_ok(&serde_json::json!({ "ok": true }))
    } else {
        json_err("repo not found in registry", StatusCode::NOT_FOUND)
    }
}

// --- Branch + state + commit + PR (agent workflow) ------------------------

// create_pr_for_repo pushes the head branch to origin, then opens a GitHub PR
// via POST /repos/{owner}/{repo}/pulls. head defaults to the current branch;
// base defaults to the repo's default branch. The token is scrubbed from any
// captured error text. Returns Ok(html_url) on success.
async fn create_pr_for_repo(
    client: &reqwest::Client,
    root: &Path,
    title: &str,
    body: &str,
    head: &str,
    base: Option<&str>,
) -> Result<String, String> {
    let remote = git_remote_url(root)
        .await
        .ok_or_else(|| "no remote configured".to_string())?;
    let full_name = github_full_name(&remote)
        .ok_or_else(|| "create-pr is only supported for github.com repos".to_string())?;
    let token = token_get()
        .ok_or_else(|| "no github token stored (connect github first)".to_string())?;
    let base_branch = match base {
        Some(b) if !b.is_empty() => b.to_string(),
        _ => git_default_branch(root).await,
    };
    git_push(root, head, &token)
        .await
        .map_err(|e| format!("push failed: {}", scrub(e, &token)))?;
    let pr_json = serde_json::json!({
        "title": title,
        "head": head,
        "base": base_branch,
        "body": body,
    });
    let url = format!("{GH_API}/repos/{}/pulls", full_name);
    let resp = client
        .post(&url)
        .headers(gh_headers(&token))
        .json(&pr_json)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("github unreachable: {}", scrub(e.to_string(), &token)))?;
    let status = resp.status();
    let body_text = resp.text().await.unwrap_or_default();
    if status.is_success() {
        let v: serde_json::Value = serde_json::from_str(&body_text)
            .map_err(|e| format!("bad github response: {}", scrub(e.to_string(), &token)))?;
        v.get("html_url")
            .and_then(|u| u.as_str())
            .map(String::from)
            .ok_or_else(|| "PR created but no URL in response".to_string())
    } else {
        let msg = parse_github_error(&body_text)
            .unwrap_or_else(|| format!("github returned {}", status));
        Err(scrub(msg, &token))
    }
}

// --- PR listing (shared by the list_prs tool and the /repos/prs UI route) ---

#[derive(Serialize)]
struct PrInfo {
    number: u64,
    title: String,
    head: String,
    base: String,
    draft: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    mergeable_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ci_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    review_state: Option<String>,
    html_url: String,
}

// list_prs_for_repo fetches up to 10 open PRs for a github.com repo, then
// enriches each with combined CI state (GET /commits/{sha}/status) and a
// summarized review state (GET /pulls/{n}/reviews). Returns the raw list so the
// agent executor can render text and the UI route can return JSON. Errors are
// surfaced as strings (no remote, not github.com, no token, API failure).
async fn list_prs_for_repo(
    client: &reqwest::Client,
    root: &Path,
) -> Result<Vec<PrInfo>, String> {
    let remote = git_remote_url(root)
        .await
        .ok_or_else(|| "no remote configured".to_string())?;
    let full_name = github_full_name(&remote)
        .ok_or_else(|| "list_prs is only supported for github.com repos".to_string())?;
    let token =
        token_get().ok_or_else(|| "no github token stored (connect github first)".to_string())?;
    let url = format!("{GH_API}/repos/{}/pulls?state=open&per_page=10", full_name);
    let resp = client
        .get(&url)
        .headers(gh_headers(&token))
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("github unreachable: {}", scrub(e.to_string(), &token)))?;
    if resp.status() == StatusCode::UNAUTHORIZED {
        return Err("invalid or expired token".into());
    }
    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(parse_github_error(&body)
            .unwrap_or_else(|| format!("github returned {}", body)));
    }
    let prs: Vec<serde_json::Value> = resp
        .json()
        .await
        .map_err(|e| format!("bad github response: {}", scrub(e.to_string(), &token)))?;
    let mut out = Vec::with_capacity(prs.len());
    for pr in prs {
        let number = pr.get("number").and_then(|v| v.as_u64()).unwrap_or(0);
        let head_sha = pr
            .get("head")
            .and_then(|h| h.get("sha"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let ci_state = if head_sha.is_empty() {
            None
        } else {
            pr_ci_state(client, &full_name, &head_sha, &token).await
        };
        let review_state = pr_review_state(client, &full_name, number, &token).await;
        out.push(PrInfo {
            number,
            title: pr
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            head: pr
                .get("head")
                .and_then(|h| h.get("ref"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            base: pr
                .get("base")
                .and_then(|b| b.get("ref"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            draft: pr.get("draft").and_then(|v| v.as_bool()).unwrap_or(false),
            // mergeable_state is only reliably computed by the single-PR GET;
            // the list endpoint often returns null/"unknown", so filter those.
            mergeable_state: pr
                .get("mergeable_state")
                .and_then(|v| v.as_str())
                .map(String::from)
                .filter(|s| !s.is_empty() && s != "unknown"),
            ci_state,
            review_state,
            html_url: pr
                .get("html_url")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        });
    }
    Ok(out)
}

// pr_ci_state returns the combined check state for a PR's head commit
// (success/failure/pending/error), or None when there are no check contexts.
async fn pr_ci_state(
    client: &reqwest::Client,
    full_name: &str,
    sha: &str,
    token: &str,
) -> Option<String> {
    let url = format!("{GH_API}/repos/{}/commits/{}/status", full_name, sha);
    let resp = client
        .get(&url)
        .headers(gh_headers(token))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let v: serde_json::Value = resp.json().await.ok()?;
    let has_statuses = v
        .get("statuses")
        .and_then(|s| s.as_array())
        .map(|a| !a.is_empty())
        .unwrap_or(false);
    if !has_statuses {
        return None;
    }
    v.get("state").and_then(|s| s.as_str()).map(String::from)
}

// pr_review_state summarizes a PR's reviews as "changes_requested",
// "approved", "reviewed", or "none", based on the latest review per user
// (reviews arrive chronologically, so later entries overwrite earlier ones).
// Returns None when there are no reviews.
async fn pr_review_state(
    client: &reqwest::Client,
    full_name: &str,
    number: u64,
    token: &str,
) -> Option<String> {
    let url = format!("{GH_API}/repos/{}/pulls/{}/reviews", full_name, number);
    let resp = client
        .get(&url)
        .headers(gh_headers(token))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let reviews: Vec<serde_json::Value> = resp.json().await.ok()?;
    if reviews.is_empty() {
        return None;
    }
    let mut latest: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for r in reviews {
        let user = r
            .get("user")
            .and_then(|u| u.get("login"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let state = r
            .get("state")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if !user.is_empty() && !state.is_empty() {
            latest.insert(user, state);
        }
    }
    let states: Vec<String> = latest.values().cloned().collect();
    if states.iter().any(|s| s == "CHANGES_REQUESTED") {
        Some("changes_requested".to_string())
    } else if states.iter().any(|s| s == "APPROVED") {
        Some("approved".to_string())
    } else {
        Some("reviewed".to_string())
    }
}

// merge_pr_for_repo merges a PR via PUT /repos/{owner}/{repo}/pulls/{n}/merge.
// Returns the merge commit sha on success. method is normalized to
// merge/squash/rebase (default merge). github.com repos only; the token is
// scrubbed from any captured error text.
async fn merge_pr_for_repo(
    client: &reqwest::Client,
    root: &Path,
    number: u64,
    method: &str,
) -> Result<String, String> {
    let remote = git_remote_url(root)
        .await
        .ok_or_else(|| "no remote configured".to_string())?;
    let full_name = github_full_name(&remote)
        .ok_or_else(|| "merge_pr is only supported for github.com repos".to_string())?;
    let token =
        token_get().ok_or_else(|| "no github token stored (connect github first)".to_string())?;
    let method = match method.trim() {
        "squash" => "squash",
        "rebase" => "rebase",
        _ => "merge",
    };
    let url = format!("{GH_API}/repos/{}/pulls/{}/merge", full_name, number);
    let body = serde_json::json!({ "merge_method": method });
    let resp = client
        .put(&url)
        .headers(gh_headers(&token))
        .json(&body)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("github unreachable: {}", scrub(e.to_string(), &token)))?;
    let status = resp.status();
    let body_text = resp.text().await.unwrap_or_default();
    if status.is_success() {
        let v: serde_json::Value = serde_json::from_str(&body_text)
            .map_err(|e| format!("bad github response: {}", scrub(e.to_string(), &token)))?;
        let sha = v
            .get("sha")
            .and_then(|s| s.as_str())
            .unwrap_or("")
            .to_string();
        Ok(sha)
    } else {
        let msg = parse_github_error(&body_text)
            .unwrap_or_else(|| format!("github returned {}", status));
        Err(scrub(msg, &token))
    }
}

// pr_detail fetches a single PR for the merge approval preview (title, head,
// base, draft, mergeable_state). CI/review state are left as None — the preview
// doesn't need them, and list_prs already enriched the UI route. Returns an
// error string for a non-github repo, missing token, or API failure.
async fn pr_detail(client: &reqwest::Client, root: &Path, number: u64) -> Result<PrInfo, String> {
    let remote = git_remote_url(root)
        .await
        .ok_or_else(|| "no remote configured".to_string())?;
    let full_name = github_full_name(&remote)
        .ok_or_else(|| "not a github.com repo".to_string())?;
    let token =
        token_get().ok_or_else(|| "no github token stored (connect github first)".to_string())?;
    let url = format!("{GH_API}/repos/{}/pulls/{}", full_name, number);
    let resp = client
        .get(&url)
        .headers(gh_headers(&token))
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("github unreachable: {}", scrub(e.to_string(), &token)))?;
    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(parse_github_error(&body)
            .unwrap_or_else(|| format!("github returned {}", body)));
    }
    let pr: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("bad github response: {}", scrub(e.to_string(), &token)))?;
    Ok(PrInfo {
        number,
        title: pr
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        head: pr
            .get("head")
            .and_then(|h| h.get("ref"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        base: pr
            .get("base")
            .and_then(|b| b.get("ref"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
        draft: pr.get("draft").and_then(|v| v.as_bool()).unwrap_or(false),
        mergeable_state: pr
            .get("mergeable_state")
            .and_then(|v| v.as_str())
            .map(String::from)
            .filter(|s| !s.is_empty() && s != "unknown"),
        ci_state: None,
        review_state: None,
        html_url: pr
            .get("html_url")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
    })
}

#[derive(Deserialize)]
struct BranchBody {
    name: String,
    title: String,
}

// repos_branch creates (or reuses) an `agent/<slug>` branch for a chat title.
// Idempotent: if the branch already exists, switches to it instead of creating.
// On a dirty-tree checkout failure, returns the git error in {error} (no force
// or stash). After a successful switch, updates the registry and re-pushes repo
// context to the backend with the new branch (best-effort).
async fn repos_branch(State(st): State<AppState>, Json(body): Json<BranchBody>) -> Response {
    let name = body.name.trim().to_string();
    let title = body.title.trim().to_string();
    let dest = match resolve_repo(&st.data_dir, &name) {
        Some(p) => p,
        None => return json_err("not found locally", StatusCode::NOT_FOUND),
    };
    let slug = slugify(&title);
    let branch = format!("agent/{}", slug);
    let ref_name = format!("refs/heads/{}", branch);
    let token = token_get().unwrap_or_default();
    let out = if git_has_ref(&dest, &ref_name).await {
        tokio::process::Command::new("git")
            .arg("-C").arg(&dest)
            .arg("switch").arg(&branch)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output()
            .await
    } else {
        tokio::process::Command::new("git")
            .arg("-C").arg(&dest)
            .arg("switch").arg("-c").arg(&branch)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output()
            .await
    };
    match out {
        Ok(o) if o.status.success() => {
            // Update the registry so the sidebar reflects the new branch.
            let mut repos = load_registry(&st.data_dir);
            if let Some(r) = repos.iter_mut().find(|r| r.full_name == name) {
                r.branch = branch.clone();
                save_registry(&st.data_dir, &repos);
            }
            // Re-push repo context with the new branch (best-effort).
            let head = git_head(&dest).await;
            let tree = top_level_tree(&dest);
            let _ = push_repo_context(&st, &name, &dest, &branch, &head, &tree).await;
            json_ok(&serde_json::json!({ "ok": true, "branch": branch }))
        }
        Ok(o) => {
            let combined = format!(
                "{}\n{}",
                String::from_utf8_lossy(&o.stdout),
                String::from_utf8_lossy(&o.stderr)
            );
            let msg = scrub(combined.trim().to_string(), &token);
            json_ok(&serde_json::json!({ "ok": false, "branch": branch, "error": msg }))
        }
        Err(e) => {
            json_ok(&serde_json::json!({ "ok": false, "branch": branch, "error": format!("git switch: {e}") }))
        }
    }
}

#[derive(Deserialize)]
struct CreateBranchBody {
    name: String,
    branch: String,
    #[serde(default)]
    base: String,
}

// repos_create_branch starts a chat on its own branch cut from the repo's
// default branch (or `base`), WITHOUT provisioning a git worktree upfront.
// This is the per-chat branch model: a new chat is just a branch from main.
//
// Two cases, keyed on whether the repo folder has uncommitted changes:
//  - Clean folder: `git switch -c <branch> <base>` (or `git switch <branch>`
//    if the branch already exists) moves the folder onto the chat's branch so
//    its tool calls run there directly — no worktree is ever created for it.
//  - Dirty folder: the working tree is never moved (switching would carry
//    another chat's / the user's uncommitted edits onto the new branch). For
//    a new branch we `git branch <branch> <base>` (create the ref only, no
//    checkout); for an existing branch we do nothing. In both sub-cases the
//    chat's tool calls lazily provision an isolated worktree via repos_exec
//    (ensure_worktree, create=false), which keeps concurrent chats on
//    different branches from treading on each other.
//
// Returns {ok, branch, isolated, error}. `isolated` is true when the folder
// was left on a different branch and the chat will run in a lazy worktree.
// Idempotent: if the folder is already on `branch`, returns ok immediately.
// The registry is updated and repo context re-pushed only when the folder is
// actually switched (isolated=false), since the folder's branch is unchanged
// otherwise.
async fn repos_create_branch(State(st): State<AppState>, Json(body): Json<CreateBranchBody>) -> Response {
    let name = body.name.trim().to_string();
    let branch = body.branch.trim().to_string();
    if branch.is_empty() {
        return json_ok(&serde_json::json!({ "ok": false, "branch": "", "isolated": false, "error": "branch is required" }));
    }
    let main = match resolve_repo(&st.data_dir, &name) {
        Some(p) => p,
        None => return json_ok(&serde_json::json!({ "ok": false, "branch": branch, "isolated": false, "error": "not found locally" })),
    };
    let token = token_get().unwrap_or_default();
    let current = git_branch(&main).await;
    if current == branch {
        return json_ok(&serde_json::json!({ "ok": true, "branch": branch, "isolated": false, "error": null }));
    }
    let dirty = git_dirty_count(&main).await;
    let has_local = git_has_ref(&main, &format!("refs/heads/{branch}")).await;
    let base = if body.base.trim().is_empty() {
        git_default_branch(&main).await
    } else {
        body.base.trim().to_string()
    };

    // Dirty folder: never move the working tree. Create the ref only (new
    // branch) so repos_exec can lazily check it out into an isolated worktree;
    // for an existing branch, leave the folder as-is (the lazy worktree handles
    // it). No registry/context update — the folder's branch is unchanged.
    if dirty > 0 {
        if !has_local {
            let out = tokio::process::Command::new("git")
                .arg("-C").arg(&main)
                .arg("branch").arg(&branch).arg(&base)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .output().await;
            return match out {
                Ok(o) if o.status.success() => json_ok(&serde_json::json!({ "ok": true, "branch": branch, "isolated": true, "error": null })),
                Ok(o) => {
                    let msg = scrub(String::from_utf8_lossy(&o.stderr).trim().to_string(), &token);
                    let emsg = if msg.is_empty() { "git branch failed".to_string() } else { msg };
                    json_ok(&serde_json::json!({ "ok": false, "branch": branch, "isolated": false, "error": emsg }))
                }
                Err(e) => json_ok(&serde_json::json!({ "ok": false, "branch": branch, "isolated": false, "error": format!("git branch: {e}") })),
            };
        }
        return json_ok(&serde_json::json!({ "ok": true, "branch": branch, "isolated": true, "error": null }));
    }

    // Clean folder: switch onto the chat's branch (create from base if new).
    let out = if has_local {
        tokio::process::Command::new("git")
            .arg("-C").arg(&main)
            .arg("switch").arg(&branch)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output().await
    } else {
        tokio::process::Command::new("git")
            .arg("-C").arg(&main)
            .arg("switch").arg("-c").arg(&branch).arg(&base)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output().await
    };
    match out {
        Ok(o) if o.status.success() => {
            let head = git_head(&main).await;
            let tree = top_level_tree(&main);
            if let Some(rec) = load_registry(&st.data_dir).into_iter().find(|r| r.full_name == name) {
                upsert_registry(&st.data_dir, &RepoRecord { branch: branch.clone(), ..rec });
            }
            let _ = push_repo_context(&st, &name, &main, &branch, &head, &tree).await;
            json_ok(&serde_json::json!({ "ok": true, "branch": branch, "isolated": false, "error": null }))
        }
        Ok(o) => {
            let combined = format!("{}\n{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr));
            let msg = scrub(combined.trim().to_string(), &token);
            let emsg = if msg.is_empty() { "git switch failed".to_string() } else { msg };
            json_ok(&serde_json::json!({ "ok": false, "branch": branch, "isolated": false, "error": emsg }))
        }
        Err(e) => json_ok(&serde_json::json!({ "ok": false, "branch": branch, "isolated": false, "error": format!("git switch: {e}") })),
    }
}

#[derive(Deserialize)]
struct StateQuery {
    name: String,
    #[serde(default)]
    branch: String,
}

// repos_state returns the live git state for a repo in one call: current
// branch, dirty file count, ahead/behind vs origin/<branch>, and whether a
// remote is configured. ahead/behind are 0/0 when the upstream ref is absent.
async fn repos_state(State(st): State<AppState>, Query(q): Query<StateQuery>) -> Response {
    let name = q.name.trim().to_string();
    let dest = match resolve_repo_branch(&st.data_dir, &name, &q.branch).await {
        Ok(p) => p,
        Err((status, e)) => return json_err(&e, status),
    };
    let branch = git_branch(&dest).await;
    let dirty = git_dirty_count(&dest).await;
    let has_remote = git_remote_url(&dest).await.is_some();
    let upstream = format!("origin/{}", branch);
    let (ahead, behind) = if git_has_ref(&dest, &upstream).await {
        (
            git_rev_count(&dest, &format!("origin/{}..HEAD", branch)).await,
            git_rev_count(&dest, &format!("HEAD..origin/{}", branch)).await,
        )
    } else {
        (0, 0)
    };
    json_ok(&serde_json::json!({
        "name": name,
        "branch": branch,
        "dirty": dirty,
        "ahead": ahead,
        "behind": behind,
        "hasRemote": has_remote,
    }))
}

#[derive(Deserialize)]
struct CommitBody {
    repo: String,
    message: String,
    #[serde(default)]
    push: bool,
    #[serde(default)]
    branch: String,
}

// repos_commit is a lightweight commit (+ optional push) with no version or
// CHANGELOG — the "finish the loop" counterpart to repos_ship. If push is true
// but the repo has no remote, returns {ok:false, error:"no remote configured"}.
async fn repos_commit(State(st): State<AppState>, Json(body): Json<CommitBody>) -> Response {
    let name = body.repo.trim().to_string();
    let dest = match resolve_repo_branch(&st.data_dir, &name, &body.branch).await {
        Ok(p) => p,
        Err((status, e)) => return json_err(&e, status),
    };
    let message = body.message.trim().to_string();
    if message.is_empty() {
        return json_err("message is required", StatusCode::BAD_REQUEST);
    }
    if body.push && git_remote_url(&dest).await.is_none() {
        return json_ok(&serde_json::json!({
            "ok": false,
            "head": null,
            "pushed": false,
            "error": "no remote configured",
        }));
    }
    let token = token_get().unwrap_or_default();
    if let Err(e) = git_commit_all(&dest, &message, &token).await {
        return json_ok(&serde_json::json!({
            "ok": false,
            "head": null,
            "pushed": false,
            "error": e,
        }));
    }
    let mut pushed = false;
    let mut push_err: Option<String> = None;
    if body.push {
        let branch = git_branch(&dest).await;
        match git_push(&dest, &branch, &token).await {
            Ok(_out) => pushed = true,
            Err(e) => push_err = Some(e),
        }
    }
    let head = git_head(&dest).await;
    if let Some(e) = push_err {
        return json_ok(&serde_json::json!({
            "ok": true,
            "head": head,
            "pushed": false,
            "error": e,
        }));
    }
    json_ok(&serde_json::json!({
        "ok": true,
        "head": head,
        "pushed": pushed,
        "error": null,
    }))
}

#[derive(Deserialize)]
struct CreatePrBody {
    repo: String,
    title: String,
    body: String,
    #[serde(default)]
    head: Option<String>,
    #[serde(default)]
    base: Option<String>,
    #[serde(default)]
    branch: String,
}

// repos_create_pr opens a GitHub PR for the repo's current (or specified) head
// branch against the default (or specified) base. Pushes the head branch to
// origin first. Errors clearly when: not a github.com repo, no stored token,
// no remote, or the push/PR call fails.
async fn repos_create_pr(State(st): State<AppState>, Json(body): Json<CreatePrBody>) -> Response {
    let name = body.repo.trim().to_string();
    let dest = match resolve_repo_branch(&st.data_dir, &name, &body.branch).await {
        Ok(p) => p,
        Err((status, e)) => return json_err(&e, status),
    };
    let title = body.title.trim().to_string();
    if title.is_empty() {
        return json_ok(&serde_json::json!({ "ok": false, "url": null, "error": "title is required" }));
    }
    let head = match body.head.as_deref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
        Some(h) => h.to_string(),
        None => git_branch(&dest).await,
    };
    let base = body
        .base
        .as_deref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(String::from);
    match create_pr_for_repo(&st.client, &dest, &title, &body.body, &head, base.as_deref()).await {
        Ok(url) => json_ok(&serde_json::json!({ "ok": true, "url": url })),
        Err(e) => json_ok(&serde_json::json!({ "ok": false, "url": null, "error": e })),
    }
}

// repos_prs is the UI-facing route for the session panel: returns a repo's open
// PRs (with CI + review state) as JSON so the Merge PR control can list them.
// Reuses list_prs_for_repo so it stays in sync with the agent's list_prs tool.
async fn repos_prs(State(st): State<AppState>, Query(q): Query<StateQuery>) -> Response {
    let name = q.name.trim().to_string();
    let dest = match resolve_repo_branch(&st.data_dir, &name, &q.branch).await {
        Ok(p) => p,
        Err((status, e)) => return json_err(&e, status),
    };
    match list_prs_for_repo(&st.client, &dest).await {
        Ok(prs) => json_ok(&serde_json::json!({ "ok": true, "prs": prs })),
        Err(e) => json_err(&e, StatusCode::BAD_GATEWAY),
    }
}

#[derive(Deserialize)]
struct MergePrBody {
    repo: String,
    number: u64,
    #[serde(default)]
    method: String,
    #[serde(default)]
    branch: String,
}

// repos_merge_pr is the UI-facing route for the session panel's Merge PR
// button: merges a PR by number via the GitHub API. Reuses merge_pr_for_repo
// so it stays in sync with the agent's merge_pr tool. Returns {ok, sha} or
// {ok:false, error}. method defaults to "merge".
async fn repos_merge_pr(State(st): State<AppState>, Json(body): Json<MergePrBody>) -> Response {
    let name = body.repo.trim().to_string();
    let dest = match resolve_repo_branch(&st.data_dir, &name, &body.branch).await {
        Ok(p) => p,
        Err((status, e)) => return json_err(&e, status),
    };
    if body.number == 0 {
        return json_ok(&serde_json::json!({ "ok": false, "sha": null, "error": "number is required" }));
    }
    match merge_pr_for_repo(&st.client, &dest, body.number, body.method.as_str()).await {
        Ok(sha) => json_ok(&serde_json::json!({ "ok": true, "sha": sha })),
        Err(e) => json_ok(&serde_json::json!({ "ok": false, "sha": null, "error": e })),
    }
}

#[derive(Deserialize)]
struct WorktreeBody {
    name: String,
    branch: String,
    #[serde(default)]
    create: bool,
}

// repos_worktree ensures a (repo, branch) worktree exists (contract 3). The
// renderer calls this when a chat is re-pointed at a branch, before any
// toolExec/session-panel call carries that branch — those calls resolve with
// create=false, so by the time they arrive the worktree this route created
// (or reused) is already there.
async fn repos_worktree(State(st): State<AppState>, Json(body): Json<WorktreeBody>) -> Response {
    let name = body.name.trim().to_string();
    let branch = body.branch.trim().to_string();
    if branch.is_empty() {
        return json_ok(&serde_json::json!({
            "ok": false, "branch": "", "path": null, "created": false, "error": "branch is required",
        }));
    }
    let main = match resolve_repo(&st.data_dir, &name) {
        Some(p) => p,
        None => return json_ok(&serde_json::json!({
            "ok": false, "branch": branch, "path": null, "created": false, "error": "not found locally",
        })),
    };
    match ensure_worktree(&st.data_dir, &name, &main, &branch, body.create).await {
        Ok((path, created)) => json_ok(&serde_json::json!({
            "ok": true,
            "branch": branch,
            "path": path.display().to_string(),
            "created": created,
            "error": null,
        })),
        Err(e) => json_ok(&serde_json::json!({
            "ok": false, "branch": branch, "path": null, "created": false, "error": e,
        })),
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
        .route("/__sidecar/repos/add-local", post(repos_add_local))
        .route("/__sidecar/repos/scan-local", post(repos_scan_local))
        .route("/__sidecar/repos/clone", post(repos_clone))
        .route("/__sidecar/repos/refresh", post(repos_refresh))
        .route("/__sidecar/repos/open", post(repos_open))
        .route("/__sidecar/repos/exec", post(repos_exec))
        .route("/__sidecar/repos/exec/stream", post(repos_exec_stream))
        .route("/__sidecar/repos/diff", post(repos_diff))
        .route("/__sidecar/repos/revert", post(repos_revert))
        .route("/__sidecar/repos/changelog", post(repos_changelog))
        .route("/__sidecar/repos/ship", post(repos_ship))
        .route("/__sidecar/repos/set-folder", post(repos_set_folder))
        .route("/__sidecar/repos/branch", post(repos_branch))
        .route("/__sidecar/repos/create-branch", post(repos_create_branch))
        .route("/__sidecar/repos/state", get(repos_state))
        .route("/__sidecar/repos/branches", post(repos_branches))
        .route("/__sidecar/repos/checkout", post(repos_checkout))
        .route("/__sidecar/repos/commit", post(repos_commit))
        .route("/__sidecar/repos/create-pr", post(repos_create_pr))
        .route("/__sidecar/repos/prs", get(repos_prs))
        .route("/__sidecar/repos/merge-pr", post(repos_merge_pr))
        .route("/__sidecar/repos/worktree", post(repos_worktree))
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

#[cfg(test)]
mod tests {
    use super::*;

    fn j(v: serde_json::Value) -> String {
        v.to_string()
    }

    // init_test_repo creates a temp git repo with one committed file f.txt =
    // "a\nb\n". The agent's file-tool executors operate on it directly.
    async fn init_test_repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        let p = dir.path();
        let env = [
            ("GIT_AUTHOR_NAME", "T"),
            ("GIT_AUTHOR_EMAIL", "t@t"),
            ("GIT_COMMITTER_NAME", "T"),
            ("GIT_COMMITTER_EMAIL", "t@t"),
        ];
        let mut cmd = tokio::process::Command::new("git");
        cmd.arg("-C").arg(p).arg("init").arg("-q");
        for (k, v) in env {
            cmd.env(k, v);
        }
        let _ = cmd.output().await.expect("git init");
        let _ = tokio::process::Command::new("git")
            .arg("-C").arg(p).arg("config").arg("user.name").arg("T")
            .output().await.expect("git config name");
        let _ = tokio::process::Command::new("git")
            .arg("-C").arg(p).arg("config").arg("user.email").arg("t@t")
            .output().await.expect("git config email");
        std::fs::write(p.join("f.txt"), "a\nb\n").unwrap();
        let mut add = tokio::process::Command::new("git");
        add.arg("-C").arg(p).arg("add").arg("-A");
        for (k, v) in env {
            add.env(k, v);
        }
        let _ = add.output().await.expect("git add");
        let mut commit = tokio::process::Command::new("git");
        commit.arg("-C").arg(p).arg("commit").arg("-q").arg("-m").arg("init");
        for (k, v) in env {
            commit.env(k, v);
        }
        let _ = commit.output().await.expect("git commit");
        dir
    }

    #[test]
    fn normalize_patch_strips_fences_and_preamble() {
        let raw = "I'll edit the file:\n```diff\n--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n```";
        let n = normalize_patch(raw);
        assert!(n.starts_with("--- a/f.txt"), "preamble not stripped: {n:?}");
        assert!(!n.contains("```"), "fences not stripped: {n:?}");
        assert!(!n.contains("I'll"), "prose not stripped: {n:?}");
        assert!(n.ends_with('\n'), "no trailing newline: {n:?}");
        assert!(!n.ends_with("\n\n"), "more than one trailing newline: {n:?}");
    }

    #[test]
    fn normalize_patch_crlf_to_lf() {
        let raw = "--- a/f.txt\r\n+++ b/f.txt\r\n@@ -1,1 +1,1 @@\r\n-a\r\n+b\r\n";
        let n = normalize_patch(raw);
        assert!(!n.contains('\r'), "CRLF not normalized: {n:?}");
    }

    #[test]
    fn resolve_new_path_guards() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        // ok: new file in a not-yet-existing subdirectory.
        let p = resolve_new_path(&root, "src/new.txt").unwrap();
        assert!(p.starts_with(&root));
        assert!(p.ends_with("src/new.txt"));
        // .git is refused.
        assert!(resolve_new_path(&root, ".git/config").is_err());
        // .env (a real dotfile name) is allowed.
        assert!(resolve_new_path(&root, ".env").is_ok());
        // any .. component is refused (can't escape via a non-existent path).
        assert!(resolve_new_path(&root, "../escape.txt").is_err());
        assert!(resolve_new_path(&root, "a/../../escape.txt").is_err());
    }

    #[test]
    fn count_matches_counts_nonoverlapping() {
        assert_eq!(count_matches("foo bar foo", "foo"), 2);
        assert_eq!(count_matches("foo bar foo", "baz"), 0);
        assert_eq!(count_matches("aaaa", "aa"), 2); // non-overlapping
        assert_eq!(count_matches("x", ""), 0);
    }

    #[test]
    fn unified_diff_new_file_is_all_additions() {
        let d = unified_diff("", "a\nb\n", "f.txt");
        assert!(d.contains("--- a/f.txt"));
        assert!(d.contains("+++ b/f.txt"));
        assert!(d.contains("+a"));
        assert!(d.contains("+b"));
        assert!(!d.contains("-a"));
    }

    #[tokio::test]
    async fn edit_file_match_counting() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        std::fs::write(root.join("f.txt"), "foo\nbar\nfoo\n").unwrap();
        // 0 matches → error, file unchanged.
        let r0 = exec_edit_file(&root, &j(serde_json::json!({"path":"f.txt","old_string":"baz","new_string":"x"})), true).await;
        assert!(r0.is_error);
        assert!(r0.observation.contains("0 matches"), "got: {}", r0.observation);
        // >1 match without replace_all → error, file unchanged.
        let r1 = exec_edit_file(&root, &j(serde_json::json!({"path":"f.txt","old_string":"foo","new_string":"x"})), true).await;
        assert!(r1.is_error);
        assert!(r1.observation.contains("2 times"), "got: {}", r1.observation);
        assert_eq!(std::fs::read_to_string(root.join("f.txt")).unwrap(), "foo\nbar\nfoo\n");
        // >1 match with replace_all → success.
        let r2 = exec_edit_file(&root, &j(serde_json::json!({"path":"f.txt","old_string":"foo","new_string":"x","replace_all":true})), true).await;
        assert!(!r2.is_error);
        assert_eq!(std::fs::read_to_string(root.join("f.txt")).unwrap(), "x\nbar\nx\n");
        // exactly 1 match → success.
        std::fs::write(root.join("g.txt"), "hello\nworld\n").unwrap();
        let r3 = exec_edit_file(&root, &j(serde_json::json!({"path":"g.txt","old_string":"world","new_string":"all"})), true).await;
        assert!(!r3.is_error);
        assert_eq!(std::fs::read_to_string(root.join("g.txt")).unwrap(), "hello\nall\n");
    }

    #[tokio::test]
    async fn write_file_creates_and_overwrites() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        // create (with a new parent dir)
        let r1 = exec_write_file(&root, &j(serde_json::json!({"path":"sub/f.txt","content":"hi\n"})), true).await;
        assert!(!r1.is_error, "{}", r1.observation);
        assert!(r1.observation.contains("Created"));
        assert_eq!(std::fs::read_to_string(root.join("sub/f.txt")).unwrap(), "hi\n");
        // overwrite
        let r2 = exec_write_file(&root, &j(serde_json::json!({"path":"sub/f.txt","content":"bye\n"})), true).await;
        assert!(!r2.is_error);
        assert!(r2.observation.contains("Overwrote"));
        assert_eq!(std::fs::read_to_string(root.join("sub/f.txt")).unwrap(), "bye\n");
    }

    #[tokio::test]
    async fn delete_path_requires_recursive_for_dirs() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        std::fs::create_dir_all(root.join("d")).unwrap();
        std::fs::write(root.join("d/f.txt"), "x").unwrap();
        // dir without recursive → error
        let r1 = exec_delete_path(&root, &j(serde_json::json!({"path":"d"})), true).await;
        assert!(r1.is_error);
        assert!(r1.observation.contains("directory"));
        assert!(root.join("d").exists());
        // dir with recursive → deleted
        let r2 = exec_delete_path(&root, &j(serde_json::json!({"path":"d","recursive":true})), true).await;
        assert!(!r2.is_error);
        assert!(!root.join("d").exists());
        // refuse repo root
        let r3 = exec_delete_path(&root, &j(serde_json::json!({"path":"."})), true).await;
        assert!(r3.is_error);
    }

    #[tokio::test]
    async fn move_path_renames_and_makes_parents() {
        let dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        std::fs::write(root.join("a.txt"), "data").unwrap();
        let r = exec_move_path(&root, &j(serde_json::json!({"from":"a.txt","to":"nested/b.txt"})), true).await;
        assert!(!r.is_error, "{}", r.observation);
        assert!(!root.join("a.txt").exists());
        assert_eq!(std::fs::read_to_string(root.join("nested/b.txt")).unwrap(), "data");
    }

    #[tokio::test]
    async fn apply_patch_ladder_wrong_counts_no_trailing_newline() {
        let dir = init_test_repo().await;
        let root = dir.path();
        // A diff with wrong hunk line counts (-1,3 +1,3 but only 2 old / 2 new
        // lines) and no trailing newline on the patch text. Strict git apply
        // fails ("corrupt patch"); normalize_patch adds the trailing newline
        // and the --recount rung recomputes the counts.
        let patch = "--- a/f.txt\n+++ b/f.txt\n@@ -1,3 +1,3 @@\n a\n-b\n+c"; // no trailing \n
        let args = j(serde_json::json!({ "patch": patch }));
        let res = exec_apply_patch(root, &args, true).await;
        assert!(!res.is_error, "expected ladder to apply, got: {}", res.observation);
        assert_eq!(std::fs::read_to_string(root.join("f.txt")).unwrap(), "a\nc\n");
    }

    #[tokio::test]
    async fn apply_patch_ladder_zero_context_hunk() {
        let dir = init_test_repo().await;
        let root = dir.path();
        // A zero-context hunk (no context lines). Strict git apply may reject
        // it; the --unidiff-zero rung accepts it. Either way the ladder should
        // succeed and insert "new" before "a".
        let patch = "--- a/f.txt\n+++ b/f.txt\n@@ -1,0 +1,1 @@\n+new\n";
        let args = j(serde_json::json!({ "patch": patch }));
        let res = exec_apply_patch(root, &args, true).await;
        assert!(!res.is_error, "expected zero-context apply to succeed, got: {}", res.observation);
        assert_eq!(std::fs::read_to_string(root.join("f.txt")).unwrap(), "new\na\nb\n");
    }

    #[tokio::test]
    async fn apply_patch_failure_nudges_to_edit_file() {
        let dir = init_test_repo().await;
        let root = dir.path();
        // A patch whose context doesn't match the file — every rung fails.
        let patch = "--- a/f.txt\n+++ b/f.txt\n@@ -1,1 +1,1 @@\n-zzz\n+q\n";
        let args = j(serde_json::json!({ "patch": patch }));
        let res = exec_apply_patch(root, &args, true).await;
        assert!(res.is_error);
        assert!(res.observation.contains("edit_file"), "missing switch-tool nudge: {}", res.observation);
        assert!(res.observation.contains("unchanged"));
        // file untouched
        assert_eq!(std::fs::read_to_string(root.join("f.txt")).unwrap(), "a\nb\n");
    }

    // init_test_repo_with_ignore is init_test_repo plus a committed .gitignore
    // (ignoring .env and ignored_dir/) with .env and ignored_dir/x.txt left
    // untracked on disk, so the gitignore-aware file tools have something to
    // mark (discovery) / skip (content). f.txt holds a distinctive token so grep
    // can assert ignored files are never searched.
    async fn init_test_repo_with_ignore() -> tempfile::TempDir {
        let dir = tempfile::tempdir().expect("tempdir");
        let p = dir.path();
        let env = [
            ("GIT_AUTHOR_NAME", "T"),
            ("GIT_AUTHOR_EMAIL", "t@t"),
            ("GIT_COMMITTER_NAME", "T"),
            ("GIT_COMMITTER_EMAIL", "t@t"),
        ];
        let mut cmd = tokio::process::Command::new("git");
        cmd.arg("-C").arg(p).arg("init").arg("-q");
        for (k, v) in env { cmd.env(k, v); }
        let _ = cmd.output().await.expect("git init");
        let _ = tokio::process::Command::new("git")
            .arg("-C").arg(p).arg("config").arg("user.name").arg("T")
            .output().await.expect("git config name");
        let _ = tokio::process::Command::new("git")
            .arg("-C").arg(p).arg("config").arg("user.email").arg("t@t")
            .output().await.expect("git config email");
        // .gitignore is committed BEFORE git add -A so .env/ignored_dir/ stay
        // untracked (ignored), while .gitignore and f.txt are tracked.
        std::fs::write(p.join(".gitignore"), ".env\nignored_dir/\n").unwrap();
        std::fs::write(p.join("f.txt"), "a\nb\nSECRETTOKEN\n").unwrap();
        std::fs::write(p.join(".env"), "TOPSECRET=value\n").unwrap();
        std::fs::create_dir_all(p.join("ignored_dir")).unwrap();
        std::fs::write(p.join("ignored_dir/x.txt"), "ignored content\n").unwrap();
        let mut add = tokio::process::Command::new("git");
        add.arg("-C").arg(p).arg("add").arg("-A");
        for (k, v) in env { add.env(k, v); }
        let _ = add.output().await.expect("git add");
        let mut commit = tokio::process::Command::new("git");
        commit.arg("-C").arg(p).arg("commit").arg("-q").arg("-m").arg("init");
        for (k, v) in env { commit.env(k, v); }
        let _ = commit.output().await.expect("git commit");
        dir
    }

    #[tokio::test]
    async fn read_file_refuses_gitignored_secret() {
        let dir = init_test_repo_with_ignore().await;
        let root = std::fs::canonicalize(dir.path()).unwrap();
        // .env is gitignored → refused, and its contents never enter the
        // observation (the agent must not be able to read a secret).
        let r = exec_read_file(&root, &j(serde_json::json!({"path":".env"}))).await;
        assert!(r.is_error, "expected refusal, got: {}", r.observation);
        assert!(r.observation.contains("gitignored"), "got: {}", r.observation);
        assert!(r.observation.contains("secret"), "got: {}", r.observation);
        assert!(!r.observation.contains("TOPSECRET"), "refusal leaked contents: {}", r.observation);
        // A tracked dotfile (.gitignore) reads normally now that safe_path
        // preserves leading dots (previously ".gitignore" → "gitignore", fail).
        let r2 = exec_read_file(&root, &j(serde_json::json!({"path":".gitignore"}))).await;
        assert!(!r2.is_error, "expected .gitignore to read, got: {}", r2.observation);
        assert!(r2.observation.contains(".env"));
    }

    #[tokio::test]
    async fn tree_marks_ignored_and_lists_dotfiles() {
        let dir = init_test_repo_with_ignore().await;
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let r = exec_tree(&root, &j(serde_json::json!({"path":"."}))).await;
        assert!(!r.is_error, "{}", r.observation);
        // tracked dotfile is listed (no longer hidden behind the dotfile skip).
        assert!(r.observation.contains(".gitignore"), "missing .gitignore: {}", r.observation);
        // ignored file + dir are marked (ignored); the dir's contents are not
        // listed as normal entries (asserted via the content not leaking).
        assert!(r.observation.contains(".env (ignored)"), "missing .env mark: {}", r.observation);
        assert!(r.observation.contains("ignored_dir/"), "ignored dir not surfaced: {}", r.observation);
        assert!(r.observation.contains("(ignored)"), "ignored dir not marked: {}", r.observation);
        assert!(r.observation.contains("f.txt"), "missing f.txt: {}", r.observation);
        assert!(!r.observation.contains("TOPSECRET"), "leaked .env content: {}", r.observation);
        assert!(!r.observation.contains("ignored content"), "leaked ignored_dir content: {}", r.observation);
    }

    #[tokio::test]
    async fn tree_depth_cap_recurses_only_to_max_depth() {
        let dir = init_test_repo_with_ignore().await;
        let root = std::fs::canonicalize(dir.path()).unwrap();
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("sub/nested.txt"), "n\n").unwrap();
        // depth=1 lists the top-level subdir but does not recurse into it.
        let r1 = exec_tree(&root, &j(serde_json::json!({"path":".","depth":1}))).await;
        assert!(r1.observation.contains("sub/"), "depth=1 should list sub/: {}", r1.observation);
        assert!(!r1.observation.contains("sub/nested.txt"), "depth=1 recursed: {}", r1.observation);
        // depth=3 reaches the nested file.
        let r2 = exec_tree(&root, &j(serde_json::json!({"path":".","depth":3}))).await;
        assert!(r2.observation.contains("sub/nested.txt"), "depth=3 missed nested: {}", r2.observation);
    }

    #[tokio::test]
    async fn glob_finds_tracked_dotfile_and_marks_ignored() {
        let dir = init_test_repo_with_ignore().await;
        let root = std::fs::canonicalize(dir.path()).unwrap();
        let r = exec_glob(&root, &j(serde_json::json!({"pattern":"*"}))).await;
        assert!(!r.is_error, "{}", r.observation);
        assert!(r.observation.contains(".gitignore"), "missing .gitignore: {}", r.observation);
        assert!(r.observation.contains(".env (ignored)"), "missing .env mark: {}", r.observation);
        assert!(!r.observation.contains("TOPSECRET"), "glob leaked .env: {}", r.observation);
    }

    #[tokio::test]
    async fn grep_skips_gitignored_files() {
        let dir = init_test_repo_with_ignore().await;
        let root = std::fs::canonicalize(dir.path()).unwrap();
        // "SECRET" is in f.txt (tracked) and .env (ignored): only f.txt matches.
        let r = exec_grep(&root, &j(serde_json::json!({"pattern":"SECRET"}))).await;
        assert!(!r.is_error, "{}", r.observation);
        assert!(r.observation.contains("f.txt"), "expected f.txt match: {}", r.observation);
        assert!(!r.observation.contains(".env"), "grep searched ignored .env: {}", r.observation);
        assert!(!r.observation.contains("TOPSECRET"), "grep leaked .env: {}", r.observation);
        // A token present only in the ignored file yields no matches at all.
        let r2 = exec_grep(&root, &j(serde_json::json!({"pattern":"TOPSECRET"}))).await;
        assert!(!r2.is_error);
        assert!(!r2.observation.contains("TOPSECRET"), "grep leaked ignored-only match: {}", r2.observation);
    }
}

