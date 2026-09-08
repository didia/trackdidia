# Recurrences and Pomodoro log

Back to [Documentation Log](../log.md). Canonical page:
[recurrences-and-pomodoro.md](../recurrences-and-pomodoro.md).

| Date | Change | Canonical pages | Evidence |
|---|---|---|---|
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
