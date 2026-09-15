# nas-llm desktop

A Tauri 2 shell that embeds the existing `www/` chat UI and bridges it to the
NAS backend (`chat.selected.systems`) through a local Rust **sidecar**. This is
Phase 0 of the desktop app plan: "the web app as a desktop app," validating the
WebView + session + `/api/*` bridge before git/codebase features are added.

## How it works

```
Tauri window (WebView, origin http://127.0.0.1:<port>)
  └─ sidecar (src-tauri/src/sidecar.rs) — an axum HTTP server on 127.0.0.1
       ├─ GET  /                  → www/index.html (desktop bridge injected)
       ├─ GET  /<asset>           → served from ../../www (traversal-guarded)
       ├─ ANY  /api/*path         → reverse-proxied to the NAS backend
       └─ *    /__sidecar/*       → control plane + desktop.js/desktop.css
```

The NAS sets a `Secure; HttpOnly; SameSite=Lax` session cookie that a WebView on
an `http://127.0.0.1` origin will **not** store. So the sidecar holds the session
cookie itself (a persisted cookie jar) and attaches it to every proxied `/api/*`
request; `Set-Cookie` responses from the backend update the jar. The renderer
never holds the NAS cookie — auth flows through the sidecar. This keeps
`www/app.js` (which uses relative `/api/*` URLs, SSE `/events`, etc.) completely
unchanged.

### Signing in (magic link)

The web app's magic-link email points at the public NAS URL, which the desktop
WebView can't capture a cookie from. So the desktop bridge adds a paste-link
flow: click **Send link** in the app, then open **⚙ Desktop settings → Sign in**
and paste the verify URL from the email. The sidecar fetches it (SSRF-guarded to
the configured backend host), captures the session cookie into its jar, and
reloads — you're signed in.

## Prerequisites

1. **Rust** (stable) — install via [rustup](https://rustup.rs) (minimal profile
   is enough; pass `--no-modify-path` if you don't want it to touch your shell
   rc files, then source `$HOME/.cargo/env` as needed):
   ```sh
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --no-modify-path
   . "$HOME/.cargo/env"   # or reopen your shell
   ```
2. **macOS system deps:** `xcode-select --install` is needed *only if* the
   first `cargo build` fails at the link step with a missing C toolchain — on
   this machine the link succeeded without it. **Windows:** see the
   [Tauri prerequisites](https://tauri.app/start/prerequisites/) (WebView2 +
   MSVC build tools).
3. **Node.js** — for the Tauri CLI (`npm install` pulls `@tauri-apps/cli` +
   `@tauri-apps/api`).

## Run (dev)

```sh
cd desktop
npm install        # ~13 packages; installs @tauri-apps/cli + api
npm run desktop    # = tauri dev
```

`tauri dev` builds the Rust binary and opens the window at the sidecar origin
(`http://127.0.0.1:17543` by default). The first build downloads many crates
and links (~25s after the crate cache is warm; several minutes cold).

### Local code-signing (dev)

`tauri dev` runs the raw debug binary, which macOS ad-hoc-signs fresh on every
rebuild. The GitHub token lives in the Keychain, whose access ACL keys off the
app's code signature — so each rebuild looks like a stranger and macOS prompts
for your keychain password on every launch. To stop that, sign the debug binary
with a stable self-signed identity (local dev only; this does not affect
bundle/CI signing):

1. **One-time** — create the identity in your login keychain:

   ```sh
   bash desktop/scripts/setup-codesign.sh
   ```

   macOS may prompt once to let `codesign` use the new key — click **Always
   Allow**.

2. **Persist the identity name** in your shell rc (`~/.zshrc`):

   ```sh
   export NASLLM_CODESIGN_ID=nas-llm-dev
   ```

3. **Launch dev with signing** instead of plain `npm run desktop`:

   ```sh
   cd desktop
   npm run desktop:signed
   ```

   `desktop:signed` (`scripts/dev.sh`) wires `scripts/codesign-linker.sh` in as
   the cargo linker for the build, which re-signs the
   `target/debug/nas-llm-desktop` executable after every link. `tauri dev`'s
   auto-rebuild and devtools are unchanged.

The first launch still prompts once for the GitHub-token keychain item — click
**Always Allow**. Subsequent rebuilds and relaunches no longer prompt. Plain
`npm run desktop` and `make check-desktop` are untouched (the wrapper is a
no-op passthrough when `NASLLM_CODESIGN_ID` is unset).

