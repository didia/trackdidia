import type { Database } from "../storage/sqlite-db";
import type { RawRow } from "./capture-decode";
import { quoteIdent } from "./capture-install";
import {
  chunked,
  emptyOutcome,
  fetchMeta,
  parseClocks,
  placeholders,
  writeOutcome,
} from "./capture-stamp";
import { entityIdOf, type PrimaryKeyValue } from "./entity-id";
import { SyncApplyError } from "./errors";
import { maxHlcOf, successorHlc } from "./hlc";
import { strategyForTable, tableOrder } from "./merge-strategies";
import { getTableRegistration, SYNC_DOMAINS, TABLE_REGISTRY } from "./registry";
import { keyConditions, type Totals } from "./apply-support";
import { readTableInfo } from "./table-info";

/**
 * Declared foreign keys while applying a bundle. Production enforces them, so three things that are
 * harmless without enforcement become hazards: a child inserted before (or without) its parent
 * aborts the whole bundle; a parent delete cascades inside the database where the capture triggers
 * are off, so the children vanish with no tombstone; and a child edit arriving for a deleted parent
 * would be inserted under a parent that is gone. Everything is derived from
 * `PRAGMA foreign_key_list`, never listed per table; `registry.test.ts` fails when a migration
 * adds a key this module has no rule for.
 *
 * The rules, in the order the apply path uses them:
 *
 * 1. ORDER. Tables are applied parents first ({@link orderByReferences}), grow-only-union parents
 *    (`ai_messages`) included, so a child that arrives in the same bundle as its parent finds it.
 * 2. DEFERRED DELETES. A parent row a bundle deletes is not deleted when its entity is merged. It
 *    is recorded ({@link ReferenceGuard.deferDelete}) and removed by {@link ReferenceGuard.flush}
 *    after every table of the bundle was applied, so deletes run children before parents, and the
 *    children's own merge sees the parent as gone.
 * 3. THE PARENT STATUS of a child row ({@link ReferenceGuard.statusOf}) is `present` (the row
 *    exists and is not being deleted), `gone` (a tombstone, here or in this bundle) or `missing`
 *    (never heard of).
 *    - gone: the child ends as a tombstone even if an edit is later than every delete it has seen
 *      (`mergeFieldClockEntity({orphaned})`). Edit wins over delete applies to the PARENT: its own
 *      later edit resurrects it, and then children with later edits come back with it. An
 *      `orphaned_child` conflict records the discarded remote row.
 *    - missing: a child that would have to be inserted is skipped (nothing written, so the bundle
 *      that later brings the parent applies it) and logged as `orphaned_child`; the bundle is
 *      never aborted for it.
 * 4. CASCADE. {@link ReferenceGuard.flush} deletes the local children of every deferred parent
 *    delete itself (recursively) and tombstones each child that has a live `sync_entity_meta` row:
 *    `deleted_at = row_hlc` = the parent's `deletedAt` (raised to just after the child's newest
 *    clock when the child was edited later than the delete: a tombstone must be later than the
 *    clocks it retains), field clocks kept, snapshot dropped. Replicas therefore agree, and a
 *    cascade with capture off never leaves "live meta, no row".
 */

export interface ForeignKeyEdge {
  childTable: string;
  childColumn: string;
  parentTable: string;
  parentColumn: string;
  onDelete: string;
}

interface EdgeRow {
  child_table: string;
  parent_table: string;
  child_column: string;
  parent_column: string | null;
  on_delete: string;
}

/** Every declared foreign key between synced registry tables, in a deterministic order. */
export const readForeignKeyEdges = async (db: Database): Promise<ForeignKeyEdge[]> => {
  const names = TABLE_REGISTRY.filter((entry) =>
    (SYNC_DOMAINS as readonly string[]).includes(entry.domain),
  ).map((entry) => entry.table);
  if (names.length === 0) return [];
  const rows = await db.select<EdgeRow[]>(
    `SELECT m.name AS child_table, f."table" AS parent_table, f."from" AS child_column,
            f."to" AS parent_column, f.on_delete AS on_delete
     FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f
     WHERE m.type = 'table' AND m.name IN (${placeholders(names.length)})
     ORDER BY m.name, f.id, f.seq`,
    names,
  );
  return rows.map((row) => {
    const parent = getTableRegistration(row.parent_table);
    const parentColumn = row.parent_column ?? parent.primaryKey[0];
    if (parent.primaryKey.length !== 1 || parentColumn !== parent.primaryKey[0]) {
      throw new SyncApplyError(
        "unsupported_foreign_key",
        `Foreign key ${row.child_table}.${row.child_column} -> ${row.parent_table}.${parentColumn} does not reference a single-column primary key; the sync apply path has no rule for it`,
        { table: row.child_table },
      );
    }
    return {
      childTable: row.child_table,
      childColumn: row.child_column,
      parentTable: row.parent_table,
      parentColumn: parentColumn as string,
      onDelete: row.on_delete.toUpperCase(),
    };
  });
};

