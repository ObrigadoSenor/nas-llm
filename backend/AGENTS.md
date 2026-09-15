# backend/ — Go backend service code map

`package main` HTTP server driving Ollama for chat, web search, agent runs, and model management. ~11k lines, 20 flat `.go` files, no subpackages.

## File responsibility map

- `main.go` — entry point; `config` struct (`:13-69`), `server` struct (`:71-89`), env helpers (`:170-221`), `main()` wiring (`:95-168`), `routes()` (`:234-281`), `requireAuth` middleware (`:283-293`)
- `agent.go` (~1500 lines) — ReAct agent loop (`runAgentLoop:493`), tool registry (`toolRegistry:163`), file/git/search/memory tool schemas (incl. `write_file`/`edit_file`/`delete_path`/`move_path`), narration guards, prose tool-call recovery (`extractProseToolCall:752`), context compaction (`maybeCompact:1449`), safe arithmetic evaluator (`evalExpr:1040`), `fetch_page` tool, agent config resolution (`agentConfig:99`). `localRepoTools` = `localFileTools` + `localGitTools`; `injectRepoContext` (git) vs `injectWorkspaceContext` (non-git workspace). `todo_write`/`todo_read` (Tasks Pill) + `planWriteTools`/`filterPlanWriteTools`/`injectPlanContext` (Plan mode)
- `jobs.go` (~1400 lines) — `job` struct (`:60`), `jobManager` worker pool (`:822`), `eventHub` per-user SSE multiplexer (`:736`), `runGeneration` dispatch (`:1088`), `runStreamPass` (`:1298`), `streamFromOllama` (`:1314`), SSE emit/broadcast, grace-period cancel for browser-bound jobs
- `models.go` (~1300 lines) — Ollama native API types, `curatedCatalog` (`:528`), `pullManager`/`pullJob` (`:331`), KV-cache estimation (`estimateKV:664`), fit verdicts (`verdictFor:671`), `runBenchmark` (`:1075`), `supportsTools` capability check (`:1273`), model management handlers
- `handlers.go` (~1100 lines) — auth/conversation/folder/generation/SSE/agent-config/repo handlers, `handleChat` proxy (`:358`), `handleGenerate` (`:431`), `handleEvents` per-conversation SSE (`:551`), `handleUserEvents` per-user SSE (`:795`), browser relay endpoints, `buildProxy` (`:335`)
- `store.go` (~900 lines) — SQLite via `modernc.org/sqlite` (pure-Go, CGO-free); schema (`:100-192`), migrations (`:235`), CRUD for conversations/folders/jobs/repos/notes/settings/benchmarks, `reconcileJobs` on restart (`:685`), `agent_checkpoints` table + `save/load/deleteCheckpoint` for pause/resume. `Repo` carries `UseGit` + `Name` (workspace model: a non-git workspace is a `Repo` with `UseGit=false`); `repos` table has `use_git`/`name` columns. `Conversation` carries `Todos` (Tasks Pill) + `PlanMode`/`Plan`/`PlanApproved` (Plan mode); `conversations` table has `todos`/`plan_mode`/`plan`/`plan_approved` columns
- `search.go` — `runSearchLoop` (`:144`), SearXNG client (`runWebSearch:377`), OpenAI chat schema types (`oaiMessage`/`oaiTool`/`chatRequest`), streaming tool-call accumulator (`streamOllamaChatWithTools:251`), `handleChatWithSearch` (`:455`)
- `clarify.go` — `askUserTool`, `runAskUserPass`/`runClarifyLoop` (`:130`), `parseClarifyQuestions`, prose-question fallback detector (`detectClarifyFromContent:287`), clarify round counter
- `relay.go` — `modelBackend` interface (`:22`), `directOllama` server-side backend (`:30`), `browserRelay` local-model backend (`:54`), `contentText`
- `registry.go` — OCI manifest fetching for pre-download sizing (`fetchManifest:147`), `parseModelRef` (`:40`), `handleModelPreflight` (`:263`), manifest cache, fit computation
- `library.go` — ollama.com/search HTML scraper (`scrapeOllamaLibrary:111`), per-model tags scraper (`scrapeOllamaModelTags:237`), `handleModelLibrary`/`handleModelLibraryTags`
- `hosts.go` — multi-host routing: `host` struct (`:17`), `hostRegistry` (`:51`), `onlineHostForModel` (`:128`), `probeHost` (`:194`), per-host online state + tags cache
- `auth.go` — HMAC-signed session cookies (`:23`), magic-link token generation/verification, `rateLimiter` (`:105`)
- `email.go` — `mailer` interface + `brevoMailer` (Brevo API, `:16`)

