# Conventions log

Back to [Documentation Log](../log.md). Canonical page:
[conventions.md](../conventions.md).

| Date | Change | Canonical pages | Evidence |
|---|---|---|---|
| 2026-10-03 | Consolidated ordered async work in `createSerialQueue` and date/week/month snapshot persistence in `useLatestValueSaver`; daily and monthly loads now wait for their own pending saves and retain edits made during loading | `docs/conventions.md` | `serial-queue.ts`, `use-latest-value-saver.ts`, daily/review hooks and pages, queue and save-race tests |
| 2026-10-03 | Documented named transactional versus queue-only writer modes and corrected the obsolete migration transaction guidance | `docs/conventions.md` | `transaction.ts`, `tauri-sqlite-repository.ts`, migration runner |
| 2026-10-03 | Removed obsolete migration transaction debt: the extracted runner preserves one transaction per migration plus its ledger insert, with rollback tests | `docs/conventions.md` | `migrations/index.ts`, `migrations/index.test.ts` |
| 2026-10-02 | Consolidated local date, week, and month helpers in `src/lib/date.ts`; migrated non-GTD callers and replaced recurrence watermark UTC slicing with local date arithmetic | `docs/conventions.md` | `date.ts`, `gtd/shared.ts`, both repositories, `date.test.ts` |
| 2026-09-22 | Added `describeRepositoryContract`, a shared implementation-agnostic `AppRepository` behavior spec run against both `MemoryRepository` and `TauriSqliteRepository` (the latter via a `node:sqlite` in-memory test adapter) | `docs/conventions.md`, `docs/storage-and-backups.md` | `src/lib/storage/repository.contract.ts`, `src/lib/storage/tauri-sqlite-repository.test.ts`, `src/test/mocks/node-sqlite-database.ts` |
| 2026-09-21 | Added `PageHeader`, `ContextFilterChips`, and `SegmentedToggle` UI primitives and replaced duplicated hero/chip markup in pages; no class or visual change | `docs/conventions.md` | `src/components/PageHeader.tsx`, `src/components/ContextFilterChips.tsx`, `src/components/SegmentedToggle.tsx` |
| 2026-09-21 | Added `useLatestRequest`/`useAsyncResource` as the convention for stale-response guards; Weekly/Monthly review, Today, and Annual Goals pages migrated (Monthly now guards month loads) | `docs/conventions.md` | `src/app/use-latest-request.ts`, `src/app/use-latest-request.test.tsx` |
| 2026-09-12 | `verses.json` is not i18n-translated (like `quotes.json`); verse text must be pasted from an authoritative edition and human-verified, never generated from memory | `docs/conventions.md`, `docs/ai-settings-and-privacy.md` | `verses.json`, `src/lib/pastor/verse-catalog.ts` |
| 2026-09-04 | Added Biome lint/format (`npm run lint` / `format` / `verify` / `verify:all`) and GitHub Actions CI (`frontend`, `rust`, `agents-sync`); `CLAUDE.md` must match `AGENTS.md` | `docs/conventions.md`, `AGENTS.md` | `biome.json`, `.github/workflows/ci.yml`, `scripts/verify.sh` |
| 2026-09-04 | Split the documentation changelog into domain logs under `docs/logs/`; `docs/log.md` is now a stable index | `docs/conventions.md`, `docs/log.md`, `AGENTS.md` | `docs/logs/*.md`, write rules in `docs/log.md` |
| 2026-07-29 | Bootstrapped the full agent-maintained documentation system: architecture, persistence, daily routines, reviews/goals, GTD, recurrences/Pomodoro, AI/privacy, conventions, and desktop builds | `AGENTS.md`, `docs/*.md` | Current source tree, tests, Tauri configuration, comparison with the Bâtisseurs documentation structure |

## Entry template

```text
YYYY-MM-DD | <concise behavior/documentation change> | <canonical docs> | <code, test, issue, or plan evidence>
```
