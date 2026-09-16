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

// serde default for use_git: old repos.json entries (pre-workspace) lack the
// field, so they deserialize to true and stay git-enabled.
fn default_true() -> bool { true }

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
	#[serde(default = "default_true")]
	use_git: bool,
	#[serde(default, skip_serializing_if = "Option::is_none")]
	name: Option<String>,
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
		existing.use_git = rec.use_git;
		existing.name = rec.name.clone();
		if rec.folder_id.is_some() {
			existing.folder_id = rec.folder_id.clone();
		}
	} else {
		repos.push(rec.clone());
	}
	save_registry(data_dir, &repos);
}

// repo_use_git reports whether a connected workspace is git-enabled. Looks up
// the sidecar registry record by full_name; a record not in the registry (e.g.
// a workspace-dir-only clone discovered by repos_local, which always has .git)
// defaults to true, preserving the old behaviour for pre-workspace clones.
fn repo_use_git(data_dir: &Path, name: &str) -> bool {
	load_registry(data_dir)
		.into_iter()
		.find(|r| r.full_name == name.trim())
		.map(|r| r.use_git)
		.unwrap_or(true)
}

// git_not_enabled is the standard soft response for a git route invoked against
// a non-git workspace (useGit=false). Returns {ok:false,error} so the UI can
// surface the reason; used by the branch/PR/commit/diff/revert/ship routes.
fn git_not_enabled() -> Response {
	json_ok(&serde_json::json!({ "ok": false, "error": "workspace is not git-enabled" }))
}

// is_git_tool reports whether an agent tool name requires git (status/log/PRs
// + commit/push/PR/merge). repos_exec short-circuits these for a non-git
// workspace so the model gets a clear observation instead of a git failure.
fn is_git_tool(tool: &str) -> bool {
	matches!(
		tool,
		"git_status" | "git_log" | "list_prs" | "git_commit" | "git_push" | "create_pr" | "merge_pr" | "pr_view" | "pr_diff" | "pr_checks" | "pr_comment" | "pr_close" | "pr_ready" | "pr_edit" | "create_repo" | "link_remote"
	)
}

// is_safe_workspace_name validates a user-chosen workspace name: letters,
// digits, spaces, dot, dash, underscore only — no slashes (so it can't escape
// the workspace dir) and no shell metacharacters. Capped at 80 chars.
fn is_safe_workspace_name(s: &str) -> bool {
	let t = s.trim();
	if t.is_empty() || t.len() > 80 {
		return false;
	}
	t.chars().all(|c| c.is_alphanumeric() || c == ' ' || c == '.' || c == '-' || c == '_')
}

// is_write_tool reports whether an agent tool mutates files (so a non-git
// workspace snapshots before running it, enabling /repos/undo-last). run_command
// is intentionally excluded: it's not a direct file mutation by the tool itself,
// and snapshotting before every command would be too aggressive.
fn is_write_tool(tool: &str) -> bool {
	matches!(
		tool,
		"write_file" | "edit_file" | "delete_path" | "move_path" | "apply_patch"
	)
}

// --- Recovery snapshots for non-git workspaces (undo-last) -----------------
//
// A non-git workspace has no `git stash` / `git checkout -- .` to undo an
// approved write. Instead, repos_exec snapshots the workspace tree into
// <data_dir>/snapshots/<name>/<millis>/ before each approved write tool, and
// /repos/undo-last restores the newest snapshot. Heavy dirs (node_modules,
// build caches, .git) are skipped to keep snapshots small. Only the last 3 are
// kept per workspace.

fn snapshots_dir(data_dir: &Path) -> PathBuf {
	data_dir.join("snapshots")
}

const SNAPSHOT_SKIP_DIRS: &[&str] = &[
	"node_modules",
	".git",
	"target",
	"dist",
	"build",
	".venv",
	"__pycache__",
	".next",
	".cache",
	".DS_Store",
];

// copy_tree recursively copies src into dst, skipping directory entries whose
// names are in `skip` (heavy build/dep dirs) and symlinks (never followed, so a
// symlink can't escape the workspace root). Best-effort: special files are
// skipped silently.
fn copy_tree(src: &Path, dst: &Path, skip: &[&str]) -> Result<(), String> {
	std::fs::create_dir_all(dst).map_err(|e| format!("mkdir {dst:?}: {e}"))?;
	for ent in std::fs::read_dir(src).map_err(|e| format!("readdir {src:?}: {e}"))? {
		let ent = ent.map_err(|e| format!("dirent: {e}"))?;
		let ft = ent.file_type().map_err(|e| format!("filetype: {e}"))?;
		if ft.is_symlink() {
			continue;
		}
		let name = ent.file_name();
		let name_s = name.to_string_lossy();
		if ft.is_dir() && skip.iter().any(|s| *s == name_s) {
			continue;
		}
		let from = ent.path();
		let to = dst.join(&name);
		if ft.is_dir() {
			copy_tree(&from, &to, skip)?;
		} else if ft.is_file() {
			let _ = std::fs::copy(&from, &to);
		}
	}
	Ok(())
}

// snapshot_workspace copies the workspace tree into a timestamped snapshot dir and
// prunes to the last 3. Returns the snapshot path. Used by repos_exec before an
// approved write tool on a non-git workspace.
fn snapshot_workspace(data_dir: &Path, name: &str, root: &Path) -> Result<PathBuf, String> {
	let base = snapshots_dir(data_dir).join(safe_name(name));
	std::fs::create_dir_all(&base).map_err(|e| format!("snapshots dir: {e}"))?;
	let stamp = std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map(|d| d.as_millis())
		.unwrap_or(0);
	let snap = base.join(format!("{stamp}"));
	// If a snapshot for the same millisecond already exists (unlikely), reuse it.
	if !snap.is_dir() {
		copy_tree(root, &snap, SNAPSHOT_SKIP_DIRS)?;
	}
	// Prune to the newest 3 (names are zero-padded millis timestamps, so lexical
	// sort = chronological).
	if let Ok(entries) = std::fs::read_dir(&base) {
		let mut names: Vec<String> = entries
			.filter_map(|e| e.ok())
			.filter_map(|e| e.file_name().into_string().ok())
			.collect();
		names.sort();
		names.reverse();
		for old in names.into_iter().skip(3) {
			let _ = std::fs::remove_dir_all(base.join(&old));
		}
	}
	Ok(snap)
}

// remove_path removes a file or directory tree (the workspace clear step uses
// this so a non-dir entry doesn't trip remove_dir_all's NotADirectory).
fn remove_path(p: &Path) {
	if p.is_dir() {
		let _ = std::fs::remove_dir_all(p);
	} else {
		let _ = std::fs::remove_file(p);
	}
}

// undo_last_snapshot restores the newest snapshot into the workspace: clears the
// workspace's non-skip contents, copies the snapshot back, and removes the
// restored snapshot so the next undo goes one further back. Returns an error
// string when there's nothing to restore.
fn undo_last_snapshot(data_dir: &Path, name: &str, root: &Path) -> Result<(), String> {
	let base = snapshots_dir(data_dir).join(safe_name(name));
	let mut entries: Vec<String> = std::fs::read_dir(&base)
		.map_err(|e| format!("snapshots dir: {e}"))?
		.filter_map(|e| e.ok())
		.filter_map(|e| e.file_name().into_string().ok())
		.collect();
	if entries.is_empty() {
		return Err("no snapshot to restore".to_string());
	}
	entries.sort();
	entries.reverse();
	let snap = base.join(&entries[0]);
	// Clear the workspace's non-skip contents (keep node_modules/.git/etc).
	for ent in std::fs::read_dir(root).map_err(|e| format!("readdir root: {e}"))? {
		let ent = ent.map_err(|e| format!("dirent: {e}"))?;
		let name_s = ent.file_name().to_string_lossy().to_string();
		if SNAPSHOT_SKIP_DIRS.iter().any(|s| *s == name_s.as_str()) {
			continue;
		}
		remove_path(&ent.path());
	}
	copy_tree(&snap, root, SNAPSHOT_SKIP_DIRS)?;
	// Remove the restored snapshot so the next undo restores the prior one.
	let _ = std::fs::remove_dir_all(&snap);
	Ok(())
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

// --- Folder-follows-active-chat: one checkout shared by chats on a repo -----
//
// A repo has one working tree (its clone/linked folder). The folder always
// tracks the active chat's branch: switching to a chat/branch runs
// ensure_folder_on_branch, which auto-stashes any dirty work-in-progress
// (keyed per branch) so a switch never carries another chat's uncommitted
// edits, then switches the folder and pops the target branch's parked stash.
// No git worktrees are created — node_modules, .env, and build caches persist
// across switches because ignored files are never stashed.

// git_stash_push runs `git stash push -u -m <msg>` in <path>. `-u` stashes
// tracked + untracked-but-not-ignored work-in-progress while LEAVING ignored
// files (node_modules, .env, build caches) in the working tree, so there is no
// reinstall on return. Returns Ok(()) on success (including "No local changes
// to save", which exits 0) or Err with the git error text.
async fn git_stash_push(path: &Path, msg: &str) -> Result<(), String> {
    let out = tokio::process::Command::new("git")
        .arg("-C").arg(path)
        .arg("stash").arg("push").arg("-u").arg("-m").arg(msg)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output().await
        .map_err(|e| format!("git stash push: {e}"))?;
    if !out.status.success() {
        let m = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if m.is_empty() { "git stash push failed".to_string() } else { m });
    }
    Ok(())
}

// git_stash_list_tagged returns the stash subjects tagged with the nasllm:
// prefix — i.e. the per-branch stashes created by ensure_folder_on_branch.
// Each `git stash list` line is "stash@{N}: On <branch>: <subject>"; the
// subject is the trailing segment after the last ": " (branch names cannot
// contain ": " so the split is unambiguous). Stash ownership is by message
// tag (nasllm:<branch>), so a stash survives sidecar restart and stash-stack
// shifts. Used by the ensure_folder_on_branch test to verify stash state.
#[allow(dead_code)]
async fn git_stash_list_tagged(path: &Path) -> Vec<String> {
    let out = tokio::process::Command::new("git")
        .arg("-C").arg(path)
        .arg("stash").arg("list")
        .output().await;
    let mut result = Vec::new();
    let Ok(o) = out else { return result };
    if !o.status.success() {
        return result;
    }
    for line in String::from_utf8_lossy(&o.stdout).lines() {
        if let Some(subject) = line.rsplit_once(": ").map(|(_, s)| s) {
            if subject.starts_with("nasllm:") {
                result.push(subject.to_string());
            }
        }
    }
    result
}

// git_stash_pop_tagged pops the stash whose subject equals <tag> (e.g.
// "nasllm:<branch>"), located via `git stash list`. If no matching stash
// exists, this is a no-op (Ok). On a clean pop the stash is dropped by git. On
// a pop conflict (non-zero exit) the stash is KEPT (git does not drop it) and
// the conflict text is returned as Err so the caller can surface a warning —
// edits are never silently lost. The user can then `git stash pop` manually
// after resolving.
async fn git_stash_pop_tagged(path: &Path, tag: &str) -> Result<(), String> {
    let list = tokio::process::Command::new("git")
        .arg("-C").arg(path)
        .arg("stash").arg("list")
        .output().await
        .map_err(|e| format!("git stash list: {e}"))?;
    if !list.status.success() {
        return Ok(()); // no stashes / git error → no-op
    }
    // Find the stash@{N} ref whose trailing subject matches <tag>.
    let mut target: Option<String> = None;
    for line in String::from_utf8_lossy(&list.stdout).lines() {
        if let Some(subject) = line.rsplit_once(": ").map(|(_, s)| s) {
            if subject == tag {
                // The line starts with "stash@{N}:"; take everything before the
                // first ':' as the ref. Args are passed directly (no shell), so
                // the braces in stash@{N} are safe.
                if let Some(ref_str) = line.split(':').next() {
                    target = Some(ref_str.trim().to_string());
                    break;
                }
            }
        }
    }
    let Some(ref_str) = target else { return Ok(()) };

    let pop = tokio::process::Command::new("git")
        .arg("-C").arg(path)
        .arg("stash").arg("pop").arg(&ref_str)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output().await
        .map_err(|e| format!("git stash pop: {e}"))?;
    if pop.status.success() {
        return Ok(());
    }
    // Conflict: git keeps the stash. Surface the conflict text as a warning.
    let combined = format!(
        "{}\n{}",
        String::from_utf8_lossy(&pop.stdout),
        String::from_utf8_lossy(&pop.stderr)
    );
    let msg = combined.trim().to_string();
    Err(if msg.is_empty() {
        format!("stash pop conflict for {tag}; stash kept — resolve and `git stash pop` manually")
    } else {
        format!("{msg}\n(stash {ref_str} kept — resolve and `git stash pop` manually)")
    })
}

