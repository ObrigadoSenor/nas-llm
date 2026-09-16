# Desktop chat/branch flow: folder-follows-active-chat + auto-stash, drop per-chat worktrees — task log (sidecar half)

Plan: `90d42686-4182-44ef-b23b-c70f12190657`. This log covers the **sidecar half**
(`desktop/src-tauri/src/github.rs` + `desktop/AGENTS.md`). The renderer half
(`desktop/renderer/desktop.js` + `desktop/src-tauri/src/sidecar.rs` cache-bust +
`desktop/README.md`) is owned by a sibling child agent and merged into one PR.

## Goal
Replace the per-chat git worktree model with one shared checkout (the repo folder)
that always tracks the active chat's branch. Switching to a chat/branch auto-stashes
dirty work-in-progress keyed per branch (`nasllm:<branch>`) and pops the target
branch's parked stash on arrival, so a switch never carries another chat's
uncommitted edits. Ignored files (`node_modules`, `.env`, build caches) are never
stashed (`git stash push -u`), so there is no reinstall on return. No git worktrees
are created anymore.

## Current state / root cause
* `repos_create_branch` (`github.rs`) had two paths: clean folder → `git switch -c`
  (folder onto branch); dirty folder → `git branch <branch> <base>` ref-only, leaving
  the folder untouched and returning `isolated:true`. The chat then ran in a lazily-
  provisioned isolated worktree via `repos_exec`/`ensure_worktree(create=false)`.
* A fresh worktree starts with no untracked/ignored files, so `node_modules`, `.env`,
  and build caches were absent until the agent re-created them — the maintenance pain
  this change fixes.
* `resolve_repo_branch` routed every session route through `ensure_worktree`, so once
  the folder was dirty/on another branch, a chat's first tool call provisioned a clean
  worktree under `<data_dir>/worktrees/<repo>/<branch>`.
* `repos/worktree` and `repos/branch` routes were already unused by the renderer.

## Changes

### `desktop/src-tauri/src/github.rs`
* **New helpers** (`git_stash_push`, `git_stash_list_tagged`, `git_stash_pop_tagged`):
  - `git_stash_push(path, msg)` — `git stash push -u -m <msg>`. `-u` stashes tracked +
    untracked-non-ignored WIP, leaving ignored files in place.
  - `git_stash_list_tagged(path) -> Vec<String>` — returns stash subjects starting with
    `nasllm:` (located via `git stash list` split on the last `": "`). `#[allow(dead_code)]`
    (used only in the test module).
  - `git_stash_pop_tagged(path, tag)` — pops the stash whose subject equals `tag`. No-op
    if none. On pop conflict (non-zero exit) the stash is KEPT and the conflict text
    returned as `Err` so the caller surfaces a warning — edits are never silently lost.
