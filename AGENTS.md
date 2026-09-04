# Codex Instructions

## Documentation (read this first)

TrackDidia's canonical, agent-maintained documentation lives in [`docs/`](docs/).
Start at [`docs/index.md`](docs/index.md) for the complete catalog. Chronological
records live in domain logs under [`docs/logs/`](docs/logs/);
[`docs/log.md`](docs/log.md) is only the index of those logs.

The application is a local-first personal operating system. It combines daily
routines and life metrics, Sunday-to-Saturday reviews, monthly and annual goals,
a GTD workspace, recurring tasks, Pomodoro tracking, relationship activity draws,
and an optional OpenRouter coach.

Quick reference:

| Topic | Canonical page |
|---|---|
| Architecture, boot flow, routes, repository boundary | [docs/architecture.md](docs/architecture.md) |
| SQLite schema, migrations, local files, backups | [docs/storage-and-backups.md](docs/storage-and-backups.md) |
| Daily routine, metrics, principles, history | [docs/daily-routines.md](docs/daily-routines.md) |
| Weekly/monthly reviews and annual goals | [docs/reviews-and-goals.md](docs/reviews-and-goals.md) |
| GTD buckets, task events, import, projects, contexts | [docs/gtd.md](docs/gtd.md) |
| Recurring tasks and Pomodoro behavior | [docs/recurrences-and-pomodoro.md](docs/recurrences-and-pomodoro.md) |
| AI coach, settings, relationship draws, debug mode | [docs/ai-settings-and-privacy.md](docs/ai-settings-and-privacy.md) |
| Code conventions and test workflow | [docs/conventions.md](docs/conventions.md) |
| Desktop development, builds, and release data safety | [docs/desktop-builds.md](docs/desktop-builds.md) |

## Documentation maintenance (required)

Treat `docs/` as persistent memory for agents and humans.

- Update the canonical page whenever behavior described there changes.
- Add a new page only when a subsystem no longer fits cleanly in an existing page.
- Keep one canonical home per fact and link to it elsewhere instead of duplicating it.
- Add new pages to both [`docs/index.md`](docs/index.md) and the table above.
- For a material documentation change, prepend a concise entry to the matching
  domain log under [`docs/logs/`](docs/logs/) (`docs/<page>.md` →
  `docs/logs/<page>.md`). Do not edit [`docs/log.md`](docs/log.md) unless you are
  adding a new domain log to that index.
- Verify relative Markdown links before reporting work complete.
- Describe shipped behavior only. Keep future ideas in [`PRD.md`](PRD.md), clearly
  labeled as roadmap rather than current behavior.

The source-of-truth order is:

1. Executable code and tests
2. SQLite migrations in
   [`src/lib/storage/tauri-sqlite-repository.ts`](src/lib/storage/tauri-sqlite-repository.ts)
3. Canonical pages in `docs/`
4. [`README.md`](README.md) and [`PRD.md`](PRD.md)

When these disagree, verify the code and migration behavior, then correct the docs.

## Architectural contracts

### Repository parity

All application data access goes through `AppRepository` in
`src/lib/storage/repository.ts`.

- Desktop uses `TauriSqliteRepository`.
- Browser preview and startup fallback use `MemoryRepository`.
- Any new repository method must be implemented in both classes.
- Domain calculations belong in `src/domain/` or a focused engine under `src/lib/`,
  not duplicated in repository implementations.
- Browser preview is intentionally non-persistent. Never describe it as a durable
  storage mode.

### SQLite migrations

- Schema changes must be append-only migrations in the `migrations` array.
- Never renumber or rewrite an already shipped migration.
- Give every migration a unique increasing integer ID and descriptive name.
- Prefer preserve-first changes: add, backfill/normalize, then read the new shape.
- `schema_migrations` is the record of applied migrations.
- Keep `MemoryRepository` behavior and TypeScript row mappings aligned with the
  migrated schema.

### Local-first data safety

- Production and development databases are deliberately separate.
- Keep the Tauri identifier `com.trackdidia.desktop` stable unless a data migration
  strategy is part of the change; the identifier determines the app-data directory.
- Do not delete or overwrite user databases or backups as part of development work.
- Manual and automatic backups use SQLite `VACUUM INTO`; changing backup behavior
  requires updating [docs/storage-and-backups.md](docs/storage-and-backups.md).
- The OpenRouter API key is stored locally inside the settings row. Never log it,
  add it to fixtures, or commit a real key.

### Dates and derived metrics

- Calendar dates use local `YYYY-MM-DD` values.
- Weeks run Sunday through Saturday.
- Use the helpers in `src/lib/date.ts`, `src/lib/gtd/shared.ts`, and the review domain
  modules instead of hand-rolling UTC date arithmetic.
- Daily GTD counts are event-derived. Task lifecycle changes must continue to emit
  the events expected by `buildDailyTaskStats`.
- Suggested GTD/Pomodoro metrics are fallbacks; an explicit daily metric value wins.
- Keep formulas centralized in `src/domain/daily-entry.ts`,
  `src/domain/weekly-review.ts`, `src/domain/monthly-review.ts`, and
  `src/domain/annual-goals.ts`.

### Bootstrap behavior

`AppProvider` owns startup sequencing. Changes must preserve these properties:

- SQLite is initialized before settings and GTD data are read.
- The bundled `Tasks.json` import and normalization steps are idempotent.
- Due recurrences and daily relationship activities are generated at startup.
- An eight-second failure/timeout activates an in-memory fallback and a visible
  warning rather than blocking the UI forever.
- Automatic backup checks must not run concurrently.

## File organization

- `src/pages/` — route-level screens.
- `src/components/` — reusable UI.
- `src/app/` — application context and orchestration hooks.
- `src/domain/` — types, state transitions, and pure review/goal calculations.
- `src/lib/gtd/`, `recurring/`, `pomodoro/`, `ai/` — focused engines/integrations.
- `src/lib/storage/` — repository contract and implementations.
- `src-tauri/` — native host, capabilities, icons, and bundling configuration.

Keep UI components thin where possible. Put deterministic rules in pure functions
and test them directly.

## Commands

Run commands from the repository root.

```bash
npm install
npm run dev
npm run tauri dev
npm run test
npm run build
npm run mac-install
```

Before reporting a code or documentation task complete, run:

1. `npm run test`
2. `npm run build`

If Rust or Tauri host code changed, also run:

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

There is currently no repository lint or format script; do not claim one ran.

## Code and testing conventions

- TypeScript is strict.
- Follow the existing double-quoted TypeScript string style.
- Keep tests next to the module/page as `*.test.ts` or `*.test.tsx`.
- Use pure engine tests for calculations and Testing Library for screen behavior.
- Use `src/test/test-utils.tsx` when a page needs the app context/router harness.
- Add tests for state transitions, date boundaries, migration-sensitive mappings,
  recurrence rules, and fallback behavior when changing those areas.
- Do not use the browser preview to validate persistence, backups, notifications, or
  other native-only behavior.

## Current product boundaries

Do not assume these exist:

- Cloud sync or multi-device conflict resolution
- User accounts or authentication
- Excel history import
- Restore-from-backup UI
- Google Calendar synchronization
- Background scheduling while the desktop app is fully closed
- Encrypted secret storage for the OpenRouter key
- Mobile application distribution

These are roadmap candidates, not shipped features.
