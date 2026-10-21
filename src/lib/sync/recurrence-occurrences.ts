import { compareHlc } from "./hlc";

/**
 * Recurring occurrences, pure (no SQL).
 *
 * A recurring task is ONE row (`recurring-task:<templateId>`) advanced in place, so the row id is
 * not an occurrence. Sync therefore models the row as a sequence of occurrences kept in two
 * `gtd`-domain sidecar tables:
 *
 * - `sync_recurrence_occurrences(template_id, due_date, outcome, outcome_hlc, device_id)`: what
 *   happened to the occurrence due on `due_date`;
 * - `sync_recurrence_clears(template_id, cleared_through_date)`: the latest due date whose missed
 *   backlog the user acknowledged (`clearPastRecurrences`), a plain max.
 *
 * Both are joins of a semilattice, so a bundle can be applied in any order, any number of times.
 * The instance row's `recurrence_due_date`, lifecycle and `pending_past_recurrences`, and the
 * template's `last_generated_for_date`, are RECOMPUTED from them after every merge (`merge-task.ts`),
 * never merged field by field.
 */

export const OCCURRENCE_OUTCOMES = ["active", "completed", "cancelled", "missed"] as const;
export type OccurrenceOutcome = (typeof OCCURRENCE_OUTCOMES)[number];

/** One `sync_recurrence_occurrences` row, camelCased. */
export interface OccurrenceRecord {
  templateId: string;
  dueDate: string;
  outcome: OccurrenceOutcome;
  /** Clock of the stamp that recorded the outcome (`baseline` clock for a virtual record). */
  outcomeHlc: string;
  /** The device that produced the outcome, not a reference. */
  deviceId: string;
}

/** What a template's merged sidecars say: every occurrence plus the clear watermark. */
export interface TemplateRecurrence {
  occurrences: readonly OccurrenceRecord[];
  clearedThroughDate: string | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A local calendar date key, `YYYY-MM-DD`, that exists on the calendar. */
export const isCalendarDateKey = (value: unknown): value is string => {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
};

export const isOccurrenceOutcome = (value: unknown): value is OccurrenceOutcome =>
  typeof value === "string" && (OCCURRENCE_OUTCOMES as readonly string[]).includes(value);

/** `completed` and `cancelled` are decisions of the user; `active` and `missed` are bookkeeping. */
export const isUserOutcome = (outcome: OccurrenceOutcome): boolean =>
  outcome === "completed" || outcome === "cancelled";

/** The occurrence outcome that a task `status` records. Anything but a terminal status is active. */
export const outcomeOfStatus = (status: unknown): OccurrenceOutcome =>
  status === "completed" || status === "cancelled" ? status : "active";

const rank = (outcome: OccurrenceOutcome): number =>
  isUserOutcome(outcome) ? 2 : outcome === "missed" ? 1 : 0;

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Total order on the records of ONE occurrence; the greater one is the merged record. Positive
 * when `a` beats `b`.
 *
 * 1. A user outcome beats `missed`, which beats `active`, whatever the clocks say: the user acted
 *    on the occurrence, and generation only ever passes a still-active occurrence over.
 * 2. Same rank: the later `outcome_hlc` wins. For `completed` against `cancelled` this is the
 *    deterministic PROVISIONAL winner (the later decision), and the pair is reported as a
 *    `terminal_divergence` conflict for the user to settle.
 * 3. Equal clocks: `completed` before `cancelled`, then the larger device id, so the result never
 *    depends on argument order.
 */
export const compareOccurrence = (a: OccurrenceRecord, b: OccurrenceRecord): number =>
  rank(a.outcome) - rank(b.outcome) ||
  compareHlc(a.outcomeHlc, b.outcomeHlc) ||
  Number(a.outcome === "completed") - Number(b.outcome === "completed") ||
  compareText(a.deviceId, b.deviceId);

/** The record that survives a merge of two records of the same occurrence. */
export const joinOccurrence = (a: OccurrenceRecord, b: OccurrenceRecord): OccurrenceRecord =>
  compareOccurrence(a, b) >= 0 ? a : b;

/** True when two records of one occurrence are different decisions of the user (complete vs cancel). */
export const isTerminalDivergence = (a: OccurrenceRecord, b: OccurrenceRecord): boolean =>
  isUserOutcome(a.outcome) && isUserOutcome(b.outcome) && a.outcome !== b.outcome;

/** Latest due date among the records, or `null` when there are none. */
export const latestDueDate = (records: readonly OccurrenceRecord[]): string | null =>
  records.reduce<string | null>(
    (latest, record) => (latest === null || record.dueDate > latest ? record.dueDate : latest),
    null,
  );

/**
 * The backlog of missed occurrences: how many are `missed` after the clear watermark. Derived,
 * never merged: a peer's stale count cannot bring back a backlog the user cleared.
 */
export const missedBacklog = (
  records: readonly OccurrenceRecord[],
  clearedThroughDate: string | null,
): number =>
  records.filter(
    (record) =>
      record.outcome === "missed" &&
      (clearedThroughDate === null || record.dueDate > clearedThroughDate),
  ).length;

/** The larger of two optional date keys (`YYYY-MM-DD` sorts as a calendar). */
export const maxDateKey = (a: string | null, b: string | null): string | null =>
  a === null ? b : b === null ? a : a >= b ? a : b;
