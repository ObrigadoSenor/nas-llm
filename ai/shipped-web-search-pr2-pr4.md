# Shipped: web-search speedup, Stop button, and the streamed tool-call pass

Release notes for PR #2 and PR #4, moved here from `README.md` so that file can
stay an operations document. Kept verbatim for the historical record.

## PR #2 — web-search speedup + Stop button (merged to `production`)

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

Remaining at the time (manual, needs a magic-link session on
https://chat.selected.systems):

- **Speed:** 🌐 on, ask a time-sensitive question — expect `🔍 searching: <query>`
  then a cited answer sooner than before (one round, not up to three).
- **Stop:** send a question, click ⏹ Stop mid-generation — the reply halts and
  the partial text is saved; send again → works normally.

Optional: set `MAX_SEARCH_ROUNDS=2` in `.env` + redeploy if single-round answers
feel too shallow for multi-part questions.

## PR #4 — streamed web_search tool-call pass (merged to `main`)

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