// ensure_folder_on_branch switches the repo's single checkout (the folder at
// `main`) onto `branch`, auto-stashing any dirty work-in-progress keyed per
// branch so a switch never carries another chat's uncommitted edits. One
// checkout is shared by all chats on a repo; there are no git worktrees.
//
// Steps (skipped for non-git workspaces or an empty branch, which return main
// unchanged):
//  1. Already on `branch` → pop any stash parked for it, return main.
//  2. Dirty folder → `git stash push -u -m "nasllm:<current_branch>"`. `-u`
//     stashes tracked + untracked-non-ignored WIP but leaves ignored files
//     (node_modules, .env, build caches) in place — no reinstall on return.
//  3. Switch: `git switch <branch>` if the ref exists, else `git switch -c
//     <branch> <base>` (base defaults to the repo's default branch).
//  4. Pop the stash tagged `nasllm:<branch>` if one exists. On pop conflict
//     the stash is KEPT and the conflict text is returned as Err so the caller
//     surfaces a warning — edits are never silently lost.
//  5. Update the registry branch so the sidebar reflects the switch. (The
//     caller re-pushes repo context to the backend, which needs AppState.)
//
// Returns Ok(main) on a clean switch (or no-op), Err(msg) on a stash/switch
// failure or a pop conflict (the folder is switched either way; the stash is
// kept for manual `git stash pop`).
async fn ensure_folder_on_branch(
    data_dir: &Path,
    main: &Path,
    repo_name: &str,
    branch: &str,
    base: &str,
) -> Result<PathBuf, String> {
    let branch = branch.trim();
    if branch.is_empty() || !repo_use_git(data_dir, repo_name) {
        return Ok(main.to_path_buf());
    }
    let current = git_branch(main).await;
    let tag = format!("nasllm:{branch}");

    // Already on the target branch: restore its parked stash (if any) and done.
    if current == branch {
        git_stash_pop_tagged(main, &tag).await?;
        return Ok(main.to_path_buf());
    }

    // Dirty folder: stash WIP keyed by the CURRENT branch so it is restored
    // when we switch back. `-u` stashes tracked + untracked-non-ignored files
    // but leaves ignored files (node_modules, .env, build caches) in place.
    if git_dirty_count(main).await > 0 {
        git_stash_push(main, &format!("nasllm:{current}")).await?;
    }

    // Switch onto the target branch (create from base if it doesn't exist yet).
    let has_local = git_has_ref(main, &format!("refs/heads/{branch}")).await;
    let resolved_base = if base.trim().is_empty() {
        git_default_branch(main).await
    } else {
        base.trim().to_string()
    };
    let out = if has_local {
        tokio::process::Command::new("git")
            .arg("-C").arg(main)
            .arg("switch").arg(branch)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output().await
    } else {
        tokio::process::Command::new("git")
            .arg("-C").arg(main)
            .arg("switch").arg("-c").arg(branch).arg(&resolved_base)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .output().await
    };
    match out {
        Ok(o) if o.status.success() => {}
        Ok(o) => {
            let combined = format!(
                "{}\n{}",
                String::from_utf8_lossy(&o.stdout),
                String::from_utf8_lossy(&o.stderr)
            );
            let msg = combined.trim().to_string();
            return Err(if msg.is_empty() { "git switch failed".to_string() } else { msg });
        }
        Err(e) => return Err(format!("git switch: {e}")),
    }

    // Pop the stash parked for the target branch (if any). On conflict the
    // stash is kept and the conflict text is returned as Err — the folder is
    // switched but the user must resolve the stash manually.
    git_stash_pop_tagged(main, &tag).await?;

    // Update the registry branch so the sidebar reflects the switch.
    if let Some(rec) = load_registry(data_dir).into_iter().find(|r| r.full_name == repo_name) {
        upsert_registry(data_dir, &RepoRecord { branch: branch.to_string(), ..rec });
    }
    Ok(main.to_path_buf())
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

// git_init_and_initial_commit turns a plain folder into a git repo in place:
// `git init -b main`, stage everything, and make an initial (possibly empty)
// commit so HEAD exists and branch/head/tree can be derived. Used by
// /repos/create-workspace (useGit=true on a non-git folder) and /repos/init-git
// (promote a non-git workspace to git-enabled). Returns an error string on
// failure; the caller surfaces it to the UI.
async fn git_init_and_initial_commit(path: &Path) -> Result<(), String> {
    let init = tokio::process::Command::new("git")
        .arg("init")
        .arg("-b")
        .arg("main")
        .arg(path)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .await;
    match init {
        Ok(o) if !o.status.success() => {
            let msg = String::from_utf8_lossy(&o.stderr).trim().to_string();
            return Err(format!(
                "git init failed: {}",
                if msg.is_empty() { "unknown error" } else { &msg }
            ));
        }
        Err(e) => return Err(format!("git init failed: {e}")),
        _ => {}
    }
    // Stage everything (an empty dir stages nothing — ignore errors).
    let _ = tokio::process::Command::new("git")
        .arg("-C")
        .arg(path)
        .arg("add")
        .arg("-A")
        .output()
        .await;
    let commit = tokio::process::Command::new("git")
        .arg("-C")
        .arg(path)
        .arg("commit")
        .arg("-m")
        .arg("Initial commit")
        .arg("--allow-empty")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .output()
        .await;
    match commit {
        Ok(o) if o.status.success() => Ok(()),
        Ok(o) => {
            let msg = String::from_utf8_lossy(&o.stderr).trim().to_string();
            Err(format!(
                "initial commit failed: {}",
                if msg.is_empty() { "unknown error" } else { &msg }
            ))
        }
        Err(e) => Err(format!("initial commit failed: {e}")),
    }
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
	#[serde(default = "default_true")]
	use_git: bool,
}

#[derive(Deserialize)]
struct CloneBody {
    full_name: String,
    clone_url: Option<String>,
}

#[derive(Deserialize)]
struct NameBody {
    name: String,
    // Optional per-chat branch, accepted for shape compat but ignored: the
    // folder always tracks the active chat's branch (ensure_folder_on_branch).
    #[serde(default)]
    #[allow(dead_code)]
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
	// Linked/registered workspaces first (existing folders + cloned repos that
	// have been recorded in the registry).
	for r in load_registry(&st.data_dir) {
		let path = PathBuf::from(&r.path);
		if !path.is_dir() {
			continue;
		}
		let (branch, dirty) = if r.use_git {
			let br = if r.branch.is_empty() {
				git_branch(&path).await
			} else {
				r.branch.clone()
			};
			(br, git_dirty_count(&path).await)
		} else {
			// Non-git workspace: no branch, nothing dirty in the git sense.
			(String::new(), 0)
		};
		seen.insert(r.full_name.clone());
		out.push(LocalRepo {
			name: r.name.clone().unwrap_or_else(|| r.full_name.clone()),
			path: path.display().to_string(),
			branch,
			dirty,
			remote: r.remote.clone(),
			full_name: Some(r.full_name.clone()),
			linked: r.linked,
			use_git: r.use_git,
		});
	}
	// Cloned workspace repos not yet in the registry (e.g. cloned before this
	// change). Scanning the workspace dir keeps backward compatibility. These are
	// always git clones (they have .git), so use_git=true.
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
				use_git: true,
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
            use_git: true,
            name: Some(full_name.clone()),
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
    if !repo_use_git(&st.data_dir, &name) { return git_not_enabled(); }
    // Always pull the folder (one checkout shared by chats on a repo; the
    // folder tracks the active chat's branch). The branch field is accepted
    // for shape compat but ignored.
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
    if !repo_use_git(&st.data_dir, &name) { return git_not_enabled(); }
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
    if !repo_use_git(&st.data_dir, &name) { return git_not_enabled(); }
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
    if !repo_use_git(&st.data_dir, &name) { return git_not_enabled(); }
    let dest = match resolve_repo(&st.data_dir, &name) {
        Some(p) => p,
        None => return json_err("not found locally", StatusCode::NOT_FOUND),
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
    if !repo_use_git(&st.data_dir, &name) { return git_not_enabled(); }
    let dest = match resolve_repo(&st.data_dir, &name) {
        Some(p) => p,
        None => return json_err("not found locally", StatusCode::NOT_FOUND),
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
    // Non-git workspace: short-circuit git tools (git_status/git_log/list_prs/
    // git_commit/git_push/create_pr/merge_pr) with a clear observation so the
    // model learns git isn't available instead of hitting a raw git failure. File
    // tools run unchanged below.
    if !repo_use_git(&st.data_dir, &repo_name) && is_git_tool(&body.tool) {
        return json_ok(&ExecResult {
            observation: format!(
                "Git is not enabled for workspace \"{repo_name}\". The {tool} tool is unavailable — this workspace is a plain folder with no git history. Use the file tools (read_file, list_files, grep, edit_file, write_file) instead.",
                tool = body.tool
            ),
            preview: "git not enabled".into(),
            is_error: true,
            ..Default::default()
        });
    }
    let main = match resolve_repo(&st.data_dir, &repo_name) {
        Some(p) => p,
        None => return json_ok(&ExecResult {
            observation: format!("Repository {repo_name} is not available locally."),
            preview: "repo not found".into(),
            is_error: true,
            ..Default::default()
        }),
    };
    // branch: switch the folder onto the chat's branch (auto-stash/pop). An
    // empty branch (older clients, branchless chat) uses the folder as-is.
    let dest = match ensure_folder_on_branch(&st.data_dir, &main, &repo_name, &body.branch, "").await {
        Ok(p) => p,
        Err(e) => return json_ok(&ExecResult {
            observation: format!("Branch switch unavailable: {e}"),
            preview: "branch switch error".into(),
            is_error: true,
            ..Default::default()
        }),
    };
    let root = match std::fs::canonicalize(&dest) {
        Ok(r) => r,
        Err(e) => return json_ok(&ExecResult { observation: format!("repo dir: {e}"), preview: "error".into(), is_error: true, ..Default::default() }),
    };
    // Non-git workspace + approved write tool: snapshot the tree first so the
    // user can undo the last write via /repos/undo-last (the non-git analog of
    // git revert). Best-effort: a snapshot failure is ignored so the write still
    // runs (the agent shouldn't be blocked by a backup problem).
    if !repo_use_git(&st.data_dir, &repo_name) && is_write_tool(&body.tool) && body.approved {
        let _ = snapshot_workspace(&st.data_dir, &repo_name, &root);
    }
    let result = match body.tool.as_str() {
        "read_file" => exec_read_file(&root, &body.args).await,
        "list_files" => exec_list_files(&root, &body.args).await,
        "tree" => exec_tree(&root, &body.args).await,
        "glob" => exec_glob(&root, &body.args).await,
        "grep" => exec_grep(&root, &body.args).await,
        "git_status" => exec_git_status(&root).await,
        "git_log" => exec_git_log(&root, &body.args).await,
        "list_prs" => exec_list_prs(&st.client, &root, &body.args).await,
        "pr_view" => exec_pr_view(&st.client, &root, &body.args).await,
        "pr_diff" => exec_pr_diff(&st.client, &root, &body.args).await,
        "pr_checks" => exec_pr_checks(&st.client, &root, &body.args).await,
        "git_commit" => exec_git_commit(&root, &body.args, body.approved).await,
        "git_push" => exec_git_push(&root, &body.args, body.approved).await,
        "create_pr" => exec_create_pr(&st.client, &root, &body.args, body.approved).await,
        "merge_pr" => exec_merge_pr(&st.client, &root, &body.args, body.approved).await,
        "pr_comment" => exec_pr_comment(&st.client, &root, &body.args, body.approved).await,
        "pr_close" => exec_pr_close(&st.client, &root, &body.args, body.approved).await,
        "pr_ready" => exec_pr_ready(&st.client, &root, &body.args, body.approved).await,
        "pr_edit" => exec_pr_edit(&st.client, &root, &body.args, body.approved).await,
        "create_repo" => exec_create_repo(&st.client, &root, &body.args, body.approved).await,
        "link_remote" => exec_link_remote(&root, &body.args, body.approved).await,
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
    let dest = match ensure_folder_on_branch(&st.data_dir, &main, &repo_name, &body.branch, "").await {
        Ok(p) => p,
        Err(e) => return sse_error(&format!("Branch switch unavailable: {e}")),
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

// --- SSH tool executor (runs ssh against a ~/.ssh/config alias) ------------
//
// The agent's ssh_* tools run here, on the desktop, shelling out to the system
// ssh. The host is an allowlisted alias resolved via the user's ~/.ssh/config —
// no credentials are stored in the app. ssh_run is approval-gated (always
// prompts, even with auto-approve on, like delete_path/create_pr/merge_pr); the
// three read tools run immediately. BatchMode=yes makes auth fail fast instead
// of hanging on a password prompt, and a carried timeout + kill_on_drop bound
// a non-exiting command (mirrors run_command's discipline).

#[derive(Deserialize)]
struct SshExecBody {
    host: String,
    tool: String,
    args: String,
    #[serde(default)]
    approved: bool,
    #[serde(default)]
    run_command_timeout_ms: u64,
}

// ssh_exec is the buffered path: read tools run here, and ssh_run's first
// (unapproved) call returns needs_approval with a host+command preview. An
// approved ssh_run can also run here as a non-streaming fallback, but the
// renderer normally uses /stream for the live command block.
async fn ssh_exec(State(_): State<AppState>, Json(body): Json<SshExecBody>) -> Response {
    let host = body.host.trim().to_string();
    if !is_safe_ssh_alias(&host) {
        return json_ok(&ExecResult {
            observation: format!("Invalid SSH host alias: {host}"),
            preview: "bad host".into(),
            is_error: true,
            ..Default::default()
        });
    }
    // ssh_run is approval-gated: the first call returns needs_approval so the
    // renderer can show host + command and re-POST with approved=true (or to
    // /stream for the live block). It is never auto-approved.
    if body.tool == "ssh_run" && !body.approved {
        let command = ssh_run_command(&body.args);
        let preview = if command.is_empty() {
            "No command provided.".to_string()
        } else {
            format!("{host}: {command}")
        };
        return json_ok(&ExecResult {
            observation: String::new(),
            preview: preview.clone(),
            is_error: false,
            needs_approval: Some(true),
            approval_kind: Some("ssh_run".into()),
            approval_preview: Some(preview),
            ..Default::default()
        });
    }
    let remote = match body.tool.as_str() {
        "ssh_run" => ssh_run_command(&body.args),
        "ssh_read" => ssh_read_command(&body.args),
        "ssh_list" => ssh_list_command(&body.args),
        "ssh_grep" => ssh_grep_command(&body.args),
        other => {
            return json_ok(&ExecResult {
                observation: format!("Unknown SSH tool: {other}"),
                preview: "unknown tool".into(),
                is_error: true,
                ..Default::default()
            })
        }
    };
    if remote.is_empty() {
        return json_ok(&ExecResult {
            observation: "No command or path provided.".into(),
            preview: "no command".into(),
            is_error: true,
            ..Default::default()
        });
    }
    let timeout_ms = if body.run_command_timeout_ms == 0 {
        120_000
    } else {
        body.run_command_timeout_ms
    };
    let out = run_ssh_buffered(&host, &remote, timeout_ms).await;
    json_ok(&ExecResult {
        observation: out.observation,
        preview: out.preview,
        is_error: out.is_error,
        exit_code: out.exit_code,
        ..Default::default()
    })
}

// ssh_exec_stream is the streaming variant for an approved ssh_run: it pipes the
// remote command's stdout+stderr to the renderer as SSE chunk events as they
// arrive and finishes with one terminal exit event (code + duration). Mirrors
// repos_exec_stream. The renderer calls /stream only after the user approves.
async fn ssh_exec_stream(State(_): State<AppState>, Json(body): Json<SshExecBody>) -> Response {
    if body.tool != "ssh_run" {
        return sse_error("Streaming SSH exec is for ssh_run only.");
    }
    let host = body.host.trim().to_string();
    if !is_safe_ssh_alias(&host) {
        return sse_error(&format!("Invalid SSH host alias: {host}"));
    }
    if !body.approved {
        return sse_error("SSH command not approved.");
    }
    let command = ssh_run_command(&body.args);
    if command.is_empty() {
        return sse_error("No command provided.");
    }
    let timeout_for_task = if body.run_command_timeout_ms == 0 {
        120_000
    } else {
        body.run_command_timeout_ms
    };
    let (tx, rx) = mpsc::channel::<StreamMsg>(64);
    let host_for_task = host;
    let command_for_task = command;
    tokio::spawn(async move {
        let start = std::time::Instant::now();
        let mut child = match tokio::process::Command::new("ssh")
            .arg("-o")
            .arg("BatchMode=yes")
            .arg("-o")
            .arg("ConnectTimeout=10")
            .arg(&host_for_task)
            .arg(&command_for_task)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
        {
            Ok(c) => c,
            Err(e) => {
                let _ = tx
                    .send(StreamMsg::Chunk(format!("Could not run ssh: {e}\n")))
                    .await;
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
                let _ = child.kill().await;
                let _ = stdout_task.await;
                let _ = stderr_task.await;
                let _ = tx
                    .send(StreamMsg::Chunk(format!(
                        "\n[ssh timed out after {}s — killed]\n",
                        timeout_for_task / 1000
                    )))
                    .await;
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

// SshOutput is the result of one buffered ssh run.
struct SshOutput {
    observation: String,
    preview: String,
    is_error: bool,
    exit_code: Option<i64>,
}

// run_ssh_buffered runs `ssh <host> <remote>` with a null stdin, captures
// stdout+stderr, and applies the per-command timeout. BatchMode=yes makes auth
// fail fast instead of hanging on a password prompt; kill_on_drop ensures the
// child is killed if the timeout future is dropped mid-wait.
async fn run_ssh_buffered(host: &str, remote: &str, timeout_ms: u64) -> SshOutput {
    let mut cmd = tokio::process::Command::new("ssh");
    cmd.arg("-o")
        .arg("BatchMode=yes")
        .arg("-o")
        .arg("ConnectTimeout=10")
        .arg(host)
        .arg(remote)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let limit = std::time::Duration::from_millis(timeout_ms);
    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return SshOutput {
                observation: format!("Could not run ssh: {e}"),
                preview: "ssh spawn error".into(),
                is_error: true,
                exit_code: None,
            }
        }
    };
    let out = match tokio::time::timeout(limit, child.wait_with_output()).await {
        Ok(o) => o,
        Err(_) => {
            return SshOutput {
                observation: format!("[ssh timed out after {}s — killed]", timeout_ms / 1000),
                preview: "timeout".into(),
                is_error: true,
                exit_code: Some(124),
            }
        }
    };
    match out {
        Ok(o) => {
            let mut observation = String::new();
            if !o.stdout.is_empty() {
                observation.push_str(&String::from_utf8_lossy(&o.stdout));
            }
            if !o.stderr.is_empty() {
                if !observation.is_empty() {
                    observation.push('\n');
                }
                observation.push_str(&String::from_utf8_lossy(&o.stderr));
            }
            let observation = cap_ssh_observation(&observation);
            let code = o.status.code().unwrap_or(-1) as i64;
            let is_error = !o.status.success();
            let preview = if is_error {
                format!("exit {code}")
            } else {
                "ok".to_string()
            };
            SshOutput {
                observation,
                preview,
                is_error,
                exit_code: Some(code),
            }
        }
        Err(e) => SshOutput {
            observation: format!("ssh failed: {e}"),
            preview: "ssh error".into(),
            is_error: true,
            exit_code: None,
        },
    }
}

// --- SSH command builders --------------------------------------------------
//
// ssh_run's command is the raw remote shell string the user approved (no
// escaping — the user sees it in the approval dialog). The read tools inject
// path/pattern/glob into a fixed command, so those args are single-quote
// shell-escaped for the remote shell (ssh_shell_escape) as an injection guard.

fn ssh_run_command(args: &str) -> String {
    let v: serde_json::Value = match serde_json::from_str(args) {
        Ok(v) => v,
        Err(_) => return String::new(),
    };
    v.get("command")
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string()
}

fn ssh_read_command(args: &str) -> String {
    let v: serde_json::Value = match serde_json::from_str(args) {
        Ok(v) => v,
        Err(_) => return String::new(),
    };
    let path = v.get("path").and_then(|p| p.as_str()).unwrap_or("");
    if path.is_empty() {
        return String::new();
    }
    format!("cat -- {}", ssh_shell_escape(path))
}

fn ssh_list_command(args: &str) -> String {
    let v: serde_json::Value = match serde_json::from_str(args) {
        Ok(v) => v,
        Err(_) => return String::new(),
    };
    let path = v.get("path").and_then(|p| p.as_str()).unwrap_or("");
    if path.is_empty() {
        "ls -la".to_string()
    } else {
        format!("ls -la -- {}", ssh_shell_escape(path))
    }
}

fn ssh_grep_command(args: &str) -> String {
    let v: serde_json::Value = match serde_json::from_str(args) {
        Ok(v) => v,
        Err(_) => return String::new(),
    };
    let pattern = v.get("pattern").and_then(|p| p.as_str()).unwrap_or("");
    if pattern.is_empty() {
        return String::new();
    }
    let path = v.get("path").and_then(|p| p.as_str()).unwrap_or("");
    let include = v.get("include").and_then(|p| p.as_str()).unwrap_or("");
    let mut cmd = String::from("grep -rn");
    if !include.is_empty() {
        cmd.push_str(&format!(" --include={}", ssh_shell_escape(include)));
    }
    cmd.push_str(" -- ");
    cmd.push_str(&ssh_shell_escape(pattern));
    if !path.is_empty() {
        cmd.push(' ');
        cmd.push_str(&ssh_shell_escape(path));
    }
    cmd
}

// ssh_shell_escape wraps s in single quotes for the remote shell, escaping any
// embedded single quotes. This makes path/pattern/glob args safe to inject into
// a fixed remote command (cat/ls/grep). The result is one shell-quoted token.
fn ssh_shell_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        if c == '\'' {
            // Close the quote, add an escaped quote, reopen.
            out.push_str("'\\''");
        } else {
            out.push(c);
        }
    }
    out.push('\'');
    out
}

// is_safe_ssh_alias reports whether s is a safe bare SSH alias: no whitespace or
// shell metacharacters, conservative charset. The alias is passed to ssh as a
// single argv element, so this guards against injecting ssh options. Mirrors the
// backend's isSSHAlias — the sidecar re-validates as the trust boundary that
// actually runs ssh.
fn is_safe_ssh_alias(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
}

// cap_ssh_observation truncates ssh output to MAX_OBS_CHARS bytes on a UTF-8
// char boundary and appends an overflow marker, mirroring cap_preview.
fn cap_ssh_observation(s: &str) -> String {
    let s = s.trim();
    if s.len() <= MAX_OBS_CHARS {
        return s.to_string();
    }
    let mut end = MAX_OBS_CHARS;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n…[truncated]", &s[..end])
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

// parse_pr_number extracts the "number" field from a PR tool's args JSON.
fn parse_pr_number(args: &str) -> Option<u64> {
    serde_json::from_str::<serde_json::Value>(args)
        .ok()
        .and_then(|v| v.get("number").and_then(|n| n.as_u64()))
}

// exec_pr_view returns a single PR's full details: title, body, state, draft,
// merged, head→base, mergeable state, CI status, and review state. Read-only —
// never approval-gated. Reuses pr_ci_state/pr_review_state for enrichment.
// github.com repos only.
async fn exec_pr_view(client: &reqwest::Client, root: &Path, args: &str) -> ExecResult {
    let number = match parse_pr_number(args) {
        Some(n) => n,
        None => return ExecResult { observation: "No PR number provided.".into(), preview: "no number".into(), is_error: true, ..Default::default() },
    };
    let remote = match git_remote_url(root).await {
        Some(r) => r,
        None => return ExecResult { observation: "no remote configured".into(), preview: "no remote".into(), is_error: true, ..Default::default() },
    };
    let full_name = match github_full_name(&remote) {
        Some(f) => f,
        None => return ExecResult { observation: "pr_view is only supported for github.com repos".into(), preview: "not github".into(), is_error: true, ..Default::default() },
    };
    let token = match token_get() {
        Some(t) => t,
        None => return ExecResult { observation: "no github token stored (connect github first)".into(), preview: "no token".into(), is_error: true, ..Default::default() },
    };
    let url = format!("{GH_API}/repos/{}/pulls/{}", full_name, number);
    let resp = match client.get(&url).headers(gh_headers(&token)).timeout(std::time::Duration::from_secs(10)).send().await {
        Ok(r) => r,
        Err(e) => return ExecResult { observation: format!("github unreachable: {}", scrub(e.to_string(), &token)), preview: "github error".into(), is_error: true, ..Default::default() },
    };
    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        let msg = parse_github_error(&body).unwrap_or_else(|| format!("github returned {}", body));
        return ExecResult { observation: format!("pr_view failed: {}", scrub(msg, &token)), preview: "PR fetch failed".into(), is_error: true, ..Default::default() };
    }
    let pr: serde_json::Value = match resp.json().await {
        Ok(v) => v,
        Err(e) => return ExecResult { observation: format!("bad github response: {}", scrub(e.to_string(), &token)), preview: "github error".into(), is_error: true, ..Default::default() },
    };
    let title = pr.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let state = pr.get("state").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let draft = pr.get("draft").and_then(|v| v.as_bool()).unwrap_or(false);
    let merged = pr.get("merged").and_then(|v| v.as_bool()).unwrap_or(false);
    let merged_at = pr.get("merged_at").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let head = pr.get("head").and_then(|h| h.get("ref")).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let base = pr.get("base").and_then(|b| b.get("ref")).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let body = pr.get("body").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let mergeable = pr.get("mergeable_state").and_then(|v| v.as_str()).map(String::from).filter(|s| !s.is_empty() && s != "unknown");
    let head_sha = pr.get("head").and_then(|h| h.get("sha")).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let ci_state = if head_sha.is_empty() { None } else { pr_ci_state(client, &full_name, &head_sha, &token).await };
    let review_state = pr_review_state(client, &full_name, number, &token).await;
    let html_url = pr.get("html_url").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let mut s = format!("#{} \"{}\" {}→{} state={}", number, title, head, base, state);
    if draft {
        s.push_str(" [draft]");
    }
    if merged {
        s.push_str(" [merged");
        if !merged_at.is_empty() {
            s.push_str(&format!(" at {}", merged_at));
        }
        s.push(']');
    }
    if let Some(m) = &mergeable {
        s.push_str(&format!(" mergeable={}", m));
    }
    if let Some(ci) = &ci_state {
        s.push_str(&format!(" CI={}", ci));
    }
    if let Some(rv) = &review_state {
        s.push_str(&format!(" reviews={}", rv));
    }
    if !html_url.is_empty() {
        s.push_str(&format!("\n{}", html_url));
    }
    if !body.is_empty() {
        s.push_str(&format!("\n\n{}", body));
    }
    ExecResult { observation: cap(&s), preview: format!("PR #{} \"{}\"", number, title), is_error: false, ..Default::default() }
}

// exec_pr_diff fetches a PR's unified diff via the application/vnd.github.v3.diff
// media type. Read-only. The diff is capped before being fed to the model.
// github.com repos only.
async fn exec_pr_diff(client: &reqwest::Client, root: &Path, args: &str) -> ExecResult {
    let number = match parse_pr_number(args) {
        Some(n) => n,
        None => return ExecResult { observation: "No PR number provided.".into(), preview: "no number".into(), is_error: true, ..Default::default() },
    };
    let remote = match git_remote_url(root).await {
        Some(r) => r,
        None => return ExecResult { observation: "no remote configured".into(), preview: "no remote".into(), is_error: true, ..Default::default() },
    };
    let full_name = match github_full_name(&remote) {
        Some(f) => f,
        None => return ExecResult { observation: "pr_diff is only supported for github.com repos".into(), preview: "not github".into(), is_error: true, ..Default::default() },
    };
    let token = match token_get() {
        Some(t) => t,
        None => return ExecResult { observation: "no github token stored (connect github first)".into(), preview: "no token".into(), is_error: true, ..Default::default() },
    };
    let url = format!("{GH_API}/repos/{}/pulls/{}", full_name, number);
    let mut h = gh_headers(&token);
    h.insert(reqwest::header::ACCEPT, HeaderValue::from_static("application/vnd.github.v3.diff"));
    let resp = match client.get(&url).headers(h).timeout(std::time::Duration::from_secs(15)).send().await {
        Ok(r) => r,
        Err(e) => return ExecResult { observation: format!("github unreachable: {}", scrub(e.to_string(), &token)), preview: "github error".into(), is_error: true, ..Default::default() },
    };
    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        let msg = parse_github_error(&body).unwrap_or_else(|| format!("github returned {}", body));
        return ExecResult { observation: format!("pr_diff failed: {}", scrub(msg, &token)), preview: "diff failed".into(), is_error: true, ..Default::default() };
    }
    let diff = resp.text().await.unwrap_or_default();
    if diff.trim().is_empty() {
        return ExecResult { observation: "No diff available (the PR may have no changes or be already merged).".into(), preview: "empty diff".into(), is_error: false, ..Default::default() };
    }
    ExecResult { observation: cap(&diff), preview: format!("diff for PR #{}", number), is_error: false, ..Default::default() }
}

// exec_pr_checks reports a PR's per-context CI states and review state summary.
// Read-only. Fetches the PR for its head sha, then the combined commit status
// (with per-context breakdown) and the review summary. github.com repos only.
async fn exec_pr_checks(client: &reqwest::Client, root: &Path, args: &str) -> ExecResult {
    let number = match parse_pr_number(args) {
        Some(n) => n,
        None => return ExecResult { observation: "No PR number provided.".into(), preview: "no number".into(), is_error: true, ..Default::default() },
    };
    let remote = match git_remote_url(root).await {
        Some(r) => r,
        None => return ExecResult { observation: "no remote configured".into(), preview: "no remote".into(), is_error: true, ..Default::default() },
    };
    let full_name = match github_full_name(&remote) {
        Some(f) => f,
        None => return ExecResult { observation: "pr_checks is only supported for github.com repos".into(), preview: "not github".into(), is_error: true, ..Default::default() },
    };
    let token = match token_get() {
        Some(t) => t,
        None => return ExecResult { observation: "no github token stored (connect github first)".into(), preview: "no token".into(), is_error: true, ..Default::default() },
    };
    let pr_url = format!("{GH_API}/repos/{}/pulls/{}", full_name, number);
    let pr_resp = match client.get(&pr_url).headers(gh_headers(&token)).timeout(std::time::Duration::from_secs(10)).send().await {
        Ok(r) => r,
        Err(e) => return ExecResult { observation: format!("github unreachable: {}", scrub(e.to_string(), &token)), preview: "github error".into(), is_error: true, ..Default::default() },
    };
    if !pr_resp.status().is_success() {
        let body = pr_resp.text().await.unwrap_or_default();
        let msg = parse_github_error(&body).unwrap_or_else(|| format!("github returned {}", body));
        return ExecResult { observation: format!("pr_checks failed: {}", scrub(msg, &token)), preview: "PR fetch failed".into(), is_error: true, ..Default::default() };
    }
    let pr: serde_json::Value = match pr_resp.json().await {
        Ok(v) => v,
        Err(e) => return ExecResult { observation: format!("bad github response: {}", scrub(e.to_string(), &token)), preview: "github error".into(), is_error: true, ..Default::default() },
    };
    let title = pr.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let head_sha = pr.get("head").and_then(|h| h.get("sha")).and_then(|v| v.as_str()).unwrap_or("").to_string();
    let review_state = pr_review_state(client, &full_name, number, &token).await;
    let mut lines: Vec<String> = Vec::new();
    lines.push(format!("#{} \"{}\"", number, title));
    if head_sha.is_empty() {
        lines.push("No head sha; CI state unavailable.".into());
    } else {
        let st_url = format!("{GH_API}/repos/{}/commits/{}/status", full_name, head_sha);
        let st_resp = client.get(&st_url).headers(gh_headers(&token)).timeout(std::time::Duration::from_secs(10)).send().await;
        let combined = match st_resp {
            Ok(r) if r.status().is_success() => r.json::<serde_json::Value>().await.ok(),
            _ => None,
        };
        let state = combined.as_ref().and_then(|c| c.get("state").and_then(|v| v.as_str())).map(String::from);
        let total = combined.as_ref().and_then(|c| c.get("total_count").and_then(|v| v.as_u64())).unwrap_or(0);
        lines.push(format!("CI: {} ({} contexts)", state.unwrap_or_else(|| "unknown".into()), total));
        if let Some(statuses) = combined.as_ref().and_then(|c| c.get("statuses").and_then(|s| s.as_array())) {
            for st in statuses.iter().take(20) {
                let ctx = st.get("context").and_then(|v| v.as_str()).unwrap_or("");
                let st_state = st.get("state").and_then(|v| v.as_str()).unwrap_or("");
                lines.push(format!("  - {} : {}", ctx, st_state));
            }
        }
    }
    match review_state {
        Some(rv) => lines.push(format!("Reviews: {}", rv)),
        None => lines.push("Reviews: none".into()),
    }
    ExecResult { observation: cap(&lines.join("\n")), preview: format!("checks for PR #{}", number), is_error: false, ..Default::default() }
}

// exec_pr_comment adds a top-level comment to a PR. Approval-gated and external
// — never auto-approved. github.com repos only.
async fn exec_pr_comment(client: &reqwest::Client, root: &Path, args: &str, approved: bool) -> ExecResult {
    let v = match serde_json::from_str::<serde_json::Value>(args) {
        Ok(v) => v,
        Err(_) => return ExecResult { observation: "Invalid args for pr_comment.".into(), preview: "bad args".into(), is_error: true, ..Default::default() },
    };
    let number = v.get("number").and_then(|n| n.as_u64()).unwrap_or(0);
    let body_text = v.get("body").and_then(|b| b.as_str()).unwrap_or("").to_string();
    if number == 0 {
        return ExecResult { observation: "No PR number provided.".into(), preview: "no number".into(), is_error: true, ..Default::default() };
    }
    if body_text.trim().is_empty() {
        return ExecResult { observation: "No comment body provided.".into(), preview: "no body".into(), is_error: true, ..Default::default() };
    }
    if !approved {
        let preview = format!("Comment on PR #{}: {}", number, cap_preview(&body_text, 200));
        return ExecResult {
            observation: String::new(),
            preview: "awaiting approval".into(),
            is_error: false,
            needs_approval: Some(true),
            approval_kind: Some("pr_comment".into()),
            approval_preview: Some(preview),
            ..Default::default()
        };
    }
    match pr_comment_for_repo(client, root, number, &body_text).await {
        Ok(url) => ExecResult { observation: format!("Comment posted: {}", url), preview: "comment posted".into(), is_error: false, ..Default::default() },
        Err(e) => ExecResult { observation: format!("pr_comment failed: {}", e), preview: "comment failed".into(), is_error: true, ..Default::default() },
    }
}

// exec_pr_close closes a PR without merging. Approval-gated and irreversible.
// The not-approved path fetches the PR so the approval dialog shows the title.
// github.com repos only.
async fn exec_pr_close(client: &reqwest::Client, root: &Path, args: &str, approved: bool) -> ExecResult {
    let number = match parse_pr_number(args) {
        Some(n) => n,
        None => return ExecResult { observation: "No PR number provided.".into(), preview: "no number".into(), is_error: true, ..Default::default() },
    };
    if !approved {
        let preview = match pr_detail(client, root, number).await {
            Ok(d) => format!("Close PR #{} \"{}\": {} → {}", number, d.title, d.head, d.base),
            Err(_) => format!("Close PR #{}", number),
        };
        return ExecResult {
            observation: String::new(),
            preview: "awaiting approval".into(),
            is_error: false,
            needs_approval: Some(true),
            approval_kind: Some("pr_close".into()),
            approval_preview: Some(preview),
            ..Default::default()
        };
    }
    match pr_close_for_repo(client, root, number).await {
        Ok(()) => ExecResult { observation: format!("Closed PR #{}.", number), preview: "closed".into(), is_error: false, ..Default::default() },
        Err(e) => ExecResult { observation: format!("pr_close failed: {}", e), preview: "close failed".into(), is_error: true, ..Default::default() },
    }
}

// exec_pr_ready marks a draft PR ready for review. Approval-gated. The REST API
// cannot un-draft a PR (PATCH pulls/{n} silently ignores draft:false), so this
// uses the GraphQL markPullRequestReadyForReview mutation with the PR node_id.
// github.com repos only.
async fn exec_pr_ready(client: &reqwest::Client, root: &Path, args: &str, approved: bool) -> ExecResult {
    let number = match parse_pr_number(args) {
        Some(n) => n,
        None => return ExecResult { observation: "No PR number provided.".into(), preview: "no number".into(), is_error: true, ..Default::default() },
    };
    if !approved {
        let preview = match pr_detail(client, root, number).await {
            Ok(d) => format!("Mark PR #{} \"{}\" ready for review (currently {})", number, d.title, if d.draft { "draft" } else { "not draft" }),
            Err(_) => format!("Mark PR #{} ready for review", number),
        };
        return ExecResult {
            observation: String::new(),
            preview: "awaiting approval".into(),
            is_error: false,
            needs_approval: Some(true),
            approval_kind: Some("pr_ready".into()),
            approval_preview: Some(preview),
            ..Default::default()
        };
    }
    match pr_ready_for_repo(client, root, number).await {
        Ok(()) => ExecResult { observation: format!("Marked PR #{} as ready for review.", number), preview: "ready for review".into(), is_error: false, ..Default::default() },
        Err(e) => ExecResult { observation: format!("pr_ready failed: {}", e), preview: "ready failed".into(), is_error: true, ..Default::default() },
    }
}

// exec_pr_edit updates a PR's title and/or body. Approval-gated. At least one of
// title/body must be provided (validated here so the model gets a clear error).
// github.com repos only.
async fn exec_pr_edit(client: &reqwest::Client, root: &Path, args: &str, approved: bool) -> ExecResult {
    let v = match serde_json::from_str::<serde_json::Value>(args) {
        Ok(v) => v,
        Err(_) => return ExecResult { observation: "Invalid args for pr_edit.".into(), preview: "bad args".into(), is_error: true, ..Default::default() },
    };
    let number = v.get("number").and_then(|n| n.as_u64()).unwrap_or(0);
    if number == 0 {
        return ExecResult { observation: "No PR number provided.".into(), preview: "no number".into(), is_error: true, ..Default::default() };
    }
    let title = v.get("title").and_then(|t| t.as_str()).map(|s| s.trim().to_string()).unwrap_or_default();
    let body_text = v.get("body").and_then(|b| b.as_str()).map(|s| s.to_string()).unwrap_or_default();
    if title.is_empty() && body_text.is_empty() {
        return ExecResult { observation: "pr_edit needs at least one of title or body.".into(), preview: "no fields".into(), is_error: true, ..Default::default() };
    }
    if !approved {
        let mut parts: Vec<String> = Vec::new();
        if !title.is_empty() {
            parts.push(format!("title=\"{}\"", cap_preview(&title, 120)));
        }
        if !body_text.is_empty() {
            parts.push(format!("body={} chars", body_text.len()));
        }
        let preview = format!("Edit PR #{}: {}", number, parts.join(", "));
        return ExecResult {
            observation: String::new(),
            preview: "awaiting approval".into(),
            is_error: false,
            needs_approval: Some(true),
            approval_kind: Some("pr_edit".into()),
            approval_preview: Some(preview),
            ..Default::default()
        };
    }
    match pr_edit_for_repo(client, root, number, &title, &body_text).await {
        Ok(()) => ExecResult { observation: format!("Updated PR #{}.", number), preview: "PR updated".into(), is_error: false, ..Default::default() },
        Err(e) => ExecResult { observation: format!("pr_edit failed: {}", e), preview: "edit failed".into(), is_error: true, ..Default::default() },
    }
}

// --- PR REST/GraphQL helpers (shared by the pr_* executors) ---

// gh_graphql runs a GitHub GraphQL mutation/query against api.github.com/graphql
// using the keychain token. Returns the response data on success; surfaces
// GraphQL errors (joined) and REST-level failures as Err strings. The token is
// scrubbed from any captured error text.
async fn gh_graphql(client: &reqwest::Client, token: &str, query: &str, variables: serde_json::Value) -> Result<serde_json::Value, String> {
    let body = serde_json::json!({ "query": query, "variables": variables });
    let resp = client
        .post("https://api.github.com/graphql")
        .headers(gh_headers(token))
        .json(&body)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("github unreachable: {}", scrub(e.to_string(), token)))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(parse_github_error(&text).unwrap_or_else(|| format!("github returned {}", status)));
    }
    let v: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("bad github response: {}", scrub(e.to_string(), token)))?;
    if let Some(errors) = v.get("errors").and_then(|e| e.as_array()) {
        if !errors.is_empty() {
            let msgs: Vec<String> = errors
                .iter()
                .filter_map(|e| e.get("message").and_then(|m| m.as_str()).map(String::from))
                .collect();
            if !msgs.is_empty() {
                return Err(msgs.join("; "));
            }
        }
    }
    Ok(v)
}

// pr_comment_for_repo posts a top-level PR comment via the issue-comments
// endpoint (POST /repos/{o}/{r}/issues/{n}/comments). Returns the comment
// html_url. github.com repos only; token scrubbed from any error text.
async fn pr_comment_for_repo(client: &reqwest::Client, root: &Path, number: u64, body: &str) -> Result<String, String> {
    let remote = git_remote_url(root).await.ok_or_else(|| "no remote configured".to_string())?;
    let full_name = github_full_name(&remote).ok_or_else(|| "pr_comment is only supported for github.com repos".to_string())?;
    let token = token_get().ok_or_else(|| "no github token stored (connect github first)".to_string())?;
    let url = format!("{GH_API}/repos/{}/issues/{}/comments", full_name, number);
    let resp = client
        .post(&url)
        .headers(gh_headers(&token))
        .json(&serde_json::json!({ "body": body }))
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("github unreachable: {}", scrub(e.to_string(), &token)))?;
    let status = resp.status();
    let body_text = resp.text().await.unwrap_or_default();
    if status.is_success() {
        let v: serde_json::Value = serde_json::from_str(&body_text)
            .map_err(|e| format!("bad github response: {}", scrub(e.to_string(), &token)))?;
        Ok(v
            .get("html_url")
            .and_then(|u| u.as_str())
            .map(String::from)
            .unwrap_or_else(|| "posted (no url)".to_string()))
    } else {
        let msg = parse_github_error(&body_text).unwrap_or_else(|| format!("github returned {}", status));
        Err(scrub(msg, &token))
    }
}

// pr_close_for_repo closes a PR via PATCH /repos/{o}/{r}/pulls/{n} with
// state=closed. github.com repos only; token scrubbed from any error text.
async fn pr_close_for_repo(client: &reqwest::Client, root: &Path, number: u64) -> Result<(), String> {
    let remote = git_remote_url(root).await.ok_or_else(|| "no remote configured".to_string())?;
    let full_name = github_full_name(&remote).ok_or_else(|| "pr_close is only supported for github.com repos".to_string())?;
    let token = token_get().ok_or_else(|| "no github token stored (connect github first)".to_string())?;
    let url = format!("{GH_API}/repos/{}/pulls/{}", full_name, number);
    let resp = client
        .patch(&url)
        .headers(gh_headers(&token))
        .json(&serde_json::json!({ "state": "closed" }))
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("github unreachable: {}", scrub(e.to_string(), &token)))?;
    if resp.status().is_success() {
        Ok(())
    } else {
        let body = resp.text().await.unwrap_or_default();
        let msg = parse_github_error(&body).unwrap_or_else(|| format!("github returned {}", body));
        Err(scrub(msg, &token))
    }
}

// pr_ready_for_repo marks a draft PR ready for review. REST cannot un-draft a
// PR, so this fetches the PR's node_id then runs the GraphQL
// markPullRequestReadyForReview mutation. github.com repos only.
async fn pr_ready_for_repo(client: &reqwest::Client, root: &Path, number: u64) -> Result<(), String> {
    let remote = git_remote_url(root).await.ok_or_else(|| "no remote configured".to_string())?;
    let full_name = github_full_name(&remote).ok_or_else(|| "pr_ready is only supported for github.com repos".to_string())?;
    let token = token_get().ok_or_else(|| "no github token stored (connect github first)".to_string())?;
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
        return Err(parse_github_error(&body).unwrap_or_else(|| format!("github returned {}", body)));
    }
    let pr: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("bad github response: {}", scrub(e.to_string(), &token)))?;
    let node_id = pr
        .get("node_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "no node_id in PR response".to_string())?;
    let query = "mutation($id:ID!){ markPullRequestReadyForReview(input:{pullRequestId:$id}){ pullRequest{ number isDraft url } } }";
    gh_graphql(client, &token, query, serde_json::json!({ "id": node_id })).await?;
    Ok(())
}

