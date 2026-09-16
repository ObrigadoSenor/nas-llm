# desktop/ — Tauri 2 desktop shell

A Tauri 2 app that wraps the shared `www/` chat UI and proxies to the NAS backend through a local Rust sidecar. The renderer is an **additive layer** on top of `www/` — it never replaces or forks `www/app.js`; it injects one `<script>` and one `<link>` and shims `fetch`/`EventSource` at runtime.

For repo-wide conventions (branch model, commit style, verification loop, do-not-run scripts) see the root `AGENTS.md`.

## Layout

- `package.json` — npm scripts only: `npm run desktop` = `tauri dev`, `npm run desktop:build` = `tauri build`, `npm run desktop:signed` = `tauri dev` with the codesign linker wrapper (see `scripts/`). Deps: `@tauri-apps/cli` + `@tauri-apps/api`.
- `renderer/desktop.js` (~2325 lines) — the entire desktop bridge: settings overlay, paste-link sign-in, Ollama panel, GitHub/repos UI, approval dialogs, branch rail, in-app updater UI. Served at `/__sidecar/desktop.js`.
- `renderer/desktop.css` (~417 lines) — self-contained dark styles for the bridge (`.ds-*` classes). No dependency on the app's CSS variables.
- `src-tauri/src/main.rs` — entry point: binds a localhost port, resolves `www/` + `renderer/` resource paths, spawns the sidecar on the Tauri async runtime, creates the WebView window at the sidecar origin.
- `src-tauri/src/sidecar.rs` — the axum HTTP server: serves `www/`, exposes `/__sidecar/*` control plane, reverse-proxies `/api/*` to the NAS, proxies `/__ollama/*` to local Ollama. Holds the session cookie jar.
- `src-tauri/src/github.rs` — GitHub token storage (macOS Keychain via `keyring`), repo clone/pull/branch/exec/commit/PR operations, `/__sidecar/github/*` and `/__sidecar/repos/*` routes. The `repos_exec` dispatcher runs the local file tools: `read_file`/`list_files`/`glob`/`grep`/`git_status`/`git_log`/`list_prs` (read-only), `write_file`/`edit_file`/`delete_path`/`move_path` (new, approval-gated with a unified-diff preview), `apply_patch` (normalized + a 4-rung apply ladder), `run_command` (timeout-bounded), and `git_commit`/`git_push`/`create_pr`/`merge_pr`. For a non-git workspace (`useGit=false`), the git tools are short-circuited with a clear observation and the git-only routes return `{ok:false,error:"workspace is not git-enabled"}`. `create-workspace`/`init-git` register/promote workspaces (name + optional `git init`). `resolve_new_path` resolves create-target paths that may not yet exist. A `#[cfg(test)]` module covers patch normalization, the apply ladder, `resolve_new_path` guards, `edit_file` match counting, `is_safe_workspace_name`, and the non-git git-route gating, and `ensure_folder_on_branch` auto-stash/restore across a branch switch.
- `src-tauri/src/updater.rs` — three `#[tauri::command]`s (`app_version`, `check_for_updates`, `download_and_install_update`) wrapping `tauri-plugin-updater` so the renderer uses IPC, not plugin capabilities.
- `src-tauri/tauri.conf.json` — no static window (`windows: []`); `frontendDist` is `../../www`; bundles `../../www/` and `../renderer/` as resources; CSP is null; updater endpoint + pubkey configured.
- `src-tauri/capabilities/main.json` — permissions for the runtime-created `main` window. `remote.urls` allows `http://127.0.0.1:*` (the sidecar origin) so plugin commands work from the sidecar-loaded page.
- `scripts/` — opt-in, macOS-only local code-signing for dev: `setup-codesign.sh` (one-time self-signed cert import), `dev.sh` (`npm run desktop:signed`; exports `CARGO_TARGET_*_LINKER` + `NASLLM_CODESIGN_ID`), `codesign-linker.sh` (env-gated linker wrapper that re-signs the debug binary after every link). The wrapper is a no-op passthrough when `NASLLM_CODESIGN_ID` is unset, so `make check-desktop`/CI are unaffected. See README "Local code-signing (dev)".

