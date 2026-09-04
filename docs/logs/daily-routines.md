# Daily routines log

Back to [Documentation Log](../log.md). Canonical page:
[daily-routines.md](../daily-routines.md).

| Date | Change | Canonical pages | Evidence |
|---|---|---|---|
| 2026-09-04 | Morning routine captures today's sleep quality and pushups; both remain editable on evening closure | `docs/daily-routines.md` | `morningMetricKeys`, `MorningRoutinePage` |
| 2026-09-02 | Daily journal saves serialize through `useDailyEntry`; Pomodoro manual refresh shows loading and failure; inactive assigned projects are labeled in selectors | `docs/daily-routines.md`, `docs/conventions.md`, `docs/recurrences-and-pomodoro.md`, `docs/gtd.md` | `useDailyEntry`, `usePomodoroController`, `projectAssignmentLabel` |
| 2026-08-31 | Morning anchors list trimmed to six principles in ritual order | `docs/daily-routines.md` | `morningPrincipleKeys`, `PrincipleChecklist` |
| 2026-08-29 | Added a "Finaliser hier" card on `/routine-matin` that shows only yesterday's still-missing manual metrics, unanswered principles, and empty night reflection, saved via one button and hidden by `AppSettings.previousDayReviewDoneDate` | `docs/daily-routines.md` | `src/domain/daily-entry.ts` (`findMissingMetricKeys`, `findUnansweredPrincipleKeys`), `src/components/PreviousDayReviewCard.tsx`, `src/pages/MorningRoutinePage.tsx` |

## Entry template

```text
YYYY-MM-DD | <concise behavior/documentation change> | <canonical docs> | <code, test, issue, or plan evidence>
```
