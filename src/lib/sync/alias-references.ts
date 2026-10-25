import type { Database } from "../storage/sqlite-db";
import { findKeyHolders } from "./alias-lookup";
import { captureSources, moveThroughPipeline } from "./alias-sources";
import type { AliasContext } from "./alias-context";
import type { RootMove } from "./aliases";
import type { RawRow } from "./capture-decode";
import { chunked, fetchMeta, fetchRows, placeholders } from "./capture-stamp";
import { type ExtraConflict, pendingCollisionId } from "./conflicts";
import { entityIdOf } from "./entity-id";
import { jsonDeepEqual } from "./field-clocks";
import { maxHlcOf } from "./hlc";
import { extraConflictOf, keyConditions } from "./apply-support";
import { keepsPending, type PendingContender } from "./merge-proposal";
import { FINANCE_SUGGESTIONS, FINANCE_TRANSACTIONS } from "./merge-finance";
import { rewriteReferences, rewriteRulesOf, tablesWithRewriteRules } from "./reference-rewrite";
import { aliasKeysOf } from "./registry";
import { refreshSnapshots } from "./snapshot-refresh";
import { readTableInfo, type TableInfo } from "./table-info";
import { quoteIdent } from "./capture-install";

/**
 * Canonical identity, rewriting what points at an id that became an alias, in the local database.
 *
 * For every table that holds a declared reference to the aliased table (the registry's `references`,
 * see `reference-rewrite.ts`), the rows that name an alias are found and rewritten to the canonical
 * id: plain columns, ids inside JSON documents and derived values alike. A rewrite issues NO clock
 * and dirties nothing (it runs with `applying = 1`): the transformation is a pure function of the
 * alias table, so the row keeps its clock, and its snapshot is refreshed to what the stamper would
 * store so a verifying scan finds nothing to stamp.
 *
 * A few tables need more than an UPDATE, because the rewrite can collide with another row:
 *
 * - a primary key built from the reference (`finance_merchant_memory`, `finance_account_balance_snapshots`
 *   keyed by an account id) is re-keyed through the merge pipeline (`alias-sources.ts`), which merges
 *   the row into one that already has the new key by the table's rule;
 * - `finance_transactions`: moving a transaction to the canonical account (and re-deriving its
 *   dedupe hash) can make it the same statement line as a transaction already there. The pair is
 *   recorded as a transaction alias and merged like any other (`ctx.absorb`);
 * - `finance_category_suggestions`: two pending suggestions for one canonical transaction: the later
 *   row clock stays pending, the other is expired with a `pending_collision` (as in
 *   `apply-proposals.ts`);
 * - `gtd_task_events`: a rewritten `dedupe_key` may equal another event's: the smaller id stays (the
 *   union keeps one row per key);
 * - `calendar_sync_links` (device-local): rewritten when the canonical task has no link of its own
 *   for that occurrence.
 */

interface Affected {
  row: RawRow;
  next: RawRow;
}

type Handler = (
  ctx: AliasContext,
  table: string,
  info: TableInfo,
  items: Affected[],
) => Promise<void>;

const CHUNK = 400;

const rowKey = (table: string, info: TableInfo, row: RawRow): string =>
  entityIdOf(
    table,
    info.primaryKey.map((column) => row[column]),
  );

const primaryKeyValues = (info: TableInfo, row: RawRow): unknown[] =>
  info.primaryKey.map((column) => row[column]);

const asNumber = (value: unknown): unknown => (typeof value === "bigint" ? Number(value) : value);

