# Architecture log

Back to [Documentation Log](../log.md). Canonical page:
[architecture.md](../architecture.md).

| Date | Change | Canonical pages | Evidence |
|---|---|---|---|
| 2026-09-09 | Email triage reviews persist metadata only (no body); coordinator pagination uses the saved cursor and a per-run page cap; enable/resume reconfigures polling | `docs/email-triage.md`, `docs/storage-and-backups.md`, `docs/architecture.md` | `sync-engine.ts`, `coordinator.ts`, `EmailTriagePage` |
| 2026-09-08 | Gmail slice: coordinator uses live Gmail adapter on desktop when vault credentials exist; Graph/Yahoo remain mocked | `docs/architecture.md`, `docs/email-triage.md` | `runtime.ts`, `use-email-triage-coordinator.ts` |
| 2026-09-08 | Added `/email-triage` route and post-bootstrap email triage coordinator (disabled by default; browser preview disables polling) | `docs/architecture.md`, `docs/email-triage.md` | `EmailTriagePage`, `use-email-triage-coordinator.ts`, `coordinator.ts` |
| 2026-09-08 | Added `/journal` read-only timeline of daily, weekly, and monthly notes with period/kind/sort filters | `docs/architecture.md` | `JournalPage`, `src/App.tsx` |
| 2026-09-07 | Floating Pomodoro overlay stays visible for the current cycle after completion until idle reset; hidden on `/pomodoro` | `docs/architecture.md`, `docs/recurrences-and-pomodoro.md` | `FloatingPomodoroTimer`, `shouldShowFloatingPomodoro` |
| 2026-09-07 | Boot sequence promotes due Scheduled tasks to Next Actions after generating recurrences; a local-day boundary plus focus/visibility repeats that pass and republishes `calendarDay` | `docs/architecture.md` | `app-context.tsx`, `use-local-day-reconciliation.ts`, `promoteDueScheduledTasks` |
| 2026-09-04 | Boot sequence no longer imports or collapses against a bundled `Tasks.json` | `docs/architecture.md` | `app-context.tsx` |
| 2026-09-02 | User-facing copy lives in `src/locales/fr/*.json` via react-i18next (French-only, accented); screens use `useTranslation`, engines use `t()` | `docs/architecture.md`, `docs/conventions.md` | `src/i18n/index.ts`, `src/locales/fr/`, pages/components, fallbacks, insights |

## Entry template

```text
YYYY-MM-DD | <concise behavior/documentation change> | <canonical docs> | <code, test, issue, or plan evidence>
```
