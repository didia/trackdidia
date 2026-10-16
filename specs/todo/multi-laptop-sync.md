# Spec — Multi-laptop sync (personal + work) through shared Drive folders

**Status:** draft, awaiting review (not approved, nothing implemented).
**Scope:** let several TrackDidia desktops share data without a server. **Personal** laptops
share everything. A **work** laptop shares only GTD and Pomodoro: the complete task list,
projects, contexts, recurrences and focus history, and nothing else. Each laptop reads and writes
its own SQLite database; they converge through files in Google Drive for Desktop folders. No
server, no account, no Drive API, no OAuth.

## Context

Today there is exactly one database per machine and
[`docs/architecture.md`](../../docs/architecture.md) states "No cloud sync, accounts, or shared
data". The only cross-machine artifact is the backup folder (`{destination}/backups/`), written
with `VACUUM INTO` and pruned to 30 files by
[`src-tauri/src/backup.rs`](../../src-tauri/src/backup.rs). Both laptops can already reach that
folder, which makes it the natural transport.

The headline requirement: **when a TrackDidia session starts, it must first absorb whatever the
other laptop produced**, and what this laptop produced must be visible to the other the next time
it starts.

The privacy requirement: **the work laptop holds the full GTD list and Pomodoro history, and
never holds daily routines, journals, reviews, goals, AI coach data, relationship settings or
finance.** "Never holds" means those bytes are not readable from the work laptop at all, not that
the app chooses to ignore them. That rules out giving the work laptop the existing backup folder:
every backup there is a full `VACUUM INTO` copy containing all of it, plus both API keys.

## Can the backup mechanism be the sync mechanism?

**No, not as-is. Yes as the transport substrate.**

Using backups directly means "on startup, restore the newest `.db` in the folder". That is
whole-database last-writer-wins, and it fails the use case:

| Problem with raw backups | Consequence |
|---|---|
| A snapshot is the entire database | Restoring the newer snapshot silently discards everything done on the other laptop since its last backup. Two laptops used on the same day is the normal case, not an edge. |
| Snapshots carry no per-row history | Nothing says which side changed a given task, so nothing can be merged, only replaced. |
| Hard deletes leave no trace (`DELETE FROM gtd_tasks`, `annual_goals`, `finance_*`) | Even a correct row merge would resurrect everything one laptop deleted. |
| File names are `trackdidia-(manual\|auto)-backup-<timestamp>.db`, 30-file shared cap | No device identity; both laptops would prune each other's files; a quiet laptop's last snapshot can be evicted by a chatty one. |
| Default interval is 24 h | Staleness measured in a day. |
| Written straight into a Drive-synced path | The other laptop can read a half-uploaded file. |
| Raw `.db` includes everything (settings blob, both API keys, finance) | No way to leave domains out of what the work laptop publishes. |

What is worth keeping: the **shared folder**, the Rust-side path discipline of `backup.rs`
(destination + environment only, no arbitrary paths), the `backups-dev/` style separation, and
`VACUUM INTO` as the *safety net before the first merge*. Backups keep working as they do
today, with one change: once sync is enabled, file names carry the device id so two personal
laptops do not prune each other's snapshots. Sync is a separate artifact: its personal
bundles sit beside the backups, and its GTD bundles go in a second folder the work laptop can see.

### Chosen approach: per-device state bundles + deterministic merge

Each laptop publishes a **state bundle** of the sync-eligible data into a directory only it ever
writes. Each laptop merges the other's bundle into its own database using per-field logical
clocks and tombstones. Because every bundle has a single writer, Google Drive can never create a
"conflicted copy", and because a bundle is full state (not a log), applying it is idempotent and
order-independent, so a missed, repeated or late bundle cannot corrupt anything.

This is the same *delta-state with per-field hybrid logical clocks in a sidecar table* engine
already approved in [`mobile-and-sync.md`](mobile-and-sync.md) (Phase 4). This spec reuses that
engine and changes the transport, the scope, and the authority model; see the next section.

## Decisions

