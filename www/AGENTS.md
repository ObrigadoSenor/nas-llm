# www/ — static browser chat UI

Vanilla JS, no build step. Served as static files by Caddy (web) and bundled by Tauri (desktop). Five source files plus vendored libraries:

- `index.html` (114 lines) — page shell, element IDs, script/link tags
- `app.js` (2860 lines) — all application logic and state
- `lib.js` (602 lines) — icons, markdown rendering, streaming renderer, agent-trace DOM builders
- `styles.css` (530 lines) — full UI styling
- `vendor/` — `highlight.min.js` + `highlight-github-dark.min.css` (highlight.js), `marked.esm.js`, `purify.es.mjs`

## Cache-bust rule — read this before editing any JS or CSS

There is no build step, so cache-busting is manual query strings in **three** separate places. If you edit a file and don't bump its `?v=`, the change will not reach a cached browser.

- **Editing `styles.css`** → bump the number in `index.html:9` (`<link … href="styles.css?v=…">`).
- **Editing `app.js`** → bump the number in `index.html:112` (`<script type="module" src="app.js?v=…">`).
- **Editing `lib.js`** → bump the number in the ES module import inside `app.js:3` (`import { … } from './lib.js?v=…'`). This is **not** in `index.html` — it's easy to miss.

Current values (as of this commit): `styles.css?v=42`, `app.js?v=48`, `lib.js?v=28`. Verify against the files before relying on these numbers.

The desktop app has its own independent `?v=` constants for renderer assets it injects on top of this directory — see `desktop/AGENTS.md`.

## app.js section map

The file is one top-level module with no submodules. Regions below are approximate line ranges; use them to jump, then scan for the function name.

