# Reliable agent file operations + pause/resume — task list

Source: Warp Drive notebook "Reliable agent file operations + pause/resume".
Branch: `feat/agent-file-tools-pause-resume` off `main`. Three commits, in
order, all verified locally with `make check` (now including `cargo test`).
Nothing is pushed and no PR is opened until all three are in and verified.

## Problem

Two things to fix in the agent harness:

- **File work is unreliable.** The only write tools are `apply_patch` (a strict
  `git apply`) and `run_command`; there is no create/save/delete/move tool. A
  rejected patch comes back as a plain error observation and the run continues
  as if the work were done — the "it skips steps" symptom. A 6-step budget
  compounds it by cutting multi-file work off mid-task.
- **There is no pause.** A run can only be cancelled, and cancelling throws
  away the agent's transcript, so the work cannot be picked up again.

## Phase 1 — Direct file tools + hardened apply_patch + run_command timeout ✅

Unblocks the reported failure on its own. Sections 1 & 2 of the spec.

- [x] Sidecar `desktop/src-tauri/src/github.rs`: `resolve_new_path` helper
  beside `safe_path` — canonicalize the deepest existing ancestor, rejoin the
  remainder, reject traversal outside the repo root and any path inside
  `.git/` (create-oriented tools need a different resolver than `safe_path`,
  which only resolves paths that already exist).
- [x] Sidecar: `write_file {path, content}` — create or overwrite, creating
  parent directories. Observation reports created-vs-overwritten plus byte and
  line counts. First call returns `needs_approval` with a unified-diff preview.
- [x] Sidecar: `edit_file {path, old_string, new_string, replace_all?}` — exact
  string replacement. Missing `old_string` or >1 match (without `replace_all`)
  returns an error observation naming the match count and asking for more
  surrounding context; the file is unchanged. The reliable substitute for
  diffs on small models.
- [x] Sidecar: `delete_path {path, recursive?}` — refuses the repo root and
  anything under `.git/`; a directory needs `recursive`.
- [x] Sidecar: `move_path {from, to}` — rename or move, creating parent
  directories.
- [x] Sidecar: shared `unified_diff(old, new, path)` helper so all four file
  tools' approval previews render through the existing colored-diff renderer
  (`renderApprovalContent`).
- [x] Sidecar: harden `exec_apply_patch` — normalize before applying (strip
  markdown fences + prose preamble, normalize CRLF, guarantee exactly one
  trailing newline); apply ladder first-success-wins (plain → `--recount` →
  `--3way` → `--recount --unidiff-zero -C0`), report which variant succeeded;
  on success return `git apply --numstat` output (files + line counts) instead
  of the fixed string; on failure return the git error + first failing hunk
  header + an explicit instruction to switch to `write_file`/`edit_file`.
- [x] Sidecar: `run_command` timeout — `run_command_timeout_ms` on `ExecBody`
  (default 120000); `exec_run_command` and `repos_exec_stream` wrap the child
  in `tokio::time::timeout`, kill on expiry, return partial output + a "timed
  out after Ns" note (exit 124). Carried on the toolExec payload so the backend
  stays authoritative.
- [x] Sidecar: wire the four tools into the `repos_exec` dispatcher.
- [x] Sidecar: `#[cfg(test)]` module — patch normalization, the apply ladder
  (no-trailing-newline and zero-context patches both applying),
  `resolve_new_path` traversal + `.git` guards, `edit_file` match counting
  (0 / 1 / >1 / `replace_all`). `Makefile` `check-desktop` runs `cargo test`
  alongside `cargo check`.
- [x] Backend `agent.go`: `writeFileTool`/`editFileTool`/`deletePathTool`/
  `movePathTool` schemas; register `local: true` in `toolRegistry`; add to
  `defaultAgentTools()` and `availableTools()`. Reword `applyPatchTool`'s
  description to steer single-file edits to `write_file`/`edit_file`.
