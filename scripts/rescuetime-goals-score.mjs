#!/usr/bin/env node
/**
 * Score weekly objectives from RescueTime Goals (Resource API + time data).
 *
 * Usage: node scripts/rescuetime-goals-score.mjs [--week YYYY-MM-DD]
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const loadEnvFile = () => {
  try {
    const raw = readFileSync(join(repoRoot, ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    // optional
  }
};

loadEnvFile();

const getWeekStartSunday = (dateText) => {
  const date = new Date(`${dateText}T12:00:00`);
  date.setDate(date.getDate() - date.getDay());
  return date.toISOString().slice(0, 10);
};

const addDays = (dateText, days) => {
  const date = new Date(`${dateText}T12:00:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
};

const scheduleDaysInWeek = (scheduleName) => {
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

const scoreMoreGoal = (actualSeconds, targetSeconds) => {
  if (targetSeconds <= 0) return 0;
  return Math.min(Math.max(0, actualSeconds) / targetSeconds, 1);
};

const scoreLessGoal = (actualSeconds, targetSeconds) => {
  if (targetSeconds <= 0) return 0;
  const actual = Math.max(0, actualSeconds);
  if (actual <= targetSeconds) return 1;
  return Math.min(targetSeconds / actual, 1);
};

const findSecondsColumnIndex = (rowHeaders) => {
  const normalized = rowHeaders.map((header) => String(header).toLowerCase());
  return normalized.findIndex((header) => header.includes("time spent"));
};

const findNameColumnIndex = (rowHeaders, kind) => {
  const normalized = rowHeaders.map((header) => String(header).toLowerCase());
  if (kind === "productivity") {
    const productivityIndex = normalized.findIndex((header) => header.includes("productivity"));
    if (productivityIndex >= 0) return productivityIndex;
  }
  const categoryIndex = normalized.findIndex((header) => header === "category" || header.includes("overview"));
  if (categoryIndex >= 0) return categoryIndex;
  return normalized.length > 1 ? normalized.length - 1 : 1;
};

const parseRankRows = (payload, kind) => {
  const headers = payload.row_headers ?? [];
  const secondsIndex = findSecondsColumnIndex(headers);
  const nameIndex = findNameColumnIndex(headers, kind);
  return (payload.rows ?? []).map((row) => ({
    name: String(row[nameIndex] ?? "").toLowerCase(),
    productivity: kind === "productivity" ? Number(row[nameIndex] ?? 0) : null,
    seconds: Number(row[secondsIndex] ?? 0)
  }));
};

class RescueTimeGoalsClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.headers = { Authorization: `Bearer ${apiKey}` };
  }

  async fetchJson(url, options = {}) {
    const response = await fetch(url, { ...options, headers: { ...this.headers, ...options.headers } });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`${url} → ${response.status}: ${body.slice(0, 200)}`);
    }
    return response.json();
  }

  async listGoals() {
    const goals = await this.fetchJson("https://www.rescuetime.com/api/resource/goals");
    return goals.filter((goal) => goal.enabled !== false);
  }

  async fetchAnalyticRank(kind, begin, end, scheduleId = 0) {
    const url = new URL("https://www.rescuetime.com/anapi/data");
    url.searchParams.set("format", "json");
    url.searchParams.set("perspective", "rank");
    url.searchParams.set("restrict_kind", kind);
    url.searchParams.set("restrict_begin", begin);
    url.searchParams.set("restrict_end", end);
    if (scheduleId > 0) {
      url.searchParams.set("restrict_schedule_id", String(scheduleId));
    }
    return this.fetchJson(url);
  }

  async fetchProjectTimesByName(begin, end) {
    const byName = new Map();
    const byClientId = new Map();

    for (let cursor = begin; cursor <= end; cursor = addDays(cursor, 1)) {
      const url = new URL("https://www.rescuetime.com/api/resource/labeled_time_project_times");
      url.searchParams.set("date", cursor);

      for (let attempt = 0; attempt < 12; attempt += 1) {
        const payload = await this.fetchJson(url);
        if (payload.is_complete !== false) {
          for (const entry of payload.project_times ?? []) {
            const projectName = normalizeLabel(entry.project?.name ?? "");
            const clientId = entry.project?.timesheets_client_id;
            const duration = Number(entry.duration ?? 0);
            if (projectName) {
              byName.set(projectName, (byName.get(projectName) ?? 0) + duration);
            }
            if (clientId) {
              byClientId.set(clientId, (byClientId.get(clientId) ?? 0) + duration);
            }
          }
          break;
        }
        if (attempt === 11) {
          throw new Error(`RescueTime project times query did not complete for ${cursor}.`);
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    return { byName, byClientId };
  }
}

const normalizeLabel = (value) =>
  value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const labelsMatch = (left, right) => {
  const a = normalizeLabel(left);
  const b = normalizeLabel(right);
  if (!a || !b) return false;
  return a.includes(b) || b.includes(a) || a.split(" ").some((token) => token.length > 3 && b.includes(token));
};

const productivitySecondsForGoal = (rows, goal) => {
  const productivity = goal.productivity;
  const productivityId = productivity?.id ?? goal.taxon_id;

  if (productivityId === 7) {
    return rows.filter((row) => row.productivity < 0).reduce((sum, row) => sum + row.seconds, 0);
  }
  if (productivityId === 10) {
    return rows.reduce((sum, row) => sum + row.seconds, 0);
  }

  const sqlEquals = (productivity?.sql_score_equals ?? "").toLowerCase();
  if (sqlEquals.includes("< 0")) {
    return rows.filter((row) => row.productivity < 0).reduce((sum, row) => sum + row.seconds, 0);
  }
  if (sqlEquals.includes("between -2 and 2")) {
    return rows.reduce((sum, row) => sum + row.seconds, 0);
  }

  const name = (productivity?.name ?? productivity?.display_name ?? "").toLowerCase();
  if (name.includes("very productive") || name.includes("focus work")) {
    return rows.filter((row) => row.productivity === 2).reduce((sum, row) => sum + row.seconds, 0);
  }
  if (name.includes("other work") || (name.includes("productive") && !name.includes("distracting"))) {
    return rows.filter((row) => row.productivity === 1).reduce((sum, row) => sum + row.seconds, 0);
  }
  if (name.includes("neutral")) {
    return rows.filter((row) => row.productivity === 0).reduce((sum, row) => sum + row.seconds, 0);
  }
  if (name.includes("very distracting")) {
    return rows.filter((row) => row.productivity === -2).reduce((sum, row) => sum + row.seconds, 0);
  }
  if (name.includes("personal") || name.includes("distracting")) {
    return rows.filter((row) => row.productivity === -1).reduce((sum, row) => sum + row.seconds, 0);
  }

  return rows.filter((row) => row.productivity === productivityId).reduce((sum, row) => sum + row.seconds, 0);
};

const overviewNameForGoal = (goal) => (goal.overview?.name ?? goal.taxon_display_name ?? "").toLowerCase();

const resolveActualSeconds = async (client, goal, weekStart, weekEnd, caches) => {
  const taxonomy = goal.taxonomy?.search_name ?? goal.taxonomy_name ?? "";

  if (taxonomy === "projects" || goal.v2project) {
    const projectTimes =
      caches.projectTimes ?? (caches.projectTimes = await client.fetchProjectTimesByName(weekStart, weekEnd));
    const label = goal.v2project?.name ?? goal.taxon_display_name ?? "";
    for (const [name, seconds] of projectTimes.byName) {
      if (labelsMatch(name, label)) {
        return seconds;
      }
    }
    return 0;
  }

  if (taxonomy === "clients") {
    const projectTimes =
      caches.projectTimes ?? (caches.projectTimes = await client.fetchProjectTimesByName(weekStart, weekEnd));
    return projectTimes.byClientId.get(goal.taxon_id) ?? 0;
  }

  if (taxonomy === "productivity") {
    const cacheKey = "productivity";
    if (!caches[cacheKey]) {
      caches[cacheKey] = parseRankRows(await client.fetchAnalyticRank("productivity", weekStart, weekEnd), "productivity");
    }
    return productivitySecondsForGoal(caches[cacheKey], goal);
  }

  if (taxonomy === "category" || taxonomy === "overviews" || goal.overview) {
    const cacheKey = "overview";
    if (!caches[cacheKey]) {
      caches[cacheKey] = parseRankRows(await client.fetchAnalyticRank("overview", weekStart, weekEnd), "overview");
    }
    const needle = overviewNameForGoal(goal);
    const row = caches[cacheKey].find((item) => item.name === needle || item.name.includes(needle));
    return row?.seconds ?? 0;
  }

  return 0;
};

const main = async () => {
  const apiKey = process.env.RESCUETIME_API_KEY?.trim();
  if (!apiKey) {
    console.error("Missing RESCUETIME_API_KEY");
    process.exit(1);
  }

  const weekArg = process.argv.includes("--week") ? process.argv[process.argv.indexOf("--week") + 1] : null;
  const weekStart = getWeekStartSunday(weekArg ?? new Date().toISOString().slice(0, 10));
  const weekEnd = addDays(weekStart, 6);

  const client = new RescueTimeGoalsClient(apiKey);
  const goals = await client.listGoals();
  const caches = {};
  const results = [];

  for (const goal of goals) {
    const days = scheduleDaysInWeek(goal.schedule?.name ?? goal.schedule_name);
    const dailyTargetSeconds = Number(goal.amount_seconds ?? 0);
    const weeklyTargetSeconds = dailyTargetSeconds * days;
    const actualSeconds = await resolveActualSeconds(client, goal, weekStart, weekEnd, caches);
    const achievement = goal.is_more
      ? scoreMoreGoal(actualSeconds, weeklyTargetSeconds)
      : scoreLessGoal(actualSeconds, weeklyTargetSeconds);

    results.push({
      displayName: goal.display_name,
      isMore: goal.is_more,
      actualHours: actualSeconds / 3600,
      weeklyTargetHours: weeklyTargetSeconds / 3600,
      achievement,
      schedule: goal.schedule?.name ?? goal.schedule_name ?? "24x7",
      days
    });
  }

  const totalAchievement = results.reduce((sum, item) => sum + item.achievement, 0);
  const scorePercent = (totalAchievement / results.length) * 100;

  console.log(`RescueTime Goals — week ${weekStart} → ${weekEnd}\n`);
  for (const item of results) {
    console.log(
      `${item.displayName}\n` +
        `  actual: ${item.actualHours.toFixed(2)}h / weekly target: ${item.weeklyTargetHours.toFixed(2)}h (${item.days}d × daily) → ${item.achievement.toFixed(2)}/1\n`
    );
  }

  console.log(`Weekly objectives score: ${totalAchievement.toFixed(2)} / ${results.length} = ${scorePercent.toFixed(1)}%`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
