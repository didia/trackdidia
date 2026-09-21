# Spec — One-way TrackDidia → Google Calendar sync for dated tasks

**Status:** approved, unshipped.
**Scope:** mirror dated tasks (Scheduled, and Planned with a planned date) into a dedicated
Google Calendar, and remove the calendar entry when the task is removed from TrackDidia.
One-way only: calendar edits never flow back. Desktop only, disabled by default.

## Context

TrackDidia is local-first: one SQLite database, no cloud sync, no accounts.
[`AGENTS.md`](../../AGENTS.md) lists "Google Calendar synchronization" under *Current
product boundaries*; this spec removes that item once shipped. Dated work today lives in
two places: `scheduled` tasks (`scheduledFor`, auto-promoted to Next Actions on the local
day) and `planned` tasks (project-only queue that reuses `scheduledFor` as an optional
planned date). See [`docs/gtd.md`](../../docs/gtd.md).

## Decisions

| Decision | Choice |
|---|---|
| Provider | Google Calendar API v3 |
| Direction | One-way, TrackDidia is authoritative |
| Calendar | Dedicated app-created **"TrackDidia"** calendar. Forced by the scope below; no calendar picker, and the primary calendar is not reachable without the broader `calendar.events` scope and Google verification |
| OAuth scope | `https://www.googleapis.com/auth/calendar.app.created` (fallback `calendar.events.owned`) |
| Auth machinery | Reuse the Gmail installed-app flow: PKCE, loopback listener, refresh token in the OS vault, access token in memory |
| Sync model | **Desired-state reconciliation** over a link table, not an outbox or write-path hooks |
| Event shape | Timed events, title only, 30 min default duration, one event per occurrence (no RRULE) |
| Deadlines | Out of scope |
| UI | A "Calendrier Google" card in `/parametres`, no new route |

## Why reconciliation instead of an outbox

Task rows are written from many private paths, not only `saveTaskInternal`:
`persistTask` in `movePlannedTask`, `reconcileProjectNextActionInternal`,
`promoteDueScheduledTasks`, the two `moveTasksWith…` normalizations,
`collapseGoogleRecurringTasks` (which also hard-deletes via `deleteTasksByIds`),
recurrence generation and import; `MemoryRepository` has ~14 `this.tasks.set(...)` sites.
An outbox would have to be threaded through all of them in both repositories, and one
missed path desynchronises the calendar permanently.

Instead a sidecar link table is the only sync state and a **pure planner** diffs current
tasks against current links:

```text
planCalendarSync({ tasks, links, today, now, settings, confirmedMassDelete })
  → { creates[], updates[], deletes[], detaches[], abort? }
```

It is idempotent, self-healing after a crash, needs no hook in either repository's write
paths, and is unit-testable with fixtures only (same shape as `src/lib/gtd/scheduled.ts`
and `planned.ts`).

## Identity: `(task_id, occurrence_key)`

`occurrence_key` is the **local `YYYY-MM-DD` of `scheduledFor`** (never a UTC slice).

Required because recurring instances reuse one task id
(`recurring-task:<templateId>`, `src/lib/recurring/engine.ts`), overwritten by upsert on
each occurrence; Google-imported recurrences collapse the same way. Keying by task id
alone would give a daily habit one perpetually sliding event.

A time change within the same local day PATCHes the same link. A **detached link is
terminal** for its occurrence key: never updated, deleted, recreated or re-adopted.

## Eligibility

A `(task, occurrence_key)` is calendar-eligible iff `status === "active"`,
`scheduledFor !== null`, and `bucket === "scheduled"` or (`bucket === "planned"` and
`projectId !== null`). Deadlines, recurrence previews (not task rows), Next Actions,
Inbox, Waiting For, Someday and References are excluded.

## Transition matrix

**Exit rule.** When a link's `(task_id, occurrence_key)` leaves the desired set for any
reason (completed, cancelled, auto-promoted, unscheduled, bucket move, row hard-deleted):

- `occurrence_key > today` → **delete** the event;
- `occurrence_key <= today` → **detach**, recording the reason.

**Reschedule refinement.** If the exit happens and the *same task* is present in the
desired set under a different `occurrence_key` in the same plan, the exit is a
reschedule: **delete** the old event regardless of its date. This prevents a ghost entry
on the old day (an overdue Planned task re-dated to next Friday, or a today-dated task
moved to next week) and cannot wipe an agenda, because a replacement event is created in
the same plan.