/** Rows of `table` that name one of `aliasIds` (or hold one inside a document), with their rewrite. */
const findAffected = async (
  ctx: AliasContext,
  table: string,
  info: TableInfo,
  target: string,
  aliasIds: readonly string[],
): Promise<Affected[]> => {
  const rules = rewriteRulesOf(table).filter((rule) => rule.target === target);
  const found = new Map<string, Affected>();
  const consider = (row: RawRow): void => {
    const id = rowKey(table, info, row);
    if (found.has(id)) return;
    const next = rewriteReferences(table, row, ctx.resolve);
    if (next !== null) found.set(id, { row, next });
  };

  const plain = new Set(
    rules
      .filter((rule) => ["foreign-key", "soft", "polymorphic"].includes(rule.kind))
      .map((rule) => rule.column),
  );
  for (const column of plain) {
    for (const batch of chunked([...aliasIds], CHUNK)) {
      const rows = await ctx.db.select<RawRow[]>(
        `SELECT * FROM ${quoteIdent(table)} WHERE ${quoteIdent(column)} IN (${placeholders(batch.length)})`,
        batch,
      );
      rows.forEach(consider);
    }
  }
  // Ids inside documents and derived keys cannot be indexed: scan the rows that have the column.
  // (The account hash is re-derived with the account column, which the plain rule above finds.)
  const scanned = new Set(
    rules
      .filter(
        (rule) =>
          (rule.kind === "json-payload" ||
            rule.kind === "json-id-list" ||
            rule.kind === "derived") &&
          rule.derive !== "account-dedupe-hash",
      )
      .map((rule) => rule.column),
  );
  for (const column of scanned) {
    const rows = await ctx.db.select<RawRow[]>(
      `SELECT * FROM ${quoteIdent(table)} WHERE ${quoteIdent(column)} IS NOT NULL`,
    );
    rows.forEach(consider);
  }
  return [...found.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, item]) => item);
};

/** The items again from the database, rewritten with the classes as they are now. */
const reload = async (
  ctx: AliasContext,
  table: string,
  info: TableInfo,
  items: readonly Affected[],
): Promise<Affected[]> => {
  const fresh: Affected[] = [];
  for (const batch of chunked(items, CHUNK)) {
    const rows = await fetchRows(
      ctx.db,
      table,
      info.primaryKey,
      batch.map((item) => primaryKeyValues(info, item.row) as (string | number)[]),
    );
    for (const row of rows) {
      const next = rewriteReferences(table, row, ctx.resolve);
      if (next !== null) fresh.push({ row, next });
    }
  }
  return fresh;
};

const changedColumns = (item: Affected): string[] =>
  Object.keys(item.next).filter(
    (column) => !jsonDeepEqual(asNumber(item.row[column]), asNumber(item.next[column])),
  );

const updateInPlace = async (
  db: Database,
  table: string,
  info: TableInfo,
  item: Affected,
): Promise<void> => {
  const columns = changedColumns(item);
  if (columns.length === 0) return;
  const where = keyConditions(info.primaryKey, columns.length + 1);
  await db.execute(
    `UPDATE ${quoteIdent(table)} SET ${columns
      .map((column, index) => `${quoteIdent(column)} = $${index + 1}`)
      .join(", ")} WHERE ${where.sql}`,
    [...columns.map((column) => item.next[column]), ...primaryKeyValues(info, item.row)],
  );
};

// ---------------------------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------------------------

/** Default: UPDATE in place, or re-key through the pipeline when a key column moved. */
const plainHandler: Handler = async (ctx, table, info, items) => {
  const rekeyed = items.filter((item) =>
    info.primaryKey.some((column) => !jsonDeepEqual(item.row[column], item.next[column])),
  );
  const rekeyedSet = new Set(rekeyed);
  const inPlace = items.filter((item) => !rekeyedSet.has(item));
  for (const item of inPlace) await updateInPlace(ctx.db, table, info, item);
  await refreshSnapshots(
    ctx.db,
    table,
    inPlace.map((item) => rowKey(table, info, item.row)),
  );
  ctx.totals.applied += inPlace.length;
  if (rekeyed.length > 0) {
    const sources = await captureSources(
      ctx,
      table,
      rekeyed.map((item) => rowKey(table, info, item.row)),
    );
    await moveThroughPipeline(ctx, table, sources);
  }
};

