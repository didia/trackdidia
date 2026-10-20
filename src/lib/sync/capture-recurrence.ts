import type { RecurringTaskTemplate } from "../../domain/types";
import { addDays, getTodayDate } from "../date";
import { listDueDatesBetween } from "../recurring/engine";
import * as recurringTemplatesRows from "../storage/sqlite/rows/recurringTemplates";
import type { Database } from "../storage/sqlite-db";
import type { JsonRecord } from "./field-clocks";
import { parseHlc } from "./hlc";
import {
  compareOccurrence,
  isCalendarDateKey,
  isUserOutcome,
  type OccurrenceOutcome,
  type OccurrenceRecord,
  outcomeOfStatus,
} from "./recurrence-occurrences";
import { raiseClear, readOccurrence, writeOccurrence } from "./recurrence-store";

/**
 * Change capture for recurring occurrences. Runs inside the stamper, in the same transaction, and
 * is derived from the DIFF of the instance row (its snapshot against what the database holds now),
 * never from the generators, so every writer of the row is covered and a stamp that finds nothing
 * new writes nothing.
 *
 * The rules, for a stamped `gtd_tasks` row with `is_recurring_instance = 1`:
 * - creation (no earlier snapshot of an instance): the current due date is recorded with the outcome
 *   its status shows, and a backlog the row already carries (`pending_past_recurrences = N`) is
 *   recorded as the N due dates before it that the template's schedule yields, as `missed`;
 * - the due date moved forward `D1 -> D2`: `D1` is `completed`/`cancelled` if the row was in that
 *   terminal state, else `missed`; every due date of the template strictly between them is `missed`
 *   (generation collapses a gap into one instance); `D2` is `active` (or what its status shows).
 *   Leaving a TERMINAL state also acknowledges the older backlog, as the desktop forgets it: the clear
 *   watermark moves to `D1`;
 * - the due date moved backwards (an early generation pulled back): only the new date is recorded,
 *   nothing is un-recorded;
 * - same due date, status became terminal: the occurrence becomes `completed`/`cancelled`;
 * - same due date, backlog went from `N > 0` to `0` (`clearPastRecurrences`): the clear watermark
 *   moves to the latest `missed` due date known.
 *
 * Every write is a join: an occurrence only ever moves up (active < missed < completed/cancelled),
 * the watermark only forward, and an unchanged outcome is not rewritten. The sidecars have no capture
 * triggers, so nothing here marks anything dirty; the stamper's `change_counter` bump for the stamped
 * entity covers them.
 */

/** A gap longer than this is not walked day by day (a corrupt or ancient due date). */
const MAX_GAP_DAYS = 3660;

const isTerminal = (status: unknown): status is "completed" | "cancelled" =>
  status === "completed" || status === "cancelled";

const rankOf = (outcome: OccurrenceOutcome): number =>
  isUserOutcome(outcome) ? 2 : outcome === "missed" ? 1 : 0;

const intOr0 = (value: unknown): number => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
};

const readTemplate = async (
  db: Database,
  templateId: string,
): Promise<RecurringTaskTemplate | null> => {
  const rows = await db.select<recurringTemplatesRows.RecurringTemplateRow[]>(
    "SELECT * FROM recurring_task_templates WHERE id = $1",
    [templateId],
  );
  const row = rows[0];
  if (row === undefined) return null;
  try {
    return recurringTemplatesRows.fromRow(row);
  } catch {
    return null; // an unreadable template only costs the intermediate dates
  }
};

/** Writes `candidate` when it moves the occurrence up. Returns whether anything was written. */
export const recordOccurrence = async (
  db: Database,
  candidate: OccurrenceRecord,
): Promise<boolean> => {
  const existing = await readOccurrence(db, candidate.templateId, candidate.dueDate);
  if (
    existing !== null &&
    (existing.outcome === candidate.outcome || compareOccurrence(candidate, existing) <= 0)
  ) {
    return false;
  }
  await writeOccurrence(db, candidate);
  return true;
};

