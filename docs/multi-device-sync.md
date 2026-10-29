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
- **Dernière synchronisation**, kept while the app runs (not stored): applied bundles, applied and already
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
- The enable backfill and the apply of a large incoming bundle are chunked (a writer slot of 0.1 to 0.3 s in process
  for the backfill and the usual merge, about 1 s with a simulated IPC cost, and a worst case of about 1,600
  statements for an oversized group; see above), but nothing resumes an interrupted backfill by itself: after a quit the user
  presses "Reprendre l'initialisation". A large bundle that fails or is cut by a restart is applied again from its
  first chunk, at about 60 % of the cost of the first time (the merge has no persisted per-chunk marker yet); once
  it has been applied completely it is never re-read. The memory needed to READ a 130,000-transaction finance
  domain for a publish is the largest cost left (350 to 450 MB of JavaScript heap measured in Node, not in the
  webview), a reason the lifecycle slice must not publish automatically before it has per-domain change detection.
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