| Transition | Outcome |
|---|---|
| Becomes eligible (new dated task, Next Action → Scheduled, Planned with date, new recurrence occurrence) | create (adopt-or-insert) |
| Title/notes change, or time change within the same local day | update if `payload_signature` differs |
| Planned ↔ Scheduled retaining `scheduledFor` | no-op |
| Rescheduled to another local day | old key deleted (reschedule) + new key created |
| Completed | exit rule (tomorrow's task → delete; today's → detach `completed`) |
| Cancelled ("Retirer") | exit rule (`cancelled`) |
| Scheduled auto-promotion at day rollover | exit rule; promotion only fires for dates `<= today`, so always **detach** `promoted`, never delete |
| Manually moved out of Scheduled/Planned | exit rule (`unscheduled`) |
| Row hard-deleted, or orphan link with no task row | exit rule (`task_deleted`) |
| Overdue Planned date, still active | stays synced (Planned is never auto-promoted) |
| Recurring template, three occurrences | three links, three events; past occurrences never patched |

This deliberately deviates from "delete always deletes": completing or cancelling
tomorrow's task clears tomorrow's calendar, while today's and past entries stay as a
record of the day, so the 00:05 auto-promotion of a task scheduled for today at 14:00
cannot wipe today's agenda. State it in `docs/calendar-sync.md` and in the Settings copy.

## Data model — migration 34

33 (`add_weekly_objective_starts_on_week_start_date`) is the highest shipped. Sidecar
tables only; no `ALTER TABLE` on `gtd_tasks`.

```sql
CREATE TABLE IF NOT EXISTS calendar_sync_settings (
  id TEXT PRIMARY KEY CHECK (id = 'global'),
  enabled INTEGER NOT NULL DEFAULT 0,
  provider TEXT NOT NULL DEFAULT 'google',
  oauth_client_id TEXT NOT NULL DEFAULT '',
  connected_account_id TEXT,
  calendar_id TEXT,
  calendar_summary TEXT NOT NULL DEFAULT 'TrackDidia',
  default_duration_minutes INTEGER NOT NULL DEFAULT 30,   -- no v1 UI
  include_notes INTEGER NOT NULL DEFAULT 0,               -- no v1 UI
  mark_busy INTEGER NOT NULL DEFAULT 0,                   -- no v1 UI
  reminders_enabled INTEGER NOT NULL DEFAULT 0,           -- no v1 UI
  state TEXT NOT NULL DEFAULT 'disconnected',
    -- disconnected | active | reconnect_required | needs_confirmation
  generation INTEGER NOT NULL DEFAULT 1,
  last_sync_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS calendar_sync_links (
  task_id TEXT NOT NULL,
  occurrence_key TEXT NOT NULL,
  calendar_id TEXT NOT NULL,
  event_id TEXT NOT NULL,            -- Google-assigned
  generation INTEGER NOT NULL,
  state TEXT NOT NULL,               -- synced | detached | failed
  payload_signature TEXT NOT NULL,   -- canonical payload, compared exactly
  event_start_at TEXT NOT NULL,
  detach_reason TEXT,   -- promoted | completed | cancelled | unscheduled | task_deleted | missing_remote
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (task_id, occurrence_key)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_sync_links_event
  ON calendar_sync_links (calendar_id, event_id);
CREATE INDEX IF NOT EXISTS idx_calendar_sync_links_state
  ON calendar_sync_links (state);
```

Settings get their own table (like `email_triage_settings`), keeping the `AppSettings`
blob, which holds the OpenRouter key, unchanged.

### `generation`

Identity epoch of the connection. Any change of `connected_account_id` or `calendar_id`
bumps it and **clears all links**; remote events from the old epoch are left behind
(documented). Plain **disconnect does not bump** it and keeps links, so reconnecting the
same account resumes. The reconciler ignores and purges links from a foreign generation.

## Event identity: adopt-or-insert

No synchronous SHA-256 exists (`src/lib/hash.ts` is a 32-bit non-crypto hash; WebCrypto is
async), so client-supplied deterministic ids are dropped. Google assigns ids and the
reconciler looks up an existing event before inserting:

```text
GET /calendar/v3/calendars/{calendarId}/events
    ?privateExtendedProperty=trackdidiaTaskId={taskId}
    &privateExtendedProperty=trackdidiaOccurrence={occurrenceKey}
    &showDeleted=false&maxResults=10
```

- Zero hits → `POST` without an `id`, store the returned id.
- **One or more hits → adopt**, choosing deterministically (lowest `id` after sorting,
  never API order). Extra duplicates are deleted in the same run and count against the
  destructive-action budget. **Never POST when the lookup returned a live event.**
- A lookup that **fails** (network/5xx) aborts that create; it never falls through to POST.
- Before persisting an adopted link, check the `(calendar_id, event_id)` unique index: if
  that event is already linked to a different key, skip, mark the link `failed` with
  `calendar_sync_event_already_linked`, and continue the run.

Base URL is `https://www.googleapis.com/calendar/v3`, already in `ALLOWED_HOSTS`.

## Event payload

