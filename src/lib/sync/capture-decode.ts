import { hash128 } from "../finance/hash";
import { canonicalJson, type FieldClockSpec, type JsonRecord, setOwn } from "./field-clocks";
import { getTableRegistration } from "./registry";

/**
 * Change capture, part 2 (pure): turning a database row into the record the clock engine compares.
 *
 * Field-clock tables are decoded column by column, keyed by DATABASE COLUMN NAME (`title`,
 * `context_ids_json`, `metrics_json`), because column names are the stable names a bundle uses.
 * Clock keys are therefore `<column>` for a scalar, `<column>.<key>` for a key of a JSON-map column
 * and `<column>.<id>` for an element of an OR-set column.
 *
 * Decisions (also in docs/storage-and-backups.md):
 * - Every non-key column is an ordinary scalar, `updated_at` included. An edit that only bumps
 *   `updated_at` is a change like any other; the merge slice is expected not to report an
 *   `updated_at`-only difference as a conflict. Primary-key columns are the entity's identity, not
 *   fields, and are never clocked.
 * - A `*_json` column that is neither a map nor an OR-set (`weekly_days_json`,
 *   `ritual_checklist_json`, ...) is one atomic field compared by parsed value, so formatting
 *   differences never count as edits. Unparsable text is kept as the raw string.
 * - A registry map column whose JSON is invalid decodes as an empty map, like the row mappers do.
 *   One whose JSON has an unmergeable shape (see `FieldClockShapeError`) is demoted to an atomic
 *   scalar by the stamper rather than failing the user's write.
 * - Every other class is stamped as a whole row: the record is the raw row and only its content
 *   hash is kept.
 */

export type RawRow = Record<string, unknown>;

export interface FieldCodec {
  kind: "field";
  spec: FieldClockSpec;
  decode(row: RawRow): JsonRecord;
}

export interface RowCodec {
  kind: "row";
  decode(row: RawRow): JsonRecord;
}

export type EntityCodec = FieldCodec | RowCodec;

const parseJsonOrUndefined = (value: unknown): unknown => {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

/** Content hash of a decoded record or raw row (128-bit; `src/lib/hash.ts` is only 32-bit). */
export const contentHash = (record: JsonRecord): string => hash128(canonicalJson(record));

/** Spec of a field-clock table: map and set columns from the registry, everything else scalar. */
export const fieldClockSpecFor = (table: string, columns: readonly string[]): FieldClockSpec => {
  const registration = getTableRegistration(table);
  const keyColumns = new Set(registration.primaryKey);
  const maps = (registration.jsonMapColumns ?? []).filter((column) => columns.includes(column));
  const sets = (registration.orSetColumns ?? []).filter((column) => columns.includes(column));
  const special = new Set([...maps, ...sets]);
  return {
    scalars: columns.filter((column) => !keyColumns.has(column) && !special.has(column)),
    maps,
    sets,
  };
};

export const buildEntityCodec = (table: string, columns: readonly string[]): EntityCodec => {
  const registration = getTableRegistration(table);
  if (registration.mergeClass !== "field-clock") {
    return {
      kind: "row",
      decode: (row) => {
        const record: JsonRecord = {};
        for (const column of columns) {
          setOwn<unknown>(record, column, row[column] ?? null);
        }
        return record;
      },
    };
  }
  const spec = fieldClockSpecFor(table, columns);
  const maps = new Set(spec.maps);
  const sets = new Set(spec.sets);
  const fields = [...(spec.scalars ?? []), ...(spec.maps ?? []), ...(spec.sets ?? [])];
  return {
    kind: "field",
    spec,
    decode: (row) => {
      const record: JsonRecord = {};
      for (const column of fields) {
        const raw = row[column] ?? null;
        if (maps.has(column)) {
          const parsed = parseJsonOrUndefined(raw);
          setOwn<unknown>(record, column, parsed === undefined ? null : parsed);
        } else if (sets.has(column)) {
          const parsed = parseJsonOrUndefined(raw);
          setOwn<unknown>(
            record,
            column,
            Array.isArray(parsed) ? parsed.filter((id) => typeof id === "string") : [],
          );
        } else if (column.endsWith("_json")) {
          const parsed = parseJsonOrUndefined(raw);
          setOwn<unknown>(record, column, parsed === undefined ? raw : parsed);
        } else {
          setOwn<unknown>(record, column, raw);
        }
      }
      return record;
    },
  };
};
