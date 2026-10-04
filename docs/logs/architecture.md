# Architecture log

Back to [Documentation Log](../log.md). Canonical page:
[architecture.md](../architecture.md).

| Date | Change | Canonical pages | Evidence |
|---|---|---|---|
| 2026-10-03 | Phase 7 finance forecasting: the local-day-boundary/startup reconciliation pass now also evaluates proactive runout/cash-flow alerts and sends at most one rate-limited OS notification per due alert key when `financeEnabled && financeNotifyRunout`; `/finances` overview route description updated to mention the alerts section | `docs/architecture.md`, `docs/finance.md` | `src/app/use-local-day-reconciliation.ts`, `src/domain/finance/forecast.ts` |
| 2026-10-03 | Broke `AppProvider` up: `bootstrapApplication` + `runOnceWithSettingsMarker` (`bootstrap.ts`), `useBootstrap` (timeout/fallback), `usePulseScheduler`, `useAutoBackupScheduler`; schedulers read settings/Pomodoro through refs and restart only on repository change; context value memoized | `docs/architecture.md` | `src/app/bootstrap.ts`, `use-bootstrap.ts`, `use-pulse-scheduler.ts`, `use-auto-backup-scheduler.ts`, `app-context.tsx`, issue #119 |
| 2026-10-03 | Repository reads are side-effect free: new `AppRepository.reconcileDay(date, now?)` (shared `reconcileGtdDay`) owns recurrence generation, Scheduled promotion, Sunday carryover, and expired-Pomodoro completion; called by bootstrap, the local-day hook, and explicit refreshes. All `getDailyEntry`/`listDailyEntries*` reads decorate once via `decorateDailyEntries`, including `listDailyEntriesInRange` ([#110](https://github.com/didia/trackdidia/issues/110)) | `docs/architecture.md`, `docs/gtd.md`, `docs/daily-routines.md` | `src/lib/gtd/reconcile.ts`, `src/lib/storage/decorate-entries.ts`, `app-context.tsx`, `use-local-day-reconciliation.ts`, `use-gtd.ts` |
| 2026-10-02 | Split email triage persistence into `AppRepository.emailTriage` with a focused store contract and removed repository forwarding methods | `docs/architecture.md`, `docs/email-triage.md` | `email-triage-store.ts`, both repositories and email stores |
| 2026-10-03 | Phase 3 finance screens: `/finances`, `/finances/transactions`, `/finances/import`, `/finances/accounts` under an always-registered `FinanceRoutes` that redirects to `/` while `financeEnabled` is false; `AppShell`'s nav list supports a per-entry `flag` gate; boot sequence seeds the default finance category taxonomy once when the flag is on and the marker is empty | `docs/architecture.md`, `docs/finance.md` | `src/App.tsx`, `src/components/AppShell.tsx`, `src/app/app-context.tsx`, `src/pages/Finance*Page.tsx` |
| 2026-09-30 | New route `/mi-semaine` (`MidWeekReviewPage`) with a nav entry; shared `loadDecoratedWeekEntries` in `src/lib/storage/week-entries.ts` | `docs/architecture.md`, `docs/reviews-and-goals.md` | `App.tsx`, `AppShell.tsx`, `week-entries.ts` |
| 2026-09-22 | Removed the dead legacy free-text coach (`coach-service.ts`, `coach-input.ts`, `CoachCard.tsx`, `AiProvider.generate`, `AiPromptContext`, `OpenRouterProvider.generate`, `CoachMessage`, `_addMonths`); `AppProvider` constructs `CoachPulseService`, not the removed `AiCoachService` | `docs/architecture.md`, `docs/ai-settings-and-privacy.md` | `src/app/app-context.tsx`, `src/lib/ai/coach-pulse-service.ts`, `src/lib/ai/provider.ts`, `src/lib/ai/openrouter-provider.ts` |
| 2026-09-12 | Added `verses.json` (root) and `src/lib/pastor/` (bible-books, verse-catalog, translations, signals, history, local-pick) for the new "Pasteur IA" surface | `docs/architecture.md`, `docs/ai-settings-and-privacy.md` | `verses.json`, `src/lib/pastor/` |
| 2026-09-09 | Email triage reviews persist metadata only (no body); coordinator pagination uses the saved cursor and a per-run page cap; enable/resume reconfigures polling | `docs/email-triage.md`, `docs/storage-and-backups.md`, `docs/architecture.md` | `sync-engine.ts`, `coordinator.ts`, `EmailTriagePage` |
| 2026-09-08 | Yahoo slice: coordinator uses live IMAP adapter on desktop when vault credentials exist | `docs/architecture.md`, `docs/email-triage.md` | `runtime.ts`, `yahoo-adapter.ts`, `yahoo_imap.rs` |
| 2026-09-08 | Email triage coordinator passes live `mutationEnabled` only when evaluation corpus and flags match | `docs/architecture.md`, `docs/email-triage.md` | `coordinator.ts`, `mutation-gate.ts` |
| 2026-09-08 | Microsoft Graph slice: coordinator uses live Graph adapter on desktop when vault credentials exist; Yahoo remains mocked | `docs/architecture.md`, `docs/email-triage.md` | `runtime.ts`, `graph-adapter.ts` |
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
