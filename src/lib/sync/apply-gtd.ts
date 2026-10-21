import type { Task } from "../../domain/types";
import { compactPlannedOrders } from "../gtd/planned";
import type { Database } from "../storage/sqlite-db";
import type { FieldCodec, RawRow } from "./capture-decode";
import { fetchMeta, fetchRows, type MetaRow, parseClocks } from "./capture-stamp";
import type { SyncChangeSet, SyncEntity } from "./change-set";
import { entityIdOf, parseEntityId, type PrimaryKeyValue } from "./entity-id";
import { jsonDeepEqual } from "./field-clocks";
import { BASELINE_CLOCK, type EntityMergeOutcome, type LocalEntityState } from "./merge-entity";
import {
  type ExtraConflict,
  instanceEntityId,
  isTerminalStatus,
  mergeTaskEntity,
  mergeTemplateEntity,
  type TaskMergeInput,
  type TaskMergeOutcome,
} from "./merge-task";
import type { TemplateRecurrence } from "./recurrence-occurrences";
import { loadRecurrence } from "./recurrence-store";
import type { TableInfo } from "./table-info";

/**
 * Applying `gtd_tasks` and `recurring_task_templates` entities: the glue between the pure merge
 * rules of `merge-task.ts` and the database (`apply-bundle.ts` writes what this returns).
 *
 * Per batch of entities it
 * 1. merges every entity with the occurrences already merged by `apply-recurrence.ts`;
 * 2. recomputes the recurring instance and template of every template the bundle touched through
 *    its sidecars, even when the bundle carries no entity for it (a peer may only have recorded an
 *    outcome);
 * 3. for tasks, repairs the Planned queue of the affected projects IN MEMORY, before anything is
 *    written, so a re-applied bundle that merges to the stored state writes nothing at all.
 *
 * Planned queue repair: tasks merge one by one (tuple last-writer-wins), so two laptops that
 * reordered, or both appended, can leave two tasks with the same `planned_order`, which would make
 * the manual up/down move a no-op. When a project's active queue has a duplicate (or a missing)
 * order, the whole queue is renumbered `0..n-1` with `compactPlannedOrders` (the same function and
 * the same tie rules the desktop uses). Gaps are left alone on purpose. Renumbering rewrites
 * orders without a clock, so unlike the rest of the merge it is not a join: two replicas that
 * repair different intermediate states can hold different orders for a moment. The next exchange
 * resolves the tie by the smaller tuple and repairs again. Orders are cosmetic; no edit is lost.
 */

export interface GtdApplyState {
  /** Merged sidecars of the templates this bundle touches. */
  recurrence: Map<string, TemplateRecurrence>;
  /** Templates whose instance row and template row must be recomputed. */
  touchedTemplates: Set<string>;
  /** Projects known to be deleted, loaded once after the projects were applied. */
  goneProjects: Set<string> | null;
}

export interface TableEnv {
  db: Database;
  table: string;
  info: TableInfo;
  codec: FieldCodec;
}

/** One entity ready to be written: a bundle entity, or a local row the merge recomputed. */
export interface StagedEntity {
  entityId: string;
  key: PrimaryKeyValue[];
  outcome: EntityMergeOutcome;
  conflicts: ExtraConflict[];
}

/** The templates a bundle touches: through its sidecars, its instance rows or its templates. */
export const touchedTemplatesOf = (
  changeSet: SyncChangeSet,
  fromSidecars: ReadonlySet<string>,
): Set<string> => {
  const touched = new Set(fromSidecars);
  for (const entity of changeSet.entities) {
    if (entity.table === "recurring_task_templates") {
      touched.add(entity.entityId);
    } else if (
      entity.table === "gtd_tasks" &&
      entity.row !== null &&
      Number(entity.row.is_recurring_instance) === 1 &&
      typeof entity.row.recurring_template_id === "string"
    ) {
      touched.add(entity.row.recurring_template_id);
    }
  }
  return touched;
};

export const loadGtdApplyState = async (
  db: Database,
  touchedTemplates: Set<string>,
): Promise<GtdApplyState> => ({
  recurrence: await loadRecurrence(db, [...touchedTemplates]),
  touchedTemplates,
  goneProjects: null,
});

const loadGoneProjects = async (db: Database, state: GtdApplyState): Promise<Set<string>> => {
  if (state.goneProjects === null) {
    const rows = await db.select<{ entity_id: string }[]>(
      "SELECT entity_id FROM sync_entity_meta WHERE entity_type = 'gtd_projects' AND deleted_at IS NOT NULL",
    );
    state.goneProjects = new Set(rows.map((row) => row.entity_id));
  }
  return state.goneProjects;
};

const localStateOf = (row: RawRow | undefined, meta: MetaRow | undefined): LocalEntityState => ({
  row: row ?? null,
  meta: meta
    ? {
        fieldClocks: parseClocks(meta.field_clocks_json),
        rowHlc: meta.row_hlc,
        deletedAt: meta.deleted_at,
      }
    : null,
});

