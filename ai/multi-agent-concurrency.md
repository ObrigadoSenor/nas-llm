# Multi-agent chats: parallel runs, per-chat branches, completion notifications — task log

Source plan: `67796345-a780-42f3-bb0b-44611675303e` (see `ai/tasks.md` Phase 16).

## Goal
Run several agent chats at once across repos: starting a second chat must not kill the first, each chat gets a real branch of its own, and finishing a chat you aren't watching should tell you.

## Root causes (all confirmed in source before any code was written)
- **One generation slot.** `jobManager` ran a single worker goroutine draining one queue. A browser-relay job *blocks that worker* while it waits for the browser to POST `/model-response`, so one local-model chat stalled every other chat — not just slowed it.
- **One SSE tail, and it was fatal.** `tailJob` began with `closeTail()`, so only one `EventSource` ever existed; `handleEvents` then cancelled the job outright when that stream dropped if `j.local`. Switching chats therefore cancelled the running chat. Repo chats were equally affected on server models, because the tail is also the only channel carrying `toolExec`.
- **Timeouts ignored the human.** `genTimeout` (5m) bounded both the whole job and the tool-exec wait, but `apply_patch` / `run_command` / `git_*` block on a user approval dialog.
- **One working tree per repo.** `resolve_repo` mapped a repo to exactly one path; `repos/branch` and `repos/checkout` `git switch`ed that shared tree. `repo_branch` was stored and displayed but never sent to the sidecar, and `injectRepoContext` told the model the *shared tree's* branch, which could be wrong.
- **Approvals were single-shot.** `showApprovalDialog` wired its resolver only inside the `if (!overlay)` guard, so the second approval of a session resolved the first, already-settled promise and never settled its own — the agent then hung until the tool-exec timeout. `dsConfirm` had the identical bug and had already been fixed; this was the same pattern, unfixed.

## How it was built
Four parallel local child agents, one per layer, each in its own git worktree, coding to contracts pinned before launch; merged onto `orchestrator/mc-integrate` conflict-free (the layers touch disjoint files).

- backend → `orchestrator/mc-backend` (`08d1553`)
- sidecar → `orchestrator/mc-sidecar` (`1ee3929`)
- webui → `orchestrator/mc-webui` (`7f935cc`)
- renderer → `orchestrator/mc-renderer` (`c111493`)

## Cross-layer contracts (must stay in sync)
- `GET /api/events` — user-scoped multiplexed SSE. Kinds: `modelCall`, `toolExec`, `phase`, `done`, `joberror`; every payload carries `convId` + `jobId`. Terminal payloads add `status` (`done`/`cancelled`) or `error`. Internal kind `error` maps to the wire name `joberror`. The per-conversation `/api/conversations/{id}/events` stream is unchanged.
- `toolExec` payload gains `branch` (from `conversations.repo_branch`); empty means "main working tree".
- Sidecar `repos/exec` + session-panel routes take an **optional** `branch`; omitting it preserves pre-existing behaviour exactly. New `POST /__sidecar/repos/worktree` → `{ok, branch, path, created, error}`.
- `www/app.js` dispatches `nasllm:jobDone` `{convId, title, status, error}` **unconditionally**; `desktop.js` listens. Suppression is per-surface: app.js skips its own toast for the on-screen chat, desktop.js skips the OS notification only when the chat is on screen *and* the window is focused.
- The desktop `EventSource` shim reads `convId` from the payload, falling back to the URL — it wraps `window.EventSource`, so it services the global stream too. `toolExec` is owned by the shim, never by `app.js`.
- Env knobs: `MAX_CONCURRENT_JOBS=4`, `BROWSER_RELAY_GRACE=45s`, `AGENT_JOB_TIMEOUT=30m`, `TOOL_EXEC_TIMEOUT=15m`.

