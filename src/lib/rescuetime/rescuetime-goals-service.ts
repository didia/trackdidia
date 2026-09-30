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
import { addDays, nowIso } from "../gtd/shared";
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
import {
  currentKeyMatchesFingerprint,
  rescueTimeCredentialFingerprint,
} from "./credential-fingerprint";
import { computeProductivityPulse } from "./productivity-mapping";

/** Opt-in freshness window: a cache entry younger than `maxAgeMs` is served without a pull. */
export interface RescueTimeComputeOptions {
  maxAgeMs?: number;
}

export const isRescueTimeCacheFresh = (
  fetchedAt: string,
  maxAgeMs: number | undefined,
  now: number = Date.now(),
): boolean => {
  if (maxAgeMs === undefined || !(maxAgeMs > 0)) {
    return false;
  }
  const fetched = Date.parse(fetchedAt);
  return Number.isFinite(fetched) && now >= fetched && now - fetched < maxAgeMs;
};

type CachedGoalItem = Omit<RescueTimeGoalItemSnapshot, "achievement">;

const isCachedGoalItem = (value: unknown): value is CachedGoalItem => {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const item = value as Record<string, unknown>;
  return (
    typeof item.goalId === "number" &&
    typeof item.title === "string" &&
    typeof item.isMore === "boolean" &&
    typeof item.actualHours === "number" &&
    Number.isFinite(item.actualHours) &&
    typeof item.weeklyTargetHours === "number" &&
    Number.isFinite(item.weeklyTargetHours) &&
    typeof item.scheduleLabel === "string"
  );
};

/** Parses a `goals` payload; returns `null` when it is not usable (treated as "no cache"). */
const parseGoalsPayload = (payloadJson: string): RescueTimeGoalItemSnapshot[] | null => {
  try {
    const parsed: unknown = JSON.parse(payloadJson);
    const list = (parsed as { items?: unknown } | null)?.items;
    if (!Array.isArray(list) || !list.every(isCachedGoalItem)) {
      return null;
    }
    return list.map((item) => {
      const actualSeconds = item.actualHours * 3600;
      const targetSeconds = item.weeklyTargetHours * 3600;
      return {
        goalId: item.goalId,
        title: item.title,
        isMore: item.isMore,
        actualHours: item.actualHours,
        weeklyTargetHours: item.weeklyTargetHours,
        scheduleLabel: item.scheduleLabel,
        achievement: item.isMore
          ? scoreMoreGoal(actualSeconds, targetSeconds)
          : scoreLessGoal(actualSeconds, targetSeconds),
      };
    });
  } catch {
    return null;
  }
};

/** Parses a `pulse` payload; `{ found: false }` for anything unusable, `null` pulse is valid. */
const parsePulsePayload = (payloadJson: string): { found: boolean; pulse: number | null } => {
  try {
    const pulse = (JSON.parse(payloadJson) as { pulse?: unknown } | null)?.pulse;
    if (pulse === null) {
      return { found: true, pulse: null };
    }
    if (typeof pulse === "number" && Number.isFinite(pulse)) {
      return { found: true, pulse };
    }
  } catch {
    // fall through: treated as "no cache"
  }
  return { found: false, pulse: null };
};

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
  /** Set when the pulse comes from the snapshot cache instead of a live pull. */
  cachedAt?: string;
}

export class RescueTimeGoalsService {
  constructor(
    private readonly repository: AppRepository,
    private readonly client: RescueTimeGoalsClient = defaultRescueTimeGoalsClient,
  ) {}

  /**
   * Reads the entry first, then confirms the saved key still matches the captured fingerprint, so
   * a key switch or removal while the read was pending never surfaces the old account's numbers.
   */
  private async readCache(weekStartDate: string, kind: "goals" | "pulse", fingerprint: string) {
    let entry: Awaited<ReturnType<AppRepository["getRescueTimeSnapshotCache"]>>;
    try {
      entry = await this.repository.getRescueTimeSnapshotCache(weekStartDate, kind, fingerprint);
    } catch {
      return null;
    }
    if (!entry || !(await currentKeyMatchesFingerprint(this.repository, fingerprint))) {
      return null;
    }
    return entry;
  }

