# Desktop app — Phase 0: Tauri shell + NAS bridge (task list)

Source plan: `7cdbb501-88f9-4537-aab3-ae0c73186050` ("Desktop app — Copilot-style local-LLM codebase agent").

Goal: a Tauri 2 shell that embeds the existing `www/` chat UI and bridges it to the NAS backend (`chat.selected.systems`) via a local Rust sidecar — "the web app as a desktop app," validating WebView + session + `/api/*` proxying before anything new is built.

## Status: merged to main (PR #14); release binary built; login surface verified

## Merge & final build
- PR #14 (`feat/desktop-tauri-shell` → `main`) merged as `81a1d3b` (merge commit, branch deleted).
- Release binary: `desktop/src-tauri/target/release/nas-llm-desktop` (15 MB, optimized, `cargo build --release`).
- Re-verified the login surface on the release binary: sidecar up on 17543 (`authed:false`); login page injects `?v=2` assets; `desktop.js` contains the paste-link field (`dsLoginBox`/`dsLoginUrl`); `/api/auth/request` via the proxy returns 400 on an invalid email (proxy reaches the NAS auth endpoint); `/__sidecar/verify` SSRF-guards a mismatched host. App left running for the manual GUI paste-click.

## Runtime verification (initial)
Launched the built binary headlessly and probed the sidecar HTTP surface — all green, no panics:
- Sidecar starts: `nas-llm sidecar listening at http://127.0.0.1:17543`.
- `/__sidecar/health` → `{"ok":true}`; `/__sidecar/state` → `{backend_url, origin, authed:false, email:null}`.
- `/` injects the desktop bridge (1 occurrence of `__sidecar/desktop.js`).
- Static assets 200 + correct content-type: `/app.js`, `/styles.css`, `/vendor/marked.esm.js`, `/__sidecar/desktop.js`.
- `/api/auth/me` via the reverse proxy → **401** (the bridge reaches the NAS backend end-to-end; auth gate intact).

## Runtime fixes (found by running it)
1. `tokio::net::TcpListener::from_std` was called in `main()` before the Tauri runtime existed → panic "there is no reactor running". Moved the `from_std` into the `setup()` task spawned on the Tauri async runtime; the std bind stays early so the port is known before the window URL is built.
2. `axum = "0.7"` (matchit 0.7) rejects the `/api/{*path}` catch-all (that's axum 0.8 syntax) → panic "catch-all parameters are only allowed at the end of a route". Changed to the 0.7 syntax `/api/*path`.
3. (build-time) reqwest 0.12 has no `client`/`http` features; pinned `features = ["json", "stream", "rustls-tls"]`. `frontendDist`/`default_www()` pointed at `../../www`; added a placeholder `icons/icon.png` for `generate_context!`.

## Tasks
- [x] Scaffold Tauri 2 project files (`desktop/package.json`, `src-tauri/Cargo.toml`, `build.rs`, `tauri.conf.json`, `capabilities/main.json`, `.gitignore`).
- [x] Rust sidecar: axum server serving `www/` (injected `index.html`) + reverse-proxy `/api/*` → NAS backend with a persisted cookie jar (sidesteps the `Secure` cookie over http problem), Set-Cookie capture, SSE streaming, `Location` rewrite.
- [x] Sidecar control plane `/__sidecar/*` (`health`, `state`, `backend`, `test`, `verify`, `logout`) + `desktop.js`/`desktop.css` asset routes; `config.json` + `session.json` in the OS app-data dir; SSRF host guard on `verify`.
- [x] Tauri entry (`main.rs`): bind `127.0.0.1:<port>`, build `AppState`, spawn `axum::serve` on the Tauri async runtime, create the main window at runtime pointing at the sidecar origin.
- [x] Desktop bridge renderer (`desktop.js`/`desktop.css`): settings overlay (backend URL + test + paste-link sign-in + logout), gear button in the header, login-view hint — non-invasive to `www/app.js`; talks to `/__sidecar` over same-origin HTTP.
- [x] Validate JS (`node --check`) + JSON; write `desktop/README.md` (rustup + `xcode-select` prerequisites, run/build); flag Rust compile pending toolchain install.

## Notes
- Rust toolchain installed via rustup (minimal profile, no shell-profile change); `cargo check` is clean (no errors/warnings). A full `cargo build`/`tauri dev` (codegen + link) is the next step and may require `xcode-select --install` for the linker.
- `reqwest` pinned to `default-features = false, features = ["json", "stream", "rustls-tls"]` (no `client`/`http` features — those aren't reqwest 0.12 features).
- `frontendDist` is `../../www` (repo `www`, not `desktop/www`); `default_www()` mirrors that.
- Placeholder `src-tauri/icons/icon.png` (1×1) satisfies `generate_context!`; real icons via `tauri icon` in Phase 5.
- Local-LLM auto-connect (Ollama lifecycle / `localhost:11434` proxy) is deferred to Phase 1 per the plan; NAS/remote models work now via the proxy.
