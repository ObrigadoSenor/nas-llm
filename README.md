# nas-llm

A single secure **public OpenAI-compatible HTTPS API endpoint** running on a
UGREEN NASync DXP2800 (Intel N100, 8 GB), called by a browser extension, with
**no router ports opened**. The API host (`llm.selected.systems`) is pure-API:
o user accounts, no management routes. A second host (`chat.selected.systems`)
runs a minimal streaming chat page backed by a small Go service for magic-link
login and SQLite chat history. Models are managed from the chat UI (download,
remove, benchmark) with the `ollama` CLI over SSH as a fallback.

```
Browser extension (Bearer token) → llm.selected.systems:
  Cloudflare edge (TLS + WAF + rate limit)
  → cloudflared (outbound-only tunnel, no open ports)
  → Caddy :8080 (/v1/*, bearer check, Host rewrite, stream flush)
  → Ollama :11434 (internal network only — never published)
  → Models on NVMe

Chat page (session cookie) → chat.selected.systems:
  Cloudflare edge (TLS + WAF + rate limit)
  → cloudflared (outbound-only tunnel)
  → Caddy :8080 (/api/* → backend :8081, else static www/)
  → Go backend (magic-link auth + SQLite history + Ollama proxy)
      web_search off → Ollama :11434 (streaming passthrough)
      web_search on  → tool loop: Ollama (tool_calls) ↔ SearXNG :8080 (internal) → cited answer
  → SQLite on NVMe (users, conversations)

  SearXNG :8080 (internal network only — never published) aggregates
  Google/Bing/DuckDuckGo for the web_search tool.
```

Endpoint: **`https://llm.selected.systems`** (OpenAI-compatible: `/v1/chat/completions`, `/v1/models`, `/v1/embeddings`) — pure API, bearer-token auth for the browser extension.

Chat UI: **`https://chat.selected.systems`** — a minimal streaming chat page (static HTML in `www/`, no secrets baked in). Sign-in is passwordless: enter your email, click a magic link, and a signed session cookie is set. Chat history lives server-side in SQLite on the NAS, so you can resume conversations from any browser. The page calls same-origin `/api/*` (auth, history, and an Ollama proxy) on the Go `backend` container; the bearer token never reaches the browser. Both hostnames route through the same Cloudflare Tunnel to the same Caddy instance, which routes by Host header — this keeps `llm.selected.systems` pure-API.

## Files

| File | Purpose |
|------|---------|
| `docker-compose.yml` | ollama (no `ports:`), caddy (`:8080`), backend (`:8081`, no `ports:`), searxng (no `ports:`), cloudflared (`tunnel` profile) |
| `Caddyfile` | `/v1/*` bearer auth + CORS for the API host; `/api/*` → backend for the chat host; static `www/` otherwise |
| `backend/` | Go service: magic-link auth, SQLite history, Ollama proxy, web_search tool loop (`search.go`), and in-UI model management — pull/remove/benchmark/catalog (`models.go`; Dockerfile builds a static binary) |
| `searxng/settings.yml` | SearXNG config — internal-only meta-search backend for the `web_search` tool (JSON output enabled, limiter off) |
| `.env.example` / `.env` | NAS access, volume, tunnel token, bearer token, model, CORS origin, session secret, Brevo key, allowlist, SearXNG URL, NAS RAM/reserve for fit guidance |
| `scripts/deploy.sh` | sync the stack to the NAS and `docker compose up -d --build` |
| `scripts/pull-models.sh` | `docker exec ollama ollama ...` over SSH |
| `scripts/smoke-test.sh` | API auth/CORS/allowlist/port-isolation/streaming + chat `/api/*` 401 + SearXNG internal JSON checks |
| `ai/tasks.md` | phased task list |

## Chat login & history

`chat.selected.systems` is backed by a small Go service (the `backend` container)
that adds three things on top of the static page:

- **Magic-link sign-in.** `POST /api/auth/request {email}` emails a one-time,
  15-minute link via Brevo. Clicking `GET /api/auth/verify?token=…` sets a
  signed, HttpOnly session cookie (~30 days) and redirects to `/`. No passwords.
- **Chat history** in SQLite on the NVMe (`${DOCKER_VOLUME}/docker/nas-llm/backend/data`):
  `GET/POST/PUT/DELETE /api/conversations[/:id]`. Each conversation belongs to a
  user; the page saves after every turn, so a reload or a different browser
  resumes where you left off.
