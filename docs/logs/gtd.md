# GTD log

Back to [Documentation Log](../log.md). Canonical page: [gtd.md](../gtd.md).

| Date | Change | Canonical pages | Evidence |
|---|---|---|---|
| 2026-09-04 | Collapsed task summary reads the persisted assignment, nested project-card tasks omit the repeated project title, and `formatAssociationCopy` is shared with project cards | `docs/gtd.md` | `formatAssociationCopy`, `hideProjectTitle`, `GtdTaskCard` |
| 2026-09-03 | Tasks with no stored contexts inherit their project's contexts for collapsed-card labels and context filters | `docs/gtd.md` | `effectiveTaskContextIds`, `GtdTaskCard`, Next Actions / Waiting For / Someday filters |
| 2026-09-03 | Collapsed `GtdTaskCard` shows the assigned project title before contexts; `Sans contexte` only when neither is set | `docs/gtd.md` | `formatAssociationCopy`, `GtdTaskCard` |

## Entry template

```text
YYYY-MM-DD | <concise behavior/documentation change> | <canonical docs> | <code, test, issue, or plan evidence>
```
