# nas-llm — task list

Project: expose a self-hosted LLM on the UGREEN DXP2800 as a single secure
public OpenAI-compatible API at `https://llm.selected.systems`, called by a
browser extension, with no router ports opened. No web UI, no user accounts;
model management via `ollama` CLI over SSH.

## Phase 1 — Prepare the NAS ✅
- [x] Install Docker from UGOS Pro App Center > Docker (v26.1.0 + compose v2.26.1)
- [x] Grant read/write on the `docker` shared folder (added ObrigadoSenor to `docker` group)
- [x] Enable SSH (Control Panel > Terminal) — key-based auth configured
- [x] `df -h` → NVMe (Kingston 1.8T) is `/volume1`; SATA WD Red (931G) is `/volume2`
- [x] Created `/volume1/docker/nas-llm/{ollama,caddy/data,caddy/config}` on the NVMe

## Phase 2 — Deploy Ollama + Caddy (LAN only)
- [x] Author `docker-compose.yml` (ollama has no `ports:`, caddy `:8080`, cloudflared behind `tunnel` profile)
- [x] Author `Caddyfile` (preflight bypass, bearer check, `/v1/*` allowlist, Host rewrite, strip Origin, `flush_interval -1`)
- [x] Author `scripts/deploy.sh`, `scripts/pull-models.sh`, `scripts/smoke-test.sh`
- [x] Fill `.env` (NAS_HOST, NAS_USER, DOCKER_VOLUME, API_BEARER_TOKEN via openssl rand -hex 32)
- [x] `scripts/deploy.sh` (LAN mode: ollama + caddy) — switched to tar-over-SSH (UGOS rsync wrapper rejects /volume1/docker); fixed `--profile` ordering for compose v2.26
- [x] `scripts/smoke-test.sh` — 8/8 passed (unauth 401, auth 200, OPTIONS 204 + CORS, `/api/delete` 404, 11434 unreachable)
- [x] Confirmed 11434 not published/reachable from the Mac

## Phase 3 — Pull + benchmark a model ✅
- [x] Migrated existing models (no re-download): llama3.2:latest, deepseek-r1:1.5b, deepseek-r1:8b (7.8G) onto the NVMe volume
- [x] Measured real tokens/sec: **9.64 tok/s** (96 tokens / 9.96s; model load 5.4s, first byte 1.48s) — within the predicted ~5–10 band
- [x] Tuned via compose env: `OLLAMA_CONTEXT_LENGTH=16384`, `MAX_LOADED_MODELS=1`, `NUM_PARALLEL=1`, `KEEP_ALIVE=24h`
- [x] Re-ran the streaming smoke test (200) via the public endpoint

## Phase 4 — Migrate DNS + build the tunnel ✅
- [x] Snapshotted `selected.systems` (4 apex A, `www`→ext-sq, Brevo TXT, DMARC→Brevo; no MX/DNSSEC/CAA)
- [x] User added zone to Cloudflare + grey-clouded Squarespace records + switched nameservers
- [x] User created named tunnel + public hostname `llm.selected.systems` → `http://caddy:8080`
- [x] TUNNEL_TOKEN loaded into `.env`; `deploy.sh` started cloudflared (precheck PASS, QUIC)
- [x] Public endpoint verified via Cloudflare edge (`--resolve`): 401/200/204+CORS/404/200 — DNS resolves to 104.21.14.106, 172.67.158.165

