import type { RescueTimeGoalRecord } from "../../domain/rescuetime-goals";
import type { RescueTimeAnalyticPayload } from "./parse-analytic-data";
import { parseRankRows } from "./parse-analytic-data";

export interface RescueTimeProjectTimesPayload {
  project_times?: Array<{
    duration?: number;
    project?: {
      id?: number;
      name?: string;
      timesheets_client_id?: number;
    };
  }>;
}

export interface RescueTimeGoalsClient {
  listGoals(apiKey: string): Promise<RescueTimeGoalRecord[]>;
  fetchAnalyticData(apiKey: string, kind: string, begin: string, end: string): Promise<RescueTimeAnalyticPayload>;
  fetchProjectTimes(apiKey: string, begin: string, end: string): Promise<RescueTimeProjectTimesPayload>;
}

export class HttpRescueTimeGoalsClient implements RescueTimeGoalsClient {
  private async fetchJson<T>(apiKey: string, url: string): Promise<T> {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`
      }
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`RescueTime API ${response.status}: ${body.slice(0, 200)}`);
    }

    return response.json() as Promise<T>;
  }

  async listGoals(apiKey: string): Promise<RescueTimeGoalRecord[]> {
    const goals = await this.fetchJson<RescueTimeGoalRecord[]>(
      apiKey,
      "https://www.rescuetime.com/api/resource/goals"
    );
    return goals.filter((goal) => goal.enabled !== false);
  }

  async fetchAnalyticData(
    apiKey: string,
    kind: string,
    begin: string,
    end: string
  ): Promise<RescueTimeAnalyticPayload> {
    const url = new URL("https://www.rescuetime.com/anapi/data");
    url.searchParams.set("format", "json");
    url.searchParams.set("perspective", "rank");
    url.searchParams.set("restrict_kind", kind);
    url.searchParams.set("restrict_begin", begin);
    url.searchParams.set("restrict_end", end);
    return this.fetchJson(apiKey, url.toString());
  }

  async fetchProjectTimes(apiKey: string, begin: string, end: string): Promise<RescueTimeProjectTimesPayload> {
    const url = new URL("https://www.rescuetime.com/api/resource/labeled_time_project_times");
    url.searchParams.set("start_date", begin);
    url.searchParams.set("end_date", end);
    return this.fetchJson(apiKey, url.toString());
  }
}

export const defaultRescueTimeGoalsClient = new HttpRescueTimeGoalsClient();

export interface ParsedProductivityRow {
  productivity: number;
  seconds: number;
}

export const parseProductivityRows = (payload: RescueTimeAnalyticPayload): ParsedProductivityRow[] => {
  const headers = payload.row_headers ?? [];
  const secondsIndex = headers.findIndex((header) => String(header).toLowerCase().includes("time spent"));
  const productivityIndex = headers.findIndex((header) => String(header).toLowerCase() === "productivity");

  return (payload.rows ?? []).map((row) => ({
    productivity: Number(row[productivityIndex] ?? 0),
    seconds: Number(row[secondsIndex] ?? 0)
  }));
};

export const productivitySecondsForGoal = (rows: ParsedProductivityRow[], goal: RescueTimeGoalRecord): number => {
  const productivityId = goal.productivity?.id ?? goal.taxon_id;
  if (productivityId === 7) {
    return rows.filter((row) => row.productivity < 0).reduce((sum, row) => sum + row.seconds, 0);
  }
  if (productivityId === 10) {
    return rows.reduce((sum, row) => sum + row.seconds, 0);
  }
  return 0;
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

export const overviewSecondsForGoal = (
  payload: RescueTimeAnalyticPayload,
  goal: RescueTimeGoalRecord
): number => {
  const rows = parseRankRows(payload);
  const needle = (goal.overview?.name ?? goal.taxon_display_name ?? "").toLowerCase();
  const row = rows.find((item) => item.name.toLowerCase() === needle || item.name.toLowerCase().includes(needle));
  return row?.seconds ?? 0;
};
