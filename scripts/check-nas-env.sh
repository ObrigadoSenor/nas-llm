#!/usr/bin/env bash
# Diagnose the NAS Docker environment that scripts/deploy.sh depends on.
#
# READ-ONLY: connects over SSH and runs only inspection commands. It does NOT
# build, restart, or modify any container or volume. With --deep it optionally
# runs a throwaway `docker run --rm alpine:3.20` to test egress from inside a
# container (pulls alpine:3.20 only if the image is not already cached locally).
#
# It sources .env the same way deploy.sh does, to learn NAS_HOST / NAS_USER /
# DOCKER_VOLUME. It never prints secrets — only those three connection/path
# values are referenced from .env.
#
# Usage:
#   scripts/check-nas-env.sh            # fast, host-level checks
#   scripts/check-nas-env.sh --deep     # also test egress from inside a container
#   scripts/check-nas-env.sh --help
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

usage() {
  sed -n '2,17p' "$0"
}

if [[ ! -f "$ROOT_DIR/.env" ]]; then
  echo "ERROR: $ROOT_DIR/.env not found. Copy .env.example to .env and fill it in." >&2
  exit 1
fi
set -a; . "$ROOT_DIR/.env"; set +a

: "${NAS_HOST:?NAS_HOST must be set in .env}"
: "${NAS_USER:=root}"
: "${DOCKER_VOLUME:=/volume1}"
REMOTE="${NAS_USER}@${NAS_HOST}"

# Guard the one .env value we forward to the remote (it is embedded in the SSH
# command line, so reject anything that isn't a plain path).
case "$DOCKER_VOLUME" in
  ""|*[!A-Za-z0-9/_-]*)
    echo "ERROR: DOCKER_VOLUME ('$DOCKER_VOLUME') must be a plain path (A-Z a-z 0-9 / _ -)." >&2
    exit 1;;
esac

DEEP=0
for arg in "$@"; do
  case "$arg" in
    --deep) DEEP=1;;
    -h|--help) usage; exit 0;;
    *) echo "ERROR: unknown arg '$arg' (try --deep or --help)" >&2; exit 1;;
  esac
done

if [[ "$DEEP" == "1" ]]; then
  echo "==> Probing ${REMOTE} (DOCKER_VOLUME=${DOCKER_VOLUME}) [deep]"
else
  echo "==> Probing ${REMOTE} (DOCKER_VOLUME=${DOCKER_VOLUME})"
fi
echo

# Single SSH connection. DOCKER_VOLUME / DEEP are injected as env vars on the
# remote command line; the heredoc body is sent verbatim (quoted 'REMOTE').
set +e
ssh "$REMOTE" "DOCKER_VOLUME='$DOCKER_VOLUME' DEEP='$DEEP' bash -s" <<'REMOTE'
set -u
DV="${DOCKER_VOLUME:-/volume1}"
DEEP="${DEEP:-0}"

