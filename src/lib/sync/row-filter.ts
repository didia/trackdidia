import type { SyncEntity } from "./change-set";
import { SyncApplyError } from "./errors";
import { getTableRegistration, POMODORO_TERMINAL_STATUSES } from "./registry";

/**
 * Registry `rowFilter`s as code: which rows of a table may leave a laptop, and which an incoming
 * bundle may carry. The SQL form is `RowFilter.publishWhen` itself (the registry is the single
 * source; `list-changes.ts` appends it to the `SELECT`); this module holds the pure predicate that
 * judges rows that are not in the local database yet (an incoming bundle), plus the checks that
 * need the other rows of the same set (a segment is published only with its terminal session).
 * `row-filter.test.ts` runs the SQL and the predicate over the same rows, so they cannot drift.
 *
 * Both directions use it: publishing asserts that nothing filtered out reached the change set
 * (defence behind the SQL), applying refuses a bundle that carries a filtered-out row (an honest
 * peer cannot produce one, so it is a bug or an attack, and is never applied silently).
 */

export const isTerminalSessionStatus = (status: unknown): boolean =>
  (POMODORO_TERMINAL_STATUSES as readonly string[]).includes(String(status));

export interface FilterContext {
  /** Ids of the terminal sessions published in the same set. */
  terminalSessionIds: ReadonlySet<string>;
}

type RowPredicate = (row: Record<string, unknown>, context: FilterContext) => boolean;

/** One predicate per registry `rowFilter`; `row-filter.test.ts` fails when a filter has none. */
const PREDICATES: Readonly<Record<string, RowPredicate>> = {
  pomodoro_sessions: (row) => isTerminalSessionStatus(row.status),
  pomodoro_segments: (row, context) => context.terminalSessionIds.has(String(row.session_id)),
  finance_account_balance_snapshots: (row) => row.source === "statement",
};

/** Tables that have a `rowFilter` in the registry. */
export const filteredTables = (): string[] => Object.keys(PREDICATES);

/** The SQL predicate that selects a table's publishable rows, or `null` for an unfiltered table. */
export const publishFilterSql = (table: string): string | null =>
  getTableRegistration(table).rowFilter?.publishWhen ?? null;

/** True when `row` of `table` satisfies the table's filter (always true for an unfiltered table). */
export const rowPassesFilter = (
  table: string,
  row: Record<string, unknown>,
  context: FilterContext,
): boolean => {
  if (getTableRegistration(table).rowFilter === undefined) return true;
  const predicate = Object.hasOwn(PREDICATES, table) ? PREDICATES[table] : undefined;
  if (predicate === undefined) {
    throw new Error(`Table "${table}" has a rowFilter but no predicate in row-filter.ts`);
  }
  return predicate(row, context);
};

const terminalSessionIdsOf = (entities: readonly SyncEntity[]): Set<string> =>
  new Set(
    entities
      .filter(
        (entity) =>
          entity.table === "pomodoro_sessions" &&
          entity.row !== null &&
          isTerminalSessionStatus(entity.row.status),
      )
      .map((entity) => entity.entityId),
  );

/** Sessions of the set by id, so a segment can be judged against the session it names. */
const sessionStates = (entities: readonly SyncEntity[]): Map<string, SyncEntity> =>
  new Map(
    entities.filter((entity) => entity.table === "pomodoro_sessions").map((e) => [e.entityId, e]),
  );

/**
 * Refuses a change set that carries a row its table never publishes.
 *
 * - `publish`: strict. A segment must belong to a terminal session of the same set. Failing is a
 *   bug in the publisher, so it throws a plain `Error`.
 * - `apply`: a session must be terminal; a segment must belong to a terminal session of the bundle,
 *   or to a session the bundle does not mention at all (then the database decides while applying:
 *   the session may be a terminal one received earlier). A segment of a session the bundle carries
 *   as non-terminal or deleted is refused. Throws `SyncApplyError("row_filter_violation")`.
 *
 * Tombstones carry no row and pass: they are checked against local state while applying.
 */
export const assertEntitiesPublishable = (
  entities: readonly SyncEntity[],
  mode: "publish" | "apply",
): void => {
  const context: FilterContext = { terminalSessionIds: terminalSessionIdsOf(entities) };
  const sessions = sessionStates(entities);
  for (const entity of entities) {
    if (entity.row === null) continue;
    if (getTableRegistration(entity.table).rowFilter === undefined) continue;
    let ok = rowPassesFilter(entity.table, entity.row, context);
    if (
      !ok &&
      mode === "apply" &&
      entity.table === "pomodoro_segments" &&
      !sessions.has(String(entity.row.session_id))
    ) {
      ok = true; // judged against the local database while applying
    }
    if (ok) continue;
    const message = `${entity.table} ${entity.entityId} is not publishable (${getTableRegistration(entity.table).rowFilter?.localOnly})`;
    if (mode === "publish") {
      throw new Error(`Row filter breach while publishing: ${message}`);
    }
    throw new SyncApplyError(
      "row_filter_violation",
      `The bundle carries a row its table never publishes: ${message}; the whole bundle is refused`,
      { table: entity.table, entityId: entity.entityId },
    );
  }
};