## Route map (`main.go:234-281`)

40 routes under `/api/*`. `health` + `auth/*` are public; everything else is behind `requireAuth` (session cookie → `ctxEmail` in context).

**Public:**
- `GET /api/health` — inline "ok"
- `POST /api/auth/request` → `handleAuthRequest` / `GET /api/auth/verify` → `handleAuthVerify` / `GET /api/auth/me` → `handleAuthMe` / `POST /api/auth/logout` → `handleAuthLogout` (handlers.go)

**Models (requireAuth):**
- `GET /api/models` → `handleModels` / `GET /api/models/catalog` → `handleModelCatalog` (models.go)
- `GET /api/models/library` → `handleModelLibrary` / `GET /api/models/library/tags` → `handleModelLibraryTags` (library.go)
- `GET /api/models/preflight` → `handleModelPreflight` (registry.go)
- `POST /api/models/pull` → `handleModelPull` / `GET /api/models/pulls/active` → `handleActivePulls` / `GET /api/models/pull/{jobId}/events` → `handlePullEvents` / `POST /api/models/pull/{jobId}/cancel` → `handlePullCancel` (models.go)
- `DELETE /api/models/{name}` → `handleModelDelete` / `POST /api/models/{name}/benchmark` → `handleModelBenchmark` / `GET /api/models/{name}/info` → `handleModelInfo` (models.go)

**Chat & jobs/events (requireAuth):**
- `POST /api/chat/completions` → `handleChat` (handlers.go)
- `GET /api/jobs/active` → `handleActiveJobs` / `GET /api/events` → `handleUserEvents` (handlers.go)

**Conversations (requireAuth, all handlers.go):**
- `GET /api/conversations` → `handleListConversations` / `GET /api/conversations/{id}` → `handleGetConversation`
- `POST /api/conversations` → `handleCreateConversation` / `PUT /api/conversations/{id}` → `handleUpdateConversation` / `PATCH /api/conversations/{id}` → `handlePatchConversation` / `DELETE /api/conversations/{id}` → `handleDeleteConversation`
- `POST /api/conversations/{id}/generate` → `handleGenerate` / `POST /api/conversations/{id}/cancel` → `handleCancel` / `POST /api/conversations/{id}/pause` → `handlePause` / `POST /api/conversations/{id}/resume` → `handleResume`
- `POST /api/conversations/{id}/model-response` → `handleModelResponse` / `POST /api/conversations/{id}/tool-response` → `handleToolResponse`
- `GET /api/conversations/{id}/events` → `handleEvents` (SSE tail) / `GET /api/conversations/{id}/job` → `handleJob` (also returns a synthetic `paused` state + `pausedStep` when a checkpoint exists but no job is live)

**Folders (requireAuth, all handlers.go):**
- `GET /api/folders` → `handleListFolders` / `POST /api/folders` → `handleCreateFolder` / `PUT /api/folders/{id}` → `handleRenameFolder` / `DELETE /api/folders/{id}` → `handleDeleteFolder`

**Agent config (requireAuth, all handlers.go):**
- `GET /api/agent/config` → `handleAgentConfigGet` / `PUT /api/agent/config` → `handleAgentConfigPut`

**Repos (requireAuth, all handlers.go):**
- `GET /api/repos` → `handleListRepos` / `POST /api/repos` → `handleRepoUpsert`

## Structural constraints

- One flat `package main`, no subpackages — all types/functions share one namespace; no import paths, no internal packages.
- `Dockerfile` — multi-stage build, `CGO_ENABLED=0`, static binary in alpine:3.20, exposes 8081.
- `backend` binary — local build artifact, gitignored via `.gitignore`.
- `go.mod` — module `github.com/sjoberg/nas-llm/backend`, Go 1.22, sole direct dep `modernc.org/sqlite`.

## Configuration

`config` struct (`main.go:13-69`) + env-reading block in `main()` (`main.go:96-121`) is the authoritative env-var/defaults list. Read through `env`/`envInt`/`envBool`/`envFloat`/`envDuration`/`mustEnv` (`main.go:170-221`). Key callouts:
- `SESSION_SECRET` — `mustEnv` (`main.go:98`); the process exits without it.
- `DB_PATH` — defaults to `/data/nas-llm.db` (container path, `main.go:102`).
- `OLLAMA_MAC_URL` — empty by default; setting it enables the optional Mac backend.
- `OLLAMA_CONTEXT_LENGTH` — mirrors the Ollama container's context length for KV-cache RAM estimation.
- `MAX_AGENT_STEPS` — per-run tool-calling round budget (default 24; the model is warned at 80% of the budget to finish outstanding edits, a narration re-prompt round does not consume a step, and exhausting the budget emits a `(budget)` trace step before forcing a tools-removed final answer).
- `RUN_COMMAND_TIMEOUT` — per-`run_command` deadline (default 120s), carried on each `toolExec` payload so the sidecar kills a non-exiting command (exit 124) instead of parking the relay until `TOOL_EXEC_TIMEOUT`.