/** The N due dates of the template just before `due`, oldest first. */
const dueDatesBefore = (template: RecurringTaskTemplate, due: string, count: number): string[] => {
  const from = addDays(due, -MAX_GAP_DAYS);
  const start = template.startDate > from ? template.startDate : from;
  const dates = listDueDatesBetween(template, start, addDays(due, -1));
  return dates.slice(Math.max(0, dates.length - count));
};

/**
 * True when a `cancelled` instance row is the generator's pull-back and not a decision of the user.
 * `prepareRecurringGeneration` cancels an instance whose due date is after the device's local today
 * and that has no earlier due date to fall back to (another laptop, whose local day is ahead, had
 * generated it), and clears the template's `last_generated_for_date` in the same pass. A user can
 * cancel a future-dated instance too (it reaches a laptop that is behind through a merge), but that
 * leaves the watermark set, so the combination "cancelled, due after today, watermark cleared" only
 * comes from the generator. Recording it as a user outcome would cancel the occurrence on every
 * laptop for good.
 */
export const isGeneratorPullBack = async (
  db: Database,
  templateId: string,
  due: string,
  status: unknown,
  today: string,
): Promise<boolean> => {
  if (status !== "cancelled" || due <= today) return false;
  const template = await readTemplate(db, templateId);
  return template !== null && template.lastGeneratedForDate === null;
};

/**
 * @param today the device's local calendar date, as the generator reads it (`getTodayDate()`);
 *   injectable for tests.
 */
export const captureRecurringInstance = async (
  db: Database,
  previous: JsonRecord | null,
  next: JsonRecord,
  hlc: string,
  today: string = getTodayDate(),
): Promise<number> => {
  const templateId = next.recurring_template_id;
  const due = next.recurrence_due_date;
  if (
    Number(next.is_recurring_instance) !== 1 ||
    typeof templateId !== "string" ||
    templateId === "" ||
    !isCalendarDateKey(due)
  ) {
    return 0;
  }
  const deviceId = parseHlc(hlc)?.deviceId;
  if (deviceId === undefined) return 0;

  let written = 0;
  const put = async (dueDate: string, outcome: OccurrenceOutcome): Promise<void> => {
    if (await recordOccurrence(db, { templateId, dueDate, outcome, outcomeHlc: hlc, deviceId })) {
      written += 1;
    }
  };
  // What the row's status says about the current occurrence. A generator pull-back is not an outcome.
  const currentOutcome = async (): Promise<OccurrenceOutcome> =>
    (await isGeneratorPullBack(db, templateId, due, next.status, today))
      ? "active"
      : outcomeOfStatus(next.status);

  const previousDue =
    previous !== null &&
    Number(previous.is_recurring_instance) === 1 &&
    previous.recurring_template_id === templateId &&
    isCalendarDateKey(previous.recurrence_due_date)
      ? previous.recurrence_due_date
      : null;

  if (previousDue === null) {
    await put(due, await currentOutcome());
    const backlog = intOr0(next.pending_past_recurrences);
    if (backlog > 0) {
      const template = await readTemplate(db, templateId);
      if (template !== null) {
        for (const date of dueDatesBefore(template, due, backlog)) await put(date, "missed");
      }
    }
    return written;
  }

  const previousStatus = (previous as JsonRecord).status;
  if (due !== previousDue) {
    if (due > previousDue) {
      const previousTerminal = isTerminal(previousStatus);
      if (previousTerminal) await put(previousDue, previousStatus);
      // The dates this advance passed over, oldest first: the previous due date itself when it was
      // still active, then every due date of the template strictly between the two.
      const passed: string[] = previousTerminal ? [] : [previousDue];
      const gapDays = Math.round(
        (new Date(`${due}T12:00:00Z`).getTime() - new Date(`${previousDue}T12:00:00Z`).getTime()) /
          86_400_000,
      );
      if (gapDays > 1 && gapDays <= MAX_GAP_DAYS) {
        const template = await readTemplate(db, templateId);
        if (template !== null) {
          passed.push(...listDueDatesBetween(template, addDays(previousDue, 1), addDays(due, -1)));
        }
      }
      // The row's own backlog says how many of them really were missed. Several advances collapsed
      // into one stamp (capture off for a while, a failed flush) can cross an occurrence the user
      // completed; the backlog the generator wrote already excludes it, and so must the records.
      // Moving on from a terminal state forgets the older backlog, so then the whole count is new.
      const added = previousTerminal
        ? intOr0(next.pending_past_recurrences)
        : Math.max(
            0,
            intOr0(next.pending_past_recurrences) -
              intOr0((previous as JsonRecord).pending_past_recurrences),
          );
      for (const date of passed.slice(Math.max(0, passed.length - added))) {
        await put(date, "missed");
      }
      if (previousTerminal && (await raiseClear(db, templateId, previousDue))) {
        written += 1;
      }
    }
    await put(due, await currentOutcome());
    return written;
  }

  if (isTerminal(next.status) && next.status !== previousStatus) {
    if ((await currentOutcome()) !== "active") await put(due, next.status);
  }
  if (
    intOr0((previous as JsonRecord).pending_past_recurrences) > 0 &&
    intOr0(next.pending_past_recurrences) === 0
  ) {
    const rows = await db.select<{ latest: string | null }[]>(
      `SELECT MAX(due_date) AS latest FROM sync_recurrence_occurrences
       WHERE template_id = $1 AND outcome = 'missed'`,
      [templateId],
    );
    const latest = rows[0]?.latest;
    if (isCalendarDateKey(latest) && (await raiseClear(db, templateId, latest))) {
      written += 1;
    }
  }
  return written;
};