| Decision | Choice |
|---|---|
| Device profiles | Each device is `personal` (all domains) or `work` (the `gtd` domain only). The profile is chosen when sync is enabled and is device-local. |
| Domains | `gtd` = GTD, recurrences, task events, Pomodoro. `personal` = daily routine, reviews, goals, objectives, AI coach, relationship draws. `finance` = household finance. Exact table mapping in [What syncs](#what-syncs). |
| Two folders | A **shared GTD folder** that the work laptop can see, holding only `gtd` bundles. A **personal folder** (the existing backup destination) that only personal laptops can see, holding `personal` and `finance` bundles plus backups. The separation is enforced by what each machine can open, not by app logic. |
| Transport | Files in `{folder}/sync/` (`sync-dev/` for development builds, mirroring `backups-dev/`). Written and read by Rust commands; Drive for Desktop moves the bytes. |
| Topology | Symmetric peers. Any laptop can be used alone for days; no primary/companion roles. |
| Payload | One bundle per **domain** per device, gzip JSON lines of rows plus their clock metadata. Full state, not a log. |
| Merge engine | Shared with the mobile spec: HLC, per-field clocks, OR-sets, tombstones, `sync_entity_meta` sidecar. Generalized from 6 entity types to the whole synced schema through a registry. |
| Change tracking | Hybrid: registry-driven SQLite **triggers** for row-clock, union, child-set and delete capture; explicit field-clock computation for the field-clock tables. Decided in the Phase 1 spike (see Open questions). |
| Settings | Never synced as a blob. A per-key registry marks each `AppSettings` key `synced` or `device`. |
| Secrets | Device-local by default (OpenRouter key, RescueTime key, LLM bridge token). |
| Calendar sync | Device-local; at most one laptop should run the reconciler. |
| Encryption | Not in v1. Folder separation, not encryption, keeps personal data off the work laptop. The bundle writer is a single seam where envelope encryption can be added later. |
| Startup order | Pull and merge first, run generators second, publish last. Correctness never depends on that order; it only reduces churn. |
| Off by default | `multiDeviceSyncEnabled` setting, false until the user opts in per device. |

## Relationship to `mobile-and-sync.md`

Shared, built once (the mobile spec's Phase 4 becomes "extend", not "build"): `hlc.ts`,
`field-clocks.ts`, `merge.ts`, the sidecar tables, the merge table for tasks (lifecycle tuple,
OR-set `contextIds`, edit-wins-over-delete, Pomodoro rules), and `createEntityId` hardening.

Different here:

| Topic | Mobile spec | This spec |
|---|---|---|
| Peers | Desktop primary + phone companion | Full desktops, symmetric, each with a `personal` or `work` profile |
| Generators | Desktop-only authority | Every device runs recurrence generation and promotion; relationship draws run on `personal` devices only (below) |
| Scope | GTD + Pomodoro only | `work` devices: GTD + Pomodoro (the mobile spec's scope). `personal` devices: everything user-authored |
| Settings | Not synced | Registry of synced keys + device keys |
| Transport | Encrypted bundles through the Drive API | Plain files in an already-synced folder |
| Payload limits | 2 MiB `provider_http.rs` cap forces chunking | None; local file I/O |

If both specs are built, the mobile transport becomes a second `SyncTransport` implementation and
the desktop-to-desktop path keeps working unchanged. Sequence this spec first: it is the smaller
transport and it exercises the whole merge engine on real data.

Note for whoever picks up the mobile spec: it predates migrations 33–41 (it claims "migration 33"
as next free) and the removal of email triage, so its migration number and its email-triage
references are stale.

## Folder protocol

Two folders, chosen separately in Settings:

```text
{gtdSyncDir}/                   shared GTD folder — visible to personal AND work laptops
  sync/
    <deviceId>/                 written only by that device
      manifest.json
      gtd-<generation>.bundle

{backupDestinationDir}/         personal folder — visible to personal laptops ONLY
  backups/                      existing backups (full database copies)
  sync/
    <deviceId>/
      manifest.json
      personal-<generation>.bundle
      finance-<generation>.bundle
```

| Device profile | Publishes to shared GTD folder | Publishes to personal folder | Reads from |
|---|---|---|---|
| `personal` | `gtd` | `personal`, `finance` | both folders |
| `work` | `gtd` | nothing (not configured) | shared GTD folder only |

How this maps to Google Drive. The work laptop must not be able to open the personal folder, so it
either signs Drive for Desktop into a different Google account (for example a work account) with
only the shared GTD folder shared to it, or uses the same account with Drive's selective folder
sync limited to that one folder. The first is the stronger boundary. Selective sync only controls
what is mirrored to disk, and the personal folder stays reachable through drive.google.com in the
browser. The setup guide for the `work` profile recommends the shared-to-a-second-account
arrangement and warns explicitly against picking the backup folder.

Each Rust command takes a folder *role* (`gtd` or `personal`) and resolves the path from the
matching setting, so code cannot write a `personal` bundle into the shared GTD folder by passing
the wrong path. A `work` device has no personal folder configured, and the command refuses
`personal`/`finance` publishes and reads.

`manifest.json`:

```json
{
  "formatVersion": 1,
  "deviceId": "dev:3f1c…",
  "deviceName": "Work MacBook",
  "appVersion": "0.2.0",
  "schemaVersion": 42,
  "writtenAt": "2026-10-14T13:02:11.482Z",
  "hlcHigh": "…",
  "profile": "work",
  "domains": {
    "gtd": { "generation": 17, "file": "gtd-17.bundle", "sha256": "…", "bytes": 482113, "rows": 9120 }
  },
  "calendarSyncEnabled": false
}
```

A manifest lists only the domains held in *its* folder: the shared GTD folder's manifests only
ever mention `gtd`, so the work laptop never learns even the size of the personal bundles.

Publish procedure (Rust command, atomic from the reader's point of view):

1. Confirm the destination exists (same rule and error as backups: never recreate a local shadow
   of an unmounted Drive path).
2. Write `<file>.partial`, flush, rename to `<file>`.
3. Write `manifest.json.partial`, flush, rename to `manifest.json`. The manifest is **last**; it
   is the commit point.
4. Delete bundle files of generations older than the previous one (keep 2 so a reader mid-download
   of the old generation does not lose it). Failure to delete is logged and never fails the publish.

Read procedure:

1. List `sync/*/manifest.json`, ignoring this device's own directory and any entry that does not
   match `<deviceId>/manifest.json` (Drive "(1)" copies, stray files).
2. For each peer, compare `domains.*.generation` and `sha256` with `sync_peers` and skip unchanged
   domains. Unchanged is the common case, so a pull is a handful of tiny file reads.
3. Before applying a bundle, verify `bytes` and `sha256`. A mismatch means Drive has not finished
   propagating: treat it as "not yet", keep the previous state, retry on the next trigger. Never
   apply a bundle that fails verification.
4. Run the schema gate (below), then apply in one transaction.

Rust owns all path handling. New commands mirror `ensure_backup_dir`/`prune_backups`: they take
a folder role plus environment and a device id, never an arbitrary path. Development
builds read and write `sync-dev/`, so a dev instance can never merge into production data.

Drive for Desktop in "stream files" mode can leave a file online-only; the first read then blocks
while it downloads. All reads run with a timeout and report "peer unreachable" rather than hanging
the UI.

## What syncs

The authoritative classification lives in `src/lib/sync/registry.ts`. **A test fails when a table
in the migrated schema, or a key of `AppSettings`, has no classification**, so a future migration
cannot add data that silently never syncs, **or lands in the wrong domain**. Every table has both
a domain and a merge class.

### Domains

| Domain | Tables | Reaches the work laptop? |
|---|---|---|
| `gtd` | `gtd_tasks`, `gtd_projects`, `gtd_contexts`, `gtd_task_events`, `recurring_task_templates`, `pomodoro_sessions`, `pomodoro_segments` | **Yes**: the whole list, every bucket, every project and context, including tasks created at home |
| `personal` | `daily_entries`, `weekly_reviews`, `monthly_reviews`, `mid_week_decisions`, `annual_goals`, `weekly_objectives`, `weekly_objective_results`, `ai_messages`, `ai_proposals`, `ai_memories` | No |
| `finance` | every synced `finance_*` table | No |
| device-local | see the last row of the class table | Never leaves any machine |

The split is clean because **references only point from `personal` to `gtd`, never the other way**.
No task, project, context, template or Pomodoro row refers to a goal, review, objective, daily
entry or AI row. (AI proposals of type `gtd_action` refer to tasks, but they live in `personal`.)
A work laptop therefore holds a self-consistent GTD database with no dangling ids. The registry test
keeps it that way: it fails if a column in a `gtd` table references a non-`gtd` table.

Useful consequence for the personal laptops: they receive the work laptop's task events and
Pomodoro sessions, so suggested daily GTD/Pomodoro metrics, weekly reviews and the coach see work
done at the office without any work-laptop access to those screens.

Two cases where GTD rows carry personal content, by design of the user's choice to share the
entire list:

- **Relationship-draw tasks** (children/spouse activities, `Personal` context) are ordinary GTD
  tasks and appear at work. Only the activity *lists* and draw bookkeeping in settings stay
  personal.
- **Task notes and project notes** may contain anything. The whole list is shared, so they go too.

### Merge classes

| Class | Tables | Merge rule |
|---|---|---|
| Field-clock | `gtd_tasks` (recurring instance rows: see [Recurring occurrences](#recurring-occurrences)), `gtd_projects`, `gtd_contexts`, `recurring_task_templates`, `daily_entries`, `weekly_reviews`, `monthly_reviews`, `mid_week_decisions`, `annual_goals`, `weekly_objectives`, `weekly_objective_results` | Each column is a field with its own clock. JSON-map columns (`metrics_json`, `principles_json`, review `notes`, annual-goal `evaluations`, `progress_log_json`, `milestones_json`) merge **per key** (`metrics.<key>`, `milestones.<id>`). Context/id lists are OR-sets. Tasks follow the mobile spec's table. |
| Row-clock | `finance_people`, `finance_accounts`, `finance_categories`, `finance_transactions`, `finance_rules`, `finance_merchant_memory`, `finance_budget_entries`, `finance_budget_months`, `finance_recurring_series`, `finance_import_profiles`, `finance_import_batches`, `ai_memories` | Whole row last-writer-wins by row HLC. Per-field clocks would multiply storage on a table that can hold ~10^5 rows for no real gain. Exception: a transaction's categorization fields and splits form one unit with causal metadata; see [Finance categorization unit](#finance-categorization-unit). |
| Grow-only union | `gtd_task_events`, `ai_messages` | Union by `id` / `dedupe_key`. Cannot conflict. |
| Monotonic status | `ai_proposals`, `finance_category_suggestions` | Terminal state (`accepted` / `dismissed` / `expired` / resolved) beats `pending`. |
| Child set | `finance_transaction_splits` | Part of the parent transaction's categorization unit; replaced as a set with whichever categorization wins. |
| Pomodoro | `pomodoro_sessions`, `pomodoro_segments` | Only **terminal** sessions (`completed`/`cancelled`) and their segments are published. A running or paused timer is owned by the laptop it runs on and never leaves it. Completed focus on either laptop counts toward the day. Segment `endedAt`: non-null beats null. |
| Device-local | `schema_migrations`, `rescuetime_snapshot_cache`, `finance_alert_notifications`, `finance_account_balance_snapshots` with `source = 'derived'` (rebuilt by the daily job), `calendar_sync_settings`, `calendar_sync_links`, the legacy `email_triage_*` tables, `sync_identity`, `sync_peers` | Never leave the machine. (The other `sync_*` sidecars travel with the entities they describe; see [Data model](#data-model-migration-sketch).) |

`finance_account_balance_snapshots` with `source = 'statement'` are user data (written by statement
import, which also re-bases the account's opening balance) and sync as row-clock.

### Natural keys and canonical identity

Several synced tables have a unique key besides the primary key, so two peers can mint *different*
ids for the *same* thing. Example: two personal laptops import the same CSV while offline; each
generates its own `finance-txn` id, but both rows carry the same `(account_id, dedupe_hash)`.
Applying the peer row by id hits `uniq_finance_txn_dedupe` and rolls back the whole finance
bundle. The local import's `ON CONFLICT … DO NOTHING` does not help, and ignoring the remote row
would strand its splits and suggestions and lose its edits.

The registry therefore declares every unique key of every synced table, and a test compares that
list with the `UNIQUE` columns and unique indexes in the migrated schema (`sqlite_master`), so a new
unique index cannot be forgotten. Before applying a bundle, in the same transaction, the engine:

1. Looks up each incoming row by each declared natural key. A local row with a different id means
   the two ids denote one entity.
2. Chooses the **canonical id** as the lexicographically smaller of the two. This is a total order,
   so every peer picks the same id whatever the merge order.
3. Records `alias_id → canonical_id` in `sync_id_aliases` (grow-only, published in the entity's
   domain) and rewrites every reference the registry declares to the alias. For transactions:
   splits, suggestions, transfer grouping and import-batch membership. For tasks: task events and
   Pomodoro segments. References inside JSON (an AI proposal payload's `taskId`) are resolved
   through the alias table when read.
4. Merges the two rows' contents with the table's normal rule (field/row clocks, lifecycle rules,
   categorization unit), as if they had always been one row. Nothing is dropped; an edit made to
   either copy survives on its clock.
5. Rewrites alias ids on decode for every later bundle that still carries them.

| Table | Natural key | Typical cause |
|---|---|---|
| `finance_transactions` | `(account_id, dedupe_hash)` | Same statement imported on two personal laptops |
| `finance_accounts` | `external_key` | Same import label bound to an account on both |
| `finance_import_profiles` | header signature | Same CSV layout saved on both |
| `finance_category_suggestions` | one `pending` per transaction (partial index) | Both laptops suggest for the same, now canonical, transaction: the later clock stays pending, and the engine resolves the other with a log entry |
| `ai_proposals` | pending-per-message/type partial indexes | Same rule as suggestions (`personal` domain) |
| `gtd_tasks` | `source_external_id` | Relationship draws on two personal laptops (see generators) |
| `gtd_projects` | `source_external_id` | Legacy imported projects |
| `gtd_contexts` | `name` | Ids are already deterministic (`context:<slug>`); a rename onto an existing name stays the mobile spec's prompt |
| `gtd_task_events` | `dedupe_key` | Weekly carryover on both; the union already keys on it |

A unique violation on a key the registry does not declare aborts that bundle with an error naming
the table and index. It is never skipped silently.

### Finance categorization unit

On `finance_transactions`, `{category_id, category_source, has_splits}` and the child splits form
one **categorization unit** with its own clock and a `base_hlc`: the unit clock this device had seen
when it wrote. Other columns stay row-clock. The unit clocks live in that row's
`sync_entity_meta.field_clocks_json`.

- **Causally later wins.** If one write's `base_hlc` is at or after the other write's clock, it
  saw that write and wins. Example: B categorizes with splits (`user`). A receives it, then removes
  the final split, and `saveTransactionSplits` deliberately resets the parent to uncategorized,
  `has_splits = false`, `category_source = 'default'`. A's reset wins, and B's old split children are
  not restored.
- **A peer republishing an unchanged row** carries its old unit clock and loses to any later write.
- **Concurrent writes** (neither saw the other): a `user` source beats an automatic one (`rule`,
  `memory`, `seed`, `ai`, `default`), so a stale automatic stage on one laptop cannot overwrite a
  manual choice made on the other. Two concurrent `user` writes: the later HLC wins and the loser
  is logged.

### Settings registry

Per-key, in the same registry file. Each synced key also has a domain, and travels in that
domain's bundle. Representative split:

- **device** (never published): `backupDestinationDir`, `autoBackupEnabled`,
  `autoBackupIntervalHours`, `lastBackupAt`, `lastBackupPath`, `storageMode`, `aiApiKey`,
  `rescuetimeApiKey`, `llmBridgeEnabled`, `llmBridgePort`, `llmBridgeToken`, `runInTray`,
  `launchAtLogin`, `aiPulseFirstOpenAt`, `multiDeviceSyncEnabled`, the device profile and the GTD
  sync folder path.
- **`gtd` domain** (reaches the work laptop): `language`, and the GTD normalization markers
  (`gtdImportDoneAt`, `gtdReferencesMigrationDoneAt`, `gtdScheduledNormalizationDoneAt`,
  `gtdRecurringCollapseDoneAt`, non-empty wins). That is a deliberately short list.
- **`personal` domain**: AI preferences and pulse/pastor settings, relationship-draw activity lists,
  relationship-draw processed dates and `previousDayReviewDoneDate` (monotonic max, which stops a
  second personal laptop from repeating today's draw), `dimancheNotesRelocatedAt`,
  `aiMaxTokensUpgradeDoneAt`.
- **`finance` domain**: every `finance*` key, including `financeEnabled` and
  `financeCategoriesSeededAt`.

Merge rules per key: per-key LWW by default, monotonic max for dates that only move forward,
non-empty-wins for one-time markers. The normalizations are idempotent, so syncing markers only
avoids repeating them.

Because settings today are one blob, synced keys get per-key clocks in `sync_entity_meta` under
`entity_type = 'setting'`; `updateSettings` (already the single read-modify-write path) is where
local changes are stamped.

## Startup and runtime flow

This is the behaviour the feature exists for. It extends the bootstrap contract in
[`AGENTS.md`](../../AGENTS.md) ("Bootstrap behavior"); all of its existing properties still hold.

**Startup, in order** (when `multiDeviceSyncEnabled` and the destination is mounted):

1. Initialize SQLite and run migrations (unchanged). Ensure device identity.
2. **Safety backup.** Before the first merge into a database that holds user rows, or when a peer's
   `schemaVersion` differs from ours, force `createBackup("auto")` to this device's own backup
   destination and record its path in the sync log. If such a backup is required and cannot be
   made, the merge does not run.
   - A **verified empty joiner** skips it, because there is nothing to lose; the skip is recorded.
     Empty means no rows other than migration and seed rows (default contexts, finance system and
     default categories, the settings row at defaults), as enumerated by the registry.
   - When a backup *is* required, onboarding asks for a destination before the merge. On a `work`
     device that is a local or work folder; the personal folder is refused by its role marker.
     The default fresh work join (empty database, no backup destination configured) therefore
     reaches its first import without an extra step.
3. **Pull**: list peers, verify and merge changed bundles (budget: 4 s). This precedes recurrence
   generation, Scheduled promotion and relationship draws so they see the other laptop's work:
   a task already completed on the other laptop is not regenerated, and today's draw already
   made there is not repeated.
4. Existing startup jobs run (normalizations, recurrence generation, promotion, draws). On a `work`
   device, only the GTD jobs run: GTD normalizations, recurrence generation and Scheduled
   promotion. Relationship draws, AI pulse, the Dimanche-notes relocation and finance jobs are
   skipped (see [Work profile](#work-profile)).
5. Auto-backup check (unchanged), enqueued through the existing `enqueueStartupWork` queue so
   backup and sync never run concurrently.
6. **Publish** this laptop's bundles if anything changed since the last publish.

**The 8-second bootstrap rule is not weakened.** A slow or unreachable folder must never trigger
the in-memory fallback or block the UI. If the pull exceeds its budget, bootstrap proceeds, the
pull continues in the background, and the status chip shows "Syncing…". When a background pull
applies changes, it republishes through the same mechanism as the local-day boundary so mounted
GTD, Daily and Pomodoro views reload.

**While running:**

- Pull on window focus / becoming visible (debounced to once per 60 s) and hourly. A pull with no
  changed manifests costs a few small reads.
- Publish after local writes, debounced (2 min after the first unpublished change), on window
  blur/hide, and best-effort on quit with a 3 s cap. A change counter in `sync_identity` makes
  "anything to publish?" a single comparison.
- "Sync now" in the sync UI forces pull then publish.

**Why startup ordering is not a correctness requirement:** if the folder was slow and a generator
ran first, the merge still converges, because generators are deterministic (next section). The
ordering exists to avoid visible churn, not to prevent corruption.

## Generators on several full peers

Every device runs recurrence generation and Scheduled promotion. Relationship draws run only on
`personal` devices, because the activity lists they draw from are `personal` settings that never
reach the work laptop. The tasks they create are `gtd` rows and do reach it. Safety comes from the
data model, not from a leader:

| Generator | Why concurrent runs converge |
|---|---|
| Scheduled promotion | Pure and idempotent over `(tasks, today, now)`. Both sides compute the same result. |
| Recurrence generation | One row per template (`recurring-task:<templateId>`) advanced in place, so the row id is not an occurrence. Sync merges per **occurrence**, never by independent max/LWW on the row's fields; see [Recurring occurrences](#recurring-occurrences). |
| Relationship draws (personal devices only) | New draws are deterministic. The task id is derived from the `source_external_id` (category + date), and the activity is chosen with a seed of `(category, date)` over the synced activity list. Two personal laptops therefore normally create the identical row, and merging it is a no-op. If the lists differed at draw time, or for draws made before this change, the rows collide on `source_external_id` and go through [canonical identity](#natural-keys-and-canonical-identity): one id by total order, events and segments remapped, lifecycle and edits merged, so a completion on either copy survives. `createdAt` is never the tiebreaker, because the planner stamps every draw `${date}T00:00:00.000Z` and concurrent draws always tie on it. No row carrying user state is dropped. |

Reads are already pure (`listTasks` no longer runs the generators; `generateDueRecurringTasks` and
`promoteDueScheduledTasks` are explicit calls), so merely viewing a list never stamps clocks or
dirties a bundle. That property must be kept: a generator call that finds nothing to do must write
nothing. The mobile spec's `runDailyGenerators` aggregate is optional here.

### Recurring occurrences

Independent field rules on the advanced-in-place row produce wrong states:

- **Wrong completion.** Both peers know the Oct 15 instance. Offline, A completes it after
  midnight while B generates Oct 16 into the same row. Max-date picks Oct 16, terminal-wins picks
  A's `completed` tuple: an Oct 16 task marked completed although only Oct 15 was done. B's
  `lastGeneratedForDate` is already Oct 16, so no later generator pass repairs it.
- **Backlog that will not clear.** `pendingPastRecurrences` is not monotonic: `clearPastRecurrences`
  deliberately saves 0. Max-merge would restore B's stale count every time B republishes, however
  often the user clears it on A.

Sync therefore models a recurring row as a sequence of occurrences, in two `gtd`-domain sidecar
tables: `sync_recurrence_occurrences(template_id, due_date, outcome, outcome_hlc, device_id)` and
`sync_recurrence_clears(template_id, cleared_through_date)`.

- `outcome` is `active`, `completed`, `cancelled` or `missed`. Generation records `missed` for the
  overrun occurrence and `active` for the new one. For the same occurrence, a user outcome
  (`completed`/`cancelled`) beats `missed`/`active` regardless of clock; complete-vs-cancel stays the
  mobile spec's prompt.
- The row's lifecycle tuple and its clocks are **scoped to an occurrence** (the epoch is
  `recurrenceDueDate`). A lifecycle write for an older epoch updates that occurrence's outcome, never
  the current row's lifecycle. Non-lifecycle edits (title, notes, contexts) merge per field across
  epochs as usual.
- After a merge the row is recomputed, not merged:
  - `recurrenceDueDate` and the template's `lastGeneratedForDate` = the latest occurrence;
  - lifecycle = that occurrence's merged state;
  - `pendingPastRecurrences` = the number of `missed` occurrences after `cleared_through_date`.
- `clearPastRecurrences` sets `cleared_through_date` to the latest due date it acknowledged. That
  date really is monotonic (max merge). A peer's stale count is irrelevant, because the count is
  derived and never merged.

Worked example: A completes Oct 15; B, offline, generates Oct 16 and records Oct 15 as missed.
After merging, Oct 15 = completed (a user outcome beats missed), Oct 16 = active, and the backlog is
0. A's `task_completed` event arrives through the `gtd_task_events` union, so daily statistics count
the completion.

This replaces the mobile spec's "primary-authoritative" rule for these fields, which relied on a
single generating device.

`createEntityId` falls back to `Math.random()` when `crypto.randomUUID` is absent
([`src/lib/gtd/shared.ts`](../../src/lib/gtd/shared.ts)). Two independent writers make that a real
collision path: make the fallback throw (shared fix with the mobile spec).

## Deletes

Hard deletes exist today (`gtd_tasks`, `annual_goals`, `weekly_objectives` and their results,
`pomodoro_segments`, `finance_rules`, `finance_transactions` on import undo, recurring series,
merchant memory, budget entries, statement balance snapshots). Without tombstones a merge would
resurrect every one of them.

- A delete writes `deleted_at` (an HLC) into `sync_entity_meta` for that key, including rows
  removed by a cascade. For the trigger-captured classes an `AFTER DELETE` trigger does this
  regardless of which code path deleted the row, so a new delete site cannot forget.
- **Edit wins over delete** (the mobile spec's rule): a field-level edit with a causally later
  clock resurrects the row. A delete with a later clock removes it. Known consequence:
  `undoFinanceImportBatch` on one laptop can be partly undone by a categorization done on the
  other. That is acceptable and visible, and recoverable by undoing again.
- Tombstones are kept 180 days, then pruned. A peer whose manifest `writtenAt` is older than
  90 days, or a laptop that has not pulled from a peer in 90 days, does **not** auto-merge:
  the user sees "this laptop has been offline too long to merge safely" and chooses to review. This
  bounds resurrection risk.

## Schema and version skew

The laptops will not always update together.

- Manifest carries `schemaVersion` (highest applied migration id) and `appVersion`.
- **Peer schema newer than ours:** do not merge from it. Status "update TrackDidia on this laptop
  to sync with `<device>`". Our own bundles keep publishing, and the newer laptop can still read
  ours because it can ignore columns it knows we lack.
- **Peer schema older than ours:** merge. Bundle rows are JSON keyed by column name, so a column the
  peer lacks simply is not present and our value is kept; unknown columns are ignored.
- A migration that changes the **meaning** of synced data (not just adds a column) must bump
  `formatVersion` and is called out in review; the default for such a change is a coordinated
  update of both laptops.
- Never apply a bundle across a major `formatVersion` it does not recognize.

## Joining the second laptop

The join flow starts by choosing the profile, which decides which folders are asked for.

- **Work laptop:** choose `work`, pick the shared GTD folder (never offered the backup folder),
  import the `gtd` bundles of a personal peer. The result is the complete GTD list and Pomodoro
  history, and nothing else.
- **Another personal laptop:** choose `personal`, pick the personal folder and the shared GTD
  folder, import all three domains.

Two cases, both explicit in the UI, neither automatic.

1. **Empty joiner (expected).** New laptop, fresh database. Settings → "Join an existing
   TrackDidia": choose the profile and folders, the app lists peers found in `sync/`, user confirms
   the peer, the app imports that peer's bundles for the profile's domains. All rows arrive with the peer's clocks. Because the
   joiner's seeded rows (contexts `context:<slug>`, finance default categories `fincat:*`, system
   categories) are deterministic ids, they merge instead of duplicating.
2. **Joiner that already has data.** As `personal`: show counts of what each side has, require a
   backup destination, back up, then merge. As `work`: allowed only if the existing data is GTD and
   Pomodoro alone (zero rows in every `personal` and `finance` table, personal settings at
   defaults); then the same backup-then-merge. Any personal or finance rows make the work join
   refused (see [Work profile](#work-profile)). Collisions on natural
   keys (a `daily_entries` row for the same date, a `weekly_reviews` row for the same week) resolve
   by field clocks; the older side's differing values are kept in the conflict log.

**Cloned device identity.** The recovery procedure in
[`docs/storage-and-backups.md`](../../docs/storage-and-backups.md) (copy a backup over the
database) could place laptop A's `sync_identity` on laptop B and make both ignore each other as
"self". So the device id is also stored in a small file beside the database in the app-data
directory, created by Rust on first run. At startup, if the id in `sync_identity` differs from the
file, the file's id wins and `sync_identity` is rewritten; the restored data then behaves as a
normal second peer that happens to share history.

## Data model (migration sketch)

Next free migration id at implementation time (42 as of this writing). **Sidecar tables only: no
`ALTER TABLE` on any existing table.** Same shapes as the mobile spec, with `entity_type` now the
table name or `setting`:

- `sync_entity_meta(entity_type, entity_id, field_clocks_json, row_hlc, deleted_at)`, indexed on
  `row_hlc`. For row-clock tables `field_clocks_json` is `{}` and `row_hlc` is authoritative.
- `sync_identity(id=1, device_id, device_name, physical_ms, counter, change_counter, last_publish_counter)`.
- `sync_peers(peer_id, peer_name, last_manifest_json, last_synced_at, last_applied_sha_by_domain)`.
- `sync_id_aliases(entity_type, alias_id, canonical_id, recorded_hlc)`: grow-only, published in the
  entity's domain ([canonical identity](#natural-keys-and-canonical-identity)).
- `sync_recurrence_occurrences(template_id, due_date, outcome, outcome_hlc, device_id)` and
  `sync_recurrence_clears(template_id, cleared_through_date)`: `gtd` domain
  ([recurring occurrences](#recurring-occurrences)).
- `sync_conflicts(id, entity_type, entity_id, kind, local_json, remote_json, detected_at, resolved_at, resolution)`.
  Besides the mobile spec's prompt cases it also records **overwritten edits** (a row-clock LWW or
  field LWW that discarded a concurrent edit) and generator-duplicate drops, so nothing is lost
  silently.

`sync_identity` and `sync_peers` never leave the machine. `sync_conflicts`, `sync_entity_meta`,
`sync_id_aliases` and the recurrence sidecars are published inside the bundles that own their
entities. The registry's "every table is classified" test treats these sidecars like any other table.

`MemoryRepository` parity: sync is meaningless for a non-persistent store, so the new
`AppRepository` methods exist on both classes and the memory implementation reports
`{ supported: false }` from `getSyncStatus` and rejects mutating calls with a clear error. Pure
modules (`hlc`, `registry`, `merge`, `field-clocks`) hold all logic and are shared. Documentation
must keep describing browser preview as non-persistent and non-syncing.

## Code layout

- `src/lib/sync/` (pure): `hlc.ts`, `registry.ts`, `field-clocks.ts`, `merge.ts`, `bundle.ts`
  (encode/decode/filter by domain), `sync-engine.ts` (pull → merge → apply → publish).
- `src/lib/sync/transport-folder.ts` implements the `SyncTransport` interface from the mobile spec
  over new Tauri commands.
- `src-tauri/src/sync_folder.rs`: `sync_publish`, `sync_list_peers`, `sync_read_bundle`,
  `sync_device_id`. Same containment rules as `backup.rs`; dedicated unit tests for path building,
  partial-file handling and generation pruning.
- `src/app/use-multi-device-sync.ts`: startup pull, focus/hourly pull, debounced publish, quit hook.
- `src/pages/SyncPage.tsx` (`/sync`): peers with last sync time and schema/app version, pending
  change count, last error, "Sync now", join flow, conflict and overwritten-edit log. A compact
  status chip in the shell links to it. A small card in Settings enables the feature per device and
  chooses scope.
- `AppRepository`: `getSyncStatus`, `ensureSyncIdentity`, `listSyncChanges(domain)`,
  `applySyncBundle(domain, bundle)`, `listSyncConflicts`, `resolveSyncConflict`, and optionally
  the mobile spec's `runDailyGenerators`.
- `src/app/device-profile.ts`: `getDeviceProfile()` and the route/feature gate used by `AppShell`,
  the router and `AppProvider` startup jobs.

⚠️ `applySyncBundle` must be one `writeTransaction` that calls the `…Internal(db, …)` writers and
never the public `saveTask`/`completeTask`/…, each of which acquires the writer queue; re-entry is
rejected and watched by the 15-second watchdog. Merge-applied writes must not stamp new local clocks
or fire the capture triggers (a transaction-scoped "applying" flag in `sync_identity`), otherwise
every merge would re-dirty the receiver and two laptops would ping-pong forever.

## Work profile

A work laptop is typically employer-managed. The user's decision: it gets the **entire GTD list and
Pomodoro**, with no work/personal split inside GTD, and **nothing else**. Four layers enforce it.
The first is the real boundary; the other three are backstops in case it fails:

1. **What the machine can open.** The work laptop is only ever given the shared GTD folder. The
   personal folder (bundles for `personal` and `finance`, plus full-database backups) is not
   reachable from it.
2. **What gets published where.** `personal` and `finance` bundles are only written to the personal
   folder; the shared GTD folder only ever receives `gtd` bundles, whichever device writes them.
   The registry is the single source of each table's domain and is tested.
3. **What gets applied.** A `work` device applies only `gtd` bundles; any other domain found
   anywhere is refused and reported.
4. **What the UI offers.** On a `work` device, the shell and router expose only the GTD and
   Pomodoro routes: `/inbox`, `/next-actions`, `/scheduled`, `/projects`, `/waiting-for`,
   `/someday-maybe`, `/references`, `/recurrences`, `/pomodoro`, `/parametres` (reduced), and
   `/sync`. The index route lands on Next Actions instead of `TodayPage`, which mixes daily metrics,
   relationship cards, quotes/verses and finance alerts. Morning routine, evening closure, weekly,
   mid-week and monthly reviews, annual goals, history, journal, finance and the AI coach are not
   registered, so no personal data can be *created* there and stranded.

Other work-profile rules:

- Settings shows only language, sync, Pomodoro/GTD-relevant options, LLM bridge and backup. The
  LLM bridge stays available, so an LLM client on the work laptop can still add tasks from work
  email.
- AI features are off and their settings hidden. No OpenRouter key is needed or stored there.
- **Backups on the work laptop** are optional and go to a destination of its own (a local or work
  folder), never the personal folder. The personal laptops already back up every `gtd` row, so the
  work laptop's backup only protects work done there since its last publish.
- **Profile changes are deliberate.** `work` → `personal` asks for the personal folder and then
  imports the other domains. `personal` → `work` on a database that holds personal or finance rows is
  refused. The user starts the work laptop from a fresh database instead, so personal rows are never
  left in a work database that merely hides them.
- **A work device starts from a database with no personal or finance rows.** If the laptop was used
  before sync with daily entries, reviews, goals, AI rows or finance, joining as `work` is refused.
  The app shows counts per domain and explains the manual path: quit, move the database file and any
  backups it made off the machine (for example to a personal laptop, which can join as `personal` and
  merge them), then restart for a fresh database. There is no "keep them local" option, because
  hidden rows and the backups containing them would still be readable on the work laptop. The app
  never deletes or archives that file itself (the `AGENTS.md` data-safety rule).
- A `work` device re-checks this at every startup. If personal or finance rows ever appear (a bug, or
  a database copied in by hand), sync pauses with an error rather than continuing.
- Secrets (OpenRouter key, RescueTime key, LLM bridge token) are never published on any profile,
  even though they already sit inside plaintext backups on personal laptops.

The opposite direction needs a conscious choice too. Work tasks reach the personal laptops, where
the AI coach, with `aiPayloadScope = "full"`, can include task titles in OpenRouter requests. See
open question 2.

## Failure modes

| Situation | Behaviour |
|---|---|
| Folder unmounted / Drive not running | Pull and publish skip with a visible, non-blocking warning; the app works locally; retry on the next trigger. |
| Bundle partially uploaded | `sha256`/`bytes` mismatch, treated as "not yet"; previous state kept. |
| Corrupt or unparsable bundle | Rejected as a whole, nothing applied, error shown with the peer name; the peer's previous generation (kept) may still be usable. |
| Drive conflict copy (`manifest (1).json`) | Ignored, warned once. |
| Laptop clock far off | HLC prevents a fast clock from winning every tie forever; warn when a peer's `hlcHigh` is more than 5 min ahead of local time. |
| Both edit the same field offline | Later HLC wins; the loser is written to `sync_conflicts` as an overwritten edit. |
| Complete vs cancel on the same task | Conflict queue prompt, per the mobile spec. |
| Merge throws midway | Transaction rolls back; the database is untouched; the pre-merge backup exists for the first-merge and skew cases. |
| Both laptops publish at the same moment | Different directories, no interaction. |
| Calendar sync enabled on both laptops | Both reconcilers would fight. Manifest carries `calendarSyncEnabled`; enabling it on a second device shows a blocking warning naming the other laptop. |
| Pomodoro running on laptop A, user opens laptop B | B shows no running timer (A's is not published). Documented behaviour. |
| The backup/personal folder is picked as the shared GTD folder, or one is nested in the other | Refused at configuration time. Rust writes a `.trackdidia-folder-role` marker (`personal` or `gtd`) into each configured folder, and a folder carrying the other role's marker, or containing `backups/`, cannot be chosen as the GTD folder. |
| A non-`gtd` bundle or manifest domain appears in the shared GTD folder | Never applied, by any device. Shown as an error naming the writer, because it means a bug or a misconfigured peer. |
| Work device finds personal data in its own database | Sync pauses with an error on `/sync`; nothing is published, applied or shown; the fresh-database rule above explains the fix. |
| Two personal laptops back up into the same `backups/` | Today they would prune each other (30-file shared cap, no device in the file name). When sync is enabled, backup file names gain the device id and retention counts per device. This is a small change to `backup.rs` and `docs/storage-and-backups.md`, done in Phase 2. |

## Phases

Each phase is independently shippable and leaves single-laptop behaviour unchanged.

0. **Prerequisites.** `createEntityId` fallback, device-id file in Rust, and a test that every
   generator is a no-op write when there is nothing to do. Valuable on their own.
1. **Engine, no transport.** `hlc`, `registry` (with the "every table and setting is classified"
   test), `field-clocks`, `merge`, sidecar migration, capture (triggers + explicit), tombstones,
   `applySyncBundle`/`listSyncChanges`. Includes the trigger-versus-explicit spike. Proven entirely by
   two in-memory SQLite repositories (below).
2. **Folder transport and profiles.** `sync_folder.rs` with folder roles and markers, `bundle.ts`,
   manifest and verification, device profile with domain filtering on publish and apply, per-device
   backup names, manual "Sync now" in a minimal `/sync` page, behind `multiDeviceSyncEnabled`.
   Profile plumbing lands here, but only `personal` is selectable.
3. **Lifecycle integration.** Startup pull-before-generators, focus/hourly pull, debounced and
   on-quit publish, view reload, status chip, generator duplicate rules, profile-gated startup jobs,
   backup/sync coordination.
4. **Work shell, join, gates, conflicts.** Work-profile route set and reduced Settings, join flow
   (empty and non-empty, per profile), profile-change rules, schema/stale-peer gates, conflict and
   overwritten-edit UI, calendar-sync warning.

**The `work` profile becomes selectable only in Phase 4**, once every protection it depends on has
shipped together: folder roles and markers, domain filtering on publish and apply, the
fresh-database requirement and startup re-check, the work shell and route set, profile-gated
startup jobs, the backup-destination rule for non-empty joiners, and a passing three-device
isolation test. No earlier phase offers work activation, even behind a flag in a release build.

5. *(Optional)* Envelope encryption of bundles; incremental bundles if full-state size becomes a
   problem; shared Pomodoro timer.

## Verification

Run from the repository root; `npm run verify:all` is the full CI mirror. Rust changes also need
`cargo check` and `cargo clippy -D warnings` on `src-tauri/Cargo.toml`.

The cheap, high-value harness: **two `TauriSqliteRepository` instances over
`createNodeSqliteDatabase()` (real in-memory SQLite, so real triggers) plus a transport that writes
to a temporary directory is a complete two-laptop simulation** with no Tauri and no network. The
existing contract tests already use this adapter.

- `hlc.test.ts`: monotonicity, causal advance on receive, skewed-peer resistance.
- `registry.test.ts`: every migrated table and every `AppSettings` key has a domain and a class; no
  secret key is published; no `gtd` table column references a non-`gtd` table; the `gtd` settings
  list is exactly the reviewed allowlist (a new key cannot join it by default).
- **Profile isolation** (three-device simulation: personal A, personal B, work W, with two temporary
  folders and W given only the GTD one): after any sequence of edits on all three, W's database
  contains zero rows in every `personal` and `finance` table, and no file W can read contains them;
  A and B converge on everything; W converges with A and B on every `gtd` table. Also: W never runs
  relationship draws; W's work-done Pomodoro sessions and task completions appear in A's suggested
  daily metrics.
- Work shell: personal routes are not registered on a `work` device (navigation to `/journal` falls
  back), and the index route is Next Actions.
- `merge.test.ts`: one case per row of each merge table (including category-source precedence,
  monotonic dates, terminal-beats-pending, generator-duplicate drop).
- `recurrence-occurrences.test.ts`: complete-old (A, Oct 15) vs generate-new (B, Oct 16) in both
  merge orders gives Oct 15 completed, Oct 16 active, backlog 0, and no extra occurrence generated;
  `clearPastRecurrences` on A, then B publishes an unrelated edit carrying its old backlog, keeps the
  backlog cleared; complete vs missed for one occurrence; complete vs cancel prompts.
- `natural-keys.test.ts`: the registry's unique keys equal the schema's unique columns and indexes;
  the same CSV imported independently on two personal peers, each copy carrying different splits,
  suggestions and an edit, converges in both orders to one canonical transaction with references
  remapped and no bundle rollback; the same for account `external_key`, import profile signature and
  pending suggestions; an undeclared unique violation aborts the bundle with a named error.
- Finance categorization: B's `user` split categorization, then A removes the final split, then B
  publishes an unrelated edit: A's reset holds and no split is restored; concurrent automatic vs
  `user` keeps `user`.
- Relationship draws: two same-date draws with identical `createdAt` converge in both merge orders,
  including when one copy was completed or had events before the merge; new deterministic draws on
  two peers produce identical rows.
- Join and backup: default fresh `work` join with an empty `backupDestinationDir` imports without a
  backup (verified-empty skip); non-empty `personal` join requires a destination and backs up first;
  `work` join on a database holding any personal or finance row is refused; the personal folder
  cannot be chosen as a work backup destination; personal rows appearing on a `work` device pause
  sync.
- `merge.property.test.ts`: **convergence** (any application order of the same bundles yields
  identical state) and **idempotence** (re-applying changes nothing, and does not re-dirty).
- `sync-engine.test.ts` scenarios: edit on B while A is closed; concurrent edits to one task's
  different fields (both survive); same field (later wins, loser logged); delete on A + edit on B
  (resurrect); delete on A, then B pulls (gone); complete-vs-cancel prompt; both laptops generate
  today's recurrence and draw; running Pomodoro not published; three days of single-laptop use then
  merge.
- `transport-folder.test.ts` and Rust tests: `.partial` files ignored, manifest-last commit, sha
  mismatch retried, `(1)` copies ignored, two generations kept, dev uses `sync-dev/`, unmounted
  destination, path containment.
- Skew and gates: newer-schema peer skipped, older-schema peer merged, stale-peer refusal, joiner
  with and without existing data, cloned-identity repair.
- Bootstrap: with a transport that never returns, bootstrap still completes inside its budget and does
  **not** activate the memory fallback; a background merge triggers view reload.
- The suite pins `TZ: America/Toronto`; inject date providers rather than changing TZ.

Manual, on two real laptops (cannot be faked in CI):

1. Enable on the personal laptop, publish; join from the work laptop as `work` with an empty database;
   compare task, project, context, recurrence and Pomodoro counts; confirm the work laptop's Drive
   cannot see the personal folder and its app shows no personal screens.
2. Add a task on 2, quit, start 1: it appears before the recurrence/draw startup jobs run.
3. Edit different fields of one task on both while offline; sync; both edits survive.
4. Delete a task on 1; start 2; it disappears. Edit a task on 2 that 1 deleted; it comes back.
5. Unmount the folder, use both, remount; everything converges, no duplicates of today's recurrence
   or relationship draw.
6. Run one laptop on an older app version: the newer one reports the skew and stays usable.

**Before the first real merge on each laptop, take a manual backup from Settings.** There is still
no restore UI.

## Documentation (required by `AGENTS.md`)

- New canonical page `docs/multi-device-sync.md` with log `docs/logs/multi-device-sync.md`; register in
  `docs/index.md`, the quick-reference table in `AGENTS.md` **and** the identical one in `CLAUDE.md`
  (CI runs `cmp AGENTS.md CLAUDE.md`); add the new domain log to `docs/log.md`.
- Update `docs/storage-and-backups.md` (sidecar migration, `sync/` folder beside `backups/`, the
  relationship between backups and sync, the recovery procedure's device-id behaviour),
  `docs/architecture.md` (boot flow, pull-before-generators), `docs/ai-settings-and-privacy.md`
  (what is published, device-local keys, per-domain scope), `docs/recurrences-and-pomodoro.md`
  (terminal-only Pomodoro sync, monotonic recurrence fields), and `docs/calendar-sync.md` (one
  reconciler laptop), each with a log row.
- Remove "Cloud sync or multi-device conflict resolution" from *Current product boundaries* in
  `AGENTS.md`/`CLAUDE.md` only when a phase that delivers it ships. Docs describe shipped behaviour
  only.
- Move this spec to `specs/done/` only after implementation, tests and docs have shipped.

## Risks, ranked

1. **Corrupting the only real database.** Sidecar-only schema, single-transaction apply with rollback,
   forced backup before the first merge and on schema skew, and no restore UI as the known gap.
2. **A missed capture path means a row never syncs.** Triggers cover tables written by bulk paths
   (finance import); the self-healing scan from the mobile spec stamps any row with no meta or a stale
   clock, turning a silent bug into a one-cycle delay.
3. **Silent data loss from a wrong merge rule.** Per-field clocks, edit-wins-over-delete, and the
   overwritten-edit log: a visible record of every discarded concurrent edit.
4. **Row-clock tables and JSON blobs.** `ai_memories` and finance rows lose a concurrent edit to the
   same row. Acceptable for single-user use; the log makes it recoverable.
5. **Resurrection after a long offline period.** Bounded by tombstone retention and the stale-peer
   refusal.
6. **Drive behaviour outside our control** (streaming mode, propagation delay, partial files).
   Mitigated by manifest-last commit, hash verification and read timeouts, but real-device testing
   is the only proof.
7. **Bundle growth.** Full-state finance bundles could reach tens of MB. The domain split keeps the
   `gtd` bundle (the one republished most often, and the only one the work laptop downloads) small;
   measure on the real database before deciding whether incremental bundles (Phase 5) are needed.
8. **Personal data reaching the employer laptop.** The boundary is folder access, which depends on
   how Drive is set up on the work laptop, not on code. Mitigated by the role markers, the guided
   setup, domain filtering on publish and apply, the work shell, and the three-device isolation
   test. The residual risk is a user later sharing the personal folder with the work account by
   hand.

## Open questions

Resolved: work laptop scope is `gtd` only (entire GTD list + Pomodoro, no work/personal split
inside GTD); reviews, journals, goals, AI and finance stay on personal laptops; secrets are
device-local.

1. **Drive setup on the work laptop.** Is the work laptop's Drive for Desktop signed into the same
   personal Google account (then selective sync, a weaker boundary because the browser still
   reaches everything) or a separate account with only the GTD folder shared to it (recommended)?
   Or is Drive for Desktop not allowed on the work laptop at all, which would need another
   transport?
2. **Work tasks and the AI coach.** On personal laptops, should tasks created on the work laptop be
   excluded from OpenRouter payloads (for example tasks under a `Work` context or project), or is
   sending their titles acceptable? This touches employer confidentiality, not just personal
   privacy.
3. **Triggers versus explicit writes** for change capture. Recommendation above is hybrid; Phase 1
   spikes it against the finance import path and the transaction/writer-queue rules before locking
   it.
4. **Encryption.** With folder separation, is a plaintext `gtd` bundle in the shared folder
   acceptable (it holds work tasks and personal tasks alike), or should v1 add a passphrase-derived
   key for that folder?
5. **Calendar sync.** Is "one reconciler laptop, warn on the second" enough, or should link rows sync
   so either laptop can run it? Which laptop should own it?
6. **Relationship-draw tasks at work.** They are GTD tasks and therefore appear on the work laptop,
   per the "entire GTD list" decision. Confirm, or exclude tasks whose `source_external_id` marks them
   as relationship draws.
7. **Are the laptops ever used at the same time?** If never (one at a time, quit before switching),
   publish-on-quit plus pull-at-start is sufficient and the debounced mid-session publish can wait.
8. **More than one personal laptop?** The design supports any number; if there is only one personal
   laptop today, the personal folder's `sync/` stays empty until a second one joins, and only the
   per-device backup naming matters now.
