import type { Database } from "../storage/sqlite-db";
import { buildEntityCodec, contentHash, type RawRow, type RowCodec } from "./capture-decode";
import {
  fetchSplitsOf,
  splitSnapshotJson,
  unitSnapshotJson,
  unitSignatureOfSnapshot,
} from "./capture-finance";
import { quoteIdent } from "./capture-install";
import {
  chunked,
  emptyOutcome,
  fetchMeta,
  fetchRows,
  fetchSnapshots,
  parseClocks,
  placeholders,
  writeOutcome,
} from "./capture-stamp";
import type { SyncEntity } from "./change-set";
import { type ExtraConflict, orphanedChildId } from "./conflicts";
import { entityIdOf, parseEntityId, type PrimaryKeyValue } from "./entity-id";
import { SyncApplyError } from "./errors";
import { canonicalJson, getOwn, jsonDeepEqual } from "./field-clocks";
import {
  extraConflictOf,
  keyConditions,
  messageOf,
  type PendingConflict,
  rowsById,
  toSqlApplyError,
  type Totals,
  writeRow,
} from "./apply-support";
import { overwrittenConflictId } from "./merge-entity";
import {
  FINANCE_SNAPSHOTS,
  FINANCE_SPLITS,
  FINANCE_TRANSACTIONS,
  mergeTransactionEntity,
  type TransactionMergeOutcome,
  unitOverwrite,
  unitSignature,
  wantedChildren,
} from "./merge-finance";
import { getTableRegistration } from "./registry";
import { readTableInfo, type TableInfo } from "./table-info";

/**
 * Applying `finance_transactions` together with their `finance_transaction_splits`, and the standing
 * anchor of the statement balance snapshots. The pure rules live in `merge-finance.ts`; this module
 * reads the database, writes, and keeps the meta and the snapshot exactly as the stamper
 * (`capture-finance.ts`) would, so a verifying scan restamps nothing.
 *
 * ## Transactions and their children
 *
 * A transaction merges by row clock for its ordinary columns and by unit order for its categorization
 * unit (`mergeTransactionEntity`). The children of the unit are then replaced as a SET by whichever
 * unit won, in the same step, from the split entities of the same bundle:
 *
 * - the remote unit won (or the transaction was inserted): the local children of the transaction are
 *   replaced by the bundle's live children of it. A local child the bundle does not carry is deleted
 *   with its meta and snapshot (no tombstone: children leave none, see `deleteBehavior`);
 * - the local unit won, or both are the same write: the bundle's children of it are ignored, so
 *   children of two units are never mixed;
 * - the transaction ended deleted: its local children are removed.
 *
 * The splits table is applied afterwards ({@link applyFinanceSplits}) only to account for the
 * entities: a split whose transaction is not in the bundle cannot be judged (it would have to follow
 * a unit nobody sent), so it is skipped with an informational `orphaned_child` conflict, not stored
 * and never an abort; the bundle that brings its transaction brings it again.
 *
 * ## The standing anchor
 *
 * `applyFinanceStatementBalance` keeps ONE `source = 'statement'` snapshot per account (it deletes the
 * previous one) and re-bases `finance_accounts.opening_balance_minor`. The delete is never published
 * (filtered tables publish no tombstones), so another laptop would keep the old anchor next to the
 * new one. The apply step ({@link competingAnchors}, {@link dropAnchors}) keeps, per account, the
 * anchor with the later row clock (then the later statement date): an incoming anchor that a local
 * one beats is not stored, one that beats the local ones replaces them (rows, meta and snapshot go,
 * no tombstone). It is a max over the anchors seen, so it does not depend on arrival order and
 * re-applying changes nothing.
 */

const CHUNK = 100;

/** The id of this device (`sync_identity`), which tells a local edit from a propagated one. */
export const readLocalDeviceId = async (db: Database): Promise<string> => {
  const rows = await db.select<{ device_id: string }[]>(
    "SELECT device_id FROM sync_identity WHERE id = 1",
  );
  return rows[0]?.device_id ?? "";
};

