# Recurrences and Pomodoro log

Back to [Documentation Log](../log.md). Canonical page:
[recurrences-and-pomodoro.md](../recurrences-and-pomodoro.md).

| Date | Change | Canonical pages | Evidence |
|---|---|---|---|
| 2026-09-01 | Pomodoro page can refresh eligible tasks; task/recurrence assignment selectors suggest active projects only; Today dashboard edits morning intention and night reflection as matching textareas | `docs/recurrences-and-pomodoro.md`, `docs/gtd.md`, `docs/daily-routines.md` | `PomodoroPage`, `projectsForAssignment`, `TodayPage` |
| 2026-08-12 | Retry Pomodoro history/summary snapshots after a transient list-read failure so the page cannot stay on pre-action history after the active session already updated | `docs/recurrences-and-pomodoro.md` | `src/app/use-pomodoro-controller.ts`, Pomodoro controller tests |
| 2026-07-30 | Hardened Pomodoro expiry against malformed deadlines, action/deadline races, and transient post-expiry refresh failures | `docs/recurrences-and-pomodoro.md` | `src/lib/pomodoro/engine.ts`, `src/app/use-pomodoro-controller.ts`, Pomodoro tests |
| 2026-07-30 | Reworked Pomodoro timing so display ticks are local to timer views while controller expiry uses serialized deadline scheduling, recovery-safe invalid timing, and deduplicated verified completion notices | `docs/recurrences-and-pomodoro.md` | `src/app/use-pomodoro-controller.ts`, `src/app/use-pomodoro-timing.ts`, Pomodoro tests |

## Entry template

```text
YYYY-MM-DD | <concise behavior/documentation change> | <canonical docs> | <code, test, issue, or plan evidence>
```
