import type { Database } from "../storage/sqlite-db";
import { rewriteChangeSet } from "./alias-decode";
import { findKeyHolders } from "./alias-lookup";
import { rewriteLocalReferences, rewriteSidecars } from "./alias-references";
import { loadAliases, persistAliases } from "./alias-store";
import type { AliasContext, ApplyEntities } from "./alias-context";
import { captureSources, moveThroughPipeline } from "./alias-sources";
import { compareIds, type RootMove } from "./aliases";
import { appendTo, without } from "./collections";
import type { ReferenceGuard } from "./apply-references";
import type { PendingConflict, Totals } from "./apply-support";
import { fetchMeta } from "./capture-stamp";
import type { SyncChangeSet } from "./change-set";
import { maxHlcOf } from "./hlc";
import { quoteIdent } from "./capture-install";
import { rewriteRulesOf, tablesWithRewriteRules } from "./reference-rewrite";
import { aliasableTables, aliasKeysOf, getTableRegistration } from "./registry";
import { tableOrder } from "./merge-strategies";

/**
 * Canonical identity: the alias engine that runs FIRST when a bundle is applied, in the same
 * transaction as the merge (spec: "Natural keys and canonical identity").
 *
 * Two peers can mint different ids for one entity (the same CSV imported on two laptops: two
 * transactions with one `(account_id, dedupe_hash)`; the same relationship draw; the same account
 * import label). Applying the peer's row by id would hit the unique index and used to abort the
 * bundle. Instead, before any entity of the bundle is merged:
 *
 * 1. The bundle's own `aliases` are learned. The alias classes (`aliases.ts`) keep one ROOT per
 *    class, the smallest id, whatever order pairs are learned in.
 * 2. Every local id that stopped being a root is MOVED to its root (`absorbMoves`): the local row,
 *    its clocks and children are merged into the root's by the table's normal rule, as if the two
 *    had always been one row (`alias-sources.ts`), and every reference in the database is rewritten
 *    (`alias-references.ts`).
 * 3. The bundle is rewritten through the classes (`alias-decode.ts`): ids, keys, references.
 * 4. For each aliasable table, the bundle's live rows are looked up by each declared natural key
 *    (`alias-lookup.ts`). A local row with a DIFFERENT id denotes the same entity: the pair is
 *    learned (recorded clock = the later of the two rows' row clocks, a function of the data, not of
 *    which replica notices), the local side is moved if it is the larger id, and the bundle is
 *    rewritten again. Tables are visited in registry order, so an account alias rewrites the
 *    account ids of the bundle's transactions BEFORE their natural keys are compared.
 * 5. The classes are written to `sync_id_aliases`.
 *
 * Everything runs with `applying = 1`: no clock is issued for a rewrite, nothing is marked dirty,
 * and every row, meta and snapshot the engine touches ends exactly as the stamper would store it.
 * Re-applying the same bundle finds nothing to do.
 *
 * What stays an abort: a unique violation on a key the registry does not declare, and one on a
 * declared key that the alias path cannot resolve (`natural_key_collision`, e.g. an edit that moves
 * a row onto a key held by a row the bundle never named).
 */

export interface IdentityArgs {
  db: Database;
  changeSet: SyncChangeSet;
  guard: ReferenceGuard;
  totals: Totals;
  conflicts: PendingConflict[];
  applyEntities: ApplyEntities;
}

/** Moves of one entity type grouped and ordered the way the registry orders tables. */
export const groupByType = (moves: readonly RootMove[]): [string, RootMove[]][] => {
  const byType = new Map<string, RootMove[]>();
  for (const move of moves) appendTo(byType, move.entityType, move);
  return [...byType].sort(([a], [b]) => tableOrder(a) - tableOrder(b));
};

