# Storage and backups log

Back to [Documentation Log](../log.md). Canonical page:
[storage-and-backups.md](../storage-and-backups.md).

| Date | Change | Canonical pages | Evidence |
|---|---|---|---|
| 2026-09-03 | Backup destination must already exist; prune is best-effort; missing-folder warning is app-wide when auto-backup is on | `docs/storage-and-backups.md`, `docs/ai-settings-and-privacy.md` | `ensure_backup_directory`, `prune_backups`, `isBackupDestinationMissing` |
| 2026-09-02 | Backups write to a user-chosen folder (typically Google Drive for Desktop), keep the newest 30 snapshots per environment subdirectory, and no longer create Application Support backup dirs | `docs/storage-and-backups.md`, `docs/desktop-builds.md`, `docs/ai-settings-and-privacy.md`, `docs/architecture.md` | `backupDestinationDir`, `src/lib/backup.ts`, `src-tauri/src/backup.rs`, `SettingsPage` |
| 2026-08-31 | Custom single-connection sqlx pool (`db_connect`/`db_execute`/`db_select`) replaces `tauri-plugin-sql`; WAL + busy_timeout; reapers disabled so JS `BEGIN`/`COMMIT` stay on one connection | `docs/storage-and-backups.md`, `docs/architecture.md`, `docs/desktop-builds.md` | `src-tauri/src/db.rs`, `TauriSqliteRepository` |

## Entry template

```text
YYYY-MM-DD | <concise behavior/documentation change> | <canonical docs> | <code, test, issue, or plan evidence>
```
