import { normalizeRescueTimeLabel, type RescueTimeGoalRecord } from "../../domain/rescuetime-goals";
import { addDays } from "../gtd/shared";
import type { RescueTimeAnalyticPayload } from "./parse-analytic-data";
import { parseRankRows } from "./parse-analytic-data";
import { fetchRescueTimeJson } from "./http-transport";
import { productivitySecondsForGoal, type ParsedProductivityRow } from "./productivity-mapping";

export { parseRankRows };

export interface RescueTimeProjectTimesPayload {
  is_complete?: boolean;
  job_id?: string | number | null;
  project_times?: Array<{
    duration?: number;
    project?: {
      id?: number;
      name?: string;
      timesheets_client_id?: number;
    };
  }>;
}

export interface RescueTimeAnalyticQuery {
  kind: string;
  begin: string;
  end: string;
  scheduleId?: number;
  sourceType?: string;
}

export interface RescueTimeGoalsClient {
  listGoals(apiKey: string): Promise<RescueTimeGoalRecord[]>;
  fetchAnalyticData(apiKey: string, query: RescueTimeAnalyticQuery): Promise<RescueTimeAnalyticPayload>;
  fetchProjectTimes(apiKey: string, begin: string, end: string): Promise<RescueTimeProjectTimesPayload>;
}

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });

export class HttpRescueTimeGoalsClient implements RescueTimeGoalsClient {
  async listGoals(apiKey: string): Promise<RescueTimeGoalRecord[]> {
    const goals = await fetchRescueTimeJson<RescueTimeGoalRecord[]>(
      "https://www.rescuetime.com/api/resource/goals",
      apiKey
    );
    return goals.filter((goal) => goal.enabled !== false);
  }

  async fetchAnalyticData(apiKey: string, query: RescueTimeAnalyticQuery): Promise<RescueTimeAnalyticPayload> {
    const url = new URL("https://www.rescuetime.com/anapi/data");
    url.searchParams.set("format", "json");
    url.searchParams.set("perspective", "rank");
    url.searchParams.set("restrict_kind", query.kind);
    url.searchParams.set("restrict_begin", query.begin);
    url.searchParams.set("restrict_end", query.end);
    if (query.scheduleId !== undefined && query.scheduleId > 0) {
      url.searchParams.set("restrict_schedule_id", String(query.scheduleId));
    }
    if (query.sourceType) {
      url.searchParams.set("restrict_source_type", query.sourceType);
    }
    return fetchRescueTimeJson<RescueTimeAnalyticPayload>(url.toString(), apiKey);
  }

  async fetchProjectTimes(apiKey: string, begin: string, end: string): Promise<RescueTimeProjectTimesPayload> {
    const projectTimes: NonNullable<RescueTimeProjectTimesPayload["project_times"]> = [];

    for (let cursor = begin; cursor <= end; cursor = addDays(cursor, 1)) {
      const url = new URL("https://www.rescuetime.com/api/resource/labeled_time_project_times");
      url.searchParams.set("date", cursor);

      for (let attempt = 0; attempt < 12; attempt += 1) {
        const payload = await fetchRescueTimeJson<RescueTimeProjectTimesPayload>(url.toString(), apiKey);
        if (payload.is_complete !== false) {
          projectTimes.push(...(payload.project_times ?? []));
          break;
        }
        if (attempt === 11) {
          throw new Error(`RescueTime project times query did not complete for ${cursor}.`);
        }
        await sleep(500);
      }
    }

    return { is_complete: true, project_times: projectTimes };
  }
}

export const defaultRescueTimeGoalsClient = new HttpRescueTimeGoalsClient();

export { productivitySecondsForGoal, type ParsedProductivityRow };

export const parseProductivityRows = (payload: RescueTimeAnalyticPayload): ParsedProductivityRow[] => {
  const headers = payload.row_headers ?? [];
  const secondsIndex = headers.findIndex((header) => String(header).toLowerCase().includes("time spent"));
  const productivityIndex = headers.findIndex((header) => String(header).toLowerCase() === "productivity");

  return (payload.rows ?? []).map((row) => ({
    productivity: Number(row[productivityIndex] ?? 0),
    seconds: Number(row[secondsIndex] ?? 0)
  }));
};

export const aggregateProjectTimes = (payload: RescueTimeProjectTimesPayload) => {
  const byName = new Map<string, number>();
  const byClientId = new Map<number, number>();

  for (const entry of payload.project_times ?? []) {
    const projectName = (entry.project?.name ?? "").toLowerCase().trim();
    const clientId = entry.project?.timesheets_client_id;
    const duration = Number(entry.duration ?? 0);

    if (projectName) {
      byName.set(projectName, (byName.get(projectName) ?? 0) + duration);
    }
    if (clientId) {
      byClientId.set(clientId, (byClientId.get(clientId) ?? 0) + duration);
    }
  }

  return { byName, byClientId };
};

export const resolveAnalyticKind = (goal: RescueTimeGoalRecord): string => {
  const taxonomy = goal.taxonomy?.search_name ?? goal.taxonomy_name ?? "";
  if (taxonomy === "productivity") {
    return "productivity";
  }
  if (taxonomy === "category") {
    return "category";
  }
  if (taxonomy === "activity") {
    return "activity";
  }
  return "overview";
};

export const matchRankRowSeconds = (
  rows: ReturnType<typeof parseRankRows>,
  goal: RescueTimeGoalRecord,
  kind: string
): number => {
  const needle = normalizeRescueTimeLabel(
    goal.taxon_display_name ??
      goal.overview?.name ??
      goal.v2project?.name ??
      goal.productivity?.display_name ??
      goal.productivity?.name ??
      ""
  );

  if (!needle) {
    return 0;
  }

  for (const item of rows) {
    const normalizedName = normalizeRescueTimeLabel(item.name);
    if (normalizedName === needle) {
      return item.seconds;
    }
  }

  let bestMatch: { seconds: number; nameLength: number } | null = null;

  for (const item of rows) {
    const normalizedName = normalizeRescueTimeLabel(item.name);
    if (!normalizedName) {
      continue;
    }

    const isPartialMatch = normalizedName.includes(needle) || needle.includes(normalizedName);
    if (!isPartialMatch) {
      continue;
    }

    if (!bestMatch || normalizedName.length > bestMatch.nameLength) {
      bestMatch = { seconds: item.seconds, nameLength: normalizedName.length };
    }
  }

  return bestMatch?.seconds ?? 0;
};

export const goalScheduleId = (goal: RescueTimeGoalRecord): number =>
  Number(goal.schedule_id ?? goal.schedule?.id ?? 0);
