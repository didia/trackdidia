# GTD Workspace

See also: [changelog](logs/gtd.md).

TrackDidia implements a local GTD workspace around one task model, separate context
and project records, and an event ledger used for daily statistics.

## Buckets and routes

| Bucket | Route | Meaning |
|---|---|---|
| `inbox` | `/inbox` | Unclarified capture |
| `next_action` | `/next-actions` | Executable work |
| `scheduled` | `/scheduled` | Work assigned a local date/time |
| `waiting_for` | `/waiting-for` | Depends on an external response/action |
| `someday_maybe` | `/someday-maybe` | Deferred possibility |
| `reference` | `/references` | Non-actionable material |
| `planned` | `/projects` (per-project group only) | Project-only ordered queue; not a route/global bucket |

The shared `GtdTaskCard` can edit title, notes, bucket, project, contexts, scheduled
date/time, and deadline. It can also complete or cancel the task. The collapsed
summary reads the persisted task (not unsaved editor draft): bucket, then the
assigned project title when present, then context names, joined with ` • `. A
task with no stored contexts inherits its project's contexts for that label.
`Sans contexte` appears only when the task has no stored contexts and its
project, if any, also has none. Nested task cards on the Projects screen omit
the project title because the enclosing project card already shows it.
Recurring instances restrict the bucket to Next Actions or Scheduled and can
apply eligible edits to one occurrence or the full local series. Project
assignment selectors on
the task card and recurrence editor suggest active projects only. A currently
assigned project that is on hold, completed, or cancelled stays in that one
dropdown until the assignment changes, labeled with its status (`En pause`,
`Termine`, or `Retire`) so it is not mistaken for an active choice. The Recurrences
project filter still lists every project.

Bulk controls complete, cancel, or move selected tasks. A bulk move to Scheduled is
skipped for tasks without `scheduledFor`. Bulk controls never offer Planned as a
destination unless a single valid target project is known; none of today's bulk
surfaces (Inbox, Next Actions, Scheduled, Waiting For, Someday/Maybe, References)
resolve one, so Planned is effectively project-card-only for now.

## Planned bucket (project-only queue)

`planned` is a project-only bucket: a task can only be created, moved, or saved into
it while it has a `projectId`. It supplies a project's next action automatically when
the project has none, without asking the user to maintain two lists.

- Each active project's card on `/projects` shows a **Planned** group, ordered by
  `plannedOrder` ascending. Each row shows the reused `scheduledFor` value as a
  human-readable local date, or a no-date state when absent. If that local date is
  before today, the row uses the existing red overdue date-pill styling with
  accessible overdue text; today, future, and no-date states are never treated as
  overdue.
- While a task is Planned, its existing `scheduledFor` field is reused as an optional
  planned date/time. It does not change the bucket, does not affect Today, does not
  create a recurrence, and does not affect ordering or promotion eligibility. It never
  appears on the Scheduled screen.
- `plannedOrder` is meaningful only for an active, Planned, project-attached task.
  Creating a Planned task appends it after the largest active planned order in its
  project. After any mutation, a project's active planned tasks are renumbered to a
  contiguous `0..n-1`; inactive/completed/cancelled rows never consume a position.
- Moving a Planned task to another project appends it at the destination and compacts
  the source. Moving Planned -> Scheduled retains `scheduledFor` and clears
  `plannedOrder`. Moving Planned to any other bucket, including manual or automatic
  promotion to Next Action, clears both `scheduledFor` and `plannedOrder`. A
  completed or cancelled task that remains Planned keeps both as historical data.
- **Auto-promotion**: whenever a task mutation, completion, cancellation, project
  reassignment, or project status change affects a project, the repository
  reconciles that project: if it is active and has zero active Next Actions, the
  earliest active planned task (by `plannedOrder`, then `createdAt`, then `id`) is
  promoted to Next Action and the remaining queue is compacted. Reconciliation never
  promotes more than one task per project per invocation and is idempotent. An
  inactive project, or one that already has an active Next Action, never
  auto-promotes.
- **Manual promotion**: each Planned row also has an explicit Promote action that
  moves it straight to Next Action, plus Move up/Move down actions that swap it with
  an adjacent active Planned sibling in the same project (disabled at the first/last
  position; cross-project moves are rejected). Manual promotion is allowed even when
  the project already has another active Next Action.
