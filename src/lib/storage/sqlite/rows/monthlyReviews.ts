import type { MonthlyReview } from "../../../../domain/types";

export interface MonthlyReviewRow {
  month_key: string;
  month_start_date: string;
  month_end_date: string;
  status: MonthlyReview["status"];
  notes_json: string;
  ritual_checklist_json: string;
  updated_at: string;
}
export const COLUMNS =
  "month_key, month_start_date, month_end_date, status, notes_json, ritual_checklist_json, updated_at";
export const fromRow = (row: MonthlyReviewRow): MonthlyReview => {
  return {
    monthKey: row.month_key,
    monthStartDate: row.month_start_date,
    monthEndDate: row.month_end_date,
    status: row.status,
    notes: JSON.parse(row.notes_json),
    ritualChecklist: JSON.parse(row.ritual_checklist_json),
    updatedAt: row.updated_at,
  };
};
export const toParams = (entity: MonthlyReview): unknown[] => [
  entity.monthKey,
  entity.monthStartDate,
  entity.monthEndDate,
  entity.status,
  JSON.stringify(entity.notes),
  JSON.stringify(entity.ritualChecklist),
  entity.updatedAt,
];
