import { createEmptyWeeklyObjective } from "../../../domain/weekly-objectives";
import type { AiProposal, RescueTimeTaxonomy, Task, WeeklyRitualSectionKey } from "../../../domain/types";
import { getTodayDate } from "../../date";
import type { AppRepository } from "../../storage/repository";
import { applyAcceptedProposal } from "../memory/apply-proposal";

export interface ProposalApplyResult {
  text?: string;
  memoryId?: string;
  proposalDecided?: boolean;
  sectionKey?: WeeklyRitualSectionKey;
  objectiveId?: string;
  taskId?: string;
}

export const applyCoachProposal = async (
  repository: AppRepository,
  proposal: AiProposal,
  acceptedDate: string
): Promise<ProposalApplyResult> => {
  if (proposal.type === "intention_draft" || proposal.type === "tomorrow_focus_draft") {
    const payload = JSON.parse(proposal.payloadJson) as { text?: string };
    return { text: payload.text ?? "" };
  }

  if (proposal.type === "review_section_draft") {
    const payload = JSON.parse(proposal.payloadJson) as { sectionKey?: WeeklyRitualSectionKey; text?: string };
    return {
      sectionKey: payload.sectionKey,
      text: payload.text ?? ""
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
        title: payload.title ?? "Objectif",
        kind: payload.kind ?? "manual",
        targetHours: payload.targetHours ?? null,
        rescuetimeKind: payload.rescuetimeKind ?? null,
        rescuetimeThing: payload.rescuetimeThing ?? null,
        sortOrder: objectives.length
      })
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
    return `[${payload.sectionKey ?? "section"}] ${payload.text ?? ""}`;
  }

  if (proposal.type === "weekly_objective") {
    return payload.title ?? "Objectif hebdomadaire";
  }

  if (proposal.type === "gtd_action") {
    return `${payload.action ?? "action"} — ${payload.reason ?? ""}`;
  }

  if (proposal.type === "commitment") {
    return payload.statement ?? "";
  }

  if (proposal.type === "memory") {
    return `[${payload.kind ?? "memoire"}] ${payload.statement ?? ""}`;
  }

  return "";
};