// pr_edit_for_repo updates a PR's title and/or body via PATCH /repos/{o}/{r}/pulls/{n}.
// Only non-empty fields are sent. github.com repos only; token scrubbed.
async fn pr_edit_for_repo(client: &reqwest::Client, root: &Path, number: u64, title: &str, body: &str) -> Result<(), String> {
    let remote = git_remote_url(root).await.ok_or_else(|| "no remote configured".to_string())?;
    let full_name = github_full_name(&remote).ok_or_else(|| "pr_edit is only supported for github.com repos".to_string())?;
    let token = token_get().ok_or_else(|| "no github token stored (connect github first)".to_string())?;
    let mut patch = serde_json::Map::new();
    if !title.is_empty() {
        patch.insert("title".into(), serde_json::Value::String(title.to_string()));
    }
    if !body.is_empty() {
        patch.insert("body".into(), serde_json::Value::String(body.to_string()));
    }
    let url = format!("{GH_API}/repos/{}/pulls/{}", full_name, number);
    let resp = client
        .patch(&url)
        .headers(gh_headers(&token))
        .json(&serde_json::Value::Object(patch))
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| format!("github unreachable: {}", scrub(e.to_string(), &token)))?;
    if resp.status().is_success() {
        Ok(())
    } else {
        let body_text = resp.text().await.unwrap_or_default();
        let msg = parse_github_error(&body_text).unwrap_or_else(|| format!("github returned {}", body_text));
        Err(scrub(msg, &token))
    }
}