ok()   { printf '  [ \033[32mPASS\033[0m ] %s\n' "$1"; }
no()   { printf '  [ \033[31mFAIL\033[0m ] %s\n' "$1"; }
info() { printf '  [ \033[36mINFO\033[0m ] %s\n' "$1"; }
hdr()  { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

# --- Connectivity / host ----------------------------------------------------
hdr "Host"
info "uname: $(uname -srm 2>/dev/null || echo '?')"
if [[ -f /etc/os-release ]]; then
  . /etc/os-release 2>/dev/null || true
  info "os:    ${PRETTY_NAME:-${ID:-unknown}}"
else
  info "os:    (no /etc/os-release)"
fi
info "arch:  $(uname -m 2>/dev/null || echo '?')"
if [[ -f /etc/.ugos_version ]]; then
  info "ugos:  $(cat /etc/.ugos_version 2>/dev/null || echo 'present, version unknown')"
fi

# --- Docker daemon ----------------------------------------------------------
hdr "Docker daemon"
if command -v docker >/dev/null 2>&1; then
  info "docker: $(docker --version 2>/dev/null || echo 'present, --version failed')"
  if docker info >/dev/null 2>&1; then
    info "server:  $(docker info --format '{{.ServerVersion}}' 2>/dev/null || echo '?')"
    info "storage: $(docker info --format '{{.Driver}}' 2>/dev/null || echo '?')"
    info "cgroup:  $(docker info --format '{{.CgroupVersion}}' 2>/dev/null || echo '?')"
    ok "docker daemon responds"
  else
    no "docker daemon not reachable (docker info failed) — service down or no perms?"
  fi
else
  no "docker CLI not found on PATH"
fi

# --- Docker Compose (PRIMARY CHECK) -----------------------------------------
# deploy.sh runs:  docker compose ... up -d --build   (Compose v2 plugin)
hdr "Docker Compose  <==  what deploy.sh actually invokes"
if command -v docker >/dev/null 2>&1 && docker compose >/dev/null 2>&1; then
  V="$(docker compose version --short 2>/dev/null || docker compose version 2>/dev/null | head -1)"
  ok "Compose v2 plugin present: ${V:-version unknown}"
  projs="$(docker compose ls --format '{{.Name}}' 2>/dev/null | paste -sd, -)"
  info "active compose projects: ${projs:-none}"
else
  no "Compose v2 plugin MISSING — 'docker compose' is not a docker subcommand"
  info "deploy.sh will fail at its final 'ssh ... up -d --build' step"
  if command -v docker-compose >/dev/null 2>&1; then
    info "standalone docker-compose (v1) found: $(docker-compose version 2>/dev/null | head -1 || echo 'version unknown')"
    info "note: deploy.sh hardcodes 'docker compose' and will NOT use docker-compose as-is"
  else
    no "standalone docker-compose (v1) also absent"
  fi
  info "fix: install the Compose v2 plugin — apt: docker-compose-plugin; or drop the"
  info "     'compose' binary into ~/.docker/cli-plugins/ (chmod +x) on the NAS"
fi

# --- Existing nas-llm state -------------------------------------------------
hdr "Existing nas-llm containers / images"
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  ctrs="$(docker ps -a --format '{{.Names}} {{.Status}}' 2>/dev/null \
          | grep -E 'ollama|caddy|backend|searxng|cloudflared' | paste -sd\; -)"
  info "containers: ${ctrs:-none running/created}"
  imgs="$(docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null \
          | grep -E 'ollama|caddy|backend|searxng|alpine|golang' | paste -sd, -)"
  info "images:     ${imgs:-none cached}"
fi

# --- Disk space on the data volume ------------------------------------------
hdr "Disk space"
if [[ -d "$DV" ]]; then
  info "$DV: $(df -h "$DV" 2>/dev/null | awk 'NR==2{print $2" total, "$4" free ("$5" used)"}')"
  ok "DOCKER_VOLUME exists"
else
  no "DOCKER_VOLUME '$DV' does not exist on the NAS — check .env DOCKER_VOLUME"
  info "mounts present:"
  df -h 2>/dev/null | awk 'NR==1 || /^\/volume/'
fi

# --- Build-time internet egress (needed by 'up --build') --------------------
hdr "Build-time internet egress  <==  needed by 'up --build'"
host_egress() {
  url="$1"; label="$2"
  if command -v wget >/dev/null 2>&1; then
    if wget -q -T 8 -O /dev/null "$url"; then ok "host -> $label"; else no "host -> $label FAILED ($url)"; fi
  elif command -v curl >/dev/null 2>&1; then
    if curl -fsS -m 8 -o /dev/null "$url"; then ok "host -> $label"; else no "host -> $label FAILED ($url)"; fi
  else
    info "neither wget nor curl on host; skipped $label"
  fi
}
host_egress "https://proxy.golang.org/" "proxy.golang.org (Go modules)"
host_egress "https://dl-cdn.alpinelinux.org/alpine/v3.20/main/x86_64/APKINDEX.tar.gz" "Alpine apk mirror"

if [[ "$DEEP" == "1" ]] && command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  echo
  info "deep: testing egress from inside a container (alpine:3.20)..."
  if docker image inspect alpine:3.20 >/dev/null 2>&1; then
    if docker run --rm alpine:3.20 sh -c \
        'wget -q -T 8 -O /dev/null https://proxy.golang.org/ && \
         wget -q -T 8 -O /dev/null https://dl-cdn.alpinelinux.org/alpine/v3.20/main/x86_64/APKINDEX.tar.gz' \
        2>/dev/null; then
      ok "container -> proxy.golang.org + Alpine mirror"
    else
      no "container CANNOT reach the internet — 'up --build' will fail mid-build"
      info "check Docker bridge DNS / NAT / firewall on the NAS"
    fi
  else
    info "alpine:3.20 not cached; skipping container test. Run 'docker pull alpine:3.20' to enable it."
  fi
elif [[ "$DEEP" != "1" ]]; then
  info "re-run with --deep to also test egress from inside a container"
fi

printf '\n\033[1m== Done ==\033[0m\n'
REMOTE
rc=$?
set -e

echo
if [[ $rc -ne 0 ]]; then
  echo "==> Remote probing exited with code $rc (SSH problem or an unset-var error above)." >&2
  exit "$rc"
fi
echo "==> Diagnostic complete."
