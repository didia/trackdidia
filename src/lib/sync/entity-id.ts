import { getTableRegistration } from "./registry";

/**
 * The canonical text key of a synced row, used by `sync_entity_meta`, `sync_entity_snapshot` and
 * `sync_dirty` as `entity_id` (next to `entity_type` = the table name).
 *
 * Encoding, decided once here:
 * - single-column primary key: the value as text (`id` -> `"task-1"`, `date` -> `"2026-03-31"`);
 * - composite primary key: a JSON array of the key values in registry order, strings as strings
 *   and integers as numbers (`finance_merchant_memory` -> `["cafe","acc-1",-1]`).
 *
 * The capture triggers build the same text in SQL (`CAST(NEW.id AS TEXT)` and
 * `json_array(NEW.a, NEW.b)`), so a trigger-written `sync_dirty.entity_id` and a TS-built meta key
 * are the same string. `JSON.stringify` and SQLite's `json_array` agree on every string SQLite can
 * store (both escape `"`, `\` and control characters identically and leave everything else as is);
 * `entity-id.test.ts` checks that against a real SQLite for awkward values. The stamper never
 * depends on it: it parses every dirty mark back to key values and re-encodes them here.
 */
export type PrimaryKeyValue = string | number;

const isKeyValue = (value: unknown): value is PrimaryKeyValue =>
  typeof value === "string" || (typeof value === "number" && Number.isFinite(value));

/** Encodes primary-key values (registry column order) into the canonical entity id. */
export const entityIdOf = (table: string, pkValues: readonly unknown[]): string => {
  const { primaryKey } = getTableRegistration(table);
  if (pkValues.length !== primaryKey.length) {
    throw new Error(
      `Table "${table}" has a ${primaryKey.length}-column primary key, got ${pkValues.length} value(s)`,
    );
  }
  if (!pkValues.every(isKeyValue)) {
    throw new Error(`Table "${table}": primary key values must be strings or finite numbers`);
  }
  return primaryKey.length === 1 ? String(pkValues[0]) : JSON.stringify(pkValues);
};

/**
 * Decodes an entity id back to primary-key values, or `null` when it is not a valid id of
 * `table` (a corrupt or foreign mark). Single-column keys decode to one string.
 */
export const parseEntityId = (table: string, entityId: unknown): PrimaryKeyValue[] | null => {
  if (typeof entityId !== "string") {
    return null;
  }
  const { primaryKey } = getTableRegistration(table);
  if (primaryKey.length === 1) {
    return [entityId];
  }
  try {
    const parsed: unknown = JSON.parse(entityId);
    if (Array.isArray(parsed) && parsed.length === primaryKey.length && parsed.every(isKeyValue)) {
      return parsed;
    }
  } catch {
    /* not JSON: fall through */
  }
  return null;
};
