import type { PrincipleKey } from "./daily";

export type AnnualGoalDimension =
  | "physique"
  | "spirituelle"
  | "sociale"
  | "intellectuelle"
  | "global";
export type AnnualGoalTrend = "up" | "steady" | "down";
export type AnnualGoalSourceType = "weekly_summary" | "daily_metric" | "daily_principle" | "manual";

export type AnnualGoalSourceId =
  | "weekly_sleep_average"
  | "weekly_respect_trc"
  | "weekly_weekly_score"
  | "weekly_discipline"
  | "weekly_tasks_completion_rate"
  | "daily_depense_calorique_avg"
  | "daily_qualite_sommeil_avg"
  | "daily_temps_ecran_avg"
  | "daily_pomodoris_sum"
  | "daily_pomodoris_avg"
  | "daily_respect_trc_rate"
  | "daily_respect_reveil_rate"
  | "daily_priere_du_matin_rate"
  | "daily_priere_du_soir_rate"
  | "daily_objectifs_atteints_rate";

export interface AnnualGoalEvaluation {
  monthKey: string;
  score: number | null;
  trend: AnnualGoalTrend | null;
  notes: string;
  blockers: string;
}

export type AnnualGoalEvaluations = Record<string, AnnualGoalEvaluation>;

export type AnnualGoalMeasurementType = "binary" | "numeric" | "cumulative" | "recurring";
export type AnnualGoalDirection = "increase" | "decrease";
export type AnnualGoalStatus = "active" | "paused" | "achieved" | "abandoned";
export type AnnualGoalCadencePeriod = "week" | "month";

export interface AnnualGoalMilestone {
  id: string;
  title: string;
  completedAt: string | null;
  sortOrder: number;
}

export interface AnnualGoal {
  id: string;
  title: string;
  dimension: AnnualGoalDimension;
  description: string;
  targetValue: number | null;
  unit: string;
  sourceId: AnnualGoalSourceId | null;
  manualCurrentValue: number | null;
  evaluations: AnnualGoalEvaluations;
  measurementType: AnnualGoalMeasurementType;
  status: AnnualGoalStatus;
  deadline: string | null;
  startingValue: number | null;
  direction: AnnualGoalDirection | null;
  cadenceTarget: number | null;
  cadencePeriod: AnnualGoalCadencePeriod;
  principleKey: PrincipleKey | null;
  progressLog: Record<string, number>;
  milestones: AnnualGoalMilestone[];
  createdAt: string;
  updatedAt: string;
}

export interface AnnualGoalProgressPoint {
  monthKey: string;
  value: number | null;
}

export interface AnnualGoalMeasurement {
  measurementType: AnnualGoalMeasurementType;
  direction: AnnualGoalDirection;
  // recurring
  currentPeriodKey: string | null;
  currentPeriodCount: number | null;
  cadenceTarget: number | null;
  adherenceRatio: number | null;
  periodsMet: number;
  periodsElapsed: number;
  currentStreak: number;
  // milestones (any type)
  milestonesCompleted: number;
  milestonesTotal: number;
  milestoneProgressRatio: number | null;
  // pacing
  expectedProgressRatio: number | null;
  onPace: boolean;
}

export interface AnnualGoalSnapshot {
  goal: AnnualGoal;
  sourceType: AnnualGoalSourceType;
  sourceLabel: string | null;
  currentValue: number | null;
  progressRatio: number | null;
  monthlyProgress: AnnualGoalProgressPoint[];
  linkedWeeklyMetricLabels: string[];
  linkedDailyHabitLabels: string[];
  measurement: AnnualGoalMeasurement;
}
