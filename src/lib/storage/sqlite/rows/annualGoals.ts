import type { AnnualGoal } from "../../../../domain/types";
import { safeParseJson } from "../safe-parse-json";

export interface AnnualGoalRow {
  id: string;
  title: string;
  dimension: AnnualGoal["dimension"];
  description: string;
  target_value: number | null;
  unit: string;
  source_id: AnnualGoal["sourceId"];
  manual_current_value: number | null;
  evaluations_json: string;
  measurement_type: AnnualGoal["measurementType"];
  status: AnnualGoal["status"];
  deadline: string | null;
  starting_value: number | null;
  direction: AnnualGoal["direction"];
  cadence_target: number | null;
  cadence_period: AnnualGoal["cadencePeriod"];
  principle_key: AnnualGoal["principleKey"];
  progress_log_json: string;
  milestones_json: string;
  created_at: string;
  updated_at: string;
}
export const COLUMNS =
  "id, title, dimension, description, target_value, unit, source_id, manual_current_value, evaluations_json, measurement_type, status, deadline, starting_value, direction, cadence_target, cadence_period, principle_key, progress_log_json, milestones_json, created_at, updated_at";
export const fromRow = (row: AnnualGoalRow): AnnualGoal => {
  return {
    id: row.id,
    title: row.title,
    dimension: row.dimension,
    description: row.description,
    targetValue: row.target_value === null ? null : Number(row.target_value),
    unit: row.unit,
    sourceId: row.source_id,
    manualCurrentValue: row.manual_current_value === null ? null : Number(row.manual_current_value),
    evaluations: JSON.parse(row.evaluations_json),
    measurementType: row.measurement_type ?? "numeric",
    status: row.status ?? "active",
    deadline: row.deadline ?? null,
    startingValue: row.starting_value === null ? null : Number(row.starting_value),
    direction: row.direction ?? null,
    cadenceTarget: row.cadence_target === null ? null : Number(row.cadence_target),
    cadencePeriod: row.cadence_period ?? "week",
    principleKey: row.principle_key ?? null,
    progressLog: safeParseJson(row.progress_log_json, {}),
    milestones: safeParseJson(row.milestones_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};
export const toParams = (entity: AnnualGoal): unknown[] => [
  entity.id,
  entity.title,
  entity.dimension,
  entity.description,
  entity.targetValue,
  entity.unit,
  entity.sourceId,
  entity.manualCurrentValue,
  JSON.stringify(entity.evaluations),
  entity.measurementType,
  entity.status,
  entity.deadline,
  entity.startingValue,
  entity.direction,
  entity.cadenceTarget,
  entity.cadencePeriod,
  entity.principleKey,
  JSON.stringify(entity.progressLog),
  JSON.stringify(entity.milestones),
  entity.createdAt,
  entity.updatedAt,
];
