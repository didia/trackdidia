# Multi-device sync (experimental)

See also: [changelog](logs/multi-device-sync.md).

TrackDidia can synchronize desktop devices through folders mirrored by Google Drive for Desktop
or another folder service. Personal devices use separate GTD and personal folders; a work device
uses only the GTD folder. Sync is opt-in and supports multiple personal peers. The transport, schema
and merge details are in [storage and backups](storage-and-backups.md); the design is recorded in
[`specs/done/multi-laptop-sync.md`](../specs/done/multi-laptop-sync.md).

Automatic triggers and the work isolation boundary are covered by simulations; a real multi-laptop
desktop smoke test has not been performed. Keep recent backups: there is no restore UI.

## What is and is not available

Personal devices sync GTD, terminal Pomodoro history, journals, reviews, goals, AI data, finance
and shared settings. Work devices get the whole GTD list and terminal Pomodoro history, but no
personal or finance data. The guided join, manual sync, automatic triggers, peer status, conflict
queue, stale-peer approval and first-merge safety backup are available on the desktop. Browser
preview has no persistent sync. Nothing runs while the app is fully closed.

## Joining an existing laptop

With sync disabled, Settings offers a guided join. Choose a profile,
folders and a device name, inspect the local and peer domain counts, then explicitly select a
peer and confirm. Only that peer is imported; normal schema and stale-peer gates still apply.
Missing peer domains are shown as pending, not as zero; joining stays disabled until every domain
required by the profile is available, and the pull rechecks coverage before enabling sync.
Folder and profile choices remain staged until confirmation. A failed setup leaves sync disabled;
if setup progressed as far as saving the profile and folders, the same choices can be resumed.
The personal profile uses the personal backup folder and the separate shared GTD folder.

A verified empty database can skip the first safety backup. The first apply checks emptiness again
inside its write transaction; if local data appeared, it refuses the merge. A nonempty database
requires a backup destination and a backup before any merge. A work join refuses personal or finance
data and uses only the GTD folder. Moving
a database and its backups to a personal location before starting with a fresh work database is a
manual operation; the app does not move, archive or delete them.

## The gate

Sync is opt-in on each desktop. The Settings card is available without debug mode; the `/sync`
page, navigation entry and automatic triggers require `multiDeviceSyncEnabled`. In browser preview
or startup fallback, persistent sync is unavailable and actions are disabled.

## Settings

Five `AppSettings` keys, all **device-local** in the sync settings registry
(`src/lib/sync/registry.ts`): they live in this laptop's settings row and are never published in a
bundle, never applied from one, and a registry/privacy test fails if one is classified otherwise.

