import type { Database } from "../storage/sqlite-db";
import type { RawRow } from "./capture-decode";
import { quoteIdent } from "./capture-install";
import { placeholders } from "./capture-stamp";
import type { ExtraConflict } from "./conflicts";
import { entityIdOf, type PrimaryKeyValue } from "./entity-id";
import { SyncApplyError } from "./errors";
import { canonicalJson, getOwn } from "./field-clocks";
import type { EntityMergeOutcome } from "./merge-entity";
import { getTableRegistration } from "./registry";
import type { TableInfo } from "./table-info";

/**
 * Pieces of the apply path shared by the entity appliers (`apply-bundle.ts`, `apply-rows.ts`,
 * `apply-proposals.ts`, `apply-references.ts`): SQL error translation, the conflict row, the
 * running totals and the generic row writer. No policy lives here.
 */

export const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The name of the unique index that covers exactly these columns of a table, when it can be found. */
const findUniqueIndex = async (
  db: Database,
  table: string,
  columns: readonly string[],
): Promise<string | null> => {
  try {
    const wanted = [...columns].sort().join(",");
    const indexes = await db.select<{ name: string }[]>(
      `SELECT name FROM pragma_index_list($1) WHERE "unique" = 1`,
      [table],
    );
    for (const index of indexes) {
      const parts = await db.select<{ name: string | null }[]>(
        "SELECT name FROM pragma_index_info($1) ORDER BY seqno",
        [index.name],
      );
      if (
        parts
          .map((part) => part.name ?? "")
          .sort()
          .join(",") === wanted
      ) {
        return index.name;
      }
    }
  } catch {
    /* naming the index is best effort */
  }
  return null;
};

/**
 * Turns a failed statement into a `SyncApplyError` that names the table and, for a unique-key
 * violation, the index. A key the registry declares as a natural key is a `natural_key_collision`:
 * the alias engine (`apply-aliases.ts`) runs first and resolves every collision it can see, so one
 * that still reaches SQL is a collision it could not resolve. Any other unique key is a
 * `unique_violation`. Never
 * swallowed: the caller rethrows, which rolls the whole bundle back.
 */
export const toSqlApplyError = async (
  db: Database,
  table: string,
  entityId: string | null,
  error: unknown,
): Promise<SyncApplyError> => {
  if (error instanceof SyncApplyError) {
    return error;
  }
  const message = messageOf(error);
  if (/UNIQUE constraint failed/i.test(message)) {
    const detail =
      message
        .slice(message.search(/UNIQUE constraint failed/i))
        .split(":")[1]
        ?.trim() ?? "";
    const named = /^index '([^']+)'/.exec(detail)?.[1] ?? null;
    const columns = named
      ? []
      : detail
          .split(",")
          .map((part) => part.trim().replace(/^[^.]+\./, ""))
          .filter((part) => part.length > 0);
    const index =
      named ?? (await findUniqueIndex(db, table, columns)) ?? (columns.join(",") || detail);
    // SQLite names the index for an expression index and the columns for a plain or partial one;
    // `index` is whichever the lookup above resolved, so a partial index (external_key) matches too.
    const declared = getTableRegistration(table).naturalKeys.find(
      (key) =>
        (key.index !== undefined && (key.index === named || key.index === index)) ||
        (columns.length > 0 &&
          key.where === undefined &&
          [...key.columns].sort().join(",") === [...columns].sort().join(",")),
    );
    return new SyncApplyError(
      declared ? "natural_key_collision" : "unique_violation",
      `${declared ? `Natural key "${declared.name}"` : "Unique key"} of "${table}" collided (${index}) while applying ${entityId ?? "a row"}; the bundle was not applied`,
      { table, entityId, index, cause: error },
    );
  }
  return new SyncApplyError("sql_error", `SQL error on "${table}": ${message}`, {
    table,
    entityId,
    cause: error,
  });
};

export interface Totals {
  applied: number;
  skipped: number;
  tombstonesApplied: number;
}

export interface PendingConflict {
  id: string;
  kind: string;
  entityType: string;
  entityId: string;
  localJson: string;
  remoteJson: string;
}

export const keyConditions = (
  primaryKey: readonly string[],
  startAt: number,
): { sql: string; next: number } => ({
  sql: primaryKey
    .map((column, index) => `${quoteIdent(column)} = $${startAt + index}`)
    .join(" AND "),
  next: startAt + primaryKey.length,
});

