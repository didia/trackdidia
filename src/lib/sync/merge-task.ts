import { hash128 } from "../finance/hash";
import type { RawRow } from "./capture-decode";
import type { SyncEntity } from "./change-set";
import {
  canonicalJson,
  type FieldClocks,
  getOwn,
  jsonDeepEqual,
  rowHlc as maxFieldClock,
  setOwn,
} from "./field-clocks";
import { compareHlc, maxHlcOf } from "./hlc";
import {
  BASELINE_CLOCK,
  type EntityMergeOutcome,
  type EntityMeta,
  knownClocks,
  type LocalEntityState,
  type MergeEntityInput,
  type OverwrittenField,
  mergeFieldClockEntity,
  type RowAction,
  sameMeta,
  senderHasSeen,
} from "./merge-entity";
import {
  isUserOutcome,
  joinOccurrence,
  latestDueDate,
  missedBacklog,
  type OccurrenceRecord,
  outcomeOfStatus,
  type TemplateRecurrence,
} from "./recurrence-occurrences";

/**
 * Merge rules of the GTD task and of the recurring template: the `gtd_tasks` and
 * `recurring_task_templates` replacement for the generic per-field merge of `merge-entity.ts`.
 * Pure: the caller (`apply-gtd.ts`) feeds in what the database holds and writes what comes out.
 *
 * ## The lifecycle tuple
 *
 * `{status, bucket, completed_at, scheduled_for, planned_order, project_id}` is merged as ONE unit.
 * Per-field last-writer-wins would produce states no user ever saw (`completed` with
 * `bucket = inbox`, a `scheduled` task without a date, a `cancelled` task with a completion date).
 * `project_id` is the one member the mobile spec lists as an independent field. It joins the unit
 * because a planned task's queue and order only mean something inside one project (on the desktop
 * moving a planned task to another project always re-stamps its order, so the two are one edit),
 * and because the normalization below depends on it: with `project_id` merged on its own, a
 * concurrent project clear demotes a planned task in one merge order and not in another, so
 * replicas that merge the same three edits in different orders diverge. The cost is that a project
 * re-filing racing a bucket change on another laptop competes with it as a whole (the loser is
 * logged as an overwritten edit).
 *
 * The unit has a total order, and the merge is its maximum, so every replica picks the same winner
 * whatever the order of application (commutative, associative, idempotent):
 *
 * 1. A TERMINAL tuple (`completed`/`cancelled`) beats an active one whatever the clocks say.
 *    Terminal is absorbing in the app (nothing reopens a task), so there is no "later reopen" to
 *    protect, and the loser's bucket/schedule move is dropped (logged as an `overwritten_edit` on
 *    the device whose edit lost).
 * 2. Same kind: the later tuple clock (the newest clock of any member) wins. For `completed`
 *    against `cancelled` this is a deterministic PROVISIONAL winner, and the pair also writes an
 *    unresolved `terminal_divergence` conflict with both tuples for the user to settle.
 * 3. Equal clocks: the tuple with the smaller canonical JSON, as every other tie in this engine.
 *
 * The winner's member clocks (not a per-member maximum) become the merged clocks; a maximum would
 * make the result depend on what was merged before.
 *
 * ## Normalization
 *
 * After the tuple (and `project_id`) are chosen, the row is normalized with the rules the app's own
 * save applies (`adjustPlannedFieldsForSave` and the demotions around it), as a pure function of the
 * merged row so every replica computes the same result:
 * - an ACTIVE `planned` task needs a project that still exists, else it is demoted exactly as the
 *   desktop demotes one (`next_action`, no scheduled date, no order);
 * - an ACTIVE `scheduled` task needs `scheduled_for`, else `next_action`;
 * - `planned_order` exists only in the `planned` bucket. A completed planned task keeps its order
 *   like it does on the desktop (`adjustPlannedFieldsForSave` retains it): the app never clears it.
 * Normalization writes no clock: it is derived, not an edit. The next merge re-derives it.
 *
 * ## Recurring instances (`is_recurring_instance = 1`, id `recurring-task:<templateId>`)
 *
 * The row is advanced in place, so its id is not an occurrence. `recurrence_due_date`, the
 * lifecycle tuple and `pending_past_recurrences` are scoped to an occurrence (the epoch is the due
 * date), and are RECOMPUTED after the occurrences of the template merged (`recurrence-occurrences.ts`):
 * - the due date is the latest occurrence, and the tuple is taken from the row(s) at that epoch
 *   whose status agrees with the merged outcome of the occurrence (a user outcome beats missed and
 *   active, regardless of clocks); a row from an older epoch contributes none of its lifecycle;
 * - the backlog is the number of `missed` occurrences after `cleared_through_date`, never merged.
 * Everything else on the row (title, notes, contexts) merges per field as usual.
 *
 * ## Templates
 *
 * Generic per-field merge, except `last_generated_for_date`, which is the latest occurrence.
 * (`pending_missed_occurrences` stays a per-field value: it is a write-only mirror nothing reads.)
 */

