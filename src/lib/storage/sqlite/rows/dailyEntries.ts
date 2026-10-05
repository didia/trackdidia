import type { DailyEntry } from "../../../../domain/types";

export interface DailyEntryRow {
  date: string;
  status: DailyEntry["status"];
  metrics_json: string;
  principles_json: string;
  morning_intention: string | null;
  night_reflection: string | null;
  tomorrow_focus: string | null;
  updated_at: string;
}
export const COLUMNS =
  "date, status, metrics_json, principles_json, morning_intention, night_reflection, tomorrow_focus, updated_at";
export const fromRow = (row: DailyEntryRow): DailyEntry => {
  return {
    date: row.date,
    status: row.status,
    metrics: JSON.parse(row.metrics_json),
    principleChecks: JSON.parse(row.principles_json),
    morningIntention: row.morning_intention ?? "",
    nightReflection: row.night_reflection ?? "",
    tomorrowFocus: row.tomorrow_focus ?? "",
    updatedAt: row.updated_at,
  };
};
export const toParams = (entity: DailyEntry): unknown[] => [
  entity.date,
  entity.status,
  JSON.stringify(entity.metrics),
  JSON.stringify(entity.principleChecks),
  entity.morningIntention,
  entity.nightReflection,
  entity.tomorrowFocus,
  entity.updatedAt,
];