/** Moves to another account re-derive the dedupe hash, so two copies of one line can now collide. */
const transactionHandler: Handler = async (ctx, table, info, items) => {
  const key = aliasKeysOf(table)[0];
  const keyChanged = (item: Affected): boolean =>
    key?.columns.some((column) => item.row[column] !== item.next[column]) === true;
  const keyed = items.filter(keyChanged);
  const involved = new Set<string>();
  const moves: RootMove[] = [];

  if (key !== undefined && keyed.length > 0) {
    const holders = await findKeyHolders(
      ctx.db,
      table,
      key,
      keyed.map((item) => ({
        entityId: String(item.row.id),
        values: key.columns.map((column) => item.next[column]),
      })),
    );
    const ids = [...holders].flatMap(([id, others]) => [id, ...others]);
    const metas = await fetchMeta(ctx.db, table, [...new Set(ids)]);
    for (const [id, others] of [...holders].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      for (const other of others) {
        const hlc =
          maxHlcOf([metas.get(id)?.row_hlc, metas.get(other)?.row_hlc]) ??
          (await ctx.guard.freshClock());
        moves.push(...ctx.aliases.index.learn(table, id, other, hlc));
        involved.add(id);
        involved.add(other);
        // A class that already held both ids (a stale local row under an alias) has no new move.
        for (const member of [id, other]) {
          const root = ctx.resolve(table, member);
          if (root !== member)
            moves.push({ entityType: table, id: member, from: member, to: root });
        }
      }
    }
  }
  const inPlace = items.filter((item) => !involved.has(String(item.row.id)));
  if (moves.length > 0) await ctx.absorb(moves);
  // The nested move rewrote references of its own (a transfer group naming the new aliases): work
  // from the rows as they are now, not from the ones read before it.
  await plainHandler(ctx, table, info, await reload(ctx, table, info, inPlace));
};

const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** One pending suggestion per transaction: the later row clock stays pending (`pending_collision`). */
const suggestionHandler: Handler = async (ctx, table, info, items) => {
  const touched = new Set<string>();
  for (const item of items) {
    const id = String(item.row.id);
    let next = item.next;
    if (next.status === "pending") {
      const others = await ctx.db.select<RawRow[]>(
        `SELECT * FROM ${quoteIdent(table)} WHERE transaction_id = $1 AND status = 'pending' AND id <> $2`,
        [next.transaction_id, id],
      );
      if (others.length > 0) {
        const metas = await fetchMeta(ctx.db, table, [
          id,
          ...others.map((other) => String(other.id)),
        ]);
        const contender = (rowId: string): PendingContender => {
          const meta = metas.get(rowId);
          return { id: rowId, clock: meta && meta.deleted_at === null ? meta.row_hlc : null };
        };
        let winner = contender(id);
        for (const other of others) {
          const candidate = contender(String(other.id));
          if (keepsPending(candidate, winner) > 0) winner = candidate;
        }
        const losers: { id: string; row: RawRow }[] = [
          ...(winner.id === id ? [] : [{ id, row: next }]),
          ...others
            .filter((other) => String(other.id) !== winner.id)
            .map((other) => ({ id: String(other.id), row: other })),
        ];
        for (const loser of losers) {
          const conflict: ExtraConflict = {
            id: pendingCollisionId(table, loser.id, winner.id),
            kind: "pending_collision",
            entityType: table,
            entityId: loser.id,
            local: { expired: loser.id, kept: winner.id },
            remote: {
              transactionId: loser.row.transaction_id,
              suggestedCategoryId: loser.row.suggested_category_id,
            },
          };
          ctx.conflicts.push(extraConflictOf(conflict));
          if (loser.id === id) {
            next = { ...next, status: "expired" };
          } else {
            await ctx.db.execute(
              `UPDATE ${quoteIdent(table)} SET status = 'expired' WHERE id = $1`,
              [loser.id],
            );
            touched.add(loser.id);
          }
        }
      }
    }
    await updateInPlace(ctx.db, table, info, { row: item.row, next });
    touched.add(id);
  }
  await refreshSnapshots(ctx.db, table, [...touched]);
  ctx.totals.applied += items.length;
};

