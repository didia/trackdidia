import type { Database } from "../storage/sqlite-db";
import type { SyncRecurrence } from "./change-set";
import {
  type ExtraConflict,
  instanceEntityId,
  TASK_TABLE,
  terminalDivergenceId,
} from "./merge-task";
import {
  compareOccurrence,
  isTerminalDivergence,
  type OccurrenceRecord,
} from "./recurrence-occurrences";
import { loadRecurrence, occurrenceToRow, raiseClear, writeOccurrence } from "./recurrence-store";

/**
 * Applying the recurrence sidecars of a bundle: the join of two sets of occurrence records and of
 * two clear watermarks. Pure joins (`recurrence-occurrences.ts`), so applying the same bundle again,
 * or in another order, changes nothing.
 *
 * The instance rows and templates are recomputed from the result by `apply-gtd.ts`, which needs to
 * know which templates this touched.
 */

export interface RecurrenceApplyResult {
  /** Templates that the bundle carries sidecar rows for, changed or not. */
  templates: Set<string>;
  applied: number;
  skipped: number;
  conflicts: ExtraConflict[];
}

const recordOf = (row: SyncRecurrence["occurrences"][number]): OccurrenceRecord => ({
  templateId: row.template_id,
  dueDate: row.due_date,
  outcome: row.outcome,
  outcomeHlc: row.outcome_hlc,
  deviceId: row.device_id,
});

export const applyRecurrenceSidecars = async (
  db: Database,
  recurrence: SyncRecurrence,
): Promise<RecurrenceApplyResult> => {
  const result: RecurrenceApplyResult = {
    templates: new Set(),
    applied: 0,
    skipped: 0,
    conflicts: [],
  };
  const incoming = recurrence.occurrences
    .map(recordOf)
    .sort(
      (a, b) =>
        (a.templateId < b.templateId ? -1 : a.templateId > b.templateId ? 1 : 0) ||
        (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0),
    );
  for (const record of incoming) result.templates.add(record.templateId);
  for (const clear of recurrence.clears) result.templates.add(clear.template_id);
  if (result.templates.size === 0) return result;

  const existing = await loadRecurrence(db, [...result.templates]);
  const known = new Map<string, OccurrenceRecord>();
  for (const [, state] of existing) {
    for (const record of state.occurrences) {
      known.set(`${record.templateId}\u0000${record.dueDate}`, record);
    }
  }

  for (const record of incoming) {
    const key = `${record.templateId}\u0000${record.dueDate}`;
    const local = known.get(key);
    if (local !== undefined && isTerminalDivergence(local, record)) {
      // The user completed the occurrence on one laptop and cancelled it on another. The merge
      // picks the later decision for now; settling it is the user's.
      const entityId = instanceEntityId(record.templateId);
      result.conflicts.push({
        id: terminalDivergenceId(TASK_TABLE, entityId, record.dueDate),
        kind: "terminal_divergence",
        entityType: TASK_TABLE,
        entityId,
        local: occurrenceToRow(local),
        remote: occurrenceToRow(record),
      });
    }
    if (local === undefined || compareOccurrence(record, local) > 0) {
      await writeOccurrence(db, record);
      known.set(key, record);
      result.applied += 1;
    } else {
      result.skipped += 1;
    }
  }

  for (const clear of recurrence.clears) {
    if (await raiseClear(db, clear.template_id, clear.cleared_through_date)) {
      result.applied += 1;
    } else {
      result.skipped += 1;
    }
  }
  return result;
};
