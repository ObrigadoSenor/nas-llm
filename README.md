# nas-llm

A single secure **public OpenAI-compatible HTTPS API endpoint** running on a
UGREEN NASync DXP2800 (Intel N100, 8 GB), called by a browser extension, with
**no router ports opened**. There is no web chat page and no user accounts — the
NAS serves an API only, and model management is done with the `ollama` CLI over
SSH.

```
Browser extension (Bearer token)
  → Cloudflare edge (TLS + WAF + rate limit)
  → cloudflared (outbound-only tunnel, no open ports)
  → Caddy :8080 (CORS preflight, bearer check, Host rewrite, stream flush)
  → Ollama :11434 (internal network only — never published)
  → Models on NVMe
```

Endpoint: **`https://llm.selected.systems`** (OpenAI-compatible: `/v1/chat/completions`, `/v1/models`, `/v1/embeddings`).

Chat UI: **`https://chat.selected.systems`** — a minimal streaming chat page (static HTML in `www/`, no secrets baked in; the bearer token is entered in the browser and stored in localStorage). The page calls the API cross-origin (CORS is already configured on the API host). Both hostnames route through the same Cloudflare Tunnel to the same Caddy instance, which routes by Host header — this keeps `llm.selected.systems` pure-API.

## Files

| File | Purpose |
|------|---------|
| `docker-compose.yml` | ollama (no `ports:`), caddy (`:8080`), cloudflared (`tunnel` profile) |
| `Caddyfile` | CORS preflight bypass, bearer check, `/v1/*` allowlist, Host rewrite, streaming |
| `.env.example` / `.env` | NAS access, volume, tunnel token, bearer token, model, CORS origin |
| `scripts/deploy.sh` | rsync the stack to the NAS and `docker compose up -d` |
| `scripts/pull-models.sh` | `docker exec ollama ollama ...` over SSH |
| `scripts/smoke-test.sh` | auth / CORS / allowlist / port-isolation / streaming checks |
| `ai/tasks.md` | phased task list |

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
With no `TUNNEL_TOKEN`, this starts **ollama + caddy** (LAN mode). Once
`TUNNEL_TOKEN` is set it also starts **cloudflared**.

## Pull / swap models

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
