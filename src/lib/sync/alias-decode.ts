import type { FinanceBundleContext } from "./apply-finance";
import type { SyncChangeSet, SyncEntity, SyncRow } from "./change-set";
import { entityIdOf } from "./entity-id";
import { appendTo } from "./collections";
import { canonicalJson, getOwn } from "./field-clocks";
import { compareHlc } from "./hlc";
import { FINANCE_SPLITS, FINANCE_TRANSACTIONS } from "./merge-finance";
import { rewriteEntityId, rewriteSyncRow, type Resolver } from "./reference-rewrite";
import { getTableRegistration } from "./registry";

/**
 * "Alias on decode": a peer that has not learned an alias yet keeps publishing the alias id, in its
 * own rows and in the references of others. Before such a change set is merged, every entity id,
 * primary key and declared reference (plain columns, JSON payload paths, derived values) is mapped
 * through the alias classes, so the merge only ever sees canonical ids. Pure; the classes come in as
 * a resolver. A change set that needs no change is returned as it is.
 *
 * Rewriting can make two entities of one bundle name the same id: a sender that wrote a row under an
 * alias id AFTER it learned the alias (a stale in-flight write) holds the alias row next to the
 * canonical one, and a tombstone kept for an alias sits next to the live canonical row. They are
 * applied one after the other ({@link splitIntoRounds}), so the table's merge rules join them. For a
 * transaction, whose splits belong to ONE of the versions, the engine remembers the id each entity
 * had before the rewrite ({@link originOf}) to hand each version only its own splits.
 */

const origins = new WeakMap<SyncEntity, string>();

/** The id an entity had in the bundle as received (its own id when the rewrite did not touch it). */
export const originOf = (entity: SyncEntity): string => origins.get(entity) ?? entity.entityId;

/** For a split entity: the transaction id it named as received. */
const parentOrigins = new WeakMap<SyncEntity, string>();

const rewriteEntity = (entity: SyncEntity, resolve: Resolver): SyncEntity => {
  if (entity.row === null) {
    const entityId = rewriteEntityId(entity.table, entity.entityId, resolve);
    if (entityId === entity.entityId) return entity;
    const next: SyncEntity = { ...entity, entityId };
    origins.set(next, originOf(entity));
    return next;
  }
  const row = rewriteSyncRow(entity.table, entity.row, resolve);
  if (row === null) return entity;
  const entityId = entityIdOf(
    entity.table,
    getTableRegistration(entity.table).primaryKey.map((column) => row[column]),
  );
  const next: SyncEntity = { ...entity, entityId, row: row as SyncRow };
  origins.set(next, originOf(entity));
  if (entity.table === FINANCE_SPLITS) {
    parentOrigins.set(next, parentOriginOf(entity));
  }
  return next;
};

const parentOriginOf = (entity: SyncEntity): string =>
  parentOrigins.get(entity) ?? String(entity.row?.transaction_id ?? "");

export const rewriteChangeSet = (changeSet: SyncChangeSet, resolve: Resolver): SyncChangeSet => {
  let touched = false;
  const entities = changeSet.entities.map((entity) => {
    const next = rewriteEntity(entity, resolve);
    if (next !== entity) touched = true;
    return next;
  });
  const unionRows: Record<string, SyncRow[]> = {};
  for (const table of Object.keys(changeSet.unionRows)) {
    const rows = (getOwn(changeSet.unionRows, table) as SyncRow[]).map((row) => {
      const next = rewriteSyncRow(table, row, resolve);
      if (next !== null) touched = true;
      return (next ?? row) as SyncRow;
    });
    Object.defineProperty(unionRows, table, {
      value: rows,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return touched ? { ...changeSet, entities, unionRows } : changeSet;
};

const orderedByClock = (group: readonly SyncEntity[]): SyncEntity[] =>
  [...group].sort(
    (a, b) =>
      compareHlc(a.rowHlc, b.rowHlc) ||
      (originOf(a) < originOf(b) ? -1 : originOf(a) > originOf(b) ? 1 : 0) ||
      (canonicalJson(a.row) < canonicalJson(b.row)
        ? -1
        : canonicalJson(a.row) > canonicalJson(b.row)
          ? 1
          : 0),
  );

/**
 * Splits entities into rounds in which every (table, entity id) appears once, in the order of their
 * clocks (then of the ids they had as received), so the merge rules decide between versions.
 */
export const splitIntoRounds = (entities: readonly SyncEntity[]): SyncEntity[][] => {
  const groups = new Map<string, SyncEntity[]>();
  for (const entity of entities) {
    const key = `${entity.table}\u0000${entity.entityId}`;
    appendTo(groups, key, entity);
  }
  const rounds: SyncEntity[][] = [];
  for (const group of groups.values()) {
    orderedByClock(group).forEach((entity, index) => {
      (rounds[index] ??= []).push(entity);
    });
  }
  return rounds;
};

/**
 * The finance context of one round when a transaction appears in several: each version gets the
 * splits that named it in the bundle as received, never those of the other version.
 */
export const financeContextForRound = (
  round: readonly SyncEntity[],
  all: readonly SyncEntity[],
): FinanceBundleContext => {
  const splitsByTransaction = new Map<string, SyncEntity[]>();
  const transactionIds = new Set<string>();
  for (const entity of all) {
    if (entity.table === FINANCE_TRANSACTIONS) transactionIds.add(entity.entityId);
  }
  const byOrigin = new Map<string, SyncEntity[]>();
  for (const entity of all) {
    if (entity.table !== FINANCE_SPLITS || entity.row === null) continue;
    const parent = parentOriginOf(entity);
    appendTo(byOrigin, parent, entity);
  }
  for (const entity of round) {
    if (entity.table !== FINANCE_TRANSACTIONS || entity.row === null) continue;
    const children = byOrigin.get(originOf(entity)) ?? [];
    if (children.length > 0) splitsByTransaction.set(entity.entityId, children);
  }
  return { splitsByTransaction, transactionIds };
};
