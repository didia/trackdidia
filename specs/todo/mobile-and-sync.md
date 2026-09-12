# Spec — TrackDidia Mobile (iOS) + Decentralized Desktop↔Phone Sync

**Status:** approved, unshipped.
**Scope:** add a lean native iOS companion app for GTD capture and daily execution, plus a
decentralized sync engine that keeps phone and desktop consistent with no server the user
operates and no third-party service holding readable data.

## Context

TrackDidia is a local-first personal OS: a Tauri v2 desktop app (React 18 + TypeScript,
Vite 5, Vitest 2, Biome) whose only durable store is a SQLite file in the macOS app-data
directory for `com.trackdidia.desktop`. Today there is exactly one device and exactly one
database. [`docs/architecture.md`](../../docs/architecture.md) names the gap plainly — "No
cloud sync, accounts, or shared data" — and [`AGENTS.md`](../../AGENTS.md) lists "Mobile
application distribution" under *Current product boundaries / Do not assume these exist*.

That single-device assumption is now the binding constraint on the app's most time-sensitive
jobs. GTD capture has to happen wherever the thought occurs, and daily work management
happens away from the desk. Neither works when the only client is a Mac app.

## Decisions

| Decision | Choice |
|---|---|
| Mobile platform | Native iOS via Tauri v2 mobile, same React codebase |
| Code signing | Free Apple personal team (7-day expiry, rebuild from the Mac); TestFlight is a documented later upgrade |
| Transport | Encrypted delta bundles relayed through the user's own Google Drive (Drive API v3, `drive.file` scope) on **both** devices; direct LAN peer path as a later fast path |
| Pomodoro | One shared logical timer across devices, controllable from either |
| Conflicts | Auto-resolve where semantically safe; unresolvable ones enter a synced conflict queue resolvable from **either** device |
| Mobile scope | Inbox capture, Next Actions, full task editing, Pomodoro, Scheduled/today's agenda, Projects (browse + assign), Waiting For, Someday-Maybe |
| Generator authority | Desktop owns recurrence generation and relationship draws; Scheduled promotion runs on both |

### Out of scope for mobile

Daily routine/metrics, weekly and monthly reviews, annual goals, history, journal,
recurrence template CRUD, references, email triage, AI coach, settings, backups. These stay
desktop-only and are not synced.

## Why native iOS rather than a PWA

Recorded because it is the load-bearing platform decision.

1. **Pomodoro notifications.** iOS PWAs cannot schedule a local notification; Web Push
   requires a push server, i.e. the hosting this project refuses. A focus session would
   never announce its end unless foreground and awake.
2. **LAN sync is impossible from a PWA.** An `https://` origin cannot call
   `http://192.168.x.x` (mixed content), and no trusted certificate exists for a LAN IP.
3. **A PWA needs an origin to be served from** — hosting, however small.
4. Secondary: iOS can evict web-app storage, which for a local-first app means losing
   *unsynced captures*; and PWAs get no iOS share sheet, Shortcuts, or widgets.

Tauri 2.10.3 / CLI 2.10.1 already support iOS, so the native route reuses the entire React
codebase and the repository-parity contract rather than duplicating domain logic.

## Phase 1 — Make the Rust host mobile-capable

[`src-tauri/src/main.rs`](../../src-tauri/src/main.rs) is a plain `fn main()` with
`tauri::Builder::default()`. `tauri ios init` requires the library entry-point shape, and
four dependency groups cannot build or behave on iOS.

Split `main.rs` into `src-tauri/src/lib.rs` (builder inside `pub fn run()`, annotated
`#[cfg_attr(mobile, tauri::mobile_entry_point)]`) plus a thin `main.rs` calling it.

Gate the desktop-only surface behind `#[cfg(desktop)]` — module declarations,
`invoke_handler` entries, and plugin registrations alike:

