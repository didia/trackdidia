import type { Database } from "../storage/sqlite-db";
import { scopeFor, type AliasContext } from "./alias-context";
import type { RawRow } from "./capture-decode";
import { fetchSplitsOf } from "./capture-finance";
import { quoteIdent } from "./capture-install";
import {
  chunked,
  emptyOutcome,
  fetchMeta,
  fetchRows,
  type MetaRow,
  parseClocks,
  placeholders,
  writeOutcome,
} from "./capture-stamp";
import { appendTo, longestList } from "./collections";
import { keyConditions, rowsById } from "./apply-support";
import type { SyncEntity } from "./change-set";
import { entityIdOf, parseEntityId, type PrimaryKeyValue } from "./entity-id";
import { BASELINE_CLOCK } from "./merge-entity";
import { FINANCE_SPLITS, FINANCE_TRANSACTIONS } from "./merge-finance";
import { rewriteEntityId, rewriteSyncRow } from "./reference-rewrite";
import { readTableInfo, toSyncRow } from "./table-info";

/**
 * Moving local rows to a new entity id THROUGH the ordinary merge pipeline.
 *
 * When an id becomes an alias, or a primary key that is built from a reference changes
 * (`finance_merchant_memory` keyed by an account id), the local state of the old id must end up
 * under the new one, merged with whatever already lives there by the table's normal rule "as if the
 * two had always been one row". The engine does that without a second implementation of any merge
 * rule:
 *
 * 1. the old state (row, clocks, children) is CAPTURED as an entity of the new id, with its
 *    references rewritten through the alias classes;
 * 2. the old row, meta and snapshot are REMOVED (no tombstone: the entity did not die, it moved);
 * 3. the captured entities are FED to the applier of the table as if a peer had sent them. The
 *    applier inserts them (a plain rename: same clocks, same row) or merges them into the row that
 *    already holds the new id (field clocks, row clock, lifecycle tuple, categorization unit with
 *    its splits as a set...), and writes meta and snapshot exactly as for a bundle.
 *
 * No clock is issued: a captured entity carries the clocks the old row had. Two sources for one
 * target are applied one after the other in the order of their old ids, so the result does not
 * depend on which replica does it.
 */

export interface CapturedSource {
  table: string;
  oldId: string;
  /** Where the entity lives afterwards (may equal `oldId` for a row that only had references fixed). */
  newId: string;
  /** The entity to feed to the applier; `null` for a stray meta row that only has to go. */
  entity: SyncEntity | null;
  /** True when rewriting references changed the row, or its id moved. */
  changed: boolean;
  /** Transactions only: the splits as entities of the new transaction id. */
  children: SyncEntity[];
  /** Transactions only: the stored split rows (to delete what the merge did not move). */
  childRows: RawRow[];
}

const chunkSize = 400;

/** The stored state of entities by id (`row`/`meta` are absent when there is none). */
export const readLocalStates = async (
  db: Database,
  table: string,
  ids: readonly string[],
): Promise<Map<string, { row: RawRow | null; meta: MetaRow | undefined }>> => {
  const info = await readTableInfo(db, table);
  const states = new Map<string, { row: RawRow | null; meta: MetaRow | undefined }>();
  for (const batch of chunked([...ids], chunkSize)) {
    const keys = batch.map((id) => parseEntityId(table, id) as PrimaryKeyValue[]);
    const rows = rowsById(table, info, await fetchRows(db, table, info.primaryKey, keys));
    const metas = await fetchMeta(db, table, batch);
    for (const id of batch) {
      const row = rows.get(id) ?? null;
      const meta = metas.get(id);
      if (row !== null || meta !== undefined) states.set(id, { row, meta });
    }
  }
  return states;
};