- The project task-creation control on `/projects` offers Planned only while a
  project is selected, with an optional planned date/time, and appends the new task
  to that project's queue.
- Global Next Actions and every group on the Scheduled screen categorically exclude
  `planned`: Scheduled's groups only ever select `bucket === "scheduled"` tasks, so a
  reused `scheduledFor` or a matching `deadline` on a Planned task never surfaces
  there.

## Task model

Important distinctions:

- `status` is `active`, `completed`, or `cancelled`.
- `scheduledFor` is an ISO instant and moving a task away from Scheduled clears it,
  except Scheduled -> Planned and Planned -> Scheduled, which retain it (see
  [Planned bucket](#planned-bucket-project-only-queue)). An active Scheduled task
  whose local `scheduledFor` date is today or earlier is auto-promoted to Next
  Actions; that move also clears the field.
- `plannedOrder` is `number | null`; meaningful only for an active, Planned,
  project-attached task.
- `deadline` is a date-only constraint and does not by itself move the task.
- `contextIds` is many-to-many by stored ID array. A task with an empty
  `contextIds` array inherits its project's contexts for collapsed-card labels
  and Next Actions / Waiting For / Someday context filters. An explicit task
  context always wins and is not overwritten.
- `projectId` is optional.
- `source` distinguishes manual, Google-imported, and email-triage records.
- Email-triage tasks use `sourceExternalId` `email-triage:<accountId>:<conversationKey>` and optional `sourceUrl`.
- imported recurrence fields and local recurrence-template fields coexist but
  represent different mechanisms.

There is no archive/delete operation for tasks in the UI. "Retirer" sets
`cancelled`.

## Contexts

Contexts are flat tags. IDs are normally deterministic:

```text
context:<slugified lowercase name>
```

The task card can create or rename contexts. Names must be non-empty and unique
case-insensitively at the repository level. Renaming preserves the ID, so existing
task/project arrays remain linked. Context chips on the expanded task card still
reflect only the task's stored `contextIds`; inherited project contexts are
display and filter behavior, not a write to the task row.

## Projects

Projects represent multi-action outcomes. They have notes, contexts, source, and one
of four statuses:

- active;
- on hold;
- completed;
- cancelled.

`statusChangedAt` tracks the last status transition. Project filters can show open,
individual status, or all projects. Tasks may reference a project, but the database
does not declare a foreign key or cascade. Assignment dropdowns do not offer on
hold, completed, or cancelled projects as new choices.

## Screen behavior

### Inbox

- quick one-line capture;
- clarification through the full task card;
- first 40 entries, with incremental display;
- bulk actions.

### Next Actions

- direct creation;
- context filtering;
- deadline filters (all, with, without, today, overdue);
- sorting by insertion date (FIFO, oldest first by default), nearest/farthest deadline, or last update;
- collapsed cards show how many local calendar days the task has been in Next Actions (`Aujourd'hui` / `Depuis N jour(s)`), using the latest `task_moved_to_next_action` event and falling back to `createdAt`;
- bulk actions.

### Scheduled

- day or Sunday-to-Saturday week view;
- independent inclusion of planned dates and deadlines;
- deduplication when a task appears in both groups;
- local recurrence previews, requested from the selected date through 30 days later;
- editing/completing/cancelling actual tasks from the calendar;
- **Auto-promotion**: after due recurrences are generated (bootstrap, GTD workspace
  load, `listTasks`, Pomodoro refresh, daily stats, and local-day rollover while the
  app stays open), every **active** task with `bucket === "scheduled"` whose local
  `scheduledFor` calendar date is today or earlier is moved to Next Actions.
  Overdue items and recurring Scheduled instances are included. `scheduledFor` is
  cleared. Planned tasks that reuse `scheduledFor` as a display date are ignored.
  Deadlines never trigger a move. Comparison uses the local calendar date, not the
  clock time and not the UTC prefix of the stored ISO string. The Scheduled page
  groups the same way (`isTaskScheduledForDate`). Daily stats generate recurrences
  for the **stats** date, then promote as of **today**, so viewing a future history
  day cannot promote early. The pass is idempotent. If Next Actions, Scheduled, or
  Pomodoro stay mounted overnight, a local-day boundary (next midnight, window
  focus, becoming visible) repeats generation and promotion and reloads those
  views.

Previews are not task rows and cannot be completed from this screen.

### Waiting For, Someday / Maybe, References

These screens filter the shared model by bucket. Waiting and Someday support direct
creation/context filtering; References is a library view for non-actionable items.

## Lifecycle event ledger

Task writes can emit:

| Event | When |
|---|---|
| `task_created` | A task is first persisted |
| `task_moved_to_next_action` | Created/moved into Next Actions, including a new recurrence date |
| `task_scheduled_for_day` | Created/moved into Scheduled for the event's local date |
| `task_completed` | Status transitions into completed |
| `weekly_carryover` | Active actionable work exists before a Sunday boundary |

Events hold a local business date and an ISO event timestamp. The event ledger is
used instead of reconstructing all history from the current task row.

A `scheduledFor` update while a task remains Planned emits no schedule or completion
event and has no effect on daily task statistics. Leaving Planned clears the field
unless the destination is Scheduled, following the existing bucket-change lifecycle
behavior above rather than an independent schedule event.

Sunday carryover events use:

```text
weekly_carryover:<weekStartDate>:<taskId>
```

as a unique dedupe key, making repeated calculations for that week idempotent.

## Daily task statistics

Before computing a day, the repository:

1. generates due recurring tasks for the stats date;
2. promotes due Scheduled tasks as of today's local date;
3. applies weekly carryover when the date is Sunday;
4. loads all tasks and events.

`tasksAdded` is the unique task count from move-to-next-action,
scheduled-for-day, and weekly-carryover events on the date.

`tasksCompleted` is the unique completed-event count, using the task's current
`completedAt` local date when available.

`tasksAtStart` counts tasks that:

- are actionable for the selected date (Next Action, or Scheduled exactly that
  local date);
- were created before the day's local midnight;
- were not completed before the day;
- were not already counted as added that day;
- were not cancelled before the day.

```text
tasksRemaining = max(0, tasksAtStart + tasksAdded - tasksCompleted)
```

The same event selection powers the Today screen's task breakdown.

## Google Tasks import helpers

`buildGoogleTasksImport` and repository `importGoogleTasksExport` still accept an
in-memory Google Tasks export payload for tests and tooling. The desktop app no
longer ships or statically imports a `Tasks.json` file.

Only items whose Google status is `needsAction` are imported. Completed entries are
counted as skipped.

### List mappings

| Google list title | TrackDidia result |
|---|---|
| `In-Basket` | Inbox |
| `Waiting for` | Waiting For |
| `Scheduled` | Scheduled |
| `Next Calls` | Next Actions + Call context |
| `Reading` | References + Reading context |
| `Next Articles to write` | Next Actions + Writing |
| `Next Tech Articles to Read` | References + Reading + Tech |
| `Next General Articles to Read` | References + Reading + General |
| `LinkedIn Monday (Professional)` | Next Actions + Writing + Professional |
| `LinkedIn Weekend (Personal)` | Next Actions + Writing + Personal |
| `Next Actions - X` | Next Actions + X context |
| `Someday/Maybe - X` | Someday / Maybe + X context |
| `Projects - X` | Each active list item becomes a project in context X |
| Anything else | Ignored |

A trailing count such as ` (12)` is removed from list titles before matching.

Tasks with any scheduled timestamp are imported into Scheduled regardless of the
base list mapping. Google IDs produce deterministic local IDs and unique
`sourceExternalId` values, so rerunning import is insert-idempotent.

Google recurring instances sharing `task_recurrence_id` collapse to the newest
scheduled/updated/created item. The active row records the group and a count of
older pending instances.

## Startup normalizations

Settings timestamps guard three one-time compatibility passes:

- move tasks with the Reading context to References;
- move all tasks with scheduled dates to Scheduled;
- collapse Google recurrence groups using the current bundled export.

The bootstrap also reimports when the import timestamp is absent, or when both task
and project counts are zero. The Settings screen can manually rerun import.

## Relationship activity tasks

Daily relationship draws create up to two manual Next Actions in the Personal
context: one children activity and one spouse activity.

Generation is idempotent per category/date through settings markers and deterministic
source external IDs. If an active task from that category already exists, no new one
is created and the category is marked processed for the day. See
[AI, settings, and privacy](ai-settings-and-privacy.md) for configuration.

## Related documentation

- [Daily routines](daily-routines.md)
- [Recurrences and Pomodoro](recurrences-and-pomodoro.md)
- [Storage and backups](storage-and-backups.md)