| Surface | File | Reason |
|---|---|---|
| `vault.rs` (`keyring` 3) | `src-tauri/src/vault.rs` | No iOS backend in the current config |
| `tauri-plugin-autostart` | registered in `main.rs` | Desktop-only plugin |
| `tray-icon` feature + tray commands | `Cargo.toml`, `src/email_triage_desktop.rs` | No tray on iOS |
| `yahoo_imap.rs` (`imap`, `native-tls`) | `src-tauri/src/yahoo_imap.rs` | Email triage is desktop-only |
| `oauth_loopback.rs` (raw `TcpListener`) | `src-tauri/src/oauth_loopback.rs` | iOS OAuth uses a custom URL scheme |
| `backup.rs`, dialog folder picking | `src-tauri/src/backup.rs` | Backups stay desktop-only |

Move those crates into `[target.'cfg(desktop)'.dependencies]` in `src-tauri/Cargo.toml` so
they are not compiled for `aarch64-apple-ios`.

Keep cross-platform: `db.rs` (sqlx/SQLite — `app_data_dir()` resolves on iOS),
`provider_http.rs` (reqwest + rustls; `www.googleapis.com` is already in its
`ALLOWED_HOSTS`), `tauri-plugin-notification`, `tauri-plugin-opener`.

**Gate before any feature work:** `cargo check --target aarch64-apple-ios --manifest-path
src-tauri/Cargo.toml` must pass. `sqlx` 0.8 with the `sqlite` feature bundles libsqlite3 via
`cc`, and that is the dependency most likely to surprise on an iOS target.

**Platform-split capabilities.** `src-tauri/capabilities/default.json` is pinned to
`../gen/schemas/desktop-schema.json` and scoped `"windows": ["main"]`. Split into
`capabilities/desktop.json` (current permissions) and `capabilities/mobile.json`
(`core:default`, `notification:default`, `opener:default`), each with the appropriate
`"platforms"` key.

**Bundle identity.** Add `src-tauri/tauri.ios.conf.json` declaring
`identifier: "com.trackdidia.mobile"` and iOS-appropriate `app.windows` (no fixed
1440×960). Leave `tauri.conf.json`'s `com.trackdidia.desktop` **untouched** — `AGENTS.md`
makes that identifier load-bearing for the desktop app-data directory. Verify that Tauri
merges an `identifier` override from a platform config; if it does not, keep the single
identifier rather than migrating the desktop one.

**Info.plist additions** (via `tauri.ios.conf.json`): `NSLocalNetworkUsageDescription` and
`NSBonjourServices` (`_trackdidia._tcp`) for the Phase 6 LAN path, plus a custom URL scheme
for the Google OAuth redirect.

Fold in three pre-existing defects, because each gets copied into mobile code if left alone:

- `rescuetime_http_get` in `main.rs` takes an **arbitrary URL** and attaches the bearer key
  with no host allowlist, unlike `provider_http_request`. Add an allowlist.
- `createEntityId` in [`src/lib/gtd/shared.ts`](../../src/lib/gtd/shared.ts) falls back to
  `Math.random().toString(36).slice(2, 10)` when `crypto.randomUUID` is absent. With two
  devices minting ids independently this becomes a real collision path. Make the fallback
  throw, or use a proper 128-bit fallback.
- Version drift: `package.json` is `0.2.0` while `Cargo.toml` and `tauri.conf.json` are
  `0.1.0`, and [`docs/desktop-builds.md`](../../docs/desktop-builds.md) says they should
  stay aligned. Align them.

## Phase 2 — Mobile shell and route set

No page components are rewritten. The existing screens already collapse to one column at the
`768px` / `1024px` breakpoints in `src/styles.css:1585,1598`, and
[`src/components/GtdTaskCard.tsx`](../../src/components/GtdTaskCard.tsx) (622 lines) is the
entire task-work surface — reusing it verbatim is what keeps this lean.

What is actually new:

- `src/components/MobileShell.tsx` — replaces `AppShell`'s 19-item sidebar with a bottom tab
  bar: **Capture · Next · Today · Pomodoro · More**. Keeps `FloatingPomodoroTimer` (already
  conditional via `shouldRenderFloatingPomodoro`); drops the sidebar and quote hero.
- `src/app/platform.ts` — `isMobileRuntime()`. Prefer a Tauri-provided platform signal over
  a viewport query, so a narrow desktop window does not get the mobile shell.
- `src/App.tsx` — select `MobileShell` vs `AppShell` and register only the mobile route
  subset: `/inbox`, `/next-actions`, `/scheduled`, `/projects`, `/waiting-for`,
  `/someday-maybe`, `/pomodoro`, plus a new `/sync`. Desktop keeps all 19 routes plus `/sync`.
- `src/pages/CapturePage.tsx` — the one genuinely new screen: a single autofocused field that
  writes straight to `inbox` and stays open for the next thought. `InboxPage`'s capture form
  is tuned for a desk, not a thumb.
- Touch affordances in `src/styles.css`: ≥44px hit targets on `GtdTaskCard` quick actions and
  `BulkTaskToolbar`, plus safe-area insets (`env(safe-area-inset-*)`).

**Mobile AppProvider trim.** [`src/app/app-context.tsx`](../../src/app/app-context.tsx) (489
lines) must skip, on mobile: the auto-backup loop (~lines 235–285), the email-triage
coordinator, the AI pulse engine, and the one-time GTD normalizations
(`gtdReferencesMigrationDoneAt`, `gtdScheduledNormalizationDoneAt` — desktop-owned, and
running them against a partially-synced phone database would move the wrong rows).

The 8-second timeout → `MemoryRepository` fallback **must not apply on mobile**. An
in-memory fallback on the phone would silently accept captures into a database discarded on
reload. On mobile, fail loudly instead.

## Phase 3 — Google Drive relay transport

- `src/lib/sync/transport.ts` — the interface the engine depends on (`list`, `fetch`, `put`,
  `delete`). Phase 6's LAN peer implements the same interface.
- `src/lib/sync/transport-drive.ts` — Drive API v3 against
  `https://www.googleapis.com/drive/v3`, already allowlisted in `src-tauri/src/provider_http.rs`.
  Scope **`drive.file`** only: the app sees solely files it created. Bundles live in one
  app-created folder whose id is cached locally.
- OAuth reuses the existing PKCE implementation in `src/lib/email-triage/oauth/`.
  `buildGmailAuthorizationUrl` is already fully parameterized over
  clientId/redirectUri/state/codeChallenge, and `GMAIL_TOKEN_URL` is Google's generic token
  endpoint, so `src/lib/sync/drive-oauth.ts` differs only in scope. Redirect differs by
  platform: desktop keeps `oauth_loopback.rs`; iOS uses the custom URL scheme.
- Move `src/lib/email-triage/provider-http.ts` to `src/lib/http/provider-http.ts` — it is not
  email-specific, and the sync engine needs `providerHttpRequest`, `assertHttpSuccess`, and
  `ProviderHttpError`.
- The refresh token goes to the desktop keychain via `vault.rs`, and to the **iOS Keychain**
  on mobile. `keyring` does not cover iOS, so mobile needs a small new Rust command or a
  Tauri keychain plugin. This is the one new native surface on iOS; size it explicitly.
- **Bundles are encrypted client-side.** Google never holds readable task data. One symmetric
  key is generated at pairing, stored in each device's keychain, and transferred only during
  pairing. Ciphertext-only in Drive is what makes the relay acceptable under "no data hosted
  online".

⚠️ `provider_http.rs` caps responses at **2 MiB**. An initial full sync of a years-old GTD
database can exceed that, so bundles must be chunked and cursor-paginated.

## Phase 4 — The sync engine

### Data model: delta-state with per-field logical clocks, in a sidecar table

