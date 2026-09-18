#!/usr/bin/env bash
# Deploy the nas-llm stack to the UGREEN NAS over SSH.
#
# rsyncs docker-compose.yml + Caddyfile + .env to ${DOCKER_VOLUME}/docker/nas-llm
# on the NAS, then runs `docker compose up -d` there. cloudflared is started
# only when TUNNEL_TOKEN is set (via the `tunnel` profile).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ ! -f "$ROOT_DIR/.env" ]]; then
  echo "ERROR: $ROOT_DIR/.env not found. Copy .env.example to .env and fill it in." >&2
  exit 1
fi
set -a; . "$ROOT_DIR/.env"; set +a

: "${NAS_HOST:?NAS_HOST must be set in .env}"
: "${NAS_USER:=root}"
: "${DOCKER_VOLUME:=/volume1}"
REMOTE_DIR="${DOCKER_VOLUME}/docker/nas-llm"
REMOTE="${NAS_USER}@${NAS_HOST}"

echo "==> Syncing stack to ${REMOTE}:${REMOTE_DIR}"
# Ensure data volumes exist, then clear stale source so files removed from the
# repo don't linger on the NAS. tar -xf only writes entries present in the
# archive, so a deleted agent.go survived next to the new agent_loop.go /
# agent_compact.go / agent_eval.go / agent_capture.go and redeclared their
# symbols, failing the build. Mirror www, searxng, and backend's source fresh
# each deploy; preserve backend/data (SQLite volume) — ollama/ and caddy
# {data,config}/ are never in the tar, so they're untouched.
ssh "$REMOTE" "mkdir -p ${REMOTE_DIR}/ollama ${REMOTE_DIR}/caddy/data ${REMOTE_DIR}/caddy/config ${REMOTE_DIR}/backend/data && rm -rf ${REMOTE_DIR}/www ${REMOTE_DIR}/searxng && find ${REMOTE_DIR}/backend -mindepth 1 -maxdepth 1 ! -name data -exec rm -rf -- {} +"
# UGOS Pro ships a restricted rsync wrapper (ug_start_server) that rejects
# /volume1/docker paths, so pipe the files over plain SSH with tar instead.
tar -cf - -C "$ROOT_DIR" docker-compose.yml Caddyfile .env www backend searxng \
  | ssh "$REMOTE" "tar -xf - -C '${REMOTE_DIR}'"
ssh "$REMOTE" "chmod 600 ${REMOTE_DIR}/.env"

COMPOSE=(docker compose --project-directory "$REMOTE_DIR" -f "$REMOTE_DIR/docker-compose.yml")
if [[ -n "${TUNNEL_TOKEN:-}" ]]; then
  # --profile must precede the subcommand on older compose (v2.26).
  COMPOSE+=(--profile tunnel)
  echo "==> TUNNEL_TOKEN set: starting ollama + caddy + backend + cloudflared"
else
  echo "==> No TUNNEL_TOKEN: starting ollama + caddy + backend only (LAN mode)"
fi
COMPOSE+=(up -d --build)

echo "==> Bringing stack up on the NAS"
ssh "$REMOTE" "${COMPOSE[*]}"

echo "==> Done. LAN endpoint: http://${NAS_HOST}:8080/v1/models"
echo "    Smoke test: scripts/smoke-test.sh"