- **Imports, DOM refs, static icons** (1-26) — `$()` helper, all `getElementById` calls, `setIcon` on static buttons.
- **Global state & extras** (28-203) — module-level state (`models`, `conversations`, `activeId`, `messages`, `activeES`, `generatingIds`, `localAborts`, etc.); `EXTRA_DEFS` (web/clarify/agent toggles, mutually exclusive, tool-gated); `buildModelEntries` (merges server + local Ollama models); `modelSupportsTools`/`enforceToolGating`; `renderPills`/`renderPlusPopup` (the + menu).
- **Image attachments** (205-310) — vision-model-only; `ensureCaps`/`syncVision`/`renderComposer`; `downscaleImage` (canvas resize before upload); file picker, paste, drag-and-drop handlers.
- **Send/Stop button** (312-336) — `renderSend` (toggles icon); `stopActive` (aborts local relay + POSTs `/cancel`).
- **fetchRetry** (338-373) — exponential-backoff wrapper used by most API calls; retries network/429/5xx, fails fast on 401/4xx.
- **Auth gate** (375-431) — `boot()` checks `/api/auth/me`; `showLogin`/`showApp`; `showApp` loads models, conversations, active jobs, opens the global stream; login/logout handlers.
- **Models: loading & unified picker** (434-754) — `loadModels`; `reattachLocalModels`/`discoverLocalModels` (probes `localhost:11434/api/tags`); badge builders (`hostBadge`, `speedBadgeFor`, `capBadge`); the single drawer with `buildInstalledRow`/`buildLocalRow`; per-row ⋯ menu (`benchmarkRow`, `confirmRemoveRow`, `deleteRowModel`, `toggleDetails`); `renderModels`/`renderModelBanner`/`chooseModel`/`saveModelSelection`; `prefetchCaps`; keyboard nav.
- **Sidebar & conversations** (756-1000) — `loadConversations`/`loadFolders`; `renderSidebar`/`renderFolder`/`renderConv` (drag-to-folder); row action menus (`openConvMenu`, `openFolderMenu`, `confirmInMenu`); `moveConversation`; inline rename; folder CRUD; `openConversation`; desktop bridge hooks (`nasllm:openConv`, `nasllm:refreshConvs`).
- **Background generation & SSE** (1002-1388) — `loadActiveJobs`/`syncGenerating` (5s poll for sidebar spinners); `closeTail`/`resumeIfGenerating`; **local-model relay** (`relayLocalModelCall`, `postModelResponse`, `relayModelCallHeadless` — browser streams to `localhost:11434/v1/chat/completions`, POSTs result back); `showToast`/`finishJob`/`reloadIfOpen`; **global stream** `openGlobalStream`/`closeGlobalStream` (user-scoped multiplexed SSE at `/api/events`); **`tailJob`** (per-conversation SSE at `/api/conversations/{id}/events` — all event listeners live here).
- **Generation completion & chat CRUD** (1390-1419) — `onGenerationDone`; `newChat`; `deleteConversation`.
- **Chat rendering** (1421-1583) — `bubbleError`; **`addMsg`** (the message DOM builder: thinking accordion, steps drawer, search evidence, bubble, meta row); `addCopyMsg`; `toolBadgeFor`/`openToolPopup` (finalized-answer tool popup); `rerenderChat`; `updateHeader`.
- **`stream()` — the send function** (1585-1669) — slash-command parse; creates conversation on first turn (`POST /api/conversations`); enqueues job (`POST /…/generate`, handles 200/409); calls `tailJob`.
- **Clarify answer** (1671-1683) — `sendClarifyAnswer` (defers if job still finalizing).
- **Input handlers** (1685-1716) — send click, keydown (Enter sends, ArrowUp/Down history, slash popup nav).
- **Sidebar toggle & helpers** (1718-1760) — mobile sidebar open/close; `titleFrom`; input history; `autosize`; time formatters (`relTime`, `absTime`, `fmtTs`).
- **Models panel: tabs & resize** (1762-1955) — drawer/sidebar resize handles (`initDrawerResize`, `initSidebarResize`); `openModelsPanel`/`switchTab`; `renderInstalledTab`; `renderLocalBlock`/`onConnectLocal`.
- **Browse tab** (1957-2288) — Recommended catalog vs All-models library toggle; search/category filter; download-target chooser (`buildPullTargetSelect`, `renderTargetChooser`, `openDownloadMenu`); `renderBrowseTab`/`renderBrowseCard`/`renderLibraryCard`/`renderLibraryList`.
- **Pull flow** (2290-2457) — `startPull` (routes server vs local); `startLocalPull` (browser-driven `localhost:11434/api/pull`); `attachPull`/`resumePullIfActive`/`resumeLocalPull`; `renderPullStatus`/`tailPull`/`cancelPull`.
- **Per-model actions & helpers** (2458-2527) — `useModel`; `flashError`; `toggleDetails`; `badge`/`mutedNote`/`capLabel`/`fmtPullBytes`/`prettyPhase`/`fitBadge`/`speedBadge`.
- **Preflight** (2529-2650) — `preflightModel` (cached `/api/models/preflight`); `localRamGB`/`localFitFor`/`preflightFitLabel`/`preflightBadgeEl`/`attachPreflightBadge` (download size + fit verdict before pull).
- **Agent settings** (2652-2707) — `openAgentPanel`/`loadAgentConfig`/`renderAgentTools`; save handler (`PUT /api/agent/config`).
- **Slash commands** (2709-2857) — `COMMANDS` array (clear/delete/rename/stop/web/clarify/agent/models/plan/logout/help); `parseSlash`; popup render/keyboard nav; `runCommand`; `toggleExtra`; `confirmSlash`/`slashNote`.
- **`boot()`** (2859) — entry point at the very end.

## lib.js vs app.js

`lib.js` is purely presentational helpers imported by `app.js`. It holds no state and makes no network calls.

- `icon(name)` / `setIcon(el, name)` / `thinkingDots()` — inline-SVG icon set (Lucide-style, `currentColor`).
- `renderMessage(container, text)` — finished-message markdown render (marked → DOMPurify → highlight.js → copy buttons).
- `StreamRenderer` class — coalesces SSE chunks into ≤1 markdown re-parse per animation frame; `suspend()` freezes it so a clarify card can't be wiped by a queued flush; `finalize()` does the full render with highlighting.
- `escapeHtml(s)` — for user messages (not rendered as markdown).
- Agent-trace DOM builders: `renderAgentSteps`/`appendAgentStep`, `buildThoughtsWrap`/`renderThoughts`/`appendThought`/`setThoughtsSummary`, `renderClarifyCard`, `renderSearchBlock`/`appendSearchEntry`/`showSearchPending`/`clearSearchPending`, `renderSourceLinks`/`appendSourceLinks`.