/**
 * The tables ordered so that every parent comes before its children, otherwise keeping the given
 * order. Only parents that are in `tables` move; a cycle (no such key exists) cannot loop.
 */
export const orderByReferences = (
  tables: readonly string[],
  edges: readonly ForeignKeyEdge[],
): string[] => {
  const present = new Set(tables);
  const done = new Set<string>();
  const ordered: string[] = [];
  const visit = (table: string): void => {
    if (done.has(table)) return;
    done.add(table);
    for (const edge of edges) {
      if (
        edge.childTable === table &&
        edge.parentTable !== table &&
        present.has(edge.parentTable)
      ) {
        visit(edge.parentTable);
      }
    }
    ordered.push(table);
  };
  for (const table of tables) visit(table);
  return ordered;
};

export type ParentStatus =
  | { state: "present" }
  | { state: "gone"; deletedAt: string }
  | { state: "missing" };

interface DeferredDelete {
  table: string;
  entityId: string;
  key: PrimaryKeyValue[];
  deletedAt: string;
}

export class ReferenceGuard {
  private readonly deferred = new Map<string, DeferredDelete>();

  private constructor(
    private readonly db: Database,
    readonly edges: readonly ForeignKeyEdge[],
  ) {}

  static async create(db: Database): Promise<ReferenceGuard> {
    const edges = await readForeignKeyEdges(db);
    for (const edge of edges) {
      // A parent that sync can delete must cascade: that is the only delete action with a rule.
      const parentKind = strategyForTable(edge.parentTable)?.kind;
      if (
        parentKind !== undefined &&
        parentKind !== "grow-only-union" &&
        edge.onDelete !== "CASCADE"
      ) {
        throw new SyncApplyError(
          "unsupported_foreign_key",
          `Foreign key ${edge.childTable}.${edge.childColumn} -> ${edge.parentTable} is ON DELETE ${edge.onDelete}; only CASCADE has a sync rule`,
          { table: edge.childTable },
        );
      }
    }
    return new ReferenceGuard(db, edges);
  }

  edgesOfChild(table: string): ForeignKeyEdge[] {
    return this.edges.filter((edge) => edge.childTable === table);
  }

  edgesOfParent(table: string): ForeignKeyEdge[] {
    return this.edges.filter((edge) => edge.parentTable === table);
  }

  /** True when deleting a row of `table` cascades to child rows (its deletes are deferred). */
  isCascadeParent(table: string): boolean {
    return this.edgesOfParent(table).some((edge) => edge.onDelete === "CASCADE");
  }

  /** Where the parent of one edge stands for a child row. A NULL reference has no parent to lack. */
  private async edgeStatus(edge: ForeignKeyEdge, row: RawRow): Promise<ParentStatus> {
    const value = row[edge.childColumn];
    if (value === null || value === undefined) return { state: "present" };
    const parentId = String(value);
    const pending = this.deferred.get(`${edge.parentTable}\u0000${parentId}`);
    if (pending) return { state: "gone", deletedAt: pending.deletedAt };
    const exists = await this.db.select<{ present: number }[]>(
      `SELECT 1 AS present FROM ${quoteIdent(edge.parentTable)} WHERE ${quoteIdent(edge.parentColumn)} = $1 LIMIT 1`,
      [value],
    );
    if (exists.length > 0) return { state: "present" };
    const meta = (await fetchMeta(this.db, edge.parentTable, [parentId])).get(parentId);
    if (meta?.deleted_at) return { state: "gone", deletedAt: meta.deleted_at };
    return { state: "missing" };
  }

