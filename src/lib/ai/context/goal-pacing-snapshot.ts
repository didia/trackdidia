import { computeYearProgressFraction } from "../../../domain/annual-goals";
import type {
  AiPayloadScope,
  AnnualGoalCadencePeriod,
  AnnualGoalDirection,
  AnnualGoalMeasurementType,
  AnnualGoalProgressPoint,
  AnnualGoalSnapshot,
  AnnualGoalStatus,
} from "../../../domain/types";
import { clampAiAsOfDate, getTodayDate } from "../../date";
import type { Surface } from "./types";

export interface GoalPacingSnapshotMilestone {
  completed: boolean;
  title?: string;
}

export interface GoalPacingSnapshotGoal {
  goalId: string;
  title?: string;
  dimension: string;
  measurementType: AnnualGoalMeasurementType;
  status: AnnualGoalStatus;
  direction: AnnualGoalDirection;
  currentValue: number | null;
  targetValue: number | null;
  unit: string;
  progressRatio: number | null;
  expectedProgressRatio: number | null;
  onPace: boolean;
  monthlyProgress: AnnualGoalProgressPoint[];
  evaluationScore: number | null;
  evaluationTrend: string | null;
  // recurring
  currentPeriodKey: string | null;
  currentPeriodCount: number | null;
  cadenceTarget: number | null;
  cadencePeriod: AnnualGoalCadencePeriod;
  adherenceRatio: number | null;
  periodsMet: number;
  periodsElapsed: number;
  currentStreak: number;
  // milestones (any type)
  milestonesTotal: number;
  milestonesCompleted: number;
  milestoneProgressRatio: number | null;
  milestones: GoalPacingSnapshotMilestone[];
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
  includeStructure: boolean,
): GoalPacingSnapshotGoal => {
  const evaluation = snapshot.goal.evaluations[evaluationMonthKey] ?? null;
  const { measurement } = snapshot;

  return {
    goalId: snapshot.goal.id,
    ...(includeStructure ? { title: snapshot.goal.title } : {}),
    dimension: snapshot.goal.dimension,
    measurementType: measurement.measurementType,
    status: snapshot.goal.status,
    direction: measurement.direction,
    currentValue: snapshot.currentValue,
    targetValue: snapshot.goal.targetValue,
    unit: snapshot.goal.unit,
    progressRatio: snapshot.progressRatio,
    expectedProgressRatio: measurement.expectedProgressRatio,
    onPace: measurement.onPace,
    monthlyProgress: snapshot.monthlyProgress,
    evaluationScore: evaluation?.score ?? null,
    evaluationTrend: evaluation?.trend ?? null,
    currentPeriodKey: measurement.currentPeriodKey,
    currentPeriodCount: measurement.currentPeriodCount,
    cadenceTarget: measurement.cadenceTarget,
    cadencePeriod: snapshot.goal.cadencePeriod,
    adherenceRatio: measurement.adherenceRatio,
    periodsMet: measurement.periodsMet,
    periodsElapsed: measurement.periodsElapsed,
    currentStreak: measurement.currentStreak,
    milestonesTotal: measurement.milestonesTotal,
    milestonesCompleted: measurement.milestonesCompleted,
    milestoneProgressRatio: measurement.milestoneProgressRatio,
    milestones: snapshot.goal.milestones.map((milestone) => ({
      completed: milestone.completedAt !== null,
      ...(includeStructure ? { title: milestone.title } : {}),
    })),
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
    goals: inputs.goalSnapshots
      .filter((snapshot) => snapshot.goal.status === "active")
      .map((snapshot) => sanitizeGoal(snapshot, inputs.evaluationMonthKey, includeStructure)),
  };
};

export const resolveGoalPacingSnapshotInputs = async (
  repository: import("../../storage/repository").AppRepository,
  year: number,
  options: { asOfDate?: string; evaluationMonthKey?: string } = {},
): Promise<GoalPacingSnapshotInputs> => {
  const asOfDate = clampAiAsOfDate(options.asOfDate ?? getTodayDate(), `${year}-12-31`);
  const evaluationMonthKey = options.evaluationMonthKey ?? asOfDate.slice(0, 7);
  const goalSnapshots = await repository.computeAnnualGoalSnapshots(year, asOfDate);

  return {
    year,
    asOfDate,
    evaluationMonthKey,
    goalSnapshots,
  };
};
