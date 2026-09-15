#!/usr/bin/env bash
# dev.sh — launch `tauri dev` with the codesign linker wrapper active, so each
# rebuild of the debug binary is re-signed with a stable self-signed identity
# and the macOS Keychain stops prompting for your password on every launch.
#
# One-time prerequisite: bash scripts/setup-codesign.sh  (creates the cert)
# Then:  cd desktop && npm run desktop:signed   (which calls this script)
# See desktop/README.md "Local code-signing (dev)".
set -euo pipefail

# Resolve this script's dir so the wrapper path is absolute. Cargo needs an
# executable path for CARGO_TARGET_*_LINKER; a relative path would resolve
# against cargo's cwd, not the desktop dir.
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
wrapper="$script_dir/codesign-linker.sh"

if [ ! -x "$wrapper" ]; then
  echo "error: $wrapper is missing or not executable" >&2
  echo "       run: chmod +x \"$wrapper\"" >&2
  exit 1
fi

# Default to the self-signed identity created by setup-codesign.sh. Override
# with the env var to use a different (e.g. Apple Developer) identity.
export NASLLM_CODESIGN_ID="${NASLLM_CODESIGN_ID:-nas-llm-dev}"

# Wire the wrapper in as the per-target linker for both Apple Silicon and
# Intel. Using env vars (not .cargo/config.toml) keeps this scoped to this
# shell only — `npm run desktop`, `make check-desktop`, and CI stay on the
# stock linker and are completely unaffected.
export CARGO_TARGET_AARCH64_APPLE_DARWIN_LINKER="$wrapper"
export CARGO_TARGET_X86_64_APPLE_DARWIN_LINKER="$wrapper"

# Run from the desktop dir (where package.json lives) and hand off to tauri
# dev, preserving auto-rebuild, devtools, and forwarded args.
cd "$script_dir/.."
exec npm run desktop "$@"
