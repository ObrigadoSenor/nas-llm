# Task list — Delete agent branches + minimal top navbar

Source plan: `Delete agent branches + minimal top navbar`.
Target: desktop app (`desktop/src-tauri/src/github.rs`, `desktop/renderer/desktop.js`, `desktop/renderer/desktop.css`).

## Part A — Delete agent branches

### Sidecar (`desktop/src-tauri/src/github.rs`)
- [x] `repos_branches`: add `default` to the JSON response (from `git_default_branch(&dest)`).
- [x] Add `DeleteBranchBody { repo, branch }` struct.
- [x] Add `repos_delete_branch` handler:
  - resolve `main` via `resolve_repo` (404 if missing);
  - refuse empty branch and refuse `== default` (return `{ok:false, error}`);
  - if `current == branch`: refuse when dirty ("commit or stash first"), else `git checkout <default>` first;
  - if a worktree for `branch` exists (`git_worktree_list`), `git worktree remove <path>` without `--force` (git refuses on dirty → protect chat work);
  - `git branch -D <branch>`;
  - if main tree was switched, refresh registry + `push_repo_context`;
  - return `{ok, branch}` / `{ok:false, error}`.
- [x] Register `.route("/__sidecar/repos/delete-branch", post(repos_delete_branch))` in `router()`.

### Renderer (`desktop/renderer/desktop.js`)
- [x] Add `async function deleteBranch(repoName, branch, defaultBranch)`:
  - `dsConfirm`; refresh `loadWorkspaceMaps`;
  - PATCH every chat whose repo matches and `repoBranch === branch` to `{repoBranch: defaultBranch}`;
  - `sid("repos/delete-branch", …)`;
  - on ok `flashDsOk` + re-render picker/rail/sidebar; on fail `flashDsErr`.
- [x] Trash button on each local, non-current, non-default branch row in `openBranchPicker` (stopPropagation; calls `deleteBranch`).
- [x] Trash button on each local, non-current, non-default branch row in `openChatBranchPicker` (stopPropagation; calls `deleteBranch`).
- [x] `openBranchPicker(r, mode)`: title switches to "Delete branch" when `mode === "delete"`; in delete mode rows don't switch on click (trash is the action).
- [x] `repoMenu`: add `add("Delete branch…", …)` opening `openBranchPicker(r, "delete")`.
- [x] Update `refreshLocal` empty-state text that referenced "the GitHub button in the header" (button moved to the sidebar).

## Part B — Minimal top navbar

### Renderer (`desktop/renderer/desktop.js`)
- [x] Rework `addSettingsButton()`:
  - when `#app` visible → do NOT insert gear/reposBtn into `<header>`; instead append compact icon buttons into `#who` before `#logout`;
  - when `#app` hidden (login) → keep the fixed viewport gear (pre-auth settings/paste-link sign-in).
- [x] `makeGear()` / `makeReposBtn()` accept a sidebar variant class (`ds-side-icon`) instead of header chrome.

### Styles (`desktop/renderer/desktop.css`)
- [x] Add `.ds-side-icon` (borderless icon matching `#logout` height, using the app's CSS vars).
- [x] Add `.ds-branch-default` badge + `.ds-branch-del` trash button styles.
- [x] Keep `.ds-gear-fixed` (login) as-is; keep header `.ds-gear`/`.ds-repos-btn` rules untouched (no longer applied when authed, but harmless).

## Validation
- [x] `cd desktop/src-tauri && cargo check` — compiles clean, no errors/warnings.
- [x] `node --check desktop/renderer/desktop.js` — parses without syntax errors.
- [ ] Manual: repo ⋯ → Delete branch… → trash deletes a non-current agent branch; chat on it falls back to default; dirty worktree refused with stash hint; default row shows no trash; header clean; gear/GitHub in sidebar footer; fixed gear on login.
