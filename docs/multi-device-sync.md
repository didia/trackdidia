# Multi-device sync (experimental)

See also: [changelog](logs/multi-device-sync.md).

TrackDidia can keep two **personal** laptops up to date with each other through two folders
that Google Drive for Desktop (or any synced folder) mirrors. This page describes what is
shipped: an **experimental, opt-in, debug-gated, manual-only** build of it. The design,
the remaining phases and the open questions live in
[`specs/todo/multi-laptop-sync.md`](../specs/todo/multi-laptop-sync.md); the engine, change
sets, folder commands, bundle format and transport are documented where they live, in
[storage-and-backups.md](storage-and-backups.md) (links below). This page does not repeat them.

> **Do not rely on this yet.** There is no restore-from-backup UI, nothing runs
> automatically, the `work` profile and the join flow for a second laptop are not shipped,
> and a third laptop is unsupported. The "Cloud sync or multi-device conflict resolution"
> product boundary in [`AGENTS.md`](../AGENTS.md) still applies to the product as a whole.

## What is and is not available

| Shipped | Not shipped |
|---|---|
| Personal profile: everything syncs (GTD, journal, reviews, goals, AI memory and proposals, finance, Pomodoro history, shared settings) | Work profile, work shell, join flow for a second laptop, profile switching |
| Manual "Synchroniser maintenant" on `/sync` | Pull at startup or on focus, hourly pull, debounced or on-quit publish, view reload, status chip |
| A forced safety backup before the first merge (and on a schema change) | Restore UI |
| Peers table, pending count, last run report, errors, stale-peer approval | Conflict and overwritten-edit list |
| Browser preview shows "unavailable" and persists nothing | Third laptop, tombstones that carry field values (see [limits](#limits)) |

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
5. Runs `enableSyncCapture`: installs the change-capture triggers and stamps every existing synced row
   in **one write transaction**. The card shows the step ("Initialisation du suivi des changements de
   toute la base…") and, when done, how many entities were initialized and how long it took.
6. Saves `multiDeviceSyncEnabled`.

Every step is safe to run again after a failure. **Large databases.** The backfill is not chunked. On a
synthetic database of 5,000 tasks, 3,000 events, 50,000 finance transactions with 15,000 splits and 1,100
daily entries (71,146 entities) it took 8.6 s in-process with `node:sqlite` and 5,146 SQL statements; at twice
that size (141,146 entities, 10,026 statements) it took 17.1 s, and each statement over the Tauri IPC adds to
that. The serial queue's 15 s watchdog is a limit on how long a *queued* operation may wait for its turn, so
the enable itself does not fail; any other write queued behind it for more than 15 s is rejected, which on a
database that size means an edit made during the enable could fail. The app should not be used while the card is
enabling. Chunking the backfill is the first item of the lifecycle slice.

**Disabling** ("Désactiver la synchronisation") only turns `multiDeviceSyncEnabled` off. The identity, change
capture and every file already in the folders stay (nothing is deleted from Drive), edits are still captured,
and enabling again is a catch-up. "Revérifier les dossiers" re-prepares both folders after the backup folder
or the shared folder was changed.

## The `/sync` page

French, keyboard-operable like the other pages. It reads its state when opened and shows:

- **Pending changes** not yet published.
- **Autres ordinateurs**: one row per known peer with name and short id, last sync time, app version and
  database (schema) version, profile, a state (`À jour`, `Mise à jour requise`, `Hors ligne trop longtemps`,
  `Format non pris en charge`, `Manifeste invalide`, `Envoi en cours chez ce pair`, `Erreur`,
  `Dossier inaccessible`, `Pas encore vu`) and the engine's detail. Files a folder listing ignored (Drive conflict
  copies, stray files) are listed under the table.
- **Stale peers.** A peer offline for 90 days is refused by default. Its row explains why and offers
  "Fusionner quand même", which needs a second confirming click and then approves exactly that peer for the
  next run.
- **Dernière synchronisation**, kept while the app runs (not stored): applied bundles, applied and already
  up-to-date items, tombstones, conflicts logged (there is no list of them yet), the **safety backup** result
  with its path, skipped peers with the reason ("mets à jour TrackDidia pour synchroniser avec cet ordinateur",
  "hors ligne trop longtemps"), clock-skew notes, and per domain whether it was published, unchanged, had no
  folder, or failed.
- **Errors.** Failures retrying cannot fix are shown first, in an alert: a **configuration** error (the folder
  carries the other role's marker, or is nested with the other folder: "choisis un autre dossier"), a **bundle too
  large** for the folder protocol (persistent: nothing is published for that domain until the data shrinks),
  a format this laptop cannot read, or an internal error. A folder that is simply not there (Drive not mounted) or
  slow is an ordinary warning that the next "Synchroniser maintenant" retries. The engine's English message stays
  available under "Détail technique".

Merged data is visible in pages opened afterwards; pages already open show it when you return to them, and
settings merged from a peer are republished to the app's copy after a run that applied anything.

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
overlap). The native `ensure_backup_dir` refuses a destination that carries or touches a `gtd` role marker too. Users who
never set a GTD folder see no change.

One action runs at a time; a second request while one runs is ignored.

## Safety

- Plaintext bundles (no encryption in v1); secrets (OpenRouter key, RescueTime key, LLM bridge token) and all
  device settings never enter a change set.
- The shared GTD folder carries only `gtd` bundles; personal and finance bundles go only to the backup folder,
  routed by the folder role and re-checked by the transport and the native host.
- Bundles are verified by size and SHA-256 before use and rejected as a whole when invalid; one bad peer or
  domain never stops the others.
- Always keep a recent manual backup before enabling. There is no undo.

## Limits

- Manual only: nothing runs at startup, on focus, on a timer, on edit or at quit.
- Personal profile only; two personal laptops. A **third laptop and the work profile are unsupported** until
  tombstones carry their last field values (a delete racing edits from two laptops that have not seen each other is
  order dependent; see the merge notes in [storage-and-backups.md](storage-and-backups.md#multi-device-sync-change-sets-and-apply)).
- The second laptop is joined by enabling sync on it with the same two folders; there is no guided join flow, and the
  first merge into a database that already holds data relies on the safety backup and the merge rules, not on an
  empty-database check.
- The enable backfill is not chunked (see above); a database larger than the sizes measured there may exceed the
  serial queue's 15 s wait limit. Do not use or edit the app while it runs; quitting is safe (the transaction rolls back).
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
- A bundle over 64 MiB (the folder protocol's cap) cannot be published or read. Measured encoded sizes stay far below
  it (see [Sync bundle format and folder transport](storage-and-backups.md#sync-bundle-format-and-folder-transport)).
- Publish serialization is in-process: running two instances of the app with one device identity is not supported.
- Conflicts are logged in `sync_conflicts` but not listed anywhere; calendar sync on two laptops is not warned about.
- Settings merged from a peer reach the running app after a run that applied something; other open pages refresh when
  re-opened.

## Code map

| Concern | Source |
|---|---|
| Bundle encode / decode | `src/lib/sync/bundle.ts` |
| Folder transport | `src/lib/sync/transport-folder.ts` (typed commands: `folder-api.ts`) |
| Enable / disable / engine construction / safety backup | `src/lib/sync/sync-service.ts`, `folder-paths.ts` |
| Gate | `src/lib/sync/gate.ts` |
| State around the engine | `src/app/use-multi-device-sync.ts` (in `AppProvider`, exposed as `useAppContext().sync`) |
| Settings card | `src/components/settings/MultiDeviceSyncSection.tsx` |
| `/sync` page | `src/pages/SyncPage.tsx`, `src/components/sync/` |
| French copy | `src/locales/fr/sync.json` |
| Test fakes | `src/lib/sync/test-support/fake-folder-host.ts` (the native commands, in memory) |

Tests: `bundle.test.ts`, `transport-folder.test.ts` (including the real engine over the real bundle codec),
`sync-service.test.ts`, `folder-paths.test.ts`, `gate.test.ts`, `use-multi-device-sync.test.tsx`,
`SyncPage.test.tsx`, `MultiDeviceSyncSection.test.tsx`, `AppShell.test.tsx`, `create-backup.test.ts`, and the
registry, privacy and settings tests listed in the changelog.