**Chosen over an oplog**, on this codebase's facts: ids are already globally unique
client-generated TEXT primary keys; `persistTask` and its siblings are already
`INSERT … ON CONFLICT(id) DO UPDATE` upserts, which *is* "apply remote state"; and a personal
GTD database is small enough that shipping every row changed since a cursor is cheap. An
oplog would add a second source of truth for no gain.

**One exception, already oplog-shaped:** `gtd_task_events` is append-only with
`dedupe_key TEXT UNIQUE` and `ON CONFLICT … DO NOTHING`. It syncs as a **grow-only set
union** keyed on `id`/`dedupe_key` — no clocks, no conflicts, ever. Because daily GTD counts
are event-derived through `buildDailyTaskStats`, this union is what makes completions done on
the phone appear in desktop statistics.

**Migration 33** (next free id; 32 is the highest shipped). A **sidecar** design, so **no
`ALTER TABLE` touches `gtd_tasks` or any existing table** — the preserve-first rule in
`AGENTS.md`, and it means a faulty sync migration cannot damage task rows:

```sql
CREATE TABLE IF NOT EXISTS sync_entity_meta (
  entity_type       TEXT NOT NULL,   -- task | project | context | recurring_template
                                     -- | pomodoro_session | pomodoro_segment
  entity_id         TEXT NOT NULL,
  field_clocks_json TEXT NOT NULL,   -- { "<field>": "<hlc>", "contextIds.<id>": "<hlc>" }
  row_hlc           TEXT NOT NULL,   -- max(field clocks); the ship cursor
  deleted_at        TEXT,            -- tombstone; NULL = live
  PRIMARY KEY (entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_sync_entity_meta_row_hlc ON sync_entity_meta (row_hlc);

CREATE TABLE IF NOT EXISTS sync_identity (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  device_id TEXT NOT NULL,
  device_name TEXT NOT NULL,
  role TEXT NOT NULL,                -- primary | companion
  physical_ms INTEGER NOT NULL,
  counter INTEGER NOT NULL           -- persisted HLC
);

CREATE TABLE IF NOT EXISTS sync_peers (
  peer_id TEXT PRIMARY KEY,
  peer_name TEXT NOT NULL,
  cursor TEXT,
  last_synced_at TEXT
);

CREATE TABLE IF NOT EXISTS sync_conflicts (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  kind TEXT NOT NULL,                -- terminal_divergence | unique_violation | ...
  local_json TEXT NOT NULL,
  remote_json TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT
);
```

`sync_conflicts` rows sync like any other entity, which is what makes resolve-from-either-
device work. `sync_identity` and `sync_peers` never leave their device.

**Clocks are hybrid logical clocks, not wall clocks.** Two devices whose clocks drift would
otherwise let the fast one win every tie forever. An HLC is
`(physical_ms, counter, device_id)` encoded as a lexicographically sortable string; receiving
a remote HLC advances the local one, making ordering causally consistent.
`src/lib/sync/hlc.ts` is pure and roughly 60 lines.

**Why per-field and not per-row.** Phone adds notes at 10:00; desktop sets a deadline at
10:05. Row-level last-writer-wins silently discards the notes. That is a frequent interaction
and an unacceptable loss, and per-field clocks resolve it automatically with no prompt.

### Change tracking: explicit writes in the shared pure layer, not triggers

`buildLifecycleEvents(previous, next)` in `src/lib/gtd/engine.ts:291` already exists for
exactly this shape of derivation, and `saveTaskInternal` already reads the previous row to
feed it. A sibling `buildFieldClockUpdates(previous, next, hlc)` in
`src/lib/sync/field-clocks.ts` slots in beside it, lives in a pure module **both repositories
import**, and is therefore correct in `MemoryRepository` too.

Triggers would also work — the sqlx pool is pinned to one connection, so they fire inside the
open transaction — but would exist only in SQLite, leaving `MemoryRepository` to duplicate the
logic, which is precisely what the repository-parity contract forbids.

