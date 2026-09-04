import { computeYearProgressFraction, isAnnualGoalOnPace } from "../../../domain/annual-goals";
import type {
  AiPayloadScope,
  AnnualGoalProgressPoint,
  AnnualGoalSnapshot,
} from "../../../domain/types";
import { getTodayDate } from "../../date";
import type { Surface } from "./types";

export interface GoalPacingSnapshotGoal {
  goalId: string;
  title?: string;
  dimension: string;
  currentValue: number | null;
  targetValue: number | null;
  unit: string;
  progressRatio: number | null;
  onPace: boolean;
  monthlyProgress: AnnualGoalProgressPoint[];
  evaluationScore: number | null;
  evaluationTrend: string | null;
}

export interface GoalPacingSnapshot {
  surface: Surface;
  scope: AiPayloadScope;
  year: number;
  asOfDate: string;
  expectedProgressRatio: number;
  goals: GoalPacingSnapshotGoal[];
}

export interface GoalPacingSnapshotInputs {
  year: number;
  asOfDate: string;
  evaluationMonthKey: string;
  goalSnapshots: AnnualGoalSnapshot[];
}

const sanitizeGoal = (
  snapshot: AnnualGoalSnapshot,
  evaluationMonthKey: string,
  expectedProgressRatio: number,
  includeStructure: boolean,
): GoalPacingSnapshotGoal => {
  const evaluation = snapshot.goal.evaluations[evaluationMonthKey] ?? null;

  return {
    goalId: snapshot.goal.id,
    ...(includeStructure ? { title: snapshot.goal.title } : {}),
    dimension: snapshot.goal.dimension,
    currentValue: snapshot.currentValue,
    targetValue: snapshot.goal.targetValue,
    unit: snapshot.goal.unit,
    progressRatio: snapshot.progressRatio,
    onPace: isAnnualGoalOnPace(snapshot.progressRatio, expectedProgressRatio),
    monthlyProgress: snapshot.monthlyProgress,
    evaluationScore: evaluation?.score ?? null,
    evaluationTrend: evaluation?.trend ?? null,
  };
};

export const buildGoalPacingSnapshot = (
  inputs: GoalPacingSnapshotInputs,
  scope: AiPayloadScope,
): GoalPacingSnapshot => {
  const includeStructure = scope === "metrics_and_structure" || scope === "full";
  const expectedProgressRatio = computeYearProgressFraction(inputs.year, inputs.asOfDate);

  return {
    surface: "annual",
    scope,
    year: inputs.year,
    asOfDate: inputs.asOfDate,
    expectedProgressRatio,
    goals: inputs.goalSnapshots.map((snapshot) =>
      sanitizeGoal(snapshot, inputs.evaluationMonthKey, expectedProgressRatio, includeStructure),
    ),
  };
};

export const resolveGoalPacingSnapshotInputs = async (
  repository: import("../../storage/repository").AppRepository,
  year: number,
  options: { asOfDate?: string; evaluationMonthKey?: string } = {},
): Promise<GoalPacingSnapshotInputs> => {
  const asOfDate = options.asOfDate ?? getTodayDate();
  const evaluationMonthKey = options.evaluationMonthKey ?? asOfDate.slice(0, 7);
  const goalSnapshots = await repository.computeAnnualGoalSnapshots(year);

  return {
    year,
    asOfDate,
    evaluationMonthKey,
    goalSnapshots,
  };
};