- **Background generation.** A reply runs as a detached job on the backend, not
  tied to the page: `POST /api/conversations/:id/generate` enqueues it and `GET
  /api/conversations/:id/events` tails it over SSE. Switching chats, reloading,
  or closing the tab does **not** cancel an in-progress reply — it keeps
  generating on the NAS and the result lands in history; come back and it's
  finished. One generation runs at a time (matching `OLLAMA_NUM_PARALLEL=1`);
  a second request queues and shows “Queued”.
- **Stop.** The Send button becomes a red ⏹ Stop while the open chat is
  generating. `POST /api/conversations/:id/cancel` aborts the job's Ollama
  request via its context; any partial text streamed so far is saved as the
  assistant reply and the page reloads with it. A queued (not-yet-started) job
  is dropped before it ever drives Ollama. Stop applies to the conversation
  you're viewing — switching to another generating chat shows its own Stop.
- **Ollama proxy** `GET /api/models` and `POST /api/chat/completions` (streaming
  passthrough) so the page never needs the bearer token or cross-origin CORS.
- **Web search (optional).** With the 🌐 toggle on, `/api/chat/completions` runs
  a tool-calling loop in the backend: it gives the model a `web_search` tool,
  executes the calls against the internal SearXNG, and streams back a cited
  answer. Off by default; a plain passthrough when the toggle is off or
  `SEARXNG_URL` is empty. See "Web search" below.

`llm.selected.systems` is untouched and stays pure-API for the extension.

Required env (`backend` container): `SESSION_SECRET`, `BREVO_API_KEY`,
`APP_BASE_URL`, `MAIL_FROM`, `ALLOWED_EMAILS` (empty = open sign-up; set to your
email for a personal NAS). The sender in `MAIL_FROM` must be a Brevo-verified
sender for `selected.systems`.

Migrating to another NAS: back up the SQLite file along with the ollama/caddy
data directories and restore it to the same path — users and conversations come
with you.

## Web search (optional)

The chat page has a 🌐 toggle. When on, the backend gives the model a
`web_search` tool and runs a small loop: the model emits one search query, the
backend queries the internal SearXNG (`http://searxng:8080/search?format=json`,
top 3 results, snippets trimmed to ~200 chars), feeds them back, and streams a
cited answer — one search round (env-tunable: `MAX_SEARCH_ROUNDS`, default 1).
The query is echoed to the page as `🔍 searching: <query>` while it runs. This
rides the existing `chat.selected.systems` → backend path; the pure-API host
`llm.selected.systems` is untouched and the extension is unaffected.

`searxng/settings.yml` also bounds outbound latency (`outgoing.request_timeout`
3s, `max_request_timeout` 5s overall, per-engine `timeout: 3`) so a slow/blocked
engine can't stall the meta-search.

The LLM itself never browses — Ollama is inference-only; the backend executes
the search. "Local" means inference and summarization stay on the NAS, but the
outbound search queries still leave your network (SearXNG aggregates/anonymizes
across Google/Bing/DuckDuckGo so no single engine sees your full history, but
it does not make queries invisible to those engines). Snippets-only keeps the
prompt-injection surface low; the model is given no consequential tools.

Requirements: a tool-calling model (`llama3.1:8b` — `deepseek-r1` is weak at
tools) and the `searxng` service up. On 8 GB, shorten the 8B's context to
~8192 (a custom Modelfile with `PARAMETER num_ctx 8192`, or lower
`OLLAMA_CONTEXT_LENGTH` in `.env`) so it fits alongside SearXNG. During search
rounds the backend flushes SSE keepalive comments so the Cloudflare 100 s edge
timeout (524) never fires while the N100 thinks.

SearXNG config: `searxng/settings.yml` enables JSON output (`search.formats`
includes `json` — off by default, and without it every consumer silently gets
HTML) and disables the rate limiter (no Redis). It is internal-only (no
published port); rotate `server.secret_key` if you ever expose it.

## Prerequisites on the NAS (phase 1)