| Google field | Value |
|---|---|
| `summary` | Task title, trimmed. Nothing else. |
| `description` | Empty unless `include_notes` (no v1 UI) |
| `start` / `end` | `{ dateTime: RFC3339 }`; start = `scheduledFor`, end = start + `default_duration_minutes` |
| `transparency` | `transparent` unless `mark_busy` |
| `reminders` | `{ useDefault: false, overrides: [] }` unless `reminders_enabled` |
| `extendedProperties.private` | `{ trackdidiaTaskId, trackdidiaOccurrence }` |

`payload_signature` is the canonical JSON (stable key order) compared with `===`; an
unchanged signature skips the PATCH, so steady state costs zero Google calls. The bucket
is deliberately not in the payload. All events are timed: `scheduledFor` always carries a
time (`buildIsoFromLocalDateAndTime` defaults `09:00`, recurrence generation `12:00`), so
all-day is not representable.

## Safety valves

- `tasks.length === 0 && links.length > 0` → abort, execute nothing,
  `last_error: "calendar_sync_empty_task_set"`. Signature of a failed read or repository
  swap, not of intent.
- `deletes.length > max(10, 0.25 × activeLinks)` → execute **nothing** (not even creates
  and updates), `state: "needs_confirmation"`.
  - "Synchroniser maintenant" stays enabled in this state and re-runs the plan so the
    summary is current.
  - The one-shot `confirmedMassDelete` override is validated against the **recomputed**
    plan: if the recomputed delete count exceeds the confirmed count the valve re-trips.
  - Settings renders it as a warning banner with a French confirm prompt, not a line of text.

## Reconciler and triggers

`reconciler.ts` bails unless `enabled && state === "active"`, reads settings, links and
`listTasks({ includeCompleted: true })`, plans, executes, persists each link immediately
after its call, and updates `last_sync_at`/`last_error`. Single-flight, 50 actions per
run, per-link `failure_count` with backoff, 403 `rateLimitExceeded`/429 → global
cooldown, `invalid_grant` → `reconnect_required`, and a 404/410 on the **calendar itself**
→ clear links, recreate the calendar, persist the new `calendar_id`, bump `generation`,
resync. A 404/410 on an event PATCH → detach `missing_remote` (do not recreate); on
DELETE → success.

`use-gtd`'s `load()` does **not** cover every mutation, so sync is requested (debounced
~2 s, no-op when no reconciler is registered) from:

- `src/app/use-gtd.ts` — end of `load()`;
- `src/app/use-local-day-reconciliation.ts` — after `promoteDueScheduledTasks` succeeds
  (guarded once per day; focus coverage comes from the hook below, not this site);
- `src/app/use-pomodoro-controller.ts` — after `repository.completeTask(...)`;
- `src/pages/RecurrencesPage.tsx` — after template save/pause/resume/cancel;
- `src/app/use-email-triage-coordinator.ts` — the GTD-update adapter. Note that
  `email-triage-sqlite-store.ts` `resolveReview` applies a GTD update inside the store and
  does not nudge: backstop-only.

`src/app/use-calendar-sync.ts` mounts beside `useEmailTriageCoordinator` only when
`repository && !browserPreview && allowStart`, runs one reconcile on start, a 15-minute
backstop timer and a window `focus` listener. A missed nudge costs latency, never
correctness.

`listTasks` is not a pure read (it runs recurrence generation and Scheduled promotion), so
a reconciler-only wake-up can itself promote tasks. This is relied on as an invariant and
pinned by test; do not change `listTasks` here.

## Files

**New:** `src/domain/calendar-sync.ts`; `src/lib/calendar/{eligibility,planner,
google-calendar-api,google-calendar-oauth,vault,session,reconciler,connect}.ts`;
`src/lib/storage/calendar-sync-{sqlite,memory}-store.ts`; `src/app/use-calendar-sync.ts`;
`docs/calendar-sync.md` + `docs/logs/calendar-sync.md`.

**Changed:** `tauri-sqlite-repository.ts` (migration 34, store delegation; no change to
`persistTask` or any write path), `memory-repository.ts`, `repository.ts` (settings get/
save; links list/get/save/delete/detach/clear), `app-context.tsx`, the trigger sites
above, `SettingsPage.tsx` + `src/locales/fr/settings.json`, and
`src-tauri/src/vault.rs` (new kind `calendar_credentials` in `resolve_key`, the only Rust
change; no capability or CSP change).

**Docs (required by AGENTS.md):** register the new page in `docs/index.md`, the
quick-reference table in **both** `AGENTS.md` and `CLAUDE.md` (byte-identical), and
`docs/log.md`; update `docs/storage-and-backups.md`, `docs/gtd.md`, `docs/architecture.md`;
remove "Google Calendar synchronization" from *Current product boundaries* only once it
ships; move this spec to `specs/done/`.

## Settings card (v1)

