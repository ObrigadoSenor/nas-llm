# Release v0.3.0

Task list for cutting the `v0.3.0` desktop release.

## Context

- Previous release: `v0.2.1` (version `0.2.1` in all manifests).
- `orchestrator/mc-integrate` sat 22 commits past `v0.2.1` (11 ahead of `origin/main`)
  with new features: multi-agent concurrency, per-(repo,branch) git worktrees,
  repo-chat UI, native completion notifications.
- The `desktop-release.yml` workflow fires only on a pushed `v*` tag and never
  auto-bumps the version, so commits alone never produced a new release.

## Plan

1. Bump `0.2.1` → `0.3.0` (minor) in:
   - `desktop/src-tauri/tauri.conf.json`
   - `desktop/package.json`
   - `desktop/src-tauri/Cargo.toml`
2. Commit the bump (+ this log) on `orchestrator/mc-integrate`.
3. Sync local `main` with `origin/main`.
4. Merge `orchestrator/mc-integrate` into `main` (`--no-ff`).
5. Push `main`, then tag `v0.3.0` on `main` and push the tag to trigger
   `.github/workflows/desktop-release.yml` (builds macOS dmg/app, signs the
   updater artifact, publishes `latest.json`).

## Notes

- Workflow currently builds macOS only (`--bundles dmg,app`); Windows artifacts
  are not produced by CI, so Windows users won't get an updater offer.
- Updater pubkey / `latest.json` endpoint are configured in
  `tauri.conf.json` `plugins.updater`.
