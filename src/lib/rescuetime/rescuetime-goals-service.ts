import {
  computeRescueTimeGoalsSnapshot,
  type RescueTimeGoalItemSnapshot,
  type RescueTimeGoalRecord,
  type RescueTimeGoalsSnapshot,
  rescueTimeLabelsMatch,
  scheduleDaysInWeek,
  scoreLessGoal,
  scoreMoreGoal,
} from "../../domain/rescuetime-goals";
import { buildWeekDates } from "../../domain/weekly-review";
import { addDays } from "../gtd/shared";
import type { AppRepository } from "../storage/repository";
import {
  aggregateProjectTimes,
  defaultRescueTimeGoalsClient,
  goalScheduleId,
  matchRankRowSeconds,
  parseProductivityRows,
  parseRankRows,
  productivitySecondsForGoal,
  type RescueTimeGoalsClient,
  resolveAnalyticKind,
} from "./goals-client";
import { computeProductivityPulse } from "./productivity-mapping";

interface AnalyticCache {
  productivity: Map<number, ReturnType<typeof parseProductivityRows>>;
  overview: Map<number, ReturnType<typeof parseRankRows>>;
  category: Map<number, ReturnType<typeof parseRankRows>>;
  activity: Map<number, ReturnType<typeof parseRankRows>>;
}

const createAnalyticCache = (): AnalyticCache => ({
  productivity: new Map(),
  overview: new Map(),
  category: new Map(),
  activity: new Map(),
});

export interface RescueTimeProductivityPulseSnapshot {
  weekStartDate: string;
  weekEndDate: string;
  pulse: number | null;
  rescuetimeConfigured: boolean;
  fetchError?: string;
}

export class RescueTimeGoalsService {
  constructor(
    private readonly repository: AppRepository,
    private readonly client: RescueTimeGoalsClient = defaultRescueTimeGoalsClient,
  ) {}