interface InstanceRow {
  recurring_template_id: string;
  recurrence_due_date: string;
  status: string;
  pending_past_recurrences: number | null;
}

/**
 * Backfill: makes sure every existing recurring instance has the occurrence record of its current
 * due date (a database whose instances were stamped before the sidecars existed, or whose capture
 * was off while the instance advanced). A template that has no record at all also gets its existing
 * backlog recorded, exactly as a creation would. `nextHlc` is called only when a row is written.
 * Returns the number of rows written.
 */
export const ensureInstanceOccurrences = async (
  db: Database,
  nextHlc: () => Promise<string>,
  today: string = getTodayDate(),
): Promise<number> => {
  const instances = await db.select<InstanceRow[]>(
    `SELECT recurring_template_id, recurrence_due_date, status, pending_past_recurrences
     FROM gtd_tasks
     WHERE is_recurring_instance = 1 AND recurring_template_id IS NOT NULL
       AND recurrence_due_date IS NOT NULL
     ORDER BY recurring_template_id`,
  );
  let written = 0;
  for (const instance of instances) {
    if (!isCalendarDateKey(instance.recurrence_due_date)) continue;
    const templateId = instance.recurring_template_id;
    const outcome = (await isGeneratorPullBack(
      db,
      templateId,
      instance.recurrence_due_date,
      instance.status,
      today,
    ))
      ? "active"
      : outcomeOfStatus(instance.status);
    const existing = await readOccurrence(db, templateId, instance.recurrence_due_date);
    if (existing !== null && rankOf(outcome) <= rankOf(existing.outcome)) continue;
    const hasAny = (
      await db.select<{ present: number }[]>(
        "SELECT 1 AS present FROM sync_recurrence_occurrences WHERE template_id = $1 LIMIT 1",
        [templateId],
      )
    ).length;
    const hlc = await nextHlc();
    const deviceId = parseHlc(hlc)?.deviceId;
    if (deviceId === undefined) continue;
    const put = async (dueDate: string, kind: OccurrenceOutcome): Promise<void> => {
      if (
        await recordOccurrence(db, {
          templateId,
          dueDate,
          outcome: kind,
          outcomeHlc: hlc,
          deviceId,
        })
      ) {
        written += 1;
      }
    };
    await put(instance.recurrence_due_date, outcome);
    const backlog = intOr0(instance.pending_past_recurrences);
    if (hasAny === 0 && backlog > 0) {
      const template = await readTemplate(db, templateId);
      if (template !== null) {
        for (const date of dueDatesBefore(template, instance.recurrence_due_date, backlog)) {
          await put(date, "missed");
        }
      }
    }
  }
  return written;
};
