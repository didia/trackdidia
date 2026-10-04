# GTD log

Back to [Documentation Log](../log.md). Canonical page: [gtd.md](../gtd.md).

| Date | Change | Canonical pages | Evidence |
|---|---|---|---|
| 2026-10-03 | `listTasks`, daily stats/breakdown, and Pomodoro stats no longer reconcile on read; `reconcileDay` is the explicit entry point (recurrences, Scheduled promotion, carryover back-filled for the most recent Sunday via `getWeekStartSunday` and never for a future Sunday, expired Pomodoros); reads no longer backfill carryover when a Sunday is viewed; GTD mutation reloads, recurrence template save/resume, and accepted AI task proposals reconcile explicitly ([#110](https://github.com/didia/trackdidia/issues/110)) | `docs/gtd.md`, `docs/recurrences-and-pomodoro.md` | `src/lib/gtd/reconcile.ts`, `use-gtd.ts`, `RecurrencesPage.tsx`, `apply-proposal.ts`, `repository.contract.ts` |
| 2026-10-03 | Extracted shared GTD mutation rules: `applyScheduleChange` (repositories + AI schedule accept), `assertPlannedTaskActionable`/`assertPlannedProjectActive`, `selectTasksForBucketNormalization`, and `planGoogleRecurringCollapse`; documented that startup bucket normalizations bypass lifecycle events and that relationship-draw tasks are stamped at UTC midnight of the draw date. Behavior unchanged apart from collapse matching against a working copy in SQLite (parity with Memory) | `docs/gtd.md` | `src/lib/gtd/schedule.ts`, `bucket-normalization.ts`, `google-recurring-collapse.ts`, `planned.ts`, `relationship-draws.ts` |
| 2026-09-29 | Inbox, Waiting For, Someday/Maybe, and References pages now share `BucketTaskListPage`; routes, i18n keys, and behavior unchanged | `docs/gtd.md` | `src/components/gtd/BucketTaskListPage.tsx` |
| 2026-09-29 | Task-list UI refactor: `GtdTaskList` replaces 11 inline `GtdTaskCard` wirings, bucket label keys centralized in `src/lib/gtd/labels.ts`, context create/rename extracted to `TaskContextEditor`, and repositories/card reuse `RecurringTaskChanges`/`RecurringEditScope`; no behavior change | `docs/gtd.md` | `src/components/gtd/`, `src/lib/gtd/labels.ts`, `GtdTaskCard.tsx` |
| 2026-09-29 | `useGtdWorkspace` refactor: single mutate-then-reload helper; bulk bucket-move skip rules moved to pure `planBulkBucketMove`; `load()` no longer repeats recurrence generation and Scheduled promotion already performed by `listTasks` (relationship generation stays, since `listTasks` does not do it) | `docs/gtd.md` | `src/app/use-gtd.ts`, `src/lib/gtd/bulk-move.ts` |
| 2026-09-27 | Sunday added-count uses lifecycle events so a later recurrence reusing a task ID cannot revive a stale carryover after an earlier completion | `docs/gtd.md` | `wasClosedBeforeLocalDay`, `buildDailyTaskStats` |
| 2026-09-27 | Sunday added-count ignores tasks completed or cancelled before that day, so an early carryover event cannot keep last week's finished work in the starting pile | `docs/gtd.md` | `countsAsAddedOnDate`, `buildDailyTaskStats` |
| 2026-09-25 | Daily stats generate recurrences only through local today and skip weekly carryover for a future Sunday | `docs/gtd.md`, `docs/recurrences-and-pomodoro.md` | `computeDailyTaskStats`, `recurrenceGenerationHorizon` |
| 2026-09-21 | Daily `tasksAdded` no longer counts `task_scheduled_for_day` or Scheduled carryover; Scheduled work counts only on Next Action entry or in-place completion | `docs/gtd.md` | `isDailyAddedEvent`, `buildDailyTaskStats`, `buildDailyTaskBreakdown` |
| 2026-09-11 | Next Actions collapsed cards show calendar-day age since the task entered the bucket | `docs/gtd.md` | `nextActionAgeDays`, `GtdTaskCard`, `listTaskEvents` |
| 2026-09-11 | Next Actions defaults to FIFO order by `createdAt` (oldest first), with deadline and last-update sorts still available | `docs/gtd.md` | `sortNextActionTasks`, `NextActionsPage.tsx` |
| 2026-09-08 | Tasks may use `source = email_triage`, nullable `sourceUrl`, and external id `email-triage:<accountId>:<conversationKey>` | `docs/gtd.md`, `docs/email-triage.md` | `src/domain/types.ts`, migration 29 |
| 2026-09-07 | Active Scheduled tasks whose local date is today or earlier auto-promote to Next Actions after due recurrence generation, including when the local day rolls over in an already-mounted view | `docs/gtd.md` | `src/lib/gtd/scheduled.ts`, `promoteDueScheduledTasks`, `use-local-day-reconciliation.ts`, bootstrap / GTD load / Pomodoro / daily stats |
| 2026-09-06 | Added the project-only `planned` bucket with ordered `plannedOrder`, reused `scheduledFor` display, manual Promote/Move up/Move down actions, and automatic single-task promotion when a project has zero active next actions | `docs/gtd.md`, `docs/storage-and-backups.md` | `src/lib/gtd/planned.ts`, migration 26, `ProjectsPage.tsx`, `GtdTaskCard.tsx`, `ScheduledPage.tsx` |
| 2026-09-04 | Removed the one-time bundled `Tasks.json` bootstrap/Settings re-import; import helpers remain for in-memory payloads | `docs/gtd.md`, `docs/architecture.md`, `docs/ai-settings-and-privacy.md` | `app-context.tsx`, `SettingsPage.tsx` |
| 2026-09-04 | Collapsed task summary reads the persisted assignment, nested project-card tasks omit the repeated project title, and `formatAssociationCopy` is shared with project cards | `docs/gtd.md` | `formatAssociationCopy`, `hideProjectTitle`, `GtdTaskCard` |
| 2026-09-03 | Tasks with no stored contexts inherit their project's contexts for collapsed-card labels and context filters | `docs/gtd.md` | `effectiveTaskContextIds`, `GtdTaskCard`, Next Actions / Waiting For / Someday filters |
| 2026-09-03 | Collapsed `GtdTaskCard` shows the assigned project title before contexts; `Sans contexte` only when neither is set | `docs/gtd.md` | `formatAssociationCopy`, `GtdTaskCard` |

## Entry template

```text
YYYY-MM-DD | <concise behavior/documentation change> | <canonical docs> | <code, test, issue, or plan evidence>
```