If `setup-codesign.sh` fails on your machine, create the certificate by hand:
**Keychain Access → Certificate Assistant → Create a Certificate…**, name it
`nas-llm-dev`, identity type *Self-Signed Root*, certificate type *Code Signing*.

### Configuration

- **Backend URL:** ⚙ Desktop settings → NAS backend URL (default
  `https://chat.selected.systems`), persisted to
  `<app-data>/nas-llm-desktop/config.json`.
- **Sidecar port:** defaults to `17543`; auto-increments if busy. Set a preferred
  port in `config.json` (`"port": 17543`).
- **Override asset paths** (useful when running the binary outside `tauri dev`):
  `NASLLM_WWW=/path/to/www` and `NASLLM_RENDERER=/path/to/desktop/renderer`.

## Verify the bridge (headless)

You can confirm the sidecar works without opening a window — build the binary
and probe its HTTP surface (run from the repo root):

```sh
. "$HOME/.cargo/env"
cd desktop/src-tauri && cargo build
BIN=target/debug/nas-llm-desktop
RUST_LOG=info NASLLM_WWW=../../www NASLLM_RENDERER=../renderer "$BIN" >/tmp/nasllm.log 2>&1 &
PORT=$(sed -nE 's/.*127\.0\.0\.1:([0-9]+).*/\1/p' /tmp/nasllm.log | head -1)
curl -s http://127.0.0.1:$PORT/__sidecar/health   # {"ok":true}
curl -s http://127.0.0.1:$PORT/__sidecar/state     # {backend_url, origin, authed, email}
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:$PORT/api/auth/me  # 401
kill %1
```

`/api/auth/me` returning **401** means the proxy reaches the NAS backend
end-to-end and the auth gate is intact. A full UI sign-in needs the window
(`npm run desktop`) plus the paste-link flow below.

## Project layout

```
desktop/
  package.json              Tauri CLI + API deps
  renderer/
    desktop.js              Desktop bridge (settings overlay, paste-link sign-in)
    desktop.css             Bridge styles (self-contained dark UI)
  src-tauri/
    Cargo.toml              Rust deps (tauri 2, axum, reqwest, tokio, …)
    build.rs                tauri-build
    tauri.conf.json         No static window (created at runtime); global Tauri; no CSP
    capabilities/main.json  Core permissions for the main window
    src/
      main.rs               Bind port, spawn sidecar, create window at sidecar origin
      sidecar.rs            axum server: www/ + /api/* proxy + /__sidecar control plane
```

## Versioning & updates

The app version lives in three places that must stay in sync: `package.json`,
`src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`. Use the bump helper so
they never drift. Pick the bump level by what changed:

- **patch** — bug fixes / small non-breaking changes
- **minor** — new backward-compatible features
- **major** — breaking changes

### One-time setup (signing)

Auto-update verifies each bundle against a Tauri signing keypair. Do this once:

1. Generate a keypair:
   ```sh
   cd desktop
   npx tauri signer generate -w ~/.tauri/nas-llm.key
   ```
2. Paste the printed **public key** into `src-tauri/tauri.conf.json`
   (`plugins.updater.pubkey`, replacing `REPLACE_WITH_TAURI_UPDATER_PUBKEY`).
   Commit it — the public key is not secret.
3. Add the **private key + password** as GitHub repo secrets
   `TAURI_PRIVATE_KEY` and `TAURI_KEY_PASSWORD` (repo Settings → Secrets and
   variables → Actions → New repository secret).

Until these are set, CI builds are unsigned and in-app updates won't verify.
macOS code-signing + notarization is optional: uncomment the `APPLE_*` env in
`.github/workflows/desktop-release.yml` and add those secrets.

### Triggering a release

From a clean `main` with your changes committed:

1. Bump the version — the helper edits all three files, commits `Release vX.Y.Z`,
   and tags `vX.Y.Z` (it does **not** push anything):
   ```sh
   scripts/bump-desktop-version.sh patch   # or minor / major
   ```
2. Push the tag (and the `main` commit, if not already pushed) to start the
   publish workflow:
   ```sh
   git push origin main
   git push origin vX.Y.Z
   ```

