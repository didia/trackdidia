# Reviews and goals log

Back to [Documentation Log](../log.md). Canonical page:
[reviews-and-goals.md](../reviews-and-goals.md).

| Date | Change | Canonical pages | Evidence |
|---|---|---|---|
| 2026-08-31 | Weekly/monthly ritual notes survive leaving the page: textarea flush on unmount, serialized latest-wins review saves | `docs/reviews-and-goals.md`, `docs/conventions.md` | `PersistedTextarea`, `WeeklyReviewPage`, `MonthlyReviewPage` |
| 2026-08-30 | Phase 4 PR #58 review: atomic weekly synthesis persist/accept, standing objectives UI, week-scoped synthesis, migration 25 index, S2 schema prompt, preview Goals parity, fallback retry policy | `docs/reviews-and-goals.md`, `docs/ai-settings-and-privacy.md`, `docs/storage-and-backups.md` | Migration 25, `WeeklyReviewPage`, `WeeklySynthesisService`, `acceptAi*Proposal`, `listDailyEntriesOnOrBefore` |
| 2026-08-29 | Shipped AI Integration v2 Phase 5: S3 `monthly_synthesis` on `/mois`, S4 `goal_pacing` on `/objectifs-annuels`, monthly/annual snapshots, goal_evaluation accept-step | `docs/reviews-and-goals.md`, `docs/ai-settings-and-privacy.md` | `src/lib/ai/context/monthly-snapshot.ts`, `MonthlySynthesisService`, `GoalPacingService`, `MonthlyReviewPage`, `AnnualGoalsPage` |
| 2026-08-29 | Shipped AI Integration v2 Phase 4: S2 `weekly_synthesis` on `/semaine`, weekly snapshot builder, accept-step for section drafts/objectives/GTD actions | `docs/reviews-and-goals.md`, `docs/ai-settings-and-privacy.md` | `src/lib/ai/context/weekly-snapshot.ts`, `WeeklySynthesisService`, `WeeklyReviewPage` |
| 2026-08-12 | Weekly score: seven local axes (calories at 3800 kcal/day), optional RescueTime Goals + productivity pulse overlay on `/semaine` | `docs/reviews-and-goals.md`, `docs/ai-settings-and-privacy.md` | `src/domain/weekly-review.ts`, `src/lib/rescuetime/rescuetime-goals-service.ts`, weekly review page |
| 2026-08-11 | Added standing weekly objectives with RescueTime time scoring, migration 20, settings key, and `/semaine` UI | `docs/reviews-and-goals.md`, `docs/ai-settings-and-privacy.md`, `docs/storage-and-backups.md` | Migration 20, `src/domain/weekly-objectives.ts`, `src/lib/rescuetime/*`, weekly review page |

## Entry template

```text
YYYY-MM-DD | <concise behavior/documentation change> | <canonical docs> | <code, test, issue, or plan evidence>
```