Enable toggle, advanced OAuth client-id field, Connecter/Reconnecter/Déconnecter,
connected account and calendar name (read-only), last sync, last error, "Synchroniser
maintenant", and the `needs_confirmation` banner. Copy must state that a dedicated
TrackDidia calendar is created automatically and cannot be changed, that task titles
leave the machine, and that today's and past entries are kept when a task is completed
or removed. Disabled in browser preview. The four dormant settings columns have no UI.

## Risks

1. **Google OAuth "Testing" status expires refresh tokens after 7 days**, and calendar
   scopes are sensitive. Set the consent screen to *In production* (unverified is fine
   for one user). Document it: it is the likeliest "silently stopped" report.
2. **Loopback collision.** `oauth_loopback.rs` holds one global session, so a calendar
   connect cancels a pending email-triage connect. Guard in TypeScript with a shared
   "OAuth in progress" flag and a French message.
3. **Rate limits on first sync.** Adopt-or-insert costs one `events.list` per create, so
   a large backlog does N list + N insert calls under the 50-action cap. Watch the first
   real run for 403 `rateLimitExceeded`.
4. **Backups** contain `calendar_sync_links`; restored stale links are handled by
   `missing_remote`, calendar recreation and the empty-set valve. Document it.
5. **Timezone.** `occurrence_key` is a local date; tests are pinned to
   `TZ: America/Toronto`, so exercise near-midnight instants.
6. **Privacy.** Titles leave the machine once enabled; the refresh token lives in the OS
   vault, never SQLite; logs carry counts, occurrence keys and event ids only.
7. Terminal rows must be readable: verify `filterTasks` with `includeCompleted: true`
   returns cancelled rows, else add a dedicated read.

## Test plan

**Planner** (`src/lib/calendar/planner.test.ts`): create for Scheduled and Planned-with-
project, none for Planned without project, Next Action, deadline-only, preview ids;
update only on signature change; Planned ↔ Scheduled no-op; same-day time change → one
update; cross-day reschedule deletes the old event and creates the new one (including
overdue-Planned re-dated to the future and today → future); exit rule exhaustively
(completed/cancelled tomorrow → delete, today → detach; unschedule future → delete, past
→ detach); **auto-promotion at 00:05 → detach `promoted`, zero deletes**; orphan link with
no task row; one template × three occurrences → three events, past never patched;
detached links never re-planned; overdue Planned stays synced; both valves and the
`confirmedMassDelete` re-trip; idempotence.

**Eligibility/payload:** local-date `occurrence_key` at 23:50 and 00:10; signature changes
on title/time/notes-with-setting but not bucket; duration clamp.

**API client** (stubbed http as in `gmail-api.test.ts`): `ensureCalendar` creates only when
absent; lookup sends both `privateExtendedProperty` params and `showDeleted=false`; **two
matching events → adopts the deterministic one, deletes the extra, inserts nothing**;
**lookup error → no insert**; zero hits → insert; 404/410 classification; `invalid_grant`.

**Reconciler** (MemoryRepository + fake API): create → update → delete; crash between
insert and link write → no duplicate; adopted event already linked elsewhere →
`failed`, run continues; calendar remotely deleted → recovery; `invalid_grant` →
`reconnect_required` with no further calls; mid-run failure keeps earlier links;
single-flight, batch cap, backoff, foreign-generation purge; never mounts under
`browserPreview` or the startup fallback (zero API calls, zero vault access).

**Storage:** parity in `memory-repository.test.ts` for every new method;
`calendar-sync-persistence.test.ts` (composite PK, unique index, defaults); migration
assertion test in `src/lib/storage/migrations/`.

**Hooks/screens:** day-rollover, pomodoro `completeTask` and recurrence-template mutations
each request a sync, and `requestCalendarSync` no-ops with nothing registered; Settings
card disabled in preview, toggle persists, connect disabled without a client id,
`needs_confirmation` banner and confirm rerun, error line.

**Gates:** `npm run test`, `npm run build`, and `npm run verify:all` (vault.rs changes).
OAuth, vault and real Google calls need a manual `npm run tauri dev` run against the dev
database, after a manual backup.

## Phases

0. **Model and planner (no network):** migration 34 + test, stores, repository methods,
   domain, eligibility, planner and tests.
1. **Connection:** vault kind, OAuth, API client, `ensureCalendar`, trimmed Settings card,
   loopback guard. Reconciler not mounted.
2. **Reconciler:** reconciler, session, hook, trigger sites, error handling, calendar
   recreation, `needs_confirmation`, manual sync. First real desktop run.
3. **Docs and polish:** `docs/calendar-sync.md` + log, registrations, boundary removal,
   spec to `specs/done/`.

## Non-goals

Two-way sync, importing calendar events, a calendar picker or primary-calendar writes,
deadlines as events, all-day events, RRULE series, and UI for the four dormant settings
columns.
