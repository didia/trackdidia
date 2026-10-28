import type { Database } from "../storage/sqlite-db";
import type { SyncBackfillLimits } from "./backfill-state";
import {
  assertRegistryMatchesSchema,
  captureTriggerTables,
  capturedTables,
  type LiveTableSchema,
  quoteIdent,
  readLiveSchema,
  SETTINGS_TABLE,
} from "./capture-install";
import { chunked, fetchRows, placeholders, stampDirtyEntities } from "./capture-stamp";
import { ensureInstanceOccurrences } from "./capture-recurrence";
import { createHlcBatch, SyncClockError } from "./clock-store";
import { entityIdOf, parseEntityId, type PrimaryKeyValue } from "./entity-id";

/**
 * The self-healing capture scan, as bounded slices. Marks the rows of one step, stamps them through
 * the normal path (`stampDirtyEntities`), and tells the caller where to resume, so the repository
 * can run it as many short writer slots and persist the cursor between them.
 *
 * Steps, in a fixed order (the cursor names the step, so a changed registry restarts a pass instead
 * of resuming at a wrong place):
 * - `rows:<table>`: every row of a captured table, by primary key; a row with no live clock row is
 *   stamped as a creation, and in `verify` mode every row is re-compared with its stored snapshot;
 * - `meta:<table>`: every live clock row, by entity id; one whose row is gone is tombstoned (a delete
 *   no trigger saw, such as the victim of `INSERT OR REPLACE` on a non-key unique conflict);
 * - `settings`: the settings blob (its synced keys that differ from their baseline);
 * - `occurrences`: recurring instances stamped before the occurrence sidecars existed get their
 *   baseline record.
 *
 * What makes it safe to interleave with the user's own edits: a mark only says "look at this row".
 * The stamper compares the live row with the stored snapshot and writes nothing when they agree, so
 * an entity the normal path already stamped (created, edited, deleted) is left alone and a newer
 * clock or snapshot is never overwritten. A row inserted ahead of the cursor is stamped by the normal
 * path at its own commit and found stamped by the scan; one behind the cursor never needs the scan.
 *
 * NULL-keyed rows (`gtd_contexts.id` is a nullable TEXT key) cannot be addressed and are skipped.
 */

export interface BackfillCursor {
  step: string;
  /** The last primary key (or entity id) handled in the step; `null` = start of the step. */
  key: PrimaryKeyValue[] | null;
}

export const OCCURRENCES_STEP = "occurrences";
export const SETTINGS_STEP = "settings";

const ROWS_PREFIX = "rows:";
const META_PREFIX = "meta:";

export const backfillSteps = (): string[] => [
  ...capturedTables().flatMap((entry) => [
    `${ROWS_PREFIX}${entry.table}`,
    `${META_PREFIX}${entry.table}`,
  ]),
  SETTINGS_STEP,
  OCCURRENCES_STEP,
];

/** The cursor persisted as `step` + `cursor_key`; `null` when it names no step of this build. */
export const decodeCursor = (step: string, cursorKey: string | null): BackfillCursor | null => {
  if (step === "") return null;
  if (!backfillSteps().includes(step)) return null;
  if (cursorKey === null) return { step, key: null };
  try {
    const parsed: unknown = JSON.parse(cursorKey);
    if (
      Array.isArray(parsed) &&
      parsed.every(
        (part) => typeof part === "string" || (typeof part === "number" && Number.isFinite(part)),
      )
    ) {
      return { step, key: parsed as PrimaryKeyValue[] };
    }
  } catch {
    /* fall through: the step restarts from its beginning */
  }
  return { step, key: null };
};

export interface BackfillSliceOptions {
  /** Re-check rows that already have a clock row (needed when capture was off for a while). */
  verify: boolean;
  limits: SyncBackfillLimits;
}

export interface BackfillSliceOutcome {
  /** Where to resume; `null` once every step is done. */
  next: BackfillCursor | null;
  /** Rows and clock rows looked at. */
  scanned: number;
  /** Entities stamped (the occurrence baseline counts as one, like the old whole-database scan). */
  stamped: number;
  /** Statements the slice issued, stamping included. */
  statements: number;
}

const keyExpression = (alias: string, primaryKey: readonly string[]): string =>
  primaryKey.length === 1
    ? `CAST(${alias}."${primaryKey[0]}" AS TEXT)`
    : `json_array(${primaryKey.map((column) => `${alias}."${column}"`).join(", ")})`;

