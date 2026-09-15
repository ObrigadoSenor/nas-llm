# Desktop workspaces — generalize repos so a local folder can be tracked without git

Source plan: `197a643d-fc3c-4760-8d18-6227095bba11`.

## Goal

A connected codebase is a "workspace": either a git repo (the only case before this change) or a plain folder. The user picks a folder, names it, and chooses whether to track it with git. When `useGit=false`, file tools still run but git tools/routes/controls are hidden.

## Design (additive, no rename)

A workspace IS a `Repo` record with a `useGit` flag + a display `name`. No parallel entity, no `Repo`→`Workspace` type rename (pure churn); only the UI label becomes "Workspaces".

### Backend (`backend/`)

- `Repo` struct (`store.go`) + `repos` table gained `UseGit bool` (`use_git INTEGER NOT NULL DEFAULT 1`) and `Name string` (`name TEXT NOT NULL DEFAULT ''`). `migrate()` adds the columns; existing rows stay git-enabled.
- `upsertRepo`/`listRepos`/`getRepo` read+write the new columns. `handleRepoUpsert` accepts `useGit`+`name`, defaulting `useGit=true` when absent so older sidecars keep working.
- `localRepoTools()` split into `localFileTools()` (read+write, no git) and `localGitTools()` (status/log/PRs + commit/push/PR/merge); `localRepoTools()` still returns the literal union so the git-repo path is byte-identical.
- `jobs.go` agent wiring branches on `repo.UseGit`: git → `localRepoTools()` + `injectRepoContext`; non-git → `localFileTools()` + new `injectWorkspaceContext` (no branch/HEAD/worktree/gitignore text; keeps the .env-secret rule). `toolExecRelay` is set in both cases so file tools relay.

### Sidecar (`desktop/src-tauri/src/github.rs`)

- `RepoRecord` + `LocalRepo` carry `use_git` + `name`; `repos.json` deserializes old entries as `use_git=true`.
- `repos_add_local` accepts `{path, name?, useGit?}`: git folder → as before; non-git folder → requires `name` + `useGit=false`, else an error pointing at the new routes.
- New `POST /__sidecar/repos/create-workspace` (`{path, name, useGit}`; optional `git init` + initial commit) and `POST /__sidecar/repos/init-git` (promote a non-git workspace to git-enabled in place).
- `repos_scan_local` returns a `git` flag per candidate; when no `.git` is found it returns the picked folder as a single non-git candidate so the picker can offer "track without git".
- Git routes gate on `use_git` via `repo_use_git` + `git_not_enabled()` (`{ok:false,error:"workspace is not git-enabled"}`): `state`/`branches`/`checkout`/`branch`/`create-branch`/`commit`/`create-pr`/`prs`/`merge-pr`/`worktree`/`ship`/`changelog`/`refresh`/`diff`/`revert`. `repos_state` returns `useGit:false` + zeros for a non-git workspace. `repos_exec` short-circuits the git tools with a clear observation; file tools run unchanged.

### Frontend (`desktop/renderer/desktop.js`)

- Sidebar "+" opens `openConnectMenu`: "Connect git repo…" (existing `connectFolderFlow`) and "New workspace…" (`createWorkspaceFlow`: pick → name + "Track with git" dialog → `create-workspace`).
- `connectFolderFlow` routes a single non-git scan candidate to `createWorkspaceForPath`.
- `localRow` shows the `name` + a "no git" tag for non-git (hides branch/dirty); `repoMenu` (⋯) offers "Enable git" for non-git instead of Pull/Branch/Ship.
- `createRepoChat` → `createWorkspaceChat`: skips `create-branch`/`repoBranch` for non-git; sets file-only `agentTools`.
- Composer status line + session panel hide git-only controls for non-git and offer an "Enable git" button.
- First-load wizard reworded to "Connect a workspace" with both git and non-git buttons.
- `desktop.js?v` → 29, `desktop.css?v` → 21 in `src-tauri/src/sidecar.rs` `index_html`.

## Tests

- `backend/workspace_test.go`: `localFileTools`/`localGitTools` partition (no overlap; git tools absent from file set); `injectWorkspaceContext` content (names workspace, says no git, forbids git tools, keeps .env rule, no git-only concepts); `Repo` `UseGit`/`Name` store round-trip.
- `github.rs` `#[cfg(test)]`: `is_safe_workspace_name` accepts/rejects; `repo_use_git` default for unregistered; `git_not_enabled` response shape.

## Validation

`make check` (gofmt + go vet + go test, backend) and `cargo check` (desktop) pass; `node --check desktop/renderer/desktop.js` passes. No automated coverage for `www/` UI or end-to-end streaming — a UI/workspace-creation walkthrough on the NAS needs a human (say so in the release summary).

## Phase B (deferred, from the plan's section 6)

Copilot-app-inspired enhancements not in this phase: sessions-vs-chats sidebar split, base-branch picker at chat creation, plan mode + persisted `plan.md`, in-session todo list (Tasks Pill), recovery refs/undo for non-git workspaces, auto-sync (background pull), Agent Merge, My Work view, slash commands, open-in-editor/Finder. Each is a deferrable sub-item; none blocks the core workspace feature.
