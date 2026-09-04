#!/usr/bin/env node
/**
 * RescueTime proof-of-concept: fetch weekly category time and score objectives.
 *
 * Usage:
 *   node scripts/rescuetime-poc.mjs --week 2026-08-03
 *   node scripts/rescuetime-poc.mjs --week 2026-08-03 --list category
 *   node scripts/rescuetime-poc.mjs --week 2026-08-03 --objective "Software Development:2"
 *
 * Reads RESCUETIME_API_KEY from environment or repo-root .env (never printed).
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
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const eq = trimmed.indexOf("=");
      if (eq <= 0) {
        continue;
      }
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env optional when key is already in environment
  }
};

loadEnvFile();

const parseArgs = () => {
  const args = process.argv.slice(2);
  const options = {
    week: null,
    listKind: null,
    objectives: [],
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--week" && args[index + 1]) {
      options.week = args[++index];
    } else if (arg === "--list" && args[index + 1]) {
      options.listKind = args[++index];
    } else if (arg === "--objective" && args[index + 1]) {
      options.objectives.push(args[++index]);
    }
  }

  return options;
};

const getWeekStartSunday = (dateText) => {
  const date = new Date(`${dateText}T12:00:00`);
  const day = date.getDay();
  date.setDate(date.getDate() - day);
  return date.toISOString().slice(0, 10);
};

const addDays = (dateText, days) => {
  const date = new Date(`${dateText}T12:00:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
};

const findSecondsColumnIndex = (rowHeaders) => {
  const normalized = rowHeaders.map((header) => String(header).toLowerCase());
  const candidates = ["time spent (seconds)", "time spent", "seconds", "time_spent_seconds"];
  for (const candidate of candidates) {
    const index = normalized.findIndex(
      (header) => header.includes(candidate.replace(/_/g, " ")) || header === candidate,
    );
    if (index >= 0) {
      return index;
    }
  }
  return normalized.findIndex((header) => header.includes("second"));
};

const findNameColumnIndex = (rowHeaders) => {
  const normalized = rowHeaders.map((header) => String(header).toLowerCase());
  const categoryIndex = normalized.indexOf("category");
  if (categoryIndex >= 0) {
    return categoryIndex;
  }
  const activityIndex = normalized.findIndex((header) => header.includes("activity"));
  if (activityIndex >= 0) {
    return activityIndex;
  }
  return normalized.length > 1 ? normalized.length - 1 : 1;
};

const fetchAnalyticData = async (apiKey, { kind, begin, end }) => {
  const url = new URL("https://www.rescuetime.com/anapi/data");
  url.searchParams.set("format", "json");
  url.searchParams.set("perspective", "rank");
  url.searchParams.set("restrict_kind", kind);
  url.searchParams.set("restrict_begin", begin);
  url.searchParams.set("restrict_end", end);

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`RescueTime API ${response.status}: ${body.slice(0, 200)}`);
  }

  return response.json();
};

const parseRankRows = (payload) => {
  const headers = payload.row_headers ?? [];
  const secondsIndex = findSecondsColumnIndex(headers);
  const nameIndex = findNameColumnIndex(headers);

  if (secondsIndex < 0) {
    throw new Error(`Could not locate seconds column in headers: ${headers.join(", ")}`);
  }

  const rows = (payload.rows ?? []).map((row) => {
    const name = String(row[nameIndex] ?? row[1] ?? "unknown");
    const seconds = Number(row[secondsIndex] ?? 0);
    return {
      name,
      seconds,
      hours: seconds / 3600,
    };
  });

  return rows.sort((left, right) => right.seconds - left.seconds);
};

const parseObjectiveSpec = (spec) => {
  const lastColon = spec.lastIndexOf(":");
  if (lastColon <= 0) {
    throw new Error(`Invalid --objective "${spec}". Expected "Category Name:targetHours".`);
  }
  const name = spec.slice(0, lastColon).trim();
  const targetHours = Number(spec.slice(lastColon + 1));
  if (!name || !Number.isFinite(targetHours) || targetHours <= 0) {
    throw new Error(`Invalid --objective "${spec}".`);
  }
  return { name, targetHours };
};

const scoreObjective = (actualHours, targetHours) => Math.min(actualHours / targetHours, 1);

const formatHours = (hours) => `${hours.toFixed(2)}h`;

const main = async () => {
  const apiKey = process.env.RESCUETIME_API_KEY?.trim();
  if (!apiKey) {
    console.error("Missing RESCUETIME_API_KEY in environment or .env");
    process.exit(1);
  }

  const options = parseArgs();
  const weekStart = options.week
    ? getWeekStartSunday(options.week)
    : getWeekStartSunday(new Date().toISOString().slice(0, 10));
  const weekEnd = addDays(weekStart, 6);
  const listKind = options.listKind ?? "category";

  console.log(`Week: ${weekStart} → ${weekEnd}`);

  const payload = await fetchAnalyticData(apiKey, {
    kind: listKind,
    begin: weekStart,
    end: weekEnd,
  });

  const rows = parseRankRows(payload);
  const byName = new Map(rows.map((row) => [row.name, row]));

  if (options.objectives.length === 0) {
    console.log(`\nTop ${listKind} time (hours):`);
    for (const row of rows.slice(0, 25)) {
      console.log(`  ${row.name}: ${formatHours(row.hours)}`);
    }
    console.log('\nPass --objective "Category:targetHours" to score time objectives.');
    return;
  }

  const results = options.objectives.map((spec) => {
    const objective = parseObjectiveSpec(spec);
    const row = byName.get(objective.name);
    const actualHours = row?.hours ?? 0;
    const achievement = scoreObjective(actualHours, objective.targetHours);
    return {
      ...objective,
      actualHours,
      achievement,
    };
  });

  const totalAchievement = results.reduce((sum, item) => sum + item.achievement, 0);
  const scorePercent = (totalAchievement / results.length) * 100;

  console.log("\nTime objective scores:");
  for (const item of results) {
    const found = byName.has(item.name) ? "" : " (not found in RescueTime data)";
    console.log(
      `  ${item.name}: ${formatHours(item.actualHours)} / ${formatHours(item.targetHours)} → ${item.achievement.toFixed(2)}/1${found}`,
    );
  }

  console.log(
    `\nWeekly time objectives score: ${totalAchievement.toFixed(2)} / ${results.length} = ${scorePercent.toFixed(1)}%`,
  );
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