## Design notes worth remembering
- **Server inference stays serialized.** A per-host semaphore of capacity 1 preserves `OLLAMA_NUM_PARALLEL=1` behaviour on the NAS/Mac; only browser-relay jobs bypass it, since those execute on the user's own machine. The parallelism gain is real precisely where it is safe.
- **One multiplexed stream, not one tail per chat.** The desktop sidecar is HTTP/1.1 on 127.0.0.1 and a webview caps ~6 connections per origin, so a tail per running chat would have starved ordinary `/api` calls. Two connections total, regardless of agent count.
- **Grace instead of instant cancel.** A browser-bound job is cancelled only if neither its tail nor the user's global stream reattaches within `BROWSER_RELAY_GRACE`. Chat switches and reloads survive; a closed app still cleans up.
- **Worktrees, because git already solves this.** A branch can be checked out in at most one worktree, which is exactly the isolation wanted. `ensure_worktree` prunes, then scans `git worktree list --porcelain` — that single scan covers both "already has a worktree" and "checked out in the main tree", since the main tree appears in that list with its branch.
- **Known tradeoff:** a fresh worktree has no untracked/ignored files (`node_modules`, `.env`, build caches), so the first `run_command` on a new branch may need an install step. Surfaced in the branch picker rather than hidden.

## Follow-up: per-chat worktree at creation time
The first integration left `createRepoChat` calling the old `repos/branch` route, which meant new chats still `git switch -c`'d the **shared repo folder**. Fixed afterwards, and worth recording because the investigation turned up a second, larger problem:
- **"A branch per chat" was really a branch per repo.** The branch name came from `slugify(title)`, but every chat on a repo is created with the same title (`owner/repo (agent)`), so every chat resolved to the same `agent/<slug>` — and `repos/branch` was idempotent, so it happily reused it. The branch this very session started on, `agent/obrigadosenor-nas-llm--agent`, is that shared branch. Two chats on one repo could not hold two branches no matter what the UI showed.
- **Fix:** `createRepoChat` now calls `repos/worktree {create:true}` with `agent/<repo-short-name>-<first 7 of convId>`. Unique per chat, readable, and provisioned as a worktree so the repo folder's branch and uncommitted work are untouched.
- **Secondary gain:** the old path carried the user's uncommitted edits onto the new chat's branch (that is what `git switch -c` does with a dirty tree). The worktree path cannot, since the chat gets a separate directory cut from the default branch.
- Verified with a scratch-git probe contrasting both paths: old → repo folder moved to the new branch *and* the uncommitted edit followed it; new → folder branch unchanged, edit stays put, chat worktree starts from committed state, and two chats hold two branches with isolated edits.
- `POST /__sidecar/repos/branch` is now unused by the UI. Left in place (it is a working control-plane route and the session panel's semantics may still want it) but it no longer participates in the chat flow.

## Validation (on `orchestrator/mc-integrate`)
- Backend: `gofmt -l .` clean, `go vet ./...` clean, `go build ./...` clean, `go test ./...` ok, `go test -race ./...` ok.
- Sidecar: `cargo check` clean (no warnings).
- JS: `node --check` clean on `www/app.js`, `www/lib.js`, `desktop/renderer/desktop.js` (copied to `.mjs`; they are ES modules).
- Cache-bust versions consistent: `app.js?v=46`, `lib.js?v=28`, `styles.css?v=41`, `desktop.js?v=20`, `desktop.css?v=17`.
- **Live backend probe** (throwaway binary, port 18099, temp DB, forged session using `auth.go`'s HMAC scheme; all artifacts deleted after): two local chats both reported `generating` *simultaneously* — the exact thing that was impossible before; `/api/events` delivered `modelCall` for both with `convId`+`jobId` on every payload; the terminal `done` payload carried `status`; finishing chat A left chat B running; A's reply persisted.
- **Live grace-period probe** (`BROWSER_RELAY_GRACE=3s`): job survives immediately after its tail drops; is cancelled once the grace expires with nothing attached; **survives past the grace while the global stream is open** (the real chat-switch case); is cancelled after the global stream drops too.
- **Git semantics probe** (scratch repo, removed after): the main tree appears in `worktree list --porcelain` with its branch; a second worktree for an already-checked-out branch is refused by git; edits in one worktree do not touch the other.

## Remaining (user)
`npm run desktop` from `orchestrator/mc-integrate` and exercise the full loop, which needs a running app and a real local model:
1. Start agent chats on two different repos, plus two chats on different branches of the same repo. Confirm all keep running while you switch between them, and that the sidebar shows each as running.
2. Reload mid-run — chats should resume, not die.
3. Confirm each chat's edits land on its own branch (`git worktree list` in the repo shows one tree per branch).
4. Approve two tool calls in a row, from different chats — both dialogs must work (this is the single-shot approval bug).
5. Let a chat you are *not* viewing finish, with the window unfocused → expect a native notification plus a sidebar badge. macOS will ask for notification permission the first time.
