import type { Database } from "../storage/sqlite-db";
import { quoteIdent } from "./capture-install";
import { chunked, placeholders } from "./capture-stamp";
import { appendTo } from "./collections";
import { getTableRegistration, type NaturalKey } from "./registry";

/**
 * Who holds a natural key: the batched lookup behind canonical identity.
 *
 * A candidate is an id with the values it has (or would have) for the key's columns. The result says,
 * for each candidate, which OTHER ids of the table store the same key, using the key's own SQL
 * (columns from the registry, `where` of a partial index) so it agrees with the unique index.
 * A key with a NULL part never collides (NULLs are distinct in a unique index) and is skipped.
 * Only bare-column keys are supported; the engine resolves nothing else by alias.
 */

export interface KeyCandidate {
  entityId: string;
  values: readonly unknown[];
}

const PARAMETER_BUDGET = 400;

const tupleKey = (values: readonly unknown[]): string => JSON.stringify(values);

export const findKeyHolders = async (
  db: Database,
  table: string,
  key: NaturalKey,
  candidates: readonly KeyCandidate[],
): Promise<Map<string, string[]>> => {
  const primaryKey = getTableRegistration(table).primaryKey;
  if (primaryKey.length !== 1) {
    throw new Error(`"${table}" has a composite primary key; it cannot be aliased`);
  }
  const columns = key.columns.map((column) => quoteIdent(column));
  const usable = candidates.filter((candidate) =>
    candidate.values.every((value) => value !== null && value !== undefined),
  );
  const holders = new Map<string, string[]>();
  const width = columns.length;
  const predicate = key.where === undefined ? "" : `(${key.where}) AND `;

  for (const batch of chunked(usable, Math.max(1, Math.floor(PARAMETER_BUDGET / width)))) {
    const where =
      width === 1
        ? `${columns[0]} IN (${placeholders(batch.length)})`
        : `(${columns.join(", ")}) IN (VALUES ${batch
            .map((_, row) => `(${placeholders(width, row * width + 1)})`)
            .join(", ")})`;
    const rows = await db.select<Record<string, unknown>[]>(
      `SELECT ${quoteIdent(primaryKey[0] as string)} AS holder_id, ${columns
        .map((column, index) => `${column} AS k${index}`)
        .join(", ")} FROM ${quoteIdent(table)} WHERE ${predicate}${where}`,
      batch.flatMap((candidate) => [...candidate.values]),
    );
    const byTuple = new Map<string, string[]>();
    for (const row of rows) {
      const tuple = tupleKey(columns.map((_, index) => row[`k${index}`]));
      appendTo(byTuple, tuple, String(row.holder_id));
    }
    for (const candidate of batch) {
      const others = (byTuple.get(tupleKey(candidate.values)) ?? []).filter(
        (id) => id !== candidate.entityId,
      );
      if (others.length > 0) holders.set(candidate.entityId, others.sort());
    }
  }
  return holders;
};