export const LIFECYCLE_FIELDS = [
  "status",
  "bucket",
  "completed_at",
  "scheduled_for",
  "planned_order",
  "project_id",
] as const;
export type LifecycleField = (typeof LIFECYCLE_FIELDS)[number];

/** Fields scoped to an occurrence on a recurring instance, besides the lifecycle tuple. */
const EPOCH_FIELDS = ["recurrence_due_date", "pending_past_recurrences"] as const;

export const TASK_TABLE = "gtd_tasks";

type LifecycleValues = Record<LifecycleField, unknown>;
type MemberClocks = Record<LifecycleField, string | null>;

/** One side's lifecycle tuple with the clocks it carries. */
export interface LifecycleTuple {
  values: LifecycleValues;
  clocks: MemberClocks;
  /** The newest clock of any member: the tuple's own clock. `null` when never stamped. */
  clock: string | null;
}

export interface ExtraConflict {
  id: string;
  kind: "terminal_divergence";
  entityType: string;
  entityId: string;
  local: unknown;
  remote: unknown;
}

export interface TaskMergeContext {
  /** True when the project is known to be deleted (a tombstone). Unknown projects are NOT gone. */
  projectGone?: (projectId: string) => boolean;
  /** The merged occurrences of the instance row's template. Defaults to none. */
  recurrence?: TemplateRecurrence | null;
}

export interface TaskMergeInput extends Omit<MergeEntityInput, "remote"> {
  /** `null` recomputes the local row from the sidecars alone (no peer row to merge). */
  remote: SyncEntity | null;
}

export interface TaskMergeOutcome extends EntityMergeOutcome {
  conflicts: ExtraConflict[];
  /** The whole stored row after the merge (`null` when the entity has none). */
  finalRow: RawRow | null;
}

// ---------------------------------------------------------------------------------------------
// The lifecycle tuple
// ---------------------------------------------------------------------------------------------

export const isTerminalStatus = (status: unknown): boolean =>
  status === "completed" || status === "cancelled";

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const compareClocks = (a: string | null, b: string | null): number =>
  a === null ? (b === null ? 0 : -1) : b === null ? 1 : compareHlc(a, b);

const clockOf = (clocks: FieldClocks, field: string): string | null =>
  getOwn(clocks, field) ?? null;

/**
 * Reads a tuple from a row and its clocks. A column the row does not carry (a peer on an older
 * schema) is taken from `fallback`, value and clock, so the unit stays whole.
 */
const readTuple = (
  row: RawRow,
  clocks: FieldClocks,
  members: readonly LifecycleField[],
  fallback: LifecycleTuple | null,
): LifecycleTuple => {
  const values = {} as LifecycleValues;
  const memberClocks = {} as MemberClocks;
  for (const field of LIFECYCLE_FIELDS) {
    if (members.includes(field) && Object.hasOwn(row, field)) {
      values[field] = row[field] ?? null;
      memberClocks[field] = clockOf(clocks, field);
    } else {
      values[field] = fallback?.values[field] ?? null;
      memberClocks[field] = fallback?.clocks[field] ?? null;
    }
  }
  return {
    values,
    clocks: memberClocks,
    clock: maxHlcOf(Object.values(memberClocks)),
  };
};

