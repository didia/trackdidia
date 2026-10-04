import type { WeeklyObjectiveResult } from "../../../../domain/types";

export interface WeeklyObjectiveResultRow {
  week_start_date: string;
  objective_id: string;
  achieved: number;
  updated_at: string;
}
export const COLUMNS = "week_start_date, objective_id, achieved, updated_at";
export const fromRow = (row: WeeklyObjectiveResultRow): WeeklyObjectiveResult => {
  return {
    weekStartDate: row.week_start_date,
    objectiveId: row.objective_id,
    achieved: row.achieved === 1,
    updatedAt: row.updated_at,
  };
};
export const toParams = (entity: WeeklyObjectiveResult): unknown[] => [
  entity.weekStartDate,
  entity.objectiveId,
  entity.achieved ? 1 : 0,
  entity.updatedAt,
];
