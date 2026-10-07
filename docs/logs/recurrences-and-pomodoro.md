# Recurrences and Pomodoro log

Back to [Documentation Log](../log.md). Canonical page:
[recurrences-and-pomodoro.md](../recurrences-and-pomodoro.md).

| Date | Change | Canonical pages | Evidence |
|---|---|---|---|
| 2026-10-06 | Next Actions task cards can start or switch a Pomodoro onto a task; paused focus retargets via a zero-duration placeholder; an open break is completed without announce then a focus starts | `docs/recurrences-and-pomodoro.md` | `focusOnTask`, `resolveFocusOnTaskAction`, `switchSessionTask`, Next Actions / engine / controller tests |
| 2026-10-06 | Cancelling a focus that started after the 25-minute idle gap no longer restores the previous cycle's completed count | `docs/recurrences-and-pomodoro.md` | `sessionsAfterLastIdleGap`, `buildPomodoroState` |
| 2026-10-03 | Recurrence generation moved from reads (`listTasks`, stats, Pomodoro refresh) to explicit `reconcileDay`; `computeDailyPomodoroStats` no longer completes expired sessions ([#110](https://github.com/didia/trackdidia/issues/110)) | `docs/recurrences-and-pomodoro.md`, `docs/gtd.md` | `src/lib/gtd/reconcile.ts`, `use-pomodoro-controller.ts` |
| 2026-10-03 | Extracted recurrence generation, close-time template updates, occurrence merges, and active-task template sync from both repositories into pure planners in the recurrence engine; pause/resume/cancel share one `setTemplateStatus` per repository; documented the single drifted-field sync behavior (generation keeps title/notes, template save/series edit resyncs them); removed the unused `findProcessingRangeStart` | `docs/recurrences-and-pomodoro.md` | Issue #107, `src/lib/recurring/engine.ts`, `engine.test.ts`, both repositories |
| 2026-10-02 | Moved Pomodoro session and segment transition rules from both repositories into the pure engine, keeping persisted timing and no-op behavior | `docs/recurrences-and-pomodoro.md` | `engine.ts`, both repositories, `engine.test.ts` |
| 2026-09-27 | Active future recurrence rewind subtracts pending counters, emits lifecycle events, and cancels premature instances before `startDate` | `docs/recurrences-and-pomodoro.md`, `docs/gtd.md` | `prepareRecurringGeneration`, `generateDueRecurringTasks` |
| 2026-09-25 | Recurrence generation is capped at local today, and a future `lastGeneratedForDate` is rewound on the next pass so a weekly or monthly summary cannot consume later occurrences | `docs/recurrences-and-pomodoro.md`, `docs/gtd.md` | `prepareRecurringGeneration`, `recurrenceGenerationHorizon`, `generateDueRecurringTasks` |
| 2026-09-22 | `MemoryRepository.generateDueRecurringTasks` now reapplies the template's current `contextIds`/`projectId` to the active task on every generation, matching `TauriSqliteRepository` (previously it kept whatever the active task row already had); title/notes still carry over from the active task | `docs/recurrences-and-pomodoro.md` | `src/lib/storage/memory-repository.ts`, `src/lib/storage/repository.contract.ts` |
| 2026-09-11 | Pomodoro task pickers offer active Next Actions only; Scheduled tasks are excluded until promotion | `docs/recurrences-and-pomodoro.md` | `isPomodoroTaskEligible`, `use-pomodoro-controller.test.tsx` |
| 2026-09-08 | Idle overlay now ticks its own 25-minute idle clock (`AppShell` and `FloatingPomodoroTimer`) so it hides itself with no other app activity, instead of relying on an unrelated re-render; documented the local-midnight edge case where the overlay can hide slightly earlier than 25 minutes | `docs/recurrences-and-pomodoro.md` | `FloatingPomodoroTimer.test.tsx` |
| 2026-09-07 | Floating Pomodoro overlay persists through idle cycle steps with compact start-break/start-focus actions; hidden on `/pomodoro` | `docs/recurrences-and-pomodoro.md`, `docs/architecture.md` | `FloatingPomodoroTimer`, `shouldShowFloatingPomodoro` |
| 2026-09-07 | Due Scheduled recurrence instances promote to Next Actions on their local due date, same pass as one-off Scheduled tasks, including at local-day rollover while the app stays open | `docs/recurrences-and-pomodoro.md`, `docs/gtd.md` | `src/lib/gtd/scheduled.ts`, `promoteDueScheduledTasks`, `use-local-day-reconciliation.ts` |
| 2026-09-01 | Pomodoro page can refresh eligible tasks; task/recurrence assignment selectors suggest active projects only; Today dashboard edits morning intention and night reflection as matching textareas | `docs/recurrences-and-pomodoro.md`, `docs/gtd.md`, `docs/daily-routines.md` | `PomodoroPage`, `projectsForAssignment`, `TodayPage` |
| 2026-08-12 | Retry Pomodoro history/summary snapshots after a transient list-read failure so the page cannot stay on pre-action history after the active session already updated | `docs/recurrences-and-pomodoro.md` | `src/app/use-pomodoro-controller.ts`, Pomodoro controller tests |
| 2026-07-30 | Hardened Pomodoro expiry against malformed deadlines, action/deadline races, and transient post-expiry refresh failures | `docs/recurrences-and-pomodoro.md` | `src/lib/pomodoro/engine.ts`, `src/app/use-pomodoro-controller.ts`, Pomodoro tests |
| 2026-07-30 | Reworked Pomodoro timing so display ticks are local to timer views while controller expiry uses serialized deadline scheduling, recovery-safe invalid timing, and deduplicated verified completion notices | `docs/recurrences-and-pomodoro.md` | `src/app/use-pomodoro-controller.ts`, `src/app/use-pomodoro-timing.ts`, Pomodoro tests |

## Entry template

```text
YYYY-MM-DD | <concise behavior/documentation change> | <canonical docs> | <code, test, issue, or plan evidence>
```
