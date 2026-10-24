import type { Database } from "../storage/sqlite-db";
import type { ReferenceGuard } from "./apply-references";
import { buildFinanceContext, type FinanceBundleContext } from "./apply-finance";
import { type GtdApplyState, loadGtdApplyState } from "./apply-gtd";
import type { PendingConflict, Totals } from "./apply-support";
import type { LoadedAliases } from "./alias-store";
import type { RootMove } from "./aliases";
import type { SyncEntity } from "./change-set";
import type { Resolver } from "./reference-rewrite";

/**
 * What the pieces of canonical identity share while one bundle is applied: the open transaction, the
 * alias classes, the running totals and conflicts, the clock source for invented records and the
 * entry into the normal merge pipeline.
 */

/** What the table appliers of `apply-bundle.ts` need besides the entities. */
export interface ApplyScope {
  gtd: GtdApplyState | null;
  finance: FinanceBundleContext;
  sessionIds: ReadonlySet<string>;
}

/** Applies entities of ONE table through the ordinary merge rules (rows, meta and snapshots). */
export type ApplyEntities = (
  table: string,
  entities: SyncEntity[],
  scope: ApplyScope,
) => Promise<void>;

export interface AliasContext {
  db: Database;
  aliases: LoadedAliases;
  totals: Totals;
  conflicts: PendingConflict[];
  guard: ReferenceGuard;
  applyEntities: ApplyEntities;
  /** The root of an id's alias class (bound to `aliases.index`). */
  resolve: Resolver;
  /**
   * Moves local state from every moved id to its new root (rows, meta, snapshots, references).
   * Set by the orchestrator so reference handlers can start a nested move (an account alias that
   * makes two transactions the same statement line).
   */
  absorb(moves: readonly RootMove[]): Promise<void>;
}

/**
 * A scope for entities the engine feeds into the pipeline on its own (not part of a bundle). The
 * gtd state is fresh on purpose: the bundle's own state caches the set of deleted projects, which
 * must be read after the bundle's projects were applied.
 */
export const scopeFor = async (
  ctx: AliasContext,
  table: string,
  entities: readonly SyncEntity[],
  extra: readonly SyncEntity[] = [],
): Promise<ApplyScope> => ({
  gtd:
    table === "gtd_tasks" || table === "recurring_task_templates"
      ? await loadGtdApplyState(ctx.db, new Set())
      : null,
  finance: buildFinanceContext([...entities, ...extra]),
  sessionIds: new Set(),
});
