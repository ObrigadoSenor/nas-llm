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
