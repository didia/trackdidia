import type { RawRow } from "./capture-decode";
import { terminalDivergenceId } from "./conflicts";
import { compareHlc } from "./hlc";
import { mergeTerminalBeatsPending } from "./merge-primitives";
import type { LiveVersion, RowRules } from "./merge-row";

/**
 * Merge rules of `ai_proposals` (class `monotonic-status`), layered on `merge-row.ts`.
 *
 * Capture stamps a proposal as a whole row (one `row_hlc`), so the merge is whole-row too; the one
 * thing that is not time is the status:
 *
 * - a TERMINAL status (`accepted`, `dismissed`, `expired`) beats `pending` whatever the clocks say,
 *   and brings its whole row (`decided_at` and `applied_entity_id` describe that decision);
 * - two DIFFERENT terminal statuses are a divergence nobody can pick by time. The winner is the
 *   smaller status string, the deterministic answer of `mergeTerminalBeatsPending` (`accepted`
 *   before `dismissed` before `expired`, which is also the order of consequence: an accepted
 *   proposal already changed data), and an unresolved `terminal_divergence` conflict with a
 *   deterministic id records both rows for the user;
 * - the same status on both sides, or two pending rows: the later clock, then the smaller JSON;
 * - a terminal row also beats any tombstone, whatever the clocks (`survivesDelete`): the app only
 *   ever deletes pending proposals, so a delete racing a decision means the decision was not seen.
 *
 * Pending proposals that claim one natural key are handled by the apply layer
 * (`apply-proposals.ts`), because it needs the database; {@link keepsPending} is its pure order.
 */

export const PROPOSAL_TERMINAL_STATUSES = ["accepted", "dismissed", "expired"] as const;

export const isTerminalProposalStatus = (status: unknown): boolean =>
  typeof status === "string" && (PROPOSAL_TERMINAL_STATUSES as readonly string[]).includes(status);

const statusOf = (row: RawRow): string => String(row.status ?? "");

export const PROPOSAL_RULES: RowRules = {
  // A decided proposal is a user decision that already had effects: a delete (which only ever
  // targets pending rows) must not erase it, whatever the clocks say.
  survivesDelete: (row) => isTerminalProposalStatus(row.status),
  rank: (a: LiveVersion, b: LiveVersion): number => {
    const left = statusOf(a.row);
    const right = statusOf(b.row);
    const leftTerminal = isTerminalProposalStatus(left);
    const rightTerminal = isTerminalProposalStatus(right);
    if (leftTerminal !== rightTerminal) return leftTerminal ? 1 : -1;
    if (leftTerminal && left !== right) {
      const merged = mergeTerminalBeatsPending(left, right, PROPOSAL_TERMINAL_STATUSES);
      return merged.status === left ? 1 : -1;
    }
    return 0;
  },
  conflictsFor: (local, remote) => {
    const left = statusOf(local);
    const right = statusOf(remote);
    if (!isTerminalProposalStatus(left) || !isTerminalProposalStatus(right) || left === right) {
      return [];
    }
    const id = String(local.id ?? remote.id ?? "");
    return [
      {
        id: terminalDivergenceId("ai_proposals", id, null),
        kind: "terminal_divergence",
        entityType: "ai_proposals",
        entityId: id,
        local,
        remote,
      },
    ];
  },
};

export interface PendingContender {
  id: string;
  /** The row clock of the pending proposal (`null`: never stamped, loses to any clock). */
  clock: string | null;
}

/**
 * Positive when `a` keeps the pending slot of a natural key and `b` must be expired: the later row
 * clock, then the greater id. A total order on distinct ids, so every replica expires the same
 * rows whatever order the proposals arrive in.
 */
export const keepsPending = (a: PendingContender, b: PendingContender): number => {
  if (a.clock !== b.clock) {
    if (a.clock === null) return -1;
    if (b.clock === null) return 1;
    return compareHlc(a.clock, b.clock);
  }
  return a.id === b.id ? 0 : a.id > b.id ? 1 : -1;
};
