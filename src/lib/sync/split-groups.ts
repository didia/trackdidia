import type { SyncChangeSet, SyncEntity } from "./change-set";
import { type PrimaryKeyValue, parseEntityId } from "./entity-id";
import { isTerminalSuggestionStatus } from "./merge-finance";
import { isTerminalProposalStatus } from "./merge-proposal";
import { instanceEntityId, isTerminalStatus } from "./merge-task";
import { getTableRegistration } from "./registry";

/**
 * Which entities of a change set must stay in ONE chunk when the set is split (`split-change-set.ts`).
 *
 * `applySyncBundle` merges a change set in one transaction and several rules look at more than one
 * entity of the SAME set at once: a transaction and its splits are one unit, a deleted parent
 * cascades over its children only after the children were merged, one pending proposal per key keeps
 * the first, the Planned queue of a project is renumbered over the batch, a recurring template is
 * recomputed from its occurrences. Applying such entities in different calls would still be a valid
 * merge, but not the same one (a tombstone clock invented by the cascade, a renumbered queue, an
 * expired duplicate), so they travel together. Entities with no such tie are independent and may
 * land in any chunk, in table order.
 *
 * A group is any set of entities that share a KEY below; keys are strings, entities that share one
 * are joined (transitively) by `Groups`. The rules:
 *
 * - `finance_transactions` + `finance_transaction_splits`: `tx:<transaction id>` (the unit);
 * - `finance_account_balance_snapshots` of one account: `acct-snapshots:<account id>` (one standing
 *   anchor per account);
 * - `pomodoro_sessions` + `pomodoro_segments`: `session:<session id>` (a segment is judged by its
 *   session);
 * - `weekly_objectives` + `weekly_objective_results`: `objective:<id>` (declared ON DELETE CASCADE:
 *   the parent delete is deferred until its children were merged, inside one call);
 * - recurring templates: the template, its instance task (`recurring-task:<template id>`) and its
 *   occurrence sidecar rows: `template:<template id>`;
 * - the NON-TERMINAL tasks of one project, in any bucket: `queue:<project id>`. The Planned queue is
 *   renumbered over the tasks of a batch, and a task that LEAVES the queue (moved to Next Actions) is
 *   still in its project, so it must be merged with the tasks that stay. A task that is completed,
 *   cancelled, deleted or has no project takes no part in the repair of any other task's queue except
 *   by leaving it, so those are applied FIRST, as single pieces (see {@link subOrderOf}): by the time
 *   the queue's remaining tasks are merged the leavers are already gone, as in the whole apply;
 * - any two entities of one table that share a declared natural key (bare columns only) and are
 *   resolved by `alias` or `name-prompt`: `natural:<table>:<key name>:<values>`, so a collision
 *   between two rows of the SAME set is resolved in one call exactly as before.
 *
 * Not grouped, ORDERED: `ai_proposals` and `finance_category_suggestions` (pending-collision keys).
 * `applyRowClockTable` applies them one entity at a time, decided rows first, then deletes, then
 * pending rows, each by id (`orderForApply`), and a pending row meets the stored pending rows that the
 * earlier entities left. The splitter keeps exactly that global order across chunks ({@link subOrderOf}
 * then the id), which is the same sequence of single-entity merges as one call with a commit in
 * between: a tombstone arrives before the pending rows that would otherwise collide with the row it
 * deletes, whichever chunk they are in. (Grouping them by message or transaction cannot work: a
 * tombstone carries no row, so its message is unknown to the splitter.)
 *
 * Known residual (declared, tested): a task that leaves one project's queue by moving to ANOTHER
 * project is in the destination project's group only, so the old project's remaining tasks may be
 * merged in an earlier chunk while it still sits in their queue; if that queue then has a duplicate or
 * missing order the repair renumbers differently from the whole apply. The repair is not a join (the
 * docs say so) and the replicas agree after one exchange. A group above `maxGroupEntities` is cut
 * into consecutive slices by id, with the same residual.
 *
 * What cannot be known from the set alone stays unmerged on purpose: collisions that only appear
 * after an alias rewrote an account id (two transactions that become one statement line) are found
 * by the second chunk against the first chunk's rows, which is the same path as a collision with a
 * local row.
 */

/** Union-find over string keys; entities join the sets of all their keys. */
export class Groups {
  private readonly parent = new Map<string, string>();

  private find(key: string): string {
    let root = key;
    for (;;) {
      const up = this.parent.get(root);
      if (up === undefined || up === root) break;
      root = up;
    }
    // Path compression.
    let walk = key;
    while (walk !== root) {
      const up = this.parent.get(walk) as string;
      this.parent.set(walk, root);
      walk = up;
    }
    return root;
  }

  /** Joins every key of the list into one set; returns the set's representative (or null if none). */
  join(keys: readonly string[]): string | null {
    let first: string | null = null;
    for (const key of keys) {
      if (!this.parent.has(key)) this.parent.set(key, key);
      if (first === null) {
        first = key;
        continue;
      }
      const a = this.find(first);
      const b = this.find(key);
      if (a !== b) this.parent.set(b, a);
    }
    return first === null ? null : this.find(first);
  }

  representative(key: string): string {
    return this.find(key);
  }
}

const INSTANCE_PREFIX = instanceEntityId("");

