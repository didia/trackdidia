# Spec — Project Planned Tasks

**Status:** approved, unstarted.
**Plan review:** independently approved through the required `plan-review` process after
3 iterations.
**Scope:** add an ordered, project-only planned-task bucket that supplies the next action
when a project has none. This is a roadmap specification, not shipped behavior; the
live GTD contract remains [`docs/gtd.md`](../../docs/gtd.md).

## Outcome

An active project can hold a deliberately ordered queue of planned tasks. Planned tasks
are not next actions and do not appear in the global Next Actions list. When an active
project has no active next action, exactly one planned task—the first in its order—is
promoted to `next_action`. This preserves a single, actionable next step without asking
the user to manually maintain two lists.

## Product rules

- `planned` is a **project-only** task bucket. A task in this bucket must have a valid
  `projectId`; a projectless task cannot be created, moved, or saved as planned.
- Add `planned` to the `Task["bucket"]` union and all bucket-aware UI, repository,
  serialization, import, filtering, and test fixtures. Existing buckets keep their
  current meanings.
- A planned task has `plannedFor: string | null`, a local `YYYY-MM-DD` date used only for
  display. It does not schedule the task, alter the task's bucket, create a recurrence,
  affect Today, or change promotion eligibility.
- A planned task has `plannedOrder: number | null`. It is meaningful only while the task
  is active, in `planned`, and attached to a project. Order is ascending and stable.
- When an active task leaves `planned`, clear both `plannedFor` and `plannedOrder`.
  Completed or cancelled tasks that remain in `planned` retain those fields as historical
  planning metadata.
- Completion, cancellation, deletion/archival, project reassignment, bucket changes, and
  edits that alter eligibility must reconcile the affected project(s). Reconciliation is
  idempotent and never promotes more than one item per project invocation.
- Only an **active** project qualifies. Inactive projects never auto-promote. A project
  with one or more active next actions never auto-promotes.
- Promotion chooses the active planned task with the lowest `plannedOrder`; ties use a
  deterministic secondary key (`createdAt`, then `id`). A missing legacy order is
  normalized before eligibility is evaluated.

## Data model and migration

Append SQLite migration **26**; do not rewrite migrations 1–25.

```sql
ALTER TABLE gtd_tasks ADD COLUMN planned_for TEXT;
ALTER TABLE gtd_tasks ADD COLUMN planned_order INTEGER;
CREATE INDEX IF NOT EXISTS idx_tasks_project_planned_order
  ON gtd_tasks (project_id, planned_order)
  WHERE bucket = 'planned' AND status = 'active';
```

Migration 26 must also normalize pre-existing rows defensively:

- Set `planned_order = NULL` for every row not in `planned`.
- Preserve no legacy planned rows (the bucket is new), but make normalization safe for
  interrupted/dev databases and future imports.
- Validate or normalize `planned_for` at the repository boundary as a local `YYYY-MM-DD`
  string or `null`; it is never converted through UTC.

Update SQLite row mappings and the browser-preview `MemoryRepository` in lockstep.
Both must expose the same fields and enforce the same invariants. The browser repository
remains non-persistent.

## Repository API and invariants

Keep domain rules out of pages. Add focused repository operations rather than allowing
callers to assemble multi-write promotion sequences:

- `createPlannedTask(input)` (or a validated `createTask` extension) requires a project,
  assigns the next contiguous order, and reconciles only after the insert is durable.
- `saveTask`, `moveTask`, `completeTask`, `cancelTask`, project status changes, and project
  reassignment validate planned-task fields and reconcile every affected project after their
  primary mutation. Bulk controls use these same single-task mutation operations; they do
  not require a new cross-task repository batch API or all-or-nothing user-action
  transaction.
- `promotePlannedTask(taskId)` is the explicit manual promotion operation. It rejects a
  non-active/non-planned task or inactive project, changes the selected task to
  `next_action`, clears both planning fields, and does not silently promote another item
  in that same call.
- `movePlannedTask(taskId, direction)` swaps with its adjacent active planned sibling in
  the same project and returns the persisted rows. It rejects cross-project moves; a
  boundary request is a harmless no-op. Reordering does not itself cause a second
  promotion when the project already has an active next action.
- `reconcileProjectNextAction(projectId)` is private or narrowly scoped. It checks the
  project status, counts active next actions, selects one ordered active planned task only
  when that count is zero, promotes it, clears both planning fields, and compacts the
  remaining planned orders.
- `reconcileProjects(projectIds)` deduplicates IDs and is the only fan-out helper. It
  makes project reassignment safe by reconciling both the old and new project.

Each individual SQLite task mutation and reconciliation of its affected project(s) runs in
the existing serialized writer and one `BEGIN IMMEDIATE` transaction. Transaction-scoped
internal helpers receive the open database connection; they must not call public methods
that re-enter the writer or open a nested transaction. Existing application-level bulk
controls may continue to fan out with `Promise.all`: the SQLite writer serializes those
per-task transactions, so a bulk action can have partial success rather than one
cross-task rollback. `MemoryRepository` mirrors the same per-item semantics. Use the same
single-task atomic boundary for proposal acceptance, especially
`acceptAiGtdActionProposal`: mutate the accepted task, reconcile the relevant project(s),
then mark the proposal accepted in one transaction.

