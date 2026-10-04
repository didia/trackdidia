# Calendar sync

One-way, desktop-only mirroring of dated TrackDidia tasks into a dedicated Google
Calendar. Disabled by default. Calendar edits never flow back into TrackDidia.

## Design

TrackDidia is local-first (one SQLite database, no cloud sync, no accounts). Dated
work lives in two GTD buckets — `scheduled` tasks (`scheduledFor`, auto-promoted to
Next Actions on the local day) and `planned` tasks (a project-only queue that reuses
`scheduledFor` as an optional planned date); see [GTD](gtd.md). Calendar sync mirrors
a subset of those tasks into one app-created Google Calendar named "TrackDidia", and
removes or detaches the calendar entry when the task leaves the mirrored set.

Sync state is **desired-state reconciliation** over a sidecar link table, not an
outbox. Task rows are written from many internal paths (`persistTask`,
`movePlannedTask`, project next-action reconciliation, Scheduled promotion, the
Google Tasks recurrence collapse, recurrence generation, import), so a write-path
hook would have to be threaded through every one of them in both repositories. A
pure planner instead diffs the current tasks against the current links on every
reconcile pass:

```text
planCalendarSync({ tasks, links, today, now, settings, confirmedMassDelete })
  → { creates[], updates[], deletes[], detaches[], abort? }
```

