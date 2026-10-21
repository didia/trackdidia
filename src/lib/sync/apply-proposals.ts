import type { Database } from "../storage/sqlite-db";
import type { RawRow } from "./capture-decode";
import { contentHash, type RowCodec } from "./capture-decode";
import { quoteIdent } from "./capture-install";
import { fetchMeta, fetchRows, writeOutcome, emptyOutcome } from "./capture-stamp";
import { type ExtraConflict, pendingCollisionId } from "./conflicts";
import { entityIdOf, type PrimaryKeyValue } from "./entity-id";
import { setOwn } from "./field-clocks";
import { keepsPending, type PendingContender } from "./merge-proposal";
import type { RowMergeOutcome } from "./merge-row";
import { getTableRegistration, type NaturalKey } from "./registry";
import { keyConditions } from "./apply-support";
import type { TableInfo } from "./table-info";

/**
 * One pending `ai_proposals` row per natural key, without the alias engine.
 *
 * The registry declares two partial unique indexes on pending proposals (one per message and type,
 * one per message and goal). Two laptops that each create a pending proposal for the same message
 * and type produce two rows that cannot both be stored as pending. This module keeps the bundle
 * from aborting and makes every replica end in the same state:
 *
 * - the contenders are the incoming row (after its own merge) and every OTHER stored pending row
 *   that shares a declared pending key with it (found with the index's own `where` and key
 *   expressions, read from the registry, never re-implemented);
 * - the contender with the later row clock (then the greater id) keeps `pending` ({@link keepsPending});
 * - every other contender becomes `expired`, keeping its id, its clock and every other column. It is
 *   stored, not dropped, so all replicas hold the same set of rows. An expired row beats a pending
 *   one in every later merge (terminal beats pending), so a replica that still holds the loser as
 *   pending converges to expired as soon as it hears of it, whichever order things arrive in.
 * - an informational `pending_collision` conflict (deterministic id per loser and winner) records it.
 *
 * Any OTHER unique violation still aborts the bundle with the typed error of `apply-support.ts`.
 */

export const PENDING_STATUS = "pending";
export const EXPIRED_STATUS = "expired";

const pendingKeys = (table: string): NaturalKey[] =>
  getTableRegistration(table).naturalKeys.filter(
    (key) => key.where !== undefined && key.index !== undefined,
  );

interface KeyProbe {
  key: NaturalKey;
  values: unknown[];
}

/** Evaluates the key expressions of every pending key on a row that is not stored yet. */
const probeKeys = async (
  db: Database,
  table: string,
  info: TableInfo,
  row: RawRow,
): Promise<KeyProbe[]> => {
  const probes: KeyProbe[] = [];
  const source = `(SELECT ${info.columns.map((column, index) => `$${index + 1} AS ${quoteIdent(column)}`).join(", ")})`;
  const params = info.columns.map((column) => row[column] ?? null);
  for (const key of pendingKeys(table)) {
    const select = [`(${key.where}) AS applies`, ...key.columns.map((c, i) => `${c} AS k${i}`)];
    const found = await db.select<Record<string, unknown>[]>(
      `SELECT ${select.join(", ")} FROM ${source}`,
      params,
    );
    const result = found[0];
    if (!result?.applies) continue;
    const values = key.columns.map((_, i) => result[`k${i}`]);
    // NULLs are distinct in a unique index: a key with a NULL part never collides.
    if (values.some((value) => value === null || value === undefined)) continue;
    probes.push({ key, values });
  }
  return probes;
};

export interface PendingOutcome {
  /** Stored pending rows to expire before the incoming row is written. */
  demote: { id: string; row: RawRow }[];
  /** The incoming row itself must be stored as expired. */
  expireIncoming: boolean;
  conflicts: ExtraConflict[];
}

const NOTHING: PendingOutcome = { demote: [], expireIncoming: false, conflicts: [] };