// exec_create_repo creates a new GitHub repository under the user's account
// (or an organization). Approval-gated and external — never auto-approved.
// Does not touch the local workspace (root is unused); follow with link_remote
// + git_push to publish a local project. github.com only.
async fn exec_create_repo(client: &reqwest::Client, _root: &Path, args: &str, approved: bool) -> ExecResult {
    let v = match serde_json::from_str::<serde_json::Value>(args) {
        Ok(v) => v,
        Err(_) => return ExecResult { observation: "Invalid args for create_repo.".into(), preview: "bad args".into(), is_error: true, ..Default::default() },
    };
    let name = v.get("name").and_then(|n| n.as_str()).unwrap_or("").trim().to_string();
    if name.is_empty() {
        return ExecResult { observation: "No repo name provided.".into(), preview: "no name".into(), is_error: true, ..Default::default() };
    }
    let org = v.get("org").and_then(|o| o.as_str()).unwrap_or("").trim().to_string();
    let description = v.get("description").and_then(|d| d.as_str()).unwrap_or("").to_string();
    let private = v.get("private").and_then(|p| p.as_bool()).unwrap_or(true);
    let auto_init = v.get("auto_init").and_then(|a| a.as_bool()).unwrap_or(false);
    if !approved {
        let prefix = if org.is_empty() { "your account/".to_string() } else { format!("{}/", org) };
        let vis = if private { "private" } else { "public" };
        let preview = format!("Create repo {}{} ({})", prefix, name, vis);
        return ExecResult {
            observation: String::new(),
            preview: "awaiting approval".into(),
            is_error: false,
            needs_approval: Some(true),
            approval_kind: Some("create_repo".into()),
            approval_preview: Some(preview),
            ..Default::default()
        };
    }
    match create_repo_for_repo(client, &name, &org, &description, private, auto_init).await {
        Ok((html_url, clone_url)) => {
            let mut s = format!("Created repository: {}", html_url);
            if !clone_url.is_empty() {
                s.push_str(&format!("\nClone URL: {}", clone_url));
            }
            s.push_str("\nNext: link the local project with link_remote (if not already linked to this URL), commit with git_commit, and push with git_push.");
            ExecResult { observation: s, preview: "repo created".into(), is_error: false, ..Default::default() }
        }
        Err(e) => ExecResult { observation: format!("create_repo failed: {}", e), preview: "create failed".into(), is_error: true, ..Default::default() },
    }
}

