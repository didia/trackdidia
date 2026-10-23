import type { Database } from "../storage/sqlite-db";
import { buildEntityCodec, contentHash, type RawRow } from "./capture-decode";
import { fetchSplitsOf, splitSnapshotJson, unitSnapshotJson } from "./capture-finance";
import { isCapturedTable } from "./capture-install";
import {
  chunked,
  emptyOutcome,
  fetchMeta,
  fetchRows,
  fetchSnapshots,
  writeOutcome,
} from "./capture-stamp";
import { entityIdOf, parseEntityId, type PrimaryKeyValue } from "./entity-id";
import { canonicalJson } from "./field-clocks";
import { FINANCE_SPLITS, FINANCE_TRANSACTIONS, unitSignature } from "./merge-finance";
import { readTableInfo } from "./table-info";

/**
 * Brings the `sync_entity_snapshot` of rows the alias engine rewrote in place back to what the
 * capture stamper would store for them, so a verifying scan restamps nothing.
 *
 * The engine rewrites references (a task's `project_id`, a split's `transaction_id`, an account id
 * inside a rule's matcher) WITHOUT issuing a clock: the transformation is deterministic from the
 * alias table, so the row keeps its clock and meta. The snapshot, however, is a copy of the row's
 * content (the decoded record of a field-clock table, a content hash of every other table, plus the
 * unit signature of a transaction and the parent id of a split) and would otherwise be stale: the
 * next scan would read the new reference as a local edit and stamp it with a fresh clock.
 *
 * Only rows that have a live `sync_entity_meta` row get a snapshot (as the stamper does: a row with
 * no meta is a creation for the next scan and has no snapshot to keep current). Tables that are not
 * captured (grow-only unions, device-local tables) have neither.
 */
export const refreshSnapshots = async (
  db: Database,
  table: string,
  entityIds: readonly string[],
): Promise<number> => {
  if (entityIds.length === 0 || !isCapturedTable(table)) return 0;
  const info = await readTableInfo(db, table);
  const codec = buildEntityCodec(table, info.columns);
  let written = 0;
  for (const batch of chunked([...new Set(entityIds)])) {
    const keys = batch.map((id) => parseEntityId(table, id) as PrimaryKeyValue[]);
    const byId = new Map<string, RawRow>();
    for (const row of await fetchRows(db, table, info.primaryKey, keys)) {
      byId.set(
        entityIdOf(
          table,
          info.primaryKey.map((column) => row[column]),
        ),
        row,
      );
    }
    const metas = await fetchMeta(db, table, batch);
    const snapshots = await fetchSnapshots(db, table, batch);
    const splits = table === FINANCE_TRANSACTIONS ? await fetchSplitsOf(db, batch) : null;

    const outcome = emptyOutcome();
    for (const id of batch) {
      const row = byId.get(id);
      const meta = metas.get(id);
      if (row === undefined || meta === undefined || meta.deleted_at !== null) continue;
      const record = codec.decode(row);
      let snapshotJson: string | null;
      let hash: string | null;
      if (codec.kind === "field") {
        snapshotJson = canonicalJson(record);
        hash = null;
      } else if (splits !== null) {
        snapshotJson = unitSnapshotJson(unitSignature(row, splits.get(id) ?? []));
        hash = contentHash(record);
      } else if (table === FINANCE_SPLITS) {
        snapshotJson = splitSnapshotJson(String(row.transaction_id));
        hash = contentHash(record);
      } else {
        snapshotJson = null;
        hash = contentHash(record);
      }
      const stored = snapshots.get(id);
      if (stored?.snapshot_json !== snapshotJson || stored?.content_hash !== hash) {
        outcome.snapshotWrites.push({ entityId: id, snapshotJson, contentHash: hash });
        written += 1;
      }
    }
    await writeOutcome(db, table, outcome);
  }
  return written;
};