const mergeInput = (
  env: TableEnv,
  local: LocalEntityState,
  remote: SyncEntity | null,
): TaskMergeInput => ({
  codec: env.codec,
  columns: env.info.columns,
  primaryKey: env.info.primaryKey,
  notNullColumns: env.info.notNull,
  local,
  remote,
});

const keyOf = (table: string, entityId: string): PrimaryKeyValue[] =>
  parseEntityId(table, entityId) as PrimaryKeyValue[];

/** Rows of `ids` keyed by entity id. */
const fetchById = async (
  env: TableEnv,
  ids: readonly string[],
): Promise<{ rows: Map<string, RawRow>; metas: Map<string, MetaRow> }> => {
  const rows = new Map<string, RawRow>();
  if (ids.length === 0) return { rows, metas: new Map() };
  for (const row of await fetchRows(
    env.db,
    env.table,
    env.info.primaryKey,
    ids.map((id) => keyOf(env.table, id)),
  )) {
    try {
      rows.set(
        entityIdOf(
          env.table,
          env.info.primaryKey.map((column) => row[column]),
        ),
        row,
      );
    } catch {
      /* a row with a NULL key cannot be addressed */
    }
  }
  return { rows, metas: await fetchMeta(env.db, env.table, ids) };
};

const templateOfRow = (row: RawRow | null | undefined): string | null =>
  row && Number(row.is_recurring_instance) === 1 && typeof row.recurring_template_id === "string"
    ? row.recurring_template_id
    : null;

// ---------------------------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------------------------

export const mergeTemplateBatch = async (
  env: TableEnv,
  state: GtdApplyState,
  batch: readonly SyncEntity[],
  rows: Map<string, RawRow>,
  metas: Map<string, MetaRow>,
): Promise<StagedEntity[]> => {
  const staged: StagedEntity[] = [];
  const inBatch = new Set<string>();
  for (const entity of batch) {
    inBatch.add(entity.entityId);
    const outcome = mergeTemplateEntity(
      mergeInput(env, localStateOf(rows.get(entity.entityId), metas.get(entity.entityId)), entity),
      { recurrence: state.recurrence.get(entity.entityId) ?? null },
    );
    staged.push({
      entityId: entity.entityId,
      key: keyOf(env.table, entity.entityId),
      outcome,
      conflicts: outcome.conflicts,
    });
  }
  const extras = [...state.touchedTemplates].filter(
    (id) => !inBatch.has(id) && state.recurrence.has(id),
  );
  const fetched = await fetchById(env, extras);
  for (const id of extras) {
    const row = fetched.rows.get(id);
    if (row === undefined) continue;
    const outcome = mergeTemplateEntity(
      mergeInput(env, localStateOf(row, fetched.metas.get(id)), null),
      { recurrence: state.recurrence.get(id) ?? null },
    );
    if (outcome.rowAction !== "none") {
      staged.push({ entityId: id, key: keyOf(env.table, id), outcome, conflicts: [] });
    }
  }
  return staged;
};

// ---------------------------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------------------------

export const mergeTaskBatch = async (
  env: TableEnv,
  state: GtdApplyState,
  batch: readonly SyncEntity[],
  rows: Map<string, RawRow>,
  metas: Map<string, MetaRow>,
): Promise<StagedEntity[]> => {
  const gone = await loadGoneProjects(env.db, state);
  const projectGone = (projectId: string): boolean => gone.has(projectId);
  const staged: StagedEntity[] = [];
  const inBatch = new Set<string>();

  for (const entity of batch) {
    inBatch.add(entity.entityId);
    const local = localStateOf(rows.get(entity.entityId), metas.get(entity.entityId));
    const template = templateOfRow(entity.row) ?? templateOfRow(local.row);
    const outcome = mergeTaskEntity(mergeInput(env, local, entity), {
      projectGone,
      recurrence: template === null ? null : (state.recurrence.get(template) ?? null),
    });
    staged.push({
      entityId: entity.entityId,
      key: keyOf(env.table, entity.entityId),
      outcome,
      conflicts: outcome.conflicts,
    });
  }

  // Instances of templates the sidecars touched but no entity of this bundle carries.
  const extraIds = [...state.touchedTemplates]
    .filter((template) => state.recurrence.has(template))
    .map(instanceEntityId)
    .filter((id) => !inBatch.has(id));
  const fetched = await fetchById(env, extraIds);
  for (const id of extraIds) {
    const row = fetched.rows.get(id);
    const template = templateOfRow(row);
    if (row === undefined || template === null) continue;
    const outcome = mergeTaskEntity(
      mergeInput(env, localStateOf(row, fetched.metas.get(id)), null),
      { projectGone, recurrence: state.recurrence.get(template) ?? null },
    );
    if (outcome.rowAction !== "none") {
      staged.push({ entityId: id, key: keyOf(env.table, id), outcome, conflicts: [] });
    }
  }

  await repairPlannedQueues(env, staged, new Map([...rows, ...fetched.rows]));
  return staged;
};

// ---------------------------------------------------------------------------------------------
// Planned queue repair
// ---------------------------------------------------------------------------------------------