## Key architecture pointers

- **Job manager / background generation:** `jobs.go` — `handleGenerate` enqueues a `job`; `maxConcurrentJobs` workers drain the queue. `runGeneration` (`jobs.go:1088`) picks the backend (`browserRelay` for local models, `directOllama` for server models) and branches into agent/clarify/search/plain paths.
- **SSE event hub:** `eventHub` (`jobs.go:736`) — per-user multiplexed stream backing `GET /api/events`. Jobs publish modelCall/toolExec/phase/done/error events so backgrounded chats keep working. Per-conversation tails (`handleEvents`, `handlers.go:551`) are the other long-lived SSE connection.
- **Browser relay:** `relay.go` — local-model jobs emit `modelCall` SSE events; the browser dials its own Ollama (localhost:11434) and POSTs results to `/api/conversations/{id}/model-response`. File tools (`write_file`/`edit_file`/`delete_path`/`move_path`, `apply_patch`, `run_command`, git tools) relay through `toolExec` events → `/tool-response`. `run_command` is bounded by `RUN_COMMAND_TIMEOUT` (carried on the payload); the sidecar's `apply_patch` normalizes the diff and tries a 4-rung apply ladder before failing.
- **Agent pause/resume:** `jobs.go`/`agent.go` — only agent-mode runs are pausable (plain chat/search/clarify keep Stop). `job.pause()` sets `pauseRequested` and cancels the current round's child ctx so pause lands within seconds; `runAgentLoop` checks the flag at the top of each iteration and after each tool result and returns `errAgentPaused` (a `*pausedError` carrying the transcript + step). The worker persists an `agent_checkpoints` row (the transcript + step + model + local/supportsTools), persists the partial assistant message, finalizes the job `paused`, and `notifyPaused` (a terminal SSE `done` with hub `status:"paused"`). `/resume` enqueues a fresh job that rehydrates the transcript (dropping the stale system message so date/repo/branch are rebuilt), appends an optional note as a user turn, and continues on the remaining step budget; the checkpoint is deleted on a clean finish. `reconcileJobs` only touches queued/generating, so a paused run is still resumable after a backend restart.
- **Multi-host Ollama routing:** `hosts.go` / `registry.go` — `hostRegistry` probes each backend's `/api/tags` every 30s and resolves model→host (`onlineHostForModel`). NAS is always-on default; Mac is optional (enabled by `OLLAMA_MAC_URL`). Server-side inference is serialized per host via `hostSem` (matching `OLLAMA_NUM_PARALLEL=1`).

## Tests

Run from `backend/`: `go test ./...`

- `agent_test.go` — system prompt injection, narration guard, prose tool-call recovery, awaiting-tool-result fallback
- `relay_test.go` — `browserRelay.Call` happy/error/timeout paths, `handleModelResponse` delivery + duplicate rejection, agent loop local-relay tool execution, non-tool model skip
- `hosts_test.go` — multi-host model resolution, offline host drop, post-mutation refresh, per-host routing of requests/benchmarks/pulls, host-aware RAM verdicts (uses `fakeOllama` test server)
- `clarify_test.go` — prose-question detector, plain-chat ask_user offer for tool-capable models, non-tool skip
- `registry_test.go` — model ref parsing, manifest size computation, preflight fit verdicts, 404 sentinel mapping
- `library_test.go` — ollama.com/search HTML parser, empty/non-matching HTML fallback
- `agent_tools_test.go` — wiring of the local file/git tools (write_file/edit_file/delete_path/move_path/merge_pr) across `defaultAgentTools`, `toolRegistry`, and `availableTools` (guards against a silent allowlist regression)
- `workspace_test.go` — non-git workspace (`UseGit=false`) gets file tools but no git tools in the agent allowlist, and uses `injectWorkspaceContext`; `localFileTools`/`localGitTools` partition. Todos/Plan store round-trip; `filterPlanWriteTools` (Plan-mode write-tool gate); `injectPlanContext` content; `todo_write`/`todo_read` registration