`app.js` owns all state, event handling, network calls, and orchestrates `lib.js` exports.

## index.html wiring

- Loads `app.js` as `<script type="module">` (line 112) — it's an ES module that imports `lib.js`.
- Loads `vendor/highlight.min.js` as a classic `<script defer>` (line 10) — exposes `window.hljs`, used by `lib.js`'s `highlightAll`.
- `vendor/highlight-github-dark.min.css` and `styles.css` are plain `<link>` stylesheets (lines 8-9).
- Key element IDs the JS depends on: `login`, `app`, `sidebar`, `convList`, `chat`, `input`, `send`, `modelBtn`, `modelsModal`, `agentModal`, `plusBtn`, `plusPopup`, `slashPopup`, `pills`, `imgPills`, `attachBtn`, `fileInput`, `tabInstalled`, `tabBrowse`, `tabBody`, `pullStatus`, `agentSystem`, `agentTools`, `agentAutoApprove`.

## Backend contract

All routes below are registered in `routes()` at `backend/main.go:234-281`.

**REST routes called by this page:**
- `GET /api/auth/me`, `POST /api/auth/request`, `POST /api/auth/logout`
- `GET /api/models`, `GET /api/models/catalog`, `GET /api/models/library`, `GET /api/models/library/tags`, `GET /api/models/preflight`, `POST /api/models/pull`, `GET /api/models/pulls/active`, `GET /api/models/pull/{jobId}/events`, `POST /api/models/pull/{jobId}/cancel`, `DELETE /api/models/{name}`, `POST /api/models/{name}/benchmark`, `GET /api/models/{name}/info`
- `GET /api/jobs/active`
- `GET /api/conversations`, `GET /api/conversations/{id}`, `POST /api/conversations`, `PATCH /api/conversations/{id}`, `DELETE /api/conversations/{id}`, `POST /api/conversations/{id}/generate`, `POST /api/conversations/{id}/model-response`, `POST /api/conversations/{id}/cancel`, `GET /api/conversations/{id}/job`
- `GET /api/folders`, `POST /api/folders`, `PUT /api/folders/{id}`, `DELETE /api/folders/{id}`
- `GET /api/agent/config`, `PUT /api/agent/config`

**SSE event streams:**
- `GET /api/events` — user-scoped multiplexed stream (opened once after auth by `openGlobalStream`). Event types switched on: `modelCall`, `done`, `joberror`. Used for background-chunk local relays and completion toasts/badges.
- `GET /api/conversations/{id}/events` — per-conversation stream (opened by `tailJob`). Event types switched on: `reset`, `searches`, `search`, `questions`, `steps`, `tool`, `thoughts`, `thought`, `clear`, `modelCall`, `phase`, `chunk`, `done`, `joberror`.
- `GET /api/models/pull/{jobId}/events` — pull progress stream (opened by `tailPull`). Event types: `reset`, `phase`, `progress`, `done`, `joberror`.

Routes registered in the backend but **not** called by this page: `GET /api/health`, `GET /api/auth/verify` (email-link landing), `POST /api/chat/completions` (direct proxy, unused by the web UI which goes through `/generate`), `PUT /api/conversations/{id}` (this page uses PATCH), `POST /api/conversations/{id}/tool-response` and `GET|POST /api/repos` (desktop bridge only).

## Desktop app reuse

The Tauri desktop app reuses this same `www/` directory: `desktop/src-tauri/tauri.conf.json` sets `frontendDist` to `../../www` (line 7) and bundles it as a resource (line 26). The desktop sidecar overlays extra assets (repo sidebar, branch rail, tool-exec bridge) on top of this base. **A change to any file here affects both the web page and the desktop app.** See `desktop/AGENTS.md` for the overlay mechanics and the desktop-only routes.