const absorbType = async (
  ctx: AliasContext,
  type: string,
  moves: readonly RootMove[],
): Promise<void> => {
  // The classes may have grown since the moves were computed: always ask for the current root.
  const aliasIds = [...new Set(moves.map((move) => move.id))]
    .filter((id) => ctx.resolve(type, id) !== id)
    .sort(compareIds);
  if (aliasIds.length === 0) return;
  const aliasSet = new Set(aliasIds);
  const roots = [...new Set(aliasIds.map((id) => ctx.resolve(type, id)))].sort(compareIds);

  const fromAliases = await captureSources(ctx, type, aliasIds);
  // The root's own row is re-fed only when rewriting changed it (its references or its key): then it
  // must be merged with the rows moving in under the new key, or two rows would collide.
  const fromRoots = (await captureSources(ctx, type, without(roots, aliasSet))).filter(
    (source) => source.changed && source.entity !== null,
  );
  await moveThroughPipeline(ctx, type, [...fromAliases, ...fromRoots]);
  await rewriteLocalReferences(ctx, type, aliasIds);
  await rewriteSidecars(ctx, type, moves);
};

export const absorbMoves = async (ctx: AliasContext, moves: readonly RootMove[]): Promise<void> => {
  for (const [type, list] of groupByType(moves)) {
    await absorbType(ctx, type, list);
  }
};

/** Pairs learned for the bundle's live rows that share a declared natural key with a local row. */
const detectCollisions = async (
  ctx: AliasContext,
  changeSet: SyncChangeSet,
  table: string,
): Promise<RootMove[]> => {
  const entities = changeSet.entities.filter(
    (entity) => entity.table === table && entity.row !== null,
  );
  if (entities.length === 0) return [];
  const byId = new Map(entities.map((entity) => [entity.entityId, entity]));

  const pairs: { id: string; other: string; hlc?: string }[] = [];
  for (const key of aliasKeysOf(table)) {
    // Two entities of the bundle itself that share a key (rewriting an account id re-derives the
    // hash of its transactions, which can make two lines of one sender the same line).
    const byTuple = new Map<string, typeof entities>();
    for (const entity of entities) {
      const values = key.columns.map((column) => (entity.row as Record<string, unknown>)[column]);
      if (values.some((value) => value === null || value === undefined)) continue;
      const tuple = JSON.stringify(values);
      appendTo(byTuple, tuple, entity);
    }
    for (const group of byTuple.values()) {
      const distinct = [...new Map(group.map((entity) => [entity.entityId, entity])).values()].sort(
        (a, b) => compareIds(a.entityId, b.entityId),
      );
      for (const other of distinct.slice(1)) {
        const first = distinct[0] as (typeof distinct)[number];
        pairs.push({
          id: other.entityId,
          other: first.entityId,
          hlc: maxHlcOf([other.rowHlc, first.rowHlc]) as string,
        });
      }
    }
    const holders = await findKeyHolders(
      ctx.db,
      table,
      key,
      entities.map((entity) => ({
        entityId: entity.entityId,
        values: key.columns.map((column) => (entity.row as Record<string, unknown>)[column]),
      })),
    );
    for (const [id, others] of holders) {
      for (const other of others) pairs.push({ id, other });
    }
  }
  if (pairs.length === 0) return [];

  const metas = await fetchMeta(ctx.db, table, [...new Set(pairs.map((pair) => pair.other))]);
  const moves: RootMove[] = [];
  const ordered = pairs.sort(
    (a, b) =>
      compareIds([a.id, a.other].sort()[0] as string, [b.id, b.other].sort()[0] as string) ||
      compareIds([a.id, a.other].sort()[1] as string, [b.id, b.other].sort()[1] as string),
  );
  for (const pair of ordered) {
    const { id, other } = pair;
    // The later of the two row clocks: a clock some device issued (so `hlcHigh` covers it) and a
    // function of the data, not of a clock this replica issues. Replicas that meet the pair in
    // different states may record different values; a class keeps the largest (`aliases.ts`), so
    // they agree once they have exchanged.
    const hlc =
      pair.hlc ??
      maxHlcOf([byId.get(id)?.rowHlc, metas.get(other)?.row_hlc]) ??
      (await ctx.guard.freshClock());
    moves.push(...ctx.aliases.index.learn(table, id, other, hlc));
    // A class that already held both (a local row left under an alias id) learns nothing new but
    // still has local state to move.
    for (const member of [id, other]) {
      const root = ctx.resolve(table, member);
      if (root !== member) moves.push({ entityType: table, id: member, from: member, to: root });
    }
  }
  return moves;
};

