# GTD Workspace

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

The shared `GtdTaskCard` can edit title, notes, bucket, project, contexts, scheduled
date/time, and deadline. It can also complete or cancel the task. The collapsed
summary shows the bucket, then the assigned project title when present, then
context names, joined with ` • `. `Sans contexte` appears only when the task has
neither a project nor any contexts. Recurring instances restrict the bucket to
Next Actions or Scheduled and can apply eligible edits to one occurrence or the
full local series. Project assignment selectors on
the task card and recurrence editor suggest active projects only. A currently
assigned project that is on hold, completed, or cancelled stays in that one
dropdown until the assignment changes, labeled with its status (`En pause`,
`Termine`, or `Retire`) so it is not mistaken for an active choice. The Recurrences
project filter still lists every project.

Bulk controls complete, cancel, or move selected tasks. A bulk move to Scheduled is
skipped for tasks without `scheduledFor`.

## Task model

Important distinctions:

- `status` is `active`, `completed`, or `cancelled`.
- `scheduledFor` is an ISO instant and moving a task away from Scheduled clears it.
- `deadline` is a date-only constraint and does not by itself move the task.
- `contextIds` is many-to-many by stored ID array.
- `projectId` is optional.
- `source` distinguishes manual and Google-imported records.
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
task/project arrays remain linked.

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
- sorting by nearest/farthest deadline or last update;
- bulk actions.

### Scheduled

- day or Sunday-to-Saturday week view;
- independent inclusion of planned dates and deadlines;
- deduplication when a task appears in both groups;
- local recurrence previews, requested from the selected date through 30 days later;
- editing/completing/cancelling actual tasks from the calendar.

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

Sunday carryover events use:

```text
weekly_carryover:<weekStartDate>:<taskId>
```

as a unique dedupe key, making repeated calculations for that week idempotent.

## Daily task statistics

Before computing a day, the repository:

1. generates due recurring tasks;
2. applies weekly carryover when the date is Sunday;
3. loads all tasks and events.

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

## Bundled Google Tasks import

`Tasks.json` is imported statically by the application and is gitignored. It is a
snapshot, not a Google API integration.

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
