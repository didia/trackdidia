# Storage and Backups

See also: [changelog](logs/storage-and-backups.md).

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

| Build | Database | Backup subdirectory |
|---|---|---|
| Debug / `tauri dev` | `trackdidia.dev.db` | `backups-dev/` |
| Release | `trackdidia.db` | `backups/` |

Beside the database, the native host keeps a small per-installation device id file
(`device-id` in release builds, `device-id.dev` in debug builds, so the two environments
never share an identity). The `sync_device_id` command (`src-tauri/src/device_id.rs`,
wrapped by `getDeviceId()` in `src/lib/sync/device-id.ts`) returns its content
(`dev:<uuid v4>`), creating it on first call by writing a temp file and hard-linking it into
place so an existing file is never overwritten. After the link the parent directory is
fsynced (Unix; skipped elsewhere) before the temp name is removed, so a power loss cannot
lose both names and mint a second id; if that flush fails the call returns an error instead
of pretending the id is safe, and the file it created is kept so a retry reads the same id.
A file that is empty, malformed, or longer than an id is reported as an error and is not
regenerated, because replacing it would orphan the device's identity. The file is not
included in backups, so restoring a backup (see [Recovery](#recovery)) leaves it untouched.
It is the authority for the device id kept in the `sync_identity` row (see
[Multi-device sync sidecar tables](#multi-device-sync-sidecar-tables)); nothing calls
`ensureSyncIdentity` at startup yet.

The live database resolves beneath:

```text
~/Library/Application Support/com.trackdidia.desktop/
```

Backups are not written there. The user picks a destination folder in Settings
(typically a Google Drive for Desktop synced folder). Snapshots go in
`{destination}/backups/` or `{destination}/backups-dev/` so development cannot prune
production files. Older copies under Application Support `backups/` or `backups-dev/`
are left in place and are no longer created.

`TauriSqliteRepository` opens a relative connection string (`sqlite:trackdidia.dev.db`
or `sqlite:trackdidia.db`) through the host `db_connect` command, which resolves it
under `app_data_dir`. `resolve_storage_paths` returns the absolute database path,
connection string, and environment. The backup directory shown in Settings is
computed in TypeScript from `AppSettings.backupDestinationDir` plus the environment
subdirectory.

SQLite may create neighboring `-wal` and `-shm` files. They are normal SQLite WAL
artifacts and must not be treated as disposable while the database is open.

## SQLite connection

The desktop host owns a single-connection sqlx pool (`src-tauri/src/db.rs`) and
exposes it as `db_connect` / `db_execute` / `db_select`. TypeScript still owns
queries and migrations; it does not use `tauri-plugin-sql`.

The native wrapper, transaction helper, and test adapter implement
`src/lib/storage/sqlite-db.ts`. Table mappings in `src/lib/storage/sqlite/rows/`
own their row shape, selected/inserted columns, decoding, and bound values.
Normal task saves and Google Tasks import share the complete task insert; import
uses `ON CONFLICT(id) DO NOTHING`, while saves update the existing row. Legacy
JSON handling and null defaults remain in the corresponding mapper.
Mapper tests cover bound-value round trips and inserts into migrated tables read
through repository queries, so an omitted selected column is checked separately
from the insert mapping.

The pool uses `max_connections(1)`, `min_connections(1)`, `idle_timeout(None)`,
and `max_lifetime(None)`. JS issues `BEGIN IMMEDIATE` / `COMMIT` as separate
commands, so one physical connection must stay open for the process lifetime.
Capping `max_connections` alone is not enough: sqlx can still close that
connection between statements via its idle-timeout or max-lifetime reapers.

Startup also sets `PRAGMA journal_mode=WAL` and `PRAGMA busy_timeout = 5000`.
WAL lets readers proceed during a write. `TauriSqliteRepository.writeTransaction`
acquires the writer queue, runs `BEGIN IMMEDIATE`, and commits when its callback
resolves, including an early return. A callback or commit failure triggers a
best-effort rollback that preserves the primary error. `writeExclusive` names
queue-only operations, so those callers do not interleave with transactions.

Transactional internal writers receive a branded `TxContext`, checked at runtime
for an active callback lifetime. They reuse it rather than entering the writer
queue again. Direct nesting on the same connection is rejected; re-entering the
writer queue remains prohibited and covered by its watchdog. Public weekly/monthly
review, weekly objective, and AI memory saves acquire a transaction before invoking
their internal writer. The migration runner uses the same transaction lifecycle.

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
- Pomodoro sessions and segments;
- AI messages, proposals, and memories;
- standing weekly objectives and per-week manual results;
- the inert multi-device sync foundation: `getSyncStatus()`, `ensureSyncIdentity()`,
  `enableSyncCapture()`, `listSyncChanges()` and `applySyncBundle()` (see
  [Multi-device sync sidecar tables](#multi-device-sync-sidecar-tables),
  [Multi-device sync change capture](#multi-device-sync-change-capture) and
  [Multi-device sync change sets and apply](#multi-device-sync-change-sets-and-apply)).

Repository helpers include `listDailyEntriesOnOrBefore(endDate, limit)` for bounded
history ending at a calendar date, `listDailyEntriesInRange(startDate, endDate)`
(decorated like the other daily reads), `listWeeklyReviewsOverlapping(startDate, endDate)`, and
`listMonthlyReviewsOverlapping(startDate, endDate)` for the Journal timeline, and
the [atomic AI proposal acceptance operation](#atomic-ai-proposal-acceptance)
(`acceptAiProposal`).

The SQLite and memory implementations must remain behaviorally aligned, except for
native-only storage information, backup creation, and multi-device sync (memory reports
`{ supported: false }` from `getSyncStatus` and rejects `ensureSyncIdentity`,
`enableSyncCapture`, `listSyncChanges` and `applySyncBundle`).

## Atomic AI proposal acceptance

`AppRepository.acceptAiProposal(proposalId, effect)` handles memory, weekly
objective, daily entry, goal evaluation, weekly/monthly review, and GTD effects through one decision path. It
loads the proposal by ID, returns the recorded applied ID when already accepted,
applies a new effect, and marks the proposal accepted together. A null effect or a
missing/inactive task or missing goal leaves the proposal pending. Dismissed and
expired proposals cannot apply new effects. Task changes use the current
stored task; a recurring drop resets its template backlog alongside lifecycle
and project reconciliation changes.

SQLite uses the writer transaction. The memory implementation applies its
internal writers synchronously and restores affected maps on failure, so no async
caller can interleave with the effect and decision. Memory remains non-persistent.

## Migration system

The `migrations` array in
[`src/lib/storage/migrations/index.ts`](../src/lib/storage/migrations/index.ts)
is the schema source of truth. Its `runMigrations(db)` runner is called by repository
initialization.

Startup:

1. Open the database.
2. Create `schema_migrations`.
3. Read applied IDs.
4. Execute each unapplied migration in ascending array order, with its ledger
   ID/name/timestamp insert in the same `BEGIN IMMEDIATE` transaction.
5. Commit on success; roll back both schema changes and the ledger on failure.
6. Seed the singleton settings row when absent.

Never renumber or rewrite a released migration. Add the next ID. Tests retain the
IDs, names, and SHA-256 hashes of the first 36 shipped SQL strings.

Column guards live beside migrations 26, 33, and 34 as
`guards.skipIfColumnExists`. The generic resolver checks table columns and skips
only the named `ALTER TABLE` statement when it already exists; repeatable indexes
and normalization statements still run. This lets an older partially applied
database record the migration safely.

`relocateDimancheNotesOnce` remains a settings-marker data normalization after
schema initialization. It changes review content rather than the schema and keeps
its existing idempotent `dimancheNotesRelocatedAt` marker.

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
| 23 | `ai_messages_append_only` | Drop `(surface, scope_key, input_hash)` uniqueness so regenerations append episodes; pending proposal uniqueness per message |
| 24 | `create_ai_memories` | Semantic coach memory (patterns, profile, commitments); pending uniqueness excludes `memory` so weekly distill can store multiple candidates |
| 25 | `ai_proposals_repeatable_weekly_types` | Pending proposal uniqueness excludes repeatable weekly types (`review_section_draft`, `weekly_objective`, `gtd_action`) in addition to `memory` |
| 26 | `add_gtd_task_planned_order` | Adds `gtd_tasks.planned_order`, a partial index on `(project_id, planned_order)` for active Planned rows, and normalizes `planned_order = NULL` for every non-Planned row |
| 27 | `ai_proposals_repeatable_goal_evaluation` | Pending proposal uniqueness also excludes `goal_evaluation`, since a monthly synthesis can propose one evaluation per evaluated goal on the same message; adds a second partial unique index on `(message_id, json_extract(payload_json, '$.goalId'))` so at most one pending `goal_evaluation` proposal can still exist per goal |
| 28 | `add_annual_goal_measurement_fields` | Adds `measurement_type` (default `numeric`), `status` (default `active`), `deadline`, `starting_value`, `direction`, `cadence_target`, `cadence_period` (default `week`), `principle_key`, `progress_log_json` (default `{}`), `milestones_json` (default `[]`) to `annual_goals` |
| 29 | `add_email_triage_foundation` | Adds `source_url` to `gtd_tasks`; creates the (now unused) legacy email triage tables |
| 30 | `add_email_triage_gmail_oauth_client_id` | Adds `gmail_oauth_client_id` to `email_triage_settings` |
| 31 | `add_email_triage_microsoft_oauth_client_id` | Adds `microsoft_oauth_client_id` to `email_triage_settings` |
| 32 | `add_email_triage_desktop_prefs` | Adds `run_in_tray` and `launch_at_login` to the legacy `email_triage_settings` table (the preferences now live in the settings JSON) |
| 33 | `add_weekly_objective_starts_on_week_start_date` | Adds nullable `starts_on_week_start_date` to `weekly_objectives` (null means the objective applies to every week) |
| 34 | `add_weekly_objective_ends_on_week_start_date` | Adds nullable `ends_on_week_start_date` to `weekly_objectives` (last week a manual objective still counts; marking it achieved sets this to the previous Sunday) |
| 35 | `create_rescuetime_snapshot_cache` | Creates `rescuetime_snapshot_cache` (`week_start_date`, `kind`, `credential_fingerprint`, `payload_json`, `fetched_at`; primary key on the first three) |
| 36 | `create_mid_week_decisions` | Creates `mid_week_decisions` (one row per week: decisions text, `decided_on_date`, nullable `lagging_snapshot_json`, `updated_at`) |
| 37 | `add_finance_foundation` | Creates the fourteen `finance_*` tables (people, accounts, categories, transactions, transaction splits, rules, merchant memory, category suggestions, budget entries/months, recurring series, account balance snapshots, import profiles, import batches) and their indexes; inserts the three system categories (`fincat:non-categorise`, `fincat:transfert`, `fincat:split`) |
| 38 | `add_finance_import_profile_separators` | Adds nullable `decimal_separator` / `thousands_separator` columns to `finance_import_profiles` via guarded, idempotent `ALTER TABLE` |
| 39 | `create_finance_alert_notifications` | Creates `finance_alert_notifications` with primary key `(alert_key, notified_on_date)`, the once-per-day-per-key ledger for Phase 7 finance alert notifications |
| 40 | `create_calendar_sync` | Creates `calendar_sync_settings` (singleton `id = 'global'`) and `calendar_sync_links` (composite primary key `(task_id, occurrence_key)`, nullable `event_id`, unique index on `(calendar_id, event_id)`, index on `state`) for the one-way TrackDidia -> Google Calendar sync model, planner, and reconciler |
| 41 | `add_finance_account_update_cadence` | Adds nullable `update_cadence_days` to `finance_accounts` via a guarded, idempotent `ALTER TABLE` (null = default cadence: weekly for on-budget accounts, monthly for the rest) |
| 42 | `add_multi_device_sync_sidecars` | Creates the seven inert `sync_*` sidecar tables and an index on `sync_entity_meta.row_hlc` with `CREATE ... IF NOT EXISTS` only: no `ALTER TABLE`, no data change, no seed rows. See [Multi-device sync sidecar tables](#multi-device-sync-sidecar-tables) |
| 43 | `add_sync_capture_state` | Creates the three device-local change-capture tables `sync_dirty`, `sync_entity_snapshot` and `sync_capture_state` with `CREATE TABLE IF NOT EXISTS` only: no `ALTER TABLE`, no trigger, no data change, no seed rows. See [Multi-device sync change capture](#multi-device-sync-change-capture) |

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

Settings are normalized by `src/domain/settings.ts` on read, which lets newly
introduced settings appear without an immediate JSON backfill. Application writes
use `updateSettings` to read, apply a synchronous updater and persist in one writer
transaction. See [settings storage](ai-settings-and-privacy.md#settings-storage)
for field ownership and form behavior.

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
| Planned queue | `planned_order` (meaningful only for an active, Planned, project-attached row; see [GTD workspace](gtd.md#planned-bucket-project-only-queue)) |
| Provenance | `source`, unique `source_external_id`, nullable `source_url` |

`gtd_tasks` declares no SQL foreign keys; its references are enforced by repository/domain
behavior. Foreign keys that other tables do declare (for example
`weekly_objective_results.objective_id` and `ai_proposals.message_id`, both `ON DELETE CASCADE`)
are enforced: the native host opens SQLite through sqlx, whose connection options turn
`PRAGMA foreign_keys` on by default.

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
historical daily task counts. `AppRepository.listTaskEvents` returns rows ordered
chronologically by `event_at` ascending in both implementations (covered by
`repository.contract.ts`), not by insertion/table order.

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
- `weekly_objectives`: standing objective definitions (`kind`, optional RescueTime mapping, target hours, sort order, optional `starts_on_week_start_date`, optional `ends_on_week_start_date`).
- `weekly_objective_results`: per-week manual achievement (`achieved` 0/1) keyed by `(week_start_date, objective_id)` with `ON DELETE CASCADE` from objectives. Saving a result and updating a manual objective's `ends_on_week_start_date` run in one SQLite transaction.
- `mid_week_decisions`: one row per `week_start_date` with the owner's mid-week decisions, `decided_on_date` (local date of the last save), nullable `lagging_snapshot_json` (the `MidWeekLaggingSnapshot` of the last save whose loads completed) and `updated_at`. The upsert is snapshot-preserving: `lagging_snapshot_json = COALESCE(excluded.lagging_snapshot_json, mid_week_decisions.lagging_snapshot_json)`, so a save without a snapshot keeps the stored one and a snapshot can never be erased. A corrupt snapshot reads as `null`. Included in backups. See [reviews-and-goals.md](reviews-and-goals.md#mid-week-check-mi-semaine).
- `rescuetime_snapshot_cache`: last successful RescueTime pulls per `(week_start_date, kind, credential_fingerprint)`; `kind` is `goals`, `pulse` or `objective_seconds`. Contains goal titles at rest, scoped by a SHA-256 key fingerprint (the API key is never stored here). Included in backups. Contract in [reviews-and-goals.md](reviews-and-goals.md#rescuetime-snapshot-cache).
- `monthly_reviews`: month key/start/end, status, notes JSON, checklist JSON.
- `annual_goals`: target/source/manual value, `measurement_type`/`status`/`deadline`,
  numeric baseline/direction, recurring cadence/principle binding,
  `progress_log_json` (cumulative and recurring period amounts), `milestones_json`
  (ordered checklist, any measurement type), plus evaluations JSON keyed by month.

Computed summaries and goal snapshots are not persisted; they are rebuilt from
daily/review data.

### Calendar sync tables

Migration 40 (`create_calendar_sync`) adds sidecar tables for the one-way,
disabled-by-default TrackDidia -> Google Calendar sync; see
[Calendar sync](calendar-sync.md). No `gtd_tasks` column changes. The schema, pure
planner (`src/lib/calendar/planner.ts`), promotion-capture step, desktop OAuth
connection, and reconciler are implemented. The reconciler mounts only after desktop
startup settles (not in browser preview or the startup fallback). See
[Google Calendar connection](ai-settings-and-privacy.md#google-calendar-connection)
for credentials, failure recovery, cooldowns, and serialized preference/reconciler writes.

- `calendar_sync_settings`: singleton `id = 'global'` for enable flag, OAuth client id,
  connected account/calendar ids, calendar summary, the four dormant columns
  (`default_duration_minutes`, `include_notes`, `mark_busy`, `reminders_enabled`, no v1
  UI), connection `state` (`disconnected` | `active` | `reconnect_required` |
  `needs_confirmation`), and `generation` (the connection's identity epoch: bumped and
  every link cleared when the connected account or calendar id changes; a plain
  disconnect does not bump it, so reconnecting the same account resumes).
- `calendar_sync_links`: one row per calendar-eligible `(task_id, occurrence_key)`
  (`occurrence_key` is the local `YYYY-MM-DD` of `scheduledFor`). `event_id` is
  nullable (`pending` and `failed` links can exist without an event); the unique index
  on `(calendar_id, event_id)` only constrains rows that own one, since SQLite allows
  any number of `NULL`s. `payload_signature` is the canonical event body JSON — it
  doubles as the stored snapshot for `pending` links. `detach_reason` records why a
  terminal link stopped syncing (`promoted` | `completed` | `cancelled` |
  `unscheduled` | `task_deleted` | `missing_remote`). Included in backups; a restored
  stale link is handled by `missing_remote` detachment, calendar recreation on a 404 of
  the calendar itself, and the reconciler's empty-task-set safety valve. The OAuth
  refresh token lives in the OS vault, not in these tables or a backup; see
  [Calendar sync](calendar-sync.md).

Write discipline: the public calendar-sync mutators on `TauriSqliteRepository` go through
the single SQLite writer (settings via `writeTransaction`, so an identity change updates
the row and clears links atomically). Promotion capture runs inside the promotion
transaction and uses the store directly. A synced link whose payload is unchanged is
detached as `promoted` at capture, terminal detachments are never reopened, and a captured
edit on an event that already exists becomes a planner update (not a create).

### Multi-device sync sidecar tables

Migration 42 (`add_multi_device_sync_sidecars`) adds the storage foundation for the planned
multi-laptop sync (design: [`specs/todo/multi-laptop-sync.md`](../specs/todo/multi-laptop-sync.md)).
**Multi-device sync is not shipped.** The tables are created empty on every database and
nothing reads or writes them except the repository methods below and, once a database has
change capture enabled (see [Multi-device sync change capture](#multi-device-sync-change-capture)),
the capture stamper and `applySyncBundle`; no existing table was altered, no setting enables the feature, and users
who never use sync see no behavior change.

| Table | Purpose |
|---|---|
| `sync_entity_meta` | `(entity_type, entity_id)` primary key, `field_clocks_json` (default `'{}'`), `row_hlc` (indexed), nullable `deleted_at` tombstone |
| `sync_identity` | Single row (`id = 1` enforced by `CHECK`): `device_id`, `device_name`, HLC state (`physical_ms`, `counter`), `change_counter`, `last_publish_counter`, and `applying` (the transaction-scoped "merge in progress" switch for later slices) |
| `sync_peers` | Per-peer last manifest, last sync time, and last applied content hash per domain |
| `sync_id_aliases` | `(entity_type, alias_id)` to `canonical_id` with `recorded_hlc` |
| `sync_recurrence_occurrences` | `(template_id, due_date)` outcome with `outcome_hlc` and the producing `device_id`; written by change capture for recurring instances, joined on apply |
| `sync_recurrence_clears` | `template_id` to `cleared_through_date` (a maximum); written by change capture, joined on apply |
| `sync_conflicts` | Detected conflicts and overwritten edits (`local_json`, `remote_json`, resolution) |

Classification lives in `src/lib/sync/registry.ts` (checked against the migrated schema by
`registry.test.ts`). `sync_identity` and `sync_peers` are device-local and never leave the
machine. `sync_recurrence_occurrences` and `sync_recurrence_clears` belong to the `gtd` domain.
`sync_entity_meta`, `sync_id_aliases`, and `sync_conflicts` have no domain of their own: a row
travels only inside the bundle of its `entity_type`'s domain (`sidecarPublishDomain`), so a
personal or finance entity's metadata or conflict copy can never be placed in a `gtd` bundle.
The plain table guards refuse these three tables outright.

`src/lib/sync/clock-store.ts` issues hybrid logical clocks against `sync_identity`
(`issueHlc`, `receiveRemoteHlc`); it must run inside an open write transaction. It rejects a
malformed remote clock and one more than 24 hours ahead of local time before the clock state
is touched, and throws a typed `SyncClockError` when no identity row exists.

Repository surface (both implementations):

- `getSyncStatus()` returns `{ supported: false }` from `MemoryRepository`. On SQLite it
  returns the identity (or `null`), `changeCounter`, `lastPublishCounter`, `pendingChanges`
  (`changeCounter - lastPublishCounter`, never negative), `captureEnabled`, and the peers,
  parsing the peer JSON columns defensively.
- `ensureSyncIdentity({ deviceId, deviceName })` creates the `sync_identity` row inside the
  normal writer transaction. The device-id file is the authority: if the row exists with a
  different `device_id` (a backup restored from another laptop, see [Recovery](#recovery)),
  only `device_id` is rewritten, the HLC state and counters are kept, and the result has
  `repaired: true`. An existing device name changes only when the given one is non-empty and
  different. An id that is not `dev:` plus a lowercase UUID v4 is rejected (the same check the
  native host applies). `MemoryRepository` rejects: sync is unavailable in browser preview.

Sidecar rows are included in backups like any other table; a restored `sync_identity` is
exactly what the repair rule above exists for.

### Multi-device sync change capture

Migration 43 (`add_sync_capture_state`) adds three device-local tables and
`AppRepository.enableSyncCapture()` turns capture on. **Sync and capture are not user-enabled
yet**: nothing in the app calls `enableSyncCapture`, so on every real database the tables stay
empty, no trigger exists, and no write path runs any sync query.

| Table | Purpose |
|---|---|
| `sync_dirty` | `(entity_type, entity_id)` marks of what a statement touched, with `op` `upsert` or `delete`. Written by the capture triggers. Drained inside the same transaction for `writeTransaction` writes, and in a follow-up transaction right after the operation for `writeExclusive` writes; after a failed stamp the marks stay durable until the next write or backfill scan |
| `sync_entity_snapshot` | The last stamped content of an entity: the decoded record for field-clock tables (`snapshot_json`), a content hash for the other classes (`content_hash`), the value for a setting key. Rebuildable; never published |
| `sync_capture_state` | Single row (`id = 1`), present only while capture is enabled: `installed_hash` of the trigger set and `installed_at` |

All three are classified device-local in `src/lib/sync/registry.ts` and never leave the machine.

**Triggers record what, TypeScript computes the clocks.**

- `installSyncCapture` (`src/lib/sync/capture-install.ts`) generates `AFTER INSERT / UPDATE /
  DELETE` triggers named `trg_sync_cap_<table>_ai|au|ad` for every registry table of the
  `gtd`, `personal` and `finance` domains except grow-only-union tables (`gtd_task_events`,
  `ai_messages`: published as full sets by id / dedupe key, no triggers, no meta) and sidecars,
  plus insert/update triggers on `app_settings` for per-key setting capture. The SQL is generated
  from the registry and the live `pragma_table_info`, never written per table, and installation
  fails loudly if the registry primary key differs from the real one.
- Every trigger has `WHEN (SELECT applying FROM sync_identity WHERE id = 1) = 0`, so without an
  identity row nothing is captured and a merge-apply transaction that sets `applying = 1` is not
  captured back (no ping-pong). The body is `INSERT INTO sync_dirty ... ON CONFLICT DO UPDATE` (an
  UPSERT clause: a trigger's own `OR REPLACE` is overridden by an outer upsert), so the last
  operation on an entity wins: a delete after an upsert is `delete`, a re-insert after a delete is
  `upsert`; an update that rewrites the key marks the old key deleted.
- The entity id is the primary key as text for a single-column key and a JSON array of the key
  values (registry order, integers as numbers) for a composite one, built by `entityIdOf`
  (`src/lib/sync/entity-id.ts`) and by the triggers in SQL; a test checks the two agree on
  awkward strings.
- The installed set is identified by a hash of the generated SQL plus the live column lists and
  keys. `ensureSyncCapture` (one query when capture was never enabled) reinstalls when that hash
  differs or when the installed trigger names are not the expected set, which also covers a
  migration that rebuilt a table and silently dropped its triggers. The helper `disableSyncCapture` (no repository method yet)
  drops the triggers, the marks and the state row and keeps clocks and snapshots. The repository runs
  `ensureSyncCapture` at `initialize()` only when `sync_capture_state` already has a row.

**Stamping** (`stampDirtyEntities`, `src/lib/sync/capture-stamp.ts`) reads `sync_dirty` and decides
what really changed. The live row, not the mark's `op`, is the truth, so statement order inside a
transaction does not matter. One clock per stamped entity comes from one read and one write of
`sync_identity` (`createHlcBatch`); `sync_identity.change_counter` grows by the number of stamped
entities.

- Field-clock tables: the row is decoded by column name, compared with the snapshot and
  `buildFieldClockUpdates` stamps only the changed scalars, JSON-map keys (`metrics_json.<key>`,
  `milestones_json.<id>`) and OR-set elements (`context_ids_json.<id>`). Clock keys use database
  column names. `updated_at` is stamped as an ordinary scalar (a save that only bumps it is a
  change; the merge slice must not report an `updated_at`-only difference as a conflict). Other
  `*_json` columns are atomic fields compared by parsed value. A map column whose JSON cannot be
  merged per key is stamped as one atomic field rather than failing the user's save; a field is
  either atomic (one bare clock) or per key (`field.<key>` clocks), never both, so demoting drops
  the per-key clocks, and a later valid shape stamps every current key as an add and drops the
  bare clock (a broken value that becomes an empty map is stamped atomically, so it still counts as
  a change). An update that
  sets identical values, or only reorders an id list, writes nothing and moves no counter.
- Row-clock, monotonic-status, child-set and Pomodoro tables: a content hash (128-bit,
  `src/lib/finance/hash.ts`; `src/lib/hash.ts` is only 32-bit) is compared; when it differs the
  row clock is set to a fresh clock. Rows excluded from publishing by a registry `rowFilter`
  (non-terminal Pomodoro sessions, derived balance snapshots) are still captured and stamped;
  `listSyncChanges` filters them out when it publishes (see below), so a session becomes publishable
  the moment its state changes, with no capture change.
- `finance_transactions` also stamp their categorization unit (`src/lib/sync/capture-finance.ts`;
  [rules](#finance-tables-the-categorization-unit-and-statement-anchors)): the snapshot keeps
  `{"unit": <signature>}` next to the row's content hash, the signature covering the unit columns AND
  every split child (all child columns except `created_at`: re-saving the same splits is not a new
  decision, and `saveTransactionSplits` is a complete no-op when the stored children already equal
  the requested ones, so it neither re-creates the children nor bumps the parent's `updated_at`). A different signature is a unit write: `field_clocks_json` gets
  `categorization` (the fresh clock), `categorization_base` (the unit clock this device held; absent
  for a creation) and `categorization_user` (the clock of the latest `user` decision in the history:
  the write's own clock for a `user` write, inherited otherwise), and `row_hlc` moves with it. An
  edit of any other column moves only `row_hlc`. A child mark re-evaluates its transaction (the
  stamper handles the splits first and adds the parent of every changed child), because a bulk
  update of split categories (`archiveCategory`) touches children only; the children keep
  `{"transaction_id": ...}` in their snapshot so a removed child can still name its parent. A row
  stamped before the unit existed (no unit clocks, no recorded signature) gets its unit clocks
  derived from its row clock, issuing no clock when it is unchanged. When such a row has been
  edited since, the old unit is not recorded, so `unitWrittenWithRow` decides from the row itself
  whether the last write also wrote the unit: `categorized_at` equal to `updated_at`, or a child
  `created_at` equal to it. Those are the stamps left by manual and bulk categorizations, by the
  classification stages and AI auto-apply when they change a non-default category, and by
  `saveTransactionSplits`. A note edit keeps the derived unit and only advances the row clock; a
  categorization is a normal unit write. Known limit: a unit change that sets neither stamp
  (`setTransfer`, `clearTransfer`, removing the last split, `archiveCategory` reassigning a
  transaction's own category, `revertCategoryBackfill`, the transfer-partner unlink done by an
  import undo) on a row left by an earlier build of change capture is read as an edit of another
  column until the next unit write. Only dev databases that enabled capture before this slice can
  hold such rows.
- Deletes write a tombstone (`deleted_at` = `row_hlc` = a fresh clock, field clocks kept) and drop
  the snapshot. An entity that never had a meta row was never published and gets nothing. A row
  that exists again after a tombstone restarts as a creation with clean clocks and clears
  `deleted_at`; every map key or OR-set element of the previous life that the new row no longer
  holds is stamped as a removal at the recreation clock, so an older peer add of it cannot win.
  Three tables deviate on purpose (`deleteBehavior`): a deleted transaction keeps a tombstone with
  EMPTY field clocks (unit clocks mean nothing without the row); a deleted split leaves no tombstone
  and its meta and snapshot are dropped (children live and die with their transaction's unit, which
  carries the whole set); a deleted statement balance snapshot leaves none either (filtered tables
  publish no tombstones, and apply keeps one standing anchor per account).
- `app_settings`: one `setting` entity per synced key; device-scope keys and secrets never get a
  meta row or a snapshot. A key with no snapshot is compared with its default value, so keys left
  at their defaults are never stamped.
- Generators and reads that find nothing to do write nothing, so they leave `sync_dirty`, meta,
  snapshots and the counter untouched.

**Where stamping runs.** `runSqliteTransaction` takes an optional `beforeCommit` hook that runs
after the work and right before `COMMIT`; if it throws, everything rolls back, marks, clocks and
the user's write together. `TauriSqliteRepository.writeTransaction` passes it only while capture
is enabled (a boolean loaded at `initialize()`, set by `enableSyncCapture`). Not every write goes
through `writeTransaction`: the finance store runs its own `BEGIN IMMEDIATE` / `COMMIT` and many
other writers are single autocommit statements. The triggers fire for those too, so `writeExclusive`
stamps the leftover marks in a transaction of its own right after the operation, still inside the
writer slot. A failure there is logged and leaves the marks durable for the next write or scan.
With capture disabled both paths issue no sync query at all.

**Backfill / self-healing scan** (`backfillSyncCapture`) marks and stamps every synced row with no
live meta row, tombstones every live meta row whose row is gone, and re-checks the settings blob;
with `verify` it re-checks every row against its snapshot or hash (needed when capture was off
for a while). It is idempotent: a second run stamps nothing. `enableSyncCapture()` requires an
existing sync identity, installs the triggers and runs the verifying backfill in one
`writeTransaction` and returns `{ installed, backfilled }`. Known limit for the startup slice: a
future migration that rewrites synced rows or rebuilds a synced table should be followed by a
verifying backfill, because the rewritten rows have no marks (a rebuild also drops the triggers
until `ensureSyncCapture` runs).

**Decision record (trigger spike).** Triggers that record marks plus pure TypeScript stamping held
up:

- *Finance import bulk path.* A 1000-row import takes about 300 ms without capture and about
  420 ms with it (in-memory SQLite in the test, categorization unit included), including one extra
  transaction that stamps the 1000 rows in batched statements. The finance store does not use `runSqliteTransaction`, so the
  "stamp right before COMMIT" premise only holds for `writeTransaction`; the post-operation flush in
  `writeExclusive` covers the rest without touching the finance store.
- *Cascades and hard deletes.* `DELETE` triggers fire for every explicit delete (task collapse,
  annual goal and weekly objective delete with its results, import undo, rules, merchant memory),
  and tombstones are written regardless of the code path. Production enforces foreign keys
  (sqlx turns them on by default), and two migrations declare `ON DELETE CASCADE`
  (`weekly_objective_results` -> `weekly_objectives`, `ai_proposals` -> `ai_messages`). SQLite fires
  the child table's DELETE triggers for rows removed by a foreign-key action, so cascaded children
  are marked and tombstoned too; a test with enforcement on checks both cascades.
- *Writer queue and transactions.* Enabling is one writer slot (`…Internal` helpers, no nested
  public call), concurrent writes queue behind it, and a failed stamp rolls the whole
  `writeTransaction` back.
- *Upserts.* `INSERT ... ON CONFLICT DO UPDATE` fires the INSERT trigger for a new row and the
  UPDATE trigger for an existing one; `INSERT OR IGNORE` and `ON CONFLICT DO NOTHING` fire
  nothing. The repository uses no `REPLACE`. With `recursive_triggers` off, `INSERT OR REPLACE`
  fires the INSERT trigger but not the DELETE trigger of a row replaced through another unique
  key; the backfill scan tombstones that victim.
- *Performance.* See the finance import numbers above; stamping 1000 inserted rows in a
  transaction costs about 100 ms, and a write with nothing dirty costs one `SELECT ... LIMIT 1`.

### Multi-device sync change sets and apply

`AppRepository.listSyncChanges(domain)` and `AppRepository.applySyncBundle(domain, changeSet)`
are the read and write halves of multi-laptop sync (design:
[`specs/todo/multi-laptop-sync.md`](../specs/todo/multi-laptop-sync.md)). **Sync is still not
user-enabled**: nothing in the app calls either method (no folder transport, bundle file, setting,
UI or startup step exists yet), and `MemoryRepository` rejects both with the browser-preview error.
Only tests exercise them, through a two-laptop harness (`src/lib/sync/test-support/`) built from
independent `TauriSqliteRepository` instances over real in-memory SQLite.

**Change set** (`src/lib/sync/change-set.ts`): the FULL synced state of one domain, not a log.

```text
SyncChangeSet = {
  formatVersion: 1, deviceId, domain: "gtd" | "personal" | "finance",
  schemaVersion,            // highest applied migration id of the sender
  hlcHigh,                  // an upper bound of every clock carried
  entities:  [{ table, entityId, row | null, fieldClocks, rowHlc, deletedAt | null }],
  unionRows: { <table>: [row, ...] },
  settings:  [{ key, value, rowHlc }],
  recurrence: {             // always present; both lists empty outside the gtd domain
    occurrences: [{ template_id, due_date, outcome, outcome_hlc, device_id }],
    clears:      [{ template_id, cleared_through_date }],
  },
}
```

Rows are keyed by database column name with the raw stored values (JSON columns stay text). An
entity with `row: null` is a tombstone and carries `deletedAt`. A reader ignores columns it does not
have and keeps its own value for columns the row lacks (schema skew). `validateChangeSet` is the
gate every change set passes (typed `SyncChangeSetError`): strict shape, a known `formatVersion`,
every clock a canonical HLC and no larger than `hlcHigh`, entities only from tables of the declared
domain (unknown, device-local and by-entity-type sidecar tables are rejected), canonical and bounded
entity ids, no duplicates, rows whose key columns match the entity id, and settings that are synced,
of the declared domain and not secret. `assertDomainAllowed(domain, allowedDomains)` is the pure
guard the later work-profile slice will call.

`recurrence` carries the two recurrence sidecars of the `gtd` domain (rows keyed by column name, like
every row). They are not entities (no field clocks, no tombstones): they are joins. Validation is
strict: exact keys, a non-empty bounded `template_id`, a real `YYYY-MM-DD` `due_date` /
`cleared_through_date`, an `outcome` of `active`, `completed`, `cancelled` or `missed`, a canonical
`outcome_hlc` (counted by `hlcHigh`), a `dev:<uuid>` `device_id`, no duplicate `(template_id, due_date)`
or `template_id`, and any row in a non-`gtd` change set is rejected (`table_not_in_domain`). The format
version stays 1 (sync is not shipped, so no change set from before this key exists).

**What is merged and what is refused.** `src/lib/sync/merge-strategies.ts` is the seam between the
registry and the engine. This build merges every table of the three bundle domains except the
recurrence sidecars: the `field-clock` tables (the `gtd` ones and the `personal` ones, including
`weekly_objectives` and `weekly_objective_results`), the `grow-only-union` tables (`gtd_task_events`,
`ai_messages`) and all the whole-row (`row_hlc`) tables, each through a rule in
`TABLE_STRATEGY_OVERRIDES` or the generic `generic-row` rule of its merge class: `pomodoro_sessions`,
`pomodoro_segments` and `ai_proposals`
([Pomodoro, AI proposals, objectives and results](#pomodoro-ai-proposals-objectives-and-results)),
`finance_transactions` with their `finance_transaction_splits`, `finance_category_suggestions` and
`finance_account_balance_snapshots` ([Finance tables](#finance-tables-the-categorization-unit-and-statement-anchors)),
and every other row-clock table (the remaining `finance_*` tables and `ai_memories`) as plain
whole-row last-writer-wins. `gtd_tasks` and `recurring_task_templates` are field-clock tables with
their own rules on top ([below](#gtd-task-and-recurring-template-rules)). The recurrence sidecars
travel in `recurrence`, never as entities (an entity of those tables is refused). A table with a
registry `rowFilter` is supported only through a row-clock rule that owns the filter; any table
without a strategy is not published by `listSyncChanges` and makes `applySyncBundle` throw
`SyncApplyError("unsupported_merge_class")` naming the table, for the whole bundle. A registry test
fails if a bundle-domain table is neither supported nor a recurrence sidecar. **Natural-key
canonicalization is not part of this build**: a declared natural key that two laptops fill with
different ids (the same statement imported on both, one account `external_key`, one import-profile
signature, a task `source_external_id`) aborts the bundle with `natural_key_collision`, and the
bundle stays unapplied until the alias engine ships (known state, tested for the finance keys).

**Foreign keys.** Production enforces SQL foreign keys, and apply runs with the capture triggers off,
so a merge that tombstoned a parent would cascade-delete child rows the engine never sees go, and a
child arriving for a deleted parent would abort the whole bundle. The schema declares two foreign
keys, `weekly_objective_results.objective_id -> weekly_objectives` and
`ai_proposals.message_id -> ai_messages` (both `ON DELETE CASCADE`). `src/lib/sync/apply-references.ts`
derives its rules from `PRAGMA foreign_key_list`, never from a per-table list (rules below). The
`referencesMergePending` registry flag is gone; `registry.test.ts` pins the two keys, requires every key
to stay inside one domain, between supported tables, `ON DELETE CASCADE`, on a single-column parent key and declared as
a `foreign-key` reference in the registry, so a migration that adds a key without a rule fails there,
and `ReferenceGuard` refuses (`unsupported_foreign_key`) any other delete action on a parent sync can
delete. The two-laptop test harness runs every scenario with foreign keys on.

**`listSyncChanges(domain)`** runs inside the repository writer slot (so no write transaction can
interleave between its SELECTs), issues only SELECTs and never writes. It returns every live entity
of the supported tables with its `sync_entity_meta` clocks, tombstones, the full row sets of the union
tables and the stamped synced settings of the domain (a key nobody changed has no clock and is not
listed). Tables go through the registry's publish guards, the result is passed through
`validateChangeSet`, and a row without a meta row (never stamped) is not published until
`enableSyncCapture`'s scan stamps it. A table with a registry `rowFilter` is read with the filter as
SQL (`RowFilter.publishWhen` is real SQL, the single source) and its `sync_entity_meta` rows are
published only together with their row; the pure predicate in `row-filter.ts` double-checks the result
(`row-filter.test.ts` runs both over the same rows) and a breach throws instead of leaking. It needs
the sync identity.

**`applySyncBundle(domain, changeSet)`** validates and refuses before taking a writer slot (shape,
domain match with the bundle, unsupported tables, a remote clock malformed or more than 24 hours ahead
of the local clock), requires change capture to be enabled, then runs ONE `writeTransaction` that only
calls internal helpers (never a public repository method, which would re-enter the writer queue). Any
error rolls back every row, meta row, snapshot, conflict and clock change, including a bad row halfway
through. Inside the transaction, in order:

1. Schema gate: a change set from a newer schema than the local one is refused
   (`schema_newer_than_local`).
2. Local capture marks are drained with `stampDirtyEntities` BEFORE `applying` is raised, so a pending
   local edit gets a local clock and its own content first and then competes with the remote value on
   equal terms.
3. `hlcHigh` is absorbed into the local clock (`absorbRemoteHlc`; a no-op when the local state is
   already past it), so every clock issued afterwards is causally after everything applied.
4. `sync_identity.applying = 1`: the capture triggers stay quiet, so merge-applied writes leave no
   `sync_dirty` mark, stamp no local clock and do not touch `change_counter`. The flag is reset to 0
   before COMMIT and is rolled back with everything else on failure.
5. In the `gtd` domain the recurrence sidecars are joined first (`apply-recurrence.ts`).
6. Entities and union rows are applied table by table (registry order, entity id order; `gtd_tasks`
   last, so the project tombstones it consults are applied), reordered so that every foreign-key
   PARENT comes before its children (`ai_messages` before `ai_proposals`, objectives before results),
   then the deletes of parents the bundle removed run last, children first (`ReferenceGuard.flush`);
   the settings are merged, overwritten edits and divergences are logged.

Every applied row also gets its `sync_entity_snapshot` (the row as the capture decoder reads it back
from the database) and `sync_entity_meta`, so the next local edit diffs against the merged state and
only the fields it really changes get new clocks. Re-applying a bundle changes nothing (not even the
clock or the counters) and bundles can arrive in any order and repeat: for the supported classes the
merge is a join, except across a tombstone that is later resurrected (see below).

Rows are written by generic SQL built from `pragma_table_info` (only columns that exist locally, the
primary key never changed), not by the repository's `save*`/`persist*` helpers, because those take
domain objects, normalize them, may stamp `updated_at`, emit task events and reconcile projects; a
merge must store exactly the merged columns. JSON columns keep the repository's compact JSON text; a
per-key, per-id or per-element merge writes its result with sorted object keys, arrays of `{ id }`
items ordered by their `sortOrder` then id, and id lists sorted, so replicas that merged the same
writes store the same text. A column whose merge changes nothing keeps the local text, so two laptops
can hold different formatting or list order for the same state.

Merge rules (`src/lib/sync/merge-entity.ts`, built from the `merge-primitives.ts` joins):

- scalar columns, including atomic `*_json` columns: last writer wins by field clock;
- JSON-map columns (`metrics_json`, `milestones_json`, ...): per key, a removed key is a clock without a
  value. Capture keeps a map field either atomic (one bare clock `metrics_json`, for a value that
  cannot be merged per key or a repaired one) or per key (`metrics_json.<key>` clocks), never both. When
  the two sides disagree about the form, or either holds a bare clock, the field is merged as one
  scalar: the side with the newer field clock wins the whole column and brings its own clocks, the
  other side's clocks for that field are dropped (tombstones keep the newer form's clocks the same
  way). That rule is not associative across three replicas that mix forms; only a corrupt map value
  gets there;
- id lists (`context_ids_json`): OR-set per element. A present element with no clock (a never-stamped
  row) is given a baseline clock, `000000000000000-000000-baseline`: a valid HLC that sorts below every
  real clock, so the element survives every merge except an explicit clocked remove. It is persisted in
  `sync_entity_meta.field_clocks_json` and published to peers like any other clock, and parses as a
  clock of a device named `baseline`;
- whole entity: edit wins over delete. A later delete removes the local row and its snapshot and keeps
  the tombstone meta; a later edit resurrects it; a tombstone for a row never seen is recorded as meta
  only. A tombstone carries no field values, so the merge is a join everywhere except across a
  tombstone that is later resurrected: a delete racing two different editors of the same entity can
  leave the surviving values depending on arrival order, because the resurrected row holds the
  incoming side's values only. The loss is logged, not silent: on a resurrection, every field, key or
  element for which the tombstone held a newer clock than the incoming entity is recorded as an
  overwritten edit whose local value is unknown. Every map key or id-list element that the
  tombstone held and the surviving row omits also gets a removal clock equal to the tombstone's
  `deletedAt`, copied from the data (never issued locally) and kept if the incoming clocks already
  hold a later removal; without it an older replica that still holds the id would add it back,
  because a missing clock is not a removal. A later add by anyone still beats it, keys the tombstone
  never had get nothing, and an atomic field (a bare clock on either side, or a value that cannot be
  merged per key) has no per-key removals to date. The same removals are dated when a live row meets
  an older tombstone, so every arrival order gives the same clocks as long as the tombstone reaches
  a replica before both live versions have merged; once two live versions merged without it, the
  tombstone cannot tell an omitted id from a kept one and the id stays (the residual non-join). Open
  item for a later slice: tombstones should carry the last field values (in the change set and in the
  local meta), which would make resurrection a join too;
- grow-only-union tables: `INSERT ... ON CONFLICT DO NOTHING`, never an update, so a collision on
  `dedupe_key` keeps the first row;
- whole-row (`row_hlc`) tables: see [Pomodoro, AI proposals, objectives and results](#pomodoro-ai-proposals-objectives-and-results) and [Finance tables](#finance-tables-the-categorization-unit-and-statement-anchors);
- settings: per key by the settings registry rule (`lww` by key clock, `monotonic-max`,
  `non-empty-wins` by value), written through the same settings writer as `updateSettings` so device keys
  are untouched. Secrets, device-scoped keys, unknown keys and keys of another domain are rejected by
  validation and re-checked by the apply step (`setting_not_syncable`).

A unique-key violation aborts the whole bundle with a `SyncApplyError` naming the table and the index:
`natural_key_collision` for a key the registry declares (canonical identity and aliasing come in a
later slice), `unique_violation` for any other. Any other SQL error is `sql_error`. Nothing is skipped
silently.

**Overwritten-edit log.** When a merge replaces a local value with a remote one, and the sender cannot
be shown to have seen the local value, a `sync_conflicts` row (`kind = 'overwritten_edit'`) is inserted
with the local and remote value and clock of that field or map key (`updated_at` and `created_at` are
never reported; a local side recorded as `"unknown": true` carries a clock only, see resurrection above). The id is derived from the entity, the field and both clocks, so applying the same
state again never duplicates it. Clocks alone cannot prove two edits were concurrent, so this is an
informational "may have overwritten" log: the sender "had seen" the local value when its entity carries
a clock of the same author at or after the local clock, which is how an ordinary later edit by a peer
that had synced is told apart. A peer that has overwritten every field of an entity leaves no such
evidence and is logged as possibly concurrent. Only the device whose value was replaced logs it; a
value that merely loses to a newer local one is not an overwrite. Overwritten setting values are not
logged (a setting entry carries no evidence of what the sender had seen).

#### Pomodoro, AI proposals, objectives and results

These tables were refused until the references slice; each now has a convergent rule. Sync is still
not user-enabled.

**Row-clock merge** (`merge-row.ts`, pure; `apply-rows.ts` is the glue). Capture stamps these tables as
a whole row (one `row_hlc`, a content hash, no field clocks), so the merge is whole-row: the state of
an entity is a live version (row and clock) or a tombstone, and the greatest state of a total order
wins, which makes the merge a join over one entity's live states: the later clock wins; an edit with a
clock equal to a delete's keeps the row (edit wins over delete); between two live versions a
table rule may rank first (terminal status), then the later clock, then the smaller canonical JSON.
The winner brings all its columns; a column the sender lacks keeps its local value. It is not a join in
every case: a tombstone carries no row, so (as for field-clock tables) resurrection is not a join, and a
joined column (a segment's `ended_at`) is lost when a tombstone sits between two versions, so three
versions are not guaranteed to give one result in one pass in every order. In both cases replicas
converge once they exchange. The stored snapshot is the
content hash of the row as the stamper decodes it, so a verifying scan restamps nothing.

**Pomodoro** (`merge-pomodoro.ts`, `row-filter.ts`). Only TERMINAL sessions (`completed`, `cancelled`)
and the segments of a terminal session are published or accepted; a running or paused timer belongs to
the laptop it runs on and never leaves it, and neither do its segments or their metadata.

- Publishing is a function of the row's current state, not of when it was last stamped: the change
  set is the full state, so the first publish after a session completes carries it and every one of
  its segments although their clocks are older. Running or paused sessions keep being stamped
  locally (capture is unchanged) and simply are not read.
- Tombstones of Pomodoro rows are NOT published. A tombstone has no row, so nothing proves the row was
  ever terminal, and publishing it could reveal that a timer's segment existed; the private side is
  chosen. No product path deletes a terminal session or a segment of one (the only delete site removes
  a placeholder segment of a running or paused session), so nothing is lost today; a future
  delete-history feature must carry the session id in the tombstone first. Applying a tombstone from
  a peer is supported (edit wins over delete by clock) and tested with hand-built bundles.
- Applying: a bundle row for a non-terminal session, or a segment of a session the bundle carries as
  non-terminal or deleted, is refused for the whole bundle with `row_filter_violation` (checked before
  a writer slot is taken). A segment whose session is neither in the bundle nor a terminal session here
  is refused the same way; one whose session the bundle carries but this laptop deleted (its delete is
  later) is skipped with an informational `orphaned_child` conflict, so one laptop's delete never makes
  every later bundle from the other fail.
- A LOCAL running or paused timer is never touched: an incoming session with its id, a segment of it,
  or a delete of either aborts the bundle with `local_timer_conflict` (impossible between honest
  peers). Pulling the other laptop's completed sessions never changes the local session itself
  (`getPomodoroState().activeSession` stays the local one, given consistent clocks, see the last bullet) and counts toward the day: `computeDailyPomodoroStats` and the suggested `pomodoris` metric read all
  sessions.
- Two versions of one terminal session or segment (only a hand edit or a bug produces them): whole-row
  last-writer-wins; the loser's device logs an `overwritten_edit` with `field = "(row)"` (the whole
  row) when the replaced version carried a clock issued by that device (a version that had itself
  arrived from the peer and is replaced by that peer's later edit is ordinary propagation and is not
  logged; this holds for every whole-row rule, see the next section). A segment's `ended_at` is joined across both versions instead: non-null beats null, and two
  different ends keep the later timestamp, so the result does not depend on which version is newer.
  Delete against edit follows the clocks; because deletes are not published, a delete on one laptop
  never reaches the other: if the delete is later the session stays deleted only on the laptop that
  deleted it (known limit, no product path).
- Known limit, wall-clock skew: remote sessions feed the local cycle and idle-reset logic
  (`buildPomodoroState` / `shouldResetPomodoroCycleAfterIdle` in `engine.ts` read every session). With
  a laptop whose wall clock is far from the other's, a remote session can look like activity in the
  future or past and trigger an idle reset, so a live local break can be auto-completed
  (`completeExpiredPomodoroSessionsInternal`). A running focus is not affected (a live focus is never
  reset). The timer rows themselves are never modified by a pull.

**AI proposals** (`merge-proposal.ts`, `apply-proposals.ts`). Rows are whole-row too.

- A terminal status (`accepted`, `dismissed`, `expired`) beats `pending` whatever the clocks say, and
  brings its whole row (`decided_at` and `applied_entity_id` describe that decision). Two different
  terminals keep the smaller status (`mergeTerminalBeatsPending`: `accepted` before `dismissed` before
  `expired`) and write an unresolved `terminal_divergence` conflict (`entity_type = 'ai_proposals'`)
  with an id derived from the proposal alone. The replica that first meets both rows logs it (usually
  the one that adopts the winner); the other learns of it when conflicts travel, in a later slice.
  The same status on both sides, or two pending rows: the later clock.
- The registry's two partial unique indexes allow one pending proposal per message and type (and per
  message and goal for `goal_evaluation`). Two pending proposals for one key created on two laptops are
  resolved without the alias engine: among the incoming row and every stored pending row that shares a
  declared pending key (found with the index's own `where` and key expressions from the registry), the
  later row clock (then the greater id) keeps `pending`; every other one is stored as `expired`
  (same id, same clock, every other column kept) and a `pending_collision` conflict (informational,
  deterministic id) records it. It is stored, not dropped, so every replica holds the same rows, and
  because terminal beats pending a replica that still holds the loser as pending converges to
  `expired` whichever order things arrive in. The bundle never aborts for this; any OTHER unique
  violation still does (`natural_key_collision` / `unique_violation`).
- `ai_messages` is a grow-only union table applied BEFORE `ai_proposals` in the same bundle. A proposal
  whose message is not here is skipped (nothing written, `orphaned_child` conflict) without aborting the
  bundle, and a later bundle that brings the message applies it; re-applying is a no-op. JSON payload
  references (`payload_json.taskId`, `goalId`) are left as they are until the alias slice.
- Within one bundle, decided (terminal) proposals are applied before deletes and before pending ones,
  so a replica that holds P1 pending and receives {P1 accepted, P2 pending} never expires anything
  against a P1 that is about to stop being pending; a replica without P1 ends in the same state.
- Deletes. No current code path deletes a synced proposal: `clearPendingAiProposals` has no callers, and
  `saveCoachPulseEpisode` only deletes pending rows of the message it has just inserted. The merge still
  handles tombstones: a pending proposal follows the clocks (a later delete removes it everywhere, a
  later edit keeps it), and every terminal proposal (`accepted`, `dismissed`, `expired`) beats any tombstone whatever the clocks
  (`survivesDelete`), because the app only ever deletes pending rows, so a delete racing a decision means
  the deleter had not seen it. A row the engine itself expired for a pending collision is terminal too, so
  it also survives a later delete of the pending row it came from; whether a replica derived it before or
  after the delete arrived can differ in a single pass, and replicas agree exactly once they exchange.

**Objectives and results** (field-clock, `weekly_objective_results` is `ON DELETE CASCADE` of
`weekly_objectives`; `apply-references.ts`). Merged per field like the other personal tables, plus:

- Parents are applied before children; deletes of parents run after every table was applied (so
  children are deleted first). The parent row a bundle deletes stays until then.
- Parent tombstone wins, local children exist: the apply deletes the children itself and writes their
  tombstone meta in the same transaction (`deleted_at = row_hlc` = the parent's `deletedAt` when that is
  later than every clock the child retains, otherwise a clock issued by the APPLYING device; field clocks
  kept, snapshot dropped). Capture-off cascades therefore never leave "live meta, no row".
- A child edit that arrives for a parent that is deleted (here, or in this bundle) is not inserted: the
  child ends as a tombstone STRICTLY later than its own newest edit (an equal clock would keep the
  edit): the latest delete the child or its parent already has when that is later than the edit,
  otherwise a clock issued by the applying device, and an `orphaned_child` conflict (informational, one per child) records the
  discarded row. "Edit wins over delete" applies to the PARENT: a parent edit later than its delete
  resurrects it, and children whose own edit is later than their tombstone come back with it. A
  child whose parent was never heard of is skipped (nothing written, `orphaned_child`) and applied by the
  bundle that brings the parent. A child listed before its parent in a bundle is fine.
- The tombstone clocks the apply invents are never derived from another device's clock (for example
  "the child author's counter + 1", a value that author issues itself next and that would tie with its
  own edit). They are drawn from the applying device's clock store inside the apply transaction, after
  the bundle's clock was absorbed, so they are unique to that device and later than everything in the
  bundle; only `sync_identity`'s clock state moves (no dirty mark, no `change_counter`), and nothing is
  issued when a delete that outranks the edit already exists, so re-applying a bundle changes nothing.
  Consequence: replicas that each had to invent the tombstone of the same child hold different, all
  valid, clocks until they exchange; tombstone against tombstone keeps the later, so they converge
  (`references.convergence.test.ts` and `classes.convergence.test.ts` compare tombstone clocks masked in
  one pass and exactly after the exchange).
- Known limit: an invented tombstone (the forced one for a child edit that arrives for a deleted parent,
  or the cascade tombstone of a child edited after the parent's delete) is dated at the APPLYING
  device's clock when it applies. Every concurrent child edit dated before that tombstone is lost once
  the parent comes back (a later parent edit resurrects it, and the child tombstone outranks the older
  edit), including edits made after the parent's delete that this device never applied inside the
  window, and wall-clock skew on the applying device widens this. The replicas that applied the child
  edit while the parent was gone drop it; the others keep it until they hear the tombstone, which then
  wins everywhere. It can happen with just two laptops (A deletes the objective; B edits a result and A
  applies that bundle; B then edits the objective and A applies the new bundle: the result was dropped
  while the objective was gone). Deleting an objective is rare and results are small, so this was
  accepted (the dating rule is deliberate) rather than carrying orphaned child values.
- What the fresh clock fixes. An earlier version dated these tombstones as "the child author's newest
  clock + 1 counter". The scenario a review described for it (a child that survives its deleted parent
  forever) does not reproduce: foreign keys are enforced and the forced-orphan rule tombstones any
  child whose parent is gone, so such a child cannot stay. The real flaw was a duplicate clock: the
  invented tombstone could equal a clock the child's author issues itself next, and an equal clock ties
  with that edit. The tombstone is now drawn from the applying device's own clock store.

#### Finance tables, the categorization unit and statement anchors

All finance tables and `ai_memories` are merged now (they were refused until this slice). Sync is
still not user-enabled. Pure rules: `src/lib/sync/merge-finance.ts`; glue: `apply-finance.ts`
(transactions, splits, anchors), `apply-rows.ts` (everything else) and `apply-proposals.ts`
(pending suggestions); capture: `capture-finance.ts`.

**Plain rows** (`finance_people`, `_accounts`, `_categories`, `_rules`, `_merchant_memory`,
`_budget_entries`, `_budget_months`, `_recurring_series`, `_import_profiles`, `_import_batches`,
`ai_memories`; rule `generic-row`): whole-row last-writer-wins by row clock, the row's clock then its
smaller canonical JSON; edit wins over delete (a delete wins only with a strictly later clock); the
replica whose OWN value was replaced logs an `overwritten_edit` with `field = "(row)"`; the one that
keeps its value, and a receiver whose replaced version had itself come from a peer (a rename, a rule
counter bump, any ordinary propagated edit), log nothing: `merge-row.ts` reports an overwrite only
when the replaced row clock was issued by the applying device (the device id of the HLC against
`sync_identity`), otherwise whole-row last-writer-wins plus the flag would add a conflict row for
every propagated edit (`created_at` and `updated_at` alone are never a conflict, so two laptops that seeded the
same default categories do not conflict). Consequences worth knowing: counters that change on every
classification (`finance_rules.applied_count`, merchant-memory hit counts) merge with the whole row,
so a concurrent edit of the same row on the other laptop can lose one of the two; the rule and memory
JSON columns (`matcher_json`, `actions_json`) are carried verbatim, the account, person and category
ids inside them are declared in the registry but not rewritten until canonical identity ships.
`finance_recurring_series` has no natural key: two laptops that detect the same series independently
hold two rows after a merge (unconfirmed ones are removed by the next detection run).

**Import undo.** `undoFinanceImportBatch` hard-deletes the batch's non-`user` transactions (with their
splits and suggestions) and never touches the batch row, so a batch is not marked undone and its
counts stay as the import wrote them on every laptop. The deletes are ordinary tombstones: a
categorization of the same transaction on the other laptop whose clock is at least as late as the
undo resurrects the transaction (with its categorization and splits) on both laptops, one with an
earlier clock loses to the undo. The batch row is still the latest batch and still `completed`, so
the batch can be undone again, but only a row that is not `user`-categorized can be removed that way:
a row brought back by a rule, a reclassify, a note or any other edit is deleted by the second undo,
while a row brought back by a MANUAL categorization stays, because undo deliberately refuses
`user`-categorized rows (`refusedUserCategorized`) and the finance store has no other transaction
delete. That is the user's explicit choice (a manual categorization after an undo says "keep this
one"); the spec's "recoverable by undoing again" holds only for the non-`user` case. Both cases are
pinned in `finance-sync.scenarios.test.ts`.

**Categorization unit** (`finance_transactions` + `finance_transaction_splits`). The unit is
`{category_id, category_source, has_splits}`, the two descriptive columns the same decision writes
(`category_confidence`, `categorized_at`; a deliberate extension of the spec so a row never shows the
confidence of another decision) and every split child. Encoding, in the transaction's
`sync_entity_meta.field_clocks_json`: `categorization` (the clock `c` of the write),
`categorization_base` (`base_hlc`: the unit clock the capturing device held, absent for a creation)
and `categorization_user` (`p`: the clock of the latest `user` decision in the write's history).
Every other column keeps the row clock.

- *Order.* Units compare by `(p, c)`, then by the smaller canonical payload JSON: a total order, so the
  merge is a max and replicas converge in any arrival order (a randomized 3-replica test applies every
  permutation, grouping and repetition). A `user` write has `p = c`; an automatic write (`rule`,
  `memory`, `seed`, `ai`, `default`) inherits the `p` of the unit it replaced. Hence: a write that saw
  another (the device holds the maximum of everything it merged) wins even when it is automatic, which
  is the spec's example (B categorizes with splits as `user`; A receives it and removes the last
  split, which resets the parent to `default`; A's reset inherits B's `p` and has a later `c`, so it
  wins and B's old children are not restored when B republishes an unrelated edit); a peer
  republishing an unchanged row carries its old unit clocks and loses to any later write; of two
  concurrent writes a `user` one beats an automatic one whatever the clocks, and of two concurrent
  `user` writes the later HLC wins. The spec's pairwise wording ("if one write's `base_hlc` is at or
  after the other's clock it saw it and wins, otherwise compare sources") is not used as the order
  itself because it is not transitive: with a `user` write Y, an automatic X that saw Y and a later
  automatic Z that saw neither, X beats Y, Y beats Z and Z beats X, so the result would depend on the
  order the writes arrive in. `categorization_user` carries the same intent transitively. It differs
  from the pairwise rule only when `base >= c` numerically without the writer having seen the other
  write (a laggy laptop's older `user` decision still beats a newer automatic stage that never saw
  it).
- *Row versus unit.* The row winner (row clock) brings the non-unit columns; the unit winner brings
  the five unit columns and its clocks; the two may differ (an unrelated edit on one laptop and a
  categorization on the other both survive). The stored meta keeps the row winner's `row_hlc` and the
  unit winner's unit clocks.
- *Children travel with the unit as a set.* After the transaction merge, the unit winner decides the
  children: a remote winner (or a freshly inserted transaction) replaces the local set by the bundle's
  live children of that transaction (rows, meta with the child's own `row_hlc`, snapshot; local
  children the bundle does not carry are deleted with their meta, no tombstone); a local winner or the
  same write keeps the local set and ignores the bundle's children; a deleted transaction keeps none.
  Two sets are never mixed. A split whose transaction the bundle does not name is skipped with an
  informational `orphaned_child` conflict and never aborts the bundle (the bundle that brings its
  transaction brings it again). A split tombstone from a bundle is ignored.
- *Conflict log.* When a remote unit replaces a local `user` decision that the remote write had not
  seen (`categorization_base` before the local clock), the content differs and the local decision was
  issued by this device, the replaced replica logs an `overwritten_edit` with `field = "categorization"` (the payload and the splits of each
  side). An ordinary later edit by a peer that had synced, and an automatic value that lost, are not
  logged.
- *Re-categorization by the app keeps working*: the import pipeline (rules, memory, seeds, transfers),
  `reclassifyFinancePending`, AI results and `saveTransactionSplits` all write through the same
  columns and are stamped by the diff. One store change makes that cheap and safe: a classification
  pass that decides exactly what a row already says no longer writes it (no `updated_at` bump) and no
  longer bumps the matching rule's `applied_count` / `last_applied_at` (both stores, same behavior),
  so a re-run of the rules with nothing new stamps nothing and cannot win over a concurrent edit of
  another column on the other laptop. A pass that does change a row still rewrites it whole.
- *Not a join across a tombstone that is later resurrected*, like every row-clock merge: replicas
  converge once they exchange.

**Category suggestions** (`finance_category_suggestions`, monotonic status; same machinery as AI
proposals). A decided suggestion (`accepted`, `corrected`, `dismissed`, or `expired` by a collision)
beats `pending` whatever the clocks and beats any tombstone (the app only deletes pending
suggestions when a transaction is categorized, so a delete racing a decision means the deleter had not
seen it; the suggestions of a transaction removed by an import undo can therefore survive on a laptop
that decided them, harmlessly: decided suggestions are only read as dismissal memory by merchant and
category, never joined to their transaction). Two different decisions keep the smaller status
(`accepted` < `corrected` < `dismissed` < `expired`) and write an unresolved `terminal_divergence`
conflict, except that a user decision silently beats an engine `expired`. Two pending suggestions for
one transaction (the partial unique index `uniq_finance_suggestion_pending`) are resolved without the
alias engine: the later row clock (then the greater id) stays `pending`, the other is stored as
`expired` (a status the app itself never writes and the TypeScript type does not list; consumers read
`pending` and `dismissed` only) with an informational `pending_collision` conflict; the bundle never
aborts for it. Decided suggestions are applied before pending ones within a bundle. Known limit:
the expiry is sticky, so if the contender that took the slot is later decided or deleted on another
laptop, a replica that resolved the collision first holds `expired` where one that heard of the
decision first holds `pending`; they agree as soon as they exchange (the terminal status spreads). A
suggestion whose transaction has not arrived is stored (there is no foreign key) and fills in later.
Two more consequences of the sticky `expired`: it survives every delete (it is a decided status), and
rows can accumulate when several laptops each create a memory or rule suggestion for the same
transaction during a reclassify (one stays `pending`, each other one becomes an `expired` row that
is never removed). The randomized convergence tests (`classes.convergence.test.ts`,
`finance.convergence.test.ts`) are deterministic only for their committed seeds: ids are random UUIDs
and finance timestamps use the real clock, and the order dependence of a sticky `expired` makes
roughly 1-2% of other seeds fail a one-pass comparison (always healed by an exchange).

**Statement balance snapshots** (`finance_account_balance_snapshots`, `rowFilter` `source =
'statement'`). Only statement snapshots are published or accepted; `derived` rows (rebuilt by the daily
job) and their metadata never leave the machine, and a bundle row with another `source` aborts the
bundle (`row_filter_violation`, checked before a writer slot is taken; `manual` is declared by the
TypeScript type but nothing writes it). No tombstones are published or kept for this table. A
statement row beats a `derived` row at the same key whatever the clocks (the daily job never
overwrites a statement either). The statement import keeps ONE standing anchor per account (it deletes
the previous one) and re-bases `finance_accounts.opening_balance_minor`; because that delete is never
published, apply keeps, per account, the anchor with the later row clock (then the later statement
date): an incoming anchor that a local one beats is not stored, one that beats the local ones replaces
them with their meta and snapshot. Interplay with the account row: the re-based opening balance
travels in the `finance_accounts` row (whole-row last-writer-wins) and the anchor in its own row; the
merge does not recompute the opening balance, so after a merge that brings transactions dated before
the statement date from the other laptop the displayed balance on that date is off by their sum until
the next transaction write, import, undo or statement on either laptop re-anchors with the merged
set (`reanchorStatementAccounts`); this is the same "merge runs no domain side effect" rule as the
Planned-queue repair for tasks.

**Settings.** The finance-domain keys merge through the settings path (`updateSettings` stamps them
under `entity_type = 'setting'`) and travel only in the finance bundle.

**Privacy.** Finance and personal tables never appear in a `gtd` change set and are refused when a
`gtd` change set names them (`table_not_in_domain`, also for a finance bundle relabeled `gtd`);
`finance_alert_notifications`, derived snapshots and every secret never leave the machine; the tests in
`finance-privacy.test.ts` replay all of this with a gtd-only replica whose database ends with no
finance or personal row and no sidecar row of such an entity.

#### GTD task and recurring template rules

`gtd_tasks` and `recurring_task_templates` keep the generic per-field / OR-set merge for everything
that is not lifecycle (`title`, `notes`, `context_ids_json`, `deadline`, ...) and replace it for the
lifecycle (`src/lib/sync/merge-task.ts`; glue in `apply-gtd.ts`). The rules are pure and order
independent (`merge-task.test.ts` checks commutativity, idempotence and three-way associativity over
random states).

- **Lifecycle tuple.** `{status, bucket, completed_at, scheduled_for, planned_order, project_id}` merges as
  ONE unit; its clock is the newest clock of any member and the winner's member clocks (not a maximum)
  are kept. `project_id` is in the unit although the mobile spec lists it as an independent field: a
  planned task's order only means something inside its project, and with `project_id` merged on its
  own the "planned task lost its project" demotion fires in one merge order and not in another. The cost: a
  project re-filing racing a bucket change competes with it as a whole (the loser is logged). Order of
  the unit: (1) a terminal tuple (`completed`/`cancelled`) beats an active one whatever the clocks (terminal
  is absorbing: nothing in the app reopens a task), (2) the later tuple clock, (3) the smaller canonical
  JSON. The device whose bucket/schedule move lost logs an `overwritten_edit` with `field = "lifecycle"`
  (both tuples). A planned-order change alone, and two completions of the same task, are never logged.
- **Complete against cancel.** The later decision (tuple clock) is the provisional winner, the same on
  every replica, and `completed_at` is the winner's (a cancelled task has none). Each device also writes
  a `sync_conflicts` row `kind = 'terminal_divergence'` (`entity_type = 'gtd_tasks'`) with both tuples,
  unresolved. Its id is derived from the task alone (and the due date for an occurrence), so re-applying,
  republishing, or resolving later never creates a second one. Resolving it is UI (a later slice); a
  resolution must write a newer tuple.
- **Normalization.** After the merge the row gets the save-time invariants of the app, as a pure function
  of the merged row so every replica agrees; it writes no clock and is re-derived by every merge: an
  active `planned` task needs a `project_id` that is not known to be deleted (a tombstone in
  `sync_entity_meta`; a project that has not arrived yet is NOT gone), else it is demoted as the desktop
  does (`next_action`, no scheduled date, no order); an active `scheduled` task needs `scheduled_for`,
  else `next_action`; `planned_order` exists only in the `planned` bucket. A completed planned task keeps
  its order, as on the desktop (`adjustPlannedFieldsForSave` retains it).
- **Planned queue.** Tasks merge one by one, so two laptops that reordered (or both appended) can leave
  duplicate `planned_order` values. When a project's active queue has a duplicate or missing order, the whole
  queue is renumbered `0..n-1` with `compactPlannedOrders` (same function and tie rules as the desktop),
  in memory before anything is written, so a re-applied bundle writes nothing. Gaps are left alone.
  Renumbering writes orders without a clock, so it is not a join: replicas that repaired different
  intermediate states can hold different orders until the next exchange, which resolves the tie by the
  smaller tuple and repairs again. The order is cosmetic; no edit is lost.
- **Recurring instances** (`is_recurring_instance = 1`, id `recurring-task:<templateId>`, advanced in
  place). `recurrence_due_date`, the lifecycle tuple and `pending_past_recurrences` are scoped to an
  occurrence and RECOMPUTED after the occurrences merged, never merged: the due date is the latest
  occurrence; the tuple comes from the row(s) at that epoch whose status agrees with the merged outcome
  (a row from an older epoch contributes no lifecycle); the backlog is the number of `missed`
  occurrences after `cleared_through_date`. Title, notes, contexts and project merge per field. A
  template touched by the bundle's sidecars is recomputed even when the bundle carries no entity for it.
- **Occurrences** (`recurrence-occurrences.ts`). Per `(template_id, due_date)` a record has an outcome
  `active`, `missed`, `completed` or `cancelled`. Join: a user outcome beats `missed`, which beats `active`,
  whatever the clocks; then the later `outcome_hlc`; at an exact tie `completed`, then the larger device
  id. Complete against cancel is the same provisional-winner-plus-`terminal_divergence` rule. The clear
  watermark is a plain maximum.
- **Template.** Generic per field, except `last_generated_for_date`, which is the latest occurrence
  (when the template has any). `pending_missed_occurrences` stays a per-field value: it is a write-only
  mirror nothing reads.

Capture of the sidecars (`capture-recurrence.ts`, called by the stamper inside the same transaction,
derived from the snapshot diff of the instance row, not from the generators; the sidecars have no capture
triggers, so nothing is marked dirty and `change_counter` still grows once per stamped entity): a new
instance records its due date with the outcome its status shows, and an existing backlog of N as the N
due dates of the template's schedule before it, `missed`; a due date that moves forward `D1 -> D2` records
`D1` as `completed`/`cancelled` (if the row was in that state), then marks `missed` the passed-over dates
(`D1` itself when it was still active, plus every due date of the template strictly between them;
generation collapses a gap into one instance), bounded by the row's own backlog growth (see the limits
below), and `D2` as `active`;
leaving a terminal state also moves the clear watermark to `D1` (the desktop forgets the older backlog
when it generates the next instance). A due date that moves backwards (an early generation pulled back)
records only the new date. Same due date: a status that turns terminal records the outcome; a backlog that
goes from `N > 0` to `0` moves the watermark to the latest known `missed` date. Writes are joins, so an
unchanged outcome is not rewritten. `backfillSyncCapture` also records the baseline for instances that
have no record (stamped before the sidecars existed), once, bumping `change_counter` by one.

Time zones. Generation reads the device's local day, so a laptop whose day is behind another's sees
an instance the other one generated as "from the future". `prepareRecurringGeneration` then either pulls
it back to an earlier due date or, when there is none (the first occurrence), cancels the row and clears
the template's `last_generated_for_date`. That cancellation is bookkeeping, not a decision. Capture
recognizes it by its signature, a `cancelled` instance whose template watermark is cleared. The watermark
alone is not proof, because it is also `null` after a STALE editor (a template card loaded before the
template's first generation) saves the template with the `lastGeneratedForDate: null` it holds; pause /
resume and a fresh card keep it, and a user's own cancel leaves it set. So the two evidences are used
where they are sound: the stamp of a status that has just turned `cancelled` must also be due AFTER the
capturing laptop's local today (`getTodayDate()`, the generator's own source; branch 1 only runs then),
so a user's cancel of an instance that is due today or earlier is always recorded; residue already in a
snapshot or a row (a first stamp, the baseline pass, the forward advance below) is decided by the cleared
watermark alone, on, before or after its due date. A user CAN cancel a future-dated instance that reached
a lagging laptop through a merge; combined with a stale-editor null watermark that rare case is dropped
as a pull-back, and so is a user's cancel first seen by the stamper or the baseline pass while the
watermark is null (documented limits). A dropped or detected pull-back records no outcome and no clear.
When that laptop's generator later builds the next instance on the same row id,
the stamp sees a `cancelled` snapshot whose occurrence was left `active` or unrecorded: the date is
passed over (`missed`, counted in the backlog) like any active one, never upgraded to a user cancel.
The recorded occurrence stays `active` (or whatever a peer recorded, such as a completion), and the
merge trusts a recorded occurrence over a row's own status (a row's status only stands in when no record
exists), so a cancelled residue row is outvoted and every laptop ends with the occurrence it should. A
pull-back to an EARLIER due date is not undone the same way: the occurrence of the later date stays
`active`, so every merge restores the later date on the lagging laptop and its next generation pass
pulls it back again, until its local day catches up. That churn rewrites the row each sync (cosmetic),
and used to append a task event every time. `buildLifecycleEvents` now gives the events of a recurring
instance whose due date moved backwards a stable `dedupe_key`
(`<type>:pullback:<taskId>:<dueDate>`), so the first pull-back records its one event exactly as before
and the repeats are dropped by `persistEvents`' existing `ON CONFLICT(dedupe_key) DO NOTHING` (also in
the union apply). This touches product code that exists independent of sync
(`src/lib/gtd/engine.ts`); behavior for every other write is unchanged.

Other known limits:
- An advance records as `missed` only as many of the passed-over due dates as the row's own
  `pending_past_recurrences` grew (moving on from a completed or cancelled occurrence counts the whole new
  backlog), the latest ones first. Several advances collapsed into one stamp (capture disabled for a while,
  a failed flush) therefore cannot record an occurrence the user completed in between as missed; the dates
  before are simply not recorded. A gap longer than 3660 days is not expanded.
- The occurrence sidecars grow by about 365 rows a year per daily template, and the whole set travels in
  every `gtd` bundle; the size is to be measured in the transport slices.
- Merging does not run `reconcileProjectPlannedTasks` (the desktop's "promote the first planned task when a
  project has no next action"), so a merged project can sit without a next action until the next local
  mutation of that project.

Sync must still not be user-enabled before the remaining slices (the rest of the row-clock tables,
finance, canonical identity and aliases, engine, transport and UI) land.

Test-only clock: `TauriSqliteRepository` takes an optional third constructor argument, the wall clock
(epoch milliseconds) behind every sync clock it issues (default `Date.now`). Production never passes it;
the harness gives each simulated laptop its own.

### Legacy email triage tables (unused)

The email triage feature was removed (see [LLM bridge](llm-bridge.md) for the replacement),
but migrations are append-only, so migrations 29–32 still create these tables and the app
never reads or writes them: `email_triage_settings`, `email_triage_accounts`,
`email_triage_conversations`, `email_triage_aliases`, `email_triage_messages`,
`email_triage_classification_attempts`, `email_triage_reviews`, `email_triage_evaluations`,
`email_triage_desired_effects`, and `email_triage_audit_events`. Existing user databases keep
whatever they contain; nothing deletes it. `gtd_tasks.source_url` (added by migration 29) is
live: it holds the link-back URL of tasks created through the MCP `add_tasks` tool, and
tasks created by the old triage keep `source = 'email_triage'`.

Provider refresh tokens and the triage classifier key that the old feature wrote to the OS
vault are no longer addressable (`vault.rs` only resolves `calendar_credentials`); they remain
as orphaned entries in the macOS Keychain under the `trackdidia` service until deleted there.

### Finance tables

Migration 37 is purely additive (no `ALTER TABLE` on any existing table) and creates
every `finance_*` table in one migration. See
[finance.md](finance.md) for the full data model and repository contract; this is the
storage-layer summary.

- `finance_people`, `finance_accounts`, `finance_categories`: household, account, and
  category taxonomy. `finance_accounts.external_key` is a nullable unique column
  binding an imported file's account label to an account.
- `finance_transactions`: one row per transaction, `UNIQUE(account_id, dedupe_hash)` so
  re-importing the same file inserts nothing. `category_source = 'user'` is never
  touched by any automatic stage.
- `finance_transaction_splits`: a transaction's amount, split across categories; the
  parent keeps the full amount and reports expand splits when present.
- `finance_rules`, `finance_merchant_memory`, `finance_category_suggestions`: the
  classification/learning loop's inputs and pending-review queue. A partial unique
  index keeps at most one pending suggestion per transaction.
- `finance_budget_entries`, `finance_budget_months`: YNAB-style envelope assignments
  and advisory month-close state (Phase 5; schema ships now, no arithmetic yet).
- `finance_recurring_series`, `finance_account_balance_snapshots`: recurring-bill
  detection (Phase 6) and daily balance history, also read by the Phase 7
  forecast engine (active series and `onBudgetBalance` respectively). Snapshot
  `source` is `derived` (daily job) or `statement` (written by
  `applyFinanceStatementBalance`, which also re-bases
  `finance_accounts.opening_balance_minor`; see
  [finance.md](finance.md#statement-import-financesimport-relevé-de-compte-pdf)).
  No schema change: both values already fit the existing columns.
- `finance_import_profiles`, `finance_import_batches`: saved column-mapping profiles
  (unique by header signature) and one row per import run, used by
  `undoFinanceImportBatch`.

Multi-device sync of these tables (not user-enabled yet) is described in
[Finance tables, the categorization unit and statement anchors](#finance-tables-the-categorization-unit-and-statement-anchors).

The three system categories (`fincat:non-categorise`, `fincat:transfert`,
`fincat:split`) are inserted by migration 37 itself, because engine code
hard-references those ids. The deterministic default French taxonomy
(`fincat:alimentation`, …) is **not** in the migration: `src/lib/finance/default-categories.ts`
holds the fixed-id list, seeded idempotently (`INSERT OR IGNORE`) through
`seedFinanceDefaultCategories()` on both repositories, gated on
`AppSettings.financeCategoriesSeededAt`.

Migration 39 (`create_finance_alert_notifications`, additive, next free id
after 38) adds a single small table, `finance_alert_notifications
(alert_key, notified_on_date, notified_at)` with primary key
`(alert_key, notified_on_date)`. It exists only to rate-limit the Phase 7
desktop notification to once per day per alert key (see
[finance.md](finance.md#forecasting-and-proactive-alerts-phase-7)); it is
never read when rendering the alerts list itself. Like every other finance
table, it is included in `VACUUM INTO` backups automatically.

## Backup behavior

Backups require a destination folder stored in `AppSettings.backupDestinationDir`.
Until that folder is chosen, manual export is disabled and automatic backup checks
skip without updating `lastBackupAt`. Desktop mode shows an app-wide banner linking
to Settings when automatic backup is enabled and no folder is set. There is no
Google OAuth or Drive API; Drive sync happens only if the chosen folder is already
managed by Google Drive for Desktop.

The chosen destination must already exist at backup time. The host creates only the
environment subdirectory under it (`backups/` or `backups-dev/`). If Google Drive
for Desktop is unmounted, the backup fails instead of recreating a local shadow of
the Drive path.

Manual and automatic backups then:

1. Confirm the chosen destination exists, then create `{destination}/backups/` or
   `{destination}/backups-dev/`.
2. Call:

```sql
VACUUM INTO '<absolute backup path>'
```

3. Best-effort keep only the newest 30 files whose names match
   `trackdidia-(manual|auto)-backup-*.db`. Other files in the folder are ignored.
   Manual and automatic snapshots share the same cap. Sort uses the timestamp in the
   filename so mixed kinds stay chronological. A prune failure does not fail the
   backup or block `lastBackupAt`; undeletable files are skipped and logged.

This creates a self-contained SQLite snapshot without copying live WAL files.
Filenames contain the backup kind (`manual` or `auto`) and a sanitized timestamp.

Backups include all AI tables (`ai_messages`, `ai_proposals`, `ai_memories`) plus
settings JSON (OpenRouter and RescueTime keys). Distilled personal statements in
`ai_memories` are therefore part of every backup copy. `pastor_verse` rows in
`ai_messages` (surface for the "Pasteur IA" verse-of-the-day card) are ordinary rows
in the same table — no migration was needed to add that surface, since `surface` is
`TEXT NOT NULL` without a `CHECK` constraint. The checked-in `verses.json` catalog
itself lives in the repository, not in SQLite, so it is not part of a backup.

Finance data (`finance_*` tables) lives only in the local SQLite file and is
therefore included in every `VACUUM INTO` backup like any other table. There is no
separate finance export or redaction step. Because an import is the largest single
write the app has ever performed and there is no restore-from-backup UI, take a
manual backup from Settings before the first real import.

Automatic backups:

- default to enabled;
- default interval is 24 hours;
- are checked at startup and every hour while the app remains open;
- run only when a destination folder is set and `lastBackupAt` is old enough;
- use an in-memory guard to avoid concurrent backup attempts;
- update `lastBackupAt` and `lastBackupPath` after a successful snapshot, even if
  retention cannot delete older files.

The Settings screen can choose the destination folder, change the enable flag and
interval, and create a manual backup. Folder picking and backup buttons are disabled
in browser preview. The backup-directory card shows the resolved environment
subdirectory, or "Mode preview" in browser preview.

Native helpers: `ensure_backup_dir` and `prune_backups` in `src-tauri/src/backup.rs`
both take the chosen destination and environment; they do not accept an arbitrary
path. Folder picking uses `tauri-plugin-dialog`.

## Recovery

There is no restore UI. Recovery is currently an operator/manual action:

1. Fully quit TrackDidia.
2. Preserve the current database and any `-wal`/`-shm` files before changing them.
3. Choose a verified backup from the matching environment subdirectory of the
   configured destination (`backups/` or `backups-dev/`). At most 30 snapshots are
   kept there.
4. Replace the matching environment database file with a copy of that backup.
5. Restart the application and verify entries, tasks, and settings.

Leave the `device-id`/`device-id.dev` file in place when restoring; it identifies this
installation, not the data.

Do not restore a development backup over production (or the reverse) without
explicitly choosing that outcome. Do not perform this operation automatically in a
code task.

## Data safety and privacy

- The database contains personal journals, principles, goals, tasks, and AI
  configuration.
- `app_settings.value` may contain the OpenRouter API key and the RescueTime API key in plaintext.
- Backups contain the same sensitive data as the source database.
- Treat locally built `dist/` artifacts and database backups as sensitive.

## Related documentation

- [Architecture](architecture.md)
- [GTD](gtd.md)
- [AI, settings, and privacy](ai-settings-and-privacy.md)
- [Calendar sync](calendar-sync.md)
- [Desktop builds](desktop-builds.md)
