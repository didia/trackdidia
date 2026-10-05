# Calendar sync log

Back to [Documentation Log](../log.md). Canonical page:
[calendar-sync.md](../calendar-sync.md).

| Date | Change | Canonical pages | Evidence |
|---|---|---|---|
| 2026-10-03 | Phase 3 (docs and polish): one-way TrackDidia → Google Calendar sync ships end to end (model/planner, OAuth connection, reconciler, Settings card). New canonical page `docs/calendar-sync.md` covers eligibility, promotion capture, the transition matrix, the removal rule, safety valves/gate table, triggers, OAuth/vault/scopes, and risks. Removed "Google Calendar synchronization" from *Current product boundaries* in `AGENTS.md`/`CLAUDE.md`; the feature remains one-way, desktop-only, and disabled by default. Spec moved to `specs/done/calendar-sync.md` | `docs/calendar-sync.md`, `docs/index.md`, `docs/storage-and-backups.md`, `docs/gtd.md`, `docs/architecture.md`, `docs/ai-settings-and-privacy.md`, `AGENTS.md`, `CLAUDE.md` | `specs/done/calendar-sync.md`, `src/lib/calendar/*`, `src/app/use-calendar-sync.ts`, `src-tauri/src/vault.rs` |
| 2026-10-02 | Calendar sync Phase 0 (model and planner, no network): migration 40 creates `calendar_sync_settings` and `calendar_sync_links`; pure `planCalendarSync` implements the full transition matrix, the reschedule refinement, the `rescheduled_after_promotion` exception, pending/reclaimable links, the 7-day staleness cap, and both safety valves | `docs/storage-and-backups.md` | `specs/todo/calendar-sync.md` (now `specs/done/calendar-sync.md`), migration `create_calendar_sync`, `src/lib/calendar/planner.ts`, `src/lib/calendar/eligibility.ts` |
