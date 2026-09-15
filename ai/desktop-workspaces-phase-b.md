# Desktop workspaces — Phase B (Copilot-app-inspired enhancements)

Source plan: `197a643d-fc3c-4760-8d18-6227095bba11` (section 6). Builds on Phase A (`ai/desktop-workspaces.md`).

## What landed

Ten Copilot-app-inspired enhancements, ranked by value-to-effort in the plan. All are working v1 implementations; the UI pieces need a manual NAS walkthrough (no `www/` automation).

### 1. Open in external editor / Finder / terminal
- Sidecar `POST /__sidecar/repos/open-in` `{name, target}` (editor|finder|terminal). `$VISUAL`/`$EDITOR` then platform default (macOS `open -a`, Windows `explorer`/`cmd`, Linux `xdg-open`). Detached + stdio null.
- Frontend: `openInApp` + `repoMenu` (⋯) items (every workspace).

### 2. Sessions vs Chats sidebar split
- Sidebar "Repos" → "Workspaces" header; `buildSidebarChatsHeader` injects a "Chats" label above `#convList`. The grouping already existed (workspace chats under their workspace; non-workspace chats in `#convList`); this makes the distinction explicit.

### 3. Base-branch picker at chat creation
- `createWorkspaceChat(r, baseBranch)` passes `base` to `repos/create-branch`. `openBaseBranchPicker` lists branches and starts a session cut from the chosen one. Git workspaces only.

### 4. Slash commands (`/plan`, `/autopilot`, `/spar`, `/security-review`)
- Added to `www/app.js`'s `COMMANDS`: `/plan` enters Plan mode (PATCH `planMode:true`) + pre-fills the planning template; `/autopilot` toggles agent + auto-approve; `/spar` pre-fills a devil's-advocate prompt; `/security-review` pre-fills a security-review prompt. `app.js?v=54`, `styles.css?v=49` bumped in `www/index.html`.

### 5. Auto-sync (background pull) behind a toggle
- `autoSync` global (localStorage, default off). The rail's 5s `repos/state` poll fast-forwards the session branch when `behind>0` via `repos/refresh` (now branch-aware — pulls in the session's worktree). Toggle chip in the composer status line (git workspaces).

### 6. Agent Merge toggle on the Merge tab
- `agentMergeTick`/`startAgentMerge`/`stopAgentMerge`: a checkbox on the session-panel Merge tab that polls `repos/prs` for the selected PR's CI/review state and calls `repos/merge-pr` when CI is green + reviews clear. Stops on merge/toggle-off/panel-close.

### 7. My Work view
- `openMyWork`/`loadMyWork`: a cross-workspace dashboard overlay built from `/api/repos` + `/api/conversations` + `repos/state` + `repos/prs`. Per-workspace: session count, git state (dirty/ahead/behind), open PRs, session list. Header "My Work" button (`makeMyWorkBtn`).

### 8. Recovery refs / undo for non-git workspaces
- Sidecar `snapshot_workspace` copies the tree (skipping node_modules/.git/target/etc.) into `<data_dir>/snapshots/<name>/<millis>/` before each approved write tool on a non-git workspace (gated by `is_write_tool`); keeps the last 3. `POST /__sidecar/repos/undo-last` restores the newest snapshot (clears non-skip contents, copies it back, consumes the snapshot). Frontend: "Undo last write" button in the session panel (non-git only).

### 9. In-session todo list (Tasks Pill)
- Backend: `Conversation.Todos` (`[]Todo`, `todos` JSON column + migration); `todo_write`/`todo_read` tools (local, relayed) in `localRepoTools`/`localFileTools` + `toolRegistry` + `availableTools`; `handlePatchConversation` accepts `todos`.
- Frontend: `runToolExec` intercepts `todo_write`/`todo_read` (PATCHes the conversation / reads the cached checklist, no sidecar round-trip) and posts the observation back. `ensureTasksPill`/`renderTasksPill` renders the collapsible checklist below the composer.

### 10. Plan mode + persisted plan
- Backend: `Conversation.PlanMode`/`Plan`/`PlanApproved` (columns + migration); `planWriteTools()`/`filterPlanWriteTools()` gate write tools out of the allowlist pre-approval; `injectPlanContext` prepends a plan-mode block (forbids editing pre-approval, says "implement" post-approval). `jobs.go` wires it: `if conv.PlanMode { inject; if !approved { filter } }`. `handlePatchConversation` accepts `plan`/`planMode`/`planApproved`.
- Frontend: `renderPlanPill` shows a Plan chip in the composer status line (awaiting-approval / approved); `openPlanPopover` shows the plan text + an Approve button (PATCHes `planApproved:true`).

## Tests
- Backend `workspace_test.go`: Todos/Plan store round-trip; `filterPlanWriteTools` (write tools removed, read/planning kept); `injectPlanContext` (pre/post-approval content); `todo_write`/`todo_read` registration.
- `github.rs` `#[cfg(test)]`: `is_write_tool` (file writes, not git/read/run_command); `snapshot_and_undo_last_round_trip` (snapshot → mutate → undo restores, node_modules skipped, snapshot consumed).

## Validation
`make check` passes (backend gofmt+vet+test; desktop cargo check+test — 26 Rust tests, 2 new). `node --check www/app.js` + `desktop/renderer/desktop.js` pass. No automated `www/` UI or end-to-end coverage — the workspace/plan/tasks/agent-merge/my-work flows need a manual walkthrough on the NAS before this ships.

## Cache-bust bumps
- `www/index.html`: `styles.css?v=49`, `app.js?v=54`.
- `sidecar.rs` `index_html`: `desktop.css?v=22`, `desktop.js?v=30`.