The residual risk of explicit tracking is a missed write path. Mitigate with a
**self-healing backfill**: before shipping, the engine scans for synced rows with no meta row,
or whose `updated_at` is newer than `row_hlc`'s physical component, and stamps them with a
local HLC. Cheap, and it converts a silent "never syncs" bug into a one-cycle delay.

### Merge rules — `src/lib/sync/merge.ts` (pure; the heart of this spec)

| Case | Resolution |
|---|---|
| `title`, `notes`, `deadline`, `projectId`, `sourceUrl`, `parentTaskId` | Per-field LWW by HLC. **Auto.** |
| `contextIds` | **OR-Set**, not LWW. Per-element add/remove clocks under `contextIds.<id>`. Concurrent "add @errands" and "add @calls" must yield *both*; LWW on the array would drop one. **Auto.** |
| Lifecycle tuple `{status, bucket, completedAt, scheduledFor, plannedOrder}` | Merged as **one unit**, never per-field — per-field LWW can produce impossible states (`completed` + `planned` + an order, or `scheduled` with `scheduledFor: null`, which `adjustPlannedFieldsForSave` rejects). Ladder below. |
| Terminal (`completed`/`cancelled`) vs a concurrent bucket move | Terminal wins. You finished it; moving it is moot. **Auto.** |
| `completed` vs `cancelled`, concurrently | **PROMPT.** Semantically opposite — one counts toward the day's GTD stats, the other does not — and no rule picks correctly. |
| Both active, different buckets | LWW on the whole tuple, taking `{bucket, scheduledFor, plannedOrder}` together so invariants hold. Then re-run `adjustPlannedFieldsForSave`; if the result is invalid (e.g. `planned` but the project was deleted elsewhere) demote to `next_action` — exactly what the desktop already does when a project is cleared from a planned task. **Auto.** |
| `plannedOrder` reordered on both sides | Take the LWW winner's full ordering for that project, then `compactPlannedOrders` to restore density. **Auto, never prompt** — losing a reorder is cheap and obvious; a prompt per drag would be intolerable. |
| `recurrenceDueDate`, `isRecurringInstance`, `pendingPastRecurrences` on `recurring-task:<templateId>` | **Primary-authoritative**: always take the desktop's value. The phone never generates, so concurrent generation is structurally impossible; this guards only a desktop generation racing a phone edit. The phone's `title`/`notes`/`contextIds` edits still merge normally. **Auto.** |
| `source_external_id` UNIQUE violation on apply | Structurally impossible once generator authority holds (both producers — relationship draws, email triage — are desktop-only), but defend: keep the row with the earlier `createdAt`, raise a conflict for the other. **Never silently drop a row.** |
| Context `name` UNIQUE violation | Context ids are deterministic (`context:<slug>`), so concurrent *creation* converges for free. Only a *rename* onto a name another context already holds can violate. Keep the local name, raise a conflict naming both. **PROMPT.** |
| Edit vs hard delete | **Edit wins — resurrect the row.** Losing a deliberate delete is recoverable (delete again); losing an edit is not. Hard deletes are rare anyway (`deleteTasksByIds`, reached only from `collapseGoogleRecurringTasks`). Tombstones still honor causally-later deletes. |
| Two Pomodoro sessions running concurrently | Later `startedAt` becomes active — which **matches existing behavior**, since `buildPomodoroState` already picks the newest running/paused session from newest-first details. The loser is terminalized rather than left running (two `running` rows would break `shouldResetPomodoroCycleAfterIdle`): `completed` at `endsAt` if it had already elapsed, else `cancelled` at the winner's `startedAt`. Both rows survive, so the day's focus history stays honest and an abandoned session correctly does not count as completed focus. **Auto, no prompt** — this is a normal accident, not a decision. |
| Pomodoro `status` + `pausedRemainingMs` | One LWW unit, same reasoning as the lifecycle tuple. Pause and resume work from either device. |
| Pomodoro segments | Grow-only set by id; `endedAt` LWW where **non-null beats null** (a segment closed on either device stays closed). |
| `gtd_task_events` | Set union on `id`/`dedupe_key`. Cannot conflict. |

