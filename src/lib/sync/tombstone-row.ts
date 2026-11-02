import { canonicalJson, getOwn, setOwn } from "./field-clocks";

/**
 * The values a tombstone carries (pure helpers, no SQL).
 *
 * A tombstone of a FIELD-CLOCK entity keeps the deleted row as its raw column values (the same shape
 * as a live row of a change set: text, finite number or `null` by column name) in
 * `sync_entity_meta.deleted_row_json` and in `SyncEntity.deletedRow`. Together with the field clocks the
 * tombstone already kept, that is the whole state of the entity at its delete, so a resurrection or a
 * second tombstone can join it field by field instead of forgetting it (see `merge-entity.ts`).
 *
 * `null` / absent means the values are UNKNOWN: a tombstone written before migration 48, one from a
 * peer on the first bundle format, a row that was never stamped, or a join of tombstones one of
 * which lacked values for something the other could not vouch for. Unknown is always safe: it is
 * what every tombstone meant before values existed.
 */

export type TombstoneRow = Record<string, unknown>;

const isCell = (value: unknown): boolean =>
  value === null ||
  typeof value === "string" ||
  (typeof value === "number" && Number.isFinite(value));

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Narrows a parsed object to a row of storable cells; `null` when it is not one. */
export const asTombstoneRow = (value: unknown): TombstoneRow | null => {
  if (!isPlainRecord(value)) return null;
  const row: TombstoneRow = {};
  for (const key of Object.keys(value)) {
    const cell = getOwn(value, key);
    // SQLite hands integers back as bigint on some adapters; JSON cannot carry them.
    const narrowed = typeof cell === "bigint" ? Number(cell) : cell;
    if (!isCell(narrowed)) return null;
    setOwn<unknown>(row, key, narrowed);
  }
  return Object.keys(row).length === 0 ? null : row;
};

/** The stored `deleted_row_json` as a row, or `null` (absent, damaged or not a row: unknown). */
export const parseTombstoneRow = (json: string | null | undefined): TombstoneRow | null => {
  if (typeof json !== "string" || json.length === 0) return null;
  try {
    return asTombstoneRow(JSON.parse(json));
  } catch {
    return null;
  }
};

/** Canonical text of a row for `deleted_row_json`; `null` for no row. */
export const tombstoneRowJson = (row: TombstoneRow | null | undefined): string | null => {
  const narrowed = row === null || row === undefined ? null : asTombstoneRow(row);
  return narrowed === null ? null : canonicalJson(narrowed);
};
