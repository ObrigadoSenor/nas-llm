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

---
Phases 1–3 are fully reversible and touch nothing outside the NAS.
Phase 4 is the first step affecting something outside it (nameservers for
`selected.systems`); show the record diff before flipping, and rollback is
pointing nameservers back at Squarespace.