**`app_settings` does not sync.** It is one untimestamped JSON blob holding the OpenRouter
key, the RescueTime key, the backup destination, and relationship-draw bookkeeping. Syncing it
would move a secret to the phone, move desktop-only paths, and corrupt draw state. If a
preference genuinely must agree across devices, add it as a separate narrow synced entity with
its own clocks — never by syncing the blob.

### Generator authority

`listTasks` is currently **not a pure read**: `tauri-sqlite-repository.ts:3024` runs
`generateDueRecurringTasks` then `promoteDueScheduledTasks` before reading. Listing tasks
mutates the database, and it is local-date dependent.

1. **Remove both calls from `listTasks`** in both repositories. This is safe because every
   real path already runs the generators explicitly — `app-context.tsx:374-388`,
   `use-gtd.ts:19-21`, `use-local-day-reconciliation.ts:35-36`,
   `use-pomodoro-controller.ts:257-258`. It also removes a hidden write from a read, which is
   good hygiene independent of sync.
2. Add `AppRepository.runDailyGenerators(date, now?)` returning
   `{recurrencesGenerated, scheduledPromoted, relationshipTasksCreated}`, and replace those
   four call sites plus `use-daily-entry.ts:32,76`.
3. Add `getSyncRole(): "primary" | "companion"`, stored in `sync_identity` and set at pairing.
   On `companion`, `generateDueRecurringTasks` and `generateDailyRelationshipTasks` are no-ops
   returning 0 and throw if called directly.

**The phone does keep running `promoteDueScheduledTasks`.** This is a deliberate refinement.
That function is pure, deterministic and idempotent given `(tasks, today, now)`
(`src/lib/gtd/scheduled.ts:19`), so both devices compute the same promotion from the same input
and converge. Recurrence generation is *not* safe to share — the deterministic
`recurring-task:<templateId>` id would be advanced independently on each side — and
relationship draws use `Math.random()`. Those two stay desktop-only.

The payoff: using only the phone for three days still surfaces scheduled work in Next Actions.
Only recurring instances lag. Timezone note: the rule is monotonic ("scheduled date ≤ today"),
so devices in different timezones promote at different *moments* but never diverge.

Surface the remaining lag honestly — the `/sync` screen shows "recurring tasks last generated
`<date>` on `<device>`", so a missing daily habit is explained rather than mysterious.

### Repository-layer changes

New `AppRepository` methods — **both** implementations, parity enforced by
`memory-repository.test.ts`: `runDailyGenerators`, `getSyncRole`/`setSyncRole`,
`getSyncIdentity`/`ensureSyncIdentity`, `listSyncChangesSince(cursor, limit)`,
`applySyncChangeSet(changeSet)`, `getSyncCursor`/`setSyncCursor`, `listSyncConflicts`,
`resolveSyncConflict(id, choice)`, `getSyncStatus`.

⚠️ **Deadlock hazard.** `applySyncChangeSet` must be a **single** `runExclusive` block issuing
`BEGIN IMMEDIATE` once and calling the `…Internal(db, …)` helpers. It must **never** call the
public `saveTask`/`completeTask`/`moveTask`, each of which takes `runExclusive` itself —
`DbSerialQueue` explicitly errors on reentrant `run()` and has a 15-second watchdog. Note that
`persistTask`/`persistEvents` resolve `db` via `getDb()` rather than taking it as a parameter;
since the sqlx pool is pinned to one connection they are in-transaction by construction.
**Verify this during implementation rather than assuming it** — it is the most likely source of
a hang.

### Engine and UI

