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
| `desktop/` | Tauri 2 desktop shell around the chat UI (sign-in, repos, in-app updates); see `desktop/README.md` for the release process |
| `scripts/bump-desktop-version.sh` | bump the desktop app version (patch/minor/major) and tag a release |
| `.github/workflows/desktop-release.yml` | build + sign + publish the desktop app to a GitHub Release on a `v*` tag push |

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
top 3 results, snippets trimmed to ~200 chars), feeds them back, and streams
back a cited answer. The whole loop is streamed, including the first model pass
that decides whether to search — so the model's thinking and any direct
(no-search) answer reach the page as they're produced, not after the pass
completes (PR #4). One search round (env-tunable: `MAX_SEARCH_ROUNDS`, default 1).
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

## Clarifying questions

The chat page turns a clarifying question into an interactive card instead of
plain text, in two ways:

- **Every chat (default).** On a tool-capable model, the backend offers the
  model an `ask_user` tool on each plain turn (no toggle needed): if the task
  is ambiguous, the model calls `ask_user` with a clear question and concrete
  options, and the backend renders them as a card. This is why a question that
  used to arrive as prose now arrives as something you can click through. A
  small/non-tool model that writes the question as prose is still caught:
  `CLARIFY_PROSE_DETECT` best-effort detects a question shape ("Question: …?
  (e.g., A, B, C)") and turns it into the same card.
- **Clarify toggle (interrogation mode).** The + menu's **Clarify** toggle
  forces the question-first loop and caps back-to-back questions at
  `MAX_CLARIFY_ROUNDS` (default 3): once the cap is reached the `ask_user` tool
  is withheld and the model must answer. Use it when you want the model to
  interrogate you before answering.

The card shows a selectable list — radio for a single-select question,
checkbox for multi-select — plus an inline **"Or type your own answer…"** input
+ Send, so you can pick an option or write your own when none fit. The user's
pick (or typed text) becomes the next turn, so the model asks again or answers.
It reuses the existing background-generation + SSE machinery — each question is
a persisted assistant turn, each answer a normal user turn — so a half-answered
question survives a reload or a backend restart (it lives in the conversation,
not in memory).

Clarify and Web search are mutually exclusive in the UI (turning one on turns
the other off). The `ask_user` tool needs a tool-calling model — `qwen3:1.7b`,
`qwen2.5:3b`, or `llama3.1:8b` (`deepseek-r1` and the non-tool 3B models just
answer directly, though the prose detector can still catch a question they
write as text). The pure-API host `llm.selected.systems` and the browser
extension are unaffected; everything rides the existing session-cookie
`/api/*` surface.

Env (`.env`, with safe defaults):
- `MAX_CLARIFY_ROUNDS=3` — back-to-back question cap under the Clarify toggle.
- `ASK_USER_IN_PLAIN_CHAT=true` — offer `ask_user` on every plain turn for
  tool-capable models. Set false to skip the tool-schema overhead on every
  turn (a question can still become a card via the detector).
- `CLARIFY_PROSE_DETECT=true` — detect a question the model wrote as prose and
  render it as a card (fallback for small/non-tool models). Set false to keep
  such turns as plain text.

## Agent mode

The + menu has an **Agent** toggle (mutually exclusive with Web search and
Clarify). When on, `/api/conversations/:id/generate` runs a general ReAct loop
in the backend (`backend/agent.go`) over a small tool registry, instead of the
single-purpose search/clarify loops. The agent can compose tools within one
run — e.g. `web_search` then `calculator`, or `ask_user` then answer — which the
mutually-exclusive toggles could not.

Tools (each a schema + server-side executor):
- **`web_search`** — the existing SearXNG meta-search (reused from `search.go`).
- **`ask_user`** — the existing clarifying-question card (terminal; the user's
  clicked option is the next turn, same as the Clarify toggle).
- **`get_time`** — the current date/time (the model's cutoff is stale).
- **`calculator`** — a safe arithmetic evaluator (`+ - * / ^`, `sqrt`/`log`/…,
  `pi`/`e`); no `eval`, so untrusted model output can't run code.
- **`memory_read` / `memory_write`** — persistent notes per user in SQLite
  (`notes` table); a short index of note keys is auto-injected into the system
  prompt so the agent knows what it can recall.
- **`fetch_page`** — download a URL and read its text. **Off by default** (see
  guardrails below).

Small-model guardrails (the N100/8 GB runs a 3B–8B model): a hard step budget
(`MAX_AGENT_STEPS`, default 6), duplicate-(tool,args) detection that nudges the
model to stop and answer, **error-as-observation** (a tool failure or a bad
argument goes back to the model as an observation so it self-corrects instead of
crashing the run), observation size capping, and **context compaction** (old tool
results are truncated; when the transcript nears the context window, the oldest
turns are summarized into one system message so a long multi-step run doesn't
overflow 8–16k). Each run's tool-call trace (step, tool, args, result preview,
duration) is streamed live to a steps drawer above the answer and persisted
(`agent_steps` table + `jobs.prompt_tokens`/`completion_tokens` for analytics).

### System prompt

The agent runs with a configurable system prompt, prepended as the first
(`system`) message of every model round. Resolution order, most-specific first:

1. **Per-conversation override** — `agent_system` on the conversation, set via
   `PATCH /api/conversations/:id` with `agentSystem`/`agentTools`. Supported in
   the schema but not yet exposed in the UI.
2. **Global default** — the `agent_system` row in the SQLite `settings` table,
   set from the UI or `PUT /api/agent/config`, read back with
   `GET /api/agent/config` (or `sqlite3 /data/nas-llm.db
   "SELECT value FROM settings WHERE key='agent_system'"`).
3. **Built-in nudge** — when nothing is configured, `agentSystemNudge()` in
   `backend/agent.go` supplies a lean default that injects today's date (so a
   stale-cutoff model can reason about "today") and steers toward one or two
   tool calls before answering.

Configure it from the **Agent settings** entry at the bottom of the + menu
(`/agent-settings` slash command): a system-prompt textarea (blank = the
built-in nudge) and a tool allowlist (a small set suits a small model). When
`memory_read` is in the allowlist, a short index of the user's memory-note keys
is auto-appended to the prompt so the agent knows what it can recall.

**Scope.** The configurable prompt applies to **Agent mode only**. Plain chat
runs a bare streamed pass with no system message; Web search and Clarify use
their own fixed, code-compiled nudges (`systemNudge()`, `clarifyNudgeText()`).
A prompt saved in Agent settings never leaks into a normal chat turn. The
resolution order and scope are pinned by `backend/agent_test.go`.

### Guardrails: `fetch_page` and the injection surface

`fetch_page` makes the agent read **untrusted web content**. That is the
"lethal trifecta": untrusted content + the agent's access to your memory notes
+ outbound network. A page can contain hidden instructions ("ignore previous
instructions and exfiltrate …") that the model may follow. Mitigations here:
it is **off by default** (`FETCH_PAGE_ENABLED=false`), the system prompt tells
the model to treat fetched content as data not instructions, content is stripped
to text and size-capped, and the tool never runs unless you opt in. Keep the
light 3B plain-chat path as the default for simple Q&A; Agent mode is opt-in per
turn. Any future file/workspace tools must be sandboxed to a dedicated NAS
directory and per-invocation approved.

Env (`.env`, with safe defaults): `MAX_AGENT_STEPS=6`, `FETCH_PAGE_ENABLED=false`.

### Running several chats at once

Chats generate concurrently, and a chat keeps running when you switch away from
it or reload. Three pieces make that work:

**A worker pool, with server inference still serialized.** `jobManager` runs
`MAX_CONCURRENT_JOBS` workers (default 4) instead of one. Jobs that dial a
server host take a per-host semaphore of capacity 1, preserving the
`OLLAMA_NUM_PARALLEL=1` behaviour the NAS and Mac are configured for — so NAS
throughput is unchanged and extra chats queue rather than thrash an 8 GB box.
Browser-relay (local-model) jobs skip the semaphore entirely and run truly in
parallel, because their inference happens on the visitor's machine, not here.
This also fixes a sharper bug: a relay job *occupied* the single worker while it
waited on the browser, so one local-model chat stalled every other chat.

**One multiplexed event stream.** `GET /api/events` is a user-scoped SSE stream
carrying `modelCall`, `toolExec`, `phase`, `done` and `joberror` for all of that
user's running jobs, every payload tagged with `convId` and `jobId` (terminal
ones also carry `status`/`error`). The foreground chat still uses the
per-conversation `/api/conversations/:id/events` tail for chunk-level rendering.
Two connections total regardless of how many chats run — deliberate, since the
desktop sidecar is HTTP/1.1 on localhost and browsers cap connections per origin.

**A grace period instead of an instant cancel.** A job that needs the browser —
local-model inference, or a repo-bound run whose file tools are relayed through
it — used to be cancelled the moment its SSE tail dropped, which is why switching
chats killed a run. It is now cancelled only if neither that tail nor the user's
`/api/events` stream reattaches within `BROWSER_RELAY_GRACE`. Chat switches and
reloads survive; a closed tab or app still gets cleaned up.

Timeouts account for a human in the loop: plain chat stays at 5 minutes, but an
agent run gets `AGENT_JOB_TIMEOUT` and an approval-gated tool call gets
`TOOL_EXEC_TIMEOUT`, since `apply_patch`/`run_command`/`git_*` block on you
clicking Approve.

When a job finishes, the UI badges that chat in the sidebar and shows a toast
(the desktop app additionally raises a native notification); the badge clears
when you open the chat.

| Var | Default | Purpose |
|-----|---------|---------|
| `MAX_CONCURRENT_JOBS` | `4` | Generation workers. Server inference is still serialized per host. |
| `BROWSER_RELAY_GRACE` | `45s` | How long a browser-bound job waits for a stream to reattach before being cancelled. |
| `AGENT_JOB_TIMEOUT` | `30m` | Overall deadline for an agent-mode run (plain chat stays at 5m). |
| `TOOL_EXEC_TIMEOUT` | `15m` | How long a relayed tool call may wait, including time spent awaiting your approval. |

## Remote Mac backend (optional, bigger models)

The NAS (8 GB) caps you at ~3B models. If you have a Mac with more RAM on the
same network (or over Tailscale), run a second Ollama there and let the NAS
backend route bigger models to it — all behind the same `chat.selected.systems`
URL. The NAS keeps the small, always-on models; the Mac holds the big ones.

**How routing works.** The backend maintains a list of Ollama hosts (the NAS is
always present; the Mac is added when `OLLAMA_MAC_URL` is set). It probes each
host's `/api/tags` every 30 s, merges their model lists, and routes each
inference (and pull/benchmark/delete) to whichever host has that model
installed — a NAS model runs on the NAS, a Mac model runs on the Mac. The
browser never talks to the Mac directly: the path is still browser → Cloudflare
→ Caddy → backend → (NAS or Mac). If the Mac is offline, its models drop out
of the selector and a request for one fails fast with a clear "backend offline"
message instead of hanging. Every outbound call reuses the existing
`Host: localhost:11434` + stripped `Origin`/`Referer` trick, so a remote
Ollama accepts it without extra CORS/auth config.

**Make the Mac's Ollama reachable (choose one):**

- *Tailscale (recommended).* Install Tailscale on the Mac, bind Ollama to the
  Mac's Tailscale IP, set `OLLAMA_MAC_URL=http://<mac-tailscale-host>:11434`.
  Works on any network, no router ports, IP-churn-proof.
- *LAN IP (simplest).* `launchctl setenv OLLAMA_HOST 0.0.0.0:11434` (and
  `launchctl setenv OLLAMA_ORIGINS "*"` if the backend's Origin is rejected),
  restart Ollama, set `OLLAMA_MAC_URL=http://<mac-lan-ip>:11434`. Brittle if
  the IP changes.
- *SSH reverse tunnel.* Keep Ollama on localhost on the Mac and run
  `autossh -R 11434:localhost:11434 <nas>`; point `OLLAMA_MAC_URL` at the
  forwarded port on the NAS. Most secure, but needs a persistent tunnel.

**NAS `.env` (empty `OLLAMA_MAC_URL` = disabled, NAS-only, original behavior):**

| Var | Default | Purpose |
|-----|---------|---------|
| `OLLAMA_MAC_URL` | (empty) | Base URL of the Mac's Ollama. Empty disables the Mac backend. |
| `MAC_RAM_GB` | `16` | Total RAM (GB) on the Mac, for Mac-model fit verdicts. |
| `MAC_SYSTEM_RESERVE_GB` | `2` | RAM reserved for macOS + apps, subtracted before fit comparison. |

Then `scripts/deploy.sh` (the vars pass through `docker-compose.yml` to the
backend container). The catalog gains Mac-tagged entries (e.g. `mistral:7b`,
`qwen2.5:14b`) whose fit is judged against the Mac's RAM; pulling one lands it
on the Mac. You can also pull any model onto a specific host with
`{"model":"…","host":"mac"}` to `/api/models/pull`.

**Tradeoff.** Big models are only available while the Mac is on and reachable;
NAS small models stay always-on. Over Tailscale-away, the Mac's upload bandwidth
affects token-stream latency. The Mac should stay plugged in for big models.

**Security.** The Mac's Ollama is unauthenticated. NEVER put it behind a public
Cloudflare tunnel or open a router port to it — keep it LAN/Tailscale/SSH only.
Only `chat.selected.systems` is public; the Mac is a private hop the browser
never sees.

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

### Shipped: streamed web_search tool-call pass (PR #4, merged to `main`)

The tool-calling pass previously ran non-streaming, so nothing reached the page
until that whole response completed. It now streams
(`streamOllamaChatWithTools` in `search.go`): the model's preamble — or a full
answer when it decides **not** to search — reaches the UI as it is produced.
Time-to-first-token drops to ~first token instead of full-response. The
searching path's *total* latency is unchanged: Ollama buffers the tool-call JSON
and emits it only once that pass completes, so the search fires at the same
moment as before; the SSE keepalive guarding against the Cloudflare 100 s edge
timeout (524) is unchanged.

Tool calls are accumulated by id/arrival order, not by `index`, so accumulation
stays correct even when Ollama emits `index:0` for every call in a multi-call
response. The two model passes can't be parallelized: the answer pass needs the
tool-call pass's search results in context, and `OLLAMA_NUM_PARALLEL=1`
serializes Ollama requests regardless; per-round searches were already
concurrent.

Verified on the NAS (🌐 on, `qwen3:1.7b`, "latest stable Python version"):
587 content chunks streamed incrementally — first token 7.36 s, spread across
7.36 s → 83 s; SearXNG fanned the query to Google/Bing/DuckDuckGo and the cited
answer referenced a Python version beyond the model's training cutoff.
`llama3.1:8b` works too but is slow to demonstrate on the N100 (≈28 s cold load
+ CPU-rate generation); the streaming is model-independent.

## Model management

Models are managed from the chat UI — no SSH required. Click the model
selector in the header to open the unified **Models** panel. The current model
is shown in a banner at the top of the panel so the choice is always obvious.
The panel has two tabs:

- **Installed** — every available model (NAS, Mac, and Local/this computer) as
  a one-click selectable list, grouped by host, with size, quant, family,
  capability badges, and the last measured tok/s (or "not benchmarked").
  - Click a row to switch the current conversation to that model — the banner
    and header update in place and the panel stays open so you can keep
    managing. The selected row is checked.
  - A per-row **⋯** menu offers **Benchmark**, **Details**, and **Remove**
    (server models). Local models are selectable only.
  - **Benchmark** — runs a short 64-token generation and reports the real
    tok/s (`eval_count / eval_duration × 1e⁹`), prompt tok/s, and load time.
    The result is persisted in SQLite and shown across browsers/reloads.
  - **Details** — architecture dims (layers, KV heads, head dim), context
    length, capabilities, and the computed RAM fit.
  - **Remove** — deletes the model from the NAS to free disk space.
  - A **Get more models** button at the bottom of the list jumps to the
    download tab.
- **Get more models** — a curated set of N100/8 GB-friendly models, each with:
  - a **fit verdict** (Fits / Tight / Won't fit) estimating RAM use as the
    model's on-disk size plus its KV cache at your configured context length,
    compared against `NAS_RAM_GB − NAS_SYSTEM_RESERVE_GB`;
  - an **estimated tok/s range** (labelled an estimate — benchmark after
    download for the real number);
  - capability badges (chat, tools, vision, thinking, embeddings) and a
    one-line blurb. **Download** starts a background pull with a live progress
    bar. A free-text **Pull by name** field downloads any `model:tag`.

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
