# AGENTS.md — nas-llm

Read this before changing anything. It is self-contained: you should not need
`README.md` to make a correct change. `README.md` is an operations document
(NAS hardware, Cloudflare tunnel, deploy phases) — useful for understanding the
production system, not for finding code.

## What this is

A self-hosted LLM stack running in Docker on a UGREEN NAS. Two public hostnames
front the same Caddy instance, routed by `Host` header:

- `llm.selected.systems` — a pure OpenAI-compatible API (`/v1/*`), bearer-token
  auth, called by a browser extension. No accounts, no management routes.
- `chat.selected.systems` — a streaming chat UI, session-cookie auth, backed by
  a Go service that owns magic-link login, SQLite history, background
  generation, web search, and agent mode.

Request path: Cloudflare → `cloudflared` (outbound-only tunnel) → Caddy `:8080`
→ either Ollama `:11434` (`/v1/*`) or the Go backend `:8081` (`/api/*`).
Ollama and SearXNG are never published outside the internal Docker network.

## Repo map

Four surfaces. Each code directory has its own `AGENTS.md` with a file-level
map — read that one before working in it.

- `backend/` — the Go service (`package main`, ~20 flat files). Owns all
  `/api/*` routes, auth, SQLite, job/SSE machinery, agent mode, web search,
  and model management. See `backend/AGENTS.md`.
- `www/` — the browser chat UI. Vanilla JS, ES modules, **no build step**.
  Served as static files by Caddy. See `www/AGENTS.md`.
- `desktop/` — a Tauri 2 shell that wraps the same `www/` UI and proxies
  `/api/*` to the NAS through a local Rust sidecar. See `desktop/AGENTS.md`.
- Deployment — `docker-compose.yml`, `Caddyfile`, `searxng/settings.yml`, and
  `scripts/`. Targets the live NAS; see "Never run these" below.

Supporting files:

- `.env.example` — every configurable variable, with comments. `.env` is
  gitignored and holds real secrets. Never commit it, never print its contents.
- `ai/` — task lists, design docs, and release logs (see below).

## Verify your work

Run this from the repo root:

```sh
make check
```

It runs `gofmt -l`, `go vet ./...`, and `go test ./...` in `backend/`, then
`cargo check` in `desktop/src-tauri`. All of it passes on a clean checkout, so
any failure is either yours or an environment problem — do not "fix" unrelated
code to make it pass.

Narrower targets: `make check-backend`, `make test`, `make fmt`,
`make check-desktop`. Run `make help` for the full list.

**What `make check` cannot tell you.** There is no automated coverage for
`www/` (vanilla JS, no build or lint step) and no end-to-end test. Anything
touching the UI, streaming behaviour, or a real model needs a human to look at
it on the NAS. If your change is UI-only, say so plainly in your summary rather
than claiming it is verified.

## Running it locally

The Go unit tests are the only fully offline loop, and they are fast — prefer
them.

To run the backend itself, override the three settings that default to
container values:

```sh
make run-backend    # or, equivalently:
cd backend && SESSION_SECRET=dev-secret DB_PATH=./dev.db \
  OLLAMA_URL=http://127.0.0.1:11434 BACKEND_PORT=8081 go run .
```

`SESSION_SECRET` is mandatory — the process calls `log.Fatalf` without it.
`DB_PATH` defaults to `/data/nas-llm.db` (a container path) and `OLLAMA_URL`
defaults to `http://ollama:11434` (Docker DNS), so both must be overridden
outside Docker.

Two things to know before you try to see the UI:

- **The backend does not serve `www/`.** It registers `/api/*` only
  (`backend/main.go` `routes()`). Caddy serves the static files, and the chat
  site block is matched on `http://chat.selected.systems:8080`
  (`Caddyfile:65`), so pointing a browser at a local Caddy needs a `Host`
  override.
- **The compose stack targets the NAS.** `docker-compose.yml` expects
  `${DOCKER_VOLUME}` paths and a filled-in `.env`. Running it locally is not a
  supported path.

