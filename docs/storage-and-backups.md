# Storage and Backups

TrackDidia is local-first. The desktop application stores all durable product data
in one SQLite database. Browser preview and startup fallback use an in-memory
repository and do not survive reloads.

## Runtime selection

`createRepository()` checks for `window.__TAURI_INTERNALS__`.

| Runtime | Repository | Persistence | Native backup |
|---|---|---|---|
| Tauri desktop | `TauriSqliteRepository` | SQLite | Yes |
| Vite/browser preview | `MemoryRepository` | None | No |
| Desktop startup failure/timeout | New `MemoryRepository` | None | No |

The fallback is a resilience feature, not a storage mode. The UI displays a warning
when SQLite startup fails.

## Application data paths

The native `resolve_storage_paths` command uses Tauri's application data directory.
The Tauri identifier is `com.trackdidia.desktop`.

| Build | Database | Backup directory |
|---|---|---|
| Debug / `tauri dev` | `trackdidia.dev.db` | `backups-dev/` |
| Release | `trackdidia.db` | `backups/` |

On macOS these resolve beneath:

```text
~/Library/Application Support/com.trackdidia.desktop/
```

The SQL plugin opens a relative connection string (`sqlite:trackdidia.dev.db` or
`sqlite:trackdidia.db`), while the native command also returns the absolute database
and backup paths for display and backup creation.

SQLite may create neighboring `-wal` and `-shm` files. They are normal SQLite WAL
artifacts and must not be treated as disposable while the database is open.

Changing the Tauri identifier changes the app-data location from the operating
system's perspective. Do not change it without a deliberate user-data migration.

## Repository contract

`AppRepository` is the only supported data-access boundary for application code.
It groups:

- daily entries;
- weekly and monthly reviews;
- annual goals;
- settings and backup operations;
- GTD contexts, projects, tasks, and task events;
- recurrence templates and generated work;
- Pomodoro sessions and segments.

The SQLite and memory implementations must remain behaviorally aligned, except for
native-only storage information and backup creation.

## Migration system

The `migrations` array in
`src/lib/storage/tauri-sqlite-repository.ts` is the schema source of truth.

Startup:

1. Open the database.
2. Create `schema_migrations`.
3. Read applied IDs.
4. Execute unapplied migrations in ascending array order.
5. Insert each applied migration ID/name/timestamp.
6. Seed the singleton settings row when absent.

Never renumber or rewrite a released migration. Add the next ID.

### Current migration catalog

| ID | Name | Effect |
|---:|---|---|
| 1 | `create_schema_migrations` | Migration ledger |
| 2 | `create_daily_entries` | Daily routine records |
| 3 | `create_app_settings` | Singleton settings JSON |
| 4 | `create_gtd_contexts` | Context/tag records |
| 5 | `create_gtd_projects` | GTD projects |
| 6 | `create_gtd_tasks` | GTD tasks |
| 7 | `create_gtd_task_events` | Task lifecycle event ledger |
| 8 | `add_gtd_task_recurrence_fields` | Imported recurrence grouping/missed count |
| 9 | `add_gtd_project_status_changed_at` | Project transition timestamp + backfill |
| 10 | `create_pomodoro_sessions` | Timer sessions |
| 11 | `create_pomodoro_segments` | Task/activity slices inside sessions |
| 12 | `create_recurring_task_templates` | Local recurrence definitions |
| 13 | `add_recurring_fields_to_gtd_tasks` | Link generated task to local template |
| 14 | `add_title_to_pomodoro_segments` | Manual activity label |
| 15 | `add_deadline_to_gtd_tasks` | Date-only task deadline |
| 16 | `create_weekly_reviews` | Weekly ritual state |
| 17 | `create_monthly_reviews` | Monthly ritual state |
| 18 | `create_annual_goals` | Goals and monthly evaluations |
| 19 | `add_paused_remaining_ms_to_pomodoro_sessions` | Durable paused timer state |
| 20 | `create_weekly_objectives` | Standing weekly objectives and per-week manual results |
| 21 | `create_ai_messages` | Persisted AI coach outputs, usage, and input-hash cache |
| 22 | `create_ai_proposals` | Accept-step proposals linked to AI messages |

## Table reference

JSON columns intentionally keep evolving, bounded structures compact. TypeScript
types and serializers are therefore part of the persisted contract.

### `schema_migrations`

| Column | Notes |
|---|---|
| `id` | Integer primary key |
| `name` | Unique migration name |
| `applied_at` | ISO timestamp |

### `daily_entries`

| Column | Notes |
|---|---|
| `date` | Local `YYYY-MM-DD` primary key |
| `status` | `not_started`, `morning_done`, or `closed` |
| `metrics_json` | Explicit `DailyMetrics`; suggested values are derived |
| `principles_json` | `PrincipleChecks` |
| `morning_intention` | Morning journal text |
| `night_reflection` | Evening journal text |
| `tomorrow_focus` | Next-day focus text |
| `updated_at` | ISO timestamp |

### `app_settings`

Singleton row constrained to `id = 1`.

| Column | Notes |
|---|---|
| `id` | Always `1` |
| `value` | Serialized `AppSettings`, including the optional OpenRouter key |