// exec_link_remote links the current local git workspace to a GitHub repository
// by adding it as the origin remote (git remote add). Approval-gated. Refuses
// to overwrite an existing remote that points to a different URL; no-ops if it
// already points to the same URL. Does not push — the agent calls git_push
// next. github.com only; requires a git-enabled workspace (gated by is_git_tool).
async fn exec_link_remote(root: &Path, args: &str, approved: bool) -> ExecResult {
    let v = match serde_json::from_str::<serde_json::Value>(args) {
        Ok(v) => v,
        Err(_) => return ExecResult { observation: "Invalid args for link_remote.".into(), preview: "bad args".into(), is_error: true, ..Default::default() },
    };
    let url = v.get("url").and_then(|u| u.as_str()).unwrap_or("").trim().to_string();
    if url.is_empty() {
        return ExecResult { observation: "No repository URL provided.".into(), preview: "no url".into(), is_error: true, ..Default::default() };
    }
    if !is_github_https(&url) {
        return ExecResult { observation: "link_remote only supports https github.com URLs.".into(), preview: "not github".into(), is_error: true, ..Default::default() };
    }
    let remote = v.get("remote").and_then(|r| r.as_str()).unwrap_or("origin").trim().to_string();
    if remote.is_empty() {
        return ExecResult { observation: "Remote name must not be empty.".into(), preview: "bad remote".into(), is_error: true, ..Default::default() };
    }
    // If the remote already exists, refuse to overwrite a different URL and
    // no-op when it already points to the same one (compare ignoring .git).
    if let Some(existing) = git_remote_url_named(root, &remote).await {
        let a = existing.trim_end_matches(".git");
        let b = url.trim_end_matches(".git");
        if a == b {
            return ExecResult { observation: format!("{} already points to {}.", remote, url), preview: "already linked".into(), is_error: false, ..Default::default() };
        }
        return ExecResult { observation: format!("{} already points to a different URL ({}). Refusing to overwrite — remove it first or pass the matching URL.", remote, existing), preview: "remote exists".into(), is_error: true, ..Default::default() };
    }
    let branch = git_branch(root).await;
    if !approved {
        let preview = format!("Link {} → {} (branch {})", remote, url, branch);
        return ExecResult {
            observation: String::new(),
            preview: "awaiting approval".into(),
            is_error: false,
            needs_approval: Some(true),
            approval_kind: Some("link_remote".into()),
            approval_preview: Some(preview),
            ..Default::default()
        };
    }
    let out = tokio::process::Command::new("git")
        .arg("-C").arg(root)
        .arg("remote").arg("add").arg(&remote).arg(&url)
        .output().await;
    match out {
        Ok(o) if o.status.success() => ExecResult {
            observation: format!("Linked {} → {} (branch {}). Run git_push to publish the branch.", remote, url, branch),
            preview: "linked".into(),
            is_error: false,
            ..Default::default()
        },
        Ok(o) => {
            let msg = String::from_utf8_lossy(&o.stderr).trim().to_string();
            ExecResult { observation: format!("git remote add failed: {}", msg), preview: "link failed".into(), is_error: true, ..Default::default() }
        }
        Err(e) => ExecResult { observation: format!("could not run git: {}", e), preview: "git error".into(), is_error: true, ..Default::default() },
    }
}

// --- Repo-lifecycle helpers (create_repo + link_remote) ---