/** Captures the local state of `ids` as entities of their rewritten ids. Absent ids are skipped. */
export const captureSources = async (
  ctx: AliasContext,
  table: string,
  ids: readonly string[],
): Promise<CapturedSource[]> => {
  if (ids.length === 0) return [];
  const info = await readTableInfo(ctx.db, table);
  const sorted = [...new Set(ids)].sort();
  const states = await readLocalStates(ctx.db, table, sorted);

  const splitRows = new Map<string, RawRow[]>();
  const splitMetas = new Map<string, MetaRow>();
  if (table === FINANCE_TRANSACTIONS) {
    for (const batch of chunked(sorted, chunkSize)) {
      for (const [id, rows] of await fetchSplitsOf(ctx.db, batch)) splitRows.set(id, rows);
    }
    const splitIds = [...splitRows.values()].flat().map((row) => String(row.id));
    for (const batch of chunked(splitIds, chunkSize)) {
      for (const [id, meta] of await fetchMeta(ctx.db, FINANCE_SPLITS, batch)) {
        splitMetas.set(id, meta);
      }
    }
  }

  const sources: CapturedSource[] = [];
  for (const oldId of sorted) {
    const state = states.get(oldId);
    if (state === undefined) continue;
    const { row, meta } = state;
    if (row === null) {
      const tombstone = meta !== undefined && meta.deleted_at !== null;
      sources.push({
        table,
        oldId,
        newId: rewriteEntityId(table, oldId, ctx.resolve),
        entity: tombstone
          ? {
              table,
              entityId: rewriteEntityId(table, oldId, ctx.resolve),
              row: null,
              fieldClocks: parseClocks(meta.field_clocks_json),
              rowHlc: meta.row_hlc,
              deletedAt: meta.deleted_at,
            }
          : null,
        // A tombstone or stray meta row only has to move when its id does.
        changed: rewriteEntityId(table, oldId, ctx.resolve) !== oldId,
        children: [],
        childRows: [],
      });
      continue;
    }
    const rewritten = rewriteSyncRow(table, row, ctx.resolve);
    const next = rewritten ?? row;
    const newId = entityIdOf(
      table,
      info.primaryKey.map((column) => next[column]),
    );
    const children = (splitRows.get(oldId) ?? []).map(
      (child): SyncEntity => ({
        table: FINANCE_SPLITS,
        entityId: String(child.id),
        row: toSyncRow({ ...child, transaction_id: newId }),
        fieldClocks: {},
        rowHlc: splitMetas.get(String(child.id))?.row_hlc ?? BASELINE_CLOCK,
        deletedAt: null,
      }),
    );
    sources.push({
      table,
      oldId,
      newId,
      entity: {
        table,
        entityId: newId,
        row: toSyncRow(next),
        fieldClocks: meta === undefined ? {} : parseClocks(meta.field_clocks_json),
        rowHlc: meta?.row_hlc ?? BASELINE_CLOCK,
        deletedAt: null,
      },
      changed: rewritten !== null || newId !== oldId,
      children,
      childRows: splitRows.get(oldId) ?? [],
    });
  }
  return sources;
};

/** Deletes the old row, meta, snapshot and dirty mark of every source (no tombstone is left). */
const removeSources = async (
  ctx: AliasContext,
  table: string,
  sources: readonly CapturedSource[],
): Promise<void> => {
  const info = await readTableInfo(ctx.db, table);
  const outcome = emptyOutcome();
  for (const source of sources) {
    await ctx.db.execute(
      `DELETE FROM ${quoteIdent(table)} WHERE ${keyConditions(info.primaryKey, 1).sql}`,
      parseEntityId(table, source.oldId) as PrimaryKeyValue[],
    );
    outcome.metaDeletes.push(source.oldId);
    outcome.snapshotDeletes.push(source.oldId);
  }
  await writeOutcome(ctx.db, table, outcome);
  for (const batch of chunked(
    sources.map((source) => source.oldId),
    chunkSize,
  )) {
    await ctx.db.execute(
      `DELETE FROM sync_dirty WHERE entity_type = $1 AND entity_id IN (${placeholders(batch.length, 2)})`,
      [table, ...batch],
    );
  }
};

/** Deletes split rows (with meta and snapshot) that the merge of a moved transaction did not keep. */
const dropLeftoverSplits = async (
  ctx: AliasContext,
  sources: readonly CapturedSource[],
): Promise<void> => {
  const info = await readTableInfo(ctx.db, FINANCE_SPLITS);
  const outcome = emptyOutcome();
  for (const source of sources) {
    if (source.newId === source.oldId) continue;
    for (const child of source.childRows) {
      const id = String(child.id);
      // Still under the old transaction: the winning unit did not take it along.
      const stored = await ctx.db.select<{ transaction_id: string }[]>(
        `SELECT transaction_id FROM ${quoteIdent(FINANCE_SPLITS)} WHERE ${keyConditions(info.primaryKey, 1).sql}`,
        [id],
      );
      if (stored[0] === undefined || stored[0].transaction_id !== source.oldId) continue;
      await ctx.db.execute(
        `DELETE FROM ${quoteIdent(FINANCE_SPLITS)} WHERE ${keyConditions(info.primaryKey, 1).sql}`,
        [id],
      );
      outcome.metaDeletes.push(id);
      outcome.snapshotDeletes.push(id);
    }
  }
  await writeOutcome(ctx.db, FINANCE_SPLITS, outcome);
};

/**
 * Removes the sources and feeds their entities to the table's applier, one round per extra source of
 * a target. See the module comment.
 */
export const moveThroughPipeline = async (
  ctx: AliasContext,
  table: string,
  sources: readonly CapturedSource[],
): Promise<void> => {
  if (sources.length === 0) return;
  await removeSources(ctx, table, sources);

  const groups = new Map<string, CapturedSource[]>();
  for (const source of sources) {
    if (source.entity === null) continue;
    appendTo(groups, source.newId, source);
  }
  const rounds = longestList(groups.values());
  for (let round = 0; round < rounds; round += 1) {
    const batch = [...groups.values()].flatMap((group) => (group[round] ? [group[round]] : []));
    const entities = batch.map((source) => source.entity as SyncEntity);
    await ctx.applyEntities(
      table,
      entities,
      await scopeFor(
        ctx,
        table,
        entities,
        batch.flatMap((source) => source.children),
      ),
    );
  }
  if (table === FINANCE_TRANSACTIONS) await dropLeftoverSplits(ctx, sources);
};