const sameRow = (a: RawRow, b: RawRow, columns: readonly string[]): boolean =>
  columns.every(
    (column) =>
      !Object.hasOwn(b, column) ||
      jsonDeepEqual(
        typeof a[column] === "bigint" ? Number(a[column]) : (a[column] ?? null),
        b[column] ?? null,
      ),
  );

export interface FinanceBundleContext {
  /** The bundle's live split entities by their transaction id. */
  splitsByTransaction: ReadonlyMap<string, readonly SyncEntity[]>;
  /** The transactions the bundle names (live or deleted); their splits are handled with them. */
  transactionIds: ReadonlySet<string>;
}

export const buildFinanceContext = (entities: readonly SyncEntity[]): FinanceBundleContext => {
  const splitsByTransaction = new Map<string, SyncEntity[]>();
  const transactionIds = new Set<string>();
  for (const entity of entities) {
    if (entity.table === FINANCE_TRANSACTIONS) transactionIds.add(entity.entityId);
    if (entity.table === FINANCE_SPLITS && entity.row !== null) {
      const parent = String(entity.row.transaction_id ?? "");
      const list = splitsByTransaction.get(parent) ?? [];
      list.push(entity);
      splitsByTransaction.set(parent, list);
    }
  }
  return { splitsByTransaction, transactionIds };
};

interface ChildrenResult {
  changed: boolean;
}

/**
 * Makes the local children of one transaction equal to `wanted` (the winning unit's set), writing
 * rows, meta (`row_hlc` of the child, `{}` clocks) and snapshots as the stamper would. Reports
 * whether anything was different, so re-applying a bundle changes (and counts) nothing.
 */
const replaceChildren = async (
  db: Database,
  info: TableInfo,
  codec: RowCodec,
  transactionId: string,
  local: readonly RawRow[],
  wanted: readonly SyncEntity[],
): Promise<ChildrenResult> => {
  const table = quoteIdent(FINANCE_SPLITS);
  const outcome = emptyOutcome();
  let changed = false;

  const wantedIds = new Set(wanted.map((entity) => entity.entityId));
  const localById = rowsById(FINANCE_SPLITS, info, [...local]);
  for (const [id, row] of localById) {
    if (wantedIds.has(id)) continue;
    await db.execute(
      `DELETE FROM ${table} WHERE ${keyConditions(info.primaryKey, 1).sql}`,
      info.primaryKey.map((column) => row[column]),
    );
    outcome.metaDeletes.push(id);
    outcome.snapshotDeletes.push(id);
    changed = true;
  }

  if (wanted.length > 0) {
    const ids = wanted.map((entity) => entity.entityId);
    const keys = ids.map((id) => parseEntityId(FINANCE_SPLITS, id) as PrimaryKeyValue[]);
    const metas = await fetchMeta(db, FINANCE_SPLITS, ids);
    // A split id that already exists (under this or another transaction) is updated in place.
    const stored = rowsById(
      FINANCE_SPLITS,
      info,
      await fetchRows(db, FINANCE_SPLITS, info.primaryKey, keys),
    );
    for (const entity of wanted) {
      const remote = entity.row as RawRow;
      const existing = stored.get(entity.entityId);
      const columns = info.columns.filter((column) => Object.hasOwn(remote, column));
      if (existing === undefined) {
        await db.execute(
          `INSERT INTO ${table} (${columns.map(quoteIdent).join(", ")}) VALUES (${placeholders(columns.length)})`,
          columns.map((column) => getOwn(remote, column)),
        );
        changed = true;
      } else if (!sameRow(existing, remote, info.columns)) {
        const sets = columns.filter((column) => !info.primaryKey.includes(column));
        await db.execute(
          `UPDATE ${table} SET ${sets.map((column, index) => `${quoteIdent(column)} = $${index + 1}`).join(", ")} WHERE ${keyConditions(info.primaryKey, sets.length + 1).sql}`,
          [
            ...sets.map((column) => getOwn(remote, column)),
            ...info.primaryKey.map((column) => existing[column]),
          ],
        );
        changed = true;
      }
      const meta = metas.get(entity.entityId);
      if (
        meta === undefined ||
        meta.deleted_at !== null ||
        meta.row_hlc !== entity.rowHlc ||
        meta.field_clocks_json !== "{}"
      ) {
        outcome.metaWrites.push({
          entityId: entity.entityId,
          fieldClocksJson: "{}",
          rowHlc: entity.rowHlc,
          deletedAt: null,
        });
        changed = true;
      }
    }
    // The snapshot is the hash of the row as the stamper decodes it, read back after the writes.
    const snapshots = await fetchSnapshots(db, FINANCE_SPLITS, ids);
    const final = rowsById(
      FINANCE_SPLITS,
      info,
      await fetchRows(db, FINANCE_SPLITS, info.primaryKey, keys),
    );
    for (const entity of wanted) {
      const row = final.get(entity.entityId);
      if (row === undefined) continue;
      const hash = contentHash(codec.decode(row));
      const snapshotJson = splitSnapshotJson(transactionId);
      const snapshot = snapshots.get(entity.entityId);
      if (snapshot?.content_hash !== hash || snapshot?.snapshot_json !== snapshotJson) {
        outcome.snapshotWrites.push({ entityId: entity.entityId, snapshotJson, contentHash: hash });
      }
    }
  }

  await writeOutcome(db, FINANCE_SPLITS, outcome);
  return { changed };
};

