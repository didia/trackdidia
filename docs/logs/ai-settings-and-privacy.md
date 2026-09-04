# AI, settings, and privacy log

Back to [Documentation Log](../log.md). Canonical page:
[ai-settings-and-privacy.md](../ai-settings-and-privacy.md).

| Date | Change | Canonical pages | Evidence |
|---|---|---|---|
| 2026-09-04 | AI max tokens default is 4096, configurable in Settings; stored factory 700 is upgraded once at bootstrap; unreadable length-truncated OpenRouter responses log a debug warn and a French fallback warning | `docs/ai-settings-and-privacy.md` | `aiMaxTokens`, `applyLegacyAiMaxTokensUpgrade`, `OpenRouterProvider`, `SettingsPage` |
| 2026-09-03 | Evening close auto-load only reuses `ok` pulses, skip-RescueTime hash cache keeps freshness, commitments resolve with AI off, disabled reason is visible on autoload | `docs/ai-settings-and-privacy.md`, `docs/daily-routines.md` | `latestClosePulseMessage`, `EveningClosurePage`, `CoachPulsePanel`, `resolveDueCommitmentsOnClose` |
| 2026-09-02 | Evening close coach reuses a persisted `close` pulse on page open (Today-style), instead of calling the model every visit | `docs/ai-settings-and-privacy.md`, `docs/daily-routines.md` | `loadLatestClosePulseForDate`, `EveningClosurePage` |
| 2026-08-31 | Phase 6 PR #60 review: analytics error state, cost rate without refetch, `AiUsageTotals` vs UI cost estimate, newest-under-cap messages, 30-day dismissal table, analytics CSS | `docs/ai-settings-and-privacy.md` | `AiCoachAnalyticsSection`, `AiCostDashboardSection`, `SettingsPage`, `listAiMessagesSince`, `computeAiUsageForMonth` |
| 2026-08-30 | Phase 5 PR #59 second-pass: atomic monthly section-draft accept, month-scoped synthesis, aligned goal-pacing risk tolerance | `docs/ai-settings-and-privacy.md`, `docs/reviews-and-goals.md`, `docs/storage-and-backups.md` | `acceptAiMonthlyReviewSectionDraftProposal`, `MonthlyReviewPage`, `ANNUAL_GOAL_PACE_TOLERANCE`, `goal-pacing-fallback` |
| 2026-08-30 | Phase 5 PR #59 review: S3/S4 schema prompts, monthly/goal-pacing cache parity with weekly, annual year/month gating, unknown goal dismiss, score 0–100 validation | `docs/ai-settings-and-privacy.md`, `docs/reviews-and-goals.md` | `OpenRouterProvider`, `MonthlySynthesisService`, `GoalPacingService`, `AnnualGoalsPage`, `MonthlyReviewPage` |
| 2026-08-30 | Weekly Settings preview passes Goals+pulse via `weeklyRescueTime` (fixes null Goals on injected path) | `docs/ai-settings-and-privacy.md` | `SettingsPage.tsx`, `preview.ts` |
| 2026-08-30 | Phase 3 PR review fixes: atomic memory accept, weekly distill rebuild, close-cache commitment finalization, stable pattern confirmation refresh | `docs/ai-settings-and-privacy.md` | `acceptAiMemoryProposal`, `weekly-distillation.ts`, `CoachPulseService`, `lifecycle.ts` |
| 2026-08-30 | Phase 2 pulse review fixes: completed tasks count as progress, idle/unknown skip RescueTime fetch, missed slots break stall notification chain, pulse slot hours require exactly three unique local hours | `docs/ai-settings-and-privacy.md` | `src/lib/ai/pulse/pulse-engine.ts`, `slot-hours.ts`, `SettingsPage.tsx` |
| 2026-08-30 | Phase 1 PR review fixes: Today auto-loads AI, accept auto-saves journal fields, append-only `ai_messages` (migration 23), coach schema in prompts, ephemeral local proposals suppressed, RescueTime skipped for fast local brief | `docs/ai-settings-and-privacy.md`, `docs/storage-and-backups.md` | Migration 23, `CoachPulseService`, `CoachPulsePanel`, `TodayPage`, `EveningClosurePage` |
| 2026-08-29 | Shipped AI Integration v2 Phase 6 (final): monthly AI cost dashboard, proposal-acceptance analytics in Settings, prompt version registry, repository usage/analytics methods | `docs/ai-settings-and-privacy.md` | `src/lib/ai/analytics/`, `src/lib/ai/prompts/registry.ts`, `AiCostDashboardSection`, `AiCoachAnalyticsSection`, `computeAiUsageForMonth` |
| 2026-08-29 | Phase 4 fix: persist local weekly synthesis on auto trigger; gtd_action schedules today; Settings weekly payload preview | `docs/ai-settings-and-privacy.md` | `WeeklySynthesisService`, `apply-proposal.ts`, `SettingsPage.tsx` |
| 2026-08-29 | Shipped AI Integration v2 Phase 3: `ai_memories` migration 24, retrieval/lifecycle engine, commitment loop, distillation proposals, Settings profile CRUD | `docs/ai-settings-and-privacy.md`, `docs/storage-and-backups.md` | Migration 24, `src/lib/ai/memory/`, `AiMemoryProfileSection`, `CoachPulseService` |
| 2026-08-29 | Shipped AI Integration v2 Phase 2: catch-up pulse engine (`open`/`steer`/`wind_down`), delta gate, weekday stall notifications, pulse settings, and Today panel thread | `docs/ai-settings-and-privacy.md` | `src/lib/ai/pulse/`, `app-context.tsx`, `TodayPage.tsx`, `SettingsPage.tsx` |
| 2026-08-29 | Shipped AI Integration v2 Phase 1: structured `coach_pulse` (`open`/`close`), provider hardening, `ai_messages`/`ai_proposals` persistence, explicit coach trigger, and accept-step prefills | `docs/ai-settings-and-privacy.md`, `docs/storage-and-backups.md` | Migrations 21–22, `CoachPulseService`, `OpenRouterProvider`, `TodayPage`, `EveningClosurePage` |
| 2026-08-29 | Documented the Settings `aiPayloadScope` control (default `full`) and the debug-gated AI payload preview panel, including the shared RescueTime pulse fetch reused across its three scoped previews | `docs/ai-settings-and-privacy.md` | `src/domain/types.ts` (`AiPayloadScope`), `src/pages/SettingsPage.tsx`, `src/lib/ai/context/preview.ts` (`resolveProductivityPulse`) |
| 2026-08-11 | Documented RescueTime dual transport (Tauri native HTTP vs browser fetch fallback) | `docs/ai-settings-and-privacy.md` | `fetchRescueTimeJson`, `rescuetime_http_get` |
| 2026-08-11 | Clarified RescueTime API key is app settings only at runtime; Settings test uses Goals API; weekly review reloads on key change | `docs/ai-settings-and-privacy.md`, `docs/reviews-and-goals.md` | Settings page, `RescueTimeGoalsService.testConnection`, weekly review effect |

## Entry template

```text
YYYY-MM-DD | <concise behavior/documentation change> | <canonical docs> | <code, test, issue, or plan evidence>
```
