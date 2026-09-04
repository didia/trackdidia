import { updateAnnualGoalEvaluation } from "../../../domain/annual-goals";
import type {
  AiProposal,
  AnnualGoalTrend,
  MonthlyReviewSectionKey,
  RescueTimeTaxonomy,
  Task,
  WeeklyRitualSectionKey,
} from "../../../domain/types";
import { createEmptyWeeklyObjective } from "../../../domain/weekly-objectives";
import { t } from "../../../i18n";
import { getTodayDate } from "../../date";
import type { AppRepository } from "../../storage/repository";
import { applyAcceptedProposal } from "../memory/apply-proposal";

export interface ProposalApplyResult {
  text?: string;
  memoryId?: string;
  proposalDecided?: boolean;
  sectionKey?: WeeklyRitualSectionKey | MonthlyReviewSectionKey;
  objectiveId?: string;
  taskId?: string;
  goalId?: string;
  monthKey?: string;
}

export const applyCoachProposal = async (
  repository: AppRepository,
  proposal: AiProposal,
  acceptedDate: string,
): Promise<ProposalApplyResult> => {
  if (proposal.type === "intention_draft" || proposal.type === "tomorrow_focus_draft") {
    const payload = JSON.parse(proposal.payloadJson) as { text?: string };
    return { text: payload.text ?? "" };
  }

  if (proposal.type === "review_section_draft") {
    const payload = JSON.parse(proposal.payloadJson) as {
      sectionKey?: WeeklyRitualSectionKey | MonthlyReviewSectionKey;
      text?: string;
    };
    return {
      sectionKey: payload.sectionKey,
      text: payload.text ?? "",
    };
  }

  if (proposal.type === "weekly_objective") {
    const payload = JSON.parse(proposal.payloadJson) as {
      title?: string;
      kind?: "time" | "manual";
      targetHours?: number | null;
      rescuetimeKind?: RescueTimeTaxonomy | null;
      rescuetimeThing?: string | null;
    };
    const objectives = await repository.listWeeklyObjectives();
    const saved = await repository.saveWeeklyObjective(
      createEmptyWeeklyObjective({
        title: payload.title ?? t("proposal.defaultObjectiveTitle", { ns: "coach" }),
        kind: payload.kind ?? "manual",
        targetHours: payload.targetHours ?? null,
        rescuetimeKind: payload.rescuetimeKind ?? null,
        rescuetimeThing: payload.rescuetimeThing ?? null,
        sortOrder: objectives.length,
      }),
    );
    return { objectiveId: saved.id };
  }

  if (proposal.type === "gtd_action") {
    const payload = JSON.parse(proposal.payloadJson) as {
      taskId?: string;
      action?: "schedule" | "defer" | "delegate" | "drop";
      reason?: string;
    };

    if (!payload.taskId || !payload.action) {
      return {};
    }

    let task: Task | undefined;
    try {
      const tasks = await repository.listTasks({ includeCompleted: true });
      task = tasks.find((item) => item.id === payload.taskId);
    } catch {
      return {};
    }

    if (!task || task.status !== "active") {
      return {};
    }

    if (payload.action === "schedule") {
      await repository.scheduleTask(payload.taskId, getTodayDate());
    } else if (payload.action === "defer") {
      await repository.moveTask(payload.taskId, "someday_maybe", task.contextIds, task.projectId);
    } else if (payload.action === "delegate") {
      await repository.moveTask(payload.taskId, "waiting_for", task.contextIds, task.projectId);
    } else if (payload.action === "drop") {
      await repository.cancelTask(payload.taskId);
    }

    return { taskId: payload.taskId };
  }

  if (proposal.type === "goal_evaluation") {
    const payload = JSON.parse(proposal.payloadJson) as {
      goalId?: string;
      monthKey?: string;
      score?: number | null;
      trend?: AnnualGoalTrend | null;
      notes?: string;
      blockers?: string;
    };

    if (!payload.goalId || !payload.monthKey) {
      return {};
    }

    const goals = await repository.listAnnualGoals();
    const goal = goals.find((item) => item.id === payload.goalId);
    if (!goal) {
      return {};
    }

    const saved = await repository.saveAnnualGoal(
      updateAnnualGoalEvaluation(goal, payload.monthKey, {
        score: payload.score ?? null,
        trend: payload.trend ?? null,
        notes: payload.notes ?? "",
        blockers: payload.blockers ?? "",
      }),
    );

    return { goalId: saved.id, monthKey: payload.monthKey };
  }

  if (proposal.type === "memory" || proposal.type === "commitment") {
    const memory = await applyAcceptedProposal(repository, proposal, acceptedDate);
    return { memoryId: memory?.id, proposalDecided: true };
  }

  return {};
};

export const proposalPreviewText = (proposal: AiProposal): string => {
  const payload = JSON.parse(proposal.payloadJson) as {
    text?: string;
    statement?: string;
    kind?: string;
    title?: string;
    sectionKey?: string;
    action?: string;
    reason?: string;
  };

  if (proposal.type === "intention_draft" || proposal.type === "tomorrow_focus_draft") {
    return payload.text ?? "";
  }

  if (proposal.type === "review_section_draft") {
    return `[${payload.sectionKey ?? t("proposal.sectionFallback", { ns: "coach" })}] ${payload.text ?? ""}`;
  }

  if (proposal.type === "weekly_objective") {
    return payload.title ?? t("proposal.weeklyObjectivePreview", { ns: "coach" });
  }

  if (proposal.type === "gtd_action") {
    return `${payload.action ?? t("proposal.actionFallback", { ns: "coach" })} — ${payload.reason ?? ""}`;
  }

  if (proposal.type === "goal_evaluation") {
    const evaluationPayload = JSON.parse(proposal.payloadJson) as {
      goalId?: string;
      score?: number | null;
      notes?: string;
    };
    return `[${evaluationPayload.goalId ?? t("proposal.goalFallback", { ns: "coach" })}] score ${evaluationPayload.score ?? t("emDash", { ns: "common" })} — ${evaluationPayload.notes ?? ""}`;
  }

  if (proposal.type === "commitment") {
    return payload.statement ?? "";
  }

  if (proposal.type === "memory") {
    return `[${payload.kind ?? t("proposal.memoryKindFallback", { ns: "coach" })}] ${payload.statement ?? ""}`;
  }

  return "";
};
