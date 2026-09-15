#!/usr/bin/env bash
# codesign-linker.sh — cargo linker wrapper that re-signs the nas-llm-desktop
# debug binary with a stable self-signed identity after every link, so the
# macOS Keychain access ACL (keyed to the app's code signature) lets one
# "Always Allow" persist across `tauri dev` rebuilds — instead of prompting for
# your keychain password on every launch.
#
# Opt-in and zero-impact when unused: if NASLLM_CODESIGN_ID is unset, this is a
# transparent passthrough to the real linker (cc). It only re-signs the final
# `nas-llm-desktop` executable (gated by basename); build-script, test, and
# dylib outputs are left to the linker's own ad-hoc signature. A signing
# failure prints a stderr warning and never fails the build.
#
# Wired in by dev.sh via CARGO_TARGET_<TRIPLE>_LINKER — never set globally (not
# in .cargo/config.toml) so `npm run desktop`, `make check-desktop`, and CI run
# on the stock linker. See desktop/README.md "Local code-signing (dev)".
set -u

# The real linker. Cargo sets CC for the target when compiling C/C++ but does
# not always export it into the linker env; fall back to cc (clang on macOS).
real_linker="${CC:-cc}"

# No identity configured → behave exactly like the default linker.
if [ -z "${NASLLM_CODESIGN_ID:-}" ]; then
  exec "$real_linker" "$@"
fi

# Run the real link first and preserve its exit code. A failed link must fail
# the build regardless of signing.
"$real_linker" "$@"
link_rc=$?
if [ "$link_rc" -ne 0 ]; then
  exit "$link_rc"
fi

# Parse -o <out> from the linker args (handle both "-o out" and "-oout").
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-o" ]; then
    out="$arg"
    break
  fi
  case "$arg" in
    -o) prev="-o" ;;
    -o*) out="${arg#-o}"; break ;;
  esac
done

# Only re-sign the main app binary; skip build-script/test/dylib outputs.
if [ -z "$out" ] || [ "$(basename "$out")" != "nas-llm-desktop" ]; then
  exit 0
fi
if [ ! -f "$out" ]; then
  exit 0
fi

# Re-sign with the stable identity + a stable designated requirement (the
# bundle identifier from tauri.conf.json). --force overwrites the linker's
# ad-hoc signature. A failure is non-fatal: the binary still runs, just with
# the ad-hoc sig (the keychain prompt returns until signing succeeds).
if ! codesign --force --sign "$NASLLM_CODESIGN_ID" \
     --identifier "com.selected.nasllm.desktop" "$out"; then
  echo "warning: codesign-linker: signing $out failed (build continues; keychain may prompt)" >&2
fi
exit 0
