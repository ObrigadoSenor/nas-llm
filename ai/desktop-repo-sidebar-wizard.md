# Desktop app: fix Connect-folder wizard, move repos into the left sidebar, add first-load wizard — task list

Source plan: `37158613-5eb4-4fe0-a3a5-fee0b3d55738`.

## Tasks
- [x] Backend: add `POST /__sidecar/repos/scan-local` endpoint (`desktop/src-tauri/src/github.rs`) — resolves a single repo root, or scans one level of subdirectories for git repos and returns candidates.
- [x] Frontend: fix `pickFolder()`'s silent `.catch(() => null)` and add a shared `connectFolderFlow()` (pick → scan → add one or show a multi-select checklist) (`desktop/renderer/desktop.js`).
- [x] Frontend: inject a collapsible "Repos" section into the left sidebar (`#sidebar`), with a "+" to connect a folder and per-repo Pull/Ship/+New chat actions; drop the modal's now-redundant "Local clones" list + "Connect folder" button.
- [x] Frontend: first-load wizard shown once when zero repos are connected, reusing `connectFolderFlow()`.
- [x] Docs: log this phase in `ai/tasks.md`.
- [x] Validate: `cargo check`/`cargo build` in `desktop/src-tauri`; `node --check` on `desktop/renderer/desktop.js`.