export const extraConflictOf = (conflict: ExtraConflict): PendingConflict => ({
  id: conflict.id,
  kind: conflict.kind,
  entityType: conflict.entityType,
  entityId: conflict.entityId,
  localJson: canonicalJson(conflict.local),
  remoteJson: canonicalJson(conflict.remote),
});

export const writeRow = async (
  db: Database,
  table: string,
  info: TableInfo,
  key: readonly PrimaryKeyValue[],
  outcome: EntityMergeOutcome,
): Promise<void> => {
  const t = quoteIdent(table);
  if (outcome.rowAction === "insert") {
    const columns = info.columns.filter((column) => Object.hasOwn(outcome.columns, column));
    await db.execute(
      `INSERT INTO ${t} (${columns.map(quoteIdent).join(", ")}) VALUES (${placeholders(columns.length)})`,
      columns.map((column) => getOwn(outcome.columns, column)),
    );
  } else if (outcome.rowAction === "update") {
    const columns = Object.keys(outcome.columns);
    const where = keyConditions(info.primaryKey, columns.length + 1);
    await db.execute(
      `UPDATE ${t} SET ${columns.map((column, index) => `${quoteIdent(column)} = $${index + 1}`).join(", ")} WHERE ${where.sql}`,
      [...columns.map((column) => getOwn(outcome.columns, column)), ...key],
    );
  } else if (outcome.rowAction === "delete") {
    await db.execute(`DELETE FROM ${t} WHERE ${keyConditions(info.primaryKey, 1).sql}`, [...key]);
  }
};

/**
 * True for an outcome that only moves `planned_order` of an existing task: what the Planned queue
 * repair stages for the receiver's own rows (no clock, no meta, no conflict). Many of them are
 * written as a few statements by {@link writePlannedOrders} instead of one each.
 */
export const isPlannedOrderOnly = (
  table: string,
  info: TableInfo,
  outcome: EntityMergeOutcome,
): boolean => {
  if (table !== "gtd_tasks" || info.primaryKey.length !== 1 || info.primaryKey[0] !== "id") {
    return false;
  }
  const columns = Object.keys(outcome.columns);
  return (
    outcome.rowAction === "update" &&
    columns.length === 1 &&
    columns[0] === "planned_order" &&
    !outcome.metaChanged &&
    !outcome.tombstoneApplied &&
    outcome.overwritten.length === 0
  );
};

/** Rows one {@link writePlannedOrders} statement carries (3 variables each, well under any limit). */
const PLANNED_ORDER_BATCH = 250;

/**
 * Writes `planned_order` for many tasks of one table with one statement per
 * {@link PLANNED_ORDER_BATCH} rows. The result is the same as one `UPDATE` per row; only the number
 * of statements (and so of writer-slot round trips) differs: a queue of 5,000 tasks renumbered by
 * one incoming task costs 20 statements instead of 5,000.
 */
export const writePlannedOrders = async (
  db: Database,
  table: string,
  rows: readonly { id: string; order: unknown }[],
): Promise<void> => {
  const t = quoteIdent(table);
  for (let start = 0; start < rows.length; start += PLANNED_ORDER_BATCH) {
    const batch = rows.slice(start, start + PLANNED_ORDER_BATCH);
    const cases = batch
      .map((_, index) => `WHEN $${index * 3 + 1} THEN $${index * 3 + 2}`)
      .join(" ");
    const ids = batch.map((_, index) => `$${index * 3 + 3}`).join(", ");
    await db.execute(
      `UPDATE ${t} SET "planned_order" = CASE "id" ${cases} END WHERE "id" IN (${ids})`,
      batch.flatMap((row) => [row.id, row.order, row.id]),
    );
  }
};

export const rowsById = (
  table: string,
  info: TableInfo,
  rows: readonly RawRow[],
): Map<string, RawRow> => {
  const byId = new Map<string, RawRow>();
  for (const row of rows) {
    try {
      byId.set(
        entityIdOf(
          table,
          info.primaryKey.map((column) => row[column]),
        ),
        row,
      );
    } catch {
      /* a row with a NULL key cannot be addressed */
    }
  }
  return byId;
};
