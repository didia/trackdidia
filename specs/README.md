# Implementation specs

`todo/` contains approved specifications that are not fully shipped, including work that
is unstarted or in progress. It is the valid lifecycle state until implementation, tests,
and canonical documentation updates ship.
`done/` contains fully implemented specifications.

Move a specification from `todo/` to `done/` only after its implementation, tests, and
canonical `docs/` updates have shipped. Specs are planning and historical records; the
current-product behavior remains documented in [`docs/`](../docs/).

## Index

- [`todo/mobile-and-sync.md`](todo/mobile-and-sync.md) — approved, unshipped lean iOS
  companion app and decentralized desktop↔phone sync engine.
- [`todo/calendar-sync.md`](todo/calendar-sync.md) — approved, unshipped one-way Google
  Calendar sync of Scheduled and Planned tasks with a date.
- [`todo/weekly-review-caching.md`](todo/weekly-review-caching.md) — §1 shipped (RescueTime
  snapshot cache); §2 compact weekly RescueTime goal lines and §3 last-good weekly coach
  synthesis fallback not implemented.
- [`done/finance.md`](done/finance.md) — implemented household finances: CSV import,
  heuristic + learned + AI categorization, Mint-style tracking, YNAB-style envelope budgets,
  and proactive runout forecasting. All 8 phases shipped.
- [`done/mid-week-review.md`](done/mid-week-review.md) — implemented dedicated `/mi-semaine`
  page: pro-rated pace per signal, RescueTime snapshot cache, saved decisions with a
  before/after card on `/semaine`, and AI steering. The optional journal feed (PR C) was not
  shipped.
- [`done/ai-integration-v2.md`](done/ai-integration-v2.md) — implemented AI integration v2.
- [`done/email-triage.md`](done/email-triage.md) — implemented multi-account email triage.
- [`done/project-planned-tasks.md`](done/project-planned-tasks.md) — implemented Project
  Planned Tasks feature.