// create_repo_for_repo POSTs /user/repos (or /orgs/{org}/repos) to create a
// new GitHub repository. Returns (html_url, clone_url). github.com only; the
// token is scrubbed from any captured error text.
async fn create_repo_for_repo(
    client: &reqwest::Client,
    name: &str,
    org: &str,
    description: &str,
    private: bool,
    auto_init: bool,
) -> Result<(String, String), String> {
    let token = token_get().ok_or_else(|| "no github token stored (connect github first)".to_string())?;
    let mut body = serde_json::json!({
        "name": name,
        "private": private,
        "auto_init": auto_init,
    });
    if !description.is_empty() {
        body["description"] = serde_json::Value::String(description.to_string());
    }
    let url = if org.is_empty() {
        format!("{GH_API}/user/repos")
    } else {
        format!("{GH_API}/orgs/{}/repos", org)
    };
    let resp = client
        .post(&url)
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
        let html_url = v.get("html_url").and_then(|u| u.as_str()).map(String::from).unwrap_or_default();
        let clone_url = v.get("clone_url").and_then(|u| u.as_str()).map(String::from).unwrap_or_default();
        Ok((html_url, clone_url))
    } else {
        let msg = parse_github_error(&body_text).unwrap_or_else(|| format!("github returned {}", status));
        Err(scrub(msg, &token))
    }
}

// git_remote_url_named returns the configured fetch URL for a named remote
// (git remote get-url <remote>), or None. Mirrors git_remote_url but takes the
// remote name so link_remote can target a non-origin remote.
async fn git_remote_url_named(path: &Path, remote: &str) -> Option<String> {
    let out = tokio::process::Command::new("git")
        .arg("-C")
        .arg(path)
        .arg("remote")
        .arg("get-url")
        .arg(remote)
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
// the sidecar's jar. Resolves the workspace's display name + use_git from the
// sidecar registry (defaults: name=full_name, use_git=true for pre-workspace
// clones not in the registry). Best-effort: failures are logged but not surfaced.
async fn push_repo_context(st: &AppState, full_name: &str, dest: &Path, branch: &str, head: &str, tree: &[String]) -> Result<(), String> {
	let backend = st.backend().await;
	let cookie = st.cookie_value().await;
	let url = format!("{}/api/repos", backend.trim_end_matches('/'));
	let rec = load_registry(&st.data_dir)
		.into_iter()
		.find(|r| r.full_name == full_name.trim());
	let name = rec
		.as_ref()
		.and_then(|r| r.name.clone())
		.unwrap_or_else(|| full_name.to_string());
	let use_git = rec.as_ref().map(|r| r.use_git).unwrap_or(true);
	let body = serde_json::json!({
		"fullName": full_name,
		"name": name,
		"useGit": use_git,
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
	#[serde(default)]
	name: Option<String>,
	#[serde(default)]
	use_git: Option<bool>,
}

// repos_add_local connects an existing on-disk folder as a workspace. If the
// folder is (or is inside) a git repo, it behaves as before: resolves the repo
// root, derives full_name from the origin remote (owner/repo for github.com,
// else the folder basename), and registers a git-enabled workspace. If the
// folder is NOT a git repo, it can only be connected as a non-git workspace
// (useGit=false) and requires a user-provided name; useGit=true on a non-git
// folder is an error pointing at /repos/create-workspace (which can git-init in
// place) or /repos/init-git (after connecting without git). Records it in the
// sidecar registry and pushes context to the backend so agent runs can inject it.
async fn repos_add_local(State(st): State<AppState>, Json(body): Json<AddLocalBody>) -> Response {
	let raw = body.path.trim().to_string();
	if raw.is_empty() {
		return json_err("path is required", StatusCode::BAD_REQUEST);
	}
	let p = PathBuf::from(&raw);
	if !p.is_dir() {
		return json_err("path is not a directory", StatusCode::BAD_REQUEST);
	}
	// Existing git repo: derive full_name from the origin remote, git-enabled.
	if let Some(root) = git_toplevel(&p).await {
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
				use_git: true,
				name: Some(full_name.clone()),
			},
		);
		let _ = push_repo_context(&st, &full_name, &root, &branch, &head, &tree).await;
		return json_ok(&serde_json::json!({
			"ok": true,
			"name": full_name,
			"fullName": full_name,
			"path": root.display().to_string(),
			"branch": branch,
			"head": head,
			"remote": remote,
			"tree": tree,
			"useGit": true,
		}));
	}
	// Not a git repo: only register as a non-git workspace when the user opted
	// in (useGit=false) and provided a name. useGit=true on a non-git folder is an
	// error — point them at create-workspace (which can git-init) or init-git.
	let use_git = body.use_git.unwrap_or(false);
	if use_git {
		return json_err(
			"not a git repository. Use /repos/create-workspace with useGit=true to git-init it in place, or connect it without git and run /repos/init-git later.",
			StatusCode::BAD_REQUEST,
		);
	}
	let name = match body.name.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
		Some(n) => n.to_string(),
		None => {
			return json_err(
				"name is required to connect a non-git folder as a workspace",
				StatusCode::BAD_REQUEST,
			)
		}
	};
	if !is_safe_workspace_name(&name) {
		return json_err(
			"name must be a simple token (letters, digits, space, dot, dash, underscore — no slashes or shell metacharacters)",
			StatusCode::BAD_REQUEST,
		);
	}
	if load_registry(&st.data_dir).iter().any(|r| r.full_name == name) {
		return json_err(
			"a workspace with that name is already connected",
			StatusCode::CONFLICT,
		);
	}
	let root = match p.canonicalize() {
		Ok(r) => r,
		Err(_) => p,
	};
	let tree = top_level_tree(&root);
	upsert_registry(
		&st.data_dir,
		&RepoRecord {
			full_name: name.clone(),
			path: root.display().to_string(),
			remote: None,
			branch: String::new(),
			folder_id: None,
			linked: true,
			use_git: false,
			name: Some(name.clone()),
		},
	);
	let _ = push_repo_context(&st, &name, &root, "", "", &tree).await;
	json_ok(&serde_json::json!({
		"ok": true,
		"name": name,
		"fullName": name,
		"path": root.display().to_string(),
		"branch": "",
		"head": "",
		"remote": null,
		"tree": tree,
		"useGit": false,
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
	#[serde(default)]
	git: bool,
}

// repos_scan_local resolves what a picked folder should connect as: if the
// folder itself is (or is inside) a git repo, that single repo is returned
// (preserves the original one-repo-root behavior). Otherwise its immediate
// subdirectories are scanned (one level deep) for a `.git` entry so a parent
// folder containing several repos (e.g. a projects directory) yields a list
// of candidates the renderer can offer as a checklist, instead of erroring. If
// no git repo is found at all, the picked folder itself is returned as a single
// non-git candidate (git=false) so the picker can offer "track without git".
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
			"repos": [ScanCandidate { name, path: root.display().to_string(), git: true }],
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
			candidates.push(ScanCandidate { name, path: child.display().to_string(), git: true });
		}
	}
	if candidates.is_empty() {
		// No git repo here or one level down: offer the picked folder itself as a
		// non-git workspace candidate so the picker can offer "track without git".
		let name = p
			.file_name()
			.map(|n| n.to_string_lossy().to_string())
			.unwrap_or_else(|| "workspace".to_string());
		candidates.push(ScanCandidate { name, path: p.display().to_string(), git: false });
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
    if !repo_use_git(&st.data_dir, &name) { return git_not_enabled(); }
    let dest = match resolve_repo(&st.data_dir, &name) {
        Some(p) => p,
        None => return json_err("not found locally", StatusCode::NOT_FOUND),
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
    #[allow(dead_code)]
    branch: String,
}

// repos_ship is the "final version" action: append a Keep-a-Changelog entry to
// CHANGELOG.md, stage all changes, commit, and optionally push. For a github.com
// https remote with a stored token, push uses a token-injected URL so a linked
// repo without a credential helper still works; otherwise it pushes via the
// configured origin. The token is scrubbed from any captured output.
async fn repos_ship(State(st): State<AppState>, Json(body): Json<ShipBody>) -> Response {
    let name = body.repo.trim().to_string();
    if !repo_use_git(&st.data_dir, &name) { return git_not_enabled(); }
    let dest = match resolve_repo(&st.data_dir, &name) {
        Some(p) => p,
        None => return json_err("not found locally", StatusCode::NOT_FOUND),
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
struct CreateBranchBody {
    name: String,
    branch: String,
    #[serde(default)]
    base: String,
}

// repos_create_branch starts a chat on its own branch cut from the repo's
// default branch (or `base`). This is the per-chat branch model: a new chat is
// just a branch from main. The repo folder is always switched onto the chat's
// branch — dirty work-in-progress is auto-stashed per branch and restored on
// return; ignored files (node_modules, .env, build caches) stay in place. No
// git worktrees are created: one checkout is shared by all chats on a repo.
//
// Returns {ok, branch, isolated, error}. `isolated` is always false now (kept
// for shape compat with the renderer): the folder IS the chat's checkout.
// Idempotent: if the folder is already on `branch`, the helper pops its parked
// stash (if any) and returns ok. The registry branch is updated inside the
// helper; repo context is re-pushed here on a successful switch.
async fn repos_create_branch(State(st): State<AppState>, Json(body): Json<CreateBranchBody>) -> Response {
    let name = body.name.trim().to_string();
    if !repo_use_git(&st.data_dir, &name) { return git_not_enabled(); }
    let branch = body.branch.trim().to_string();
    if branch.is_empty() {
        return json_ok(&serde_json::json!({ "ok": false, "branch": "", "isolated": false, "error": "branch is required" }));
    }
    let main = match resolve_repo(&st.data_dir, &name) {
        Some(p) => p,
        None => return json_ok(&serde_json::json!({ "ok": false, "branch": branch, "isolated": false, "error": "not found locally" })),
    };
    match ensure_folder_on_branch(&st.data_dir, &main, &name, &branch, &body.base).await {
        Ok(main) => {
            // Re-push repo context with the new branch (best-effort). The
            // registry branch is already updated inside the helper.
            let head = git_head(&main).await;
            let tree = top_level_tree(&main);
            let _ = push_repo_context(&st, &name, &main, &branch, &head, &tree).await;
            json_ok(&serde_json::json!({ "ok": true, "branch": branch, "isolated": false, "error": null }))
        }
        Err(e) => json_ok(&serde_json::json!({ "ok": false, "branch": branch, "isolated": false, "error": e })),
    }
}

#[derive(Deserialize)]
struct StateQuery {
    name: String,
    #[serde(default)]
    #[allow(dead_code)]
    branch: String,
}

// repos_state returns the live git state for a repo in one call: current
// branch, dirty file count, ahead/behind vs origin/<branch>, and whether a
// remote is configured. ahead/behind are 0/0 when the upstream ref is absent.
async fn repos_state(State(st): State<AppState>, Query(q): Query<StateQuery>) -> Response {
    let name = q.name.trim().to_string();
    // Non-git workspace: no branch/dirty/ahead/behind/remote. The UI hides the
    // git controls when useGit is false.
    if !repo_use_git(&st.data_dir, &name) {
        return json_ok(&serde_json::json!({
            "name": name,
            "branch": "",
            "dirty": 0,
            "ahead": 0,
            "behind": 0,
            "hasRemote": false,
            "useGit": false,
        }));
    }
    // Report the folder's live branch/dirty/ahead/behind. The branch query
    // param is accepted for shape compat but ignored (the folder tracks the
    // active chat's branch).
    let dest = match resolve_repo(&st.data_dir, &name) {
        Some(p) => p,
        None => return json_err("not found locally", StatusCode::NOT_FOUND),
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
        "useGit": true,
    }))
}

#[derive(Deserialize)]
struct CommitBody {
    repo: String,
    message: String,
    #[serde(default)]
    push: bool,
    #[serde(default)]
    #[allow(dead_code)]
    branch: String,
}

// repos_commit is a lightweight commit (+ optional push) with no version or
// CHANGELOG — the "finish the loop" counterpart to repos_ship. If push is true
// but the repo has no remote, returns {ok:false, error:"no remote configured"}.
async fn repos_commit(State(st): State<AppState>, Json(body): Json<CommitBody>) -> Response {
    let name = body.repo.trim().to_string();
    if !repo_use_git(&st.data_dir, &name) { return git_not_enabled(); }
    let dest = match resolve_repo(&st.data_dir, &name) {
        Some(p) => p,
        None => return json_err("not found locally", StatusCode::NOT_FOUND),
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
    #[allow(dead_code)]
    branch: String,
}

// repos_create_pr opens a GitHub PR for the repo's current (or specified) head
// branch against the default (or specified) base. Pushes the head branch to
// origin first. Errors clearly when: not a github.com repo, no stored token,
// no remote, or the push/PR call fails.
async fn repos_create_pr(State(st): State<AppState>, Json(body): Json<CreatePrBody>) -> Response {
    let name = body.repo.trim().to_string();
    if !repo_use_git(&st.data_dir, &name) { return git_not_enabled(); }
    let dest = match resolve_repo(&st.data_dir, &name) {
        Some(p) => p,
        None => return json_err("not found locally", StatusCode::NOT_FOUND),
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
    if !repo_use_git(&st.data_dir, &name) { return git_not_enabled(); }
    let dest = match resolve_repo(&st.data_dir, &name) {
        Some(p) => p,
        None => return json_err("not found locally", StatusCode::NOT_FOUND),
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
    #[allow(dead_code)]
    branch: String,
}

// repos_merge_pr is the UI-facing route for the session panel's Merge PR
// button: merges a PR by number via the GitHub API. Reuses merge_pr_for_repo
// so it stays in sync with the agent's merge_pr tool. Returns {ok, sha} or
// {ok:false, error}. method defaults to "merge".
async fn repos_merge_pr(State(st): State<AppState>, Json(body): Json<MergePrBody>) -> Response {
    let name = body.repo.trim().to_string();
    if !repo_use_git(&st.data_dir, &name) { return git_not_enabled(); }
    let dest = match resolve_repo(&st.data_dir, &name) {
        Some(p) => p,
        None => return json_err("not found locally", StatusCode::NOT_FOUND),
    };
    if body.number == 0 {
        return json_ok(&serde_json::json!({ "ok": false, "sha": null, "error": "number is required" }));
    }
    match merge_pr_for_repo(&st.client, &dest, body.number, body.method.as_str()).await {
        Ok(sha) => json_ok(&serde_json::json!({ "ok": true, "sha": sha })),
        Err(e) => json_ok(&serde_json::json!({ "ok": false, "sha": null, "error": e })),
    }
}

// --- Create a new workspace (named, optional git) ---------------------------

#[derive(Deserialize)]
struct CreateWorkspaceBody {
    path: String,
    name: String,
    #[serde(default)]
    use_git: Option<bool>,
}

// repos_create_workspace registers a local folder as a workspace, optionally
// initializing git. Unlike repos_add_local (which connects an EXISTING git
// repo), this is the "new workspace" path: the user picked a folder and chose a
// name + whether to track it with git. When useGit=true on a non-git folder it
// runs git init + an initial commit in place; when useGit=false it registers
// the plain folder as-is (file tools work, git tools/routes are hidden).
// Validates the name (safe token, unique), records it in the sidecar registry,
// and pushes context to the backend. full_name is the user-provided name (the
// unique key); the display name equals it.
async fn repos_create_workspace(State(st): State<AppState>, Json(body): Json<CreateWorkspaceBody>) -> Response {
    let raw_path = body.path.trim().to_string();
    let name = body.name.trim().to_string();
    if raw_path.is_empty() {
        return json_err("path is required", StatusCode::BAD_REQUEST);
    }
    if name.is_empty() {
        return json_err("name is required", StatusCode::BAD_REQUEST);
    }
    if !is_safe_workspace_name(&name) {
        return json_err(
            "name must be a simple token (letters, digits, space, dot, dash, underscore — no slashes or shell metacharacters)",
            StatusCode::BAD_REQUEST,
        );
    }
    if load_registry(&st.data_dir).iter().any(|r| r.full_name == name) {
        return json_err(
            "a workspace with that name is already connected",
            StatusCode::CONFLICT,
        );
    }
    let p = PathBuf::from(&raw_path);
    if !p.is_dir() {
        return json_err("path is not a directory", StatusCode::BAD_REQUEST);
    }
    let use_git = body.use_git.unwrap_or(true);
    let is_git_already = git_toplevel(&p).await.is_some();
    if use_git && !is_git_already {
        if let Err(e) = git_init_and_initial_commit(&p).await {
            return json_err(&e, StatusCode::BAD_GATEWAY);
        }
    }
    let root = if is_git_already || use_git {
        git_toplevel(&p).await.unwrap_or_else(|| p.clone())
    } else {
        match p.canonicalize() {
            Ok(r) => r,
            Err(_) => p,
        }
    };
    let (branch, head, tree) = if use_git {
        (
            git_branch(&root).await,
            git_head(&root).await,
            top_level_tree(&root),
        )
    } else {
        (String::new(), String::new(), top_level_tree(&root))
    };
    let remote = if use_git { git_remote_url(&root).await } else { None };
    let full_name = name.clone();
    upsert_registry(
        &st.data_dir,
        &RepoRecord {
            full_name: full_name.clone(),
            path: root.display().to_string(),
            remote: remote.clone(),
            branch: branch.clone(),
            folder_id: None,
            linked: true,
            use_git,
            name: Some(name.clone()),
        },
    );
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
        "useGit": use_git,
    }))
}

// --- Promote a non-git workspace to git-enabled ------------------------------

#[derive(Deserialize)]
struct InitGitBody {
    name: String,
}

// repos_init_git promotes a non-git workspace to git-enabled in place: runs
// git init + an initial commit on the workspace folder, flips the registry
// record's use_git to true, re-derives branch/head/tree, and re-pushes context
// to the backend. The workspace keeps its full_name (and display name). If it
// was already git-enabled, returns ok with alreadyGit=true (no-op).
async fn repos_init_git(State(st): State<AppState>, Json(body): Json<InitGitBody>) -> Response {
    let name = body.name.trim().to_string();
    if name.is_empty() {
        return json_err("name is required", StatusCode::BAD_REQUEST);
    }
    let mut repos = load_registry(&st.data_dir);
    let rec = match repos.iter_mut().find(|r| r.full_name == name) {
        Some(r) => r,
        None => return json_err("workspace not found in registry", StatusCode::NOT_FOUND),
    };
    if rec.use_git {
        return json_ok(&serde_json::json!({ "ok": true, "alreadyGit": true, "error": null }));
    }
    let root = PathBuf::from(&rec.path);
    if !root.is_dir() {
        return json_err("workspace path is not a directory", StatusCode::BAD_REQUEST);
    }
    if let Err(e) = git_init_and_initial_commit(&root).await {
        return json_err(&e, StatusCode::BAD_GATEWAY);
    }
    rec.use_git = true;
    rec.branch = git_branch(&root).await;
    let head = git_head(&root).await;
    let tree = top_level_tree(&root);
    rec.remote = git_remote_url(&root).await;
    let branch = rec.branch.clone();
    let remote = rec.remote.clone();
    save_registry(&st.data_dir, &repos);
    let _ = push_repo_context(&st, &name, &root, &branch, &head, &tree).await;
    json_ok(&serde_json::json!({
        "ok": true,
        "alreadyGit": false,
        "name": name,
        "branch": branch,
        "head": head,
        "remote": remote,
        "tree": tree,
        "error": null,
    }))
}

// --- Undo last write for a non-git workspace (recovery snapshot restore) -------

#[derive(Deserialize)]
struct UndoLastBody {
    name: String,
}

// repos_undo_last restores the newest recovery snapshot for a non-git workspace,
// undoing the most recent approved write tool. Git workspaces are pointed at
// /repos/revert instead (they have git to undo with). Returns {ok} or
// {ok:false,error}.
async fn repos_undo_last(State(st): State<AppState>, Json(body): Json<UndoLastBody>) -> Response {
    let name = body.name.trim().to_string();
    if name.is_empty() {
        return json_err("name is required", StatusCode::BAD_REQUEST);
    }
    if repo_use_git(&st.data_dir, &name) {
        return json_ok(&serde_json::json!({
            "ok": false,
            "error": "undo-last is for non-git workspaces; use /repos/revert for a git workspace",
        }));
    }
    let dest = match resolve_repo(&st.data_dir, &name) {
        Some(p) => p,
        None => return json_err("not found locally", StatusCode::NOT_FOUND),
    };
    match undo_last_snapshot(&st.data_dir, &name, &dest) {
        Ok(_) => json_ok(&serde_json::json!({ "ok": true })),
        Err(e) => json_ok(&serde_json::json!({ "ok": false, "error": e })),
    }
}

// --- Open a workspace in an external app (editor / Finder / terminal) ------------

#[derive(Deserialize)]
struct OpenInBody {
    name: String,
    // "editor" | "finder" | "terminal"
    target: String,
}

// repos_open_in opens a workspace folder in an external application: the user's
// editor ($VISUAL/$EDITOR, else a platform default), the file manager
// (Finder/Explorer/xdg), or a terminal. The child is detached + stdio null so
// the sidecar never waits on it. Best-effort: returns {ok:false,error} when the
// launch fails (e.g. no editor installed) so the UI can toast the reason.
async fn repos_open_in(State(st): State<AppState>, Json(body): Json<OpenInBody>) -> Response {
    let name = body.name.trim().to_string();
    let target = body.target.trim().to_lowercase();
    if name.is_empty() {
        return json_err("name is required", StatusCode::BAD_REQUEST);
    }
    let dest = match resolve_repo(&st.data_dir, &name) {
        Some(p) => p,
        None => return json_err("not found locally", StatusCode::NOT_FOUND),
    };
    let path_str = dest.display().to_string();
    let mut cmd = tokio::process::Command::new("sh");
    cmd.arg("-c");
    let script = match target.as_str() {
        "editor" => {
            // Prefer $VISUAL / $EDITOR; fall back to a platform default.
            let exe = std::env::var("VISUAL")
                .or_else(|_| std::env::var("EDITOR"))
                .unwrap_or_else(|_| default_editor().to_string());
            format!("{exe:?} {:?}", path_str)
        }
        "finder" => format!("{:?} {:?}", default_file_manager(), path_str),
        "terminal" => default_terminal_command(&path_str),
        other => {
            return json_err(
                &format!("unknown target \"{other}\" (want editor, finder, or terminal)"),
                StatusCode::BAD_REQUEST,
            )
        }
    };
    cmd.arg(script);
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    match cmd.spawn() {
        Ok(_child) => json_ok(&serde_json::json!({ "ok": true })),
        Err(e) => json_ok(&serde_json::json!({
            "ok": false,
            "error": format!("could not open: {e}"),
        })),
    }
}

// default_editor returns a platform-default editor command when $VISUAL/$EDITOR
// is unset. macOS: `open -a "Visual Studio Code"` (the most common harness
// editor); Windows/Linux: `code` (the VS Code CLI, widely installed).
fn default_editor() -> &'static str {
    if cfg!(target_os = "macos") {
        "open -a \"Visual Studio Code\""
    } else {
        "code"
    }
}

// default_file_manager returns the command that opens a folder in the OS file
// manager: `open` (macOS Finder), `explorer` (Windows Explorer), `xdg-open`
// (Linux).
fn default_file_manager() -> &'static str {
    if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(target_os = "windows") {
        "explorer"
    } else {
        "xdg-open"
    }
}

