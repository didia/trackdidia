import type { Database } from "../storage/sqlite-db";
import type { RawRow } from "./capture-decode";
import { quoteIdent } from "./capture-install";
import type { MetaRow, MetaWrite, SnapshotRow, SnapshotWrite } from "./capture-stamp";
import { canonicalJson } from "./field-clocks";
import {
  FINANCE_SNAPSHOTS,
  FINANCE_SPLITS,
  FINANCE_TRANSACTIONS,
  hasUnitClock,
  nextUnitVersion,
  type UnitVersion,
  unitClocksOf,
  unitSignature,
  unitVersionOf,
} from "./merge-finance";

/**
 * Change capture for the finance categorization unit (design: `merge-finance.ts`).
 *
 * A transaction's `{category_id, category_source, has_splits}` (+ its descriptive companions) and its
 * split children form one unit. Capture derives the unit from the same snapshot diff as everything
 * else, in the same transaction as the write:
 *
 * - the transaction's snapshot keeps `content_hash` of the row (as for any row-clock table) and, in
 *   `snapshot_json`, `{"unit": <signature>}`: the signature of the unit payload and ALL its children.
 *   A different signature is a unit write; an unchanged one stamps no unit clock, so editing a
 *   description or a note never moves the categorization;
 * - a unit write stamps `categorization` (the fresh clock), `categorization_base` (the unit clock the
 *   device held, absent for a creation) and `categorization_user` (this clock for a `user` decision,
 *   else inherited) in `sync_entity_meta.field_clocks_json`, and always moves `row_hlc` too, so an
 *   edit of the unit still wins over a concurrent delete like any other edit of the entity;
 * - saving splits, or removing the last one, is what `saveTransactionSplits` does: it rewrites the
 *   children and resets the parent in the same transaction, so both arrive in one stamp. A child
 *   mark re-evaluates the parent (`stampTableMarks` reports the parent ids of changed children),
 *   because a bulk update of split categories (`archiveCategory`) touches children only.
 * - the children keep `{"transaction_id": ...}` in their snapshot, so the deletion of a child can
 *   still name its parent. Children and statement snapshots leave no tombstone (see
 *   {@link deleteBehavior}).
 *
 * Nothing here runs unless change capture is enabled; a stamp that finds nothing changed writes
 * nothing and issues no clock.
 */

export type DeleteBehavior =
  /** Tombstone, keeping the field clocks (the generic behavior). */
  | "tombstone"
  /** Tombstone with empty field clocks: the unit clocks mean nothing without the row. */
  | "tombstone-clear"
  /** No tombstone: the entity's meta and snapshot are dropped (never published as a delete). */
  | "drop";

/**
 * What a delete leaves behind.
 * - a transaction: a tombstone without unit clocks, so replicas that applied the delete agree with
 *   the one that stamped it;
 * - a split: nothing. Children live and die with their transaction's unit, which carries the whole
 *   set; a tombstone of a child could not say which unit removed it;
 * - a statement snapshot: nothing. The table is filtered (only `statement` rows are published) and
 *   filtered tombstones are never published; a replaced anchor is superseded on the other laptop by
 *   the standing-anchor rule of `apply-finance.ts`.
 */
export const deleteBehavior = (table: string): DeleteBehavior => {
  if (table === FINANCE_TRANSACTIONS) return "tombstone-clear";
  if (table === FINANCE_SPLITS || table === FINANCE_SNAPSHOTS) return "drop";
  return "tombstone";
};

export const unitSnapshotJson = (signature: string): string => canonicalJson({ unit: signature });