  /**
   * The standing of a child row's parents: gone if any parent is gone (the latest delete), else
   * missing if any is missing, else present. A table without foreign keys is always present.
   */
  async statusOf(table: string, row: RawRow): Promise<ParentStatus> {
    let missing = false;
    let deletedAt: string | null = null;
    for (const edge of this.edgesOfChild(table)) {
      const status = await this.edgeStatus(edge, row);
      if (status.state === "gone") deletedAt = maxHlcOf([deletedAt, status.deletedAt]);
      else if (status.state === "missing") missing = true;
    }
    if (deletedAt !== null) return { state: "gone", deletedAt };
    return missing ? { state: "missing" } : { state: "present" };
  }

  /** Records a parent delete to run in {@link flush}; the row stays until then. */
  deferDelete(table: string, entityId: string, key: PrimaryKeyValue[], deletedAt: string): void {
    this.deferred.set(`${table}\u0000${entityId}`, { table, entityId, key, deletedAt });
  }

  /**
   * Runs the deferred parent deletes, children first: the local children of each parent are
   * tombstoned and deleted by this code (capture is off), then the parent row.
   */
  async flush(totals: Totals): Promise<void> {
    const pending = [...this.deferred.values()].sort(
      (a, b) =>
        tableOrder(a.table) - tableOrder(b.table) ||
        (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0),
    );
    for (const entry of pending) {
      const info = await readTableInfo(this.db, entry.table);
      const rows = await this.db.select<RawRow[]>(
        `SELECT * FROM ${quoteIdent(entry.table)} WHERE ${keyConditions(info.primaryKey, 1).sql}`,
        [...entry.key],
      );
      const parentRow = rows[0];
      if (parentRow !== undefined) {
        await this.cascade(entry.table, parentRow, entry.deletedAt, totals, new Set());
      }
      await this.db.execute(
        `DELETE FROM ${quoteIdent(entry.table)} WHERE ${keyConditions(info.primaryKey, 1).sql}`,
        [...entry.key],
      );
    }
    this.deferred.clear();
  }

  private async cascade(
    parentTable: string,
    parentRow: RawRow,
    deletedAt: string,
    totals: Totals,
    path: Set<string>,
  ): Promise<void> {
    if (path.has(parentTable)) return;
    const nextPath = new Set(path).add(parentTable);
    for (const edge of this.edgesOfParent(parentTable)) {
      if (edge.onDelete !== "CASCADE") continue;
      const children = await this.db.select<RawRow[]>(
        `SELECT * FROM ${quoteIdent(edge.childTable)} WHERE ${quoteIdent(edge.childColumn)} = $1`,
        [parentRow[edge.parentColumn]],
      );
      if (children.length === 0) continue;
      const info = await readTableInfo(this.db, edge.childTable);
      const ids = children.map((child) =>
        entityIdOf(
          edge.childTable,
          info.primaryKey.map((column) => child[column]),
        ),
      );
      for (const child of children) {
        await this.cascade(edge.childTable, child, deletedAt, totals, nextPath);
      }
      for (const batch of chunked(ids)) {
        const metas = await fetchMeta(this.db, edge.childTable, batch);
        const outcome = emptyOutcome();
        for (const id of batch) {
          const meta = metas.get(id);
          if (!meta || meta.deleted_at !== null) continue;
          // The parent's delete clock, raised to just after the child's newest clock when the child
          // was edited later (a tombstone must be later than the clocks it retains).
          const newest = maxHlcOf([
            meta.row_hlc,
            ...Object.values(parseClocks(meta.field_clocks_json)),
          ]);
          const tombstoneAt = maxHlcOf([
            deletedAt,
            newest === null ? null : successorHlc(newest),
          ]) as string;
          outcome.metaWrites.push({
            entityId: id,
            fieldClocksJson: meta.field_clocks_json,
            rowHlc: tombstoneAt,
            deletedAt: tombstoneAt,
          });
          outcome.snapshotDeletes.push(id);
          totals.applied += 1;
          totals.tombstonesApplied += 1;
        }
        await writeOutcome(this.db, edge.childTable, outcome);
      }
      for (const child of children) {
        await this.db.execute(
          `DELETE FROM ${quoteIdent(edge.childTable)} WHERE ${keyConditions(info.primaryKey, 1).sql}`,
          info.primaryKey.map((column) => child[column]),
        );
      }
    }
  }
}