## Sidecar architecture

`main.rs:63` binds `127.0.0.1` starting at port 17543, walking up 64 ports until free. The WebView is created at `http://127.0.0.1:<port>` (`main.rs:178-186`) and is **same-origin with the sidecar** — this is why `www/app.js`'s relative `/api/*` URLs and SSE `/events` work unchanged.

The renderer **never** talks to the NAS directly. All `/api/*` requests go through the sidecar's reverse proxy (`sidecar.rs:415` `proxy_api`), which:

- Attaches the session cookie from its jar to every outbound request (`sidecar.rs:443-447`).
- Captures `Set-Cookie` responses into the jar; strips `Set-Cookie` from the response so the WebView never sees it (`sidecar.rs:470-477`).
- Rewrites backend-host `Location` headers to the local origin (`sidecar.rs:478-486`, `rewrite_location` at `:553`).
- Streams response bodies (SSE/chunked) through unchanged.

The cookie jar is persisted to `<app-data>/nas-llm-desktop/session.json`; the backend URL to `config.json` (`sidecar.rs:59-90`).

### Routes (sidecar.rs:286-304)

- `GET /` — `www/index.html` with desktop bridge injected (`index_html`, `:308`).
- `GET /<asset>` — `serve_www` fallback (`:336`): traversal-guarded static file serving from `www/`, SPA fallback to `index_html` on miss.
- `ANY /api/*path` — `proxy_api` (`:415`): reverse proxy to the NAS backend.
- `GET /__sidecar/health` — liveness check.
- `GET /__sidecar/state` — backend URL, origin, authed flag, email (probes `/api/auth/me`).
- `POST /__sidecar/backend` — set + persist the NAS backend URL.
- `POST /__sidecar/test` — connectivity test (GET `/api/health` on a URL).
- `POST /__sidecar/verify` — paste-link magic-link sign-in (`:678`): walks the redirect chain to capture the session cookie, derives the backend origin, confirms via `/api/auth/me`.
- `POST /__sidecar/logout` — calls backend `/api/auth/logout`, clears the jar.
- `GET /__sidecar/desktop.js` / `desktop.css` — serves the renderer files.
- `GET/POST /__sidecar/ollama/{status,start,stop}` — local Ollama lifecycle.
- `ANY /__ollama/*path` — `proxy_ollama` (`:835`): same-origin proxy to `localhost:11434`, strips browser `Origin`/`Referer` (Ollama 403s them).

GitHub/repos routes are in `github.rs` `router()` (merged into the same axum app at `main.rs:148`): `/__sidecar/github/{status,connect,disconnect,repos}` and `/__sidecar/repos/{local,add-local,create-workspace,init-git,open-in,undo-last,scan-local,clone,refresh,open,exec,exec/stream,diff,revert,changelog,ship,set-folder,create-branch,state,branches,checkout,commit,create-pr,prs,merge-pr}`.

`open-in` opens a workspace in an external app (editor/Finder/terminal); `undo-last` restores the newest recovery snapshot for a non-git workspace (the non-git analog of `revert`). `repos_exec` snapshots the workspace tree before each approved write tool on a non-git workspace (into `<data_dir>/snapshots/<name>/`) so `undo-last` can restore it.

A connected codebase is a "workspace": either a git repo (`useGit=true`, the default and the only case before this feature) or a plain folder (`useGit=false`). The sidecar registry (`repos.json`) records `use_git` + `name` per record; git-only routes (`state`/`branches`/`checkout`/`create-branch`/`commit`/`create-pr`/`prs`/`merge-pr`/`ship`/`changelog`/`refresh`/`diff`/`revert`) gate on `use_git` and return `{ok:false,error:"workspace is not git-enabled"}` for a non-git workspace. `repos_exec` short-circuits the git tools (`git_status`/`git_log`/`list_prs`/`git_commit`/`git_push`/`create_pr`/`merge_pr`) for a non-git workspace with a clear observation; file tools run unchanged. `repos_state` returns `useGit:false` + zeros for branch/dirty/ahead/behind for a non-git workspace. `create-workspace` registers a folder with a name + optional `git init`; `init-git` promotes a non-git workspace to git-enabled in place.

