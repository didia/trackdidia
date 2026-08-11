import { addDays } from "../gtd/shared";
import {
  computeRescueTimeGoalsSnapshot,
  rescueTimeLabelsMatch,
  scheduleDaysInWeek,
  scoreLessGoal,
  scoreMoreGoal,
  type RescueTimeGoalItemSnapshot,
  type RescueTimeGoalRecord,
  type RescueTimeGoalsSnapshot
} from "../../domain/rescuetime-goals";
import { buildWeekDates } from "../../domain/weekly-review";
import type { AppRepository } from "../storage/repository";
import {
  aggregateProjectTimes,
  defaultRescueTimeGoalsClient,
  parseProductivityRows,
  productivitySecondsForGoal,
  type RescueTimeGoalsClient
} from "./goals-client";
import { parseRankRows } from "./parse-analytic-data";

interface FetchCaches {
  productivity?: ReturnType<typeof parseProductivityRows>;
  overview?: ReturnType<typeof import("./parse-analytic-data").parseRankRows>;
  projectTimes?: ReturnType<typeof aggregateProjectTimes>;
}

export class RescueTimeGoalsService {
  constructor(
    private readonly repository: AppRepository,
    private readonly client: RescueTimeGoalsClient = defaultRescueTimeGoalsClient
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
      const caches: FetchCaches = {};
      const items: RescueTimeGoalItemSnapshot[] = [];

      for (const goal of goals) {
        const scheduleLabel = goal.schedule?.name ?? goal.schedule_name ?? "24x7";
        const days = scheduleDaysInWeek(scheduleLabel);
        const weeklyTargetSeconds = Number(goal.amount_seconds ?? 0) * days;
        const actualSeconds = await this.resolveActualSeconds(apiKey, goal, normalized, weekEndDate, caches);
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
          scheduleLabel
        });
      }

      return computeRescueTimeGoalsSnapshot(normalized, weekEndDate, items, { rescuetimeConfigured });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Echec de la requete RescueTime Goals.";
      return computeRescueTimeGoalsSnapshot(normalized, weekEndDate, [], {
        rescuetimeConfigured,
        fetchError: message
      });
    }
  }

  private async resolveActualSeconds(
    apiKey: string,
    goal: RescueTimeGoalRecord,
    weekStart: string,
    weekEnd: string,
    caches: FetchCaches
  ): Promise<number> {
    const taxonomy = goal.taxonomy?.search_name ?? goal.taxonomy_name ?? "";

    if (taxonomy === "projects" || goal.v2project) {
      if (!caches.projectTimes) {
        const payload = await this.client.fetchProjectTimes(apiKey, weekStart, weekEnd);
        caches.projectTimes = aggregateProjectTimes(payload);
      }
      const label = goal.v2project?.name ?? goal.taxon_display_name ?? "";
      for (const [name, seconds] of caches.projectTimes.byName) {
        if (rescueTimeLabelsMatch(name, label)) {
          return seconds;
        }
      }
      return 0;
    }

    if (taxonomy === "clients") {
      if (!caches.projectTimes) {
        const payload = await this.client.fetchProjectTimes(apiKey, weekStart, weekEnd);
        caches.projectTimes = aggregateProjectTimes(payload);
      }
      return caches.projectTimes.byClientId.get(goal.taxon_id) ?? 0;
    }

    if (taxonomy === "productivity") {
      if (!caches.productivity) {
        const payload = await this.client.fetchAnalyticData(apiKey, "productivity", weekStart, weekEnd);
        caches.productivity = parseProductivityRows(payload);
      }
      return productivitySecondsForGoal(caches.productivity, goal);
    }

    if (taxonomy === "category" || taxonomy === "overviews" || taxonomy === "overview" || goal.overview) {
      if (!caches.overview) {
        const payload = await this.client.fetchAnalyticData(apiKey, "overview", weekStart, weekEnd);
        caches.overview = parseRankRows(payload);
      }
      const needle = (goal.overview?.name ?? goal.taxon_display_name ?? "").toLowerCase();
      const row = caches.overview.find(
        (item) => item.name.toLowerCase() === needle || item.name.toLowerCase().includes(needle)
      );
      return row?.seconds ?? 0;
    }

    return 0;
  }

  async testConnection(apiKey: string): Promise<{ goalCount: number; sampleGoal?: string }> {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      throw new Error("Cle API RescueTime manquante.");
    }

    const goals = await this.client.listGoals(trimmed);
    return {
      goalCount: goals.length,
      sampleGoal: goals[0]?.display_name
    };
  }
}