const parseSnapshotObject = (json: string | null | undefined): Record<string, unknown> | null => {
  if (typeof json !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

/** The unit signature a transaction's snapshot recorded; `undefined` for a snapshot older than the unit. */
export const unitSignatureOfSnapshot = (snapshot: SnapshotRow | undefined): string | undefined => {
  const parsed = parseSnapshotObject(snapshot?.snapshot_json);
  return typeof parsed?.unit === "string" ? parsed.unit : undefined;
};

export const splitSnapshotJson = (transactionId: string): string =>
  canonicalJson({ transaction_id: transactionId });

/** The transaction a split's snapshot belonged to; `null` when unknown. */
export const parentOfSplitSnapshot = (snapshot: SnapshotRow | undefined): string | null => {
  const parsed = parseSnapshotObject(snapshot?.snapshot_json);
  return typeof parsed?.transaction_id === "string" ? parsed.transaction_id : null;
};

const CHILD_CHUNK = 100;

/** The split rows of the given transactions, by transaction id (an entry for every id asked). */
export const fetchSplitsOf = async (
  db: Database,
  transactionIds: readonly string[],
): Promise<Map<string, RawRow[]>> => {
  const found = new Map<string, RawRow[]>();
  for (const id of transactionIds) found.set(id, []);
  const table = quoteIdent(FINANCE_SPLITS);
  for (let start = 0; start < transactionIds.length; start += CHILD_CHUNK) {
    const batch = transactionIds.slice(start, start + CHILD_CHUNK);
    if (batch.length === 0) continue;
    const rows = await db.select<RawRow[]>(
      `SELECT * FROM ${table} WHERE ${quoteIdent("transaction_id")} IN (${batch
        .map((_, index) => `$${index + 1}`)
        .join(", ")})`,
      batch,
    );
    for (const row of rows) found.get(String(row.transaction_id))?.push(row);
  }
  return found;
};

export interface TransactionStampInput {
  row: RawRow;
  children: readonly RawRow[];
  /** The content hash of the row (as for any row-clock table). */
  rowHash: string;
  /** The live meta row, or `undefined` for a creation (never stamped, or tombstoned). */
  meta: MetaRow | undefined;
  snapshot: SnapshotRow | undefined;
  /** Issues the next clock of the stamp batch. */
  issue: () => Promise<string>;
  parseClocks: (json: string | null | undefined) => Record<string, string>;
}

export interface TransactionStamp {
  meta: Omit<MetaWrite, "entityId">;
  snapshot: Omit<SnapshotWrite, "entityId">;
}

/**
 * The stamp of one live transaction, or `null` when neither the row nor the unit changed (and the
 * unit clocks exist). A row stamped before the unit existed gets its unit clocks derived from its
 * row clock without issuing a clock.
 */
export const stampTransaction = async (
  input: TransactionStampInput,
): Promise<TransactionStamp | null> => {
  const { row, children, rowHash, meta, snapshot, issue, parseClocks } = input;
  const signature = unitSignature(row, children);
  const clocks = meta ? parseClocks(meta.field_clocks_json) : {};
  const previous: UnitVersion | null = meta ? unitVersionOf(clocks, meta.row_hlc, row) : null;
  const recorded = unitSignatureOfSnapshot(snapshot);
  const rowSame = meta !== undefined && snapshot?.content_hash === rowHash;
  const unitSame = meta !== undefined && recorded === signature;

  if (rowSame && unitSame && hasUnitClock(clocks)) return null;

  const snapshotWrite: Omit<SnapshotWrite, "entityId"> = {
    snapshotJson: unitSnapshotJson(signature),
    contentHash: rowHash,
  };

  // The row and the unit are unchanged since the last stamp, but the unit clocks were never written
  // (a stamp from before the unit existed): derive them, issue nothing.
  if (meta !== undefined && rowSame && (unitSame || recorded === undefined)) {
    return {
      meta: {
        fieldClocksJson: canonicalJson(unitClocksOf(previous as UnitVersion)),
        rowHlc: meta.row_hlc,
        deletedAt: null,
      },
      snapshot: snapshotWrite,
    };
  }

  const hlc = await issue();
  const unitChanged = meta === undefined || !unitSame;
  const version = unitChanged ? nextUnitVersion(previous, row.category_source, hlc) : previous;
  return {
    meta: {
      fieldClocksJson: canonicalJson(unitClocksOf(version as UnitVersion)),
      rowHlc: hlc,
      deletedAt: null,
    },
    snapshot: snapshotWrite,
  };
};
