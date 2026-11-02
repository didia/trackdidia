# Multi-device sync (experimental)

See also: [changelog](logs/multi-device-sync.md).

TrackDidia can keep two **personal** laptops up to date with each other through two folders
that Google Drive for Desktop (or any synced folder) mirrors. This page describes what is
shipped: an **experimental, opt-in, debug-gated** build of it, with [automatic triggers](#automatic-triggers)
on top of the manual button. The design,
the remaining phases and the open questions live in
[`specs/todo/multi-laptop-sync.md`](../specs/todo/multi-laptop-sync.md); the engine, change
sets, folder commands, bundle format and transport are documented where they live, in
[storage-and-backups.md](storage-and-backups.md) (links below). This page does not repeat them.

> **Do not rely on this yet.** There is no restore-from-backup UI, the automatic triggers have only
> been exercised against fakes (never in a real desktop window), the `work` profile and the join flow
> for a second laptop are not shipped, and a third laptop is unsupported. The "Cloud sync or multi-device conflict resolution"
> product boundary in [`AGENTS.md`](../AGENTS.md) still applies to the product as a whole.

## What is and is not available

| Shipped | Not shipped |
|---|---|
| Personal profile: everything syncs (GTD, journal, reviews, goals, AI memory and proposals, finance, Pomodoro history, shared settings) | Work profile, work shell, join flow for a second laptop, profile switching |
| Manual "Synchroniser maintenant" on `/sync` | Restore UI |
| [Automatic triggers](#automatic-triggers): pull at startup (before the day's generators), on focus and hourly; publish after a 2-minute debounce, on blur and on quit; backoff; status chip; reload of open GTD / Today / Daily / Pomodoro screens | Conflict and overwritten-edit list |
| A forced safety backup before the first merge (taken once, not on every pull; and on a schema change) | Third laptop, tombstones that carry field values (see [limits](#limits)) |
| Peers table, pending count, last run report, errors, stale-peer approval | Any trigger without the debug gate and `multiDeviceSyncEnabled` |
| Browser preview shows "unavailable" and persists nothing | Background syncing while the app is fully closed |

## The gate

Sync must stay hard to enable by accident.

- The **Settings card** ("Synchronisation multi-ordinateurs (expérimental)") renders only when
  the app's **debug mode** is on (`debugEnabled`; always on in Vite development; otherwise
  enabled by the Settings switch "Mode debug local", `?debug=1`, or `localStorage`
  `trackdidia.debug.enabled`; see [AI, Settings and Privacy](ai-settings-and-privacy.md#debug-mode)).
- The **`/sync` page content and its nav entry** need debug mode **and** the device-local
  `multiDeviceSyncEnabled` setting. The route is always registered; without both it shows a
  gate message (and, when sync is simply off, a link to Settings). `src/lib/sync/gate.ts` is the
  single place both gates are decided.
- In **browser preview** (and under the startup fallback, which has no persistent storage) the
  card and the page say "unavailable in browser preview" and every action is disabled. Nothing is
  persisted.
- The final sync slice removes the debug requirement; until then it is the opt-in.

## Settings

Four new `AppSettings` keys, all **device-local** in the sync settings registry
(`src/lib/sync/registry.ts`): they live in this laptop's settings row and are never published in a
bundle, never applied from one, and a registry/privacy test fails if one is classified otherwise.

| Key | Default | Meaning |
|---|---|---|
| `multiDeviceSyncEnabled` | `false` | Sync was enabled on this laptop (identity created, capture installed, folders prepared). |
| `syncProfile` | `"personal"` | Only `"personal"` is supported. A stored `"work"` is kept as written but sync refuses it (`unsupported_profile`). Anything that is not a profile normalizes to `"personal"`. |
| `syncGtdFolderDir` | `""` | The shared GTD folder. |
| `syncDeviceName` | `"Cet ordinateur"` | How this laptop is named to its peers (at most 100 characters). Give each laptop a different name. |

The **personal** folder is the existing `backupDestinationDir` (the backup folder): the personal
bundles go beside `backups/` in `{backupDestinationDir}/sync/` (`sync-dev/` in development). No
setting remembers the last error or the last sync time: both are derived from the engine's reports
and the `sync_peers` table.

## Enabling (Settings card)

`enableSync` (`src/lib/sync/sync-service.ts`), run by the card's "Activer la synchronisation":

1. Refuses outside the desktop app, for a profile other than `personal`, without a device name, and
   without **both** folders (the backup folder and the shared GTD folder). Nothing is written then.
2. Refuses a shared GTD folder that is the backup folder or lies inside or around it, before the native
   host is asked (`folder-paths.ts`, case-insensitive and separator-insensitive). The picker applies
   the same rule when the folder is chosen. The native host then enforces it again with canonical
   paths and role markers ([Sync folder commands](storage-and-backups.md#sync-folder-commands)).
3. Prepares the shared folder as role `gtd` and the backup folder as role `personal` with
   `sync_prepare_folder`, **each given the other as `otherFolderDir`** (so the nesting check always has
   both). A rejected folder is reported with which folder it was.
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
and enabling again is a catch-up. "Revérifier les dossiers" re-prepares both folders after the backup folder
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
  up-to-date items, tombstones, conflicts logged (there is no list of them yet), the **safety backup** result
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

Everything below exists **only while the debug gate is open AND `multiDeviceSyncEnabled` is on**, on the desktop
storage (`isSyncAutomationEnabled` / `syncAutomationKeyFor`, `src/lib/sync/gate.ts`). With either off, nothing is
built: no engine at startup, no window listener, no timer, no pull, no close handler, no status chip, and the
backup scheduler gets no lane; the app behaves exactly as it did before sync existed (tests pin each of these).
Turning the setting off or debug mode off in a running session tears all of it down; changing a folder, the device
name or the profile rebuilds it.

| Trigger | What happens | Limits |
|---|---|---|
| **Startup** (inside bootstrap) | Pull from the other laptop BEFORE the two GTD normalizations, recurrence generation, Scheduled promotion and relationship draws, so a task already completed on the other laptop is not regenerated and today's draw made there is not repeated. Then publish what is pending (step 6 of the spec's flow). | Bootstrap waits at most **4 s** for the pull; past that it carries on and the same pull keeps running in the background (chip: "Synchronisation…"; open screens reload when it applies). It never throws into bootstrap and never activates the in-memory fallback. |
| **Window focus / becoming visible** | Pull. | At most once per **60 s** (any pull counts, startup included). |
| **Hourly** | Pull. | Every 60 minutes while the app runs. |
| **Local changes** | Publish. | A 15 s poll of one row (`pendingChanges`, a single counter comparison) notes when changes were first seen; they are published when the first is **2 minutes** old. Further edits do not push the deadline back. |
| **Window blur / hidden** | Publish what is pending, at once. | |
| **Quit** | Publish what is pending, best effort. | Waits at most **3 s**, then the window closes whatever happened. In tray mode the close handler publishes nothing and keeps the window alive for the native handler to hide (hiding blurs it, which already publishes). |
| **Synchroniser maintenant** | Pull then publish, always. | Ignores and resets the backoff and the "paused" state; waits for an automatic run already in flight. |

A trigger that finds a run in flight is dropped, not queued, and no automatic trigger runs while a manual action
(Sync now, enable, resume, folder recheck) holds the controller. Pulls apply the data in the same chunked slots as
Sync now ([details](storage-and-backups.md#chunked-capture-backfill-and-chunked-apply)).

### Startup ordering, the 8-second rule and chunk resumption

`useBootstrap` builds the engine once (`src/lib/sync/startup-sync.ts`), starts the pull, and hands both to
`useMultiDeviceSync`, which adopts them: there is **one engine per session** (one in-flight guard, one publish
memory). The 4 s is a **wait** budget, not a work budget. **The pull is not given an engine `budgetMs`**: when the
wait lapses the pull continues unbudgeted in the background. This is how the slice-14 obligation (the chunk
resume index is in memory, so a budgeted first merge of a very large bundle restarted at chunk 0 after every
restart) is discharged: no automatic path ever cuts a merge, so the only thing that can interrupt a very large
first merge is quitting the app, after which the next start repeats the bundle from its first chunk, in the
background, to the end (chunks already applied merge as no-ops, about 60 % of the first cost). A persisted
per-chunk cursor was NOT built, because the unbudgeted path makes it unnecessary for the app. The engine's
`budgetMs` option remains for tests and callers that want it.

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
  included) and the automatic-backup scheduler's backups run in one exclusive lane; see
  [Backup behavior](storage-and-backups.md#backup-behavior).
- **The first-merge safety backup is taken once**, not on every pull until a bundle completes: its path is
  recorded (`sync_identity.first_merge_backup_path`). A failed backup is retried and merges nothing meanwhile.
- **Automatic publishing is per domain.** A task edit rebuilds the `gtd` bundle only; a periodic manifest
  heartbeat (30 days) keeps the untouched folder from looking absent
  ([details](storage-and-backups.md#per-domain-change-detection-and-the-manifest-heartbeat)).

### What was not measured

There is no desktop in the development environment. Not measured, and not claimed: the real Tauri IPC latency per
statement (so `maxEntities` and the other apply limits stay as tuned against the in-process adapter; each
automatic run logs `statusReadMs`, the time of one `getSyncStatus`, and `maxChunkMs`, the slowest apply slot, in
the debug log under `sync.lifecycle`, so a session on a real laptop can read the latency off); the JavaScript heap
inside the real webview (the 350 to 450 MB read of a very large `finance` domain is a Node figure; per-domain
detection only makes it rarer); and the close handler in a real Tauri window (it is tested against a fake window).
Manual check on a desktop: edit a task and quit within seconds (the other laptop should receive it), close with
the Drive folder unmounted (the window must still close within about 3 s), and watch the debug log lines above.

## What "Synchroniser maintenant" does

`engine.syncNow()` ([Sync engine](storage-and-backups.md#sync-engine-transport-seam-and-device-profile)): pull every
peer of both folders, then publish. Before the first merge (and when the database schema changed since the last
merge with a peer) the engine requires a **safety backup**, taken by `createBackup("auto", { deviceId })`
into this laptop's backup folder with the per-device name `trackdidia-auto-backup-<deviceTag>-<timestamp>.db`
(retention per device, `prune_backups` given the same id; see
[Backup behavior](storage-and-backups.md#backup-behavior)). With no backup folder the backup is refused and
**nothing is merged**. The backup path is shown in the run report and recorded as `lastBackupPath`. There is
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
- Personal profile only; two personal laptops. A **third laptop and the work profile are unsupported** until
  tombstones carry their last field values (a delete racing edits from two laptops that have not seen each other is
  order dependent; see the merge notes in [storage-and-backups.md](storage-and-backups.md#multi-device-sync-change-sets-and-apply)).
- The second laptop is joined by enabling sync on it with the same two folders; there is no guided join flow, and the
  first merge into a database that already holds data relies on the safety backup and the merge rules, not on an
  empty-database check.
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
- **Disable leaves change tracking installed.** The capture triggers stay on the database and keep recording every edit
  (a small cost per write), so enabling again is a catch-up. There is no "remove tracking" action.
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
- Conflicts are logged in `sync_conflicts` but not listed anywhere; calendar sync on two laptops is not warned about.
- Settings merged from a peer reach the running app after a run that applied something. GTD, Today, Daily and Pomodoro
  screens reload after a merge; Reviews, Journal, Finance and the other pages show merged data when opened.

## Code map

| Concern | Source |
|---|---|
| Bundle encode / decode | `src/lib/sync/bundle.ts` |
| Folder transport | `src/lib/sync/transport-folder.ts` (typed commands: `folder-api.ts`) |
| Enable / disable / engine construction / safety backup | `src/lib/sync/sync-service.ts`, `folder-paths.ts` |
| Gate | `src/lib/sync/gate.ts` |
| State around the engine | `src/app/use-multi-device-sync.ts` (in `AppProvider`, exposed as `useAppContext().sync`) |
| Automatic triggers | `src/lib/sync/lifecycle-policy.ts` (pure rules), `lifecycle.ts` (timers and runs), `startup-sync.ts` (the bootstrap pull), `quit-publish.ts` (close handler), `src/app/use-sync-automation.ts` (window events), `domain-counters.ts` (per-domain change detection) |
| Status chip | `src/components/sync/SyncStatusChip.tsx` |
| Settings card | `src/components/settings/MultiDeviceSyncSection.tsx` |
| `/sync` page | `src/pages/SyncPage.tsx`, `src/components/sync/` |
| French copy | `src/locales/fr/sync.json` |
| Test fakes | `src/lib/sync/test-support/fake-folder-host.ts` (the native commands, in memory) |

Tests: `lifecycle-policy.test.ts`, `lifecycle.test.ts` (fake timers), `startup-sync.test.ts`, `quit-publish.test.ts`,
`use-multi-device-sync.automation.test.tsx` (the real hook over a real repository and the fake host, including the
"gate closed adds no listener, timer or pull" proofs), `sync-engine.domains.test.ts`, `SyncStatusChip.test.tsx`,
`bundle.test.ts`, `transport-folder.test.ts` (including the real engine over the real bundle codec),
`sync-service.test.ts`, `folder-paths.test.ts`, `gate.test.ts`, `use-multi-device-sync.test.tsx`,
`SyncPage.test.tsx`, `MultiDeviceSyncSection.test.tsx`, `AppShell.test.tsx`, `create-backup.test.ts`, and the
registry, privacy and settings tests listed in the changelog.
