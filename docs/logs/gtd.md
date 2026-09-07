# GTD log

Back to [Documentation Log](../log.md). Canonical page: [gtd.md](../gtd.md).

| Date | Change | Canonical pages | Evidence |
|---|---|---|---|
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