/** Positive when tuple `a` beats `b`; see the module comment. Zero only for identical tuples. */
export const compareTuples = (a: LifecycleTuple, b: LifecycleTuple): number => {
  const byKind =
    Number(isTerminalStatus(a.values.status)) - Number(isTerminalStatus(b.values.status));
  if (byKind !== 0) return byKind;
  const byClock = compareClocks(a.clock, b.clock);
  if (byClock !== 0) return byClock;
  const byValues = compareText(canonicalJson(b.values), canonicalJson(a.values));
  if (byValues !== 0) return byValues;
  return compareText(canonicalJson(b.clocks), canonicalJson(a.clocks));
};

const sameTuple = (a: LifecycleTuple, b: LifecycleTuple): boolean =>
  jsonDeepEqual(a.values, b.values);

/** What a conflict row shows of one side. */
const snapshotOf = (tuple: LifecycleTuple): Record<string, unknown> => ({
  ...tuple.values,
  clock: tuple.clock,
});

/**
 * Deterministic id of a `terminal_divergence` conflict: one per task (or per occurrence of a
 * recurring task). A task can only become terminal once, so the same divergence found again (the
 * bundle is applied twice, or republished) is the same row, and a divergence the user already
 * resolved is never raised again.
 */
export const terminalDivergenceId = (
  entityType: string,
  entityId: string,
  occurrence: string | null,
): string => `terminal-divergence:${hash128(JSON.stringify([entityType, entityId, occurrence]))}`;

// ---------------------------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------------------------

/**
 * The app's save-time invariants applied to a merged row. Pure and idempotent. Returns the same
 * object when nothing needs to change.
 */
export const normalizeTaskRow = (
  row: RawRow,
  projectGone: (projectId: string) => boolean = () => false,
): RawRow => {
  const has = (column: string): boolean => Object.hasOwn(row, column);
  if (!has("bucket")) return row;
  const active = !isTerminalStatus(row.status);
  let next = row;
  const change = (patch: RawRow): void => {
    next = { ...next, ...patch };
  };

  if (active && next.bucket === "planned") {
    const project = next.project_id;
    if (typeof project !== "string" || project === "" || projectGone(project)) {
      // Exactly what the desktop does to a planned task that loses its project.
      change({
        bucket: "next_action",
        ...(has("scheduled_for") ? { scheduled_for: null } : {}),
      });
    }
  } else if (active && next.bucket === "scheduled" && has("scheduled_for") && !next.scheduled_for) {
    change({ bucket: "next_action" });
  }
  if (has("planned_order") && next.bucket !== "planned" && next.planned_order !== null) {
    change({ planned_order: null });
  }
  return next;
};

// ---------------------------------------------------------------------------------------------
// Assembling an outcome
// ---------------------------------------------------------------------------------------------

const emptyOutcome = (local: LocalEntityState): TaskMergeOutcome => ({
  rowAction: "none",
  columns: {},
  meta: local.meta ?? { fieldClocks: {}, rowHlc: BASELINE_CLOCK, deletedAt: null },
  metaChanged: false,
  tombstoneApplied: false,
  overwritten: [],
  conflicts: [],
  finalRow: local.row,
});

/** Turns the merged row and clocks into the outcome the apply layer writes. */
const assemble = (
  local: LocalEntityState,
  remote: SyncEntity | null,
  row: RawRow,
  clocks: FieldClocks,
  overwritten: OverwrittenField[],
  conflicts: ExtraConflict[],
): TaskMergeOutcome => {
  let rowAction: RowAction;
  let columns: Record<string, unknown>;
  if (local.row === null) {
    rowAction = "insert";
    columns = { ...row };
  } else {
    columns = {};
    for (const column of Object.keys(row)) {
      if (!jsonDeepEqual(row[column], local.row[column])) {
        setOwn(columns, column, row[column]);
      }
    }
    rowAction = Object.keys(columns).length > 0 ? "update" : "none";
  }
  const meta: EntityMeta = {
    fieldClocks: clocks,
    rowHlc:
      maxFieldClock(clocks) ??
      (local.row === null ? undefined : local.meta?.rowHlc) ??
      remote?.rowHlc ??
      BASELINE_CLOCK,
    deletedAt: null,
  };
  return {
    rowAction,
    columns,
    meta,
    metaChanged: local.row === null ? true : !sameMeta(local.meta, meta),
    tombstoneApplied: false,
    overwritten,
    conflicts,
    finalRow: row,
  };
};

