import type { Finding } from "../../../domain/insights/types";
import type { WeeklyRitualSectionKey, WeeklySynthesisResponse } from "../../../domain/types";
import { t } from "../../../i18n";
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
    drafts.tempsEtPlan = t("weekly.sectionAxesWatch", {
      ns: "coach",
      axes: weakest.map((axis) => axis.label).join(" et ")
    });
  }

  drafts.dimanche = t("weekly.sectionSunday", { ns: "coach" });

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
        reason: t("weekly.staleDeferReason", { ns: "coach" })
      }
    ];
  }

  return [];
};

export const buildLocalWeeklySynthesis = (snapshot: WeeklySnapshot): WeeklySynthesisResponse => {
  const rankedAxes = sortAxesByScore(snapshot.axes);
  const strongest = rankedAxes[0]?.label ?? t("weekly.axisDiscipline", { ns: "coach" });
  const weakest = rankedAxes.slice(-2).map((axis) => axis.label);
  const paddedWeakest =
    weakest.length === 2
      ? weakest
      : weakest.length === 1
        ? [weakest[0], t("weekly.axisTasksCompletion", { ns: "coach" })]
        : [t("weekly.axisScreenTime", { ns: "coach" }), t("weekly.axisPomodoris", { ns: "coach" })];

  const topFinding = pickTopFinding(snapshot.findings as Finding[]);
  const scorePercent = formatPercent(snapshot.weeklyScore);

  return {
    headline: topFinding ? t("weekly.headlineWithFinding", { ns: "coach" }) : t("weekly.headline", { ns: "coach" }),
    scoreExplanation: topFinding
      ? t("weekly.scoreWithFinding", { ns: "coach", score: scorePercent, label: topFinding.label })
      : t("weekly.scorePartial", { ns: "coach", score: scorePercent }),
    strongestAxis: strongest,
    weakestAxes: paddedWeakest,
    sectionDrafts: buildSectionDrafts(snapshot.findings as Finding[], snapshot.axes),
    nextWeekObjectives: [],
    gtdActions: buildGtdActions(snapshot)
  };
};
