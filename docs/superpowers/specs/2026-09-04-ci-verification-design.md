# CI Verification Gate Design

Date: 2026-09-04  
Status: approved for planning

## Goal

Add pull-request verification so every change is checked for format/lint,
TypeScript correctness, unit tests, production frontend build, Rust host
compile/clippy, and AGENTS.md ↔ CLAUDE.md parity.

Unblock that gate by removing the one-time bundled `Tasks.json` import so
checkout/CI no longer depends on a gitignored personal export.

## Decisions (locked)

| Topic | Choice |
|---|---|
| Scope | Full gate: frontend + Rust + production build |
| JS lint/format | Biome only (no ESLint/Prettier) |
| Baseline | Clean gate from day one — fix existing violations in the same change |
| CI shape | Parallel jobs + local verify script that mirrors CI |
| Agent docs | `CLAUDE.md` is an exact copy of `AGENTS.md`; CI enforces equality |
| Tasks.json | Remove the one-time bundled import in the first implementation pass |

## Architecture

### GitHub Actions

File: `.github/workflows/ci.yml`

Triggers:

- `pull_request` (all branches)
- `push` to `master`

Three parallel jobs on `ubuntu-latest`:

1. **frontend**
   - checkout
   - setup Node (version pinned to match local/engine expectation; use lockfile-compatible LTS)
   - `npm ci`
   - run the same npm scripts used locally:
     - `npm run lint` (Biome check, includes format + lint)
     - `npm run typecheck`
     - `npm run test`
     - `npm run build`
   - cache npm dependencies

2. **rust**
   - checkout
   - install stable Rust toolchain with clippy
   - cache Cargo
   - from `src-tauri/`:
     - `cargo check`
     - `cargo clippy -- -D warnings`
   - no `tauri build`, no macOS packaging, no app-bundle artifacts

3. **agents-sync**
   - checkout
   - fail unless `AGENTS.md` and `CLAUDE.md` are byte-identical:
     - `cmp AGENTS.md CLAUDE.md`

Any failing job fails the workflow.

### Local verify mirror

`scripts/verify.sh` runs the full gate locally:

1. frontend: `npm run verify`
2. rust: same `cargo check` / `cargo clippy -- -D warnings` as CI
3. agents sync: `cmp AGENTS.md CLAUDE.md`

`package.json` scripts:

| Script | Command / meaning |
|---|---|
| `lint` | `biome check .` |
| `lint:fix` | `biome check --write .` |
| `format` | `biome format --write .` |
| `typecheck` | `tsc --noEmit` |
| `verify` | `npm run lint && npm run typecheck && npm run test && npm run build` |
| `verify:all` | `bash scripts/verify.sh` (frontend + rust + agents sync) |

`npm run build` may keep its existing `tsc --noEmit && vite build` behavior;
`typecheck` remains a dedicated script so CI and local runs can fail fast on
types without always waiting for Vite when only types are needed. CI still runs
both `typecheck` and `build`.

### Biome

Add `biome.json`:

- double quotes for JS/TS (matches current style)
- recommended lint rules enabled
- ignore generated/noise paths: `dist/`, `node_modules/`, `coverage/`,
  `src-tauri/target/`, `src-tauri/gen/`, lockfiles, and similar
- day-one clean sweep: apply `biome check --write .` and commit fixes so the
  first green CI run does not rely on ignores of real violations

### AGENTS.md / CLAUDE.md

- Create `CLAUDE.md` as an exact copy of `AGENTS.md`
- Add a short directive in `AGENTS.md` (copied into `CLAUDE.md`): when
  `AGENTS.md` changes, update `CLAUDE.md` to the same content
- Keep them as plain duplicates (no codegen) so the `cmp` check stays obvious
- Update verification-command sections in those files and in
  `docs/conventions.md` / `docs/log.md` for the new scripts and CI expectations

## Error handling / failure modes

- Biome/typecheck/test/build failures fail the frontend job with standard
  command exit codes
- Clippy warnings are errors (`-D warnings`)
- Missing or divergent `CLAUDE.md` fails `agents-sync`
- Browser preview / Tauri packaging are not part of CI; native-only behavior
  remains a local desktop concern

## Testing / acceptance

The change is successful when:

1. Opening a PR runs the three jobs and they all pass on a clean tree with no
   `Tasks.json` present
2. Local `npm run verify` and `npm run verify:all` match the CI frontend/full
   gates
3. Editing only `AGENTS.md` without updating `CLAUDE.md` fails CI
4. Docs list the new verification commands and no longer claim there is no
   lint/format script
5. App bootstrap and Settings no longer import or require `Tasks.json`; related
   docs no longer list it as a build prerequisite

## Prerequisite: remove one-time `Tasks.json` import

Today, `src/app/app-context.tsx` and `src/pages/SettingsPage.tsx` statically
import gitignored `../../Tasks.json`. Without that file, Vite fails 13 UI test
suites and `tsc`/`npm run build` fail with missing-module errors. The import was
a one-time Google Tasks bootstrap, not ongoing product behavior.

First implementation pass must:

1. Remove the static `Tasks.json` imports from app bootstrap and Settings
2. Remove bootstrap steps and Settings UI that re-run the bundled export import /
   recurring collapse against that file
3. Stop documenting `Tasks.json` as a required local build dependency
4. Leave pure helpers that accept an in-memory Google Tasks payload
   (`buildGoogleTasksImport`, repository `importGoogleTasksExport`, and their
   unit tests with inline fixtures) unless they become dead after the UI/bootstrap
   removal — then delete those dead paths too
5. Confirm `npm run test` and `npm run build` succeed in a clean tree with no
   `Tasks.json` present

Do **not** commit a real or stub `Tasks.json` to make CI green.

## Out of scope

- Configuring GitHub branch-protection rules in the UI
- Full Tauri native release builds in CI
- Editor format-on-save settings
- Encrypted secret storage or cloud sync
- Reintroducing a committed Google Tasks fixture for CI

## Implementation notes

- Prefer appending documentation updates to existing canonical pages rather than
  inventing a second verification source of truth
- Keep Rust checks scoped to `src-tauri/` with the existing
  `Cargo.toml` / lockfile
- Do not delete or overwrite user databases as part of this work
- Treat `Tasks.json` removal as a blocking prerequisite before relying on CI
  greenness