`.github/workflows/desktop-release.yml` then builds and signs macOS (`.dmg` +
`.app`) and Windows (`.msi` + `.exe`) bundles, creates the GitHub Release for
the tag, and uploads a combined `latest.json` updater manifest as a release
asset. The release **notes are generated automatically from the commit
subjects since the previous tag** — write clear commit messages and they
become the in-app changelog. To hand-write notes instead, edit the GitHub
Release body and re-run the workflow (it rewrites `latest.json` from the
current release body).

Manual dispatch (no tag push): run the workflow from the **Actions** tab with
the `tag` input set to the version to publish, e.g. `v0.2.0`.

### Checking for updates (in-app)

Open **⚙ Desktop settings → Updates** to see the current version, click
**Check for updates** to fetch the latest release and its notes, and click
**Update to latest** to download, install, and relaunch. The app verifies the
download against the pubkey in `tauri.conf.json` before installing.

## Repo → agent chat → commit/push/PR (the workflow)

The sidebar **Repos** section is the entry point. Connect a local git repo with
**+** (folder picker; a parent dir with several repos yields a checklist). Each
connected repo is a workspace with **Pull**, **Ship** (versioned release), and
**+ New chat**.

**+ New chat** starts an agent work session against that repo on its **own
branch** so `main` is never dirtied:
- The sidecar cuts a fresh `agent/<repo>-<id>` branch from the repo's default
  branch and stores `repo_branch` on the conversation. No git worktree is
  provisioned upfront — a new chat is just a branch from main. When the repo
  folder is clean the folder is switched onto that branch (so the chat's tools
  run there directly); when the folder is dirty the branch is created without
  switching, and the chat's tool calls lazily provision an **isolated git
  worktree** — so another chat's or your uncommitted edits are never carried
  onto the new branch, and two chats on two branches stay isolated. The `<id>`
  suffix is a slice of the conversation id, so two chats on one repo never
  collide. The new chat appears under its repo in the sidebar the moment it's
  created (the dropdown auto-expands), not only after you send the first
  message. If branch creation fails you get the git error and a choice to
  continue on the repo folder's current branch instead — nothing is forced.
- The chat is titled `owner/repo (agent <id>)` with that same `<id>`, so chats on
  one repo are tellable apart in the sidebar — and so the approval dialog and the
  completion notification, which both name the chat, actually identify it. The
  chat you're viewing is highlighted in the sidebar repo dropdown. Rename it
  whenever you like; a rename sticks and nothing overwrites it.