  async computeGoalsSnapshot(weekStartDate: string): Promise<RescueTimeGoalsSnapshot> {
    const normalized = buildWeekDates(weekStartDate);
    const weekEndDate = addDays(normalized, 6);
    const settings = await this.repository.getSettings();
    const apiKey = settings.rescuetimeApiKey.trim();
    const rescuetimeConfigured = apiKey.length > 0;

    if (!rescuetimeConfigured) {
      return computeRescueTimeGoalsSnapshot(normalized, weekEndDate, [], { rescuetimeConfigured });
    }

    try {
      const goals = await this.client.listGoals(apiKey);
      const caches = createAnalyticCache();
      let projectTimesCache: ReturnType<typeof aggregateProjectTimes> | undefined;
      const items: RescueTimeGoalItemSnapshot[] = [];

      for (const goal of goals) {
        const scheduleLabel = goal.schedule?.name ?? goal.schedule_name ?? "24x7";
        const days = scheduleDaysInWeek(scheduleLabel);
        const weeklyTargetSeconds = Number(goal.amount_seconds ?? 0) * days;
        const actualSeconds = await this.resolveActualSeconds(
          apiKey,
          goal,
          normalized,
          weekEndDate,
          caches,
          async () => {
            if (!projectTimesCache) {
              const payload = await this.client.fetchProjectTimes(apiKey, normalized, weekEndDate);
              projectTimesCache = aggregateProjectTimes(payload);
            }
            return projectTimesCache;
          },
        );
        const achievement = goal.is_more
          ? scoreMoreGoal(actualSeconds, weeklyTargetSeconds)
          : scoreLessGoal(actualSeconds, weeklyTargetSeconds);

        items.push({
          goalId: goal.id,
          title: goal.display_name,
          isMore: goal.is_more,
          actualHours: actualSeconds / 3600,
          weeklyTargetHours: weeklyTargetSeconds / 3600,
          achievement,
          scheduleLabel,
        });
      }

      return computeRescueTimeGoalsSnapshot(normalized, weekEndDate, items, {
        rescuetimeConfigured,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Echec de la requete RescueTime Goals.";
      return computeRescueTimeGoalsSnapshot(normalized, weekEndDate, [], {
        rescuetimeConfigured,
        fetchError: message,
      });
    }
  }

  private async loadProductivityRows(
    apiKey: string,
    weekStart: string,
    weekEnd: string,
    scheduleId: number,
    caches: AnalyticCache,
  ) {
    if (!caches.productivity.has(scheduleId)) {
      const payload = await this.client.fetchAnalyticData(apiKey, {
        kind: "productivity",
        begin: weekStart,
        end: weekEnd,
        scheduleId,
      });
      caches.productivity.set(scheduleId, parseProductivityRows(payload));
    }
    return caches.productivity.get(scheduleId)!;
  }

  private async loadRankRows(
    apiKey: string,
    kind: "overview" | "category" | "activity",
    weekStart: string,
    weekEnd: string,
    scheduleId: number,
    caches: AnalyticCache,
  ) {
    const cacheMap = caches[kind];
    if (!cacheMap.has(scheduleId)) {
      const payload = await this.client.fetchAnalyticData(apiKey, {
        kind,
        begin: weekStart,
        end: weekEnd,
        scheduleId,
      });
      cacheMap.set(scheduleId, parseRankRows(payload));
    }
    return cacheMap.get(scheduleId)!;
  }

  private async resolveActualSeconds(
    apiKey: string,
    goal: RescueTimeGoalRecord,
    weekStart: string,
    weekEnd: string,
    caches: AnalyticCache,
    ensureProjectTimesCache: () => Promise<ReturnType<typeof aggregateProjectTimes>>,
  ): Promise<number> {
    const taxonomy = goal.taxonomy?.search_name ?? goal.taxonomy_name ?? "";
    const scheduleId = goalScheduleId(goal);

    if (taxonomy === "projects" || goal.v2project) {
      const projectTimes = await ensureProjectTimesCache();
      const label = goal.v2project?.name ?? goal.taxon_display_name ?? "";
      for (const [name, seconds] of projectTimes.byName) {
        if (rescueTimeLabelsMatch(name, label)) {
          return seconds;
        }
      }
      return 0;
    }

    if (taxonomy === "clients") {
      const projectTimes = await ensureProjectTimesCache();
      return projectTimes.byClientId.get(goal.taxon_id) ?? 0;
    }

    const analyticKind = resolveAnalyticKind(goal);
    if (analyticKind === "productivity") {
      const rows = await this.loadProductivityRows(apiKey, weekStart, weekEnd, scheduleId, caches);
      return productivitySecondsForGoal(rows, goal);
    }

    const rankKind = analyticKind as "overview" | "category" | "activity";
    const rows = await this.loadRankRows(apiKey, rankKind, weekStart, weekEnd, scheduleId, caches);
    return matchRankRowSeconds(rows, goal, rankKind);
  }

  async computeProductivityPulse(
    weekStartDate: string,
  ): Promise<RescueTimeProductivityPulseSnapshot> {
    const normalized = buildWeekDates(weekStartDate);
    const weekEndDate = addDays(normalized, 6);
    const settings = await this.repository.getSettings();
    const apiKey = settings.rescuetimeApiKey.trim();
    const rescuetimeConfigured = apiKey.length > 0;

    if (!rescuetimeConfigured) {
      return {
        weekStartDate: normalized,
        weekEndDate,
        pulse: null,
        rescuetimeConfigured,
      };
    }

    try {
      const payload = await this.client.fetchAnalyticData(apiKey, {
        kind: "productivity",
        begin: normalized,
        end: weekEndDate,
        sourceType: "computers",
      });
      const rows = parseProductivityRows(payload);
      const pulse = computeProductivityPulse(rows);

      return {
        weekStartDate: normalized,
        weekEndDate,
        pulse,
        rescuetimeConfigured,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Echec de la requete RescueTime productivity.";
      return {
        weekStartDate: normalized,
        weekEndDate,
        pulse: null,
        rescuetimeConfigured,
        fetchError: message,
      };
    }
  }

  async testConnection(apiKey: string): Promise<{ goalCount: number; sampleGoal?: string }> {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      throw new Error("Cle API RescueTime manquante.");
    }

    const goals = await this.client.listGoals(trimmed);
    return {
      goalCount: goals.length,
      sampleGoal: goals[0]?.display_name,
    };
  }
}