- `src/lib/sync/hlc.ts`, `field-clocks.ts`, `merge.ts` — pure, no I/O, no Tauri.
- `src/lib/sync/sync-engine.ts` — orchestration: pull → merge → apply → push. Transport-agnostic.
- `src/lib/sync/transport.ts` + `transport-drive.ts` (Phase 3) + `transport-lan.ts` (Phase 6).
- `src/app/use-sync.ts` — foreground sync on app open, on a timer, and after each mutation (debounced).
- `src/pages/SyncPage.tsx` (`/sync`, both platforms) — pairing, last-sync time, pending change
  count, generator freshness, and the conflict queue with a side-by-side chooser.

## Phase 5 — Pairing

Desktop generates the bundle encryption key and a device id, and displays a QR code. The phone
scans it (or accepts a typed pass-phrase) and stores the key in the iOS Keychain. Both devices
then authorize Drive independently through their own OAuth flow. Desktop sets itself `primary`,
phone `companion`.

## Phase 6 — LAN fast path (last, and optional)

Same `SyncTransport` interface. Desktop runs a small inbound listener advertised over mDNS
(`_trackdidia._tcp`); `oauth_loopback.rs`'s raw `TcpListener` is the precedent for an inbound
socket in this codebase. Payloads carry the same encryption as Drive bundles, so plain HTTP on
the LAN is acceptable, and iOS ATS is satisfied by the Phase 1 Info.plist local-networking keys.

**Deliberately last.** The Drive relay already works at home as well as away, so the LAN path is
a latency optimization — worth having for the shared Pomodoro timer, not worth blocking a
working app on.

## Verification

Run from the repository root. `npm run verify:all` is the full local mirror of CI (`lint` →
`typecheck` → `test` → `build` → `cargo check` → `cargo clippy -D warnings` →
`cmp AGENTS.md CLAUDE.md`).

Phase 1 gate, before any feature work:

```bash
rustup target add aarch64-apple-ios
cargo check --target aarch64-apple-ios --manifest-path src-tauri/Cargo.toml
npm run verify:all      # desktop must stay green throughout
```

Sync engine — the tests that actually catch divergence:

- `src/lib/sync/hlc.test.ts` — local monotonicity, causal advance on receive, sortability,
  resistance to a skewed peer clock.
- `src/lib/sync/merge.test.ts` — one case per row of the merge table, including every PROMPT case.
- `src/lib/sync/merge.property.test.ts` — **convergence**: any application order of a concurrent
  op set yields identical state (commutativity); re-applying a change set changes nothing
  (idempotence). These find the bugs hand-written cases cannot.
- `src/lib/sync/sync-engine.test.ts` — **two `MemoryRepository` instances plus an in-memory
  transport is a complete two-device simulation**, with no SQLite, no Tauri and no network.
  Highest-value test here; `src/test/test-utils.tsx` already builds on `MemoryRepository`, so the
  pattern exists. Cover: capture on B while A is offline; concurrent edits to one task;
  concurrent complete-vs-cancel reaching the conflict queue and resolving from either side; two
  concurrent Pomodoro sessions; three-day one-device-only runs.
- `src/lib/storage/memory-repository.test.ts` — extend for every new method (parity contract).
- `src/lib/sync/transport-drive.test.ts` — stub `providerHttpRequest`, as `gmail-oauth.test.ts` does.
- Cross-timezone cases: `vite.config.ts` pins `TZ: America/Toronto` for all tests, so inject a
  date provider rather than mutating the global TZ.

End-to-end on real devices (cannot be faked in CI):

1. `npm run tauri dev` (debug DB `trackdidia.dev.db`) — confirm desktop behavior is unchanged and
   `listTasks` no longer writes.
2. `npm run tauri ios dev` on a connected iPhone — capture to inbox, verify it reaches the desktop
   after a sync cycle.
3. Airplane-mode the phone, capture three items, re-enable, confirm all three land.
4. Start a focus on the phone, pause it on the desktop, confirm convergence.
5. Edit the same task's title on the phone and its deadline on the desktop while both are offline;
   sync; confirm **both** edits survive. This is the per-field-clock payoff.