export const resolvePendingKeys = async (
  db: Database,
  table: string,
  info: TableInfo,
  merged: RowMergeOutcome,
  entityId: string,
): Promise<PendingOutcome> => {
  const row = merged.finalRow;
  if (row === null || merged.meta.deletedAt !== null || row.status !== PENDING_STATUS) {
    return NOTHING;
  }
  const own = parseOwnKey(info, row);
  const contenders = new Map<string, { row: RawRow; clock: string | null }>();
  for (const probe of await probeKeys(db, table, info, row)) {
    const same = probe.key.columns.map((c, i) => `${c} = $${i + 1}`).join(" AND ");
    const notSelf = keyConditions(info.primaryKey, probe.values.length + 1);
    const rows = await db.select<RawRow[]>(
      `SELECT * FROM ${quoteIdent(table)} WHERE (${probe.key.where}) AND ${same} AND NOT (${notSelf.sql})`,
      [...probe.values, ...own],
    );
    for (const other of rows) {
      const id = entityIdOf(
        table,
        info.primaryKey.map((column) => other[column]),
      );
      contenders.set(id, { row: other, clock: null });
    }
  }
  if (contenders.size === 0) return NOTHING;

  const metas = await fetchMeta(db, table, [...contenders.keys()]);
  for (const [id, contender] of contenders) {
    const meta = metas.get(id);
    contender.clock = meta && meta.deleted_at === null ? meta.row_hlc : null;
  }
  const self: PendingContender = { id: entityId, clock: merged.meta.rowHlc };
  const others: (PendingContender & { row: RawRow })[] = [...contenders].map(([id, value]) => ({
    id,
    clock: value.clock,
    row: value.row,
  }));
  let winner: PendingContender = self;
  for (const other of others) {
    if (keepsPending(other, winner) > 0) winner = other;
  }
  const conflicts: ExtraConflict[] = [];
  const lose = (loserId: string, loserRow: RawRow): void => {
    conflicts.push({
      id: pendingCollisionId(table, loserId, winner.id),
      kind: "pending_collision",
      entityType: table,
      entityId: loserId,
      local: { expired: loserId, kept: winner.id },
      remote: { type: loserRow.type, messageId: loserRow.message_id },
    });
  };
  const demote = others
    .filter((other) => other.id !== winner.id)
    .map((other) => ({ id: other.id, row: other.row }));
  for (const loser of demote) lose(loser.id, loser.row);
  const expireIncoming = winner.id !== entityId;
  if (expireIncoming) lose(entityId, row);
  return { demote, expireIncoming, conflicts };
};

const parseOwnKey = (info: TableInfo, row: RawRow): PrimaryKeyValue[] =>
  info.primaryKey.map((column) => row[column] as PrimaryKeyValue);

/** Marks the incoming outcome as an expired proposal: its row, and the columns that get written. */
export const expireIncoming = (merged: RowMergeOutcome): void => {
  if (merged.finalRow === null) return;
  merged.finalRow = { ...merged.finalRow, status: EXPIRED_STATUS };
  setOwn(merged.columns, "status", EXPIRED_STATUS);
  if (merged.rowAction === "none") merged.rowAction = "update";
};

/**
 * Expires stored pending rows: row updated, snapshot hash refreshed, meta untouched (the loser keeps
 * the clock it had; no clock is issued while applying).
 */
export const demoteStored = async (
  db: Database,
  table: string,
  info: TableInfo,
  codec: RowCodec,
  demote: readonly { id: string; row: RawRow }[],
): Promise<void> => {
  for (const loser of demote) {
    const key = info.primaryKey.map((column) => loser.row[column] as PrimaryKeyValue);
    await db.execute(
      `UPDATE ${quoteIdent(table)} SET ${quoteIdent("status")} = $1 WHERE ${keyConditions(info.primaryKey, 2).sql}`,
      [EXPIRED_STATUS, ...key],
    );
    const stored = (await fetchRows(db, table, info.primaryKey, [key]))[0];
    if (stored === undefined) continue;
    const outcome = emptyOutcome();
    outcome.snapshotWrites.push({
      entityId: loser.id,
      snapshotJson: null,
      contentHash: contentHash(codec.decode(stored)),
    });
    await writeOutcome(db, table, outcome);
  }
};