The desktop app serves `www/` itself through its sidecar and is the easiest way
to exercise the real UI; `desktop/README.md` documents a headless probe of that
sidecar that needs no window.

## Conventions that will bite you

### Static assets are cache-busted by hand

Asset URLs carry a manual `?v=N` query string. **If you edit one of these files
and do not bump its version, your change will not reach a cached browser.** The
number lives in a different file from the asset — and for the desktop app, in
Rust source. Five locations:

- edit `www/styles.css` → bump `styles.css?v=N` in `www/index.html`
- edit `www/app.js` → bump `app.js?v=N` in `www/index.html`
- edit `www/lib.js` → bump `./lib.js?v=N` in the import at `www/app.js:3`
- edit `desktop/renderer/desktop.css` → bump `desktop.css?v=N` in
  `desktop/src-tauri/src/sidecar.rs`
- edit `desktop/renderer/desktop.js` → bump `desktop.js?v=N` in
  `desktop/src-tauri/src/sidecar.rs`

The `www` and `desktop` version counters are independent; bump only the ones
whose files you touched.

### Branch model

- Work happens on `main`. Feature branches are cut from `main` and merged back
  by PR.
- `production` is the release branch: `main` → `production` by PR.
- The NAS is deployed from `main`.
- Do not commit directly to `main` or `production`, and do not target
  `production` with a feature PR.

Branch names follow `feat/`, `fix/`, `docs/`, or `chore/` prefixes.

### Commits

Conventional Commits, with a scope matching the surface you touched —
`feat(desktop):`, `fix(agent):`, `docs(ai):`, `chore(release):`.

Desktop release notes are generated from commit subjects since the previous
tag, so subjects become user-visible changelog entries. Write them accordingly.

End every commit message with:

```
Co-Authored-By: Warp <agent@warp.dev>
```

### Task and design docs live in `ai/`

Plans, phased task lists, and release logs go in `ai/` as markdown — that is
where the existing ones are and where they are expected. Do not scatter
`NOTES.md` or `SUMMARY.md` files around the repo, and do not write a summary
file when a message to the user would do.

### Desktop version bumps

The app version appears in `desktop/package.json`,
`desktop/src-tauri/tauri.conf.json`, and `desktop/src-tauri/Cargo.toml`. Use
`scripts/bump-desktop-version.sh` so they cannot drift.

## Never run these

Each of these reads secrets from `.env` and acts on the live NAS over SSH.
None of them is a test. Do not run them to "verify" anything — ask the user.

- `scripts/deploy.sh` — tars `.env` and the stack to the NAS and restarts the
  production containers.
- `scripts/smoke-test.sh` — sources `.env`, curls the public endpoint with the
  real bearer token, and SSHes into the NAS.
- `scripts/pull-models.sh` — `docker exec`s against the NAS's Ollama.

Also: never print, echo, or commit `.env`. Never publish Ollama's port 11434 or
SearXNG's port — the compose file deliberately omits `ports:` for both, and the
smoke test asserts 11434 is unreachable.

## Where things are

- API routes — `backend/main.go`, `routes()`
- Agent mode / ReAct loop and tool registry — `backend/agent.go`
- Background generation, job queue, SSE event hub — `backend/jobs.go`
- Clarifying questions / `ask_user` — `backend/clarify.go`, rendered by
  `renderClarifyCard` in `www/lib.js`
- Web search / SearXNG — `backend/search.go`, config in `searxng/settings.yml`
- Model management, catalog, benchmarks — `backend/models.go`,
  `backend/library.go`, `backend/registry.go`
- Multi-host Ollama routing (NAS + optional Mac) — `backend/hosts.go`
- Magic-link auth and sessions — `backend/auth.go`, `backend/email.go`
- SQLite schema and queries — `backend/store.go`
- Desktop sidecar (proxy, asset injection, control plane) —
  `desktop/src-tauri/src/sidecar.rs`