/** A rewritten dedupe key may equal another event's: the union keeps one row per key (smaller id). */
const eventHandler: Handler = async (ctx, table, info, items) => {
  for (const item of items) {
    const id = String(item.row.id);
    const key = item.next.dedupe_key;
    if (typeof key === "string") {
      const other = (
        await ctx.db.select<{ id: string }[]>(
          `SELECT id FROM ${quoteIdent(table)} WHERE dedupe_key = $1 AND id <> $2`,
          [key, id],
        )
      )[0];
      if (other !== undefined) {
        const drop = compareIds(other.id, id) < 0 ? id : other.id;
        await ctx.db.execute(`DELETE FROM ${quoteIdent(table)} WHERE id = $1`, [drop]);
        if (drop === id) continue;
      }
    }
    await updateInPlace(ctx.db, table, info, item);
  }
  ctx.totals.applied += items.length;
};

/** Device-local mirror of an external calendar: re-point a link unless the canonical task has one. */
const calendarHandler: Handler = async (ctx, table, info, items) => {
  for (const item of items) {
    const columns = changedColumns(item);
    if (columns.length === 0) continue;
    const where = keyConditions(info.primaryKey, columns.length + 1);
    await ctx.db.execute(
      `UPDATE OR IGNORE ${quoteIdent(table)} SET ${columns
        .map((column, index) => `${quoteIdent(column)} = $${index + 1}`)
        .join(", ")} WHERE ${where.sql}`,
      [...columns.map((column) => item.next[column]), ...primaryKeyValues(info, item.row)],
    );
  }
};

const HANDLERS: Readonly<Record<string, Handler>> = {
  [FINANCE_TRANSACTIONS]: transactionHandler,
  [FINANCE_SUGGESTIONS]: suggestionHandler,
  gtd_task_events: eventHandler,
  calendar_sync_links: calendarHandler,
};

/**
 * Rewrites every local reference to the aliases `aliasIds` of `target`. Idempotent: rows that no
 * longer name an alias are not found.
 */
export const rewriteLocalReferences = async (
  ctx: AliasContext,
  target: string,
  aliasIds: readonly string[],
): Promise<void> => {
  for (const table of tablesWithRewriteRules()) {
    if (!rewriteRulesOf(table).some((rule) => rule.target === target)) continue;
    const info = await readTableInfo(ctx.db, table);
    const items = await findAffected(ctx, table, info, target, aliasIds);
    if (items.length === 0) continue;
    await (HANDLERS[table] ?? plainHandler)(ctx, table, info, items);
  }
};

/**
 * Rewrites the sidecar rows that name an alias by entity id: unresolved conflicts of the entity.
 * (Marks in `sync_dirty` of a moved entity are removed with the entity; meta and snapshot move with
 * it, see `alias-sources.ts`.)
 */
export const rewriteSidecars = async (
  ctx: AliasContext,
  entityType: string,
  moves: readonly RootMove[],
): Promise<void> => {
  const ids = [...new Set(moves.map((move) => move.id))];
  for (const batch of chunked(ids, CHUNK)) {
    const rows = await ctx.db.select<{ entity_id: string }[]>(
      `SELECT DISTINCT entity_id FROM sync_conflicts WHERE entity_type = $1 AND entity_id IN (${placeholders(batch.length, 2)})`,
      [entityType, ...batch],
    );
    for (const row of rows) {
      await ctx.db.execute(
        "UPDATE sync_conflicts SET entity_id = $1 WHERE entity_type = $2 AND entity_id = $3",
        [ctx.resolve(entityType, row.entity_id), entityType, row.entity_id],
      );
    }
  }
};
