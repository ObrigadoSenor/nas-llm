# Local-LLM tools / downloads / discovery — task list

Source plan: `013c8aa4-bf82-42e1-bb02-bd5fbf1ad8c9` ("Local-LLM agent/web-search not engaging (non-tool model + no capability gating)").

Status: **executed** — backend `go build`/`go vet`/`go test` clean (incl. new e2e test), `node --check` on `app.js` clean.

## Workstream A — Capability gating (the reported fix)
- [x] **A1 Backend: add capabilities to `/api/models`.** `Capabilities []string` on `ollamaModel` (sibling of `details`); included in `handleModels` items. `models.go`.
- [x] **A2 Frontend: capture + thread model capabilities.** `discoverLocalModels` keeps `m.capabilities`; `buildModelEntries` carries caps for local + server; `localEntries()` helper.
- [x] **A3 Frontend: capability badges on model cards.** `capBadges()` helper; badges on `renderLocalCard` + `renderInstalledCard`.
- [x] **A4 Frontend: gate Agent/Web/Clarify on tool support.** `modelSupportsTools()` (null = unknown → no false-block); `enforceToolGating()` drops active tool extras; `renderPlusPopup` disables them with a tooltip; wired into `loadModels`/`reattachLocalModels`/`onConnectLocal`/`chooseModel`/`useModel`/`ensureCaps`.
- [x] **A5 Backend: "no tools used" note for Agent mode.** `runAgentLoop` emits a `(direct)` step when the model answers on round 0 without calling any tool. `agent.go`.
- [x] **A6 Frontend: id-based relay tool-call accumulation.** `relayLocalModelCall` accumulates by id-presence (mirrors `streamOllamaChatWithTools`), fixing multi-call corruption from Ollama's `index:0`-for-every-call.

## Workstream B — Model downloads: NAS / Mac / Local target
- [x] **B1 Frontend: download target chooser.** `buildPullTargetSelect()` (Auto/NAS/Mac-when-configured/Local) on Browse + Pull-by-name; `startPull(model, target)` sends `host` for NAS/Mac. `app.js`.
- [x] **B2 Frontend: browser-driven local pull.** `startLocalPull()` POSTs `localhost:11434/api/pull`, parses NDJSON, drives `renderPullStatus` directly; cancel aborts; `onLocalPullDone` re-probes `/api/tags`. Shared progress bar + `pullMode`-routed `cancelPull`.

## Workstream C — Model discovery: categorized, searchable catalog
- [x] **C1 Backend: categories + expanded catalog.** `Categories []string` on `catalogEntry`; `curatedCatalog` expanded (llama3.2:1b, qwen2.5-coder:3b/7b, deepseek-r1:1.5b/7b, qwen3:8b, …) tagged code/agentic/math/vision/long-context/fast/chat/embeddings. `models.go`.
- [x] **C2 Backend: surface categories in catalog endpoint.** Rides along via the struct JSON tag; `handleModelCatalog` unchanged.
- [x] **C3 Frontend: Browse search + category filter UI.** Search box + category chips (client-side filter via `renderBrowseList`); "best for" category badges on browse cards. `app.js`.

## Workstream D — Markup, tests, validation
- [x] **D1 `index.html`: cache-bust bump.** `app.js?v=28`, `styles.css?v=28`; new control styles added to `styles.css`.
- [x] **D2 Tests + validation.** `TestAgentLoop_LocalRelayToolCallsExecuteAndContinue` (local relay POSTs `calculator` tool_call → tool executes → loop continues to done); `go build`/`go vet`/`go test` clean; `node --check` clean. **Deviation:** no frontend unit test for the accumulation fix (project has no frontend test harness) — covered by the backend e2e + `node --check`; extraction into a dependency-free module is a follow-up if a harness is added.
