# Documentation Log

Chronological record of material TrackDidia wiki maintenance. Add new entries at
the top of the table.

| Date | Change | Canonical pages | Evidence |
|---|---|---|---|
| 2026-08-11 | Documented RescueTime dual transport (Tauri native HTTP vs browser fetch fallback) | `docs/ai-settings-and-privacy.md` | `fetchRescueTimeJson`, `rescuetime_http_get` |
| 2026-08-11 | Clarified RescueTime API key is app settings only at runtime; Settings test uses Goals API; weekly review reloads on key change | `docs/ai-settings-and-privacy.md`, `docs/reviews-and-goals.md` | Settings page, `RescueTimeGoalsService.testConnection`, weekly review effect |
| 2026-08-11 | Added standing weekly objectives with RescueTime time scoring, migration 20, settings key, and `/semaine` UI | `docs/reviews-and-goals.md`, `docs/ai-settings-and-privacy.md`, `docs/storage-and-backups.md` | Migration 20, `src/domain/weekly-objectives.ts`, `src/lib/rescuetime/*`, weekly review page |
| 2026-07-29 | Bootstrapped the full agent-maintained documentation system: architecture, persistence, daily routines, reviews/goals, GTD, recurrences/Pomodoro, AI/privacy, conventions, and desktop builds | `AGENTS.md`, `docs/*.md` | Current source tree, tests, Tauri configuration, comparison with the Bâtisseurs documentation structure |

## Entry template

```text
YYYY-MM-DD | <concise behavior/documentation change> | <canonical docs> | <code, test, issue, or plan evidence>
```
