import { hash128 } from "../finance/hash";

/**
 * Conflicts the merge rules raise besides the generic `overwritten_edit` (which `merge-entity.ts`
 * builds from a lost field). Pure data and deterministic ids, shared by every merge module.
 *
 * Every id is a function of what the conflict is ABOUT, never of when it was found, so the same
 * conflict found again (a bundle applied twice, a peer republishing, another replica meeting the
 * same pair) is the same `sync_conflicts` row (`ON CONFLICT(id) DO NOTHING`) and a conflict the user
 * already resolved is never raised again.
 *
 * - `terminal_divergence`: two different terminal states met (complete vs cancel, accepted vs
 *   dismissed). Needs the user; unresolved until they settle it.
 * - `orphaned_child`: informational. A child row would have been inserted for a parent that is
 *   deleted or unknown here, so it was kept deleted or skipped instead of violating the foreign key.
 * - `pending_collision`: informational. Two pending rows claimed one natural key; the earlier one
 *   was expired so the partial unique index holds.
 * - `name_collision`: a context was renamed (or created) with a name another context already has.
 *   The local name stays and the conflict stays unresolved until the user settles it.
 */
export type ExtraConflictKind =
  | "terminal_divergence"
  | "orphaned_child"
  | "pending_collision"
  | "name_collision";

export interface ExtraConflict {
  id: string;
  kind: ExtraConflictKind;
  entityType: string;
  entityId: string;
  local: unknown;
  remote: unknown;
}

/**
 * Deterministic id of a `terminal_divergence` conflict: one per task (or per occurrence of a
 * recurring task). A task can only become terminal once, so the same divergence found again (the
 * bundle is applied twice, or republished) is the same row, and a divergence the user already
 * resolved is never raised again.
 */
export const terminalDivergenceId = (
  entityType: string,
  entityId: string,
  occurrence: string | null,
): string => `terminal-divergence:${hash128(JSON.stringify([entityType, entityId, occurrence]))}`;

/** One `orphaned_child` conflict per child row, whichever parent or bundle caused it. */
export const orphanedChildId = (entityType: string, entityId: string): string =>
  `orphaned-child:${hash128(JSON.stringify([entityType, entityId]))}`;

/** One `pending_collision` conflict per (expired loser, kept winner) pair. */
export const pendingCollisionId = (entityType: string, loserId: string, winnerId: string): string =>
  `pending-collision:${hash128(JSON.stringify([entityType, loserId, winnerId]))}`;

/** One `name_collision` conflict per (context, contested name): found again it is the same row. */
export const nameCollisionId = (entityType: string, entityId: string, name: string): string =>
  `name-collision:${hash128(JSON.stringify([entityType, entityId, name]))}`;
