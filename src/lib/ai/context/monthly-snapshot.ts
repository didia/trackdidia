import type {
  AiPayloadScope,
  AnnualGoalSnapshot,
  MonthlyReview,
  MonthlyReviewSectionKey,
  MonthlyReviewSummary,
  MonthlyReviewWeekSummary,
} from "../../../domain/types";
import type { Surface } from "./types";

export interface MonthlySnapshotWeek {
  weekStartDate: string;
  weekEndDate: string;
  weeklyScore: number;
  reviewStatus: MonthlyReviewWeekSummary["reviewStatus"];
  noteCount: number;
}

export interface MonthlySnapshotGoal {
  goalId: string;
  title?: string;
  dimension: string;
  currentValue: number | null;
  targetValue: number | null;
  unit: string;
  progressRatio: number | null;
  monthValue: number | null;
  evaluationScore: number | null;
  evaluationTrend: string | null;
}

export interface MonthlySnapshot {
  surface: Surface;
  scope: AiPayloadScope;
  monthKey: string;
  monthStartDate: string;
  monthEndDate: string;
  reviewStatus: MonthlyReview["status"];
  daysTracked: number;
  weeksCovered: number;
  weeklyReviewsCompleted: number;
  sleepAverage: number;
  trcRate: number;
  screenTimeTotalMinutes: number;
  pomodorisTotal: number;
  disciplineAverage: number;
  tasksCompletionRate: number;
  weeklyScoreAverage: number;
  weeks: MonthlySnapshotWeek[];
  goals: MonthlySnapshotGoal[];
  notes?: Partial<Record<MonthlyReviewSectionKey, string>>;
}

export interface MonthlySnapshotInputs {
  monthKey: string;
  summary: MonthlyReviewSummary;
  review: MonthlyReview | null;
  goalSnapshots: AnnualGoalSnapshot[];
}

const sanitizeGoal = (
  snapshot: AnnualGoalSnapshot,
  monthKey: string,
  includeStructure: boolean,
): MonthlySnapshotGoal => {
  const monthPoint = snapshot.monthlyProgress.find((point) => point.monthKey === monthKey) ?? null;
  const evaluation = snapshot.goal.evaluations[monthKey] ?? null;

  return {
    goalId: snapshot.goal.id,
    ...(includeStructure ? { title: snapshot.goal.title } : {}),
    dimension: snapshot.goal.dimension,
    currentValue: snapshot.currentValue,
    targetValue: snapshot.goal.targetValue,
    unit: snapshot.goal.unit,
    progressRatio: snapshot.progressRatio,
    monthValue: monthPoint?.value ?? null,
    evaluationScore: evaluation?.score ?? null,
    evaluationTrend: evaluation?.trend ?? null,
  };
};

export const buildMonthlySnapshot = (
  inputs: MonthlySnapshotInputs,
  scope: AiPayloadScope,
): MonthlySnapshot => {
  const includeStructure = scope === "metrics_and_structure" || scope === "full";
  const includeFreeText = scope === "full";
  const { summary, review, goalSnapshots, monthKey } = inputs;

  return {
    surface: "monthly",
    scope,
    monthKey,
    monthStartDate: summary.monthStartDate,
    monthEndDate: summary.monthEndDate,
    reviewStatus: review?.status ?? "draft",
    daysTracked: summary.daysTracked,
    weeksCovered: summary.weeksCovered,
    weeklyReviewsCompleted: summary.weeklyReviewsCompleted,
    sleepAverage: summary.sleepAverage,
    trcRate: summary.trcRate,
    screenTimeTotalMinutes: summary.screenTimeTotalMinutes,
    pomodorisTotal: summary.pomodorisTotal,
    disciplineAverage: summary.disciplineAverage,
    tasksCompletionRate: summary.tasksCompletionRate,
    weeklyScoreAverage: summary.weeklyScoreAverage,
    weeks: summary.weeks.map((week) => ({
      weekStartDate: week.weekStartDate,
      weekEndDate: week.weekEndDate,
      weeklyScore: week.weeklyScore,
      reviewStatus: week.reviewStatus,
      noteCount: week.noteCount,
    })),
    goals: goalSnapshots.map((snapshot) => sanitizeGoal(snapshot, monthKey, includeStructure)),
    ...(includeFreeText && review ? { notes: { ...review.notes } } : {}),
  };
};

export const resolveMonthlySnapshotInputs = async (
  repository: import("../../storage/repository").AppRepository,
  monthKey: string,
): Promise<MonthlySnapshotInputs> => {
  const year = Number(monthKey.slice(0, 4));
  const [summary, review, goalSnapshots] = await Promise.all([
    repository.computeMonthlyReviewSummary(monthKey),
    repository.getMonthlyReview(monthKey),
    repository.computeAnnualGoalSnapshots(year),
  ]);

  return {
    monthKey,
    summary,
    review,
    goalSnapshots,
  };
};
