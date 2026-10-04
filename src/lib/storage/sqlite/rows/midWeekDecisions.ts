import type { MidWeekDecisions, MidWeekDecisionsSaveInput } from "../../../../domain/types";
import { buildWeekDates } from "../../../../domain/weekly-review";
import { parseMidWeekLaggingSnapshot } from "../../../../domain/mid-week-review";
export interface MidWeekDecisionsRow {
  week_start_date: string;
  decisions: string;
  decided_on_date: string;
  lagging_snapshot_json: string | null;
  updated_at: string;
}
export const COLUMNS =
  "week_start_date, decisions, decided_on_date, lagging_snapshot_json, updated_at";
export const fromRow = (row: MidWeekDecisionsRow): MidWeekDecisions => ({
  weekStartDate: row.week_start_date,
  decisions: row.decisions,
  decidedOnDate: row.decided_on_date,
  laggingSnapshot: parseMidWeekLaggingSnapshot(row.lagging_snapshot_json),
  updatedAt: row.updated_at,
});
export const toParams = (entity: MidWeekDecisionsSaveInput | MidWeekDecisions): unknown[] => [
  buildWeekDates(entity.weekStartDate),
  entity.decisions,
  entity.decidedOnDate,
  entity.laggingSnapshot ? JSON.stringify(entity.laggingSnapshot) : null,
  entity.updatedAt,
];
