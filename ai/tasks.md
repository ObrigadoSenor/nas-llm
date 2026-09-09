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
- [ ] Browser test: open https://chat.selected.systems, paste bearer token, stream a chat (user)

---
Phases 1–3 are fully reversible and touch nothing outside the NAS.
Phase 4 is the first step affecting something outside it (nameservers for
`selected.systems`); show the record diff before flipping, and rollback is
pointing nameservers back at Squarespace.
