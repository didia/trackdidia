import type { RawRow } from "./capture-decode";
import { setOwn } from "./field-clocks";
import type { RowRules } from "./merge-row";

/**
 * Merge rules of the two Pomodoro tables, layered on the whole-row merge of `merge-row.ts`.
 *
 * Only TERMINAL sessions (`completed` / `cancelled`) and their segments are ever published or
 * applied (`row-filter.ts`), so every version that meets another here is a finished record: a
 * terminal session is immutable in practice (the app never edits one), and so are its segments. The
 * rules below only decide what happens when two versions of one record differ anyway (a peer that
 * edited the database by hand, a bug):
 *
 * - session: whole-row last-writer-wins. The later clock brings every column; the loser is logged
 *   as an `overwritten_edit` of the whole row. Equal clocks: the smaller canonical JSON.
 * - segment: whole-row last-writer-wins, except `ended_at`, which is JOINED across both versions:
 *   a non-null end beats a missing one (a segment is closed once), and two different ends keep the
 *   later timestamp. Joining makes the result independent of which version was newer and of the
 *   order three replicas meet in.
 * - delete against edit: the later clock wins; an edit as late as the delete keeps the row (edit
 *   wins over delete), as for every other entity.
 */

export const SESSION_RULES: RowRules = { reportOverwrites: true };

const endOf = (row: RawRow): string | null => {
  const value = row.ended_at;
  return typeof value === "string" && value !== "" ? value : null;
};

/** The later of two ends; a present end beats none. Associative, commutative, idempotent. */
export const joinEndedAt = (a: string | null, b: string | null): string | null => {
  if (a === null) return b;
  if (b === null) return a;
  return a >= b ? a : b;
};

export const SEGMENT_RULES: RowRules = {
  joined: ["ended_at"],
  reportOverwrites: true,
  absorb: (winner, loser) => {
    // A sender on an older schema may not carry the column at all: then the local value stays.
    if (!Object.hasOwn(winner, "ended_at") && !Object.hasOwn(loser, "ended_at")) return winner;
    const joined = joinEndedAt(endOf(winner), endOf(loser));
    const row = { ...winner };
    setOwn(row, "ended_at", joined ?? winner.ended_at ?? null);
    return row;
  },
};