/**
 * Local writes after aliasing are not prevented at the database level: a screen that still holds the
 * old id, or a write that was in flight when the alias arrived, can leave a row under an alias id or
 * a reference to one. Left alone it would be published, rewritten by every receiver and, next to the
 * canonical row, hard to merge. So before each apply the engine looks for exactly that, with one
 * indexed lookup per declared plain reference, and moves what it finds to the canonical id like a
 * newly learned alias. (Ids inside JSON documents and derived keys are not swept: they are rewritten
 * when the alias is learned, and every receiver rewrites them again on decode.)
 */
const healStaleLocalState = async (ctx: AliasContext): Promise<void> => {
  const stale: RootMove[] = [];
  for (const type of aliasableTables()) {
    if (!ctx.aliases.index.hasAliases(type)) continue;
    const known = "(SELECT alias_id FROM sync_id_aliases WHERE entity_type = $1)";
    const ids = new Set<string>();
    const pk = quoteIdent(getTableRegistration(type).primaryKey[0] as string);
    for (const sql of [
      `SELECT ${pk} AS id FROM ${quoteIdent(type)} WHERE ${pk} IN ${known}`,
      `SELECT entity_id AS id FROM sync_entity_meta WHERE entity_type = $1 AND entity_id IN ${known}`,
    ]) {
      for (const row of await ctx.db.select<{ id: string }[]>(sql, [type])) ids.add(row.id);
    }
    for (const child of tablesWithRewriteRules()) {
      for (const rule of rewriteRulesOf(child)) {
        if (rule.target !== type || !["foreign-key", "soft", "polymorphic"].includes(rule.kind)) {
          continue;
        }
        const column = quoteIdent(rule.column);
        for (const row of await ctx.db.select<{ id: string }[]>(
          `SELECT DISTINCT ${column} AS id FROM ${quoteIdent(child)} WHERE ${column} IN ${known}`,
          [type],
        )) {
          ids.add(row.id);
        }
      }
    }
    for (const id of ids) {
      const root = ctx.resolve(type, id);
      if (root !== id) stale.push({ entityType: type, id, from: id, to: root });
    }
  }
  await ctx.absorb(stale);
};

/**
 * Runs the engine on `changeSet` and returns the change set to merge: aliases learned, local state
 * moved, ids and references rewritten.
 */
export const resolveCanonicalIdentity = async (args: IdentityArgs): Promise<SyncChangeSet> => {
  const { db, guard, totals, conflicts, applyEntities } = args;
  const aliases = await loadAliases(db);
  const ctx: AliasContext = {
    db,
    aliases,
    totals,
    conflicts,
    guard,
    applyEntities,
    resolve: (entityType, id) => aliases.index.resolve(entityType, id),
    absorb: (moves) => absorbMoves(ctx, moves),
  };

  // 0. Local state that still names an alias (a stale write after the alias was learned).
  await healStaleLocalState(ctx);

  // 1-2. The bundle's own aliases.
  const incoming: RootMove[] = [];
  for (const alias of [...args.changeSet.aliases].sort(
    (a, b) => compareIds(a.entity_type, b.entity_type) || compareIds(a.alias_id, b.alias_id),
  )) {
    incoming.push(
      ...aliases.index.learn(
        alias.entity_type,
        alias.alias_id,
        alias.canonical_id,
        alias.recorded_hlc,
      ),
    );
  }
  await ctx.absorb(incoming);

  // 3. Alias on decode.
  let changeSet = aliases.index.isEmpty()
    ? args.changeSet
    : rewriteChangeSet(args.changeSet, ctx.resolve);

  // 4. Natural keys, table by table.
  for (const table of aliasableTables().sort((a, b) => tableOrder(a) - tableOrder(b))) {
    const moves = await detectCollisions(ctx, changeSet, table);
    if (moves.length === 0) continue;
    await ctx.absorb(moves);
    changeSet = rewriteChangeSet(changeSet, ctx.resolve);
  }

  // 5. Persist the classes.
  totals.applied += await persistAliases(db, aliases);
  return changeSet;
};