- A small **status line** below the input field shows the repo, branch, and git
  state (`owner/repo · ⎇ branch · ●N dirty · ↑a ↓b`, plus `no remote` when there
  isn't one) while a repo-bound chat is open — polled every few seconds and
  refreshed after each tool call. Click it to open the **session panel**; click
  the **⎇ branch chip** to change which branch this chat works on.
- Agent edits arrive as `apply_patch`/`run_command` calls, each shown in an
approval dialog prefixed with the asking chat and `tool → owner/repo @ branch`,
so you see which chat wants to write and where before approving. Approvals from
different chats queue up one at a time rather than fighting over one dialog.

**Finishing the work** — from the session panel (or per-repo ⋯):
- **Commit** / **Commit & push** — plain `git add -A` + commit (+ optional push);
no version/CHANGELOG ceremony. Push is disabled when the repo has no remote.
- **Open PR** — pushes the head branch and opens a GitHub pull request (head =
the chat's `agent/<slug>`, base = the repo's default branch) via the stored
keychain token; returns the PR URL. Only for `github.com` repos with a token.
- **Ship** — the existing versioned release flow (version + CHANGELOG + push).
- **Revert** — `git checkout -- . && git clean -fd` to undo agent edits.

The agent can also finish the loop itself: `git_commit`, `git_push`, and
`create_pr` are agent tools (each approval-gated, same dialog). They're
auto-enabled for repo-bound chats.

### Several chats at once

Chats run in parallel. Starting a second chat does not stop the first, and
switching away from a running chat — or reloading the app — leaves it running:

- The chat you are looking at streams over its own SSE tail; every other running
  chat is driven by a single multiplexed `GET /api/events` stream. Two
  connections total, however many agents are going. (This matters: the sidecar
  speaks HTTP/1.1 on localhost and the WebView caps connections per origin, so
  one stream per chat would starve ordinary API calls.)
- A chat using a **local** model, or any repo-bound chat, needs the app to relay
  work — so if every stream drops, the backend waits out a grace period
  (`BROWSER_RELAY_GRACE`, 45 s) before cancelling. Switching chats and reloading
  are well inside it; quitting the app cleans the run up.
- Local-model chats genuinely run at the same time, because inference happens on
  this machine. Chats on NAS/Mac models still take turns, because those hosts run
  with `OLLAMA_NUM_PARALLEL=1` — they queue rather than fail.

### A branch per chat

Each chat is pinned to a branch (`repo_branch`), and every tool call it makes is
executed against **that** branch — not whatever the repo happens to be on:

- If the chat's branch is the one checked out in the repo folder, tools run
  there, exactly as before — no worktree is involved.
- Otherwise the sidecar lazily provisions a **git worktree** for that branch
  under `<app-data>/nas-llm-desktop/worktrees/<repo>/<branch>` and runs there.
  Git allows a branch in at most one worktree, which is what keeps two chats on
  two branches from treading on each other. This happens on the first tool call
  that needs it, not when the chat is created.
- Change a chat's branch any time with the **⎇ chip** under the input: pick an
  existing branch or create a new one. A clean folder is switched onto the
  chosen branch; a dirty folder is left untouched and the chat runs in an
  isolated worktree instead, so other chats' branches are never disturbed.
- The per-repo **⋯ → Branch…** picker is unchanged and still switches the repo
  folder itself — that is the tree you have open in your editor.

**Isolated worktrees start clean.** A worktree created for a dirty-folder chat
contains tracked files only: no `node_modules`, no `.env`, no build caches. The
first `run_command` in it may need an install step. Remove ones you are done
with via `git worktree remove <path>` (or `git worktree prune` after deleting by
hand).

**Chats created before this change** share one `agent/<slug-of-title>` branch,
because the old naming derived from the chat title and every chat on a repo was
titled exactly `owner/repo (agent)`. They keep working as they always did;
re-point any with the ⎇ chip to give it a branch of its own, and rename them if
you want them tellable apart.

### Notifications

When a chat finishes work you are not watching, the app raises a native
notification ("Chat finished" / "Chat cancelled" / "Chat failed" plus the chat
title) and marks the chat in the sidebar; the badge clears when you open it.
macOS asks for notification permission the first time. Nothing fires for the
chat that is on screen while the window is focused — you can already see it.

## Notes / out of scope for Phase 0

- **Local LLMs (Ollama on this machine):** managed. The sidecar auto-starts an
  installed Ollama on app boot and proxies `localhost:11434` at same-origin
  `/__ollama/*` (a `fetch` shim in `desktop.js` rewrites the web UI's direct
  localhost calls), so local models appear in the picker with no
  `OLLAMA_ORIGINS` setup and no WebView CORS/CSP issues. ⚙ Desktop settings →
  Ollama shows status and Start/Stop. (macOS: app or Homebrew CLI; Windows
  lifecycle is a follow-up.)
- **Rust is compile- and runtime-validated** (`cargo build` clean; the sidecar was probed headlessly — control plane, static assets, index injection, and the `/api/*` proxy to the NAS all work). A real `tauri dev` launch (which also opens the WebView window) is the remaining manual check; run `npm run desktop`.
- **macOS bundle built**: `npx tauri build` produces `nas-llm.app` + `nas-llm_0.1.0_aarch64.dmg` (4.9 MB) in `src-tauri/target/release/bundle/`. Unsigned (for local testing); sign + notarize by setting `APPLE_SIGNING_IDENTITY` / `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` secrets in CI.
- **Windows builds via CI**: a Windows `.msi`/`.exe` can't be cross-compiled from macOS. `.github/workflows/desktop-release.yml` builds both platforms on a `v*` tag push or manual dispatch — macOS produces `.dmg`+`.app`, Windows produces `.msi`+`.exe` — and publishes them to a GitHub Release with a `latest.json` updater manifest (see Versioning & updates above).
- **Icons** are generated: `npx tauri icon src-tauri/icons/icon-source.png` produces `.icns`, `.ico`, and all PNG sizes in `src-tauri/icons/`. Regenerate with a new 1024×1024 source if you want a different look.
- **Signing/notarization**: updater signing is wired (one-time keypair setup — see Versioning & updates). macOS code-signing + notarization is still optional; set the `APPLE_*` secrets and uncomment the env block in `.github/workflows/desktop-release.yml` to enable it.
