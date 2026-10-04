import type { WeeklyReview } from "../../../../domain/types";

export interface WeeklyReviewRow {
  week_start_date: string;
  week_end_date: string;
  status: WeeklyReview["status"];
  notes_json: string;
  ritual_checklist_json: string;
  updated_at: string;
}
export const COLUMNS =
  "week_start_date, week_end_date, status, notes_json, ritual_checklist_json, updated_at";
export const fromRow = (row: WeeklyReviewRow): WeeklyReview => {
  return {
    weekStartDate: row.week_start_date,
    weekEndDate: row.week_end_date,
    status: row.status,
    notes: JSON.parse(row.notes_json),
    ritualChecklist: JSON.parse(row.ritual_checklist_json),
    updatedAt: row.updated_at,
  };
};
export const toParams = (entity: WeeklyReview): unknown[] => [
  entity.weekStartDate,
  entity.weekEndDate,
  entity.status,
  JSON.stringify(entity.notes),
  JSON.stringify(entity.ritualChecklist),
  entity.updatedAt,
];
