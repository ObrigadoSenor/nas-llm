#!/usr/bin/env bash
# setup-codesign.sh — one-time creation of a self-signed code-signing identity
# (nas-llm-dev) in your login keychain. dev.sh / codesign-linker.sh use it to
# keep the nas-llm-desktop debug binary's signature stable across `tauri dev`
# rebuilds, so the Keychain stops asking for your password on every launch.
#
# Run once:  bash desktop/scripts/setup-codesign.sh
# Then:      export NASLLM_CODESIGN_ID=nas-llm-dev   (add to ~/.zshrc)
# Then:      cd desktop && npm run desktop:signed
#
# Self-signed is for LOCAL DEV ONLY. It does not satisfy Gatekeeper for anyone
# else; distribution signing is the separate APPLE_* path in
# .github/workflows/desktop-release.yml. See desktop/README.md
# "Local code-signing (dev)".
set -euo pipefail

id="${NASLLM_CODESIGN_ID:-nas-llm-dev}"

# macOS only.
if [ "$(uname -s)" != "Darwin" ]; then
  echo "error: setup-codesign.sh is macOS-only (got $(uname -s))" >&2
  exit 1
fi
command -v openssl >/dev/null 2>&1 || { echo "error: openssl not found in PATH" >&2; exit 1; }
command -v security >/dev/null 2>&1 || { echo "error: security not found in PATH" >&2; exit 1; }

# Idempotent: if the identity already exists, there's nothing to do.
if security find-identity -p codesigning -v 2>/dev/null | grep -q "\"$id\""; then
  echo "Identity \"$id\" already exists in the keychain. Nothing to do."
  echo "Run: export NASLLM_CODESIGN_ID=$id"
  exit 0
fi

# Locate the login keychain (.keychain-db on 10.12+, .keychain on older macOS).
login_keychain="$HOME/Library/Keychains/login.keychain-db"
[ -f "$login_keychain" ] || login_keychain="$HOME/Library/Keychains/login.keychain"
if [ ! -f "$login_keychain" ]; then
  echo "error: could not find login keychain under $HOME/Library/Keychains/" >&2
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# openssl config with the codeSigning extended key usage. macOS ships
# LibreSSL as /usr/bin/openssl, which lacks -addext, so use a config file.
cat >"$tmp/openssl.cnf" <<EOF
[req]
distinguished_name = req_dn
prompt = no
x509_extensions = v3_codesign

[req_dn]
CN = $id

[v3_codesign]
basicConstraints = CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = codeSigning
EOF

echo "Generating a self-signed code-signing certificate (\"$id\")…"
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$tmp/key.pem" -out "$tmp/cert.pem" \
  -days 3650 -config "$tmp/openssl.cnf"

# Export a p12. The password is only used once to import; the keychain stores
# the key itself afterward.
pw="$id-$(date +%s)"
openssl pkcs12 -export -out "$tmp/identity.p12" \
  -inkey "$tmp/key.pem" -in "$tmp/cert.pem" \
  -passout "pass:$pw"

echo "Importing into login keychain: $login_keychain"
# -T /usr/bin/codesign adds codesign to the imported key's ACL so it can sign
# without a per-sign prompt. You still get one "always allow" the first time
# codesign uses the key.
security import "$tmp/identity.p12" -k "$login_keychain" -T /usr/bin/codesign -P "$pw"

# Confirm it landed as a usable codesigning identity.
if security find-identity -p codesigning -v 2>/dev/null | grep -q "\"$id\""; then
  echo
  echo "Done. Add this to your shell rc (~/.zshrc) so it applies to every shell:"
  echo "  export NASLLM_CODESIGN_ID=$id"
  echo
  echo "Then launch the app with:  cd desktop && npm run desktop:signed"
  echo "The first launch still prompts once for the GitHub-token keychain item —"
  echo "click \"Always Allow\". Subsequent rebuilds/relaunches will not prompt."
else
  echo "error: import finished but \"$id\" was not found as a codesigning identity" >&2
  echo "       open Keychain Access and check for a certificate named \"$id\"" >&2
  exit 1
fi