## Phase 5 — Lock down the endpoint ✅
- [x] Confirmed Caddy `/v1/*` allowlist + 404 for everything else (verified on public path)
- [x] Cloudflare WAF rate-limit rule active: `(http.host eq "llm.selected.systems")`, 10 req / 10s per IP, Block 60s — verified by 30-request burst (#1–10 = 401 origin, #11–30 = 429 edge-blocked)
- [x] Do NOT enable Cloudflare Access (breaks extension `fetch()`)

## Phase 6 — Validate from off-network (user-driven)
- [x] Public-path smoke test from the Mac via Cloudflare edge (`--resolve`): 7/7 — 401 unauth, 200 auth, 204+CORS preflight, 404 `/api/delete`, 200 streaming (port-11434 check skipped, already verified on LAN)
- [ ] `ENDPOINT=https://llm.selected.systems scripts/smoke-test.sh` over **cellular** (true off-network — user, phone)
- [ ] Real `fetch()` from the unpacked extension works end to end (user)

## Phase 7 — Operational hardening
- [ ] (Optional) drop `ports: 8080:8080` now that cloudflared reaches Caddy internally
- [ ] Add a UGOS backup task for the ollama + caddy data directories
- [ ] Document key-rotation procedure (in README) — done
- [ ] (Future) pin `EXTENSION_ORIGIN` before publishing the extension

## Chat UI (added post-plan) ✅
- [x] `www/index.html` — minimal streaming chat page, token in localStorage
- [x] Caddyfile: `http://chat.selected.systems:8080` site block serving static files (keeps API host pure; `http://` scheme disables auto-HTTPS so :8080 stays plain HTTP for cloudflared)
- [x] www/ mounted into caddy + synced by deploy.sh; Caddyfile + compose validated
- [x] User added `chat.selected.systems` → `http://caddy:8080` as a second public hostname on the tunnel (orphan DNS record removed first)
- [x] Deployed + verified: `https://chat.selected.systems/` returns 200 + HTML through the edge; `https://llm.selected.systems/v1/models` still 401 (API host pure)

## Phase 8 — Chat login + server-side history (backend) 🚧
- [x] Plan approved: magic-link auth, Go backend, SQLite on NVMe, page calls same-origin /api/*
- [x] `backend/` Go service (main, store, auth, email, handlers) + multi-stage Dockerfile (static binary, CGO off, modernc.org/sqlite)
- [x] `docker-compose.yml`: `backend` service (:8081, no ports, internal network, SQLite volume); caddy depends_on backend
- [x] `Caddyfile`: chat host routes `/api/*` → `backend:8081` (flush_interval -1), else serves `www/`; API host untouched
- [x] `.env.example`: SESSION_SECRET, BREVO_API_KEY, APP_BASE_URL, MAIL_FROM, ALLOWED_EMAILS
- [x] `scripts/deploy.sh`: sync `backend/`, mkdir `backend/data`, `up -d --build`
- [x] `scripts/smoke-test.sh`: chat `/api/auth/me` + `/api/models` → 401 without session
- [x] `www/index.html`: magic-link login screen, auth/me gate, sidebar history, same-origin /api/* with session cookie, persist after each turn
- [ ] User: set SESSION_SECRET + BREVO_API_KEY + ALLOWED_EMAILS in `.env`; verify MAIL_FROM is a Brevo-verified sender
- [ ] Deploy + browser test: request magic link, sign in, create chats across models, reload / second device → history resumes; delete + logout work
- [ ] (Optional) Cloudflare WAF rate-limit rule on `chat.selected.systems` (mirror the llm host rule)

## Phase 9 — Chat UI: folders, rename, timestamps, mobile drawer ✅
- [x] Backend `store.go`: `folders` table + `conversations.folder_id` / `title_custom` columns; idempotent `migrate()` (PRAGMA table_info) upgrades existing DBs in place; `Folder` struct, `Message.Ts`, `Conversation.FolderID`/`TitleCustom`
- [x] Backend store methods: `listFolders`/`createFolder`/`renameFolder`/`deleteFolder` (delete unassigns chats, never deletes them); `patchConversation` (title → title_custom=1, folderId "" → NULL, model); `updateConversation` now preserves a custom title across per-turn saves; list/get return folderId + titleCustom
- [x] Backend handlers + routes: `GET/POST/PUT/DELETE /api/folders[/:id]`, `PATCH /api/conversations/{id}` (Caddy `/api/*` passes PATCH through; same-origin so no preflight)
- [x] Frontend `www/index.html`: sidebar groups chats by folder with collapsible headers (state in localStorage) + an "Unsorted" group; new / rename / delete folder; per-chat `⋯` menu (Rename, Move to ▶, Delete)
- [x] Frontend rename: inline `<input>` on the row title; Enter/blur saves via PATCH, Esc cancels
- [x] Frontend timestamps: each new user/assistant message gets `ts=Date.now()`; `addMsg` renders an absolute timestamp by the role label; header shows the active chat's last-updated time; sidebar shows compact absolute time (today→HH:MM, this year→Sep 9, older→Sep 9, 2024) with the relative string as tooltip. Legacy messages have no ts and show none.
- [x] Frontend mobile drawer: `☰` toggles open/close, `✕` button + scrim + Escape close, "+ New chat" and selecting a chat close it, body scroll locked while open
- [x] Validated: backend Docker build (`go build`) clean; frontend JS `node --check` clean
- [ ] User: redeploy via `scripts/deploy.sh` (new backend binary + static page); browser-test folders/rename/timestamps/drawer on mobile + desktop

## Phase 10 — Web search (SearXNG + backend tool loop) 🚧
- [x] Plan approved (revised after Phase 8–9): extend the existing Go backend's `handleChat` with the web_search tool loop — no new service, no Caddyfile change; chat-UI feature on the chat.selected.systems path (pure-API host untouched, extension unaffected)
- [x] `searxng/settings.yml` — internal-only meta-search: `search.formats` includes `json` (off by default), `server.limiter: false`, small engine set (google/bing/duckduckgo), placeholder `secret_key`
- [x] `docker-compose.yml`: `searxng` service (pinned `2026.9.8-3fdc6d753`, no ports, internal network, file-mounted settings); `backend` gets `SEARXNG_URL` env + `depends_on: searxng`
- [x] `backend/search.go`: `web_search` tool + system nudge; non-streaming tool-calling rounds vs Ollama (`role: "tool"` + `tool_call_id`, not `tool_use_id`), SearXNG JSON via `http://searxng:8080/search`, top 5 / ~300-char snippets, max 3 rounds; streams the final answer as OpenAI SSE with 5s `: searching…` keepalive comments (dodges Cloudflare 524); flag off → unchanged streaming passthrough; empty `SEARXNG_URL` → graceful passthrough
- [x] `backend/handlers.go` `handleChat`: peeks `web_search` in the body, branches (passthrough vs `handleChatWithSearch`); `backend/main.go` config gains `searxngURL`
- [x] `www/index.html`: 🌐 toggle (localStorage `nas-llm-search`) sends `web_search` in the `/api/chat/completions` body; surfaces keepalive comments as a `🔍 searching the web…` hint
- [x] `.env.example`: `SEARXNG_URL=http://searxng:8080` (empty = disable, graceful passthrough)
- [x] `scripts/deploy.sh`: tar list gains `searxng/`; `scripts/smoke-test.sh`: internal SearXNG JSON check (from the backend container, LAN only — the full tool loop needs a session + a pulled model, so it's a manual browser test)
- [x] Validated locally: `go build` (golang:1.22-alpine) clean + gofmt clean; `node --check` on the page JS clean; `docker compose config` clean
- [x] Rolled the SearXNG `secret_key` (openssl rand -hex 32; placeholder gone)
- [x] Deployed via `scripts/deploy.sh` — hit a Docker-created root-owned stub dir at `searxng/settings.yml` (Docker auto-made a dir on the prior `compose up` before the file synced); cleared it via a scoped throwaway `caddy:2-alpine` container (runs as root over the bind mount, `ObrigadoSenor` is in the docker group so no root SSH needed) + `docker rm -f searxng`, then re-deployed clean. Backend rebuilt with `search.go`; searxng Up on `:8080` (log errors for `ahmia`/`torch` engines and missing `limiter.toml` are harmless — defaults from `use_default_settings`, limiter is off)
- [x] `scripts/smoke-test.sh` — 11/11 PASS (incl. new SearXNG internal JSON search check from the backend container; existing auth/CORS/allowlist/11434-unreachable/chat-401 all still green)
- [x] `scripts/pull-models.sh pull llama3.1:8b` — 4.9 GB on NVMe; tool-calling model ready (deepseek-r1 remains as the weak-at-tools fallback)
- [x] **OOM fix #1 (500 on search):** 8B at `OLLAMA_CONTEXT_LENGTH=16384` needed 6.7 GB (4.7 GB weights + 2 GB KV cache) but only ~4.8 GB available; runner killed during load (`signal: terminated`). Lowered `OLLAMA_CONTEXT_LENGTH` to `8192` in `.env` + `.env.example` (KV cache halves to 1 GB) and redeployed. Verified: 8B loads (200 in 24s), tool-calling works
- [x] **OOM fix #2 (no answer from any model):** after the 8B test it stayed resident (`KEEP_ALIVE=24h`, 6.6 GB) with `MAX_LOADED_MODELS=1`, so every other model had to swap it out to load — hung. Lowered `OLLAMA_KEEP_ALIVE` `24h`→`10m` in `.env` + `.env.example` (idle models unload, freeing RAM) and redeployed (restarts Ollama → 8B freed). Verified: mem 213 MB→5 GB free, swap 4 GB→2.2 GB, 3B responds 200 in 5.3s
- [x] **Thinking indicator:** `www/index.html` — animated three-dot `Thinking…` shown in the assistant bubble until the first token arrives (so the slow N100 doesn't look frozen); for web search the `🔍 searching the web…` message stays (backend SSE keepalives refresh it). Also fixed `.toggle.on` to use `--soft` (was referencing undefined `--user` after the CSS refactor)
- [ ] User: browser test on https://chat.selected.systems — hard-refresh the page (new JS); pick `llama3.1:8b` (search) or `llama3.2:latest` (light chat), toggle 🌐 on, ask a time-sensitive question, expect the thinking/search indicator then a cited answer; toggle off → normal chat; confirm https://llm.selected.systems/v1/models still 401

## Phase 11 — Background chat generation (switch chats, reply keeps running) 🚧
- [x] Plan approved: move generation out of the HTTP request into a detached background job in the Go backend, persisted to SQLite and tailed by the browser over SSE. Switching chats just closes one SSE tail; the job keeps running on the NAS. Fixes the latent bug where the frontend pushed the in-flight assistant reply into whichever conversation was active at completion.
- [x] `backend/store.go`: `jobs` table in schema (+ `idx_jobs_conv`); `createJob`/`setJobGenerating`/`setJobContent`/`finalizeJob`/`reconcileJobs` (marks stale queued/generating as error on startup)/`updateConversationMessages` (persists the user turn, title untouched)/`appendAssistantMessage` (reads current messages, appends the assistant reply on success only)
- [x] `backend/jobs.go` (new): `job` struct + `jobManager` with a single-worker queue (matches `OLLAMA_NUM_PARALLEL=1`). Worker drives Ollama on `context.Background()` + 5m timeout — a browser disconnect never cancels generation. Per-job broadcast channels (buffered 512) fan chunks to SSE subscribers; `reset`-on-(re)connect replays the accumulated prefix so reconnects never double-count. `runGeneration`/`runStreamPass`/`streamFromOllama` parse Ollama SSE and emit content deltas.
- [x] `backend/search.go`: refactored to callback-based `runSearchLoop(ctx, model, msgs, emit, emitPhase)` + `callOllamaChatCtx`; `handleChatWithSearch` (legacy `/api/chat/completions` web_search path) rewired to call it with OpenAI-SSE emit callbacks + keepalive. Removed the old ResponseWriter-coupled helpers.
- [x] `backend/handlers.go` + `backend/main.go`: routes `POST /api/conversations/{id}/generate` (409 + existing job state on dup), `GET /api/conversations/{id}/events` (SSE tail with 5s keepalive, `done` when no active job), `GET /api/conversations/{id}/job` (204 when idle), `GET /api/jobs/active`. `jobs *jobManager` wired in `main()`; `reconcileJobs` runs in `newStore`.
- [x] `www/index.html`: `stream()` now POSTs `/generate` + opens an `EventSource` to `/events` (`reset`/`chunk`/`phase`/`done`/`joberror`); `openConversation()` resumes an active job via `/job` + reopens the tail; sidebar spinner via `generatingIds` + `/api/jobs/active` (5s poll); model-change save guarded while a job is active; `newChat`/`logout` close the tail. The client no longer appends the assistant reply itself — `done` reloads from the server (source of truth).
- [x] Validated locally: `go build` + `gofmt` clean (golang:1.22-alpine); `node --check` on the page JS clean; `docker compose config` clean; built + ran the backend container and confirmed all four routes (401 unauth, handlers run with session), the full job lifecycle (queued→generating→error), `jobs` table created on a fresh DB, and **no assistant message appended on error**.
- [x] `scripts/smoke-test.sh`: 401 checks for `/api/jobs/active`, `/api/conversations/{id}/job`, `/events`, `/generate` (the full flow needs a session + a pulled model, so it stays a manual browser test).
- [ ] User: redeploy via `scripts/deploy.sh` (new backend binary + static page); browser-test on https://chat.selected.systems — (1) send a message, switch to another chat mid-generation, switch back → reply completed; (2) send in chat A then chat B → B shows “Queued”, runs after A; (3) reload during generation → partial content renders and generation finishes. Confirm https://llm.selected.systems/v1/models still 401.

## Phase 12 — Restore Stop button (cancel in-flight generation) ✅
Regression: the "Split chat UI into ES modules" commit (702bd57) dropped the Stop-button wiring that commit b1949e3 added, so the Send button no longer became Stop while a question was generating. The backend cancel path was still intact (`POST /api/conversations/{id}/cancel` → `handleCancel` → `job.cancel` → `notifyCancelled`, which broadcasts a terminal SSE `done` and persists partial content).
- [x] `www/lib.js`: add a filled-square `stop` icon to the ICONS map (currentColor fill) so `setIcon` can swap the button glyph
- [x] `www/app.js`: restore `renderSend()` (swaps Send/Stop icon + `.stop` class from `activeJobConvId===activeId`, always re-enables the button) and `stopActive()` (POSTs `/cancel`; 4s fallback if the terminal SSE `done` never arrives); replace every `send.disabled=false/true` lifecycle call with `renderSend()` (openConversation, resumeIfGenerating, tailJob error, onGenerationDone, newChat, stream error paths) and add `renderSend()` after `tailJob` + in `logout`; keep `send.disabled=true` only during the enqueue window and inside `stopActive`; Send click handler now routes Stop→`stopActive` vs Send→`stream` via `classList.contains("stop")`
- [x] `www/styles.css`: restore `#send.stop` red border/background/color + hover state after the `#send` rule
- [x] `www/index.html`: bump cache-bust `?v=3`→`?v=4` on `styles.css` and `app.js`
- [x] Validated: `node --check` clean on `app.js` + `lib.js` (as .mjs); grep confirms no stray `send.disabled=false` remains and every lifecycle site calls `renderSend()`
- [ ] User: redeploy via `scripts/deploy.sh` (static page only — backend unchanged); hard-refresh https://chat.selected.systems, send a question, click the red Stop while generating → reply stops and the partial answer is saved; resume/switch-chat/reload still behave

## Phase 13 — Image upload (vision models) ✅
Only `gemma3:4b` in the curated catalog is vision-capable, but the backend stored messages as plain-text strings — so even with it installed an image never reached the model. This adds per-message image data end-to-end and gates the UI on the model's `vision` capability.
- [x] `backend/store.go`: `Message` gains `Images []string` (`json:"images,omitempty"`, base64 data URLs). Messages are already persisted as a JSON blob in `conversations.messages`, so this round-trips through SQLite with no schema change; `omitempty` keeps existing text-only conversations byte-identical.
- [x] `backend/jobs.go`: new `messageContent(m)` builds the OpenAI `content` field — a plain JSON string for text-only messages, an array of typed parts (`[{type:"text",…},{type:"image_url",image_url:{url:"data:…"}}]`) when `m.Images` is non-empty — so a vision model actually receives the image. `runGeneration` uses it instead of `jsonString(m.Content)`. The direct `handleChat` passthrough and `handleChatWithSearch` already preserved image parts via `oaiMessage.Content` (`json.RawMessage`), so no change there.
- [x] `www/lib.js`: add a `paperclip` icon to ICONS for the attach button.
- [x] `www/index.html`: composer gains `#imgPills` (staged-image preview strip), `#attachBtn` (paperclip), and a hidden `#fileInput` (multi-select); cache-bust bumped to `?v=21`.
- [x] `www/styles.css`: `.attach-btn`, `.input-wrap.has-attach #input` padding, `.composer.drag-over` outline, `.img-pills`/`.img-pill` (64px removable thumbnails), `.msg-images` (in-chat image thumbs).
- [x] `www/app.js`: lazy vision detection — `ensureVision(name)` GETs `/api/models/{name}/info` and adds the model to `visionModels` when `capabilities` includes `vision`; `syncVision()` runs on boot, model select, `Use`, and open-conversation. Attach button only shows for vision models; switching to a non-vision model drops staged images. Three capture paths (vision-gated): file picker, clipboard paste, drag-and-drop. `downscaleImage()` caps the longest edge at 1280px and re-encodes JPEG q0.82 so phone photos don't become multi-MB base64 blobs in SQLite. `stream()` stages `pendingImages` onto the user message (`images` array) and renders them; `addMsg`/`rerenderChat` render images in the user bubble; pending images cleared on send / chat switch / new chat.
- [x] Validated locally: `go build` + `go vet` clean (golang:1.22-alpine); `node --check` clean on `app.js` + `lib.js`.
- [x] **End-to-end verification (local Ollama + backend built from this source):** the NAS stack is deployed to `/volume1` (not present on the Mac), so ran a self-contained replica — Ollama 0.34.0 + the backend built from current source on a private Docker network, with a throwaway `SESSION_SECRET` (no real secrets touched) and plain-HTTP `APP_BASE_URL` (so the auth cookie isn't Secure-only). Minted a valid session cookie via the same HMAC scheme `auth.go` uses (`base64url(email).exp.hmac(secret,email|exp)`), generated a solid-red 220×220 PNG as a data URL, and drove the real background path: `POST /api/conversations` → `POST /api/conversations/{id}/generate` (user message with `images:[dataURL]`, `web_search:false`) → poll `/job` → `GET /api/conversations`.
  - Pre-checks: forged cookie authenticates (`{"email":"tester@example.com"}`); `gemma3:4b` listed; `/api/models/gemma3:4b/info` reports `capabilities: ['completion','vision']` — the exact check the frontend's `ensureVision()` gates the attach button on.
  - **Image present:** model replied **"The image is red."** (job: queued→generating→done; user message stored with `images=1`).
  - **Control (same prompt, no image):** model replied "Please provide me with the image! I need to see it to tell you its color." — confirming the first reply came from the model actually seeing the red PNG, not guessing from the prompt text. Full chain validated: `handleGenerate` → `runGeneration` → `messageContent` (images → OpenAI `image_url` parts) → `streamFromOllama` → Ollama `gemma3:4b`.
  - Test containers/volumes/image removed afterward; repo untouched.
- [ ] User: redeploy via `scripts/deploy.sh` (new backend binary + static page); on https://chat.selected.systems pick `gemma3:4b`, attach/paste/drop an image, send → expect a reply that describes the image; switch to a non-vision model → attach button hides and staged images clear. Confirm https://llm.selected.systems/v1/models still 401.

## Phase 14 — Desktop: fix Connect-folder wizard, move repos into the sidebar, first-load wizard 🚧
Source plan: `37158613-5eb4-4fe0-a3a5-fee0b3d55738`. Root cause: `pickFolder()` swallowed every native-picker IPC failure via `.catch(() => null)` and its caller no-opped silently on a falsy result — so a broken picker call, a cancellation, or picking a folder that wasn't itself a git repo (e.g. a parent projects directory) all looked identical: nothing happened, no error. Confirmed via source inspection (plugin registration, `dialog:default` permission, IPC command shape) and `strings` on the user's built app bundle that the wiring itself was current and correct — the bug was purely the swallowed error + missing multi-repo support.
- [x] `desktop/src-tauri/src/github.rs`: new `POST /__sidecar/repos/scan-local` — resolves the picked folder to its git root if it is (or is inside) one; otherwise scans immediate subdirectories for a `.git` entry and returns every match as a candidate, so a parent folder containing several repos yields a checklist instead of a "not a git repository" error. Registered in `router()`.
- [x] `desktop/renderer/desktop.js`: `pickFolder()` no longer swallows IPC errors; new shared `connectFolderFlow()` (pick → scan-local → add the one match, or show `showConnectPicker()`'s checklist for several) is the single entry point used by the sidebar "+", the first-load wizard, and reused `addLocalRepo()`. `flashDsErr` reworked into a page-level `.ds-toast` so failures are visible regardless of which (if any) overlay triggered them — previously it wrote into a `<div>` hidden inside the closed Repositories modal.
- [x] `desktop/renderer/desktop.js` + `desktop.css`: new collapsible "Repos" section injected into `#sidebar` (between `#sideHead` and `#convList`) with a "+" (connect) and "⋯" (Working changes) in its header; renders connected repos via the existing `localRow()`/`refreshLocal()`. Dropped the now-redundant "Local clones" list + "Connect folder" button from the header modal, which is now GitHub-only (renamed "GitHub" from "Repositories").
- [x] `desktop/renderer/desktop.js`: first-load wizard (`showRepoWizard`/`maybeShowRepoWizard`) shown once, only when zero repos are connected (`localStorage['nas-llm-repo-wizard-seen']`), reusing `connectFolderFlow()`; skip or connect both mark it seen.
- [x] Validated: `cargo check` clean in `desktop/src-tauri`; `node --check` clean on `desktop/renderer/desktop.js`.
- [ ] User: `npm run desktop` — confirm the native folder picker now opens (or a real error toast appears if it doesn't), point it at a folder containing multiple repos and connect a subset via the checklist, verify the sidebar Repos section lists them with working Pull/Ship/+New chat, and confirm the wizard appears once on a fresh profile with zero repos connected.

## Phase 15 — Desktop agent workflow: link repo → agent chat → branch → commit/push/PR 🚧
Source plan: `96a3a8a2-8d02-40cb-a2ff-843bbfbcde3b`. Goal: make the desktop app's "link a local repo → start an agent chat → code → commit/push → PR" flow one coherent workflow, with the current branch always visible, so `main` is never dirtied by agent edits. Implemented as three parallel child-agent layers (Rust sidecar / Go backend / renderer) merged onto `orchestrator/integrate`.
- [x] Sidecar (`desktop/src-tauri/src/github.rs`): new routes `POST /__sidecar/repos/branch` (slug from chat title → `git switch -c agent/<slug>`, idempotent, dirty-tree failure returns error without forcing, re-pushes repo context), `GET /__sidecar/repos/state?name=` (`{branch, dirty, ahead, behind, hasRemote}`), `POST /__sidecar/repos/commit` (plain `git add -A`+commit + optional push, no version/CHANGELOG), `POST /__sidecar/repos/create-pr` (GitHub `POST /repos/{owner}/{repo}/pulls` via the keychain token; pushes head first; clear errors for non-GitHub/no-token/no-remote). `repos_exec` gains `git_commit`/`git_push`/`create_pr` match arms, all approval-gated. Routes registered in `router()`; github router already merged in `main.rs`.
- [x] Backend (`backend/`): `Conversation.RepoBranch` + `repo_branch TEXT` column (migrated like `repo_id`); PATCH `/api/conversations/:id` accepts `repoBranch`; list/get return it. New local agent tools `git_commit`/`git_push`/`create_pr` (schemas in `agent.go`, `local: true` in `toolRegistry`, listed in `availableTools`); `jobs.go` repo-bound allow list appends them; `injectRepoContext` prompt now tells the model it can commit/push/open a PR.
- [x] Renderer (`desktop/renderer/desktop.js` + `desktop.css`): `createRepoChat` calls `repos/branch`, PATCHes `repoBranch`, adds the git tools to `agentTools`, and navigates without a full reload (one additive `nasllm:openConv` listener in `www/app.js`). Branch rail in `#app header` (`⎇ branch · ●N dirty · ↑a ↓b`, polls + refreshes after toolExec). Approval dialog prefixes writes with `tool → owner/repo @ branch`. New session panel (status + diff + Revert/Commit/Commit & push/Open PR/Ship). Sidebar chat rows show `repo_branch`.
- [x] Integrated + validated on `orchestrator/integrate`: `cargo check` clean; `gofmt -l .` clean + `go build ./...` clean + test compile clean; `node --check` clean on `desktop.js` + `app.js`. Cross-layer contract spot-check passed (tool names, `repos_exec` arms, routes, `repo_branch` field all align). Pre-existing local `Cargo.lock` 0.2.1 bump preserved.
- [ ] User: `npm run desktop` (from `orchestrator/integrate`) — link a repo → + New chat → confirm the header rail shows `agent/<slug>` and main is untouched → ask the agent to make an edit → approve the `apply_patch` (prefixed with repo @ branch) → open the session panel → Commit & push / Open PR → confirm the PR opens in the browser. Then exercise the agent-driven `git_commit`/`git_push`/`create_pr` tools (each approval-gated).

---
Phases 1–3 are fully reversible and touch nothing outside the NAS.
Phase 4 is the first step affecting something outside it (nameservers for
`selected.systems`); show the record diff before flipping, and rollback is
pointing nameservers back at Squarespace.
