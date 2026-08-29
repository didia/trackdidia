# Documentation Log

Chronological record of material TrackDidia wiki maintenance. Add new entries at
the top of the table.

| Date | Change | Canonical pages | Evidence |
|---|---|---|---|
| 2026-08-30 | Phase 2 pulse review fixes: completed tasks count as progress, idle/unknown skip RescueTime fetch, missed slots break stall notification chain, pulse slot hours require exactly three unique local hours | `docs/ai-settings-and-privacy.md` | `src/lib/ai/pulse/pulse-engine.ts`, `slot-hours.ts`, `SettingsPage.tsx` |
| 2026-08-30 | Phase 1 PR review fixes: Today auto-loads AI, accept auto-saves journal fields, append-only `ai_messages` (migration 23), coach schema in prompts, ephemeral local proposals suppressed, RescueTime skipped for fast local brief | `docs/ai-settings-and-privacy.md`, `docs/storage-and-backups.md` | Migration 23, `CoachPulseService`, `CoachPulsePanel`, `TodayPage`, `EveningClosurePage` |
| 2026-08-29 | Shipped AI Integration v2 Phase 3: `ai_memories` migration 24, retrieval/lifecycle engine, commitment loop, distillation proposals, Settings profile CRUD | `docs/ai-settings-and-privacy.md`, `docs/storage-and-backups.md` | Migration 24, `src/lib/ai/memory/`, `AiMemoryProfileSection`, `CoachPulseService` |
| 2026-08-29 | Shipped AI Integration v2 Phase 2: catch-up pulse engine (`open`/`steer`/`wind_down`), delta gate, weekday stall notifications, pulse settings, and Today panel thread | `docs/ai-settings-and-privacy.md` | `src/lib/ai/pulse/`, `app-context.tsx`, `TodayPage.tsx`, `SettingsPage.tsx` |
| 2026-08-29 | Shipped AI Integration v2 Phase 1: structured `coach_pulse` (`open`/`close`), provider hardening, `ai_messages`/`ai_proposals` persistence, explicit coach trigger, and accept-step prefills | `docs/ai-settings-and-privacy.md`, `docs/storage-and-backups.md` | Migrations 21–22, `CoachPulseService`, `OpenRouterProvider`, `TodayPage`, `EveningClosurePage` |
| 2026-08-29 | Documented the Settings `aiPayloadScope` control (default `full`) and the debug-gated AI payload preview panel, including the shared RescueTime pulse fetch reused across its three scoped previews | `docs/ai-settings-and-privacy.md` | `src/domain/types.ts` (`AiPayloadScope`), `src/pages/SettingsPage.tsx`, `src/lib/ai/context/preview.ts` (`resolveProductivityPulse`) |
| 2026-08-29 | Added a "Finaliser hier" card on `/routine-matin` that shows only yesterday's still-missing manual metrics, unanswered principles, and empty night reflection, saved via one button and hidden by `AppSettings.previousDayReviewDoneDate` | `docs/daily-routines.md` | `src/domain/daily-entry.ts` (`findMissingMetricKeys`, `findUnansweredPrincipleKeys`), `src/components/PreviousDayReviewCard.tsx`, `src/pages/MorningRoutinePage.tsx` |
| 2026-08-13 | Added `npm run mac-install` to copy the release `Trackdidia.app` into `/Applications` | `docs/desktop-builds.md` | `scripts/mac-install.sh`, `package.json` |
| 2026-08-12 | Weekly score: seven local axes (calories at 3800 kcal/day), optional RescueTime Goals + productivity pulse overlay on `/semaine` | `docs/reviews-and-goals.md`, `docs/ai-settings-and-privacy.md` | `src/domain/weekly-review.ts`, `src/lib/rescuetime/rescuetime-goals-service.ts`, weekly review page |
| 2026-08-12 | Retry Pomodoro history/summary snapshots after a transient list-read failure so the page cannot stay on pre-action history after the active session already updated | `docs/recurrences-and-pomodoro.md` | `src/app/use-pomodoro-controller.ts`, Pomodoro controller tests |
| 2026-08-11 | Documented RescueTime dual transport (Tauri native HTTP vs browser fetch fallback) | `docs/ai-settings-and-privacy.md` | `fetchRescueTimeJson`, `rescuetime_http_get` |
| 2026-08-11 | Clarified RescueTime API key is app settings only at runtime; Settings test uses Goals API; weekly review reloads on key change | `docs/ai-settings-and-privacy.md`, `docs/reviews-and-goals.md` | Settings page, `RescueTimeGoalsService.testConnection`, weekly review effect |
| 2026-08-11 | Added standing weekly objectives with RescueTime time scoring, migration 20, settings key, and `/semaine` UI | `docs/reviews-and-goals.md`, `docs/ai-settings-and-privacy.md`, `docs/storage-and-backups.md` | Migration 20, `src/domain/weekly-objectives.ts`, `src/lib/rescuetime/*`, weekly review page |
| 2026-07-30 | Hardened Pomodoro expiry against malformed deadlines, action/deadline races, and transient post-expiry refresh failures | `docs/recurrences-and-pomodoro.md` | `src/lib/pomodoro/engine.ts`, `src/app/use-pomodoro-controller.ts`, Pomodoro tests |
| 2026-07-30 | Reworked Pomodoro timing so display ticks are local to timer views while controller expiry uses serialized deadline scheduling, recovery-safe invalid timing, and deduplicated verified completion notices | `docs/recurrences-and-pomodoro.md` | `src/app/use-pomodoro-controller.ts`, `src/app/use-pomodoro-timing.ts`, Pomodoro tests |
| 2026-07-29 | Bootstrapped the full agent-maintained documentation system: architecture, persistence, daily routines, reviews/goals, GTD, recurrences/Pomodoro, AI/privacy, conventions, and desktop builds | `AGENTS.md`, `docs/*.md` | Current source tree, tests, Tauri configuration, comparison with the Bâtisseurs documentation structure |

## Entry template

```text
YYYY-MM-DD | <concise behavior/documentation change> | <canonical docs> | <code, test, issue, or plan evidence>
```
