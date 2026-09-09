# Storage and backups log

Back to [Documentation Log](../log.md). Canonical page:
[storage-and-backups.md](../storage-and-backups.md).

| Date | Change | Canonical pages | Evidence |
|---|---|---|---|
| 2026-09-09 | Email triage review rows store subject/sender/received-at/source URL only; message bodies remain transient | `docs/storage-and-backups.md`, `docs/email-triage.md` | `email_triage_reviews.sanitized_preview_json`, `sync-engine.ts` |
| 2026-09-08 | Migration 32 adds `run_in_tray` and `launch_at_login` to `email_triage_settings`; a passing evaluation sets `automation_enabled` to 1 and a failed run clears it | `docs/storage-and-backups.md`, `docs/email-triage.md` | Migration `add_email_triage_desktop_prefs`, `saveEvaluation` |
| 2026-09-08 | Migration 29 adds email triage tables and `gtd_tasks.source_url`; OS vault commands are available for a later settings UI | `docs/storage-and-backups.md`, `docs/email-triage.md` | Migration `add_email_triage_foundation`, `src-tauri/src/vault.rs` |
| 2026-09-08 | `listDailyEntriesInRange` returns persisted rows without GTD/Pomodoro decoration so the Journal timeline stays a note-only read | `docs/storage-and-backups.md` | `MemoryRepository`, `TauriSqliteRepository` |
| 2026-09-08 | Repository range helpers for the Journal timeline: `listDailyEntriesInRange`, `listWeeklyReviewsOverlapping`, `listMonthlyReviewsOverlapping` | `docs/storage-and-backups.md` | `AppRepository`, `MemoryRepository`, `TauriSqliteRepository` |
| 2026-09-08 | Migration 28 adds ten nullable/defaulted columns to `annual_goals` for measurement type, status, deadline, numeric baseline/direction, recurring cadence/principle, and JSON progress log/milestones; all existing rows backfill to `measurement_type = 'numeric'` | `docs/storage-and-backups.md`, `docs/reviews-and-goals.md` | Migration `add_annual_goal_measurement_fields`, `src/lib/storage/tauri-sqlite-repository.ts` |
| 2026-09-07 | Fixed monthly review coach crash (`UNIQUE constraint failed: ai_proposals.message_id, ai_proposals.type`): migration 27 adds `goal_evaluation` to the pending-proposal uniqueness exclusion list (one evaluation per evaluated goal per message) and adds a second partial unique index on `(message_id, json_extract(payload_json, '$.goalId'))` so a duplicated goal id in one AI response can still only leave one pending proposal; `buildProposals` also dedupes by goal id, keeping the last draft | `docs/storage-and-backups.md` | Migration `ai_proposals_repeatable_goal_evaluation`, `src/lib/storage/migrations/ai-proposals-index.test.ts`, `src/lib/ai/monthly-synthesis-service.ts`, `src/lib/ai/monthly-synthesis-service.test.ts` |
| 2026-09-06 | Migration 26 adds `gtd_tasks.planned_order` plus a partial `(project_id, planned_order)` index for active Planned rows, and normalizes `planned_order = NULL` on every non-Planned row | `docs/storage-and-backups.md`, `docs/gtd.md` | Migration `add_gtd_task_planned_order`, `src/lib/storage/migrations/planned-order.test.ts` |
| 2026-09-03 | Backup destination must already exist; prune is best-effort; missing-folder warning is app-wide when auto-backup is on | `docs/storage-and-backups.md`, `docs/ai-settings-and-privacy.md` | `ensure_backup_directory`, `prune_backups`, `isBackupDestinationMissing` |
| 2026-09-02 | Backups write to a user-chosen folder (typically Google Drive for Desktop), keep the newest 30 snapshots per environment subdirectory, and no longer create Application Support backup dirs | `docs/storage-and-backups.md`, `docs/desktop-builds.md`, `docs/ai-settings-and-privacy.md`, `docs/architecture.md` | `backupDestinationDir`, `src/lib/backup.ts`, `src-tauri/src/backup.rs`, `SettingsPage` |
| 2026-08-31 | Custom single-connection sqlx pool (`db_connect`/`db_execute`/`db_select`) replaces `tauri-plugin-sql`; WAL + busy_timeout; reapers disabled so JS `BEGIN`/`COMMIT` stay on one connection | `docs/storage-and-backups.md`, `docs/architecture.md`, `docs/desktop-builds.md` | `src-tauri/src/db.rs`, `TauriSqliteRepository` |

## Entry template

```text
YYYY-MM-DD | <concise behavior/documentation change> | <canonical docs> | <code, test, issue, or plan evidence>
```
