import type { Database } from "../storage/sqlite-db";
import {
  isCalendarDateKey,
  isOccurrenceOutcome,
  maxDateKey,
  type OccurrenceRecord,
  type TemplateRecurrence,
} from "./recurrence-occurrences";

/**
 * SQL access to the two recurrence sidecars (`sync_recurrence_occurrences`,
 * `sync_recurrence_clears`). Shared by change capture (writes what a stamp saw) and by apply
 * (writes what a peer sent). Neither table has capture triggers, so writing here never marks
 * anything dirty and never moves `change_counter`: the caller decides what counts as a change.
 */

// Local copies: capture-stamp imports this module, so importing its helpers would be a cycle.
const BATCH = 100;
const chunked = <T>(items: readonly T[]): T[][] => {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += BATCH) {
    chunks.push(items.slice(index, index + BATCH));
  }
  return chunks;
};
const placeholders = (count: number): string =>
  Array.from({ length: count }, (_, index) => `$${index + 1}`).join(", ");

export interface OccurrenceRow {
  template_id: string;
  due_date: string;
  outcome: string;
  outcome_hlc: string;
  device_id: string;
}

export interface ClearRow {
  template_id: string;
  cleared_through_date: string;
}

/** A stored row as a record, or `null` for a row this build cannot read (never thrown on). */
export const occurrenceFromRow = (row: OccurrenceRow): OccurrenceRecord | null =>
  typeof row.template_id === "string" &&
  isCalendarDateKey(row.due_date) &&
  isOccurrenceOutcome(row.outcome) &&
  typeof row.outcome_hlc === "string" &&
  typeof row.device_id === "string"
    ? {
        templateId: row.template_id,
        dueDate: row.due_date,
        outcome: row.outcome,
        outcomeHlc: row.outcome_hlc,
        deviceId: row.device_id,
      }
    : null;

export const occurrenceToRow = (record: OccurrenceRecord): OccurrenceRow => ({
  template_id: record.templateId,
  due_date: record.dueDate,
  outcome: record.outcome,
  outcome_hlc: record.outcomeHlc,
  device_id: record.deviceId,
});

export const readOccurrence = async (
  db: Database,
  templateId: string,
  dueDate: string,
): Promise<OccurrenceRecord | null> => {
  const rows = await db.select<OccurrenceRow[]>(
    "SELECT template_id, due_date, outcome, outcome_hlc, device_id FROM sync_recurrence_occurrences WHERE template_id = $1 AND due_date = $2",
    [templateId, dueDate],
  );
  const row = rows[0];
  return row === undefined ? null : occurrenceFromRow(row);
};

export const writeOccurrence = async (db: Database, record: OccurrenceRecord): Promise<void> => {
  await db.execute(
    `INSERT OR REPLACE INTO sync_recurrence_occurrences
       (template_id, due_date, outcome, outcome_hlc, device_id) VALUES ($1, $2, $3, $4, $5)`,
    [record.templateId, record.dueDate, record.outcome, record.outcomeHlc, record.deviceId],
  );
};

export const readClear = async (db: Database, templateId: string): Promise<string | null> => {
  const rows = await db.select<ClearRow[]>(
    "SELECT template_id, cleared_through_date FROM sync_recurrence_clears WHERE template_id = $1",
    [templateId],
  );
  const date = rows[0]?.cleared_through_date;
  return isCalendarDateKey(date) ? date : null;
};

/** Raises the clear watermark; never lowers it. Returns whether it moved. */
export const raiseClear = async (
  db: Database,
  templateId: string,
  date: string,
): Promise<boolean> => {
  const current = await readClear(db, templateId);
  if (current !== null && current >= date) return false;
  await db.execute(
    "INSERT OR REPLACE INTO sync_recurrence_clears (template_id, cleared_through_date) VALUES ($1, $2)",
    [templateId, date],
  );
  return true;
};

/** The merged sidecars of the given templates. A template with none maps to no entry. */
export const loadRecurrence = async (
  db: Database,
  templateIds: readonly string[],
): Promise<Map<string, TemplateRecurrence>> => {
  const found = new Map<string, TemplateRecurrence>();
  const ids = [...new Set(templateIds)];
  const occurrences = new Map<string, OccurrenceRecord[]>();
  for (const batch of chunked(ids)) {
    const rows = await db.select<OccurrenceRow[]>(
      `SELECT template_id, due_date, outcome, outcome_hlc, device_id
       FROM sync_recurrence_occurrences WHERE template_id IN (${placeholders(batch.length)})
       ORDER BY template_id, due_date`,
      batch,
    );
    for (const row of rows) {
      const record = occurrenceFromRow(row);
      if (record !== null) {
        occurrences.set(record.templateId, [...(occurrences.get(record.templateId) ?? []), record]);
      }
    }
  }
  const clears = new Map<string, string | null>();
  for (const batch of chunked(ids)) {
    const rows = await db.select<ClearRow[]>(
      `SELECT template_id, cleared_through_date FROM sync_recurrence_clears
       WHERE template_id IN (${placeholders(batch.length)})`,
      batch,
    );
    for (const row of rows) {
      if (isCalendarDateKey(row.cleared_through_date)) {
        clears.set(
          row.template_id,
          maxDateKey(clears.get(row.template_id) ?? null, row.cleared_through_date),
        );
      }
    }
  }
  for (const id of ids) {
    const list = occurrences.get(id);
    const cleared = clears.get(id) ?? null;
    if (list !== undefined || cleared !== null) {
      found.set(id, { occurrences: list ?? [], clearedThroughDate: cleared });
    }
  }
  return found;
};