6. Complete a task on the phone and cancel it on the desktop offline; sync; confirm a conflict
   appears on both and resolving on either clears both.
7. Cross local midnight with the phone only; confirm scheduled tasks promote and the `/sync`
   screen explains the recurring-task lag.

**Before the first sync against the real database, take a manual backup from Settings.** There is
no restore-from-backup UI; this is the only recovery path.

## Documentation (required by `AGENTS.md`)

- New canonical page `docs/mobile-and-sync.md` plus its log `docs/logs/mobile-and-sync.md` (path
  rule: `docs/<page>.md` → `docs/logs/<page>.md`).
- Register it in **three** places: `docs/index.md`, the quick-reference table in `AGENTS.md`, and
  the identical table in `CLAUDE.md` — CI runs `cmp AGENTS.md CLAUDE.md`.
- Add the new domain log to the catalog in `docs/log.md` (the one case where editing it is correct).
- Update `docs/architecture.md` (boot flow, mobile shell, route split, generator authority),
  `docs/storage-and-backups.md` (migration 33, sidecar tables),
  `docs/recurrences-and-pomodoro.md` (shared timer, companion-mode generator rules), and
  `docs/desktop-builds.md` (iOS build, free-personal-team signing, 7-day rebuild, TestFlight
  upgrade path), prepending a row to each touched page's domain log.
- Remove "Mobile application distribution" and the no-cloud-sync boundary from *Current product
  boundaries* in `AGENTS.md`/`CLAUDE.md` **as phases land, not before** — that list describes
  shipped behavior.
- Move this spec to `specs/done/` only once implementation, tests and docs have all shipped.

## Risks, ranked

1. **Corrupting the desktop database** — the user's only real copy, with no restore UI. Mitigated
   by sidecar-only schema (no `ALTER` on `gtd_tasks`), `applySyncChangeSet` as one transaction with
   rollback, and a forced `createBackup("auto")` before the first apply.
2. **Silent data loss from a wrong merge rule** — worse than a visible conflict. Mitigated by
   per-field clocks, edit-wins-over-delete, and never dropping a row on a constraint violation.
3. **iOS build viability** — `sqlx`/bundled libsqlite3 on `aarch64-apple-ios` is the biggest
   unknown. Phase 1 proves it before anything is built on top.
4. **A missed write path** leaves a row with no meta row, so it never syncs. Mitigated by the
   self-healing backfill scan.
5. **7-day signing expiry** (free personal team) — the app stops launching weekly until rebuilt
   from the Mac. Re-signing and reinstalling the same bundle id keeps the app container, so data
   survives; **deleting** the app does not. Combined with a phone holding unsynced captures this is
   a genuine data-loss path, so `/sync` should show pending-change count prominently and the
   rebuild procedure should be documented as "sync first, then reinstall". TestFlight (90-day
   builds, over-the-air) is the upgrade when weekly friction gets old.
6. **2 MiB `provider_http.rs` response cap** vs an initial full sync. Chunk and paginate.
7. **Drive relay latency** makes the shared timer stale. Deadline-based timing absorbs most of it;
   Phase 6 reduces it to seconds.
8. **New secret storage on iOS.** The Drive refresh token and the bundle key need the iOS Keychain;
   `keyring` does not cover iOS, so this is new native code. If it slips, do **not** fall back to
   SQLite — the desktop already has that flaw for the OpenRouter key, and it is a documented gap,
   not a precedent to copy.

## Suggested sequencing

Phases 1 and 2 are independently shippable and leave desktop behavior untouched. Phase 4's pure
modules (`hlc`, `field-clocks`, `merge`) can be written and fully tested against
`MemoryRepository` **before** any migration or transport exists — that is where the design risk
lives, so front-load it. Migration 33 and `applySyncChangeSet` come next, then Phase 3's
transport, then Phase 5 pairing. Phase 6 is optional and last.