1. **Docker** — install from UGOS Pro **App Center > Docker**.
2. **Shared folder access** — grant read/write on the `docker` shared folder.
3. **SSH** — enable in **Control Panel > Terminal**.
4. **Find the NVMe volume** (model weights go on NVMe to keep SATA disks asleep):
   ```sh
   ssh root@<nas-ip> df -h
   ```
   If the NVMe is its own volume it will be `/volume2`; if folded into the main
   pool, `/volume1`. Set `DOCKER_VOLUME` in `.env` accordingly and create:
   ```sh
   ssh root@<nas-ip> "mkdir -p /volume?/docker/nas-llm/{ollama,caddy/data,caddy/config}"
   ```
   (`deploy.sh` creates these for you.)

## First-time setup (local)

```sh
cp .env.example .env
# Generate a bearer token (hex only — other chars break the Caddyfile matcher):
openssl rand -hex 32
# Edit .env: set NAS_HOST, NAS_USER, DOCKER_VOLUME, API_BEARER_TOKEN.
# Leave TUNNEL_TOKEN blank until phase 4.
```

## Deploy

```sh
scripts/deploy.sh
```
With no `TUNNEL_TOKEN`, this starts **ollama + caddy + backend** (LAN mode). Once
`TUNNEL_TOKEN` is set it also starts **cloudflared**. The backend image is built
on the NAS (`--build`); no local Go toolchain is needed.

`searxng/settings.yml` is a read-only bind mount, so edits to it are **not**
picked up by `up -d` — restart the container after a deploy that changes it:
```sh
ssh root@<nas-ip> "docker restart searxng"
```

### Shipped: web-search speedup + Stop button (PR #2, merged to `production`)