Settings are merged with current defaults on read, which lets newly introduced
settings appear on existing installations without an immediate JSON backfill.

### `gtd_contexts`

| Column | Notes |
|---|---|
| `id` | Usually deterministic `context:<slug>` |
| `name` | Unique display name |
| `created_at`, `updated_at` | ISO timestamps |

### `gtd_projects`

| Column | Notes |
|---|---|
| `id` | Local/generated or imported ID |
| `title`, `notes` | Project content |
| `status` | `active`, `on_hold`, `completed`, `cancelled` |
| `status_changed_at` | Last status-transition timestamp |
| `context_ids_json` | Context ID array |
| `source` | `manual` or `google_import` |
| `source_external_id` | Unique Google source ID when imported |
| `created_at`, `updated_at` | ISO timestamps |

### `gtd_tasks`

| Column group | Columns / meaning |
|---|---|
| Identity/content | `id`, `title`, `notes` |
| Lifecycle | `status`, `completed_at`, `created_at`, `updated_at` |
| Organization | `bucket`, `context_ids_json`, `project_id`, `parent_task_id` |
| Dates | `scheduled_for` (instant), `deadline` (local date) |
| Local recurrence | `recurring_template_id`, `recurrence_due_date`, `is_recurring_instance` |
| Imported recurrence | `recurrence_group_id`, `pending_past_recurrences` |
| Provenance | `source`, unique `source_external_id` |

There are no declared SQL foreign keys. Referential consistency is enforced by
repository/domain behavior.

### `gtd_task_events`

| Column | Notes |
|---|---|
| `id` | Generated event ID |
| `task_id` | Related task |
| `type` | Created, moved, scheduled, completed, or weekly carryover |
| `event_date` | Local business date |
| `event_at`, `created_at` | ISO timestamps |
| `dedupe_key` | Optional unique key; used by weekly carryover |
| `metadata_json` | Small string map |

This table is append-only in normal application behavior and is required for
historical daily task counts.

### `recurring_task_templates`

Stores title/notes, destination bucket, contexts/project, daily/weekly/monthly rule
fields, optional scheduled time, start date, status, last generated date, missed
occurrence count, and lifecycle timestamps.

### `pomodoro_sessions`

| Column | Notes |
|---|---|
| `id` | Session ID |
| `kind` | `focus`, `short_break`, `long_break` |
| `status` | `running`, `paused`, `completed`, `cancelled` |
| `started_at`, `ends_at` | Timer boundaries |
| `paused_remaining_ms` | Remaining duration while paused |
| `completed_at`, `cancelled_at` | Terminal timestamps |
| `cycle_index` | Focus position 1-4 |
| `date` | Local start date |

### `pomodoro_segments`

Each row is one contiguous activity slice within a session: `session_id`, optional
`task_id`, optional manual `title`, `started_at`, and optional `ended_at`.

### Review and goal tables

- `weekly_reviews`: Sunday start, Saturday end, status, notes JSON, checklist JSON.
- `weekly_objectives`: standing objective definitions (`kind`, optional RescueTime mapping, target hours, sort order).
- `weekly_objective_results`: per-week manual achievement (`achieved` 0/1) keyed by `(week_start_date, objective_id)` with `ON DELETE CASCADE` from objectives.
- `monthly_reviews`: month key/start/end, status, notes JSON, checklist JSON.
- `annual_goals`: target/source/manual value plus evaluations JSON keyed by month.

Computed summaries and goal snapshots are not persisted; they are rebuilt from
daily/review data.

## Backup behavior

Manual and automatic backups call:

```sql
VACUUM INTO '<absolute backup path>'
```

This creates a self-contained SQLite snapshot without copying live WAL files.
Filenames contain the backup kind (`manual` or `auto`) and a sanitized timestamp.

Automatic backups:

- default to enabled;
- default interval is 24 hours;
- are checked at startup and every hour while the app remains open;
- run only when `lastBackupAt` is old enough;
- use an in-memory guard to avoid concurrent backup attempts;
- update `lastBackupAt` and `lastBackupPath` after success.

The Settings screen can change the enable flag/interval and create a manual backup.
Backup buttons are disabled in browser preview.

## Recovery

There is no restore UI. Recovery is currently an operator/manual action:

1. Fully quit TrackDidia.
2. Preserve the current database and any `-wal`/`-shm` files before changing them.
3. Choose a verified backup from the matching environment directory.
4. Replace the matching environment database file with a copy of that backup.
5. Restart the application and verify entries, tasks, and settings.

Do not restore a development backup over production (or the reverse) without
explicitly choosing that outcome. Do not perform this operation automatically in a
code task.

## Data safety and privacy

- The database contains personal journals, principles, goals, tasks, and AI
  configuration.
- `app_settings.value` may contain the OpenRouter API key and the RescueTime API key in plaintext.
- Backups contain the same sensitive data as the source database.
- `Tasks.json` may contain personal Google Tasks data and is intentionally
  gitignored.
- `dist/` may embed imported task data when built locally because `Tasks.json` is a
  static source import. Treat locally built artifacts as sensitive.

## Related documentation

- [Architecture](architecture.md)
- [GTD](gtd.md)
- [AI, settings, and privacy](ai-settings-and-privacy.md)
- [Desktop builds](desktop-builds.md)
