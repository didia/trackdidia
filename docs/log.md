# Documentation Log

Chronological records live in domain logs under [`docs/logs/`](logs/). This page
is only the catalog and write rules — day-to-day work should not edit it.

## Domain logs

| Domain log | Canonical page |
|---|---|
| [logs/architecture.md](logs/architecture.md) | [architecture.md](architecture.md) |
| [logs/storage-and-backups.md](logs/storage-and-backups.md) | [storage-and-backups.md](storage-and-backups.md) |
| [logs/daily-routines.md](logs/daily-routines.md) | [daily-routines.md](daily-routines.md) |
| [logs/reviews-and-goals.md](logs/reviews-and-goals.md) | [reviews-and-goals.md](reviews-and-goals.md) |
| [logs/gtd.md](logs/gtd.md) | [gtd.md](gtd.md) |
| [logs/recurrences-and-pomodoro.md](logs/recurrences-and-pomodoro.md) | [recurrences-and-pomodoro.md](recurrences-and-pomodoro.md) |
| [logs/ai-settings-and-privacy.md](logs/ai-settings-and-privacy.md) | [ai-settings-and-privacy.md](ai-settings-and-privacy.md) |
| [logs/conventions.md](logs/conventions.md) | [conventions.md](conventions.md) |
| [logs/desktop-builds.md](logs/desktop-builds.md) | [desktop-builds.md](desktop-builds.md) |

Path rule: `docs/<page>.md` → `docs/logs/<page>.md`. Documentation-process
changes (`AGENTS.md`, this index, conventions workflow) land in
[logs/conventions.md](logs/conventions.md).

## Write rules

1. Update the canonical page whose shipped behavior changed.
2. Prepend a row to **only** that page’s file under `docs/logs/`.
3. If two product domains both changed materially, prepend the same row to
   **both** product logs.
4. Do **not** also edit this index unless you are adding a new domain log here.
5. Do **not** log incidental mentions of `architecture.md` / `conventions.md`
   when those pages were not the subject of the change.

## Entry template

```text
YYYY-MM-DD | <concise behavior/documentation change> | <canonical docs> | <code, test, issue, or plan evidence>
```