* **New `ensure_folder_on_branch(data_dir, main, repo_name, branch, base) -> Result<PathBuf, String>`**:
  the single shared switch helper. Gates on `repo_use_git` (no-op for non-git) and empty
  branch (returns `main`). If already on `branch`, pops its parked stash and returns. If
  dirty, stashes WIP keyed `nasllm:<current_branch>`. Switches (`git switch` or `git switch -c
  <branch> <base>`, base defaults to the repo's default branch). Pops `nasllm:<branch>`.
  Updates the registry branch. Returns `Err` on stash/switch failure or pop conflict
  (the folder is switched either way; the stash is kept for manual `git stash pop`).
* **`repos_create_branch`** repointed to `ensure_folder_on_branch` for both clean and
  dirty folders (always switch; the dirty ref-only path is gone). Returns
  `{ok, branch, isolated:false, error}` — `isolated` is always `false` now (kept for
  shape compat). `push_repo_context` is called by the handler after `Ok`.
* **`repos_exec` / `repos_exec_stream`**: replaced `ensure_worktree(create=false)` with
  `ensure_folder_on_branch(&st.data_dir, &main, &repo_name, &body.branch, "")`. Empty
  branch → `Ok(main)` via the helper (as today). Same `ExecResult` / `sse_error` error
  shape, message "Branch switch unavailable: …".
* **10 session routes** switched from `resolve_repo_branch(&st.data_dir, &name, &body.branch)`
  to `resolve_repo(&st.data_dir, &name)` (folder), None → `json_err("not found locally", NOT_FOUND)`:
  `repos_state`, `repos_refresh`, `repos_diff`, `repos_revert`, `repos_changelog`,
  `repos_ship`, `repos_commit`, `repos_create_pr`, `repos_prs`, `repos_merge_pr`.
  The `branch` field stays in each request struct (`#[allow(dead_code)]`, accepted for
  shape compat, ignored). `repos_refresh` dropped its branch-aware path (always pulls the
  folder). `repos_state` reports the folder's live branch/dirty/ahead/behind and ignores
  the `branch` query param.
* **Removed dead machinery**: `ensure_worktree`, `resolve_repo_branch`, `git_worktree_list`,
  `git_worktree_prune`, `worktrees_dir`, the worktree comment block, `repos_worktree` handler
  + `WorktreeBody`, `repos_branch` handler + `BranchBody`, the `.route` entries for
  `branch` and `worktree` in `router()`, and the now-unused `slugify` helper. Kept
  `git_has_ref`/`git_default_branch`/`git_branch`/`git_dirty_count` (used by the new helper).
* **New `#[cfg(test)]`** `ensure_folder_on_branch_stashes_and_restores`: commits a `.gitignore`
  (node_modules), dirties branch A (tracked edit to f.txt + ignored node_modules/x.txt),
  switches to B (asserts A's tracked edit stashed, ignored file persists, B clean, stash
  tagged `nasllm:<A>`), switches back to A (asserts tracked edit restored by pop, ignored
  file still persists, stash consumed).

### `desktop/AGENTS.md`
* Route list (`:48`): removed `worktree` and `branch`; added `exec/stream`, `prs`, `merge-pr`;
  updated the line reference to `github.rs` `router()`.
* Git-only route list (`:52`): removed `branch`/`worktree`.
* New paragraph (`:54`) describing the folder-follows-active-chat + auto-stash model (one
  checkout shared by chats on a repo; dirty WIP auto-stashed per branch and restored on
  return; ignored files persist; pop conflict keeps the stash + surfaces a warning; session
  routes' `branch` param accepted but ignored).
* `github.rs` layout entry (`:14`): test coverage description updated to include
  `ensure_folder_on_branch` auto-stash/restore.

## Route shape (final)
* `POST /__sidecar/repos/create-branch` — unchanged path, `{name, branch, base?}` body,
  `{ok, branch, isolated, error}` response. `isolated` is always `false` now (shape compat).
* Session routes (`repos/state`, `repos/exec`, `repos/commit`, `repos/create-pr`, `repos/prs`,
  `repos/merge-pr`, `repos/diff`, `repos/revert`, `repos/changelog`, `repos/ship`,
  `repos/refresh`) — unchanged paths; `branch` param accepted but ignored; operate on the
  repo folder.
* **Removed routes**: `POST /__sidecar/repos/branch`, `POST /__sidecar/repos/worktree`.

## Validation
* `cargo check` in `desktop/src-tauri` — clean, **no warnings**.
* `cargo test` in `desktop/src-tauri` — **27 passed; 0 failed** (includes the new
  `ensure_folder_on_branch_stashes_and_restores` test).
* Backend is untouched by this half; `make check` (gofmt/vet/test) should stay green.

## Remaining (user)
* `npm run desktop` and exercise: connect a repo → + New chat → composer shows the new
  `agent/<slug>-<id>` branch and the folder switches to it → edit (approve) → start a 2nd
  chat while the 1st has uncommitted edits → 1st chat's edits are stashed (not carried),
  2nd chat runs on its own branch in the folder, `node_modules` persists → switch back to
  1st chat → stash pops, edits restored. Then ⎇ chip re-point and remote branch checkout.
* Note the concurrency tradeoff: two chats on different branches of one repo share one
  folder. A background tool on chat A while the active chat is B will switch the folder to A
  (stashing B's edits, popping A's), then the rail switches back to B — rapid background tool
  runs can bounce the folder. Cross-repo concurrency is unaffected (separate folders).

## Tradeoffs / known limitations (accepted)
* **Same-repo concurrent chats share one folder.** No simultaneous isolated trees for two
  chats on one repo. Mitigation: run one same-repo chat at a time, or accept the bounce.
* **Stash pop can conflict** if a branch evolved (e.g., auto-sync fast-forwarded it) while
  its stash was parked. On conflict the stash is kept and a warning surfaced for manual
  `git stash pop` — edits are never silently lost.
* **Stash ownership by message tag** (`nasllm:<branch>`) survives sidecar restart and
  stash-stack shifts, but is keyed by branch name — if two chats share the same branch name
  they share the same stash slot (acceptable: same branch = same work).
* The repo folder reflects whichever chat was last activated/ran a tool — consistent with
  the prior documented behavior, now extended to chat activation.