const textOf = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

const naturalKeyColumns = (table: string): { name: string; columns: readonly string[] }[] =>
  getTableRegistration(table)
    .naturalKeys.filter(
      (key) =>
        key.resolution !== "union-dedupe" &&
        // Pending collisions are resolved by apply ORDER (see the module comment), not by grouping.
        key.resolution !== "pending-collision" &&
        key.columns.every((column) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(column)),
    )
    .map((key) => ({ name: key.name, columns: key.columns }));

const idPart = (table: string, entityId: string, index: number): string | null => {
  const key = parseEntityId(table, entityId) as PrimaryKeyValue[] | null;
  const part = key?.[index];
  return part === undefined ? null : String(part);
};

/**
 * The group keys of one entity. A tombstone has no row, so only what its id says is known; rules that
 * need a column fall back to the id where the primary key carries it.
 */
export const groupKeysOf = (entity: SyncEntity): string[] => {
  const keys: string[] = [];
  const { table, row, entityId } = entity;
  const cell = (column: string): string | null => (row === null ? null : textOf(row[column]));
  switch (table) {
    case "finance_transactions":
      keys.push(`tx:${entityId}`);
      break;
    case "finance_transaction_splits": {
      const tx = cell("transaction_id");
      if (tx !== null) keys.push(`tx:${tx}`);
      break;
    }
    case "finance_account_balance_snapshots": {
      const account = idPart(table, entityId, 0);
      if (account !== null) keys.push(`acct-snapshots:${account}`);
      break;
    }
    case "pomodoro_sessions":
      keys.push(`session:${entityId}`);
      break;
    case "pomodoro_segments": {
      const session = cell("session_id");
      if (session !== null) keys.push(`session:${session}`);
      break;
    }
    case "weekly_objectives":
      keys.push(`objective:${entityId}`);
      break;
    case "weekly_objective_results": {
      const objective = idPart(table, entityId, 1);
      if (objective !== null) keys.push(`objective:${objective}`);
      break;
    }
    case "recurring_task_templates":
      keys.push(`template:${entityId}`);
      break;
    case "gtd_tasks": {
      const template =
        row !== null && Number(row.is_recurring_instance) === 1
          ? cell("recurring_template_id")
          : null;
      if (template !== null) keys.push(`template:${template}`);
      else if (entityId.startsWith(INSTANCE_PREFIX)) {
        // A tombstoned instance: its id is derived from the template id.
        keys.push(`template:${entityId.slice(INSTANCE_PREFIX.length)}`);
      }
      const project = row !== null && !isTerminalStatus(row.status) ? cell("project_id") : null;
      if (project !== null) keys.push(`queue:${project}`);
      break;
    }
    default:
      break;
  }
  if (row !== null) {
    for (const natural of naturalKeyColumns(table)) {
      const values = natural.columns.map((column) => row[column]);
      if (values.some((value) => value === null || value === undefined)) continue;
      keys.push(`natural:${table}:${natural.name}:${JSON.stringify(values)}`);
    }
  }
  return keys;
};

/** The template ids a change set's recurrence sidecars name. */
export const sidecarTemplateIds = (changeSet: SyncChangeSet): Set<string> => {
  const ids = new Set<string>();
  for (const occurrence of changeSet.recurrence.occurrences) ids.add(occurrence.template_id);
  for (const clear of changeSet.recurrence.clears) ids.add(clear.template_id);
  return ids;
};

/**
 * Where a piece sorts among the pieces of its table: lower first. Mirrors the order one call applies
 * entities in, for the tables where order matters:
 * - `ai_proposals`, `finance_category_suggestions`: decided rows (0), deletes (1), pending rows (2);
 * - a `gtd_tasks` piece with NO `queue:` key (a project-less, terminal or deleted task, alone or in a
 *   natural-key or template group): 0, so tasks that leave a Planned queue are applied before the
 *   queue's remaining tasks (1).
 * Every other piece is 1. `inQueue` says whether the entity's piece carries a `queue:` key.
 */
export const subOrderOf = (entity: SyncEntity, inQueue: boolean): number => {
  if (entity.table === "ai_proposals" || entity.table === "finance_category_suggestions") {
    if (entity.row === null) return 1;
    const terminal =
      entity.table === "ai_proposals"
        ? isTerminalProposalStatus(entity.row.status)
        : isTerminalSuggestionStatus(entity.row.status);
    return terminal ? 0 : 2;
  }
  if (entity.table === "gtd_tasks" && !inQueue) return 0;
  return 1;
};

export const QUEUE_KEY_PREFIX = "queue:";

/**
 * True for an entity that may be separated from the rest of its group: a task whose ONLY key is its
 * project's queue (no template, no natural key). Everything else in a group is tied to its group
 * members by a rule that reads them together, and is never cut away from them: a transaction from its
 * splits (children sort before the parent id and would be dropped as orphans, the unit would replace
 * local splits), an objective from its results, a session from its segments (a segment of an unknown
 * session fails the bundle), a template from its instance, the snapshots of an account.
 */
export const isDetachable = (entity: SyncEntity, keys: readonly string[]): boolean =>
  entity.table === "gtd_tasks" &&
  keys.length === 1 &&
  (keys[0] as string).startsWith(QUEUE_KEY_PREFIX);
