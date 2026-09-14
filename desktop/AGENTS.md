# desktop/ — Tauri 2 desktop shell

A Tauri 2 app that wraps the shared `www/` chat UI and proxies to the NAS backend through a local Rust sidecar. The renderer is an **additive layer** on top of `www/` — it never replaces or forks `www/app.js`; it injects one `<script>` and one `<link>` and shims `fetch`/`EventSource` at runtime.

For repo-wide conventions (branch model, commit style, verification loop, do-not-run scripts) see the root `AGENTS.md`.

## Layout

- `package.json` — npm scripts only: `npm run desktop` = `tauri dev`, `npm run desktop:build` = `tauri build`. Deps: `@tauri-apps/cli` + `@tauri-apps/api`.
- `renderer/desktop.js` (~2325 lines) — the entire desktop bridge: settings overlay, paste-link sign-in, Ollama panel, GitHub/repos UI, approval dialogs, branch rail, in-app updater UI. Served at `/__sidecar/desktop.js`.
- `renderer/desktop.css` (~417 lines) — self-contained dark styles for the bridge (`.ds-*` classes). No dependency on the app's CSS variables.
- `src-tauri/src/main.rs` — entry point: binds a localhost port, resolves `www/` + `renderer/` resource paths, spawns the sidecar on the Tauri async runtime, creates the WebView window at the sidecar origin.
- `src-tauri/src/sidecar.rs` — the axum HTTP server: serves `www/`, exposes `/__sidecar/*` control plane, reverse-proxies `/api/*` to the NAS, proxies `/__ollama/*` to local Ollama. Holds the session cookie jar.
- `src-tauri/src/github.rs` — GitHub token storage (macOS Keychain via `keyring`), repo clone/pull/branch/exec/commit/PR operations, `/__sidecar/github/*` and `/__sidecar/repos/*` routes.
- `src-tauri/src/updater.rs` — three `#[tauri::command]`s (`app_version`, `check_for_updates`, `download_and_install_update`) wrapping `tauri-plugin-updater` so the renderer uses IPC, not plugin capabilities.
- `src-tauri/tauri.conf.json` — no static window (`windows: []`); `frontendDist` is `../../www`; bundles `../../www/` and `../renderer/` as resources; CSP is null; updater endpoint + pubkey configured.
- `src-tauri/capabilities/main.json` — permissions for the runtime-created `main` window. `remote.urls` allows `http://127.0.0.1:*` (the sidecar origin) so plugin commands work from the sidecar-loaded page.

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

GitHub/repos routes are in `github.rs:2541-2568` (merged into the same axum app at `main.rs:148`): `/__sidecar/github/{status,connect,disconnect,repos}` and `/__sidecar/repos/{local,add-local,scan-local,clone,refresh,open,exec,diff,revert,changelog,ship,set-folder,branch,create-branch,state,branches,checkout,commit,create-pr,worktree}`.

## HTML injection + cache-bust — READ THIS BEFORE EDITING THE RENDERER

`sidecar.rs:308-332` (`index_html`) reads `www/index.html`, injects a `<link>` for `desktop.css` before `</head>` and a `<script>` for `desktop.js` before `</body>`, then serves it. The `?v=` query strings on those URLs are **hardcoded literals in Rust source**:

- `desktop.css?v=19` — `sidecar.rs:317`
- `desktop.js?v=24` — `sidecar.rs:324`

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
- `341-410` — **Tool execution** (`runToolExec`): approval-gated write tools; `AUTO_APPROVE_TOOLS` set at `:363`; posts observations to the backend.
- `412-553` — **Approval dialog**: FIFO queue (`pumpApprovalQueue`), reusable overlay re-wired per call, colored diff renderer (`renderDiff`).
- `555-574` — **Tauri IPC helpers** (`tauriInvoke`, `tauriListen`): the only IPC in the app; everything else is same-origin HTTP.
- `576-638` — **Native notifications** (job completion) + `pickFolder` (native directory picker via `plugin:dialog`).
- `640-736` — **Connect folder flow**: native pick → `/__sidecar/repos/scan-local` → single add or checklist picker.
- `738-776` — `dsConfirm` (replaces native `confirm()`).
- `778-829` — Workspace data helpers (`loadWorkspaceData`, `ensureWorkspaceFolder`).
- `831-1036` — **Branch rail + composer status line**: binds to the active repo-bound chat, polls `/__sidecar/repos/state` every 5s, renders `repo · ⎇ branch · ●N dirty · ↑a ↓b`, auto-approve toggle chip.
- `1038-1178` — `createRepoChat`: registers repo with backend, creates conversation, cuts an `agent/<slug>-<id>` branch, enables file+git agent tools, navigates without reload.
- `1180-1733` — **Repos overlay + local repo sidebar**: GitHub connect/browse/clone, local repo dropdown rows, `openBranchPicker` (repo folder switch), `openChatBranchPicker`/`switchChatBranch` (per-chat branch), `repoMenu` (⋯ actions), `refreshLocal`/`refreshGithub`, toasts.
- `1735-1800` — **Working changes panel**: cross-repo `git diff` + revert.
- `1802-1904` — **Ship wizard**: version + changelog + commit/push.
- `1906-2077` — **Session panel**: diff review, commit & push, open PR, revert, ship.
- `2078-2119` — Sidebar "Repos" section injection into `#sidebar`.
- `2121-2168` — First-load connect wizard (shown once when zero repos).
- `2170-2212` — Gear button placement (header when authed, fixed when on login view).
- `2214-2254` — `hookLogin`: paste-link box on the login card.
- `2256-2325` — `bootDesktop`: orchestrates all of the above on load; MutationObservers on `#app`/`#convList`; auto-starts Ollama.

## How www/ is consumed

`tauri.conf.json:7` sets `frontendDist` to `../../www`. `tauri.conf.json:25-28` bundles `../../www/` → `www/` and `../renderer/` → `renderer/` as Tauri resources. At runtime `main.rs:84-129` resolves the `www/` and `renderer/` directories through a cascade: `NASLLM_WWW`/`NASLLM_RENDERER` env vars → Tauri resource dir → `exe_relative_resource` fallback → compile-time `CARGO_MANIFEST_DIR` default (dev only).

**Editing `www/` affects the desktop app** — the sidecar serves the same files. See `www/AGENTS.md` for the web UI's own structure and its separate cache-bust locations.

## Release process

`desktop/README.md` documents versioning (three places: `package.json`, `tauri.conf.json`, `Cargo.toml`), signing keypair setup, and the tag-triggered release flow in full. `.github/workflows/desktop-release.yml` builds macOS + Windows on `v*` tags. Use `scripts/bump-desktop-version.sh patch|minor|major` to bump all three version files and tag in one step. Do not re-document the release flow here.