const unitConflicts = (
  entityId: string,
  merged: TransactionMergeOutcome,
  localRow: RawRow | undefined,
  remoteRow: RawRow,
  localChildren: readonly RawRow[],
  remoteChildren: readonly SyncEntity[],
  localDeviceId: string,
): PendingConflict[] => {
  const { local, remote, winner } = merged.unit;
  if (winner !== "remote" || local === null || remote === null || localRow === undefined) {
    return [];
  }
  const remoteRows = remoteChildren.map((child) => child.row as RawRow);
  const lost = unitOverwrite(
    { version: local, row: localRow, signature: unitSignature(localRow, localChildren) },
    { version: remote, row: remoteRow, signature: unitSignature(remoteRow, remoteRows) },
    { local: localChildren, remote: remoteRows },
    localDeviceId,
  );
  if (lost === null) return [];
  return [
    {
      id: overwrittenConflictId(
        FINANCE_TRANSACTIONS,
        entityId,
        lost.field,
        lost.local.clock,
        lost.remote.clock,
      ),
      kind: "overwritten_edit",
      entityType: FINANCE_TRANSACTIONS,
      entityId,
      localJson: canonicalJson({ [lost.field]: lost.local }),
      remoteJson: canonicalJson({ [lost.field]: lost.remote }),
    },
  ];
};