| Key | Default | Meaning |
|---|---|---|
| `multiDeviceSyncEnabled` | `false` | Sync was enabled on this laptop (identity created, capture installed, folders prepared). |
| `syncProfile` | `"personal"` | `"personal"` or `"work"`; an invalid value normalizes to `"personal"`. The repository reads this stored value when it applies a bundle ([guards](#work-profile-guards-and-shell)). |
| `profileDecisionMadeAt` | `""` | Device-local marker recording the initial profile decision. |
| `syncGtdFolderDir` | `""` | The shared GTD folder. |
| `syncDeviceName` | `"Cet ordinateur"` | How this laptop is named to its peers (at most 100 characters). Give each laptop a different name. |

The **personal** folder is the existing `backupDestinationDir` (the backup folder): the personal
bundles go beside `backups/` in `{backupDestinationDir}/sync/` (`sync-dev/` in development). No
setting remembers the last error or the last sync time: both are derived from the engine's reports
and the `sync_peers` table.

## Enabling (Settings card)

`enableSync` (`src/lib/sync/sync-service.ts`), run by the card's "Activer la synchronisation":

1. Refuses outside the desktop app or without a device name and the folders required by the profile: personal uses both the backup and shared GTD folders; work uses the GTD folder.
2. Refuses a shared GTD folder that is the backup folder or lies inside or around it, before the native
   host is asked (`folder-paths.ts`, case-insensitive and separator-insensitive). The picker applies
   the same rule when the folder is chosen. The native host then enforces it again with canonical
   paths and role markers ([Sync folder commands](storage-and-backups.md#sync-folder-commands)).
3. Prepares the shared folder as role `gtd`; a personal device also prepares its backup folder as
   role `personal`. The other configured folder is passed to the host for the nesting check. A rejected
   folder is reported with which folder it was.
4. Reads the device id from the native device-id file and runs `ensureSyncIdentity`. If the stored identity
   belonged to another laptop (a cloned or restored database) it is rewritten to this device's id with its
   clock state kept, and the card says so.
5. Runs `enableSyncCapture` and then the remaining backfill chunks: a short first transaction installs the
   change-capture triggers, then every existing synced row is stamped in **bounded writer slots** (about
   1,000 rows each) with the app free to run in between, and a progress bar with the percentage. The card
   shows "Initialisation du suivi des changements, par petites étapes…" and, when done, how many entities
   were initialized and how long it took.
6. Saves `multiDeviceSyncEnabled` once every row is initialized.

Every step is safe to run again after a failure. **Large databases.** The backfill used to be one write
transaction (8.6 s in process for a synthetic 71,146-entity database, 17.1 s at twice that, plus every
statement's IPC cost, during which any other write queued for more than 15 s was rejected). It is now
chunked and resumable: the longest slot measured is about 0.1 to 0.3 s in process (see
[Chunked capture backfill and chunked apply](storage-and-backups.md#chunked-capture-backfill-and-chunked-apply)),
so the app stays usable and an edit made during the enable is captured as usual. The progress is saved after
every chunk: if the app is quit or crashes, nothing is lost, sync stays off, and the Settings card and the
`/sync` page (both read the stored progress when they open, even while sync is still off) show the unfinished percentage with **"Reprendre l'initialisation"**,
which carries on from where it stopped. **While the initialization is unfinished nothing is published and
nothing is merged** (`/sync` says so); the engine reports `backfill_incomplete`.

**Disabling** ("Désactiver la synchronisation") only turns `multiDeviceSyncEnabled` off. The identity, change
capture and every file already in the folders stay (nothing is deleted from Drive), edits are still captured,
and enabling again is a catch-up. "Revérifier les dossiers" re-prepares the profile’s folders after the backup folder
or the shared folder was changed.

## The `/sync` page

French, keyboard-operable like the other pages. It reads its state when opened and shows:

- **Pending changes** not yet published.
- **Autres ordinateurs**: one row per known peer with name and short id, last sync time, app version and
  database (schema) version, profile, a state (`À jour`, `Mise à jour requise`, `Hors ligne trop longtemps`,
  `Format non pris en charge`, `Manifeste invalide`, `Envoi en cours chez ce pair`, `En attente` (not merged yet
  because the time budget ran out; the next run continues), `Erreur`, `Dossier inaccessible`, `Pas encore vu`) and
  the engine's detail. A peer in `Erreur` whose first merge was halted because the safety backup could not be made
  shows the run-wide reason in French with a link to Settings. Files a folder listing ignored (Drive conflict
  copies, stray files) are listed under the table.
- **Stale peers.** A peer offline for 90 days is refused by default. Its row explains why and offers
  "Fusionner quand même", which needs a second confirming click and then approves exactly that peer for the
  next run.
- **Dernière synchronisation**, the last "Synchroniser maintenant" (automatic runs are not listed here: the sidebar chip and the debug log carry them), kept while the app runs (not stored): applied bundles, applied and already
  up-to-date items, tombstones, conflicts logged (also listed in the conflict queue), the **safety backup** result
  with its path, skipped peers with the reason ("mets à jour TrackDidia pour synchroniser avec cet ordinateur",
  "hors ligne trop longtemps"), clock-skew notes, and per domain whether it was published, unchanged, had no
  folder, or failed.
- **Notes (information, not alarms).** "Dossier non connecté : …" when changes stay pending because no folder
  carries a domain this laptop may publish (they are published on reconnection; the pending count stays above zero),
  and "La publication des données … a été remplacée par une plus récente" when a publish that outlived the engine's
  timeout was overtaken by a newer one (the folder transport's fencing; nothing is lost).
- **Errors.** Failures retrying cannot fix are shown first, in an alert: a **configuration** error (the folder
  carries the other role's marker, or is nested with the other folder: "choisis un autre dossier"), a **bundle too
  large** for the folder protocol (persistent: nothing is published for that domain until the data shrinks),
  a format this laptop cannot read, or an internal error. A folder that is simply not there (Drive not mounted) or
  slow is an ordinary warning that the next "Synchroniser maintenant" retries. The engine's English message stays
  available under "Détail technique".

Merged data is visible in pages opened afterwards; pages already open show it when you return to them, and
settings merged from a peer are republished to the app's copy after a run that applied anything.

## Automatic triggers

Everything below exists only while `multiDeviceSyncEnabled` is on, on the desktop
storage (`isSyncAutomationEnabled` / `syncAutomationKeyFor`, `src/lib/sync/gate.ts`). When sync is off, nothing is
built: no engine at startup, no window listener, no timer, no pull, no close handler, no status chip, and the
backup scheduler gets no lane; the app behaves exactly as it did before sync existed (tests pin each of these).
Turning the setting off in a running session tears all of it down; changing a folder, the device
name or the profile rebuilds it.

| Trigger | What happens | Limits |
|---|---|---|
| **Startup** (inside bootstrap) | Pull from the other laptop BEFORE the two GTD normalizations, recurrence generation, Scheduled promotion and relationship draws, so a task already completed on the other laptop is not regenerated and today's draw made there is not repeated. Then publish what is pending (step 6 of the spec's flow). | Bootstrap waits at most **4 s** (less if bootstrap already spent time: never past the 8 s deadline minus 2.5 s) for the pull; past that it carries on and the same pull keeps running in the background (chip: "Synchronisation…"; open screens reload when it applies). It never throws into bootstrap, and its safety backup and later apply pieces do not take the writer until bootstrap is over ([below](#startup-ordering-the-8-second-rule-and-chunk-resumption)). |
| **Window focus / becoming visible** | Pull. | At most once per **60 s** (any pull counts, startup included). |
| **Hourly** | Pull. | Every 60 minutes while the app runs. |
| **Manifest heartbeat** | Run the engine publish path although nothing is pending, so a manifest older than 30 days is rewritten ([why](storage-and-backups.md#per-domain-change-detection-and-the-manifest-heartbeat)). | Peers refuse a manifest older than 90 days, and a clean device never publishes for pending changes, so without this a laptop with no new edits would age out while online. Once per session right after the startup publish step (or at the first hourly tick when there is none; the manifest age, not the process uptime, is what matters, so a restart evaluates again), then at most once per **24 h** on the hourly tick; any successful publish counts as that day's evaluation. On a fresh manifest it is one folder listing and writes nothing. It respects the backoff, the "paused" state, a run in flight, a manual action, an unfinished backfill (the engine publishes nothing then) and the exclusive lane; a failed one is not counted and is retried by the next hourly tick. |
| **Local changes** | Publish. | A 15 s poll of one row (`pendingChanges`, a single counter comparison) notes when changes were first seen; they are published when the first is **2 minutes** old. Further edits do not push the deadline back. |
| **Window blur / hidden** | Publish what is pending, at once. | |
| **Quit** (window close) | Publish what is pending, best effort. | Waits at most **3 s** in total (for a run in flight to end, then for the publish), then the window closes whatever happened; a pull that is still running at the cap means nothing is published. In tray mode the close handler publishes nothing and keeps the window alive for the native handler to hide (hiding blurs it, which already publishes). |
| **Quit** (tray **Quitter**) | The same capped publish, then the process exits. | The tray action exits the process without closing any window, so the close handler never runs for it. While automation is on the webview tells the host (`desktop_set_exit_handshake`) that it answers a quit request; **Quitter** then emits `desktop-quit-requested` instead of exiting, the webview runs the same capped publish and calls `desktop_exit`, and the host exits anyway after **4 s** if no answer comes (a stuck or missing webview cannot keep the app running; a second **Quitter** while one waits exits at once). A failing publish or a failing `desktop_exit` still ends in an exit. When settings rebuild the lifecycle, the old registration's event callback is made inert synchronously on release (its listener stays attached until the host has been told to stop waiting), so a Quitter in that window is answered only by the current registration: it publishes first and exits once, and with no live registration the host's 4 s timer (or its already-off flag) ends the quit. With automation off nothing is registered and the host is never told to wait, so **Quitter** exits at once exactly as before. Other exits (for example the macOS application menu's Quit) are not intercepted. |
| **Synchroniser maintenant** | Pull then publish, always. | Ignores and resets the backoff and the "paused" state; waits for an automatic run already in flight, and runs in the same exclusive lane as backups. |

A trigger that finds a run in flight is dropped, not queued, and no automatic trigger runs while a manual action
(Sync now, enable, resume, folder recheck) holds the controller. A run waiting for the exclusive lane (behind an
automatic backup, say) re-checks, once it has the lane and again once its engine is built, that its lifecycle is
still the running one; if sync was turned off or rebuilt meanwhile (`stop()`), it builds no engine, touches no
folder, records nothing and reports nothing, so disabling sync really stops everything queued. Pulls apply the data in the same chunked slots as
Sync now ([details](storage-and-backups.md#chunked-capture-backfill-and-chunked-apply)).

### Startup ordering, the 8-second rule and chunk resumption

`useBootstrap` builds the engine once (`src/lib/sync/startup-sync.ts`), starts the pull, and hands both to
`useMultiDeviceSync`, which adopts them: there is **one engine per session** (one in-flight guard, one publish
memory).

**What is guaranteed about the 8-second rule.** The 4 s is a **wait** budget, not a work budget, and it is
bounded by the deadline: `min(4 s, 8 s deadline - time bootstrap already spent - 2.5 s)`, counted from the moment the
step starts and including building the engine (a device-id read and an identity write). If the engine is not built
when the wait lapses, or no time is left, there is no startup pull (the hook builds its own engine later).
Once the wait has lapsed the pull continues in the background but **cannot hold the SQLite writer while bootstrap
finishes**: the engine's `beforeWrite` gate keeps the safety backup (one long `VACUUM INTO` slot) back until
bootstrap has settled, and lets an apply piece start only while the wait is open. Consequences, stated plainly:
a pull that needs a backup (a first merge; a schema difference, which every laptop meets once after migration 47
if its peer is still on 46) **merges nothing during bootstrap** and does it right after, in the background, while
the day's generators have already run (they converge with the merge); a pull that needs no backup applies its
pieces inside the wait. What is NOT guaranteed: a writer slot that began inside the wait (one apply piece, about
0.1 to 0.3 s in process, projected near 1 s with the real IPC cost, which is unmeasured) can overrun the wait, which
is what the 2.5 s reserve is for.

**Chunk resumption.** The pull is not given an engine `budgetMs`: past the gate it runs unbudgeted. This is how the
slice-14 obligation (the chunk resume index is in memory, so a budgeted first merge of a very large bundle
restarted at chunk 0 after every restart) is discharged: no automatic path ever cuts a merge, so the only thing
that can interrupt a very large first merge is quitting the app, after which the next start repeats the bundle
from its first chunk, in the background, to the end (chunks already applied merge as no-ops, about 60 % of the
first cost). The trade-off: a first merge that quits mid-way is repeated, not resumed. A persisted per-chunk
cursor was NOT built. The engine's `budgetMs` option remains for tests and callers that want it.

If the folder is slow and a generator ran before the pull finished, the merge still converges (generators are
deterministic; spec "Generators on several full peers"): the ordering avoids visible churn, it is not a
correctness requirement. A background pull that applied something reloads the open screens (below).

### Backoff, "paused" and failures

A failing folder never blocks the UI and never causes the fallback. A run that finds a folder unreachable or slow,
or any error, backs the automatic triggers off: **30 s, doubling, capped at 15 minutes**; during a backoff
every automatic trigger (pull, publish, quit) does nothing. Something only you can fix (no identity, change tracking
not enabled, the required safety backup cannot be made, a folder rejected by its marker, a folder
setting missing) pauses the automatic triggers until a manual run succeeds or the settings change. An unfinished
change-tracking initialization is neither: the engine pulls and publishes nothing and the chip says so.
`src/lib/sync/lifecycle-policy.ts` holds all of these rules as pure functions.

### Status chip and view reload

A chip in the sidebar (visible with the gate open and sync on; a link to `/sync`) shows one of: **À jour**
(with how long ago), **Synchronisation…**, **Erreur de synchro** (with the time of the next try), **Initialisation du
suivi** (backfill incomplete), **Synchro en pause**.

The calendar day does not change within a day, so after a pull that applied rows `AppProvider` reloads the open
screens through the GTD external-change channel (GTD, Today and Daily) and a reload key on the Pomodoro
controller, and republishes the settings copy; a pull finished before any screen existed announces nothing. This is
the day-boundary republish idea reached by other means, not the same code path. Reviews, Journal and Finance
still load when opened.

### Backups, the safety backup, and per-domain publishing

- **Backup and sync never overlap.** Automatic pulls and publishes (the startup pull and its background tail
  included), "Synchroniser maintenant" and the automatic-backup scheduler's backups run in one exclusive lane
  (enabling and resuming the backfill do not: they take no backup, and holding the lane for a whole backfill would starve the automatic backups); see
  [Backup behavior](storage-and-backups.md#backup-behavior).
- **The first-merge safety backup is taken once**, not on every pull until a bundle completes: its path is
  recorded (`sync_identity.first_merge_backup_path`). A failed backup is retried and merges nothing meanwhile.
  The record is never cleared: a first merge that stalls for weeks (a peer that keeps failing) later continues
  against the old pre-merge backup, which is stale by then; take a manual backup before resuming such a merge.
- **Schema skew.** A peer on a newer schema is refused until this device is updated. Merging an older
  schema takes a `schema_skew` safety backup. This release uses schema 49 and format 3.
- **Automatic publishing is per domain.** A task edit rebuilds the `gtd` bundle only; a periodic manifest
  heartbeat (30 days) keeps the untouched folder from looking absent
  ([details](storage-and-backups.md#per-domain-change-detection-and-the-manifest-heartbeat)).

The publisher reads committed counters through the writer queue. Its per-domain cache tracks the
counter covered by each published snapshot, and the global published mark advances only to the
minimum covered counter. A rolled-back write therefore cannot make a later edit look published;
an edit made during publication remains pending for the next run.

Finance categorization and its splits merge as one unit. Versions are ordered by the latest user
choice in their history (`p`), then their write clock (`c`), then canonical payload as a deterministic
tie-break. A pairwise causal/source comparison can cycle: user Y at 10, automatic X at 20 based on Y,
and automatic Z at 30 based on 5 would give X > Y, Y > Z, and Z > X. The total `(p, c)` order
avoids arrival-order-dependent results.

### What was not measured

There is no desktop in the development environment. Not measured, and not claimed: the real Tauri IPC latency per
statement (so `maxEntities` and the other apply limits stay as tuned against the in-process adapter; each
automatic run logs `statusReadMs`, the time of one `getSyncStatus`, and `maxChunkMs`, the slowest apply slot, in
the debug log under `sync.lifecycle`, so a session on a real laptop can read the latency off); the JavaScript heap
inside the real webview (the 350 to 450 MB read of a very large `finance` domain is a Node figure; per-domain
detection only makes it rarer); and the close handler and the tray-quit handshake in a real Tauri window (they are tested against a fake window and a fake event bus; the Rust half of the handshake, `desktop_shell.rs`, is written to mirror the existing tray code but could not be compiled offline: CI's `cargo check` and `clippy` are its first compile).
One more limit of the close handler: in tray mode it decides from the JavaScript copy of `runInTray`, while the native close handler keeps its own state; if they ever diverge (the native `desktop_set_run_in_tray` call failed), the window is kept alive by the handler and not hidden by the host, and cannot be closed by the window button until the setting is fixed.
The native application-menu quit and Cmd+Q paths are not intercepted by the current tray/window handshake.

Manual check on a desktop: edit a task and quit within seconds (the other laptop should receive it), close with
the Drive folder unmounted (the window must still close within about 3 s), and watch the debug log lines above.
With **Réduire dans la barre système** on, repeat both through the tray's **Quitter** (the app must exit within
about 4 s, and the other laptop must receive the edit), and with sync off check that **Quitter** exits at once.

## What "Synchroniser maintenant" does

`engine.syncNow()` ([Sync engine](storage-and-backups.md#sync-engine-transport-seam-and-device-profile)): pull every
peer of each folder available to the profile, then publish. Before the first merge (and when the database schema changed since the last
merge with a peer) the engine requires a **safety backup**, taken by `createBackup("auto", { deviceId })`
into this laptop's backup folder with the per-device name `trackdidia-auto-backup-<deviceTag>-<timestamp>.db`
(retention per device, `prune_backups` given the same id; see
[Backup behavior](storage-and-backups.md#backup-behavior)). A verified empty joiner may skip the first backup; otherwise a missing backup folder prevents the merge. The backup path is shown in the run report and recorded as `lastBackupPath`. There is
no restore UI: recovery stays the manual procedure in [Recovery](storage-and-backups.md#recovery).

While sync is enabled, every backup of this laptop (manual, automatic, safety) is named and pruned per device, using the
id in the native device-id file (not the database's `sync_identity` row, which a copied database inherits from another
laptop), so two laptops sharing one backup folder never prune each other's snapshots.

**A backup never goes to the shared GTD folder.** The backup folder holds full copies of the database, the shared GTD folder
is visible to other accounts. While a GTD folder is set, choosing a backup folder that is the GTD folder, inside it or
around it is refused in Settings, every backup (manual, automatic, safety) is refused with a French error if the stored
settings overlap, an app-wide banner says backups are stopped, and Sync now refuses to start (`/sync` shows the folder
overlap). The native `ensure_backup_dir` refuses a destination that carries or touches a `gtd` role marker too, and it
judges the `backups` / `backups-dev` folder that really receives the database: a symlink there is refused whatever it points
to (a link to the shared folder would otherwise let the backup follow it into that folder), and `prune_backups` applies the
same check. The refusal reaches the user as a typed error (Settings, and `/sync` for the safety backup, which then merges
nothing). Users who
never set a GTD folder see no change.

A bundle above the apply limits (400 entities, 4,000 union rows, 400 aliases, 2,000 recurrence rows per chunk) is
merged as several transactions, in table and reference order, groups that merge rules read together kept whole (up to 1,500 entities; a larger one is cut by id); the
peer's hash is recorded only after the last one, so an interrupted merge is simply repeated. The run report shows
`fusion en N étapes` for such a bundle (and `fusion interrompue après N étapes sur M` when a time budget cut it) ([details and measurements](storage-and-backups.md#chunked-capture-backfill-and-chunked-apply)).

One manual action runs at a time; a second request while one runs is ignored. "Synchroniser maintenant" while an
automatic run is in flight waits for it, then runs.

## Deletes and tombstone values

A delete leaves a tombstone, and since migration 48 the tombstone of a field-clock entity (tasks, projects,
contexts, recurring templates, daily entries, reviews, goals, objectives and their results) also keeps the **last
values of the deleted row** next to its clocks. Consequences you can rely on:

- **Edit wins over delete, and nothing is lost.** Laptop A deletes a task, B edits its notes and C completes it,
  none having seen the others. Whatever order the laptops sync in, the task comes back completed with B's notes:
  the edit that outlives the delete resurrects the entity with the values the tombstone kept, joined field by field.
  Before this change the completion (or an edit to another field) could be lost depending on the order.
- **What is logged.** When a later edit replaces a value that the other laptop had not seen, an *overwritten edit*
  is written to `sync_conflicts` with the real values of both sides (before, a tombstone could only log "unknown").
  The conflict queue shows them.
- **Old tombstones stay valid.** A tombstone made before the tombstone update, or by an older laptop, has
  no values; it merges exactly as before. A deleted row cannot be recovered after the fact.
- **Row-clock data** (finance, Pomodoro history, AI proposals) keeps a tombstone without values: they are compared
  as whole rows, which needs none. Pomodoro tombstones are still never published.

**Updating devices.** Tombstone values arrived in schema 48 and format 2; this release writes format 3 and schema 49. A laptop that is
already on the new version reads format 1 and 2 bundles and manifests. An older laptop refuses format 3 and shows an update warning and merges nothing from it until it is updated (its own
changes keep being published and the updated laptop keeps reading them); update both within the same few days. The first
merge after the update takes the usual safety backup because the schema differs. Details and the format decision:
[Tombstones carry the last field values](storage-and-backups.md#tombstones-carry-the-last-field-values).

## Work-profile guards and shell

The work profile gets the whole GTD list and terminal Pomodoro history. Its protections include
folder separation, publication and apply guards, a restricted shell, and a fresh-database check:

1. **What the machine can open.** `buildSyncEngine` for a work profile builds the shared GTD folder's transport only, even if a
   backup folder is configured, and `prepareFolders` prepares the GTD folder alone (the backup folder is only passed for the
   nesting check). `enableSync` refuses a work profile before any folder, identity or setting is touched when the database holds
   personal data.
2. **What gets published where.** Unchanged: the engine and the transport routing (tested again for a work engine).
3. **What gets applied.** The engine refuses non-GTD manifest entries and bundles; and now the **repository** does too, on its
   own: `applySyncBundle` reads the persisted `syncProfile` inside its transaction and refuses (`domain_not_allowed`) any change set
   that carries a row, tombstone, union row, alias or setting of a domain a work database may not hold, even if the engine passed
   it ([details](storage-and-backups.md#work-profile-guards-in-the-repository)).

**Work shell and jobs.** The stored device profile controls the shell even when sync or debug is off. A work device opens Next Actions at `/`, registers GTD, Pomodoro, sync and Settings routes only, and redirects unknown paths to `/`. Settings retains calendar, LLM bridge, backup and sync controls while hiding personal, AI and finance controls. Startup skips the AI settings upgrade, relationship draws and finance seed; runtime skips coach pulse and finance snapshots and alerts; Sunday-note relocation runs only during personal bootstrap, after the profile decision. GTD day reconciliation and Pomodoro remain active. If startup falls back after reading the profile it preserves that profile; before the profile is known, the fallback uses the restricted work shell.

**What counts as personal data.** `AppRepository.inspectSyncProfileData` counts, per domain, the rows of the domain's tables,
the **sidecar rows** that describe such an entity (`sync_entity_meta` clocks and tombstones, `sync_entity_snapshot` copies,
`sync_id_aliases`, `sync_conflicts`, `sync_dirty` marks; routed by `entity_type`, so they are found even when the table row is
gone) and the personal or finance settings that differ from their defaults. A fresh database passes: the three seeded finance
categories (and the default taxonomy), their clocks and snapshots, and the markers the app writes itself are whitelisted. A
seeded category is whitelisted only **while it is still exactly the shipped seed**: rename "Pharmacie" to a medication (or change
its parent, kind, archive state, flags or order) and it is finance data, so a database that holds it can neither become nor join as
a work database, and a work device that holds it pauses; deleting a seeded category counts too, and so do the conflicts and
aliases about one ([details](storage-and-backups.md#work-profile-guards-in-the-repository)).

**Profile-change rules** (pure, `profile-rules.ts`, called by the guided join through `changeSyncProfile` and `enableSync`):

| Change | Result |
|---|---|
| same profile | no-op, nothing read or saved |
| `work` to `personal` | allowed; next steps are choosing the personal folder, then importing the other domains |
| `personal` to `work`, no personal or finance rows | allowed (GTD and Pomodoro rows alone are fine) |
| `personal` to `work`, any personal or finance row | **refused** (`SyncSetupError` code `work_profile_data_present`, with `counts` per domain); nothing is saved |
| joining as `work` on a non-empty personal database | the same refusal |
| joining as `personal` | allowed; a database that holds data needs a backup first, an empty one skips it (`decideJoin`) |

There is no "keep them local" option and the app never moves, archives or deletes the database file: the manual path (quit,
move the file and its backups off the work machine, restart for a fresh database) is for the person.

**Startup re-check.** A work engine looks at its own database before every pull and publish (`engine-profile.ts`): once per
engine (so at every startup, inside the 4 s startup pull and never in `initialize`), then again after 10 minutes while it is clean,
and at every run while it is not. The look is one-row probes of the personal and finance tables and sidecars (45 statements whatever
the data; the most expensive scans a sidecar's primary-key index, 18 ms in process with 200,000 rows; the IPC cost is unmeasured). If any personal or finance row exists, the run **pauses**: no folder is listed or read, nothing is
applied, nothing is published, and the report carries the error `work_profile_data_present` (counts in `detail`). `/sync` shows it in
the alert area with French text and the manual path; the lifecycle classifies it as blocked, so the sidebar chip reads "Synchro en
pause" and the automatic triggers stop until a manual run succeeds or the settings change (no new chip state). A look that fails is
`profile_check_failed` (retried by the next run). The look runs in the background pull, never in bootstrap's own sequence: a database
or lane that never answers is a startup pull that lapses after its wait and continues in the background (tested through
`bootstrapApplication`), with no fallback and no change to the 8-second rule.

**Schema and stale-peer gates on the work path** (engine gates, tested for a work engine): a peer on a newer schema is skipped
(`update_required`, nothing read, our own state still published), an older one is merged after a `schema_skew` safety backup, a peer
last written more than 90 days ago, or not pulled from for 90 days, is refused (`stale_peer`) until approved. At the repository
boundary a bundle from a newer schema than the database is refused too (`schema_newer_than_local`), even if the engine let it through.

**Cloned device identity.** The device-id file is the authority. Building the engine (`buildSyncEngine`, which runs at every
startup when the gate is open, and when sync is enabled) rewrites a stored identity that came from another laptop (a copied or
restored database), keeping its clock state, logs a warning and reports `repaired`; the copy then publishes under its own id as a
normal second peer (tested with two machines sharing one stored identity).



## Conflict queue and privacy

The `/sync` conflict queue shows overwritten edits and conflicts needing a decision. A decision
travels as its concrete selected value with a resolution clock, so peers can converge even when
“local” and “remote” mean different things on each laptop. Conflicts travel only in their owning
domain. The work device receives GTD conflicts only.

Conflicts about filtered rows get an additional privacy check: both historical payloads must contain
row-shaped snapshots with the matching key and filter fields proving eligibility; a chosen resolution
must satisfy the same check for its value and evidence. An ambiguous or ineligible historical payload
stays in the local queue and is not published, even if its current owner has since become eligible.
Incoming violations are refused. This protects running Pomodoro data and non-statement finance
balance snapshots; ordinary eligible conflicts remain available locally and sync in their own domain.

## Safety

- Plaintext bundles (no encryption in v1); secrets (OpenRouter key, RescueTime key, LLM bridge token) and all
  device settings never enter a change set.
- The shared GTD folder carries only `gtd` bundles; personal and finance bundles go only to the backup folder,
  routed by the folder role and re-checked by the transport and the native host.
- Bundles are verified by size and SHA-256 before use and rejected as a whole when invalid; one bad peer or
  domain never stops the others.
- Always keep a recent manual backup before enabling. There is no undo.

## Limits

- The automatic triggers are described above and are untested in a real desktop window; with the gate closed nothing
  automatic exists. There is still no restore UI, and nothing runs while the app is fully closed (a laptop that is
  off does not sync; the other one publishes and the next start pulls).
- Work isolation depends on folder permissions: use a separate Google account shared only the GTD
  folder. Bundles are plaintext and this boundary cannot prevent someone sharing the personal folder
  with the work account later. Real multi-laptop behavior has not been smoke tested.
- The enable backfill and the apply of a large incoming bundle are chunked (a writer slot of 0.1 to 0.3 s in process
  for the backfill and the usual merge, about 1 s with a simulated IPC cost, and a worst case of about 1,600
  statements for an oversized group; see above), but nothing resumes an interrupted backfill by itself: after a quit the user
  presses "Reprendre l'initialisation". A large bundle that fails or is cut by a restart is applied again from its
  first chunk, at about 60 % of the cost of the first time (the merge has no persisted per-chunk marker; automatic
  pulls are never budgeted, see [above](#startup-ordering-the-8-second-rule-and-chunk-resumption)); once
  it has been applied completely it is never re-read. The memory needed to READ a 130,000-transaction finance
  domain for a publish is the largest cost left (350 to 450 MB of JavaScript heap measured in Node, not in the
  webview): automatic publishing now rebuilds only the domains that changed, which makes it rarer, not smaller, and
  the real webview figure is unmeasured.
- **Disable leaves change tracking installed.** The capture triggers keep recording edits, so enabling again is a catch-up.
  The separate confirmed uninstall action disables sync and removes capture triggers, pending marks and backfill progress;
  application data, backups, folder files, clocks and snapshots remain. Re-enabling verifies and backfills changes made
  while capture was off ([storage details](storage-and-backups.md#multi-device-sync-change-capture)).
- **Minimum system.** Compression needs `CompressionStream`/`DecompressionStream` (WebKit 16.4+, i.e. macOS 13 or a
  recent Safari/WebKit; Chromium WebView2 is fine). On an older system this laptop writes **uncompressed** bundles (about
  12 times larger: a 50,000-transaction finance domain is about 62 MiB, close to the 64 MiB cap, and a larger one is a
  persistent `too_large`) and **cannot read** its peers' gzip bundles (reported as an unsupported-format failure). Finance-heavy
  databases should only sync between laptops that both have a recent system.
- Timeouts: the engine abandons a folder call after 30 s, the native publish and read timeouts are 45 s; a publish that was
  abandoned may still commit. The engine gives up first (30 s), so the transport's later reconciliation result is discarded and the
  next run republishes the same data as one extra generation (harmless); the transport only reconciles host-reported timeouts.
- A bundle over 64 MiB (the folder protocol's cap), or whose uncompressed body passes 512 MiB (what readers inflate),
  cannot be published or read: both are refused when publishing, as the persistent "données trop volumineuses" error,
  before anything is written. Measured encoded sizes stay far below the first cap (see [Sync bundle format and folder transport](storage-and-backups.md#sync-bundle-format-and-folder-transport)).
- Publish serialization is in-process: running two instances of the app with one device identity is not supported.
- Filtered-row conflicts with ambiguous or ineligible historical payloads remain local, as described above.
- Settings merged from a peer reach the running app after a run that applied something. GTD, Today, Daily and Pomodoro
  screens reload after a merge; Reviews, Journal, Finance and the other pages show merged data when opened.

## Code map

| Concern | Source |
|---|---|
| Bundle encode / decode | `src/lib/sync/bundle.ts` |
| Folder transport | `src/lib/sync/transport-folder.ts` (typed commands: `folder-api.ts`) |
| Enable / disable / engine construction / safety backup | `src/lib/sync/sync-service.ts`, `folder-paths.ts` |
| Gate | `src/lib/sync/gate.ts` |
| Work-profile guards | `profile-data.ts` (pure: seeds, routing of sidecar rows, summary), `profile-data-sql.ts` (the reads), `profile-rules.ts` (profile-change and join rules), `profile-guard.ts` (the repository's apply-time check), `engine-profile.ts` (the engine's re-check), `sync-service.ts` (`changeSyncProfile`, `assertProfileFitsDatabase`) |
| State around the engine | `src/app/use-multi-device-sync.ts` (in `AppProvider`, exposed as `useAppContext().sync`) |
| Automatic triggers | `src/lib/sync/lifecycle-policy.ts` (pure rules), `lifecycle.ts` (timers and runs), `startup-sync.ts` (the bootstrap pull), `quit-publish.ts` (close handler and tray-quit handshake; the host half is `src-tauri/src/desktop_shell.rs`: `desktop_set_exit_handshake`, `desktop_exit`), `src/app/use-sync-automation.ts` (window events), `domain-counters.ts` (per-domain change detection) |
| Status chip | `src/components/sync/SyncStatusChip.tsx` |
| Settings card | `src/components/settings/MultiDeviceSyncSection.tsx` |
| `/sync` page | `src/pages/SyncPage.tsx`, `src/components/sync/` |
| French copy | `src/locales/fr/sync.json` |
| Test fakes | `src/lib/sync/test-support/fake-folder-host.ts` (the native commands, in memory) |

Tests: `lifecycle-policy.test.ts`, `lifecycle.test.ts` (fake timers), `lifecycle.heartbeat.test.ts` (the real lifecycle gate over the real engine and in-memory folders: a clean device with an ageing manifest refreshes it, a fresh one writes nothing), `startup-sync.test.ts`, `quit-publish.test.ts`,
`use-multi-device-sync.automation.test.tsx` (the real hook over a real repository and the fake host, including the
"gate closed adds no listener, timer or pull" proofs), `sync-engine.domains.test.ts`, `SyncStatusChip.test.tsx`,
`bundle.test.ts`, `transport-folder.test.ts` (including the real engine over the real bundle codec),
`sync-service.test.ts`, `folder-paths.test.ts`, `gate.test.ts`, `use-multi-device-sync.test.tsx`,
`profile-data.test.ts`, `src/lib/storage/sync-profile-data.test.ts`, `profile-rules.test.ts`, `profile-guard.test.ts`, `sync-engine.work-profile.test.ts`, `sync-service.work-profile.test.ts`, `SyncPage.test.tsx`, `MultiDeviceSyncSection.test.tsx`, `AppShell.test.tsx`, `create-backup.test.ts`, and the
registry, privacy and settings tests listed in the changelog.
