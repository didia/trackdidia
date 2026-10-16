# Spec: duplicate a task or an entire project

**Status:** draft, awaiting review (not approved, nothing implemented).
**Scope:** let the user duplicate

1. a **single task**, and
2. an **entire project** (a new project plus a copy of its tasks).

Every copy is a fresh entity with its own id and no history. Tasks copied into a project are created
in the **Planned** bucket. There is no migration, no new setting, no Rust change and no LLM bridge
tool.

## Context

What exists today, verified against the code:

| Piece | Where | What it gives this spec |
|---|---|---|
| Planned bucket (project-only queue) | [`src/lib/gtd/planned.ts`](../../src/lib/gtd/planned.ts), [`docs/gtd.md`](../../docs/gtd.md) "Planned bucket" | A task can only be Planned if it has a project. Order is `plannedOrder`, then `createdAt`, then `id` (`compareByPlannedOrder`, currently module-private: export it). |
| Planned reconciliation | `reconcileProjectPlannedTasks` in `planned.ts`, called by both repositories after every task write | When a project is `active` and has **zero** active Next Actions, the head of its Planned queue is promoted to `next_action` and the queue is compacted to `0..n-1`. So the first copied task of a duplicated project is promoted immediately. |
| Lifecycle events | `buildLifecycleEvents(null, task)` in [`src/lib/gtd/engine.ts`](../../src/lib/gtd/engine.ts) | A new Planned task emits only `task_created`. `isDailyAddedEvent` counts only `task_moved_to_next_action`, Next Action carryover and in-place Scheduled completion, so Planned copies do not inflate today's `tasksAdded`; only the auto-promoted head does. Event dates come from `toLocalDateString(createdAt)`, so copies need a fresh `createdAt`. |
| Unique columns | `gtd_tasks.source_external_id` and `gtd_projects.source_external_id`, both `TEXT UNIQUE` (migrations 5 and 6) | A copied value would violate the constraint. The LLM bridge also stores `llm:<clientId>` there, and sync identity keys on it. It must be `null` on copies. |
| Task and Project shapes | [`src/domain/types/gtd.ts`](../../src/domain/types/gtd.ts) | `Task` has 22 fields and `Project` has 10; the copy matrix below covers all of them. `Task` has no Pomodoro estimate or time-spent field: sessions and segments reference `task_id` in their own tables. |
| `parentTaskId` | set only by Google import (`google-task:<id>`); the recurring engine sets it to `null` | Not reachable from the UI, but the planner still remaps it. |
| Contexts | no delete on `AppRepository`; missing ids are recreated lazily by `ensureContextsByIds` (Memory) and `ensureContextsExist` (SQLite, called from `persistTask`, **not** from `createTaskInternal`) | `contextIds` are copied verbatim. |
| Recurrence engine | generators key on `(recurringTemplateId, recurrenceDueDate)` | A copy with null/false recurrence fields is invisible to the generators, so it cannot create a second generator or collide with an idempotency key. |
| Repository parity | `AppRepository` in [`src/lib/storage/repository.ts`](../../src/lib/storage/repository.ts), `TauriSqliteRepository`, `MemoryRepository` | Every new method exists in both. SQLite helpers: `writeTransaction`, `transactionDb(tx)`, `persistTask`, `persistEvents`, `reconcileProjectsInternal`, `createTaskInternal`, `assertPlannedProjectExists`. `saveProject` inlines its `INSERT`, so extract a private `persistProject`. Memory holds synchronous maps `tasks`, `projects`, `events`, `contexts`. |
| Test fixtures | `describeRepositoryContract` in [`src/lib/storage/repository.contract.ts`](../../src/lib/storage/repository.contract.ts), run for both repositories; rollback fixtures in [`src/lib/storage/accept-ai-proposal.test.ts`](../../src/lib/storage/accept-ai-proposal.test.ts) (spy on `Map.set` for Memory, on `db.execute` for SQLite) | The `acceptAiProposal` `gtdTask` branch snapshots `tasks`, `contexts`, `events`, `recurringTemplates` but **not** `projects`; copying it as-is would leave an orphan project after a rollback. |
| UI facts | French only ([`src/locales/fr/gtd.json`](../../src/locales/fr/gtd.json)); no toast, no `window.confirm`, no `scrollIntoView` anywhere in `src`; React `^18.3.1` | Feedback is an inline `role="status"` message. Task and project actions are inline buttons. |
| UI data flow | `useGtdWorkspace` ([`src/app/use-gtd.ts`](../../src/app/use-gtd.ts)) wraps every mutation in `withReload`; `GtdTaskCard` has `useEffect([task])` that collapses the card and clears errors on every reload; `GtdProjectCard` (in [`src/pages/ProjectsPage.tsx`](../../src/pages/ProjectsPage.tsx)) has `useEffect(() => setExpanded(false), [project.id])`, which also runs on mount | Both effects defeat naive "set state after the action" approaches; see Decisions 11 and 12. |