For an individual mutation, any validation or write failure rolls back its primary mutation,
order changes, promotion, and proposal decision together. A bulk operation reports or
retains the result of each item: failed items roll back independently while earlier or later
items may succeed. Accepted AI proposals remain idempotent: a repeat call returns the prior
accepted result and does not promote another task.

## Ordering semantics

- Creation appends after the largest active planned order in its project.
- Moving a planned task to another project appends it in the destination and compacts the
  source. Moving an active task out of planned clears both planning fields.
- Editing a planned task without changing its project retains its position.
- After any mutation, active planned tasks in each affected project are normalized to
  contiguous `0..n-1` order. Inactive/completed/cancelled rows do not consume positions.
- Auto-promotion consumes the first item, clears both planning fields, then compacts the
  remaining queue. The reconciliation pass promotes at most one task even if no next
  action remains after other malformed data is normalized.

## UI

Add a **Planned** group inside each project on the GTD Projects surface; do not add it to
the global Next Actions route or generic projectless bucket selectors.

- The group lists active planned tasks in `plannedOrder`, displaying `plannedFor` as a
  human-readable local date when present and no date state when absent.
- The project task creation control offers Planned only for a selected project. Creating a
  planned task accepts an optional display-only `plannedFor` date and appends it to the
  queue.
- The task editor shows `plannedFor` and ordering controls only when the task is planned
  and has a project. It validates/clears fields consistently when changing bucket or
  project.
- Each planned row has explicit **Promote**, **Move up**, and **Move down** actions.
  Promote invokes the repository operation; arrow controls are disabled at the first and
  last positions. Keyboard and accessible labels describe the task and resulting action.
- Manual promotion refreshes the project groups and global next-action data. It is allowed
  even if another next action already exists; automatic reconciliation is the rule that
  requires zero active next actions.
- Existing bulk controls must not offer Planned unless a single valid target project is
  known. Prefer a clear disabled/omitted option over creating invalid projectless tasks.
- Translations cover labels, empty state, date caption, ordering actions, validation, and
  promotion feedback in the supported locales.

## Events, dates, and derived metrics

Task lifecycle events stay event-derived as described in [`docs/gtd.md`](../../docs/gtd.md).
Use local `YYYY-MM-DD` values from the established date helpers for user actions,
auto-promotion, and AI-proposal acceptance; never derive event dates with UTC conversion.
Creating, moving, promoting, completing, or cancelling tasks must continue to emit the
same lifecycle events required by `buildDailyTaskStats`. `plannedFor` itself emits no
schedule or completion event and has no impact on daily counts.

## Test plan

Add focused tests beside the affected repositories, domain helpers, and UI:

- Migration 26 maps both new columns, preserves old task data, and safely normalizes
  invalid/non-planned order state.
- Memory and SQLite repository parity: project-only validation, append/compact/swap order,
  project reassignment, harmless reorder boundary no-ops, completed/cancelled exclusions,
  inactive-project behavior, and deterministic tie breaking.
- Reconciliation promotes exactly one earliest task only when an active project has zero
  active next actions; it remains idempotent across repeated calls.
- Each single-task mutation path (including each item invoked by bulk controls and project
  status changes) reconciles the right old/new projects atomically and rolls back on
  failure; bulk tests cover independent per-item rollback and partial success.
- `acceptAiGtdActionProposal` remains idempotent and transactionally updates task,
  reconciliation, and proposal state.
- Event dates at local midnight and around timezone boundaries remain local calendar dates;
  `plannedFor` changes do not affect daily task statistics.
- UI coverage verifies group visibility, project-only creation, display-only dates,
  editor validation, manual promotion, disabled order controls, translated labels, and
  global Next Actions exclusion.

Run `npm run test` and `npm run build` before shipping. Because this feature changes GTD
behavior and storage, update [`docs/gtd.md`](../../docs/gtd.md),
[`docs/storage-and-backups.md`](../../docs/storage-and-backups.md), and their matching
domain logs after implementation and before moving this spec to `done/`.

## Assumptions and risks

- A project may intentionally contain multiple active next actions; auto-promotion must
  not reduce or reorder them.
- Planned order is per project, not global, and planned dates never become scheduling.
- Imports and future integrations must route planned writes through repository validation;
  direct SQL would violate the invariant.
- The greatest implementation risk is re-entrant repository transactions. Keep all
  promotion/reconciliation helpers transaction-scoped and test rollback paths explicitly.
- A malformed legacy/dev database must fail safely or normalize deterministically rather
  than silently promoting multiple tasks.

When this specification ships, update the canonical GTD and storage documentation,
prepend their domain logs, run the required test/build verification, and then move this
file to [`../done/`](../done/).