Merged to `production` via [PR #2](https://github.com/ObrigadoSenor/nas-llm/pull/2)
(`main` → `production`). Deployed to the NAS and verified through the public
Cloudflare edge (not just LAN):

- `https://llm.selected.systems/v1/models` — 401 unauth, 200 auth (pure-API
  host, extension unaffected).
- `https://chat.selected.systems/` — 200 (chat page).
- `https://chat.selected.systems/api/conversations/{id}/cancel` — 401 without a
  session (the new Stop route is live and auth-gated).
- LAN smoke test **16/16** (incl. the `/cancel` 401 check and SearXNG internal
  JSON check). SearXNG search leg measured at 0.83–1.17s/query.

The NAS is deployed from `main`; `production` is the release branch that `main`
merges into via PR. Branch model: work on `main`, open `main` → `production`
PRs to release.

Remaining (manual, needs a magic-link session on https://chat.selected.systems):

- **Speed:** 🌐 on, ask a time-sensitive question — expect `🔍 searching: <query>`
  then a cited answer sooner than before (one round, not up to three).
- **Stop:** send a question, click ⏹ Stop mid-generation — the reply halts and
  the partial text is saved; send again → works normally.

Optional: set `MAX_SEARCH_ROUNDS=2` in `.env` + redeploy if single-round answers
feel too shallow for multi-part questions.

## Model management

Models are managed from the chat UI — no SSH required. Click the grid icon
(⊞) next to the model selector in the header to open the **Manage models**
panel, which has two tabs:

- **Browse** — a curated set of N100/8 GB-friendly models, each with:
  - a **fit verdict** (Fits / Tight / Won't fit) estimating RAM use as the
    model's on-disk size plus its KV cache at your configured context length,
    compared against `NAS_RAM_GB − NAS_SYSTEM_RESERVE_GB`;
  - an **estimated tok/s range** (labelled an estimate — benchmark after
    download for the real number);
  - capability badges (chat, tools, vision, thinking, embeddings) and a
    one-line blurb. **Download** starts a background pull with a live progress
    bar. A free-text **Pull by name** field downloads any `model:tag`.
- **Installed** — every model on the NAS, with size, quant, family, capability
  badges, and the last measured tok/s (or "not benchmarked"). Actions:
  - **Use** — switch the current conversation to this model.
  - **Benchmark** — runs a short 64-token generation and reports the real
    tok/s (`eval_count / eval_duration × 1e⁹`), prompt tok/s, and load time.
    The result is persisted in SQLite and shown across browsers/reloads.
  - **Details** — architecture dims (layers, KV heads, head dim), context
    length, capabilities, and the computed RAM fit.
  - **Remove** — deletes the model from the NAS to free disk space.

Downloads run as detached jobs on the NAS (one at a time, mirroring the
generation job system) and stream progress over SSE, so they survive a page
reload or tab close — reopen the panel and it reattaches. The pure-API host
`llm.selected.systems` and the browser extension are unaffected; everything
rides the existing session-cookie `/api/*` surface.

### Performance metrics (benchmarking)

Every pull **auto-benchmarks**: once the download finishes, the backend runs a
short 64-token generation against the new model and persists the measured
tok/s before signaling "done" — so the Installed card shows real performance
immediately, with no extra click. The progress bar shows a "Benchmarking…"
phase while this runs. A benchmark failure (e.g. an unloadable model) is
non-fatal: the pull still succeeds. You can re-benchmark any installed model
at any time with the **Benchmark** button.

The measured tok/s (`eval_count / eval_duration × 1e⁹`), prompt tok/s, and
load time are stored in SQLite (`model_benchmarks`) and surfaced on the
Installed card, the Details panel, and `GET /api/models`.

The catalog's **estimated tok/s ranges are calibrated from measured N100
benchmarks** (not vendor specs), so the pre-download "will it run slow"
guidance is realistic. Measured sample (Q4_K_M, 8192-token context):

| Model | Est. tok/s | Measured |
|-------|------------|----------|
| `llama3.2:1b` | — | ~16 tok/s |
| `qwen3:1.7b` | 10–16 | ~12–16 tok/s |
| `llama3.2:3b` | 7–11 | ~8–10 tok/s |
| `llama3.1:8b` | 2–4 | ~3 tok/s |

Estimates are deliberately conservative (a range, not a point) — always
benchmark for the definitive number on your specific hardware and load.

Fit guidance env (`.env`, with safe defaults so existing deploys keep working):

| Var | Default | Purpose |
|-----|---------|---------|
| `NAS_RAM_GB` | `8` | Total RAM on the NAS, used to judge model fit. |
| `NAS_SYSTEM_RESERVE_GB` | `1.5` | RAM reserved for OS + containers, subtracted before comparing. |
| `OLLAMA_CONTEXT_LENGTH` | `16384` | Mirrors the ollama container value; drives the KV-cache estimate. |

Backend routes (all session-auth-gated, registered in `backend/main.go`):

| Route | Purpose |
|-------|---------|
| `GET /api/models` | Installed models with size/details + last benchmark (OpenAI `{data:[{id}]}` shape, selector-compatible). |
| `GET /api/models/catalog` | Curated catalog with per-model fit + speed verdicts and NAS RAM info. |
| `POST /api/models/pull` | Enqueue a background pull (one at a time); 202 + job state, 409 if one is active. |
| `GET /api/models/pulls/active` | Active pull(s) for reconnect (mirrors `/api/jobs/active`). |
| `GET /api/models/pull/{jobId}/events` | SSE progress (reset/phase/progress/done/joberror) with keepalive. |
| `POST /api/models/pull/{jobId}/cancel` | Cancel an in-flight pull via its context. |
| `DELETE /api/models/{name}` | Remove a model (Ollama `DELETE /api/delete`); 404 if absent. |
| `POST /api/models/{name}/benchmark` | Run a 64-token generation; returns measured tok/s, persisted. |
| `GET /api/models/{name}/info` | `/api/show` details (dims, capabilities) + size + KV-cache estimate + benchmark. |

The `ollama` CLI over SSH remains as a fallback/ops tool:

```sh
scripts/pull-models.sh pull llama3.2:3b   # download (one-time, ~2 GB)
scripts/pull-models.sh list               # what's installed
scripts/pull-models.sh run  llama3.2:3b   # interactive chat over SSH
scripts/pull-models.sh rm   qwen2.5:3b    # remove
```

On 8 GB, the sweet spot is a **3B model at Q4** (`llama3.2:3b` or `qwen2.5:3b`).
Spend leftover RAM on **context length**, not parameter count — the KV cache is
what OOMs you, and a page-summarising extension needs long input more than a
smarter model. Tune via `OLLAMA_CONTEXT_LENGTH`, `OLLAMA_MAX_LOADED_MODELS=1`,
`OLLAMA_NUM_PARALLEL=1`, `OLLAMA_KEEP_ALIVE` in `.env`, then redeploy.

For the optional **web search** feature, pull a tool-calling model —
`llama3.1:8b` is recommended (`deepseek-r1` is weak at tool calling):

```sh
scripts/pull-models.sh pull llama3.1:8b
```

At ~5 GB RAM (Q4) alongside SearXNG, give the 8B a shorter context (~8192) —
either lower `OLLAMA_CONTEXT_LENGTH` in `.env`, or create a custom Modelfile
with `PARAMETER num_ctx 8192` so the 3B can keep 16k. The chat page lets you
pick the model per conversation, so keep `llama3.2:3b` as the light fallback.

## Smoke test

```sh
scripts/smoke-test.sh                                       # LAN (phase 2/5)
ENDPOINT=https://llm.selected.systems scripts/smoke-test.sh  # public (phase 6)
```

## Rotate the bearer token

```sh
NEW=$(openssl rand -hex 32)
# Update API_BEARER_TOKEN in .env (and in the browser extension), then:
scripts/deploy.sh
```
Caddy can also match a list of tokens (issue one per consumer; revoke by
deleting a line). Update the `@authed` matcher in the `Caddyfile` accordingly.

## Read logs

```sh
ssh root@<nas-ip> "docker logs --tail 100 -f ollama"
ssh root@<nas-ip> "docker logs --tail 100 -f caddy"
ssh root@<nas-ip> "docker logs --tail 100 -f cloudflared"
ssh root@<nas-ip> "docker logs --tail 100 -f backend"
```

## Phase 4 — DNS migration + Cloudflare Tunnel (user-driven)

`selected.systems` is used (not `obrigadosenor.com`): it has no inbound email
and no DNSSEC, so the blast radius is just a Squarespace website. `obrigadosenor.com`
is left untouched.

1. **Snapshot current records** (rollback plan): the four apex `A` records, the
   `www` CNAME to `ext-sq.squarespace.com`, the Brevo verification TXT, the
   DMARC TXT, and any Brevo DKIM selector.
2. **Add `selected.systems` to Cloudflare**, diff the auto-imported records
   against the snapshot, hand-add anything missed.
3. **Set the Squarespace site records to DNS-only (grey cloud)** — proxying
   them fights Squarespace's own certificate provisioning.
4. **Switch nameservers at Squarespace**, wait for the zone to go Active, then
   confirm the site still loads and Brevo still reports the domain verified.

**Rollback:** point the nameservers back at Squarespace and restore the
snapshotted records. Failure is immediately visible and instantly reversible.

Then create a **named tunnel** in the Cloudflare dashboard, add a public hostname
`llm.selected.systems` → `http://caddy:8080`, copy the tunnel token into
`.env` as `TUNNEL_TOKEN`, and `scripts/deploy.sh` (it starts cloudflared
automatically).

## Phase 5 — lock down

- The `Caddyfile` already allows only `/v1/*` and 404s everything else, so
  `/api/pull|create|delete|push` are unreachable even with a valid token.
- Add a **Cloudflare WAF rate-limit rule** on `llm.selected.systems` to bound
  abuse. On a box where each request costs seconds of 100% CPU, edge filtering
  is a performance feature, not just a security one.
- Do **not** use Cloudflare Access on this hostname — its HTML login redirect
  breaks `fetch()` from an extension.

## CORS note

`Access-Control-Allow-Origin: *` is safe while the extension is local-only and
undistributed (the bearer token is a genuine secret). **Before publishing the
extension**, pin `EXTENSION_ORIGIN` to the extension's origin
(`chrome-extension://<id>`) — at that point the token ships to users and both
the origin and token need locking down.

## Gotchas (already handled in the Caddyfile)

- **CORS preflight bypasses auth.** `OPTIONS` is answered `204` with CORS
  headers *before* the bearer check — otherwise the browser's preflight (which
  does not send `Authorization`) gets a 401 and the real request never fires.
- **Ollama 403s non-localhost `Host`.** Caddy rewrites `Host` to
  `localhost:11434` and strips the inbound `Origin`.
- **Cloudflare free-plan origin timeout is 100 s (524).** Always stream
  (`"stream": true`) — `flush_interval -1` makes Caddy flush token-by-token.
- **Ollama has no auth.** Port 11434 is never published to the host or LAN.
- **Host ports must not collide with UGOS** — 8080 is used (9000 is the UGOS console).

## Optional hardening (phase 7)

- Once the tunnel is up, drop the `ports: "8080:8080"` mapping from `docker-compose.yml`
  so Caddy is reachable only by cloudflared over the internal network (not the LAN).
  Re-add it only when you need LAN testing.
- Add a UGOS backup task for `/volume?/docker/nas-llm/ollama` and `.../caddy`.
- Container `restart: unless-stopped` is already set.
