import { addDays } from "../lib/gtd/shared";
import { buildWeekDates } from "./weekly-review";
import type {
  WeeklyObjective,
  WeeklyObjectiveItemSnapshot,
  WeeklyObjectiveResult,
  WeeklyObjectivesSnapshot
} from "./types";

export interface RescueTimeSecondsByObjectiveId {
  [objectiveId: string]: number | null;
}

export interface RescueTimeErrorsByObjectiveId {
  [objectiveId: string]: string | undefined;
}

export const scoreTimeObjective = (actualHours: number | null, targetHours: number | null): number => {
  if (actualHours === null || targetHours === null || !Number.isFinite(targetHours) || targetHours <= 0) {
    return 0;
  }

  const safeActual = Math.max(0, actualHours);
  return Math.min(safeActual / targetHours, 1);
};

export const scoreManualObjective = (achieved: boolean): number => (achieved ? 1 : 0);

export const computeWeeklyObjectivesScore = (achievements: number[]): number | null => {
  if (achievements.length === 0) {
    return null;
  }

  const total = achievements.reduce((sum, achievement) => sum + achievement, 0);
  return total / achievements.length;
};

export const cloneWeeklyObjective = (objective: WeeklyObjective): WeeklyObjective => ({
  ...objective
});

export const createEmptyWeeklyObjective = (
  partial: Partial<WeeklyObjective> = {},
  timestamp = new Date().toISOString()
): WeeklyObjective => ({
  id: partial.id ?? "",
  title: partial.title ?? "",
  kind: partial.kind ?? "manual",
  targetHours: partial.targetHours ?? null,
  rescuetimeKind: partial.rescuetimeKind ?? null,
  rescuetimeThing: partial.rescuetimeThing ?? null,
  sortOrder: partial.sortOrder ?? 0,
  createdAt: partial.createdAt ?? timestamp,
  updatedAt: partial.updatedAt ?? timestamp
});

export const buildWeeklyObjectivesSnapshot = (
  weekStartDate: string,
  objectives: WeeklyObjective[],
  results: WeeklyObjectiveResult[],
  rescuetimeSecondsByObjectiveId: RescueTimeSecondsByObjectiveId,
  options: {
    rescuetimeConfigured: boolean;
    fetchError?: string;
    errorsByObjectiveId?: RescueTimeErrorsByObjectiveId;
  }
): WeeklyObjectivesSnapshot => {
  const normalized = buildWeekDates(weekStartDate);
  const weekEndDate = addDays(normalized, 6);
  const resultsByObjectiveId = new Map(results.map((result) => [result.objectiveId, result]));
  const sortedObjectives = [...objectives].sort(
    (left, right) => left.sortOrder - right.sortOrder || left.title.localeCompare(right.title)
  );

  const items: WeeklyObjectiveItemSnapshot[] = sortedObjectives.map((objective) => {
    if (objective.kind === "manual") {
      const result = resultsByObjectiveId.get(objective.id);
      return {
        objective,
        actualHours: null,
        achievement: scoreManualObjective(result?.achieved ?? false),
        source: "manual"
      };
    }

    const error = options.errorsByObjectiveId?.[objective.id];
    if (error) {
      return {
        objective,
        actualHours: null,
        achievement: 0,
        source: "missing",
        error
      };
    }

    const seconds = rescuetimeSecondsByObjectiveId[objective.id];
    if (seconds === undefined || seconds === null) {
      return {
        objective,
        actualHours: null,
        achievement: 0,
        source: "missing"
      };
    }

    const actualHours = seconds / 3600;
    return {
      objective,
      actualHours,
      achievement: scoreTimeObjective(actualHours, objective.targetHours),
      source: "rescuetime"
    };
  });

  const achievements = items.map((item) => item.achievement);
  const totalAchievement = achievements.reduce((sum, achievement) => sum + achievement, 0);

  return {
    weekStartDate: normalized,
    weekEndDate,
    items,
    totalAchievement,
    score: computeWeeklyObjectivesScore(achievements),
    rescuetimeConfigured: options.rescuetimeConfigured,
    fetchError: options.fetchError
  };
};
