# Spec — Project Scheduling

**Status:** draft, awaiting review (not approved, nothing implemented).
**Plan review:** design approved by the `plan-review` process (Sonnet planner, Opus
validator) after 2 iterations. Complexity: **high**.
**Scope:** let a project be *scheduled* for a later day, the way a task can be. A scheduled
project is inactive: its tasks stay in the Planned queue and are never auto-promoted. It
appears on the Scheduled screen and, when calendar sync is on, in Google Calendar. When its
day arrives it becomes an ordinary active project and the existing Planned-task promotion
supplies its first Next Action.

## Outcome

The user can defer a whole project ("start the kitchen renovation on March 3") without its
actions polluting today's Next Actions, and without having to remember to reactivate it.

- Scheduling a project (from `active` or `on_hold`) with a future date turns it into a
  `scheduled` project.
- While scheduled, none of its work is executable: existing Next Actions and dated
  Scheduled tasks move into the Planned queue, and new tasks aimed at Next Actions or
  Scheduled land in Planned instead.
- It is visible in the in-app calendar (the Scheduled screen) on its day and, with sync on,
  in Google Calendar.
- On the scheduled local day (or the first reconcile after it, if the app was closed) the
  project becomes `active` and the existing planned-task reconciliation promotes exactly
  one Planned task. From then on it is a normal project.

## Scope tiers (the trade-off, stated plainly)

The request strictly requires only "an inactive project never auto-promotes". The existing
promotion logic already gives that for any status other than `active` (this is how
`on_hold` behaves). The feature therefore has two tiers:

- **Tier A — status gate.** New `scheduled` status, project `scheduledFor`, time-driven
  activation, calendar presence, Scheduled-screen UI. Needed for the feature to exist.
- **Tier B — containment.** Existing Next Actions/Scheduled tasks are demoted to Planned
  when the project is scheduled, and the project cannot hold executable tasks while
  scheduled. This matches "all its tasks remain planned" but goes beyond what `on_hold`
  does today, and it adds an invariant to every task write path.

