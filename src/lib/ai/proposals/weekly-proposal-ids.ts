import type { AiProposal, WeeklyObjective, WeeklyRitualSectionKey } from "../../../domain/types";
import { createEmptyWeeklyObjective } from "../../../domain/weekly-objectives";

export const weeklyObjectiveIdFromProposal = (proposalId: string): string =>
  proposalId.replace(/^ai-proposal:/, "weekly-objective:");

export const buildWeeklyObjectiveFromProposal = (
  proposal: AiProposal,
  sortOrder: number,
): WeeklyObjective | null => {
  if (proposal.type !== "weekly_objective") {
    return null;
  }

  const payload = JSON.parse(proposal.payloadJson) as {
    title?: string;
    kind?: "time" | "manual";
    targetHours?: number | null;
    rescuetimeKind?: WeeklyObjective["rescuetimeKind"];
    rescuetimeThing?: string | null;
  };

  if (!payload.title?.trim()) {
    return null;
  }

  return createEmptyWeeklyObjective({
    id: weeklyObjectiveIdFromProposal(proposal.id),
    title: payload.title.trim(),
    kind: payload.kind ?? "manual",
    targetHours: payload.targetHours ?? null,
    rescuetimeKind: payload.rescuetimeKind ?? null,
    rescuetimeThing: payload.rescuetimeThing ?? null,
    sortOrder,
  });
};

export const reviewSectionFromProposal = (
  proposal: AiProposal,
): { sectionKey: WeeklyRitualSectionKey; text: string } | null => {
  if (proposal.type !== "review_section_draft") {
    return null;
  }

  const payload = JSON.parse(proposal.payloadJson) as {
    sectionKey?: WeeklyRitualSectionKey;
    text?: string;
  };

  if (!payload.sectionKey || !payload.text?.trim()) {
    return null;
  }

  return { sectionKey: payload.sectionKey, text: payload.text.trim() };
};