const withoutKeys = (clocks: FieldClocks, drop: ReadonlySet<string>): FieldClocks => {
  const kept: FieldClocks = {};
  for (const key of Object.keys(clocks)) {
    if (!drop.has(key)) setOwn(kept, key, clocks[key] as string);
  }
  return kept;
};

const setClock = (clocks: FieldClocks, field: string, clock: string | null): void => {
  if (clock !== null) setOwn(clocks, field, clock);
};

const fieldNamesOf = (input: Pick<MergeEntityInput, "codec">): Set<string> =>
  new Set([
    ...(input.codec.spec.scalars ?? []),
    ...(input.codec.spec.maps ?? []),
    ...(input.codec.spec.sets ?? []),
  ]);

const templateIdOf = (row: RawRow | null): string | null =>
  row !== null &&
  Number(row.is_recurring_instance) === 1 &&
  typeof row.recurring_template_id === "string"
    ? row.recurring_template_id
    : null;

/** Id of the row a recurring template advances in place. */
export const instanceEntityId = (templateId: string): string => `recurring-task:${templateId}`;

// ---------------------------------------------------------------------------------------------
// Recurring instance epoch
// ---------------------------------------------------------------------------------------------

interface EpochChoice {
  due: string;
  tuple: LifecycleTuple;
  /** `null` when no occurrence is known at all: the row keeps whatever count it carries. */
  pending: number | null;
}

/**
 * The state of a recurring instance after the occurrences merged: see the module comment. `null`
 * when nothing says which occurrence is current (no occurrence and no row with a due date).
 */
const resolveEpoch = (args: {
  local: { tuple: LifecycleTuple; due: string | null } | null;
  remote: { tuple: LifecycleTuple; due: string | null } | null;
  recurrence: TemplateRecurrence;
}): EpochChoice | null => {
  const { local, remote, recurrence } = args;
  const dates = [
    ...recurrence.occurrences.map((record) => record.dueDate),
    local?.due ?? null,
    remote?.due ?? null,
  ].filter((date): date is string => typeof date === "string" && date !== "");
  const due = dates.reduce<string | null>(
    (max, date) => (max === null || date > max ? date : max),
    null,
  );
  if (due === null) return null;

  const candidates = [local, remote].filter(
    (side): side is { tuple: LifecycleTuple; due: string | null } =>
      side !== null && side.due === due,
  );
  // The merged outcome of the current occurrence is the sidecar record. Only when there is none (a
  // database whose sidecars are incomplete) does a row's own status stand in for it. A row's status
  // is NOT evidence next to a record: a laptop whose local day is behind pulls a premature instance
  // back by cancelling the row, which is the generator's bookkeeping and not an outcome, so the
  // record stays `active` and that cancelled row is outvoted.
  const records: OccurrenceRecord[] = recurrence.occurrences.filter(
    (record) => record.dueDate === due,
  );
  if (records.length === 0) {
    for (const side of candidates) {
      records.push({
        templateId: "",
        dueDate: due,
        outcome: outcomeOfStatus(side.tuple.values.status),
        outcomeHlc: side.tuple.clock ?? BASELINE_CLOCK,
        deviceId: "",
      });
    }
  }
  const outcome = records.reduce((best, record) => joinOccurrence(best, record)).outcome;

  const agrees = (tuple: LifecycleTuple): boolean =>
    isUserOutcome(outcome)
      ? tuple.values.status === outcome
      : !isTerminalStatus(tuple.values.status);
  const matching = candidates.filter((side) => agrees(side.tuple));
  const pool = matching.length > 0 ? matching : candidates;
  let chosen: LifecycleTuple | null = null;
  for (const side of pool) {
    if (chosen === null || compareTuples(side.tuple, chosen) > 0) chosen = side.tuple;
  }
  // No row at the current epoch (the occurrence only exists in a sidecar): keep the row's own
  // lifecycle and let the outcome below correct the status.
  const base = chosen ?? local?.tuple ?? remote?.tuple;
  if (base === undefined) return null;

  let tuple = base;
  if (
    isUserOutcome(outcome) ? base.values.status !== outcome : isTerminalStatus(base.values.status)
  ) {
    tuple = {
      ...base,
      values: {
        ...base.values,
        status: isUserOutcome(outcome) ? outcome : "active",
        completed_at: outcome === "completed" ? (base.values.completed_at ?? null) : null,
      },
    };
  }
  return {
    due,
    tuple,
    pending:
      recurrence.occurrences.length === 0
        ? null
        : missedBacklog(recurrence.occurrences, recurrence.clearedThroughDate),
  };
};

