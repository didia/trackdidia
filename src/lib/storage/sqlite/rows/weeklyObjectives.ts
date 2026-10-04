import type { WeeklyObjective } from "../../../../domain/types";

export interface WeeklyObjectiveRow {
  id: string;
  title: string;
  kind: WeeklyObjective["kind"];
  target_hours: number | null;
  rescuetime_kind: WeeklyObjective["rescuetimeKind"];
  rescuetime_thing: string | null;
  sort_order: number;
  starts_on_week_start_date: string | null;
  ends_on_week_start_date: string | null;
  created_at: string;
  updated_at: string;
}
export const COLUMNS =
  "id, title, kind, target_hours, rescuetime_kind, rescuetime_thing, sort_order, starts_on_week_start_date, ends_on_week_start_date, created_at, updated_at";
export const fromRow = (row: WeeklyObjectiveRow): WeeklyObjective => {
  return {
    id: row.id,
    title: row.title,
    kind: row.kind,
    targetHours: row.target_hours === null ? null : Number(row.target_hours),
    rescuetimeKind: row.rescuetime_kind,
    rescuetimeThing: row.rescuetime_thing,
    sortOrder: Number(row.sort_order),
    startsOnWeekStartDate: row.starts_on_week_start_date?.trim() || null,
    endsOnWeekStartDate: row.ends_on_week_start_date?.trim() || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};
export const toParams = (entity: WeeklyObjective): unknown[] => [
  entity.id,
  entity.title,
  entity.kind,
  entity.targetHours,
  entity.rescuetimeKind,
  entity.rescuetimeThing,
  entity.sortOrder,
  entity.startsOnWeekStartDate,
  entity.endsOnWeekStartDate,
  entity.createdAt,
  entity.updatedAt,
];