  async computeGoalsSnapshot(
    weekStartDate: string,
    options: RescueTimeComputeOptions = {},
  ): Promise<RescueTimeGoalsSnapshot> {
    const normalized = buildWeekDates(weekStartDate);
    const weekEndDate = addDays(normalized, 6);
    const settings = await this.repository.getSettings();
    const apiKey = settings.rescuetimeApiKey.trim();
    const rescuetimeConfigured = apiKey.length > 0;

    if (!rescuetimeConfigured) {
      return computeRescueTimeGoalsSnapshot(normalized, weekEndDate, [], { rescuetimeConfigured });
    }

    // Captured once: the write below uses this value even if the key changes mid-pull.
    const fingerprint = await rescueTimeCredentialFingerprint(apiKey);

    if (options.maxAgeMs !== undefined && options.maxAgeMs > 0) {
      const entry = await this.readCache(normalized, "goals", fingerprint);
      const cachedItems = entry ? parseGoalsPayload(entry.payloadJson) : null;
      if (entry && cachedItems && isRescueTimeCacheFresh(entry.fetchedAt, options.maxAgeMs)) {
        return computeRescueTimeGoalsSnapshot(normalized, weekEndDate, cachedItems, {
          rescuetimeConfigured,
          cachedAt: entry.fetchedAt,
        });
      }
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

      try {
        await this.repository.saveRescueTimeSnapshotCache({
          weekStartDate: normalized,
          kind: "goals",
          credentialFingerprint: fingerprint,
          payloadJson: JSON.stringify({
            items: items.map(({ achievement: _achievement, ...rest }) => rest),
          }),
          fetchedAt: nowIso(),
        });
      } catch {
        // A cache-write failure never fails the pull.
      }

      return computeRescueTimeGoalsSnapshot(normalized, weekEndDate, items, {
        rescuetimeConfigured,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Echec de la requete RescueTime Goals.";
      const entry = await this.readCache(normalized, "goals", fingerprint);
      const cachedItems = entry ? parseGoalsPayload(entry.payloadJson) : null;
      if (entry && cachedItems) {
        return computeRescueTimeGoalsSnapshot(normalized, weekEndDate, cachedItems, {
          rescuetimeConfigured,
          cachedAt: entry.fetchedAt,
        });
      }
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
    const taxonomy = goal.taxonomy_name ?? goal.taxonomy?.search_name ?? "";
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
    options: RescueTimeComputeOptions = {},
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

    const fingerprint = await rescueTimeCredentialFingerprint(apiKey);

    if (options.maxAgeMs !== undefined && options.maxAgeMs > 0) {
      const entry = await this.readCache(normalized, "pulse", fingerprint);
      const cached = entry ? parsePulsePayload(entry.payloadJson) : null;
      if (entry && cached?.found && isRescueTimeCacheFresh(entry.fetchedAt, options.maxAgeMs)) {
        return {
          weekStartDate: normalized,
          weekEndDate,
          pulse: cached.pulse,
          rescuetimeConfigured,
          cachedAt: entry.fetchedAt,
        };
      }
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

      try {
        await this.repository.saveRescueTimeSnapshotCache({
          weekStartDate: normalized,
          kind: "pulse",
          credentialFingerprint: fingerprint,
          payloadJson: JSON.stringify({ pulse }),
          fetchedAt: nowIso(),
        });
      } catch {
        // A cache-write failure never fails the pull.
      }

      return {
        weekStartDate: normalized,
        weekEndDate,
        pulse,
        rescuetimeConfigured,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Echec de la requete RescueTime productivity.";
      const entry = await this.readCache(normalized, "pulse", fingerprint);
      const cached = entry ? parsePulsePayload(entry.payloadJson) : null;
      if (entry && cached?.found) {
        return {
          weekStartDate: normalized,
          weekEndDate,
          pulse: cached.pulse,
          rescuetimeConfigured,
          cachedAt: entry.fetchedAt,
        };
      }
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
