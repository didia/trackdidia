# Recurring Tasks and Pomodoro

Recurring tasks and Pomodoro both integrate with the GTD task model, but they are
separate engines:

- recurrence templates decide when actionable task instances exist;
- Pomodoro sessions record focused time against GTD tasks or free-form activities.

## Local recurring tasks

### Template model

A `RecurringTaskTemplate` contains:

- title and notes;
- destination: Next Actions or Scheduled;
- context IDs and optional project;
- rule type and rule-specific fields;
- optional scheduled time;
- local start date;
- active, paused, or cancelled status;
- last generated due date;
- pending missed occurrence count;
- lifecycle timestamps.

Only active templates generate tasks or calendar previews.

### Supported rules

#### Daily

Runs every `dailyInterval` days from the start date. The interval is normalized to a
minimum of one.

#### Weekly

Runs on one or more local weekday numbers (`0` Sunday through `6` Saturday), every
`weeklyInterval` weeks relative to the start date.

#### Monthly

Two modes:

- exact day of month;
- nth weekday (first through fifth weekday).

An impossible day or nth-weekday occurrence is skipped for that month. There is no
"last day" or "last weekday" special mode.

### Generated task identity

Each template owns at most one active generated task:

```text
recurring-task:<templateId>
```

The task links back with `recurringTemplateId`, stores the current
`recurrenceDueDate`, and is marked `isRecurringInstance`.

When several due dates have passed before generation:

- the active task advances to the latest due date;
- earlier dates are represented by `pendingPastRecurrences`;
- the UI displays the missed count rather than creating one row per occurrence.

Completing the current recurring task resets the template's pending missed count.
Cancelling it also clears that count. The task card can explicitly clear the task's
displayed past count.

### Generation triggers

Due recurrence generation runs:

- during application bootstrap;
- before GTD workspace loads;
- before daily task statistics/breakdowns;
- when the Pomodoro controller loads eligible tasks.

It does not run as an operating-system background job while TrackDidia is closed.

Generation starts after the latest of:

- template start date;
- the day after `lastGeneratedForDate`;
- the day after the active task's recurrence due date.

Task lifecycle events are emitted when an instance first appears or advances to a
new date, so daily GTD counts include recurrence work.

### Editing scope

For a generated task, the task card offers:

- occurrence: change the current task only;
- series: update title, notes, destination, contexts, project, and scheduled time on
  the template, then synchronize the active task.

Deadline is occurrence-only in practice because the template model has no deadline
field.

Pausing a template stops future generation but leaves the current active task.
Cancelling the template also cancels its active generated task. Resuming restores
future generation.

### Previews

The Scheduled screen asks for active template occurrences in a date range. A
preview:

- is calculated, not persisted;
- is hidden if it matches the current active generated task date;
- may be marked `overdue_preview` when an older due date exists behind an active
  instance;
- cannot be completed or edited as a real task.

## Imported Google recurrence groups

Google Tasks recurrence collapsing predates the local template engine. Imported
tasks may use:

- `recurrenceGroupId`;
- `pendingPastRecurrences`;
- no `recurringTemplateId`.

Do not assume every task displaying missed recurrences has a local template. See
[GTD](gtd.md) for import behavior.

## Pomodoro

### Timing

| Kind | Duration |
|---|---:|
| Focus | 25 minutes |
| Short break | 5 minutes |
| Long break | 25 minutes |

The cycle is:

```text
focus 1 -> short break
focus 2 -> short break
focus 3 -> short break
focus 4 -> long break -> reset to focus 1
```

After more than 25 minutes of inactivity following the last ended session, the
cycle resets to focus 1. A paused session prevents idle reset. A still-running break
is auto-completed when reset logic applies.

### Sessions and segments

A session stores timer/cycle state. Focus sessions additionally contain one or more
segments:

- each segment points to a GTD task, or carries a free-form title;
- switching activity closes the current segment and opens another;
- pausing closes open segments;
- resuming opens a new segment with the latest task/title;
- completing/cancelling closes every open segment.

Eligible GTD tasks are active Next Actions and Scheduled tasks.

### Timer orchestration

`usePomodoroController` is mounted once in `AppProvider`, so the floating timer and
Pomodoro page share state.

- UI countdown state updates once per second.
- Repository state is reloaded after every action.
- Expired running sessions complete at their planned `endsAt`.
- Completing a focus or break through the controller plays a chime and requests a
  native/browser notification.
- Starting/resuming tries to unlock audio from the user interaction first.

The sound is synthesized as WAV/PCM in the frontend; no external audio asset is
required.

### User actions

- Start the next expected focus/break.
- Associate a task or manual activity with a focus.
- Switch task/activity during a running focus.
- Pause and resume.
- Complete the current linked GTD task without ending the focus.
- Complete a focus early after at least half of its 25 minutes has elapsed.
- Skip a current or pending break.
- Cancel any active session.

Completing a GTD task during focus detaches it from the continuing session.

### Daily reporting

`completedFocusSessions` counts sessions for the local date where:

- kind is focus;
- status is completed.

Cancelled focus sessions do not count. The value decorates the daily `pomodoris`
metric as a suggestion.

Time-by-task summaries sum segment wall-clock duration, capped at the supplied
current time for open segments. They group:

- task segments by task ID;
- manual segments case-insensitively by title;
- empty manual labels under "Sans titre".

The session count for a summary is the number of distinct sessions containing that
task/activity.

### Notifications

The notification plugin is registered in the Tauri host and the default capability
grants notification access. Browser environments may use browser notification APIs
where available, but native behavior must be tested in Tauri.

Notifications and sound happen while the frontend is running; there is no
background daemon for a fully closed app.

## Related documentation

- [GTD](gtd.md)
- [Daily routines](daily-routines.md)
- [Storage and backups](storage-and-backups.md)
