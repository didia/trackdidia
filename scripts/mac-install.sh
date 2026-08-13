#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "mac-install is only supported on macOS." >&2
  exit 1
fi

APP_NAME="Trackdidia.app"
PROCESS_NAME="Trackdidia"
DEST="/Applications/${APP_NAME}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

candidates=()
if [[ -n "${1:-}" ]]; then
  candidates+=("$1")
fi
if [[ -n "${CARGO_TARGET_DIR:-}" ]]; then
  candidates+=("${CARGO_TARGET_DIR}/release/bundle/macos/${APP_NAME}")
fi
candidates+=("${REPO_ROOT}/src-tauri/target/release/bundle/macos/${APP_NAME}")

bundle=""
for candidate in "${candidates[@]}"; do
  if [[ -d "$candidate" ]]; then
    bundle="$candidate"
    break
  fi
done

if [[ -z "$bundle" ]]; then
  echo "Trackdidia.app not found. Build it first with: npm run tauri build" >&2
  echo "Looked in:" >&2
  for candidate in "${candidates[@]}"; do
    echo "  $candidate" >&2
  done
  exit 1
fi

echo "Installing ${bundle} -> ${DEST}"
killall "${PROCESS_NAME}" 2>/dev/null || true
rm -rf "${DEST}"
cp -R "${bundle}" "${DEST}"
xattr -cr "${DEST}"
echo "Installed ${DEST}"
