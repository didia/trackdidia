import type { Finding } from "../../../domain/insights/types";
import type { WeeklyRitualSectionKey, WeeklySynthesisResponse } from "../../../domain/types";
import { formatPercent } from "../../format";
import { pickTopFinding } from "./coach-pulse-fallback";
import type { WeeklySnapshot, WeeklySnapshotAxis } from "../context/weekly-snapshot";

const sortAxesByScore = (axes: WeeklySnapshotAxis[]): WeeklySnapshotAxis[] =>
  [...axes].sort((left, right) => right.score - left.score);

const sectionForFinding = (finding: Finding): WeeklyRitualSectionKey | null => {
  const kind = "kind" in finding ? String(finding.kind) : "";

  if (kind.startsWith("inbox_") || kind.startsWith("projects_") || kind.startsWith("stale_")) {
    return "gtd";
  }

  if (kind.startsWith("aging_") || kind === "overdue_deadlines" || kind === "scheduled_vs_completed_ratio") {
    return "gtd";
  }

  if (kind.startsWith("focus_") || kind === "task_concentration") {
    return "tempsEtPlan";
  }

  if ("principleKey" in finding) {
    return "bilan";
  }

  if (kind.startsWith("metric_") || kind.startsWith("weekly_score")) {
    return "tempsEtPlan";
  }

  if (kind.startsWith("correlation_") || kind.startsWith("anomaly_")) {
    return "bilan";
  }

  return "bilan";
};

const buildSectionDrafts = (findings: Finding[], axes: WeeklySnapshotAxis[]): Partial<Record<WeeklyRitualSectionKey, string>> => {
  const drafts: Partial<Record<WeeklyRitualSectionKey, string>> = {};
  const topFinding = pickTopFinding(findings);
  const weakest = sortAxesByScore(axes).slice(-2);

  if (topFinding) {
    const section = sectionForFinding(topFinding);
    if (section) {
      drafts[section] = topFinding.label;
    }
  }

  if (weakest.length >= 2) {
    drafts.tempsEtPlan = `Axes a surveiller: ${weakest.map((axis) => axis.label).join(" et ")}.`;
  }

  drafts.dimanche = "Cloturer la semaine passee et poser le ton pour celle qui arrive.";

  return drafts;
};

const buildGtdActions = (
  snapshot: WeeklySnapshot
): WeeklySynthesisResponse["gtdActions"] => {
  const staleFinding = snapshot.findings.find(
    (finding) => "kind" in finding && finding.kind === "stale_next_actions"
  ) as (Finding & { taskIds?: string[] }) | undefined;
  const taskId = staleFinding?.taskIds?.[0];

  if (taskId) {
    return [
      {
        taskId,
        action: "defer",
        reason: "Next action stale — clarifier, planifier ou deleguer."
      }
    ];
  }

  return [];
};

export const buildLocalWeeklySynthesis = (snapshot: WeeklySnapshot): WeeklySynthesisResponse => {
  const rankedAxes = sortAxesByScore(snapshot.axes);
  const strongest = rankedAxes[0]?.label ?? "Discipline";
  const weakest = rankedAxes.slice(-2).map((axis) => axis.label);
  const paddedWeakest =
    weakest.length === 2
      ? weakest
      : weakest.length === 1
        ? [weakest[0], "Completion taches"]
        : ["Temps d'ecran", "Pomodoris"];

  const topFinding = pickTopFinding(snapshot.findings as Finding[]);
  const scorePercent = formatPercent(snapshot.weeklyScore);

  return {
    headline: topFinding ? "Lecture de la semaine" : "Semaine a refermer",
    scoreExplanation: topFinding
      ? `Score hebdo ${scorePercent}. ${topFinding.label}`
      : `Score hebdo ${scorePercent}. Les signaux restent partiels — note ce qui a tenu malgre tout.`,
    strongestAxis: strongest,
    weakestAxes: paddedWeakest,
    sectionDrafts: buildSectionDrafts(snapshot.findings as Finding[], snapshot.axes),
    nextWeekObjectives: [],
    gtdActions: buildGtdActions(snapshot)
  };
};