- [x] Backend `jobs.go`: add the four tools to the repo-bound allow append;
  `toolExecPayload` carries `RunCommandTimeoutMs`; `emitToolRelay` passes
  `s.cfg.runCommandTimeout` through.
- [x] Backend `main.go`: `runCommandTimeout` config + `RUN_COMMAND_TIMEOUT` env
  (default 120s).
- [x] Backend `agent_tools_test.go`: wiring test for the four new tools
  (allowlist + registry + `availableTools` + `local:true` + required args).
- [x] Renderer `desktop/renderer/desktop.js`: `AUTO_APPROVE_TOOLS` gains
  `write_file`, `edit_file`, `move_path` (not `delete_path` — always prompts,
  like `create_pr`/`merge_pr`); `COMMAND_TOOLS` gains the four; `runToolExec`
  threads `runCommandTimeoutMs` through both buffered and streaming paths;
  `renderApprovalContent` treats the new tools' `@@` previews as diffs.
- [x] Cache-bust: bump `desktop.js?v=N` (and `desktop.css?v=N` only if CSS is
  touched) in `desktop/src-tauri/src/sidecar.rs`.
- [x] Docs: `backend/AGENTS.md` (new tools + `RUN_COMMAND_TIMEOUT`),
  `desktop/AGENTS.md` (dispatcher tools + approval set).
- [x] Validated: `make check` clean (incl. `cargo test`); `node --check` on
  `desktop/renderer/desktop.js`.
- [x] Manual pass (desktop app, not covered by `make check`): a repo-bound chat
  creates a file in a new directory, edits it, renames it, deletes it.

## Phase 2 — Step budget, observation wording, tool-list dedupe 🚧

Section 3 of the spec.

- [ ] Raise `MAX_AGENT_STEPS` default 6 → 24 in `backend/main.go`,
  `docker-compose.yml`, `.env.example`, and the README env table.
- [ ] `runAgentLoop`: at 80% of the budget append a system message telling the
  model how many steps remain and to finish outstanding edits then summarize.
- [ ] `runAgentLoop`: emit a trace `agentStep` (`Tool: "(budget)"`) when the
  budget forces the final tools-removed answer, so the truncation is visible in
  the UI instead of silent.
- [ ] `runAgentLoop`: a narration re-prompt round does not consume a step.
- [ ] Strengthen the failed-write observation: state that the file is
  unchanged, that repeating the identical call will fail again, and which tool
  to use instead.
- [ ] Collapse the duplicated local tool lists into one `localRepoTools()`
  helper used by `defaultAgentTools`, `availableTools`, and the repo-bound
  append in `jobs.go`; wire up `git_log` and `list_prs` (schemas + registry)
  while doing it so the model can finally call them.
- [ ] Docs: `backend/AGENTS.md` (budget + tool list). Go tests: the 80%
  warning firing, narration retry not consuming a step, `localRepoTools()`
  containing `git_log`/`list_prs`.
- [ ] Validated: `make check` clean.

## Phase 3 — Pause and resume 🚧

Section 4 of the spec. Checkpointing applies to agent-mode runs only; plain
chat, search, and clarify turns keep the existing Stop behaviour.

- [ ] Backend `jobs.go`: `pauseRequested` on `job` + a `roundCancel
  context.CancelFunc`; `pause()` sets the flag and cancels the current round's
  child context so pause takes effect within seconds, not after a full
  inference round. The partial round is discarded.
- [ ] Backend `agent.go`: `runAgentLoop` derives a per-round child ctx, stores
  `roundCancel` on the job under `j.mu`, checks `pauseRequested` at the top of
  each iteration and after each tool result, and on pause returns a sentinel
  `errAgentPaused` carrying the transcript and step index. Pausing between
  steps means no tool relay is ever left in flight.