interface QueueMember {
  id: string;
  projectId: string;
  plannedOrder: number | null;
  createdAt: string;
}

const isActivePlanned = (row: RawRow | null): boolean =>
  row !== null &&
  row.bucket === "planned" &&
  !isTerminalStatus(row.status) &&
  typeof row.project_id === "string" &&
  row.project_id !== "";

const orderOf = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const hasDefect = (members: readonly QueueMember[]): boolean => {
  const seen = new Set<number>();
  for (const member of members) {
    if (member.plannedOrder === null || seen.has(member.plannedOrder)) return true;
    seen.add(member.plannedOrder);
  }
  return false;
};

const asTask = (member: QueueMember): Task =>
  ({
    id: member.id,
    status: "active",
    bucket: "planned",
    projectId: member.projectId,
    plannedOrder: member.plannedOrder,
    createdAt: member.createdAt,
    contextIds: [],
  }) as unknown as Task;

/** Sets `planned_order` on a staged entity, keeping its outcome consistent with the stored row. */
const withPlannedOrder = (staged: StagedEntity, order: number, localRow: RawRow | null): void => {
  const outcome = staged.outcome as TaskMergeOutcome;
  if (outcome.finalRow === null) return;
  outcome.finalRow = { ...outcome.finalRow, planned_order: order };
  if (outcome.rowAction === "insert" || localRow === null) {
    outcome.columns = { ...outcome.columns, planned_order: order };
    return;
  }
  const columns = { ...outcome.columns };
  if (jsonDeepEqual(order, localRow.planned_order)) {
    delete columns.planned_order;
  } else {
    columns.planned_order = order;
  }
  outcome.columns = columns;
  outcome.rowAction = Object.keys(columns).length > 0 ? "update" : "none";
};

const repairPlannedQueues = async (
  env: TableEnv,
  staged: StagedEntity[],
  localRows: Map<string, RawRow>,
): Promise<void> => {
  const stagedById = new Map(staged.map((entry) => [entry.entityId, entry] as const));
  const projects = new Set<string>();
  for (const entry of staged) {
    const row = (entry.outcome as TaskMergeOutcome).finalRow;
    if (isActivePlanned(row)) projects.add((row as RawRow).project_id as string);
  }
  if (projects.size === 0) return;

  const ids = [...projects];
  const stored = await env.db.select<RawRow[]>(
    `SELECT id, project_id, planned_order, created_at FROM gtd_tasks
     WHERE bucket = 'planned' AND status NOT IN ('completed', 'cancelled')
       AND project_id IN (${ids.map((_, index) => `$${index + 1}`).join(", ")})`,
    ids,
  );
  const queues = new Map<string, Map<string, QueueMember>>();
  const place = (member: QueueMember): void => {
    const queue = queues.get(member.projectId) ?? new Map<string, QueueMember>();
    queue.set(member.id, member);
    queues.set(member.projectId, queue);
  };
  for (const row of stored) {
    place({
      id: String(row.id),
      projectId: String(row.project_id),
      plannedOrder: orderOf(row.planned_order),
      createdAt: String(row.created_at ?? ""),
    });
  }
  // The merged rows replace what is stored: a task that left the queue is removed, one that joined
  // it is added.
  for (const entry of staged) {
    for (const queue of queues.values()) queue.delete(entry.entityId);
    const row = (entry.outcome as TaskMergeOutcome).finalRow;
    if (isActivePlanned(row)) {
      place({
        id: entry.entityId,
        projectId: (row as RawRow).project_id as string,
        plannedOrder: orderOf((row as RawRow).planned_order),
        createdAt: String((row as RawRow).created_at ?? ""),
      });
    }
  }

  const renumbered = new Map<string, number>();
  for (const [projectId, queue] of [...queues].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const members = [...queue.values()];
    if (!hasDefect(members)) continue;
    for (const changed of compactPlannedOrders(members.map(asTask), projectId)) {
      if (changed.plannedOrder !== null) renumbered.set(changed.id, changed.plannedOrder);
    }
  }

  const outside = [...renumbered.keys()].filter((id) => !stagedById.has(id));
  const fetched = outside.length > 0 ? await fetchById(env, outside) : null;
  for (const [id, order] of renumbered) {
    const entry = stagedById.get(id);
    if (entry !== undefined) {
      withPlannedOrder(entry, order, localRows.get(id) ?? null);
      continue;
    }
    const row = fetched?.rows.get(id);
    const meta = fetched?.metas.get(id);
    if (row === undefined || jsonDeepEqual(row.planned_order, order)) continue;
    const local = localStateOf(row, meta);
    const outcome: TaskMergeOutcome = {
      rowAction: "update",
      columns: { planned_order: order },
      meta: local.meta ?? { fieldClocks: {}, rowHlc: BASELINE_CLOCK, deletedAt: null },
      metaChanged: false,
      tombstoneApplied: false,
      overwritten: [],
      conflicts: [],
      finalRow: { ...row, planned_order: order },
    };
    staged.push({ entityId: id, key: keyOf(env.table, id), outcome, conflicts: [] });
  }
};