// ---------------------------------------------------------------------------------------------
// Task entity
// ---------------------------------------------------------------------------------------------

/**
 * Merges the remote `gtd_tasks` entity into the local state (or, with `remote: null`, recomputes
 * the local recurring instance from the occurrences alone). Everything not in the lifecycle tuple,
 * and not epoch-scoped on an instance, keeps the generic per-field / OR-set behaviour: the generic
 * merge runs first and the tuple rules replace only their own columns.
 */
export const mergeTaskEntity = (
  input: TaskMergeInput,
  context: TaskMergeContext = {},
): TaskMergeOutcome => {
  const { local, remote, columns } = input;
  const localRow = local.row;
  const projectGone = context.projectGone ?? (() => false);

  const generic = remote === null ? null : mergeFieldClockEntity({ ...input, remote });
  if (generic !== null && generic.meta.deletedAt !== null) {
    return { ...generic, conflicts: [], finalRow: null };
  }
  const remoteRow = remote?.row ?? null;
  if (remote !== null && remoteRow === null) {
    // A tombstone older than a local edit: the local state stands.
    return { ...(generic as EntityMergeOutcome), conflicts: [], finalRow: localRow };
  }
  if (localRow === null && remote === null) return emptyOutcome(local);

  const members = LIFECYCLE_FIELDS.filter((field) => columns.includes(field));
  const localClocks = local.meta?.fieldClocks ?? {};
  const remoteClocks = remote === null ? {} : knownClocks(remote.fieldClocks, fieldNamesOf(input));

  const base: RawRow =
    localRow === null
      ? { ...(generic?.columns ?? {}) }
      : { ...localRow, ...(generic?.columns ?? {}) };
  let clocks: FieldClocks = { ...(generic === null ? localClocks : generic.meta.fieldClocks) };

  const localTuple = localRow === null ? null : readTuple(localRow, localClocks, members, null);
  const remoteTuple =
    remoteRow === null ? null : readTuple(remoteRow, remoteClocks, members, localTuple);
  const templateId = templateIdOf(remoteRow) ?? templateIdOf(localRow);
  const recurrence = context.recurrence ?? { occurrences: [], clearedThroughDate: null };

  const overwritten: OverwrittenField[] = [];
  const conflicts: ExtraConflict[] = [];
  const owned = new Set<string>(members);

  let chosen: LifecycleTuple | null = null;
  const epoch =
    templateId === null
      ? null
      : resolveEpoch({
          local:
            localTuple === null || localRow === null
              ? null
              : { tuple: localTuple, due: stringOrNull(localRow.recurrence_due_date) },
          remote:
            remoteTuple === null || remoteRow === null
              ? null
              : { tuple: remoteTuple, due: stringOrNull(remoteRow.recurrence_due_date) },
          recurrence,
        });

  if (epoch !== null) {
    chosen = epoch.tuple;
    for (const field of EPOCH_FIELDS) owned.add(field);
    if (columns.includes("recurrence_due_date")) base.recurrence_due_date = epoch.due;
    if (columns.includes("pending_past_recurrences") && epoch.pending !== null) {
      base.pending_past_recurrences = epoch.pending;
    }
  } else if (localTuple !== null && remoteTuple !== null) {
    const order = compareTuples(localTuple, remoteTuple);
    chosen = order >= 0 ? localTuple : remoteTuple;
    if (order < 0 && !sameTuple(localTuple, remoteTuple)) {
      noteLifecycleOverwrite(localTuple, remoteTuple, remote as SyncEntity, overwritten);
    }
    if (
      isTerminalStatus(localTuple.values.status) &&
      isTerminalStatus(remoteTuple.values.status) &&
      localTuple.values.status !== remoteTuple.values.status
    ) {
      const entityId = (remote as SyncEntity).entityId;
      conflicts.push({
        id: terminalDivergenceId(TASK_TABLE, entityId, null),
        kind: "terminal_divergence",
        entityType: TASK_TABLE,
        entityId,
        local: snapshotOf(localTuple),
        remote: snapshotOf(remoteTuple),
      });
    }
  } else {
    chosen = localTuple ?? remoteTuple;
  }

  if (chosen !== null) {
    for (const field of members) {
      if (localRow !== null || Object.hasOwn(base, field)) base[field] = chosen.values[field];
    }
    clocks = withoutKeys(clocks, new Set(members));
    for (const field of members) setClock(clocks, field, chosen.clocks[field]);
  }

  const normalized = normalizeTaskRow(base, projectGone);
  return assemble(
    local,
    remote,
    normalized,
    clocks,
    [...(generic?.overwritten ?? []).filter((item) => !owned.has(item.field)), ...overwritten],
    conflicts,
  );
};

