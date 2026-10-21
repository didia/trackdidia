import type { Database } from "../storage/sqlite-db";
import { assertRegistryMatchesSchema } from "./capture-install";

/** Live shape of one table, read from `pragma_table_info`. */
export interface TableInfo {
  /** Column names in declaration order. */
  columns: string[];
  /** Primary-key columns in key order. */
  primaryKey: string[];
  /** Columns declared NOT NULL. */
  notNull: ReadonlySet<string>;
}

interface ColumnRow {
  name: string;
  not_null: number;
  pk: number;
}

/**
 * Reads the live columns of a registry table and checks its primary key against the registry (the
 * contract entity ids rely on). Throws when the table does not exist or the keys disagree.
 */
export const readTableInfo = async (db: Database, table: string): Promise<TableInfo> => {
  const rows = await db.select<ColumnRow[]>(
    `SELECT name, "notnull" AS not_null, pk FROM pragma_table_info($1) ORDER BY cid`,
    [table],
  );
  const columns = rows.map((row) => row.name);
  const primaryKey = rows
    .filter((row) => row.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((row) => row.name);
  assertRegistryMatchesSchema(table, { columns, primaryKey });
  return {
    columns,
    primaryKey,
    notNull: new Set(rows.filter((row) => Number(row.not_null) === 1).map((row) => row.name)),
  };
};

/** A stored value as a change-set cell: SQLite integers may arrive as bigint. */
export const toRowCell = (value: unknown): unknown =>
  typeof value === "bigint" ? Number(value) : value;

/** A stored row as a change-set row (same keys, bigint narrowed). */
export const toSyncRow = (row: Record<string, unknown>): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(row)) {
    Object.defineProperty(result, key, {
      value: toRowCell(row[key]),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
};
