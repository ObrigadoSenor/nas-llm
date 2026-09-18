# Agent UI awareness (`ui_*` tools) — task list

Branch: `feat/agent-ui-awareness` off `main`. One branch, sequential — the
backend schema, the shared executor, and the desktop shim are one contract
across three surfaces, so parallel work would only conflict.

## Problem

Asked about something on screen — "what's the number next to the drawer
icon?" — the agent answered:

> I'm unable to interact with the user interface or provide information about
> UI elements.

That was accurate. The harness had no UI surface at all: no tool, no prompt,
nothing. And the answer is not in the source either — that number is
`.ds-badge` on `.ds-drawer-btn`, written by `refreshChangesBadge`
(`desktop/renderer/desktop.js`) from live git state, so it exists only in the
DOM of the running app.

## Shape of the fix

A `ui_*` tool family relayed over the existing `toolExec` cue, but executed by
the **page** rather than the desktop sidecar. That placement is the whole
design: it is what lets the same code serve the desktop shell and
`chat.selected.systems`.

## Phase 1 — Backend tool family ✅

- [x] `backend/agent_ui.go`: single-source `uiToolDefs` table with
  `ui_snapshot` (optional `area` enum), `ui_read {ref}`, `ui_click {ref}`,
  `ui_set_value {ref, value}`; `uiTools`/`uiActionTools`/`uiToolMetas` derived
  from it; `isUITool`/`containsAnyUITool`/`uiTargetFor` helpers; `uiTargetApp`.
- [x] `agent_tools.go`: register the family in `toolRegistry` (`local:true`,
  no server-side executor), append `uiToolMetas` to `availableTools`, and add
  `uiActionTools` to `planWriteTools` (plan mode may look, not touch).
- [x] `jobs.go`: `toolExecPayload.Target`; `emitToolExec` stamps it via
  `uiTargetFor`; `uiEnabled` makes the relay non-nil with no repo bound; ui_*
  calls carry neither repo nor host.
- [x] `agent_prompt.go`: `injectUIContext` — applied when the allowlist has a
  ui_* tool. Forbids the disclaimer, warns that refs go stale, and tells the
  model to look up what a value *means* in the source rather than guessing
  from the number.
- [x] `handlers.go`: `agentRunNeedsBrowser` returns true for a UI-enabled run.
- [x] `backend/agent_ui_test.go`: wiring, opt-in contract, target stamp, plan
  gating, browser binding, prompt content.

### Two defects this surfaced (fixed here)

- **The relay no longer implies a workspace.** `runAgentLoop` drops local tools
  when there is no relay, which used to mean "no repo → no file tools". With
  ui_* on, a repo-less run *has* a relay, so `read_file`/`run_command`/
  `todo_write` would have been offered with nothing able to execute them — the
  sidecar errors on an empty repo, and the browser UI (which only handles ui_*)
  would never answer at all, stalling the run until `TOOL_EXEC_TIMEOUT`.
  `filterRepoTools` now drops them whenever no workspace is bound. This was
  already latent for an SSH-only chat; it is fixed for that case too.
- **`validateToolArgs` rejected a bare no-arg call.** Empty `arguments` failed
  validation even for a schema with no required fields, so a model emitting
  `""` instead of `"{}"` burned a step being told off for a valid call. Since
  `ui_snapshot` is the entry point for every UI question, that was a step tax
  on the common path. Empty args are now accepted when nothing is required —
  which also helps `get_time`, `git_status`, `git_push`, `list_prs` and
  `todo_read`.

## Phase 2 — Shared executor ✅

- [x] `www/ui.js`: region-grouped DOM snapshot (`login`/`sidebar`/`header`/
  `chat`/`composer`/`drawer`/`dialog`) with refs, roles, labels and state;
  `#chat` summarized rather than serialized; ref registry resolving by element
  identity with a "stale, re-snapshot" error; `ui_click`/`ui_set_value` with a
  post-action delta so the agent learns what changed without another step.
- [x] Approval: inline in the command block via `window.nasllm.blocks`, with a
  small `.modal` fallback for a background chat. Auto-approved when the
  conversation is — except destructive controls, which always ask.
- [x] Safety rails: `#send` refused (no self-prompting); every approve/reject
  control refused; both approval overlays excluded from snapshots entirely;
  password/email values never reported.
- [x] `www/app.js`: import `ui.js`, add `toolExec` listeners to both the
  conversation tail and the global stream (ui_* only, deduped by `jobId:step`).
- [x] `www/lib.js`: `ui_click`/`ui_set_value` join `COMMAND_TOOLS` (block +
  inline approval); labels and arg summaries for the trace.
- [x] `desktop/renderer/desktop.js`: the toolExec shim returns early for ui_*
  so www/ owns them; `runToolExec` refuses them defensively.

## Phase 3 — Bookkeeping ✅

- [x] Cache-bust: `app.js?v=60` (`www/index.html`), `lib.js?v=38` and the new
  `ui.js?v=1` (both in the `www/app.js` imports), `desktop.js?v=49`
  (`desktop/src-tauri/src/sidecar.rs`).
- [x] Docs: `backend/AGENTS.md` (new file, tools, prompt builder, tests, a "UI
  awareness" architecture pointer), `www/AGENTS.md` (the new module, its
  cache-bust site, the contract-5 amendment), `desktop/AGENTS.md` (shim
  delegation).
- [x] `make check` clean; `node --check` on every touched JS file.

## Decisions

- **Opt-in, default off.** The ui_* tools are not in `defaultAgentTools`.
  Enabling one makes the run browser-bound (`agentRunNeedsBrowser`), so a
  server-model agent run that today survives the app closing would start being
  grace-cancelled. That is a real trade and belongs to the user, not to a
  default. Turn them on in Agent settings; flipping the default later is a
  one-line change.
- **Text snapshots, not screenshots.** The observation channel is a string and
  the catalog's local models are mostly non-vision. A semantic snapshot is also
  what a small model can actually act on.
- **`target` is on the payload, not in the schema.** Only `"app"` exists today.
  The wire field and the renderer's routing are in place, so a second target (a
  dev-server preview, say) is a new executor plus a `target` param on the
  schemas — not a change to the backend contract. Keeping it out of the
  model-facing schema means no tokens spent choosing a constant.
- **Plain chat is untouched.** Non-agent turns have no tool loop, so the same
  question asked outside Agent mode still gets a disclaimer. Adding UI text to
  `plainChatNudge` would tax every plain turn on the N100 for little gain.

## Not covered by `make check`

Everything in Phase 2 is UI-only. It needs a human pass in both surfaces:

- Ask "what's the number next to the drawer icon?" in an agent chat with the
  UI tools enabled — the agent should snapshot, answer from live state, and
  (with the repo bound) cross-check the meaning against `refreshChangesBadge`.
- A `ui_click` (e.g. open the drawer) and a `ui_set_value` into `#input`.
- Confirm `ui_click` on an approve button and on `#send` are both refused.
- Confirm the same flow works in the browser at `chat.selected.systems`, where
  there is no sidecar and the approval falls back to the built-in prompt.
