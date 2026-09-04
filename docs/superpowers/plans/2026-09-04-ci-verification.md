# CI Verification Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add PR CI (Biome, typecheck, test, build, cargo check/clippy, AGENTS↔CLAUDE sync) and remove the one-time `Tasks.json` dependency so a clean checkout verifies green.

**Architecture:** Parallel GitHub Actions jobs call the same npm/cargo commands as `scripts/verify.sh`. Biome is the only JS lint/format tool. `CLAUDE.md` is a byte-identical copy of `AGENTS.md`.

**Tech Stack:** GitHub Actions, Node/npm, Biome, TypeScript, Vitest, Vite, Rust/Cargo clippy.

**Spec:** `docs/superpowers/specs/2026-09-04-ci-verification-design.md`

## Global Constraints

- Default branch is `master` (CI `push` trigger uses `master`, not `main`)
- Do not commit `Tasks.json` or stubs
- Keep repository `importGoogleTasksExport` / `buildGoogleTasksImport` if unit tests still use in-memory payloads
- Update canonical docs + domain log under `docs/logs/`
- When editing `AGENTS.md`, also update `CLAUDE.md` to match

---

### Task 1: Remove one-time `Tasks.json` import

**Files:**
- Modify: `src/app/app-context.tsx`
- Modify: `src/pages/SettingsPage.tsx`
- Modify: Settings locale keys / tests that assert the re-import UI
- Modify: docs that list `Tasks.json` as a build requirement (`docs/architecture.md`, `docs/desktop-builds.md`, `docs/gtd.md`, `docs/conventions.md`, `docs/index.md`, `docs/storage-and-backups.md`, `AGENTS.md`)

- [ ] Remove static `Tasks.json` imports
- [ ] Remove bootstrap Google Tasks import + recurring-collapse-against-export steps
- [ ] Remove Settings “re-import GTD from Tasks.json” action (keep GTD stats display if still useful without re-import)
- [ ] Update docs; append `docs/logs/gtd.md` (and conventions/desktop as needed)
- [ ] Run `npm run test` and `npm run build` with no `Tasks.json` present

### Task 2: Biome + npm scripts

**Files:**
- Create: `biome.json`
- Modify: `package.json` / `package-lock.json`

- [ ] Add `@biomejs/biome` devDependency
- [ ] Scripts: `lint`, `lint:fix`, `format`, `typecheck`, `verify`, `verify:all`
- [ ] Run `npm run lint:fix` and fix remaining failures
- [ ] Confirm `npm run lint` and `npm run typecheck` pass

### Task 3: CI workflow + verify script + CLAUDE.md

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `scripts/verify.sh`
- Create: `CLAUDE.md` (copy of updated `AGENTS.md`)
- Modify: `AGENTS.md` (sync directive + verify commands)
- Modify: `docs/conventions.md`, relevant `docs/logs/*.md`

- [ ] Three parallel jobs: frontend, rust, agents-sync
- [ ] `scripts/verify.sh` mirrors full gate
- [ ] `cmp AGENTS.md CLAUDE.md` in CI and verify script
- [ ] Run `npm run verify` and `bash scripts/verify.sh` (rust if toolchain available)

---