- [ ] Backend `store.go`: new `agent_checkpoints(job_id, conversation_id,
  email, step, transcript, model, created_at)` table + `migrate` guard;
  `saveCheckpoint`/`loadCheckpoint`/`deleteCheckpoint`. `transcript` is the
  JSON `[]oaiMessage` list.
- [ ] Backend `jobs.go` worker: on `errAgentPaused`, persist the checkpoint,
  persist the partial assistant message (with steps + thoughts), finalize the
  job `paused`, and `notifyPaused` (terminal SSE `done` carrying
  `status:paused` via the hub). `reconcileJobs` is unchanged — `paused` rows
  are untouched, so a paused run is still resumable after a backend restart.
- [ ] Backend routes: `POST /api/conversations/{id}/pause` → `handlePause`;
  `POST /api/conversations/{id}/resume` → `handleResume` (optional note
  appended as a user turn). `GET /api/conversations/{id}/job` and
  `GET /api/jobs/active` expose the `paused` status and the checkpoint's step
  index.
- [ ] Backend `runGeneration` resume path: rehydrates the transcript, rebuilds
  the system prompt from scratch (date/repo/branch current), continues on the
  remaining step budget, deletes the checkpoint once the run finishes cleanly.
- [ ] Backend tests: checkpoint round-trip + resume rehydration; pause
  requested during a tool round (relay not left in flight); `reconcileJobs`
  leaves `paused` alone.
- [ ] Frontend `www/app.js` + `www/lib.js`: while an agent job runs the Stop
  control gains a Pause action; Pause POSTs `/pause`; the bubble switches to a
  paused phase showing "Paused at step N" with a Resume button. `tailJob`
  learns the `paused` terminal status; `finishJob` and the sidebar show a
  paused badge instead of a spinner. On load a conversation whose newest
  assistant turn has a live checkpoint renders the Resume affordance (survives
  reload, chat switch, backend restart).
- [ ] Frontend: `pause` icon in `lib.js` ICONS; cache-bust `app.js?v=N`,
  `lib.js?v=N` in the `app.js:3` import (and `styles.css?v=N` if CSS touched)
  in `www/index.html`.
- [ ] Docs: `www/AGENTS.md` (new routes + `paused` SSE status),
  `backend/AGENTS.md` (new table + routes + pause/resume lifecycle).
- [ ] Validated: `make check` clean.
- [ ] Manual pass (desktop app): a long run paused mid-way and resumed after an
  app reload.

## Implementation order

All of it lands locally first. One branch — `feat/agent-file-tools-pause-resume`
— with three commits, in this order:

1. File tools plus the hardened `apply_patch` and the `run_command` timeout
   (Phases 1). This alone unblocks the reported failure.
2. Step budget, observation wording, and the tool-list dedupe (Phase 2).
3. Pause and resume (Phase 3).

Docs and tests ship with the commit they belong to. Verification stays local
throughout: `make check` after each commit, plus the desktop manual pass after
commits 1 and 3 (the sidecar and renderer changes are not covered by
`make check`). Nothing is pushed and no PR is opened until all three are in and
verified.

The phases stay separate commits rather than one squashed change so the
eventual PR is still reviewable step by step, and commit 1 can be split off
into its own PR at push time if the file-tool fix should ship ahead of the rest.

## Decisions

- `apply_patch` stays in the default allowlist, with its description reworded
  to steer single-file changes to `write_file`/`edit_file`.
- Auto-approve covers `write_file`, `edit_file`, and `move_path`. `delete_path`
  always prompts, joining `create_pr`/`merge_pr` as tools the auto-approve
  setting does not silence.
- `RUN_COMMAND_TIMEOUT` is a backend env (default 120s) carried on each
  `toolExec` payload; the sidecar enforces it so the value stays authoritative
  on the backend.
- No child agents: the three commits are strictly sequential and share files
  across surfaces (`agent.go`, `jobs.go`, `github.rs`), so parallel agents on
  one branch would conflict. Implemented sequentially on one branch.
