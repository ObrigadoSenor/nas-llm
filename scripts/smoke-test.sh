#!/usr/bin/env bash
# Smoke-test the nas-llm endpoint.
#
# Defaults to the LAN endpoint http://$NAS_HOST:8080 (phase 2/5).
# For off-network validation (phase 6) run:
#   ENDPOINT=https://llm.selected.systems scripts/smoke-test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
set -a; . "$SCRIPT_DIR/../.env"; set +a
: "${NAS_HOST:?NAS_HOST must be set in .env}"
: "${API_BEARER_TOKEN:?API_BEARER_TOKEN must be set in .env}"
: "${OLLAMA_MODEL:=llama3.2:3b}"

ENDPOINT="${ENDPOINT:-http://${NAS_HOST}:8080}"
CHAT_BASE="${CHAT_BASE:-http://${NAS_HOST}:8080}"
CHAT_HOST="${CHAT_HOST:-chat.selected.systems}"
AUTH="Authorization: Bearer ${API_BEARER_TOKEN}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
pass=0; fail=0
ok()   { echo "PASS: $1"; pass=$((pass+1)); }
bad()  { echo "FAIL: $1"; fail=$((fail+1)); }

echo "Endpoint: $ENDPOINT"

# 1. Unauthenticated -> 401
code=$(curl -s -o /dev/null -w '%{http_code}' "$ENDPOINT/v1/models")
[[ "$code" == 401 ]] && ok "unauthenticated /v1/models rejected (401)" || bad "unauthenticated /v1/models expected 401 got $code"

# 2. Authenticated /v1/models -> 200
code=$(curl -s -o "$TMP/models.json" -w '%{http_code}' -H "$AUTH" "$ENDPOINT/v1/models")
[[ "$code" == 200 ]] && ok "authenticated /v1/models succeeds (200)" || bad "authenticated /v1/models expected 200 got $code"

# 3. OPTIONS preflight -> 204 + CORS headers
code=$(curl -s -o /dev/null -w '%{http_code}' -D "$TMP/pf.txt" -X OPTIONS \
  -H "Origin: chrome-extension://test" \
  -H "Access-Control-Request-Method: POST" \
  -H "Access-Control-Request-Headers: authorization,content-type" \
  "$ENDPOINT/v1/chat/completions")
[[ "$code" == 204 ]] && ok "OPTIONS preflight returns 204" || bad "OPTIONS preflight expected 204 got $code"
grep -qi '^access-control-allow-origin:' "$TMP/pf.txt" && ok "preflight sends Access-Control-Allow-Origin" || bad "preflight missing Access-Control-Allow-Origin"
grep -qi 'authorization' "$TMP/pf.txt" && ok "preflight allows Authorization header" || bad "preflight does not allow Authorization header"

# 4. Non-/v1 path -> 404 (Ollama management routes unreachable)
code=$(curl -s -o /dev/null -w '%{http_code}' -H "$AUTH" "$ENDPOINT/api/delete")
[[ "$code" == 404 ]] && ok "non-/v1 path /api/delete returns 404" || bad "non-/v1 path /api/delete expected 404 got $code"

# 5. Ollama port 11434 must NOT be reachable from here (LAN mode only)
if [[ "$ENDPOINT" == "http://${NAS_HOST}:8080" ]]; then
  if curl -s -o /dev/null -w '%{http_code}' --connect-timeout 3 "http://${NAS_HOST}:11434/api/tags" >"$TMP/11434" 2>/dev/null; then
    bad "port 11434 is reachable (HTTP $(cat "$TMP/11434")) — Ollama must never be published"
  else
    ok "port 11434 not reachable from here"
  fi
fi

# 6. Authenticated streaming chat -> 200 (only if a model is pulled)
nmodels=$(grep -o '"id"' "$TMP/models.json" 2>/dev/null | wc -l | tr -d ' ')
if [[ "$nmodels" -gt 0 ]]; then
  code=$(curl -s -o /dev/null -w '%{http_code}' -H "$AUTH" -H 'Content-Type: application/json' \
    -d "{\"model\":\"$OLLAMA_MODEL\",\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"Say hello in one word.\"}]}" \
    "$ENDPOINT/v1/chat/completions")
  [[ "$code" == 200 ]] && ok "authenticated streaming /v1/chat/completions (200)" || bad "streaming /v1/chat/completions expected 200 got $code"
else
  echo "SKIP: streaming test (no models yet — run: scripts/pull-models.sh pull $OLLAMA_MODEL)"
fi

# 7. Chat /api/* requires a session -> 401 without a cookie
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: ${CHAT_HOST}" "${CHAT_BASE}/api/auth/me")
[[ "$code" == 401 ]] && ok "chat /api/auth/me rejects no session (401)" || bad "chat /api/auth/me expected 401 got $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: ${CHAT_HOST}" "${CHAT_BASE}/api/models")
[[ "$code" == 401 ]] && ok "chat /api/models rejects no session (401)" || bad "chat /api/models expected 401 got $code"

# 7b. Background-generation endpoints are session-gated too (return 401 without
#     a cookie; confirms the routes are registered + auth-protected). The full
#     generate->events->job flow needs a session + a pulled model, so it stays a
#     manual browser test (see ai/tasks.md).
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: ${CHAT_HOST}" "${CHAT_BASE}/api/jobs/active")
[[ "$code" == 401 ]] && ok "chat /api/jobs/active rejects no session (401)" || bad "chat /api/jobs/active expected 401 got $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: ${CHAT_HOST}" "${CHAT_BASE}/api/conversations/fakeid/job")
[[ "$code" == 401 ]] && ok "chat /api/conversations/{id}/job rejects no session (401)" || bad "chat /api/conversations/{id}/job expected 401 got $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: ${CHAT_HOST}" "${CHAT_BASE}/api/conversations/fakeid/events")
[[ "$code" == 401 ]] && ok "chat /api/conversations/{id}/events rejects no session (401)" || bad "chat /api/conversations/{id}/events expected 401 got $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: ${CHAT_HOST}" -X POST -H 'Content-Type: application/json' -d '{}' "${CHAT_BASE}/api/conversations/fakeid/generate")
[[ "$code" == 401 ]] && ok "chat /api/conversations/{id}/generate rejects no session (401)" || bad "chat /api/conversations/{id}/generate expected 401 got $code"
code=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: ${CHAT_HOST}" -X POST "${CHAT_BASE}/api/conversations/fakeid/cancel")
[[ "$code" == 401 ]] && ok "chat /api/conversations/{id}/cancel rejects no session (401)" || bad "chat /api/conversations/{id}/cancel expected 401 got $code"

# 8. SearXNG internal JSON search (no published port — reach it from the
#    backend container on the internal network). LAN endpoint only; the
#    full web_search tool loop needs a session + a pulled model, so it is a
#    manual browser test (see ai/tasks.md Phase 10).
if [[ "$ENDPOINT" == "http://${NAS_HOST}:8080" ]]; then
  sx=$(ssh "${NAS_USER:-root}@${NAS_HOST}" "docker exec backend wget -q -O- 'http://searxng:8080/search?q=ollama&format=json' 2>/dev/null" 2>/dev/null || true)
  if printf '%s' "$sx" | grep -q '"results"'; then
    ok "SearXNG internal JSON search reachable from backend"
  else
    bad "SearXNG internal JSON search not usable from backend (searxng up? json format enabled in searxng/settings.yml?)"
  fi
fi

echo
echo "Results: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