One checkout (the repo folder) is shared by all chats on a repo — no git worktrees. The folder always tracks the active chat's branch: `repos_create_branch` and `repos_exec`/`repos_exec_stream` call `ensure_folder_on_branch`, which auto-stashes dirty work-in-progress keyed per branch (`git stash push -u -m "nasllm:<branch>"`, leaving ignored files like `node_modules`/`.env`/build caches in place), switches the folder, and pops the target branch's parked stash. On a pop conflict the stash is kept and a warning surfaced — edits are never silently lost. Session routes (`state`/`diff`/`revert`/`commit`/`create-pr`/`prs`/`merge-pr`/`changelog`/`ship`/`refresh`) operate on the folder directly; their `branch` param is accepted but ignored.

## HTML injection + cache-bust — READ THIS BEFORE EDITING THE RENDERER

`sidecar.rs:308-332` (`index_html`) reads `www/index.html`, injects a `<link>` for `desktop.css` before `</head>` and a `<script>` for `desktop.js` before `</body>`, then serves it. The `?v=` query strings on those URLs are **hardcoded literals in Rust source**:

- `desktop.css?v=22` — `sidecar.rs:317`
- `desktop.js?v=30` — `sidecar.rs:324`

(These numbers go stale on every bump; always re-read the lines before quoting them.)

**Editing `renderer/desktop.js` or `renderer/desktop.css` requires bumping the matching `?v=` constant inside `sidecar.rs`.** Without the bump, the WebView serves the old cached file and your change is invisible. The procedure:

1. Edit `renderer/desktop.js` (or `desktop.css`).
2. Open `src-tauri/src/sidecar.rs`, find the `index_html` function (~line 308).
3. Increment the `?v=` integer in the `desktop.js` (line ~324) or `desktop.css` (line ~317) `href`/`src` literal.
4. Rebuild — `cargo check` / `tauri dev` picks up the Rust change.

This is a cross-language coupling with no build-time check. The `www/` side has its own separate cache-bust locations (`www/index.html` for `styles.css`/`app.js`, plus `lib.js` versioned in an ES module import) — those are documented in `www/AGENTS.md`, not here.

## desktop.js section map

