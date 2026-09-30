export interface RescueTimeGoalRecord {
  id: number;
  display_name: string;
  taxon_display_name?: string;
  amount_seconds: number;
  is_more: boolean;
  enabled?: boolean;
  taxonomy_name?: string;
  schedule_name?: string;
  schedule_id?: number;
  schedule?: { id?: number; name?: string };
  taxon_id: number;
  taxonomy?: { search_name?: string };
  productivity?: {
    id?: number;
    display_name?: string;
    name?: string;
    sql_score_equals?: string;
  };
  overview?: { name?: string };
  v2project?: { name?: string };
}

export interface RescueTimeGoalItemSnapshot {
  goalId: number;
  title: string;
  isMore: boolean;
  actualHours: number;
  weeklyTargetHours: number;
  achievement: number;
  scheduleLabel: string;
}

export interface RescueTimeGoalsSnapshot {
  weekStartDate: string;
  weekEndDate: string;
  items: RescueTimeGoalItemSnapshot[];
  totalAchievement: number;
  score: number | null;
  rescuetimeConfigured: boolean;
  fetchError?: string;
  /** Set when the items come from the snapshot cache instead of a live pull. */
  cachedAt?: string;
}

export const scheduleDaysInWeek = (scheduleName: string | undefined): number => {
  const normalized = (scheduleName ?? "").toLowerCase();
  if (
    normalized.includes("working") ||
    normalized.includes("weekday") ||
    normalized.includes("work hour")
  ) {
    return 5;
  }
  return 7;
};

export const scoreMoreGoal = (actualSeconds: number, targetSeconds: number): number => {
  if (targetSeconds <= 0) {
    return 0;
  }
  return Math.min(Math.max(0, actualSeconds) / targetSeconds, 1);
};

export const scoreLessGoal = (actualSeconds: number, targetSeconds: number): number => {
  if (targetSeconds <= 0) {
    return 0;
  }
  const actual = Math.max(0, actualSeconds);
  if (actual <= targetSeconds) {
    return 1;
  }
  return Math.min(targetSeconds / actual, 1);
};

export const computeRescueTimeGoalsSnapshot = (
  weekStartDate: string,
  weekEndDate: string,
  items: RescueTimeGoalItemSnapshot[],
  options: { rescuetimeConfigured: boolean; fetchError?: string; cachedAt?: string },
): RescueTimeGoalsSnapshot => {
  const achievements = items.map((item) => item.achievement);
  const totalAchievement = achievements.reduce((sum, achievement) => sum + achievement, 0);

  return {
    weekStartDate,
    weekEndDate,
    items,
    totalAchievement,
    score: achievements.length > 0 ? totalAchievement / achievements.length : null,
    rescuetimeConfigured: options.rescuetimeConfigured,
    fetchError: options.fetchError,
    ...(options.cachedAt ? { cachedAt: options.cachedAt } : {}),
  };
};

export interface CachedObjectiveSecondsValue {
  seconds: number;
  fetchedAt: string;
}

export type CachedObjectiveSeconds = Record<string, CachedObjectiveSecondsValue>;

const isCachedObjectiveSecondsValue = (value: unknown): value is CachedObjectiveSecondsValue =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as CachedObjectiveSecondsValue).seconds === "number" &&
  Number.isFinite((value as CachedObjectiveSecondsValue).seconds) &&
  typeof (value as CachedObjectiveSecondsValue).fetchedAt === "string";

/** Defensive parse of an `objective_seconds` payload; anything unparseable counts as empty. */
export const parseObjectiveSecondsPayload = (
  payloadJson: string | null,
): CachedObjectiveSeconds => {
  if (!payloadJson) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(payloadJson);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const result: CachedObjectiveSeconds = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (isCachedObjectiveSecondsValue(value)) {
        result[id] = { seconds: value.seconds, fetchedAt: value.fetchedAt };
      }
    }
    return result;
  } catch {
    return {};
  }
};

/**
 * Merges freshly pulled objective seconds into the existing cached map. Incoming ids overwrite;
 * every other id keeps its own `fetchedAt`. An unparseable existing payload counts as empty.
 */
export const mergeObjectiveSecondsPayload = (
  existingPayloadJson: string | null,
  values: CachedObjectiveSeconds,
): CachedObjectiveSeconds => ({
  ...parseObjectiveSecondsPayload(existingPayloadJson),
  ...values,
});

export const normalizeRescueTimeLabel = (value: string): string =>
  value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export const rescueTimeLabelsMatch = (left: string, right: string): boolean => {
  const a = normalizeRescueTimeLabel(left);
  const b = normalizeRescueTimeLabel(right);
  if (!a || !b) {
    return false;
  }
  return (
    a.includes(b) ||
    b.includes(a) ||
    a.split(" ").some((token) => token.length > 3 && b.includes(token))
  );
};