Housekeeping noticed while reading: the index entry for `todo/calendar-sync.md` in
[`specs/README.md`](../README.md) is stale (the file lives in `specs/done/`). It is outside this
spec's scope.

## Decisions

Decisions marked **(user)** were answered by the user on 2026-10-16. The rest are recommended
defaults awaiting review.

| # | Decision | Choice |
|---|---|---|
| 1 | Which source tasks a project copy contains | **(user)** Active **and completed** tasks, each recreated as a fresh Planned task. **Cancelled** tasks are skipped. `options.includeCompleted` defaults to `true`; the confirm panel has a checked "Inclure les tâches terminées" box and a line "N tâches (dont M terminées)". |
| 2 | Order of the new Planned queue | **(user: oldest-completed-first)** Completed tasks first, by `completedAt` ascending then `id`; then active tasks by bucket order `next_action`, `planned` (by `compareByPlannedOrder`), `scheduled` (by `scheduledFor` ascending), `waiting_for`, `inbox`, `someday_maybe`, `reference`; ties by `createdAt` then `id`. Consequence, stated plainly: the auto-promoted Next Action (Decision 5) is a copy of the **oldest completed** task. With the box unchecked, it is a copy of the source's first active Next Action, else its first Planned task, and so on down the bucket order. The user accepted the immediate promotion. |
| 3 | Standalone task duplicate | **(user)** Active Inbox task, no project, same title, notes, contexts and `sourceUrl`. |
| 4 | Task duplicate inside a project | Project `active` or `on_hold`: the copy is `planned` in the same project, appended with `nextPlannedOrder` (on hold it is not promoted until the project resumes). Project `completed` or `cancelled`: the copy falls back to the Inbox with `projectId = null`, because a Planned copy there would never be promoted and the default "open" project filter hides those projects. **Open question 1 asks the user to confirm this split.** |
| 5 | Auto-promotion | **(user)** Accepted. The existing "project with no Next Action gets one" rule runs once at the end; the head of the queue becomes a Next Action and emits `task_moved_to_next_action` (+1 to today's `tasksAdded`). No change to reconciliation. |
| 6 | Dates | **(user)** `scheduledFor` and `deadline` are cleared on every copy. A stale date would read as overdue, be calendar-eligible, drive Scheduled promotion and pollute `overdue_deadlines` health findings. |
| 7 | Recurrence | **(user)** Recurring templates attached to a project are **not** copied. A copied recurring instance becomes a plain one-off task. The project-duplication notice says so. |
| 8 | Project status | The copy is always `active`, even when the source is `on_hold`, `completed` or `cancelled`: a copy of a finished project is meant to be worked. The source project and its tasks are never modified. |
| 9 | Project naming | The UI computes the default `Copie de X` (i18n prefix). `nextCopyTitle(title, existingTitles, prefix)` strips a leading prefix and any `(n)` suffix, then picks the first unused of `Copie de X`, `Copie de X (2)`, `Copie de X (3)`… (case-insensitive). The user edits it in the confirm panel. The repository trims it, rejects an empty title, and defaults to the same helper with the French prefix when omitted. Titles are not unique in the database, so this is cosmetic. Copied tasks keep their titles unchanged. |
| 10 | Atomicity and shape | `duplicateProject` is **one** repository method: one snapshot read, one transaction, one reconcile at the end. It must not loop over `createTask` (that calls `getAllTasks()` and reconciles per task, O(n²), and exposes intermediate states). `duplicateTask` reuses `createTaskInternal` so Planned invariants stay in one place. No dedupe key: duplicating twice makes two copies; the UI guards double-submit. |
| 11 | Expanding the new project card | `ProjectsPage` holds `autoExpandProjectId`. After `duplicateProject` resolves it sets the id to `result.project.id` and resets the filters to defaults (status "open", empty search, context "all") so the new card cannot be hidden. `GtdProjectCard` gets an `autoExpand` prop (`project.id === autoExpandProjectId`). The existing reset effect becomes ref-guarded and runs `setExpanded(false)` only when `project.id` actually changes from its previous value (so it no longer fires on mount). A second effect declared after it, `if (autoExpand) setExpanded(true)` keyed on `[autoExpand]`, expands the card whether it mounts with `autoExpand` already true or the flag flips after mount. The page never clears the id, so the user can collapse the card later. Any `scrollIntoView` is optional and guarded (`element.scrollIntoView?.()`), since jsdom lacks it. |
| 12 | Task-copy notice | Invariant: the notice state is never reset by `GtdTaskCard`'s `[task]` effect and is rendered **outside every card and outside the collapsible editor**. "Set it after `await`" is not enough: React 18 batches updates made after an `await`, so the continuation can run before the re-render that fires the effect. Owner: `GtdTaskList` (mounted by `NextActionsPage`, `ScheduledPage`, `ProjectsPage`, `BucketTaskListPage`), which holds the message and renders a `role="status"` element before the task list. `GtdTaskListWorkspace` gains `duplicateTask?: (taskId: string) => Promise<Task>`; the handler builds the message from the returned task. Messages (separate i18n keys): Planned → "Copie créée dans les tâches planifiées du projet « P »"; Inbox → "Copie créée dans l'Inbox"; Inbox because the project is finished → a message saying the project link was dropped. The handler rethrows on failure and the card shows the error in its existing `saveError` slot (a failure causes no reload, so the editor stays open). The notice has a dismiss button, is replaced by the next duplicate, has no timer, and disappears when the list unmounts. The source card may be unchanged and the copy usually lands elsewhere, hence the destination is named. |
| 13 | Large projects | See "Performance" below. No hard cap in v1. |
| 14 | LLM bridge | **Not exposed in v1.** The bridge tool surface is append-only (`list_*`, `add_tasks`, `create_project`). One call could create hundreds of rows and the model cannot preview the result; `add_tasks` and `create_project` already cover model-driven creation. |
| 15 | Accessibility | Buttons carry an `aria-label` with the title (like `task.promoteAria`). The project confirm panel is an inline form with an autofocused title input, Enter submits, Escape cancels when not busy. |

## Contract: pure planner

New file `src/lib/gtd/duplicate.ts` (pure, no storage access; takes `now` and an id factory so tests
are deterministic):

```ts
planProjectDuplication(
  source: Project,
  sourceTasks: Task[],
  options: { title: string; includeCompleted: boolean; now: string; newId: (kind: "task" | "project") => string },
): { project: Project; tasks: Task[] };

// `project` is null only for a standalone task. A task whose projectId points at a
// missing project never reaches the planner: the repository throws first.
planTaskDuplication(source: Task, project: Project | null, options: { now: string }): CreateTaskInput;

nextCopyTitle(title: string, existingTitles: string[], prefix: string): string;
```

Both repositories use the same planner. `compareByPlannedOrder` is exported from `planned.ts`.

### Per-field copy matrix: `Task` (all 22 fields)

| Field | Rule |
|---|---|
| `id` | Regenerated (`createEntityId("task")`). |
| `title`, `notes`, `sourceUrl` | Copied unchanged (`sourceUrl` is a reference link, not an identity). |
| `status` | Always `active`, including copies of completed tasks. |
| `bucket` | `planned` for every task of a duplicated project, whatever its source bucket. Single task: Decisions 3 and 4. |
| `contextIds` | Copied verbatim (new array). |
| `projectId` | Project duplicate: the new project's id. Single task: Decisions 3 and 4. |
| `parentTaskId` | Remapped to the parent's copy when the parent is also copied, else `null`. Single task: `null`. |
| `scheduledFor`, `deadline` | `null` (Decision 6). |
| `recurringTemplateId`, `recurrenceDueDate`, `isRecurringInstance`, `recurrenceGroupId`, `pendingPastRecurrences` | `null`, `null`, `false`, `null`, `0`. |
| `completedAt` | `null`. |
| `plannedOrder` | Project duplicate: assigned in plan order (see "Performance" for the exact numbering). Single task: assigned by `adjustPlannedFieldsForSave` (`nextPlannedOrder`). |
| `source` | `manual`. |
| `sourceExternalId` | `null` (UNIQUE column, bridge keys, sync identity). |
| `createdAt`, `updatedAt` | One shared `now`. |

Not copied at all: task events (the new ones come from `buildLifecycleEvents`), Pomodoro sessions and
segments, `calendar_sync_links`, AI proposals and memories.

### Per-field copy matrix: `Project` (all 10 fields)

| Field | Rule |
|---|---|
| `id` | Regenerated (`createEntityId("project")`). |
| `title` | Decision 9. |
| `status` | `active` (Decision 8). |
| `statusChangedAt`, `createdAt`, `updatedAt` | `now`. |
| `notes`, `contextIds` | Copied. |
| `source` | `manual`. |
| `sourceExternalId` | `null`. |

## Contract: repository

Added to `AppRepository` (types `DuplicateProjectOptions` and `DuplicateProjectResult` live in
`src/domain/types/gtd.ts`) and implemented in **both** repositories:

```ts
duplicateProject(projectId: string, options?: { title?: string; includeCompleted?: boolean }):
  Promise<{ project: Project; taskCount: number; skippedRecurringTemplates?: number }>;
duplicateTask(taskId: string): Promise<Task>;
```

- **Unknown ids.** `duplicateProject` throws the French "introuvable" error when the project does not
  exist. `duplicateTask` throws it when the task does not exist **or** when `source.projectId` is set
  but the project lookup returns nothing. Both throw before any write.
- **SQLite `duplicateProject`.** One `writeTransaction`: read the project and `getAllTasks`, call the
  planner, `persistProject` (extracted helper), `persistTask` for each task, `persistEvents(
  buildLifecycleEvents(null, task))` for each task, then one `reconcileProjectsInternal(tx,
  [project.id])`. Context ids are upserted **once** over the union of all copied tasks' contexts
  instead of once per task (add an internal flag or helper to `persistTask`).
- **SQLite `duplicateTask`.** `writeTransaction(tx => createTaskInternal(tx, input))`.
- **Memory `duplicateProject`.** Validate first, then snapshot `projects`, `tasks`, `events` **and**
  `contexts` as new Maps, call `ensureContextsByIds` once for the union, apply the project, the tasks
  and the events, run `reconcileProjects` once, and on any error restore the snapshot
  (`Object.assign(this, snapshot)`) and rethrow.
- **No `reconcileDay` call**; reads and these writes follow the existing GTD engine rules.

### Performance

On desktop each SQL statement is an IPC call to the SQLite plugin, inside one write-queue slot.

- Giving the copies `plannedOrder` `0..n-1` would make the final reconcile promote the head and then
  renumber the other `n-1` copies to `0..n-2`, persisting each of them a second time (with a context
  upsert). For 600 tasks that doubles the work to roughly 2,000 calls.
- **Requirement:** the planner must number the queue so that, after the head is promoted, the rest is
  already contiguous and the reconcile rewrites only the head. Recommended mechanism: give the head
  `plannedOrder: -1` (the column is a plain `INTEGER` with no `CHECK`) and the others `0..n-2`; the
  alternative is to write the head directly as `next_action` with the same two events
  (`task_created`, `task_moved_to_next_action`) so the final reconcile finds nothing to do.
- **Contract assertion:** after `duplicateProject`, no copied task other than the head has
  `updatedAt !== createdAt`; the SQLite fixture additionally counts `execute` calls.
- The UI stays responsive (calls are async) but must not allow concurrent mutations: while running,
  the project panel shows a busy state (`aria-busy`, "Duplication en cours…", Dupliquer / Confirmer /
  Annuler disabled, no Escape-cancel because the transaction cannot be aborted).
- Multi-row batched `INSERT`s are a known escape hatch, not required in v1.

## UI

- **Project card** (`src/pages/ProjectsPage.tsx`): a "Dupliquer" button opens an inline confirm form
  with an editable title (default `Copie de X`), the "Inclure les tâches terminées" checkbox and the
  count line. On success: filters reset, new card expanded (Decision 11), and a page-level
  `role="status"` message: « Projet « {title} » créé avec {count} tâches planifiées. Les
  récurrences ne sont pas copiées. » A project with zero tasks is allowed (the message says 0).
- **Task card** (`src/components/GtdTaskCard.tsx`): a "Dupliquer" button in the expanded editor's
  action row (`onDuplicate?` prop), wired through `GtdTaskListWorkspace.duplicateTask` and
  `useGtdWorkspace` (`withReload`). Feedback is the list-level notice of Decision 12.
- New i18n keys under `projects.duplicate.*` and `task.duplicate.*` in `src/locales/fr/gtd.json`,
  including the copy prefix "Copie de".

## Why not on the LLM bridge

See Decision 14. No change to `src/lib/llm-bridge/tools.ts`. [`docs/llm-bridge.md`](../../docs/llm-bridge.md)
may carry a one-line "duplication is not exposed" note.

## Interaction with calendar sync and multi-laptop sync

- Calendar sync: `scheduledFor` is cleared, so copies are never calendar-eligible; a later change
  that copied dates would adopt copies as new links through the normal create path.
- Multi-laptop and mobile sync ([`multi-laptop-sync.md`](multi-laptop-sync.md),
  [`mobile-and-sync.md`](mobile-and-sync.md)): copies get fresh `createEntityId` ids and go through the
  same creation path as `createTask`, so they are ordinary creates for the merge engine.
  Nulling `sourceExternalId` avoids canonical-identity collisions. Nothing else is needed.

## Phases

1. **Planner and repositories.** `duplicate.ts`, `duplicateProject` and `duplicateTask` in both
   repositories, contract tests, rollback tests.
2. **Project card UI.** Button, confirm panel, `autoExpandProjectId`, notice, i18n, UI tests.
3. **Task card UI.** `onDuplicate`, `GtdTaskList`-owned notice, i18n, UI tests.
4. **Documentation.** See below.

## Verification

- **Pure unit tests** (`src/lib/gtd/duplicate.test.ts`): the full field matrix for tasks and
  projects; the completed-first ordering including ties and `plannedOrder` gaps; `includeCompleted`
  on and off; cancelled skipped; `parentTaskId` remap and `null`; recurring-instance reset;
  `sourceExternalId` and `sourceUrl`; `planTaskDuplication` for standalone, active, on-hold and
  completed/cancelled project; `nextCopyTitle` (prefix stripping, counter, case-insensitive
  collisions); fixed `now` and id factory.
- **Repository contract tests** (`repository.contract.ts`, both implementations):
  - new project has a new id, `sourceExternalId` null, is `active`, notes and contexts equal;
  - task counts match the rules; all copies are Planned except the head, whose events are
    `task_created` plus `task_moved_to_next_action` dated today, the others `task_created` only;
    `tasksAdded` rises by exactly 1 and `tasksCompleted` is unchanged;
  - exactly one `next_action` in the copy and the rest of the queue is contiguous;
  - the performance assertion of "Performance" above;
  - the source project and tasks are deep-equal before and after, including when the source has a
    `sourceExternalId` (UNIQUE not violated); two duplications make two independent projects;
  - no Pomodoro sessions, source events or `calendar_sync_links` are copied;
  - a recurring-instance source becomes a one-off and `generateDueRecurringTasks` creates nothing
    extra;
  - zero-task project; archived, completed and cancelled source gives an `active` copy;
  - single task: standalone → Inbox; active/on-hold project → Planned at max+1;
    completed/cancelled project → Inbox with `projectId = null`; dangling `projectId` and unknown
    ids reject with no writes;
  - a 600-task project: contiguous order and acceptable time (SQLite `:memory:`).
- **Rollback tests** (both fixtures, in the style of `accept-ai-proposal.test.ts`): Memory spies on
  `tasks.set` so the Nth call throws (the project is set before the tasks, so a missing `projects`
  snapshot would leave an orphan); SQLite spies on `db.execute` and fails the Nth
  `INSERT INTO gtd_tasks`. Assert `listProjects()`, `listTasks({ includeCompleted: true })`,
  `listTaskEvents()` and `listContexts()` are all unchanged, then retry successfully.
- **UI tests** (`renderWithApp` from `src/test/test-utils.tsx`, `MemoryRepository`):
  - Project card: panel shows « Copie de X »; after submit the new card has `aria-expanded="true"`
    with its editor visible and the copied title (pins Decision 11); with a non-default status
    filter and search seeded, the new card is still visible; the status message shows the count;
    a double-click calls the repository once; the busy state disables the controls; Escape cancels;
    keyboard-only flow works.
  - Task notice: expand a task card, click "Dupliquer", wait for the reload, assert the
    `role="status"` element shows the destination text, that it is **not** a descendant of any
    `article.task-card`, and that the source card is collapsed (pins the invariant of Decision 12,
    not call ordering); a second duplicate replaces the notice; the finished-project Inbox message
    differs from the generic Inbox one.
- **Manual desktop check** on a seeded dev database with a ~600-task project (never a production
  database).
- Run `npm run test`, `npm run build` and preferably `npm run verify`. No Rust change, so no cargo
  checks.

## Documentation (required by `AGENTS.md`)

- [`docs/gtd.md`](../../docs/gtd.md): a "Duplication" section (copy matrix, ordering, events and
  Planned interplay, single-task rules, not exposed on the bridge).
- Prepend an entry to [`docs/logs/gtd.md`](../../docs/logs/gtd.md). Do not edit `docs/log.md`.
- Optional one-line note in [`docs/llm-bridge.md`](../../docs/llm-bridge.md).
- Keep this spec's entry in [`specs/README.md`](../README.md); move the spec to `specs/done/` only
  after implementation, tests and docs have shipped.
- Verify relative Markdown links. `AGENTS.md` and `CLAUDE.md` are untouched.

## Risks, ranked

1. **Non-atomic Memory rollback** (orphan project). Mitigated by the four-map snapshot and the
   `listProjects()` assertion.
2. **Surprise from auto-promotion**: with the chosen ordering, the new Next Action is a copy of the
   oldest completed task. Documented here and in `docs/gtd.md`; the confirm panel may preview
   « Première action : « … » ».
3. **Large-project latency and write-queue occupancy** (see "Performance").
4. **Unique-constraint violation** from a copied `sourceExternalId`. Mitigated by always nulling it.
5. **Stale UI feedback** from the card reset effects. Mitigated by the list-level notice and the
   ref-guarded reset.
6. **Recurring instances silently become one-off tasks.** Stated in the project notice.

## Open questions

1. **Single task inside a finished project.** Decision 4 sends the copy to the Inbox (project link
   dropped) when the project is `completed` or `cancelled`, and keeps it Planned when the project is
   `active` or `on_hold`. Is that the right split? Alternative: always keep the copy Planned in the
   same project, even a finished one (it would sit there unpromoted and invisible under the default
   "open" filter).
