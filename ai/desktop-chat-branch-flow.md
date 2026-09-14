# Desktop chat/branch flow: branch-from-main + lazy worktree, active-chat highlight, immediate sidebar add — task log

## Goal
Rework the desktop "repo → agent chat" flow so a new chat is just a branch from
main (no git worktree provisioned upfront), the active chat is highlighted in
the sidebar repo dropdown, and a newly created chat appears under its repo
immediately instead of only after the first message. Keep branch isolation for
concurrent chats on different branches via a lazily-created worktree.

## Decisions (confirmed with the user)
- New chat = a branch cut from the repo's default branch in the repo folder.
  No worktree is provisioned at creation.
- A worktree is created lazily, only when a chat runs a tool on a branch that
  isn't the repo folder's current checkout. This keeps two chats on two
  branches isolated without paying the worktree cost (or risking the dirty-tree
  carry) for every chat.
- Dirty folder handling: opening/creating a chat on a different branch never
  moves a dirty working tree. The branch is created without checkout (or left
  alone if it already exists) and the chat runs in a lazy isolated worktree.
  A clean folder is switched onto the chat's branch so its tools run there
  directly.

## Changes

### Sidecar (`desktop/src-tauri/src/github.rs`)
- New `POST /__sidecar/repos/create-branch` `{name, branch, base?}`:
  - Clean folder + new branch → `git switch -c <branch> <base>` (folder onto
    branch, no worktree). `base` defaults to the repo's default branch.
  - Clean folder + existing branch → `git switch <branch>`.
  - Dirty folder + new branch → `git branch <branch> <base>` (ref only, no
    checkout) so `repos_exec` lazily makes an isolated worktree.
  - Dirty folder + existing branch → no-op (lazy worktree isolates).
  - Idempotent (folder already on `branch` → ok). Updates the registry + re-pushes
    repo context only when it actually switches the folder. Returns
    `{ok, branch, isolated, error}`. Registered in `router()`.
- `repos_exec` and `resolve_repo_branch` are unchanged: they already resolve a
  chat's branch to a worktree via `ensure_worktree(create=false)`, which is
  exactly the lazy-isolation path (reuse the folder if it's on the branch;
  otherwise `git worktree add`).

### Renderer (`desktop/renderer/desktop.js` + `desktop.css`)
- `createRepoChat`: replaced the `repos/worktree{create:true}` block with
  `repos/create-branch`. After the PATCH it now auto-expands the repo
  (`expandedRepos.add` + `saveExpandedRepos`), `await refreshLocal()`, dispatches
  `nasllm:refreshConvs`, then `navigateToConv`. Awaiting `refreshLocal` (instead
  of firing it and navigating away) is what makes the new chat appear under its
  repo on creation rather than only after the first message.
- `switchChatBranch`: re-pointed to `repos/create-branch` for local/new branches
  and `repos/checkout{remote:true}` for remote-only branches; `openChatBranchPicker`
  passes `isRemote` per row. Copy updated to describe the switch-when-clean /
  isolate-when-dirty model.
- Active-chat tracking: new `activeConvId` + `getActiveConvId()` (falls back to
  `activeConvIdFromDOM()`). `localRow` stamps `data-conv-id` + `.active` on each
  repo-chat row; `highlightActiveRepoChat()` toggles `.active` to match the
  active conv. `actualSyncBranchRail`, `runToolExec`'s rail-refresh check, and
  `isConvOnScreen` now use `getActiveConvId()` — this also fixes the latent bug
  where repo-bound chats (filtered out of `#convList`) made
  `activeConvIdFromDOM()` return null, so the branch rail never bound to a repo
  chat. CSS: `.ds-repo-chat.active`.

### Web UI (`www/app.js`)
- Additive `nasllm:activeConv` dispatch in `openConversation` (detail = id),
  `newChat` (null), and `logout` (null). No other app.js behavior changes; the
  plain web UI ignores the event.

### Cache-bust (`desktop/src-tauri/src/sidecar.rs`)
- `desktop.css?v=18` → `v=19`, `desktop.js?v=23` → `v=24`.

### Docs
- `desktop/README.md`: "Repo → agent chat" and "A branch per chat" sections
  rewritten for the no-upfront-worktree + lazy-worktree model, the active-chat
  highlight, and the immediate sidebar add.

## Validation
- `cargo check` clean in `desktop/src-tauri`.
- `node --check` clean on `desktop/renderer/desktop.js` and `www/app.js`.

## Remaining (user)
- `npm run desktop` and exercise: connect a repo → + New chat → chat appears
  under the repo immediately and is highlighted → composer status line shows the
  new `agent/<repo>-<id>` branch → ask the agent to edit → approve → the edit
  lands on the chat's branch (folder switched when clean). Then start a second
  chat on the same repo while the first has uncommitted edits and confirm the
  first chat's branch/edits are not disturbed (the second chat runs in a lazy
  worktree). Use the ⎇ chip to re-point a chat at an existing/new branch.
- Note the concurrency tradeoff accepted by this change: without an upfront
  worktree, a chat whose branch isn't the folder's current checkout relies on
  the lazy worktree in `repos_exec`; the repo folder itself reflects whichever
  chat was last switched onto it (shown in the composer status line).