export const applyFinanceTransactions = async (
  db: Database,
  entities: readonly SyncEntity[],
  context: FinanceBundleContext,
  totals: Totals,
  conflicts: PendingConflict[],
): Promise<void> => {
  const info = await readTableInfo(db, FINANCE_TRANSACTIONS);
  const splitInfo = await readTableInfo(db, FINANCE_SPLITS);
  const codec = buildEntityCodec(FINANCE_TRANSACTIONS, info.columns);
  const splitCodec = buildEntityCodec(FINANCE_SPLITS, splitInfo.columns);
  if (codec.kind !== "row" || splitCodec.kind !== "row") {
    throw new SyncApplyError(
      "unsupported_merge_class",
      `"${FINANCE_TRANSACTIONS}" has no row codec`,
      {
        table: FINANCE_TRANSACTIONS,
      },
    );
  }

  const localDeviceId = await readLocalDeviceId(db);
  for (const batch of chunked([...entities], CHUNK)) {
    const keys = batch.map(
      (entity) => parseEntityId(FINANCE_TRANSACTIONS, entity.entityId) as PrimaryKeyValue[],
    );
    const ids = batch.map((entity) => entity.entityId);
    const rows = rowsById(
      FINANCE_TRANSACTIONS,
      info,
      await fetchRows(db, FINANCE_TRANSACTIONS, info.primaryKey, keys),
    );
    const metas = await fetchMeta(db, FINANCE_TRANSACTIONS, ids);
    const localSplits = await fetchSplitsOf(db, ids);

    const outcome = emptyOutcome();
    const written: { entityId: string; tombstone: boolean }[] = [];
    for (const entity of batch) {
      const key = parseEntityId(FINANCE_TRANSACTIONS, entity.entityId) as PrimaryKeyValue[];
      const meta = metas.get(entity.entityId);
      const localRow = rows.get(entity.entityId);
      let merged: TransactionMergeOutcome;
      try {
        merged = mergeTransactionEntity({
          localDeviceId,
          columns: info.columns,
          local: {
            row: localRow ?? null,
            meta: meta
              ? {
                  fieldClocks: parseClocks(meta.field_clocks_json),
                  rowHlc: meta.row_hlc,
                  deletedAt: meta.deleted_at,
                }
              : null,
          },
          remote: entity,
        });
      } catch (error) {
        throw new SyncApplyError(
          "merge_failed",
          `Could not merge ${FINANCE_TRANSACTIONS} ${entity.entityId}: ${messageOf(error)}`,
          { table: FINANCE_TRANSACTIONS, entityId: entity.entityId, cause: error },
        );
      }

      try {
        await writeRow(db, FINANCE_TRANSACTIONS, info, key, merged);
      } catch (error) {
        throw await toSqlApplyError(db, FINANCE_TRANSACTIONS, entity.entityId, error);
      }

      // The children follow the unit that won (never a mix of two).
      const remoteChildren = context.splitsByTransaction.get(entity.entityId) ?? [];
      const localChildren = localSplits.get(entity.entityId) ?? [];
      const wanted = wantedChildren(merged.unit.winner, remoteChildren);
      let childrenChanged = false;
      if (wanted !== null && (wanted.length > 0 || localChildren.length > 0)) {
        try {
          childrenChanged = (
            await replaceChildren(db, splitInfo, splitCodec, entity.entityId, localChildren, wanted)
          ).changed;
        } catch (error) {
          throw await toSqlApplyError(db, FINANCE_SPLITS, entity.entityId, error);
        }
      }

      if (merged.metaChanged) {
        outcome.metaWrites.push({
          entityId: entity.entityId,
          fieldClocksJson: canonicalJson(merged.meta.fieldClocks),
          rowHlc: merged.meta.rowHlc,
          deletedAt: merged.meta.deletedAt,
        });
      }
      if (merged.rowAction !== "none" || merged.metaChanged || childrenChanged) {
        totals.applied += 1;
      } else {
        totals.skipped += 1;
      }
      if (merged.tombstoneApplied) totals.tombstonesApplied += 1;
      for (const field of merged.overwritten) {
        conflicts.push({
          id: overwrittenConflictId(
            FINANCE_TRANSACTIONS,
            entity.entityId,
            field.field,
            field.local.clock,
            field.remote.clock,
          ),
          kind: "overwritten_edit",
          entityType: FINANCE_TRANSACTIONS,
          entityId: entity.entityId,
          localJson: canonicalJson({ [field.field]: field.local }),
          remoteJson: canonicalJson({ [field.field]: field.remote }),
        });
      }
      if (entity.row !== null) {
        conflicts.push(
          ...unitConflicts(
            entity.entityId,
            merged,
            localRow,
            entity.row,
            localChildren,
            remoteChildren,
            localDeviceId,
          ),
        );
      }
      for (const conflict of merged.conflicts) conflicts.push(extraConflictOf(conflict));
      written.push({ entityId: entity.entityId, tombstone: merged.meta.deletedAt !== null });
    }

    // The snapshot is what the stamper would record: the hash of the stored row and the signature of
    // its unit, children included, read back after every write.
    const final = rowsById(
      FINANCE_TRANSACTIONS,
      info,
      await fetchRows(
        db,
        FINANCE_TRANSACTIONS,
        info.primaryKey,
        written.map(
          (entry) => parseEntityId(FINANCE_TRANSACTIONS, entry.entityId) as PrimaryKeyValue[],
        ),
      ),
    );
    const finalSplits = await fetchSplitsOf(
      db,
      written.map((entry) => entry.entityId),
    );
    const snapshots = await fetchSnapshots(
      db,
      FINANCE_TRANSACTIONS,
      written.map((entry) => entry.entityId),
    );
    for (const entry of written) {
      const snapshot = snapshots.get(entry.entityId);
      const row = final.get(entry.entityId);
      if (entry.tombstone || row === undefined) {
        if (snapshot) outcome.snapshotDeletes.push(entry.entityId);
        continue;
      }
      const hash = contentHash((codec as RowCodec).decode(row));
      const signature = unitSignature(row, finalSplits.get(entry.entityId) ?? []);
      if (snapshot?.content_hash !== hash || unitSignatureOfSnapshot(snapshot) !== signature) {
        outcome.snapshotWrites.push({
          entityId: entry.entityId,
          snapshotJson: unitSnapshotJson(signature),
          contentHash: hash,
        });
      }
    }
    await writeOutcome(db, FINANCE_TRANSACTIONS, outcome);
  }
};

