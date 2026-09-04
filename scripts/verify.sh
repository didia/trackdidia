#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

echo "==> frontend verify"
npm run verify

echo "==> rust check"
cargo check --manifest-path src-tauri/Cargo.toml

echo "==> rust clippy"
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings

echo "==> AGENTS.md / CLAUDE.md sync"
cmp AGENTS.md CLAUDE.md

echo "==> verify:all OK"
