#!/usr/bin/env bash
# Manage Ollama models on the NAS via `docker exec` over SSH.
#
# Usage:
#   scripts/pull-models.sh pull llama3.2:3b
#   scripts/pull-models.sh list
#   scripts/pull-models.sh rm   qwen2.5:3b
#   scripts/pull-models.sh run  llama3.2:3b   # interactive chat over SSH
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
set -a; . "$SCRIPT_DIR/../.env"; set +a
: "${NAS_HOST:?NAS_HOST must be set in .env}"
: "${NAS_USER:=root}"
REMOTE="${NAS_USER}@${NAS_HOST}"

CMD="${1:-list}"
shift || true

case "$CMD" in
  pull)   ssh "$REMOTE" "docker exec ollama ollama pull $*" ;;
  list|ls) ssh "$REMOTE" "docker exec ollama ollama list" ;;
  rm|delete) ssh "$REMOTE" "docker exec ollama ollama rm $*" ;;
  run)    ssh -t "$REMOTE" "docker exec -it ollama ollama run $*" ;;
  ps)     ssh "$REMOTE" "docker exec ollama ollama ps" ;;
  *) echo "Usage: $0 {pull|list|rm|run|ps} [model]" >&2; exit 2 ;;
esac