/** A `Database` that counts the statements run through it. */
const counting = (db: Database): { db: Database; count: () => number } => {
  let statements = 0;
  return {
    db: {
      execute: (query, values) => {
        statements += 1;
        return db.execute(query, values);
      },
      select: <T>(query: string, values?: unknown[]) => {
        statements += 1;
        return db.select<T>(query, values);
      },
    },
    count: () => statements,
  };
};

const MARK_BATCH = 150;

const insertMarks = async (
  db: Database,
  table: string,
  marks: readonly { id: string; op: "upsert" | "delete" }[],
): Promise<void> => {
  for (const batch of chunked(marks, MARK_BATCH)) {
    const values = batch.map((_, index) => `($1, $${index * 2 + 2}, $${index * 2 + 3})`).join(", ");
    await db.execute(
      `INSERT OR REPLACE INTO sync_dirty (entity_type, entity_id, op) VALUES ${values}`,
      [table, ...batch.flatMap((mark) => [mark.id, mark.op])],
    );
  }
};

const rowsStep = async (
  db: Database,
  table: string,
  live: LiveTableSchema,
  after: PrimaryKeyValue[] | null,
  limit: number,
  verify: boolean,
): Promise<{ scanned: number; last: PrimaryKeyValue[] | null; exhausted: boolean }> => {
  assertRegistryMatchesSchema(table, live);
  const primaryKey = live.primaryKey;
  const columns = primaryKey.map((column) => `t.${quoteIdent(column)}`);
  const conditions = columns.map((column) => `${column} IS NOT NULL`);
  const params: unknown[] = [];
  if (after !== null) {
    params.push(...after);
    conditions.push(
      columns.length === 1
        ? `${columns[0]} > $1`
        : `(${columns.join(", ")}) > (${placeholders(columns.length)})`,
    );
  }
  if (!verify) {
    // Correlated lookup on the clock table's primary key: not a subquery that is rebuilt per slice.
    conditions.push(
      `NOT EXISTS (SELECT 1 FROM sync_entity_meta m WHERE m.entity_type = '${table}'
         AND m.entity_id = ${keyExpression("t", primaryKey)} AND m.deleted_at IS NULL)`,
    );
  }
  const found = await db.select<Record<string, PrimaryKeyValue>[]>(
    `SELECT ${keyExpression("t", primaryKey)} AS __id,
            ${columns.map((column, index) => `${column} AS __k${index}`).join(", ")}
     FROM ${quoteIdent(table)} t WHERE ${conditions.join(" AND ")}
     ORDER BY ${columns.join(", ")} LIMIT ${Math.max(1, Math.floor(limit))}`,
    params,
  );
  await insertMarks(
    db,
    table,
    found.map((row) => ({ id: String(row.__id), op: "upsert" })),
  );
  const lastRow = found[found.length - 1];
  return {
    scanned: found.length,
    last: lastRow ? primaryKey.map((_, index) => lastRow[`__k${index}`] as PrimaryKeyValue) : after,
    exhausted: found.length < Math.max(1, Math.floor(limit)),
  };
};

const metaStep = async (
  db: Database,
  table: string,
  live: LiveTableSchema,
  after: PrimaryKeyValue[] | null,
  limit: number,
): Promise<{ scanned: number; last: PrimaryKeyValue[] | null; exhausted: boolean }> => {
  assertRegistryMatchesSchema(table, live);
  const size = Math.max(1, Math.floor(limit));
  const ids = await db.select<{ entity_id: string }[]>(
    `SELECT entity_id FROM sync_entity_meta
     WHERE entity_type = $1 AND deleted_at IS NULL ${after === null ? "" : "AND entity_id > $2"}
     ORDER BY entity_id LIMIT ${size}`,
    after === null ? [table] : [table, after[0]],
  );
  const present = new Set<string>();
  const keys: PrimaryKeyValue[][] = [];
  for (const { entity_id } of ids) {
    const key = parseEntityId(table, entity_id);
    if (key !== null) keys.push(key);
  }
  for (const batch of chunked(keys, 200)) {
    for (const row of await fetchRows(db, table, live.primaryKey, batch)) {
      try {
        present.add(
          entityIdOf(
            table,
            live.primaryKey.map((column) => row[column]),
          ),
        );
      } catch {
        /* a row with a NULL key cannot be addressed */
      }
    }
  }
  // A clock row whose entity id is not a valid key of the table carries nothing to stamp.
  const gone = keys.map((key) => entityIdOf(table, key)).filter((id) => !present.has(id));
  await insertMarks(
    db,
    table,
    gone.map((id) => ({ id, op: "delete" })),
  );
  const lastId = ids[ids.length - 1]?.entity_id;
  return {
    scanned: ids.length,
    last: lastId === undefined ? after : [lastId],
    exhausted: ids.length < size,
  };
};

