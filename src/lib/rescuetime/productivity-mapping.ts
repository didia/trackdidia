import type { RescueTimeGoalRecord } from "../../domain/rescuetime-goals";

export interface ParsedProductivityRow {
  productivity: number;
  seconds: number;
}

const productivityScoreFromName = (name: string | undefined): number | null => {
  const normalized = (name ?? "").toLowerCase();
  if (normalized.includes("very productive") || normalized.includes("focus work")) {
    return 2;
  }
  if (
    normalized.includes("other work") ||
    (normalized.includes("productive") && !normalized.includes("distracting"))
  ) {
    return 1;
  }
  if (normalized.includes("neutral")) {
    return 0;
  }
  if (normalized.includes("very distracting")) {
    return -2;
  }
  if (normalized.includes("personal") || normalized.includes("distracting")) {
    return -1;
  }
  return null;
};

const productivityScoresFromSqlEquals = (sqlEquals: string | undefined): number[] | null => {
  const normalized = (sqlEquals ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  if (normalized.includes("< 0")) {
    return [-2, -1];
  }
  if (normalized.includes("between -2 and 2")) {
    return [2, 1, 0, -1, -2];
  }
  const exactMatch = normalized.match(/=\s*(-?\d+)/);
  if (exactMatch) {
    return [Number(exactMatch[1])];
  }
  return null;
};

export const productivitySecondsForGoal = (
  rows: ParsedProductivityRow[],
  goal: RescueTimeGoalRecord,
): number => {
  const productivity = goal.productivity;
  const productivityId = productivity?.id ?? goal.taxon_id;

  if (productivityId === 7) {
    return rows.filter((row) => row.productivity < 0).reduce((sum, row) => sum + row.seconds, 0);
  }
  if (productivityId === 10) {
    return rows.reduce((sum, row) => sum + row.seconds, 0);
  }

  const sqlScores = productivityScoresFromSqlEquals(
    (productivity as { sql_score_equals?: string } | undefined)?.sql_score_equals,
  );
  if (sqlScores) {
    return rows
      .filter((row) => sqlScores.includes(row.productivity))
      .reduce((sum, row) => sum + row.seconds, 0);
  }

  const scoreFromName = productivityScoreFromName(productivity?.name ?? productivity?.display_name);
  if (scoreFromName !== null) {
    return rows
      .filter((row) => row.productivity === scoreFromName)
      .reduce((sum, row) => sum + row.seconds, 0);
  }

  return rows
    .filter((row) => row.productivity === productivityId)
    .reduce((sum, row) => sum + row.seconds, 0);
};

export const computeProductivityPulse = (rows: ParsedProductivityRow[]): number | null => {
  let weightedSum = 0;
  let totalSeconds = 0;

  for (const row of rows) {
    if (!Number.isFinite(row.seconds) || !Number.isFinite(row.productivity)) {
      continue;
    }

    weightedSum += row.productivity * row.seconds;
    totalSeconds += row.seconds;
  }

  if (totalSeconds <= 0) {
    return null;
  }

  const mean = weightedSum / totalSeconds;
  const pulse = ((mean + 2) / 4) * 100;
  return Math.min(100, Math.max(0, pulse));
};