/**
 * Accounts for the split entities of a bundle. Children were applied (and counted) with their
 * transaction; one whose transaction the bundle does not name is skipped and logged (see the module
 * comment); a tombstone of a split is ignored (children leave no tombstone, the unit carries the
 * set).
 */
export const applyFinanceSplits = async (
  entities: readonly SyncEntity[],
  context: FinanceBundleContext,
  totals: Totals,
  conflicts: PendingConflict[],
): Promise<void> => {
  for (const entity of entities) {
    if (entity.row === null) continue;
    if (context.transactionIds.has(String(entity.row.transaction_id ?? ""))) continue;
    totals.skipped += 1;
    const orphan: ExtraConflict = {
      id: orphanedChildId(FINANCE_SPLITS, entity.entityId),
      kind: "orphaned_child",
      entityType: FINANCE_SPLITS,
      entityId: entity.entityId,
      local: { parent: "unknown" },
      remote: entity.row,
    };
    conflicts.push(extraConflictOf(orphan));
  }
};

// ---------------------------------------------------------------------------------------------
// Standing anchor of the statement balance snapshots
// ---------------------------------------------------------------------------------------------

export interface AnchorRef {
  id: string;
  key: PrimaryKeyValue[];
  clock: string | null;
  asOfDate: string;
}

interface AnchorRow {
  account_id: string;
  as_of_date: string;
}

/**
 * The other `statement` snapshots of an account (every one but `ownEntityId`) with the row clock of
 * their live meta (`null` for an unstamped one, which loses to any stamped anchor).
 */
export const competingAnchors = async (
  db: Database,
  accountId: string,
  ownEntityId: string,
): Promise<AnchorRef[]> => {
  const table = quoteIdent(FINANCE_SNAPSHOTS);
  const anchors = await db.select<AnchorRow[]>(
    `SELECT account_id, as_of_date FROM ${table} WHERE account_id = $1 AND source = 'statement'`,
    [accountId],
  );
  const refs = anchors.map((anchor) => ({
    id: entityIdOf(FINANCE_SNAPSHOTS, [anchor.account_id, anchor.as_of_date]),
    key: [anchor.account_id, anchor.as_of_date] as PrimaryKeyValue[],
    asOfDate: anchor.as_of_date,
  }));
  const others = refs.filter((ref) => ref.id !== ownEntityId);
  const metas = await fetchMeta(
    db,
    FINANCE_SNAPSHOTS,
    others.map((ref) => ref.id),
  );
  return others.map((ref) => {
    const meta = metas.get(ref.id);
    return { ...ref, clock: meta && meta.deleted_at === null ? meta.row_hlc : null };
  });
};

/** Deletes superseded anchors with their meta and snapshot (no tombstone). Returns how many. */
export const dropAnchors = async (db: Database, anchors: readonly AnchorRef[]): Promise<number> => {
  if (anchors.length === 0) return 0;
  const table = quoteIdent(FINANCE_SNAPSHOTS);
  const primaryKey = getTableRegistration(FINANCE_SNAPSHOTS).primaryKey;
  const outcome = emptyOutcome();
  for (const anchor of anchors) {
    await db.execute(`DELETE FROM ${table} WHERE ${keyConditions(primaryKey, 1).sql}`, anchor.key);
    outcome.metaDeletes.push(anchor.id);
    outcome.snapshotDeletes.push(anchor.id);
  }
  await writeOutcome(db, FINANCE_SNAPSHOTS, outcome);
  return anchors.length;
};
