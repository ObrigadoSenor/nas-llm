# Release v0.3.3

Archive log for cutting the `v0.3.3` desktop release — the first release that
boots a working UI when installed normally. Covers the two fixes that landed
this session and the broken releases they supersede.

## Context

- `v0.3.0` shipped the multi-agent concurrency work but had **no bundled UI
  assets** (`bundle.resources` was missing), so the installed app was blank.
- `v0.3.1` added `bundle.resources` (map form: `../../www/ → www/`,
  `../renderer/ → renderer/`) and resolved them via Tauri's `resource_dir()` /
  `resolve(.., BaseDirectory::Resource)`. CI built it and published
  `latest.json`; the updater offered it.
- `v0.3.2` added the toolExec dedupe fix (PR #20).
- Both `v0.3.1` and `v0.3.2` were **still broken on a real install**: Tauri's
  `resource_dir()` canonicalizes the exe-relative path
  (`${exe_dir}/../Resources`), and `canonicalize` returns `Err` on the CI-built
  release binary even though the bundled files exist at that path. Resolution
  fell through to the compile-time `CARGO_MANIFEST_DIR` default (a
  `/Users/runner/...` path absent on a user's machine) → every www/renderer
  asset 404'd → blank window.
- The v0.3.1 "verification" missed this because that same fallback pointed at
  the live source tree on the dev machine, masking the failure. The lesson:
  verify against the **published CI artifact**, not a local build on the dev
  machine.

## Fixes shipped

### PR #20 — toolExec dedupe (in v0.3.2)
Repo-bound agent chats stalled when started or switched ("they cancel out and
don't reply"). Root cause: the desktop `EventSource` shim attaches a
`toolExec` listener to every `EventSource`, and the backend broadcasts each
`toolExec` to **both** the job's per-conversation tail and the owner's global
`/api/events` hub — so a foreground chat's file-tool call ran twice. For write
tools (`apply_patch`, `run_command`, `git_*`, `create_pr`) that meant two
approval dialogs for one call; whichever the user acted on second delivered a
spurious "user rejected" observation and stalled the agent. `modelCall` never
had this (the global stream skips `d.convId === activeJobConvId`); `toolExec`
had no guard.

Fix: dedupe in the shim by `jobId:step`, checked synchronously before the
first `await` and held for the life of `runToolExec`. Exactly one stream
services each tool call; backgrounded chats (tail closed) keep running via the
global stream unchanged. Also bumped the `desktop.js` cache-bust `v20 → v21`.

### PR #21 — resource-dir fallback (in v0.3.3)
Added `exe_relative_resource()` in `main.rs`: computes
`current_exe().parent()/../Resources/<leaf>` and probes with `.exists()`,
which resolves `..` without needing `canonicalize` to succeed. Runs after
`resource_dir()`/`resolve()` but before the `CARGO_MANIFEST_DIR` default, so
the common case is unchanged and only the failing-canonicalize case is
rescued. Also logs the resolved `www`/`renderer` paths at info for
diagnosability.

## Release chain

| Tag | Contents | State |
|-----|----------|-------|
| v0.3.0 | multi-agent concurrency (no bundled resources) | broken — blank window |
| v0.3.1 | bundling fix (map-form `resources`) | broken — `resource_dir()` fails on CI binary |
| v0.3.2 | + toolExec dedupe (PR #20) | broken — same resource-dir regression |
| **v0.3.3** | + `exe_relative_resource` fallback (PR #21) | **working — first good release** |

`v0.3.3` was cut via `scripts/bump-desktop-version.sh patch` (0.3.2 → 0.3.3),
committed as `Release v0.3.3` (`97dfe30`), tagged `v0.3.3`, and pushed to
trigger `.github/workflows/desktop-release.yml`.

## Verification (end-to-end, published CI artifact)

CI run `34818945148` — ✓ success (6m13s). Release v0.3.3 published (not
draft/prerelease) with `latest.json`, `nas-llm_0.3.3_aarch64.dmg`,
`nas-llm_aarch64.app.tar.gz`, and the signed
`nas-llm_aarch64.app.tar.gz.sig` (so in-app updates verify against the
pubkey in `tauri.conf.json`).

Decisive probe: downloaded the published DMG, copied `.app` out, ran the
**CI-built binary** with `NASLLM_WWW`/`NASLLM_RENDERER` unset (real-install
scenario — the exact case that 404'd for v0.3.2):

- Resolved-path log: `www=…/MacOS/../Resources/www
  renderer=…/MacOS/../Resources/renderer` — confirms `resource_dir()` still
  fails on the CI binary and the `exe_relative_resource` fallback now catches
  it.
- `index.html`, `app.js`, `styles.css`, `vendor/marked.esm.js`,
  `__sidecar/desktop.js`, `__sidecar/desktop.css`, and a sentinel placed only
  in `Resources/www`: all **200** (v0.3.2 returned 404 for all).
- `/api/auth/me` proxy: **200**.
- Bridge injection: `desktop.js?v=21`; toolExec dedupe code present in the
  served `desktop.js`.

## Update path

`latest.json` advertises v0.3.3, so installed apps on ≤v0.3.2 are offered it
via ⚙ Desktop settings → Updates. The updater compares version strings, not
bundle health, which is why broken v0.3.0–v0.3.2 were still offered — v0.3.3
is what makes that update path deliver a working app.

## Notes

- Workflow builds macOS only (`--bundles dmg,app`); Windows artifacts are not
  produced by CI.
- CI annotations flagged Node.js 20 deprecation in `actions/checkout@v4` /
  `setup-node@v4` (forced to Node 24) — non-blocking, worth a future bump.
- Process for future releases: verify against the **published DMG** (download,
  copy out, run with env unset), not a local `tauri build` — the dev-machine
  source tree masks `resource_dir()`/fallback failures.
