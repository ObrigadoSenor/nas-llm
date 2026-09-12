# Desktop agent workflow: link repo → agent chat → branch → commit/push/PR — task log

Source plan: `96a3a8a2-8d02-40cb-a2ff-843bbfbcde3b` (see `ai/tasks.md` Phase 15).

## Goal
Make the desktop app's "link a local repo → start an agent chat → code → commit/push → PR" flow one coherent workflow, with the current branch always visible, so `main` is never dirtied by agent edits.

## How it was built
Three parallel local child agents, each in its own git worktree on its own branch, coding to pinned cross-layer contracts; merged onto `orchestrator/integrate`.

- sidecar → `orchestrator/sidecar` (`15f4db7`) — Rust sidecar routes + `repos_exec` git tools.
- backend → `orchestrator/backend` (`4d80ecd`) — Go `repo_branch` + agent tool schemas + allow list.
- renderer → `orchestrator/renderer` (`9047454`) — `createRepoChat` rewrite, branch rail, session panel, approval prefix.

## Cross-layer contracts (must stay in sync)
- Agent tool names: `git_commit`, `git_push`, `create_pr` (backend schemas + sidecar `repos_exec` match arms).
  - `git_commit` args `{"message"}`; `git_push` args `{}`; `create_pr` args `{"title","body"}` (head = current branch, base = default branch).
- Sidecar routes: `POST /__sidecar/repos/branch`, `GET /__sidecar/repos/state?name=`, `POST /__sidecar/repos/commit`, `POST /__sidecar/repos/create-pr`.
- Conversation field: `repo_branch` (column) / `repoBranch` (JSON, camelCase) — PATCH accepts it; list/get return it.
- `jobs.go` repo-bound allow list appends the three git tools; `injectRepoContext` mentions them.

## Files changed (integrated)
- `desktop/src-tauri/src/github.rs` (+519: 4 routes, 3 `repos_exec` arms, helpers)
- `desktop/src-tauri/Cargo.lock` (auto)
- `backend/agent.go`, `backend/jobs.go`, `backend/store.go`, `backend/handlers.go`, `backend/agent_test.go`, `backend/clarify.go` (gofmt), `backend/go.mod`, `backend/go.sum` (`go mod tidy`)
- `desktop/renderer/desktop.js`, `desktop/renderer/desktop.css`
- `www/app.js` (one additive `nasllm:openConv` listener — no-reload navigation)

## Validation (on `orchestrator/integrate`)
- `cargo check` clean (desktop/src-tauri).
- `gofmt -l .` clean; `go build ./...` clean; `go test -run '^$' ./...` clean (backend).
- `node --check` clean on `desktop/renderer/desktop.js` + `www/app.js`.
- Cross-layer spot-check: tool names, `repos_exec` arms, routes, `repo_branch` field all align.
- Pre-existing local `Cargo.lock`/`Cargo.toml` 0.2.1 bump preserved across the merge.

## Notes
- Backend child installed Go via Homebrew (was not on the machine) to run validation; ran `go mod tidy` (touched `go.mod`/`go.sum`) and applied `gofmt -w` whitespace fixes to a few pre-existing files (`clarify.go`, `agent_test.go`, store/handlers/toolRegistry alignment). Review those whitespace diffs if you want a strictly-minimal commit.
- Merge was conflict-free (the three layers touched disjoint files).
- Worktrees: `nas-llm-wt-sidecar`, `nas-llm-wt-backend`, `nas-llm-wt-renderer` (can be removed once you're done reviewing).

## Remaining (user)
`npm run desktop` from `orchestrator/integrate` and exercise the end-to-end flow: link repo → + New chat → header rail shows `agent/<slug>` and `main` is clean → agent edit → approve (prefixed `repo @ branch`) → session panel → Commit & push / Open PR → PR opens in browser. Then try the agent-driven `git_commit`/`git_push`/`create_pr` tools.

## Iteration: sidebar repo dropdown
The per-repo sidebar row was too cluttered (name + 3 badges + branch meta + Pull/Ship/⋯/+ New chat buttons + chats list, all flat). Reworked `localRow` into a dropdown: a header with just the repo name, a ⋯ actions menu (Pull / Session… / Ship…), and a + for a new chat; expanding the header shows the attached chats. Branch/dirty state lives in the composer status line (below the input) and the session panel, so the sidebar row is minimal. Expand state persists per repo in `localStorage["nas-llm-repo-expanded"]`. Cache-bust bumped v10 → v11. Validated: `node --check` + `cargo check` clean.

## Iteration: composer status line (below the input)
Moved the repo/branch info out of the header rail into a small muted status line below the composer input: `owner/repo · ⎇ branch · ●N dirty · ↑a ↓b` (plus `no remote` when applicable). Enriched vs the old header rail with the repo name and remote status. Still polled every ~5s and refreshed after each toolExec; click opens the session panel. Removed the header `.ds-branch-rail` to avoid two-place duplication. Cache-bust bumped v11 → v12. Validated: `node --check` + `cargo check` clean.
