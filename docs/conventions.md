# Conventions and Development Workflow

## Verification commands

Run all JavaScript commands from the repository root.

```bash
npm run test
npm run build
```

`npm run test` executes the Vitest suite once. `npm run build` runs
`tsc --noEmit` before the Vite production build, so it is also the repository's
type-check gate.

There is no lint or format script at present. If Rust/Tauri host code changes, also
run:

```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

## File placement

| Kind of change | Location |
|---|---|
| Route-level UI | `src/pages/` |
| Reusable visual component | `src/components/` |
| React orchestration/shared runtime state | `src/app/` |
| Domain type or deterministic calculation | `src/domain/` |
| GTD rule/import | `src/lib/gtd/` |
| Recurrence rule | `src/lib/recurring/` |
| Pomodoro rule or notification sound | `src/lib/pomodoro/` |
| AI provider/service behavior | `src/lib/ai/` |
| Persistence API or adapter | `src/lib/storage/` |
| Native capability/path/build behavior | `src-tauri/` |
| User-facing copy | matching JSON file under `src/locales/fr/` |

Prefer pure functions for calculations and state transitions. Pages should compose
those functions and repository calls rather than becoming alternate business-rule
implementations.

New UI copy goes in the matching namespace file under `src/locales/fr/`, not
inline in components. Non-React user-facing strings (notifications, relative
dates, local coach fallbacks, insight labels) use `t(key, { ns })` from
`src/i18n`. Do not i18n AI system prompts, `logDebug` messages, `quotes.json`,
or user-authored content.

## TypeScript and React

- TypeScript is strict and emits no JavaScript during type checking.
- Follow the current double-quoted string style.
- Use type-only imports where the import is only a type.
- Preserve immutable update patterns for domain objects; clone nested maps/arrays
  before modifying them.
- Keep global runtime behavior in `AppProvider` or a focused shared hook.
- Keep temporary form state local to the screen/component.
- `PersistedTextarea` debounces persistence by 450 ms unless `debounceMs={0}` is
  supplied. It also flushes the pending draft on unmount. Daily entries, weekly
  reviews, and monthly reviews serialize those saves so an earlier in-flight
  snapshot cannot overwrite later notes.

## Repository changes

When extending `AppRepository`:

1. Add the contract method and required shared types.
2. Implement SQLite behavior.
3. Implement memory behavior.
4. Reuse or add a pure domain/engine function when the logic is deterministic.
5. Add tests for that function and/or repository behavior.
6. Update the relevant canonical documentation.

Do not let memory preview and SQLite silently diverge. Native-only operations such
as backups may explicitly throw in memory mode.

## SQLite changes

The migration list in `TauriSqliteRepository` is the schema source of truth.

- Add one new migration with the next integer ID.
- Do not edit a migration that may already exist in a user's
  `schema_migrations`.
- Update row interfaces, SQL projections, serializers, and both repository
  implementations.
- Preserve existing user data.
- Prefer idempotent backfills and explicit defaults.
- Test startup against both a fresh database and an existing database when practical.

The repository currently applies migrations sequentially but does not wrap the
whole migration body and migration-record insert in an explicit transaction. Keep
migration SQL simple and safe to retry where SQLite permits it.

## Dates and time zones

TrackDidia uses two related representations:

- calendar keys: local `YYYY-MM-DD` strings;
- instants: ISO timestamps, usually UTC after `Date#toISOString()`.

Rules:

- Use `getTodayDate()` and `toLocalDateString()` for local calendar identity.
- Use local noon when doing date-only arithmetic to avoid DST/midnight shifts.
- Weeks begin Sunday through `getWeekStartSunday()`.
- Use `buildIsoFromLocalDateAndTime()` for Scheduled inputs.
- Do not compare the first ten characters of an arbitrary ISO timestamp when local
  date semantics matter; use the shared local-date helpers.
- Review month keys are `YYYY-MM`.

## Derived data

- Do not persist suggested daily metrics as if the user entered them.
- Use `resolveMetricValue()` when a calculation should honor explicit overrides.
- Task statistics depend on `TaskEvent` generation. When adding a task transition,
  decide whether `buildLifecycleEvents()` must emit a new or existing event.
- Recurrence generation should remain idempotent for a template/date.
- Annual goal source calculations belong in the source-definition registry in
  `src/domain/annual-goals.ts`.

## Testing

Tests live beside the code:

- `src/domain/*.test.ts` — pure routine/review/goal calculations;
- `src/lib/**/*.test.ts` — engines, storage, import, AI, and backup rules;
- `src/pages/*.test.tsx` — route behavior with Testing Library.

Useful test infrastructure:

- `src/test/setup.ts` installs DOM matchers;
- `src/test/test-utils.tsx` provides app/router-aware rendering;
- `MemoryRepository` is the preferred deterministic adapter for UI tests.

High-value edge cases include:

- Sunday/week and month boundaries;
- explicit metric overrides versus suggestions;
- zero or missing daily data;
- duplicate task event/import IDs;
- recurring daily/weekly/monthly dates and missed occurrences;
- Pomodoro expiry, pause/resume, task switching, and cycle reset;
- OpenRouter disabled, empty-input, error, and fallback paths;
- migration compatibility and settings default merging.

## Documentation workflow

For every shipped behavior change:

1. Update the one canonical product/technical page.
2. Update [`index.md`](index.md) and `AGENTS.md` only if navigation or a major
   contract changed.
3. Append a line to [`log.md`](log.md) for a material documentation change.
4. Check relative links.
5. Run tests and build.

Future work belongs in `PRD.md` or an explicitly marked plan, not in current-state
documentation.

## Known technical debt

1. **The test clock is not consistently pinned.** As of 2026-07-29, the full suite
   has four date-sensitive failures: three memory-repository tests call
   `listTasks()`, which advances active recurrences through the real current date,
   while asserting April/May fixtures; the annual-goals page test edits the current
   month but asserts the evaluation under `2026-04`. Use fake timers or derive the
   expected month/date before treating these tests as stable.
2. **The bundled task export dominates the frontend bundle.** `Tasks.json` is a
   static import (about 2.6 MB in the current workspace), and Vite reports a
   JavaScript chunk above 500 kB. A user-selected import or lazy/native file read
   would reduce bundle size and personal-data exposure.
3. **OpenRouter credentials are not in a keychain.** The key lives in the settings
   JSON and therefore in every database backup.
4. **Backup restore is manual.** The app can create snapshots but cannot validate or
   restore one through the UI.
5. **Migrations are not explicitly transactional as a unit.** A partial multi-
   statement failure may require operator investigation before retry.
6. **No lint/format automation is configured.** The build enforces types, while
   style consistency remains manual.
