#!/usr/bin/env bash
# Bump the desktop app version across the three files that carry it
# (desktop/package.json, desktop/src-tauri/tauri.conf.json, and
# desktop/src-tauri/Cargo.toml), commit "Release vX.Y.Z", and tag vX.Y.Z to
# trigger .github/workflows/desktop-release.yml. The tag is NOT pushed
# automatically — push it to publish:
#   git push origin vX.Y.Z
#
# Versioning policy:
#   patch = bug fixes / small non-breaking changes
#   minor = new backward-compatible features
#   major = breaking changes
#
# Usage: scripts/bump-desktop-version.sh {patch|minor|major}
set -euo pipefail

bump="${1:-}"
case "$bump" in
  patch|minor|major) ;;
  *) echo "Usage: $0 {patch|minor|major}" >&2; exit 1 ;;
esac

root="$(cd "$(dirname "$0")/.." && pwd)"
cargo="$root/desktop/src-tauri/Cargo.toml"
pkg="$root/desktop/package.json"
conf="$root/desktop/src-tauri/tauri.conf.json"

# Current version: the only `version = "..."` at the start of a line in
# Cargo.toml is the [package] version (dependency versions live inside `{ }`).
cur=$(grep -E '^version = "[0-9]+\.[0-9]+\.[0-9]+"' "$cargo" | head -1 | sed -E 's/^version = "([0-9]+\.[0-9]+\.[0-9]+)".*/\1/')
if [ -z "$cur" ]; then
  echo "could not read current version from $cargo" >&2
  exit 1
fi

IFS='.' read -r major minor patch <<<"$cur"
case "$bump" in
  major) major=$((major + 1)); minor=0; patch=0 ;;
  minor) minor=$((minor + 1)); patch=0 ;;
  patch) patch=$((patch + 1)) ;;
esac
new="$major.$minor.$patch"

# perl -i is portable across macOS (BSD) and Linux (GNU), unlike sed -i.
# Cargo.toml: anchor on the line-start package version. The JSON files each
# have a single top-level "version": key.
perl -i -pe "s/^version = \"[^\"]+\"/version = \"$new\"/" "$cargo"
perl -i -pe "s/\"version\": \"[^\"]+\"/\"version\": \"$new\"/" "$pkg"
perl -i -pe "s/\"version\": \"[^\"]+\"/\"version\": \"$new\"/" "$conf"

git -C "$root" add "$cargo" "$pkg" "$conf"
git -C "$root" commit -m "Release v$new"
git -C "$root" tag "v$new"

echo "Bumped $cur -> $new and tagged v$new."
echo "Push to publish: git push origin v$new"