- `1-56` — Header, utilities (`$`, `sid`, `el`), **Ollama fetch shim**: rewrites `localhost:11434` calls to same-origin `/__ollama/*` before `app.js` runs.
- `58-110` — **toolExec SSE shim**: wraps `window.EventSource` so every stream gets a `toolExec` listener; on receipt, POSTs the tool call to `/__sidecar/repos/exec` and the observation back to `/api/conversations/:id/tool-response`. Dedupes by `jobId:step`.
- `112-253` — **Settings overlay**: `buildOverlay` assembles backend URL, magic-link sign-in, Ollama panel, updates section.
- `255-339` — **In-app updater UI** (`addUpdatesSection`): `tauriInvoke` for version/check/install; listens to `update://progress` events.
- `341-410` — **Tool execution** (`runToolExec`): approval-gated write tools; `AUTO_APPROVE_TOOLS` set at `:363` covers `write_file`/`edit_file`/`move_path`/`apply_patch`/`run_command`/`git_commit`/`git_push` (NOT `delete_path`/`create_pr`/`merge_pr` — those always prompt); `COMMAND_TOOLS` at `:367` renders a Warp-style block for all of these; threads `runCommandTimeoutMs` from the toolExec payload to the sidecar; posts observations to the backend.
- `412-553` — **Approval dialog**: FIFO queue (`pumpApprovalQueue`), reusable overlay re-wired per call, colored diff renderer (`renderDiff`).
- `555-574` — **Tauri IPC helpers** (`tauriInvoke`, `tauriListen`): the only IPC in the app; everything else is same-origin HTTP.
- `576-638` — **Native notifications** (job completion) + `pickFolder` (native directory picker via `plugin:dialog`).
- `640-736` — **Connect folder flow**: native pick → `/__sidecar/repos/scan-local` → single add or checklist picker. `scan-local` returns a `git` flag per candidate; a non-git candidate routes to the named-workspace flow (`createWorkspaceForPath`) instead of `add-local`.
- `738-776` — `dsConfirm` (replaces native `confirm()`).
- `778-829` — Workspace data helpers (`loadWorkspaceData`, `ensureWorkspaceFolder`).
- `831-1036` — **Branch rail + composer status line**: binds to the active repo-bound chat, polls `/__sidecar/repos/state` every 5s, renders `repo · ⎇ branch · ●N dirty · ↑a ↓b`, auto-approve + auto-sync toggle chips, Plan Pill (plan mode).
- `1038-1178` — `createWorkspaceChat` (was `createRepoChat`): registers workspace with backend, creates conversation, cuts an `agent/<slug>-<id>` branch (git workspaces only — skipped for `useGit=false`), enables file+git agent tools (file-only for non-git); `openBaseBranchPicker` starts a session from an existing branch. Tasks Pill (`ensureTasksPill`/`renderTasksPill`/`runTodoTool`) renders the agent-maintained checklist below the composer.
- `1180-1733` — **Repos overlay + local repo sidebar**: GitHub connect/browse/clone, local repo dropdown rows, `openBranchPicker` (repo folder switch), `openChatBranchPicker`/`switchChatBranch` (per-chat branch), `repoMenu` (⋯ actions), `refreshLocal`/`refreshGithub`, toasts.
- `1735-1800` — **Working changes panel**: cross-repo `git diff` + revert.
- `1802-1904` — **Ship wizard**: version + changelog + commit/push.
- `1906-2077` — **Session panel**: diff review, commit & push, open PR, revert, ship; Agent Merge toggle on the Merge tab (polls CI/reviews, auto-merges); Undo-last-write button for non-git workspaces.
- `2078-2119` — Sidebar "Workspaces" section injection into `#sidebar`; the "+" opens `openConnectMenu` (Connect git repo / New workspace…); `buildSidebarChatsHeader` injects the "Chats" label above `#convList`.
- `2121-2168` — First-load connect wizard (shown once when zero workspaces); offers both git and non-git.
- `openMyWork` — cross-workspace dashboard overlay (sessions, dirty/ahead, open PRs across all workspaces); header "My Work" button.
- `2170-2212` — Gear button placement (header when authed, fixed when on login view).
- `2214-2254` — `hookLogin`: paste-link box on the login card.
- `2256-2325` — `bootDesktop`: orchestrates all of the above on load; MutationObservers on `#app`/`#convList`; auto-starts Ollama.

## How www/ is consumed

`tauri.conf.json:7` sets `frontendDist` to `../../www`. `tauri.conf.json:25-28` bundles `../../www/` → `www/` and `../renderer/` → `renderer/` as Tauri resources. At runtime `main.rs:84-129` resolves the `www/` and `renderer/` directories through a cascade: `NASLLM_WWW`/`NASLLM_RENDERER` env vars → Tauri resource dir → `exe_relative_resource` fallback → compile-time `CARGO_MANIFEST_DIR` default (dev only).

**Editing `www/` affects the desktop app** — the sidecar serves the same files. See `www/AGENTS.md` for the web UI's own structure and its separate cache-bust locations.

## Release process

`desktop/README.md` documents versioning (three places: `package.json`, `tauri.conf.json`, `Cargo.toml`), signing keypair setup, and the tag-triggered release flow in full. `.github/workflows/desktop-release.yml` builds macOS + Windows on `v*` tags. Use `scripts/bump-desktop-version.sh patch|minor|major` to bump all three version files and tag in one step. Do not re-document the release flow here.
