import type { Database } from "../storage/sqlite-db";
import { type AliasRecord, AliasIndex } from "./aliases";
import { chunked, placeholders } from "./capture-stamp";
import { isValidHlc } from "./hlc";
import { isAliasableTable } from "./registry";

/**
 * `sync_id_aliases` on disk: loading the alias classes, persisting what a merge learned and the
 * single-id lookup. The classes themselves live in `aliases.ts`.
 *
 * The table is grow-only: a row is only inserted or moved to a smaller canonical id / a later
 * clock, never deleted. Rows that are not valid (an unknown or non-aliasable type, a malformed
 * clock, an id that is its own alias) are ignored when loading, so a damaged row can neither crash a
 * merge nor spread through a bundle.
 */

interface AliasRow {
  entity_type: string;
  alias_id: string;
  canonical_id: string;
  recorded_hlc: string;
}

const recordOf = (row: AliasRow): AliasRecord => ({
  entityType: row.entity_type,
  aliasId: row.alias_id,
  canonicalId: row.canonical_id,
  recordedHlc: row.recorded_hlc,
});

const isUsable = (row: AliasRow): boolean =>
  isAliasableTable(row.entity_type) &&
  typeof row.alias_id === "string" &&
  row.alias_id.length > 0 &&
  typeof row.canonical_id === "string" &&
  row.canonical_id.length > 0 &&
  row.alias_id !== row.canonical_id &&
  isValidHlc(row.recorded_hlc);

export const loadAliasRecords = async (db: Database): Promise<AliasRecord[]> => {
  const rows = await db.select<AliasRow[]>(
    "SELECT entity_type, alias_id, canonical_id, recorded_hlc FROM sync_id_aliases",
  );
  return rows.filter(isUsable).map(recordOf);
};

/** The alias classes stored here, plus the rows as stored (to persist only what changed). */
export interface LoadedAliases {
  index: AliasIndex;
  stored: ReadonlyMap<string, AliasRecord>;
}

const storedKey = (entityType: string, aliasId: string): string => `${entityType}\u0000${aliasId}`;

export const loadAliases = async (db: Database): Promise<LoadedAliases> => {
  const records = await loadAliasRecords(db);
  return {
    index: new AliasIndex(records),
    stored: new Map(
      records.map((record) => [storedKey(record.entityType, record.aliasId), record]),
    ),
  };
};

/**
 * Writes every row of `index` that differs from `stored` (a new alias, a member that now points at a
 * smaller root, a later class clock). Idempotent: a second call with the same state writes nothing.
 * Returns the number of rows written.
 */
export const persistAliases = async (db: Database, loaded: LoadedAliases): Promise<number> => {
  const changed = loaded.index.records().filter((record) => {
    const before = loaded.stored.get(storedKey(record.entityType, record.aliasId));
    return (
      before === undefined ||
      before.canonicalId !== record.canonicalId ||
      before.recordedHlc !== record.recordedHlc
    );
  });
  for (const batch of chunked(changed, 100)) {
    const values = batch.map((_, row) => `(${placeholders(4, row * 4 + 1)})`).join(", ");
    await db.execute(
      `INSERT OR REPLACE INTO sync_id_aliases (entity_type, alias_id, canonical_id, recorded_hlc)
       VALUES ${values}`,
      batch.flatMap((record) => [
        record.entityType,
        record.aliasId,
        record.canonicalId,
        record.recordedHlc,
      ]),
    );
  }
  for (const record of changed) {
    (loaded.stored as Map<string, AliasRecord>).set(
      storedKey(record.entityType, record.aliasId),
      record,
    );
  }
  return changed.length;
};

/**
 * The canonical id of `id`: what its alias class resolves to, or `id` itself when it is not an
 * alias. For code that reads an id out of a payload that predates an alias (an AI proposal's
 * `taskId` in a message written before the rewrite, a stale UI state): rows are stored
 * path-compressed, so one lookup is enough, and a damaged chain is followed for a few hops at most.
 */
export const resolveAlias = async (
  db: Database,
  entityType: string,
  id: string,
): Promise<string> => {
  let current = id;
  for (let hop = 0; hop < 8; hop += 1) {
    const rows = await db.select<{ canonical_id: string }[]>(
      "SELECT canonical_id FROM sync_id_aliases WHERE entity_type = $1 AND alias_id = $2",
      [entityType, current],
    );
    const next = rows[0]?.canonical_id;
    if (next === undefined || next === current) return current;
    current = next;
  }
  return current;
};