(`src/lib/calendar/planner.ts`). It is idempotent and self-healing after a crash,
and needs no hook in the general task-write paths. It needs exactly one choke-point
hook — [promotion capture](#promotion-capture) — because Scheduled promotion
destroys the data the planner would otherwise diff.

## Identity: `(task_id, occurrence_key)`

`occurrence_key` is the local `YYYY-MM-DD` of `scheduledFor` (never a UTC slice).
This is required because recurring instances reuse one task id
(`recurring-task:<templateId>`, `src/lib/recurring/engine.ts`, overwritten on each
occurrence; Google-imported recurrences collapse the same way) — keying by task id
alone would give a daily habit one perpetually sliding event.

A time change within the same local day PATCHes the same link. A **detached link is
terminal** for its occurrence key: never updated, recreated, or re-adopted, except
for the single exception in
[Rescheduling a promoted task](#rescheduling-a-promoted-task).

## Eligibility

A `(task, occurrence_key)` is calendar-eligible iff `status === "active"`,
`scheduledFor !== null`, and `bucket === "scheduled"` or (`bucket === "planned"`
and `projectId !== null`). Deadlines, recurrence previews (not task rows), Next
Actions, Inbox, Waiting For, Someday, and References are excluded
(`src/lib/calendar/eligibility.ts`).

## Promotion capture

`listTasks()` runs `generateDueRecurringTasks(today)` and then
`promoteDueScheduledTasks(today)` before it reads. Promotion moves every active
Scheduled task whose local `scheduledFor` date is today or earlier to Next Actions
and **clears `scheduledFor`**. A recurrence occurrence generated for today is
therefore promoted in the same call and is never visible as Scheduled, and a task
created or edited to a time later today is usually promoted before the reconciler's
2-second debounce fires. A pure diff of current task rows would never see today's
dated work — exactly the work a calendar is most useful for.

The promotion step itself, in both `TauriSqliteRepository` and `MemoryRepository`,
records the instant before clearing it: for each task about to be promoted, when
sync is `enabled` and `state` is `active` or `needs_confirmation`, the same
operation (the same SQLite transaction; the same synchronous block in
`MemoryRepository`) upserts a link row for `(task_id, occurrence_key)` with
`state = 'pending'`, `event_id = NULL`, and `payload_signature` built from the task
as it is at that moment. If a `synced` link with the same signature already exists,
capture does nothing. If it exists with a different signature, the link becomes
`pending` with its `event_id` kept, so the planner updates from the snapshot before
detaching.

A `pending` link is a virtual desired occurrence: the planner creates an event from
the stored snapshot whether or not a matching task row still exists, then detaches
the link with reason `promoted`. A link that is `pending`, or `detached` with reason
`promoted`, is *reclaimable*: if its key re-enters the desired set (the task is
re-dated the same local day before the next promotion), the live task payload
supersedes the snapshot and the link returns to the live path. Links detached with
`completed`, `cancelled`, `unscheduled`, `task_deleted`, or `missing_remote` stay
terminal.

A `pending` link older than 7 days is dropped without creating, so a long offline
stretch does not later create events days in the past. If a `pending` link's task
is not recurrence-generated and is live-eligible under a different occurrence key
in the same plan, the pending link is dropped without creating (the user re-dated
before the reconciler ran).

**Not back-filled.** Enabling sync does not recover work already promoted earlier
that day; its instant is gone. Only Scheduled tasks still holding a `scheduledFor`,
and tasks promoted after sync is enabled, are mirrored. The Settings copy states
this.

## Transition matrix (summary)

**Exit rule.** When a link's `(task_id, occurrence_key)` leaves the desired set
(completed, cancelled, auto-promoted, unscheduled, bucket move, row hard-deleted):
`occurrence_key > today` deletes the event; `occurrence_key <= today` detaches it,
recording the reason.

**Reschedule refinement.** If the same task is present in the desired set under a
different `occurrence_key` in the same plan, the exit is a reschedule: delete the
old event regardless of its date, because a replacement event is created in the
same plan.

| Transition | Outcome |
|---|---|
| Becomes eligible | create (adopt-or-insert) |
| Title/notes/time change within the same local day | update if `payload_signature` differs |
| Planned ↔ Scheduled retaining `scheduledFor` | no-op |
| Rescheduled to another local day | old key deleted + new key created |
| Completed | exit rule (future → delete; today/past → detach `completed`) |
| Cancelled | exit rule (`cancelled`) |
| Scheduled auto-promotion / day rollover | event created if missing, then detached `promoted`; never deleted |
| Manually moved out of Scheduled/Planned | exit rule (`unscheduled`) |
| Row hard-deleted, or orphan link | exit rule (`task_deleted`) |
| Overdue Planned, still active | stays synced (Planned is never auto-promoted) |
| Recurring template, several occurrences | one link/event per occurrence; past occurrences never patched |

### Rescheduling a promoted task

A promoted link is `detached` (terminal), so without an exception it would leave
the old event behind when the task is later moved to another day. The single
explicit exception: when a task with an active `scheduledFor` has a `detached` link
with reason `promoted` under a different `occurrence_key`, and the task is **not**
recurrence-generated (`task.isRecurringInstance === true || task.recurrenceGroupId
!== null`), that old event is deleted (any date) and its link removed, with reason
`rescheduled_after_promotion`. `completed` and `cancelled` detachments are records
and are never deleted by this rule. Recurring tasks are excluded because the same
task id is reused for every generated occurrence; applying the exception to them
would delete yesterday's entry every morning. Known limitation: manually moving a
single already-promoted recurring occurrence leaves its old event in place.

This deliberately deviates from "delete always deletes": completing or cancelling
tomorrow's task clears tomorrow's calendar, while today's and past entries stay as
a record of the day, so the daily auto-promotion of a task scheduled for today
cannot wipe today's agenda.

## Removal rule

An event is deleted outright only when its occurrence key is still in the future at
the moment it exits the desired set, or when the reschedule refinement/exception
fires. Every other exit (today-or-past completion, cancellation, unscheduling, or
promotion) detaches the link and leaves the event in place, so the calendar keeps a
record of what happened on a given day rather than erasing history retroactively.

## Data model — migration 37

Migration 37 (`create_calendar_sync`) adds two sidecar tables; no `ALTER TABLE` on
`gtd_tasks`. See [Storage and backups](storage-and-backups.md#calendar-sync-tables)
for the full column reference.

- `calendar_sync_settings` — singleton (`id = 'global'`) row: enable flag, provider,
  OAuth client id, connected account/calendar ids, calendar summary, four dormant
  columns with no v1 UI (`default_duration_minutes`, `include_notes`, `mark_busy`,
  `reminders_enabled`), connection `state`
  (`disconnected | active | reconnect_required | needs_confirmation`), `generation`,
  `last_sync_at`, `last_error`.
- `calendar_sync_links` — one row per calendar-eligible `(task_id, occurrence_key)`
  (composite primary key), `event_id` nullable, `state`
  (`pending | synced | detached | failed`), `payload_signature` (canonical event
  body; also the stored snapshot for `pending` links), `event_start_at`,
  `detach_reason`, `failure_count`, `last_error`. A unique index on
  `(calendar_id, event_id)` constrains only rows that own an event, since SQLite
  permits any number of `NULL`s.

### `generation`

Identity epoch of the connection. Any change of `connected_account_id` or
`calendar_id` bumps it and clears every link; remote events from the old epoch are
left behind. A plain disconnect does not bump it, so reconnecting the same account
resumes. The reconciler ignores and purges links from a foreign generation.

## Event identity: adopt-or-insert

Google assigns event ids; there is no synchronous hash available client-side for a
deterministic id, so the reconciler looks up an existing event before inserting via
`privateExtendedProperty=trackdidiaTaskId=<taskId>` and
`privateExtendedProperty=trackdidiaOccurrence=<occurrenceKey>` (paginated,
`showDeleted=false`). The lookup exhausts pagination (up to 20 pages) before it
decides anything, because an empty page can still carry a `nextPageToken`. Zero hits
across all pages inserts a new event; one or more hits adopts the lowest id
deterministically and deletes every other hit as a duplicate; a failed or
page-capped lookup aborts the create as retryable and never falls through to an
insert. Before persisting an adopted link, the `(calendar_id, event_id)` unique
index is checked: if that event is already linked to a different key, the link is
recorded as `failed` with `event_id = NULL` instead of adopting, and the run
continues.

## Event payload

| Google field | Value |
|---|---|
| `summary` | Task title, trimmed |
| `description` | Empty unless `include_notes` (no v1 UI) |
| `start` / `end` | `{ dateTime }`; start = `scheduledFor`, end = start + `default_duration_minutes` (30 by default) |
| `transparency` | `transparent` unless `mark_busy` |
| `reminders` | `{ useDefault: false, overrides: [] }` unless `reminders_enabled` |
| `extendedProperties.private` | `{ trackdidiaTaskId, trackdidiaOccurrence }` |

`payload_signature` is the canonical JSON (stable key order), compared with `===`;
an unchanged signature skips the PATCH, so steady state costs zero Google calls. All
events are timed — `scheduledFor` always carries a time — so all-day events are not
representable.

## Safety valves and gate table

- `tasks.length === 0 && links.length > 0` aborts the run and executes nothing
  (`last_error: "calendar_sync_empty_task_set"`) — the signature of a failed read or
  repository swap, not of intent.
- `deletes.length > max(10, 0.25 × activeLinks)` executes nothing (not even the
  creates and updates in the same plan) and sets `state: "needs_confirmation"` with
  the delete count and a summary in `last_error`.

The reconciler has one entry point, `reconcile({ trigger })`
(`src/lib/calendar/reconciler.ts`), and the state gate depends on the trigger:

| Trigger | `active` | `needs_confirmation` | `reconnect_required` / `disconnected` |
|---|---|---|---|
| Automatic (debounced nudge, 15-min backstop, window focus) | runs | no-op | no-op |
| `syncNow()` (Settings button) | runs | replans, no override | fails fast to the reconnect prompt |
| `confirmMassDelete(n)` (confirmation banner button) | n/a | replans with override `n` | n/a |

In `needs_confirmation`, `syncNow()` recomputes the plan: if the valve no longer
trips it executes and returns to `active`; otherwise it stays in
`needs_confirmation` with a refreshed summary. `confirmMassDelete(n)` carries the
delete count the user was shown; it executes only if the recomputed count is
`<= n`, then returns to `active` — if the count grew, the valve re-trips and the
override is not consumed. The override is single-use and never persisted. Automatic
triggers stay no-ops while confirmation is pending, but promotion capture keeps
running, so nothing is lost while the user decides.

The reconciler is also single-flight (a call made while one is running joins the
in-flight promise), caps a run at 50 actions, and applies per-link exponential
backoff on failure (`2^failureCount` minutes, capped at 30). A 403
`rateLimitExceeded`/429 response sets a **15-minute global cooldown** that blocks
only the `automatic` trigger (`syncNow()`/`confirmMassDelete()` bypass it, so a
manual retry is never silently swallowed). An `invalid_grant` response moves
settings to `reconnect_required` and stops the run. A 404/410 on the **calendar
itself** (`calendar_not_found`) clears every link, recreates the calendar, persists
the new `calendar_id`, bumps `generation`, and re-runs the reconcile once; a second
404 in that same re-run is recorded as a per-link failure instead of recovering
again, so a persistently missing calendar cannot loop. A 404/410 on an event PATCH
detaches the link with reason `missing_remote` (it is not recreated); on DELETE it
is treated as success.

## Triggers

`src/app/use-calendar-sync.ts` mounts beside `useEmailTriageCoordinator`, only when
a repository exists, this is not browser preview, and startup has settled. It runs
one reconcile on mount, a 15-minute backstop timer, and a window `focus` listener,
and registers the debounced (~2 s) `requestCalendarSync()` entry point, which is a
no-op when nothing is mounted. `use-gtd`'s `load()` does not cover every mutation,
so `requestCalendarSync()` is also called from:

- `src/app/use-gtd.ts` — end of `load()`;
- `src/app/use-local-day-reconciliation.ts` — after `promoteDueScheduledTasks`
  succeeds (guarded once per day);
- `src/app/use-pomodoro-controller.ts` — after `repository.completeTask(...)`;
- `src/pages/RecurrencesPage.tsx` — after template save/pause/resume/cancel;
- `src/app/use-email-triage-coordinator.ts` — the GTD-update adapter (email triage's
  own `resolveReview` applies a GTD update without nudging; this is backstop-only).

`listTasks()` is not a pure read (it runs recurrence generation and Scheduled
promotion), so any caller, including a reconciler-only wake-up, can promote tasks —
this is why promotion capture lives inside the promotion step rather than in the
reconciler.

## OAuth, vault, and scopes

Calendar sync reuses the Gmail installed-app OAuth flow from
`src/lib/email-triage/oauth/gmail-oauth.ts`: PKCE, a loopback listener, and the same
Google token endpoint, with a calendar-scoped authorization URL
(`src/lib/calendar/google-calendar-oauth.ts`). The requested scope is
`https://www.googleapis.com/auth/calendar.app.created` plus the non-sensitive
`email` scope — `calendar.app.created` alone cannot read the primary calendar or the
account's email address, so `email` is requested alongside it purely to identify
the connected account (`GoogleCalendarApiClient.getAccountProfile`). The refresh
token is stored in the OS vault under the fixed `calendar_credentials` kind
(`src-tauri/src/vault.rs` `resolve_key`; there is only ever one connected account,
so no `accountId` is needed, unlike email triage's per-account `provider_credentials`
entries). The access token stays in memory only (`src/lib/calendar/session.ts`).

**Loopback collision.** `oauth_loopback.rs` holds exactly one global loopback
session: starting a new OAuth flow silently cancels any pending one. Email triage
(Gmail, Microsoft Graph) and calendar sync both drive that loopback, so a flow
started by one would otherwise cancel a flow in progress for the other.
`src/lib/oauth-loopback-guard.ts` is the TypeScript-side mutex: whichever flow
acquires the lease first holds it until it releases (success, failure, or timeout);
the other is rejected up front with a clear French error
(`oauth_loopback_busy`) instead of silently losing its callback.

## Settings card

A "Calendrier Google" card on `/parametres` (no new route): enable toggle, an
advanced OAuth client-id field, Connecter/Reconnecter/Déconnecter, the connected
account and calendar name (read-only), last sync, last error, a "Synchroniser
maintenant" button, and the `needs_confirmation` banner with a French confirm
prompt. The connect action is disabled without a resolved client id (settings field,
falling back to `VITE_CALENDAR_OAUTH_CLIENT_ID`) or in browser preview. The copy
states that a dedicated TrackDidia calendar is created automatically and cannot be
changed, that task titles leave the machine once sync is enabled, that today's and
past entries are kept when a task is completed or removed (only future entries are
deleted), and that enabling sync is not retroactive. The four dormant settings
columns have no UI.

## Risks

1. **Google OAuth "Testing" publishing status expires refresh tokens after 7 days**,
   and calendar scopes are sensitive. The OAuth consent screen must be set to
   *In production* (an unverified app is fine for a single user) — this is the
   likeliest cause of a "sync silently stopped working" report.
2. **Loopback collision** between calendar sync and email triage OAuth flows; see
   [OAuth, vault, and scopes](#oauth-vault-and-scopes).
3. **Rate limits on first sync.** Adopt-or-insert costs one `events.list` call per
   create, so a large backlog does up to N list + N insert calls, capped by the
   50-action budget per run; watch the first real run for 403 `rateLimitExceeded`.
4. **Backups** contain `calendar_sync_links`. A restored stale link is handled by
   `missing_remote` detachment, calendar recreation on a 404 of the calendar itself,
   and the empty-task-set safety valve — see
   [Storage and backups](storage-and-backups.md#calendar-sync-tables).
5. **Timezone.** `occurrence_key` is a local date, not a UTC slice; near-midnight
   instants are exercised by tests pinned to `TZ=America/Toronto`.
6. **Privacy.** Task titles leave the machine once sync is enabled; the refresh
   token lives in the OS vault, never SQLite; logs carry counts, occurrence keys,
   and event ids only, never titles or tokens.
7. **Not back-filled.** Enabling sync does not recover work already promoted
   earlier that day; see [Promotion capture](#promotion-capture).

## Non-goals

Two-way sync, importing calendar events into TrackDidia, a calendar picker or
writes to the primary calendar, deadlines as events, all-day events, RRULE series,
and UI for the four dormant settings columns.

## Related documentation

- [Storage and backups](storage-and-backups.md)
- [GTD](gtd.md)
- [Architecture](architecture.md)
- [AI, settings, and privacy](ai-settings-and-privacy.md)
- [Email triage](email-triage.md)