This spec **includes Tier B by default**. [Open question 1](#open-questions) records what
dropping it removes.

## Non-goals

- Project deadlines or end dates (projects have no deadline field).
- All-day calendar events (an existing calendar-sync non-goal).
- Recurring project schedules.
- A project event ledger (no `project_*` events exist; none are added).
- Restoring a task's pre-scheduling bucket when the project is unscheduled or activated.
- A "projects starting today" widget on Today.
- New LLM-bridge write tools (the bridge surface stays append-only).

## Current state (verified against the code)

- `ProjectStatus` has four values (`active`, `on_hold`, `completed`, `cancelled`), stored
  in `gtd_projects.status`, a plain `TEXT NOT NULL` with no CHECK constraint.
- Every "is this project usable" gate tests `status === "active"`:
  `reconcileProjectPlannedTasks` and `assertPlannedProjectActive` in
  [`src/lib/gtd/planned.ts`](../../src/lib/gtd/planned.ts), `projectsForAssignment` in
  [`src/lib/gtd/engine.ts`](../../src/lib/gtd/engine.ts), `findActiveProject` in
  [`src/lib/llm-bridge/tools.ts`](../../src/lib/llm-bridge/tools.ts),
  `computeGtdHealthFindings` in
  [`src/domain/insights/gtd-health.ts`](../../src/domain/insights/gtd-health.ts), and
  `ProjectsPage`. A new status is therefore inert at all of them with no edit.
- `on_hold` projects keep their existing Next Actions; the nearest precedent is "an inactive
  project never auto-promotes".
- Task scheduling stores `scheduledFor` as an ISO instant built from a local date and
  optional time (`buildIsoFromLocalDateAndTime`, default 09:00). Scheduled-task promotion
  compares the **local calendar date only** and clears `scheduledFor`.
- Day reconciliation lives in `reconcileGtdDay`
  ([`src/lib/gtd/reconcile.ts`](../../src/lib/gtd/reconcile.ts)): recurrences, Scheduled
  promotion, weekly carryover, expired Pomodoro. It runs at bootstrap, at the local-day
  boundary (`use-local-day-reconciliation.ts`), on every `use-gtd` load, and in the bridge
  `add_tasks`.
- Recurrence generation persists through `persistTask` and bypasses `saveTask` and project
  reconciliation.
- There is no separate calendar view. The in-app calendar is
  [`src/pages/ScheduledPage.tsx`](../../src/pages/ScheduledPage.tsx) (day/week). The only
  other calendar surface is the one-way Google sync
  ([`docs/calendar-sync.md`](../../docs/calendar-sync.md), shipped via
  [`../done/calendar-sync.md`](../done/calendar-sync.md)).
- `planCalendarSync` aborts with `empty_task_set` when `tasks.length === 0 && links.length > 0`
  (a failed-read safety valve) and has a single caller, `runReconcile` in
  `src/lib/calendar/reconciler.ts`.

## Product rules

1. **Invariant.** `scheduledFor` is non-null **if and only if** `status === "scheduled"`.
2. **Who can be scheduled.** An `active` or `on_hold` project can be scheduled; a
   `scheduled` project can be rescheduled. `completed` and `cancelled` projects cannot be
   scheduled (the user must change their status first).
3. **Activation.** A scheduled project becomes active when the **local date** of its
   `scheduledFor` is today or earlier. Time of day is ignored, exactly as for Scheduled
   tasks. Missed days catch up at the next reconcile (startup, midnight, window focus,
   becoming visible, or any GTD reload).
4. **Activation effect.** `status = active`, `scheduledFor = null`, `statusChangedAt` and
   `updatedAt` = now. The existing project reconciliation then promotes exactly one Planned
   task (lowest `plannedOrder`), or none if the project already has an active Next Action
   (for example a recurring instance).
5. **Other exits.** Pause (`on_hold`), Terminer (`completed`) and Retirer (`cancelled`) on a
   scheduled project also clear `scheduledFor`. They promote nothing.
6. **Early start.** "Démarrer maintenant" and clearing the date are the same operation as
   natural activation (`scheduleProject(id, null)`), including the single promotion.
7. **Start-now normalization.** A requested date that is today or earlier, on any path
   (`scheduleProject`, `saveProject`, the bridge), means "start now": the project is `active`,
   the date is cleared, and **nothing is demoted**. Scheduling for today must not destroy
   the user's Next Actions. The UI sets the date input `min` to tomorrow.
8. **Containment (Tier B).** While a project is `scheduled`, it holds no *active,
   non-recurring* `next_action` or `scheduled` task; those live in `planned`.
   - Entering `scheduled`: every such task is demoted to `planned`. Resulting queue,
     renumbered `0..n-1`: (a) demoted Next Actions by `createdAt`, `id`; (b) the existing
     Planned queue in its current order; (c) demoted dated Scheduled tasks by
     `scheduledFor`, `createdAt`, `id`. Demoted Scheduled tasks **keep** `scheduledFor`
     (the existing Scheduled → Planned retention rule), so their own calendar events stay.
   - New or edited tasks: a requested `next_action` or `scheduled` bucket for such a task is
     coerced to `planned` *before* persist (no spurious `task_moved_to_next_action` event).
   - Untouched: `inbox`, `waiting_for`, `someday_maybe`, `reference` tasks (not executable
     work), recurring instances (they cannot be Planned and generation bypasses `saveTask`;
     templates keep generating, as for `on_hold`), and completed/cancelled tasks.
9. **No bucket restore.** Unscheduling or activating does not put demoted tasks back. The
   original bucket is not stored, restoring would need a new column, and it would conflict
   with edits made while scheduled. Activation re-supplies one Next Action, and the UI shows
   the number of tasks that will be moved before the user confirms scheduling.
10. **Manual promotion while scheduled** is rejected (the existing
    `assertPlannedProjectActive`). Reordering stays allowed.
11. **Bulk moves.** Selecting tasks that belong to a scheduled project and bulk-moving them
    to Next Actions or Scheduled **skips** those tasks and counts them in the existing
    "skipped" total, the same way `planBulkBucketMove`
    ([`src/lib/gtd/bulk-move.ts`](../../src/lib/gtd/bulk-move.ts)) already skips "Scheduled
    without a date" and "Planned without a project". The planner receives the projects to
    decide this. Repository coercion (rule 8) remains the safety net for paths with no UI
    (bridge, AI proposals, other callers).

## Data model and migration

Append a SQLite migration named `add_gtd_project_scheduled_for` with the **next free id at
implementation time** (42 as of commit `1db00d5`; other in-flight specs, such as
multi-laptop sync, also add migrations). Never renumber or rewrite shipped migrations.

```sql
ALTER TABLE gtd_projects ADD COLUMN scheduled_for TEXT;
UPDATE gtd_projects SET scheduled_for = NULL WHERE status != 'scheduled';
```

- Use `guards.skipIfColumnExists` like migrations 26, 33, 34, 38 and 41; the guard
  statement text must match the SQL exactly.
- No index (the projects table is tiny and `listProjects` loads all rows).
- `status` needs no schema change (no CHECK).
- `shipped-migrations.json` pins only the first 36 migrations and is not touched.
- New test `src/lib/storage/migrations/project-scheduled-for.test.ts`, modelled on
  `planned-order.test.ts`: column present, normalization applied, guarded and a no-op on
  re-run, id strictly increasing.

Types: `ProjectStatus` gains `"scheduled"`; `Project` gains a **required**
`scheduledFor: string | null` (mirrors `Task.scheduledFor`). Row mapping
(`src/lib/storage/sqlite/rows/projects.ts`): add `scheduled_for` to `ProjectRow`, `COLUMNS`,
`fromRow` (`?? null`) and `toParams` (11 columns). In `TauriSqliteRepository` the hard-coded
`$1…$10` placeholder lists (Google import insert and `saveProject`) become `$1…$11` and the
`ON CONFLICT DO UPDATE` gains `scheduled_for = excluded.scheduled_for`. `MemoryRepository`
mirrors the same fields. About 15 test files with `Project` literals need the new field
(listed in the implementation notes below).

## Repository API and invariants

All domain logic is pure and shared; the two repositories only call it.

**New module `src/lib/gtd/project-schedule.ts`** (with `.test.ts`):

- `normalizeProjectSchedule(project, today, now)`: a non-`scheduled` status forces
  `scheduledFor = null`; `scheduled` with no date throws a distinct ASCII French error
  (for example "Un projet programme doit avoir une date" — not the text of the existing
  `assertPlannedProjectActive` error); `scheduled` with a local date ≤ today returns
  `{ status: "active", scheduledFor: null, statusChangedAt: now }`.
- `applyProjectScheduleChange(project, scheduledFor, today)`, mirroring
  `applyScheduleChange` in `schedule.ts`: a date after today → `scheduled` (from `active`,
  `on_hold` or `scheduled`); a date ≤ today → start now; `null` on a scheduled project →
  `active`; `completed`/`cancelled` throws.
- `selectDueScheduledProjects(projects, today, now)`: only projects that actually change
  under `normalizeProjectSchedule`.
- `isProjectScheduledForDate(project, date)`, built on `isSameLocalDate`.

**`AppRepository` additions** (both implementations):

- `scheduleProject(projectId, scheduledFor | null): Promise<Project>` — require the project,
  `applyProjectScheduleChange`, then `saveProject`.
- `activateDueScheduledProjects(date): Promise<number>` — returns the count activated.
- `saveProject` runs `normalizeProjectSchedule(next, getTodayDate(), now)` before the
  upsert. The existing `reconcileProjectsInternal(tx, [id])` afterwards performs the demotion
  on entering `scheduled` and the single promotion on leaving it.
- `createTaskInternal` and `saveTaskInternal` load the task's project and pass it as a new
  optional 4th argument to `adjustPlannedFieldsForSave` (`planned.ts`), which applies the
  coercion of rule 8 *before* the existing planned logic assigns `plannedOrder`.
- `reconcileProjectPlannedTasks(tasks, project, now)` gains a `scheduled` branch: demote
  every active non-recurring `next_action`/`scheduled` task per rule 8 (returning only
  changed tasks, `updatedAt = now`), promote nothing. This is the safety-net sweep for
  entering `scheduled` and for bypass paths.

**No writes when nothing is due.** `reconcileDay` runs on every `use-gtd` load and in the
bridge, and the sync specs require a generator that finds nothing to do to write nothing.
`activateDueScheduledProjects`:

1. Reads projects **outside** the writer (the existing `listProjects` pattern) and computes
   `selectDueScheduledProjects`. If empty, return `0` without entering `writeTransaction`,
   persisting any row, touching `updatedAt`, or calling `reconcileProjectsInternal`.
2. Otherwise enter `writeTransaction`, **re-read and recompute** (another queued mutation
   may have run in between), persist each activated project with `statusChangedAt = now`,
   then `reconcileProjectsInternal(tx, activatedIds)`, which emits
   `task_moved_to_next_action` with a local event date through the existing path.

Transaction rules are unchanged from the Planned-tasks feature: helpers receive `tx` and
never call public methods that re-enter the writer; demotion and activation run inside one
`writeTransaction`. `MemoryRepository` follows the same shape with synchronous maps and an
early return with no map writes.

## Reconciliation and bootstrap

[`src/lib/gtd/reconcile.ts`](../../src/lib/gtd/reconcile.ts): `ReconcileDayPort` gains
`"activateDueScheduledProjects"` and `ReconcileDayResult` gains `activatedProjects: number`.
Step order becomes:

1. recurrences
2. `activateDueScheduledProjects(date <= today ? date : today)` — never activates for a
   future clamp date
3. `promoteDueScheduledTasks`
4. weekly carryover
5. expired Pomodoro

Activation precedes carryover so a Sunday-morning activation joins that Sunday's pile
exactly like a Scheduled promotion. The step is idempotent (a second run finds no due
project) and catches up missed days. `src/app/bootstrap.ts` adds `activatedProjects` to its
existing debug counts. `AppProvider` sequencing and `use-local-day-reconciliation.ts` need
no change because they already call `reconcileDay`.

**Workspace hook.** [`src/app/use-gtd.ts`](../../src/app/use-gtd.ts) (`useGtdWorkspace`)
gains `scheduleProject: withReload((projectId, scheduledFor | null) =>
repository.scheduleProject(projectId, scheduledFor))`, next to `scheduleTask`/`saveProject`.
`withReload` runs `load({ preserveVisibleState: true, reconcile: true })`, so
`reconcileDay`, the project/task reload and `requestCalendarSync()` all run. Only two type
sites change: the `useMemo` return in `use-gtd.ts` and the `Pick<ReturnType<typeof
useGtdWorkspace>, …>` list in `GtdProjectCard` (`ProjectsPage.tsx`). `ScheduledPage` calls
`useGtdWorkspace()` directly. `saveProject` is still used for Pause/Terminer/Retirer.

## Calendar

**In-app.** `ScheduledPage` gains a "Projets" include chip next to the existing task groups,
and a Projects section in the day view and in each week-day group. Source:
`workspace.projects.filter((p) => isProjectScheduledForDate(p, date))`. Each project renders
as a compact **read-only** card (title, date/time pill, number of Planned tasks, an "Ouvrir"
link to `/projects`, and "Démarrer maintenant" via `workspace.scheduleProject`). These cards
are excluded from bulk selection (a project is not a `Task`). The project count folds into
the `scheduled.list.subtitleDay` / `subtitleWeek` parameters and the empty-state check. The
task groups keep selecting only `bucket === "scheduled"`.

**Google Calendar** (one-way sync, off by default and unavailable in browser preview; when
off, nothing changes and scheduled projects still show in-app).

- `src/lib/calendar/eligibility.ts` adds a pure adapter
  `projectToCalendarItem(project): Task`: id `project:<projectId>`; title
  `Projet : <title>` (constant prefix; the summary is part of `payloadSignature`); notes
  `""`; status `completed`/`cancelled` map through and every other project status maps to
  `active`; bucket `scheduled`; `scheduledFor` equals the project's value only when its
  status is `scheduled`, else `null`; `projectId: null`, `isRecurringInstance: false`,
  `recurrenceGroupId: null`. Also `isProjectCalendarItemId(id)` (`startsWith("project:")`).
  Link identity stays `(task_id, occurrence_key)`; `calendar_sync_links.task_id` has no
  foreign key, so no link-table change or migration is needed.
- **Project items are a separate planner input.** `PlanCalendarSyncInput` gains optional
  `projectItems?: Task[]` (default `[]`). Concatenating projects into `tasks` would let one
  project disarm the empty-task-set valve, so a failed task read would delete or detach every
  task link. Therefore:
  - the task valve becomes `tasks.length === 0 && taskLinks.length > 0`, where `taskLinks`
    are links whose `taskId` does **not** start with `project:`;
  - a symmetric project valve `projectItems.length === 0 && projectLinks.length > 0` also
    aborts with `reason: "empty_task_set"` (no change to the `CalendarSyncAbort` union).
    Projects are never deleted, so an empty project read while project links exist is a
    failed read;
  - after the valves, the lookups use `[...tasks, ...projectItems]`;
  - behavior is byte-identical to today when there are no project links;
  - a comment on `PlanCalendarSyncInput` warns that every caller must pass `projectItems`.
- `runReconcile` in `reconciler.ts` calls `listProjects()` after `listTasks` and passes
  `projectItems: projects.map(projectToCalendarItem)`. It never concatenates into `tasks`.
- Behavior with sync on: a scheduled project is a **timed** event at its `scheduledFor`
  (default 09:00, the configured default duration). Reschedule to another day → old event
  deleted, new one created. Natural activation on the date → link detached as
  `unscheduled`, event kept as a record of the day. Early activation, pause, or clearing the
  date while still future-dated → event deleted. Completed/cancelled while still
  future-dated → event deleted. Tasks that are Planned with their own date keep their own
  events.
- **No promotion capture for projects.** The planner's pending-capture path only matters for
  items whose link was never created before their day arrived (sync off or offline), and
  scheduling for today or earlier activates immediately. Documented as a known limitation,
  consistent with the existing "Not back-filled" note.

## UI

French copy lives in `src/locales/fr/gtd.json` (the only locale) and **uses accents**.
`engine.ts` labels and repository error messages stay ASCII, matching the repo convention.

- Locale: status "Programmé"; button "Démarrer maintenant"; control "Programmer";
  confirmation when the project has N active Next Actions/Scheduled tasks:
  "N action(s) seront remises dans la file Planifiée (projet)" (never "file Planned").
  "Planifié" is avoided because it collides with "Planifiée (projet)" (the Planned bucket)
  and "Planifiées" (Scheduled tasks on `ScheduledPage`).
- `engine.ts`: add a `scheduled` entry ("Programme") to `inactiveProjectLabels`, which is
  already typed `Record<Exclude<ProjectStatus, "active">, string>`, so TypeScript demands
  it. `projectAssignmentLabel` appends the date for a scheduled project (ASCII).
  `projectsForAssignment` stays **active-only** (parity with `on_hold`); a scheduled project
  that is the current assignment stays visible and labelled.
- `ProjectsPage.tsx`:
  - `projectStatusKey`, `projectStatusFilterValues`, `projectStatusFilterKey` gain
    `scheduled`; the "open" filter becomes `active || scheduled || on_hold`; sort rank is
    active, scheduled (by `scheduledFor`), on_hold, completed, cancelled; the new-project
    literal gets `scheduledFor: null`.
  - The expanded card gets a "Programmer" date + optional time control (date `min` =
    tomorrow) calling `workspace.scheduleProject`. Choosing a date means scheduled; clearing
    it on a scheduled project means "start now". The status `<select>` does not offer
    `scheduled` without a date.
  - Quick actions on a scheduled project: "Démarrer maintenant"
    (`scheduleProject(id, null)`), Pause, Terminer, Retirer (the last three via
    `saveProject`, clearing the date). The status pill shows the date.
  - In a scheduled project's Planned group, Promote is disabled with a "démarre le …" hint;
    Move up/down stay enabled. The per-card Planned creation control keeps working and is
    the v1 way to pre-load tasks.
- `GtdTaskCard.tsx`: when the draft's project is `scheduled` and the task is not a recurring
  instance, hide the Next Actions and Scheduled bucket options and show a hint.
- `BulkTaskToolbar` / `planBulkBucketMove`: rule 11.
- `src/styles.css`: `.project-card__status-pill--scheduled`.

## LLM bridge

Additive only (the bridge surface is append-only and the
[work-coach spec](work-coach.md) forbids new write tools in v1). In
[`src/lib/llm-bridge/tools.ts`](../../src/lib/llm-bridge/tools.ts):

- `projectStatusValues` gains `"scheduled"`, widening the `list_projects` `status` enum.
  `list_projects` output gains `scheduledFor` (ISO or `null`). The default filter stays
  `active`, so the tool description tells the model to pass `status: "scheduled"`.
- `create_project` gains optional `scheduledDate` (YYYY-MM-DD, validated with
  `isValidLocalDate`) and `scheduledTime` (HH:mm, default 09:00), built with
  `buildIsoFromLocalDateAndTime`. A date after today creates a `scheduled` project; a date
  ≤ today creates an active project and the result carries a warning. The same-title dedupe
  covers `active` and `scheduled`; if it returns an existing project and a date was passed,
  the date is ignored and a warning is added.
- `findActiveProject` becomes a lookup over `active` **or** `scheduled` projects. In
  `buildTaskInput`, a matched `scheduled` project with bucket `next_action`/`scheduled`
  yields bucket `planned` plus a warning (the repository would coerce anyway; the warning
  tells the model why).
- The `project` field description and [`docs/llm-bridge.md`](../../docs/llm-bridge.md)
  change "active" to "active or scheduled". Bridge `list_tasks` is unchanged.

## AI, health, events and statistics

- **Health and AI.** `projects_without_next_action` needs **no code change**: a scheduled
  project is outside both numerator and denominator (it filters `status === "active"`).
  After activation, an empty project is flagged normally. AI snapshots
  (`daily-snapshot.ts`, `weekly-snapshot.ts`) expose only finding counts, samples and the
  title index and never serialize project status, so snapshots and input hashes are
  byte-identical when no project is scheduled. The AI `gtd_action` accept path goes through
  `saveTask`/`applyScheduleChange`, so containment applies.
- **Events.** Scheduling, demotion and activation emit **no** project event (no project
  ledger exists). `buildLifecycleEvents` emits nothing when a task moves to `planned`.
  Activation promotion emits `task_moved_to_next_action` dated `toLocalDateString(updatedAt)`
  through the existing reconcile code. `buildDailyTaskStats` needs no change. A Next Action
  demoted the same day it was counted as added is not subtracted from `tasksAdded`; this is
  the same artifact as moving a Next Action to Waiting For today.
- **Pomodoro.** A running session references only `taskId`, so demotion does not affect it.

## Interaction with the sync specs (notes only)

- [`mobile-and-sync.md`](mobile-and-sync.md) merges the task lifecycle tuple
  `{status, bucket, completedAt, scheduledFor, plannedOrder}` as one unit;
  [`multi-laptop-sync.md`](multi-laptop-sync.md) classifies `gtd_projects` as field-clock.
  For projects, `{status, scheduledFor}` should be one merge unit, and
  `normalizeProjectSchedule` plus the containment sweep are re-run after a merge (mirroring
  the `adjustPlannedFieldsForSave` re-run).
- `activateDueScheduledProjects` is a time-driven generator and must run after the
  pull-before-generators step. It writes nothing when nothing is due, which it does. Because
  activation is deterministic, concurrent activations on two devices converge.
- No other column or tombstone requirement. When this spec is approved, add a one-line
  cross-reference to each sync spec.

## Test plan

Pure (beside each module):

- `project-schedule.test.ts`: every `normalizeProjectSchedule` branch;
  `applyProjectScheduleChange` (future, today, past, null, completed/cancelled throws, from
  `on_hold`, reschedule); `selectDueScheduledProjects`; `isProjectScheduledForDate`; cases
  near local midnight and DST weekends (tests run under `TZ=America/Toronto`; never compare
  UTC string prefixes).
- `planned.test.ts`: the `scheduled` branch of `reconcileProjectPlannedTasks` demotes only
  active non-recurring `next_action`/`scheduled` tasks, leaves inbox/waiting/someday/
  reference/recurring/closed tasks alone, promotes nothing, orders and compacts as in rule
  8, is idempotent, and retains `scheduledFor`; `adjustPlannedFieldsForSave` with a
  scheduled project.
- `bulk-move.test.ts`: tasks of a scheduled project are skipped for `next_action`/
  `scheduled` and counted in `skippedCount`.
- `engine.test.ts`: new label and assignment-label cases.
- `eligibility.test.ts`: `projectToCalendarItem` for every status.
- `planner.test.ts`: scheduled → create; reschedule → delete + create; future activation/
  unschedule → delete; activation today → detach `unscheduled`; completed/cancelled reasons;
  **zero tasks + at least one project item + existing task links → abort `empty_task_set`**;
  zero tasks with only project links and non-empty `projectItems` → no abort; zero
  `projectItems` with existing `project:` links → abort; no project links → behavior
  identical to before.
- `reconciler.test.ts`: passes `projectItems` separately (never concatenated) and tolerates
  a failed projects read.

Migration: `project-scheduled-for.test.ts`; `migrations/index.test.ts` stays green.

Repository contract (`repository.contract.ts`, run for both `MemoryRepository` and
`TauriSqliteRepository`):

- `saveProject` as `scheduled` demotes as specified with order, `scheduledFor` and events,
  and stamps `statusChangedAt`; `scheduled` without a date throws; other statuses clear the
  date; a date ≤ today normalizes to `active`.
- `createTask`/`saveTask` with `next_action`/`scheduled` into a scheduled project coerce to
  `planned` and emit no `task_moved_to_next_action`.
- `activateDueScheduledProjects`: due, overdue catch-up, future untouched; exactly one
  Planned task promoted with a local event date; none if a Next Action exists; idempotent;
  returns the count.
- **No-op test:** with no due project, `activateDueScheduledProjects` and `reconcileDay`
  leave every project and task row identical (including `updated_at`) and the event list
  unchanged. For SQLite, spy on `execute` to show `activateDueScheduledProjects` issues no
  write statements and no `BEGIN`; assert no-`BEGIN` for that method only, because
  `promoteDueScheduledTasks`, recurrence and carryover legitimately open transactions.
  Memory: compare map snapshots.
- `reconcileDay` returns `activatedProjects`, honors the future-date clamp, and runs
  activation before Scheduled promotion.
- `scheduleProject` rules; `promotePlannedTask` on a scheduled project is rejected; reorder
  allowed; transaction rollback/atomicity on failure (models: `transaction.test.ts`,
  `calendar-sync-persistence.test.ts`).
- Round trip of `scheduled_for` including a null column (`rows.test.ts`,
  `tauri-sqlite-repository.test.ts`); recurring generation into a scheduled project is not
  contained and does not break reconcile.

App: `bootstrap.test.ts` and `use-local-day-reconciliation.test.tsx` (activation at
startup, midnight rollover and focus; a failed reconcile does not republish the day);
`use-gtd.test.tsx` (`scheduleProject` → `repository.scheduleProject`, `reconcileDay`,
reload, `requestCalendarSync`).

Bridge (`tools.test.ts`): `create_project` with `scheduledDate` (future, past with warning,
invalid, dedupe against a scheduled project); `list_projects` with `status: "scheduled"` and
the new field; `add_tasks` into a scheduled project coerces and warns.

UI: `ProjectsPage.test.tsx` (schedule, reschedule, "Démarrer maintenant", the count
confirmation text, Promote disabled, filter/sort/pill); `ScheduledPage.test.tsx` (chip and
section in day and week views; task groups still exclude `planned` tasks);
`GtdTaskCard.test.tsx` (bucket options hidden for a scheduled project).

Fixture churn: every `Project` literal needs `scheduledFor: null` — `GtdTaskCard.test`,
`BucketTaskListPage.test`, `gtd-health.test`, the four `ai/context` tests, `engine.test`,
`google-tasks-import(.test)`, `planned.test`, `tools(.test)`, `accept-ai-proposal.test`,
`repository.contract`, `rows.test`, `ProjectsPage(.test)`, `ScheduledPage.test`; plus the
non-test builders `google-tasks-import.ts`, `llm-bridge/tools.ts`, `ProjectsPage.tsx` and
`memory-repository.ts`.

Run `npm run test` and `npm run build` (or `npm run verify`) before shipping. Rust checks
are not needed: `src-tauri` is untouched.

## Documentation checklist (when implemented)

- [`docs/gtd.md`](../../docs/gtd.md): Projects section (five statuses, `scheduled`
  semantics, containment), Scheduled screen, daily reconciliation steps and result tuple,
  lifecycle-event notes.
- [`docs/storage-and-backups.md`](../../docs/storage-and-backups.md): migration row with the
  id allocated at implementation time, `gtd_projects.scheduled_for`, status list.
- [`docs/calendar-sync.md`](../../docs/calendar-sync.md): eligibility, the project adapter,
  the `projectItems` input and both valves, the no-capture limitation.
- [`docs/llm-bridge.md`](../../docs/llm-bridge.md): tools table and `add_tasks` rules.
- [`docs/architecture.md`](../../docs/architecture.md): the `reconcileDay` step
  descriptions.
- Prepend entries to `docs/logs/gtd.md`, `docs/logs/storage-and-backups.md`,
  `docs/logs/calendar-sync.md` and `docs/logs/llm-bridge.md`. Do not edit `docs/log.md`.
- Then move this spec to [`../done/`](../done/).

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Status vs field | New status `scheduled` + project `scheduledFor` | Every `status === "active"` gate becomes correct for free; a date on an active project fails open at each. |
| Date storage | `gtd_projects.scheduled_for TEXT`, ISO instant | Parity with tasks; the calendar needs a time; activation compares the local date only. |
| Date ≤ today when scheduling | Start now: active, date cleared, no demotion | Scheduling for today must not destroy the Next Action set. |
| Activation hook | New step 2 in `reconcileGtdDay` | Reuses bootstrap, day boundary, reloads and AI accepts; idempotent; catches up. |
| Nothing due | No transaction, no writes, no `updatedAt` change | `reconcileDay` runs on every load; sync specs require it. |
| Activation effect | Active, date cleared, existing reconcile promotes at most one | Matches "functions as a normal project". |
| Workspace action | `scheduleProject` via `withReload` | Guarantees `reconcileDay`, reload and calendar sync after UI actions. |
| Existing Next Actions | Moved to Planned, front of queue | The project must not feed Next Actions while inactive (Tier B). |
| Existing dated Scheduled tasks | Moved to Planned, date kept, end of queue | Existing Scheduled → Planned rule keeps their calendar events. |
| Inbox/Waiting/Someday/Reference | Untouched | Not executable work. |
| Recurring instances | Exempt; templates keep generating | Cannot be Planned; generation bypasses `saveTask`; same as `on_hold`. |
| New/edited tasks | Coerced to `planned` before persist | One central rule used by both repositories; no spurious events. |
| Bulk moves | Skip + count, not coerce | Honest "skipped" feedback; repository coercion stays as safety net. |
| Safety net | Sweep in `reconcileProjectPlannedTasks` | Covers entering `scheduled` and bypass paths. |
| Bucket restore | No | Original bucket not stored; conflicts with edits while scheduled. |
| Calendar identity | Synthetic `project:<id>` task in a separate `projectItems` input | No link-table change; one project cannot disarm the empty-task-set valve. |
| Calendar format | Timed event `Projet : <title>` | All-day is an existing non-goal. |
| Pickers | Active-only; current assignment still shown | Parity with `on_hold`. |
| French copy | Locale "Programmé"/"Démarrer maintenant"; ASCII in `engine.ts` and errors | Repo convention; "Planifié" collides with existing labels. |

## Open questions

Each has a proposed default that this draft already follows.

1. **Containment (Tier B).** Default: demote existing Next Actions to the front of the
   Planned queue when a project is scheduled, with a confirmation line showing the count.
   Alternative: leave existing tasks alone, as `on_hold` does, and rely on the status gate
   only. Choosing the alternative **removes the whole containment layer**: the 4th argument
   to `adjustPlannedFieldsForSave`, the `scheduled` branch/sweep in
   `reconcileProjectPlannedTasks`, `GtdTaskCard` option hiding, the bulk-move skip rule,
   bridge coercion and its warning, the confirmation UI, and their tests. What remains is the
   status, the date, activation, the calendar and the Scheduled-screen UI.
2. **Dated Scheduled tasks inside a project being scheduled.** Default: moved to Planned
   with their date kept, so they lose auto-promotion after activation. Alternative: leave
   them Scheduled and hold their promotion until the project is active.
3. **Assignment pickers.** Default: not offered scheduled projects in v1 (tasks go in via
   the Projects-page Planned control, the bridge, or by moving a task). Alternative: offer
   them and force Planned.
4. **Status label.** Default "Programmé". "Prévu" is another candidate; "Planifié" is a poor
   choice (collides with both existing labels).
5. **Recurring templates in a scheduled project.** Default: keep generating, as for
   `on_hold`. Alternative: pause generation until activation.

## Assumptions and risks

- **Persisted status.** `scheduled` is stored in `gtd_projects.status`. An older binary
  opening a migrated database would show an undefined label; downgrade is unsupported, as
  with every migration. No feature flag: the status is inert until a user schedules a
  project. Production and development databases stay separate.
- **Silent coercion.** Paths without UI (bridge, AI proposals, other callers) coerce a
  Next Action/Scheduled request into Planned. The bridge warns; the bulk toolbar skips
  instead (rule 11).
- **Project valve.** Any future `planCalendarSync` caller that forgets `projectItems` will
  abort permanently with `empty_task_set` once project links exist (hence the comment and
  test).
- **One-time normalization bypass.** `moveTasksWithScheduledDatesToBucket("scheduled")`
  (gated by `gtdScheduledNormalizationDoneAt`) selects any active task with a `scheduledFor`,
  including dated Planned tasks, and emits no events. On a database that has not run it yet,
  a dated Planned task in a scheduled project could land in `scheduled`, and
  `promoteDueScheduledTasks` could emit `task_moved_to_next_action` before the sweep demotes
  it. Negligible (the pass has already run on real databases), but a real hole in the
  invariant; either run `reconcileProjectsInternal` over affected projects at the end of
  that pass or accept it.
- **Google import.** `importGoogleTasksExport` inserts projects with `ON CONFLICT DO
  NOTHING` and tasks with `persistTask(..., "ignore")`; it may add tasks to a scheduled
  project, which the sweep demotes on the next project reconcile. The bundled export is no
  longer shipped, so this is tooling and tests only.
- **Transactions.** The main implementation risk is an accidental nested writer. Keep
  demotion and activation inside one `writeTransaction` with `tx`-scoped helpers and test
  rollback.
- **Parity.** Guard Memory/SQLite parity through the shared `repository.contract.ts`.
- **No promotion capture.** A project scheduled and activated while sync was offline gets no
  calendar event. Documented limitation.

When this specification ships, update the canonical GTD, storage, calendar-sync and bridge
documentation, prepend their domain logs, run the required test/build verification, and
then move this file to [`../done/`](../done/).