/**
 * Runs one bounded slice of the scan inside the caller's open write transaction. Starts at `from`
 * (`null` = the beginning) and ends when `limits.rowsPerChunk` rows were looked at, when the scan
 * part issued `limits.statementsPerChunk` statements, or when every step is done. Requires the sync
 * identity (the stamper issues clocks).
 */
export const runBackfillSlice = async (
  raw: Database,
  nowMs: number,
  from: BackfillCursor | null,
  options: BackfillSliceOptions,
): Promise<BackfillSliceOutcome> => {
  const identity = await raw.select<{ id: number }[]>("SELECT id FROM sync_identity WHERE id = 1");
  if (identity.length === 0) {
    throw new SyncClockError(
      "identity_missing",
      "Multi-device sync identity has not been created on this device",
    );
  }
  const { db, count } = counting(raw);
  const steps = backfillSteps();
  const occurrencesIndex = steps.indexOf(OCCURRENCES_STEP);
  const schema = await readLiveSchema(db, captureTriggerTables());
  let index = Math.max(0, from === null ? 0 : steps.indexOf(from.step));
  let key = from === null || steps[index] !== from.step ? null : from.key;
  let scanned = 0;

  // At least one step per slice, whatever the statement budget: a slice must always make progress.
  let first = true;
  while (
    index < occurrencesIndex &&
    (first ||
      (scanned < options.limits.rowsPerChunk && count() < options.limits.statementsPerChunk))
  ) {
    first = false;
    const step = steps[index] as string;
    const room = options.limits.rowsPerChunk - scanned;
    if (step === SETTINGS_STEP) {
      await db.execute(
        `INSERT OR REPLACE INTO sync_dirty (entity_type, entity_id, op)
         SELECT '${SETTINGS_TABLE}', CAST(id AS TEXT), 'upsert' FROM app_settings`,
      );
      scanned += 1;
      index += 1;
      key = null;
      continue;
    }
    const isRows = step.startsWith(ROWS_PREFIX);
    const table = step.slice(isRows ? ROWS_PREFIX.length : META_PREFIX.length);
    const live = schema.get(table) as LiveTableSchema;
    const result = isRows
      ? await rowsStep(db, table, live, key, room, options.verify)
      : await metaStep(db, table, live, key, room);
    scanned += result.scanned;
    if (result.exhausted) {
      index += 1;
      key = null;
    } else {
      key = result.last;
    }
  }

  // The stamper drains every mark above, in this same transaction.
  let stamped = await stampDirtyEntities(db, nowMs);
  if (index === occurrencesIndex) {
    // Recurring instances stamped before the occurrence sidecars existed (or while capture was
    // off) get their baseline record. Idle when every instance already has one.
    const issuer = createHlcBatch(db, nowMs);
    const baselined = await ensureInstanceOccurrences(db, () => issuer.next());
    if (baselined > 0) {
      await issuer.flush();
      await db.execute("UPDATE sync_identity SET change_counter = change_counter + 1 WHERE id = 1");
      stamped += 1;
    }
    index += 1;
    key = null;
  }
  const finished = index >= steps.length;
  return {
    next: finished ? null : { step: steps[index] as string, key },
    scanned,
    stamped,
    statements: count(),
  };
};

/**
 * The whole scan in the caller's transaction, with no chunk limit: the old single-transaction
 * behaviour, kept for tests and for callers that already hold a write transaction. Idempotent. Returns
 * the number of stamped entities (also added to `change_counter`).
 */
export const backfillSyncCapture = async (
  db: Database,
  nowMs: number,
  options: { verify?: boolean } = {},
): Promise<number> => {
  let cursor: BackfillCursor | null = null;
  let stamped = 0;
  for (;;) {
    const slice: BackfillSliceOutcome = await runBackfillSlice(db, nowMs, cursor, {
      verify: options.verify === true,
      limits: {
        rowsPerChunk: Number.MAX_SAFE_INTEGER,
        statementsPerChunk: Number.MAX_SAFE_INTEGER,
      },
    });
    stamped += slice.stamped;
    if (slice.next === null) return stamped;
    cursor = slice.next;
  }
};