const stringOrNull = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

/**
 * Logs the local tuple that a remote one replaced, when the sender cannot have seen it. A change
 * of `planned_order` alone (a drag in the Planned queue) is never worth a row.
 */
const noteLifecycleOverwrite = (
  localTuple: LifecycleTuple,
  remoteTuple: LifecycleTuple,
  remote: SyncEntity,
  into: OverwrittenField[],
): void => {
  const differing = LIFECYCLE_FIELDS.filter(
    (field) => !jsonDeepEqual(localTuple.values[field], remoteTuple.values[field]),
  );
  if (differing.length === 0) return;
  // Two completions (or two cancellations) are the same decision made twice: nothing was lost.
  if (
    localTuple.values.status === remoteTuple.values.status &&
    isTerminalStatus(localTuple.values.status)
  ) {
    return;
  }
  if (differing.length === 1 && differing[0] === "planned_order") return;
  if (senderHasSeen(localTuple.clock, remote.fieldClocks)) return;
  into.push({
    field: "lifecycle",
    local: { value: snapshotOf(localTuple), clock: localTuple.clock },
    remote: { value: snapshotOf(remoteTuple), clock: remoteTuple.clock },
  });
};

// ---------------------------------------------------------------------------------------------
// Recurring template
// ---------------------------------------------------------------------------------------------

/**
 * Merges the remote `recurring_task_templates` entity. Generic per field, except
 * `last_generated_for_date`: the latest occurrence recorded for the template, when there is one.
 * With `remote: null` the local template is recomputed from the occurrences alone.
 */
export const mergeTemplateEntity = (
  input: TaskMergeInput,
  context: Pick<TaskMergeContext, "recurrence"> = {},
): TaskMergeOutcome => {
  const { local, remote, columns } = input;
  const generic = remote === null ? null : mergeFieldClockEntity({ ...input, remote });
  if (generic !== null && generic.meta.deletedAt !== null) {
    return { ...generic, conflicts: [], finalRow: null };
  }
  if (remote !== null && remote.row === null) {
    return { ...(generic as EntityMergeOutcome), conflicts: [], finalRow: local.row };
  }
  if (local.row === null && remote === null) return emptyOutcome(local);

  const base: RawRow =
    local.row === null
      ? { ...(generic?.columns ?? {}) }
      : { ...local.row, ...(generic?.columns ?? {}) };
  const latest = latestDueDate(context.recurrence?.occurrences ?? []);
  if (latest !== null && columns.includes("last_generated_for_date")) {
    base.last_generated_for_date = latest;
  }
  return assemble(
    local,
    remote,
    base,
    { ...(generic === null ? (local.meta?.fieldClocks ?? {}) : generic.meta.fieldClocks) },
    (generic?.overwritten ?? []).filter(
      (item) => !(latest !== null && item.field === "last_generated_for_date"),
    ),
    [],
  );
};