// default_terminal_command returns a `sh -c`-safe script that opens a
// terminal cd'd into the workspace folder. macOS: `open -a Terminal`; Windows
// opens `cmd` at the path; Linux tries x-terminal-emulator then xterm. The
// path is injected via {:?} (Debug-quoted) so spaces/quotes are safe; workspace
// paths are filesystem paths and won't contain the delimiter.
fn default_terminal_command(path: &str) -> String {
    if cfg!(target_os = "macos") {
        format!("open -a Terminal {:?}", path)
    } else if cfg!(target_os = "windows") {
        // cmd /c start cmd /k "cd /d <path>" — inner quotes escaped for sh -c.
        // Workspace paths are filesystem paths and won't contain ", so no replace.
        format!("cmd /c start cmd /k \"cd /d {}\"", path)
    } else {
        format!("x-terminal-emulator --directory {:?} 2>/dev/null || xterm -e 'cd {:?}' &", path, path)
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
        .route("/__sidecar/repos/create-workspace", post(repos_create_workspace))
        .route("/__sidecar/repos/init-git", post(repos_init_git))
        .route("/__sidecar/repos/open-in", post(repos_open_in))
        .route("/__sidecar/repos/undo-last", post(repos_undo_last))
        .route("/__sidecar/repos/scan-local", post(repos_scan_local))
        .route("/__sidecar/repos/clone", post(repos_clone))
        .route("/__sidecar/repos/refresh", post(repos_refresh))
        .route("/__sidecar/repos/open", post(repos_open))
        .route("/__sidecar/repos/exec", post(repos_exec))
        .route("/__sidecar/repos/exec/stream", post(repos_exec_stream))
        .route("/__sidecar/ssh/exec", post(ssh_exec))
        .route("/__sidecar/ssh/exec/stream", post(ssh_exec_stream))
        .route("/__sidecar/repos/diff", post(repos_diff))
        .route("/__sidecar/repos/revert", post(repos_revert))
        .route("/__sidecar/repos/changelog", post(repos_changelog))
        .route("/__sidecar/repos/ship", post(repos_ship))
        .route("/__sidecar/repos/set-folder", post(repos_set_folder))
        .route("/__sidecar/repos/create-branch", post(repos_create_branch))
        .route("/__sidecar/repos/state", get(repos_state))
        .route("/__sidecar/repos/branches", post(repos_branches))
        .route("/__sidecar/repos/checkout", post(repos_checkout))
        .route("/__sidecar/repos/commit", post(repos_commit))
        .route("/__sidecar/repos/create-pr", post(repos_create_pr))
        .route("/__sidecar/repos/prs", get(repos_prs))
        .route("/__sidecar/repos/merge-pr", post(repos_merge_pr))
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

    #[test]
    fn ssh_shell_escape_quotes_and_escapes() {
        // plain path → single-quoted
        assert_eq!(ssh_shell_escape("/var/log/syslog"), "'/var/log/syslog'");
        // empty → '' (still a valid quoted token; builders guard empty upstream)
        assert_eq!(ssh_shell_escape(""), "''");
        // embedded single quote → close, escape, reopen
        assert_eq!(ssh_shell_escape("a'b"), "'a'\\''b'");
        // shell metacharacters are inert inside single quotes
        assert_eq!(ssh_shell_escape("$(whoami)"), "'$(whoami)'");
        assert_eq!(ssh_shell_escape("a;rm -rf /"), "'a;rm -rf /'");
    }

    #[test]
    fn ssh_command_builders_inject_escaped_args() {
        // ssh_run passes the command through verbatim (the user approves it).
        assert_eq!(
            ssh_run_command(&j(serde_json::json!({"host":"nas","command":"uname -a"}))),
            "uname -a"
        );
        // ssh_read wraps the path in cat -- '<escaped>'.
        assert_eq!(
            ssh_read_command(&j(serde_json::json!({"host":"nas","path":"/etc/hosts"}))),
            "cat -- '/etc/hosts'"
        );
        // a path with a quote is escaped, not injected.
        assert_eq!(
            ssh_read_command(&j(serde_json::json!({"host":"nas","path":"a'b"}))),
            "cat -- 'a'\\''b'"
        );
        // missing path → empty (caller surfaces "no command").
        assert_eq!(ssh_read_command(&j(serde_json::json!({"host":"nas"}))), "");
        // ssh_list defaults to ls -la when no path.
        assert_eq!(ssh_list_command(&j(serde_json::json!({"host":"nas"}))), "ls -la");
        assert_eq!(
            ssh_list_command(&j(serde_json::json!({"host":"nas","path":"/srv"}))),
            "ls -la -- '/srv'"
        );
        // ssh_grep escapes pattern + path and optional include glob.
        assert_eq!(
            ssh_grep_command(&j(serde_json::json!({"host":"nas","pattern":"foo","path":"/srv"}))),
            "grep -rn -- 'foo' '/srv'"
        );
        assert_eq!(
            ssh_grep_command(&j(serde_json::json!({"host":"nas","pattern":"foo bar"}))),
            "grep -rn -- 'foo bar'"
        );
        assert_eq!(
            ssh_grep_command(&j(serde_json::json!({"host":"nas","pattern":"x","path":"/etc","include":"*.conf"}))),
            "grep -rn --include='*.conf' -- 'x' '/etc'"
        );
        // missing pattern → empty.
        assert_eq!(ssh_grep_command(&j(serde_json::json!({"host":"nas"}))), "");
    }

    #[test]
    fn is_safe_ssh_alias_rejects_metacharacters() {
        assert!(is_safe_ssh_alias("nas"));
        assert!(is_safe_ssh_alias("mac.lan"));
        assert!(is_safe_ssh_alias("host-1"));
        assert!(is_safe_ssh_alias("vm_2"));
        // reject empty, whitespace, shell metacharacters, ssh-option injection.
        assert!(!is_safe_ssh_alias(""));
        assert!(!is_safe_ssh_alias("nas;rm"));
        assert!(!is_safe_ssh_alias("-oProxyCommand=x"));
        assert!(!is_safe_ssh_alias("nas host"));
        assert!(!is_safe_ssh_alias("nas`whoami`"));
    }

    #[test]
    fn cap_ssh_observation_trims_and_caps_on_char_boundary() {
        assert_eq!(cap_ssh_observation("  hi\n"), "hi");
        let big = "x".repeat(MAX_OBS_CHARS + 50);
        let capped = cap_ssh_observation(&big);
        assert!(capped.ends_with("…[truncated]"));
        // ASCII body is exactly MAX_OBS_CHARS bytes before the marker.
        assert_eq!(capped.len(), MAX_OBS_CHARS + "\n…[truncated]".len());
        // A multibyte cut is backed off to a char boundary: valid UTF-8 end to
        // end, with the marker present.
        let mut multi = String::from("a").repeat(MAX_OBS_CHARS - 1);
        multi.push('\u{00E9}'); // 2-byte é right at the cap boundary
        multi.push_str("zz");
        let capped = cap_ssh_observation(&multi);
        std::str::from_utf8(capped.as_bytes()).expect("valid utf-8");
        assert!(capped.ends_with("…[truncated]"));
    }

    #[test]
    fn is_write_tool_covers_file_writes_not_git_or_read() {
        // File-mutation tools that get snapshotted for undo-last.
        for t in ["write_file", "edit_file", "delete_path", "move_path", "apply_patch"] {
            assert!(is_write_tool(t), "{t} should be a write tool");
        }
        // git tools are NOT write tools here (they're gated separately by
        // is_git_tool); run_command is intentionally excluded (too aggressive).
        for t in ["read_file", "grep", "tree", "git_status", "git_commit", "run_command", "todo_write"] {
            assert!(!is_write_tool(t), "{t} should not be a write tool");
        }
    }

    #[test]
    fn snapshot_and_undo_last_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = tempfile::tempdir().unwrap();
        let root = std::fs::canonicalize(dir.path()).unwrap();
        std::fs::write(root.join("a.txt"), "before\n").unwrap();
        std::fs::write(root.join("b.txt"), "keep\n").unwrap();
        // node_modules is skipped by the snapshot (heavy dir).
        std::fs::create_dir_all(root.join("node_modules")).unwrap();
        std::fs::write(root.join("node_modules/x.js"), "deps").unwrap();

        // Snapshot the pre-write state, then mutate, then undo restores it.
        let snap = snapshot_workspace(data_dir.path(), "ws", &root).expect("snapshot");
        assert!(snap.is_dir(), "snapshot dir was created");
        assert!(snap.join("a.txt").is_file(), "a.txt was snapshotted");
        assert!(!snap.join("node_modules").exists(), "node_modules was skipped");

        // Simulate a write tool: overwrite a.txt and add a new file.
        std::fs::write(root.join("a.txt"), "after\n").unwrap();
        std::fs::write(root.join("new.txt"), "created\n").unwrap();

        // Undo restores the snapshot: a.txt reverts, new.txt is removed, b.txt stays.
        undo_last_snapshot(data_dir.path(), "ws", &root).expect("undo");
        assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), "before\n");
        assert!(!root.join("new.txt").exists(), "new.txt should be removed by undo");
        assert_eq!(std::fs::read_to_string(root.join("b.txt")).unwrap(), "keep\n");
        // node_modules is skipped on restore too (kept, not cleared).
        assert!(root.join("node_modules/x.js").exists(), "node_modules should be preserved");
        // The restored snapshot was consumed.
        assert!(!snap.exists(), "snapshot should be consumed by undo");
    }

    #[test]
    fn is_safe_workspace_name_accepts_plain_tokens() {
        // letters, digits, spaces, dot, dash, underscore are fine.
        assert!(is_safe_workspace_name("notes"));
        assert!(is_safe_workspace_name("My Notes 2024"));
        assert!(is_safe_workspace_name("proj.v2"));
        assert!(is_safe_workspace_name("scratch-pad"));
        assert!(is_safe_workspace_name("tmp_3"));
        // reject empty, slashes (path escape), shell metacharacters, too long.
        assert!(!is_safe_workspace_name(""));
        assert!(!is_safe_workspace_name("   "));
        assert!(!is_safe_workspace_name("a/b"));
        assert!(!is_safe_workspace_name("..\\secret"));
        assert!(!is_safe_workspace_name("a;rm -rf /"));
        assert!(!is_safe_workspace_name("$(whoami)"));
        assert!(!is_safe_workspace_name("a`x`"));
        let long = "w".repeat(81);
        assert!(!is_safe_workspace_name(&long));
        // 80 chars is still allowed (the cap is inclusive).
        let max = "w".repeat(80);
        assert!(is_safe_workspace_name(&max));
    }

    #[test]
    fn repo_use_git_defaults_true_for_unregistered() {
        let dir = tempfile::tempdir().unwrap();
        // A name with no registry record (e.g. a workspace-dir-only clone
        // discovered by repos_local, which always has .git) defaults to true so
        // pre-workspace clones keep behaving as git repos.
        assert!(repo_use_git(dir.path(), "owner/repo"));
    }

    #[tokio::test]
    async fn git_routes_gate_on_non_git_workspace() {
        // Build a registry with one non-git workspace and assert the gating
        // helpers behave: repo_use_git returns false for it, and the shared
        // git_not_enabled response shape is the {ok:false,error} the UI expects.
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path();
        upsert_registry(
            data_dir,
            &RepoRecord {
                full_name: "scratch".into(),
                path: data_dir.join("scratch").display().to_string(),
                remote: None,
                branch: String::new(),
                folder_id: None,
                linked: true,
                use_git: false,
                name: Some("scratch".into()),
            },
        );
        assert!(!repo_use_git(data_dir, "scratch"), "non-git record should gate");
        assert!(repo_use_git(data_dir, "other"), "unregistered name defaults to git");
        // git_not_enabled is a Response; check its JSON body has the soft shape.
        let resp = git_not_enabled();
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        let s = String::from_utf8_lossy(&body);
        assert!(s.contains("\"ok\":false"), "got: {s}");
        assert!(s.contains("workspace is not git-enabled"), "got: {s}");
    }

    #[tokio::test]
    async fn ensure_folder_on_branch_stashes_and_restores() {
        let dir = init_test_repo().await;
        let root = dir.path();
        let data = tempfile::tempdir().unwrap();
        let data_dir = data.path();

        // Register the repo so repo_use_git returns true and the helper can
        // update the registry.
        let branch_a = git_branch(root).await; // initial branch (main or master)
        upsert_registry(data_dir, &RepoRecord {
            full_name: "test/stash".into(),
            path: root.display().to_string(),
            remote: None,
            branch: branch_a.clone(),
            folder_id: None,
            linked: true,
            use_git: true,
            name: Some("test/stash".into()),
        });

        // Commit a .gitignore listing node_modules so the ignored file stays
        // ignored on every branch (a tracked .gitignore survives switches; an
        // untracked one would be stashed by -u, un-ignoring node_modules on the
        // other branch and making the switch-back dirty).
        std::fs::write(root.join(".gitignore"), "node_modules\n").unwrap();
        let _ = tokio::process::Command::new("git")
            .arg("-C").arg(root).arg("add").arg(".gitignore")
            .output().await.unwrap();
        let _ = tokio::process::Command::new("git")
            .arg("-C").arg(root).arg("commit").arg("-q").arg("-m").arg("gitignore")
            .output().await.unwrap();

        // Dirty branch A: a tracked edit to f.txt + an ignored node_modules/x.txt.
        std::fs::write(root.join("f.txt"), "a\nb\nDIRTY\n").unwrap();
        std::fs::create_dir_all(root.join("node_modules")).unwrap();
        std::fs::write(root.join("node_modules/x.txt"), "ignored\n").unwrap();
        assert!(git_dirty_count(root).await > 0, "A should be dirty");

        // Switch to branch B via the helper. A's tracked edit is stashed (tagged
        // nasllm:<A>); the ignored node_modules/x.txt stays in place.
        let branch_b = "agent/b-chat";
        let r = ensure_folder_on_branch(data_dir, root, "test/stash", branch_b, "").await;
        assert!(r.is_ok(), "switch to B failed: {:?}", r.err());
        assert_eq!(git_branch(root).await, branch_b);
        // B is clean of A's tracked edit.
        assert_eq!(std::fs::read_to_string(root.join("f.txt")).unwrap(), "a\nb\n");
        // The ignored file persists (not stashed by -u).
        assert!(root.join("node_modules/x.txt").exists(), "ignored file was stashed");
        // B should be clean (node_modules is ignored by the committed .gitignore).
        assert_eq!(git_dirty_count(root).await, 0, "B should be clean");
        // A's stash is parked under the nasllm:<A> tag.
        let tagged = git_stash_list_tagged(root).await;
        assert!(tagged.iter().any(|s| s == &format!("nasllm:{branch_a}")), "A's stash not found: {tagged:?}");

        // Switch back to A. The helper pops the stash tagged nasllm:<A>,
        // restoring A's tracked edit.
        let r = ensure_folder_on_branch(data_dir, root, "test/stash", &branch_a, "").await;
        assert!(r.is_ok(), "switch back to A failed: {:?}", r.err());
        assert_eq!(git_branch(root).await, branch_a);
        assert_eq!(
            std::fs::read_to_string(root.join("f.txt")).unwrap(),
            "a\nb\nDIRTY\n",
            "A's tracked edit should be restored by the stash pop"
        );
        // The ignored file still persists.
        assert!(root.join("node_modules/x.txt").exists(), "ignored file should still persist");
        // The stash was consumed by the clean pop.
        let tagged = git_stash_list_tagged(root).await;
        assert!(!tagged.iter().any(|s| s == &format!("nasllm:{branch_a}")), "A's stash should be popped: {tagged:?}");
    }
}

