import { decodeProposal, isWeeklySectionKey } from "./payloads";
import type { AiProposal, WeeklyObjective, WeeklyRitualSectionKey } from "../../../domain/types";
import { createEmptyWeeklyObjective } from "../../../domain/weekly-objectives";
import { buildWeekDates } from "../../../domain/weekly-review";
import { addDays } from "../../date";

export const weeklyObjectiveIdFromProposal = (proposalId: string): string =>
  proposalId.replace(/^ai-proposal:/, "weekly-objective:");

export const buildWeeklyObjectiveFromProposal = (
  proposal: AiProposal,
  sortOrder: number,
  reviewedWeekStartDate: string,
): WeeklyObjective | null => {
  const decoded = decodeProposal(proposal);
  if (decoded.type !== "weekly_objective") return null;
  const payload = decoded.payload;

  return createEmptyWeeklyObjective({
    id: weeklyObjectiveIdFromProposal(proposal.id),
    title: payload.title.trim(),
    kind: payload.kind ?? "manual",
    targetHours: payload.targetHours ?? null,
    rescuetimeKind: payload.rescuetimeKind ?? null,
    rescuetimeThing: payload.rescuetimeThing ?? null,
    sortOrder,
    startsOnWeekStartDate: addDays(buildWeekDates(reviewedWeekStartDate), 7),
  });
};

export const reviewSectionFromProposal = (
  proposal: AiProposal,
): { sectionKey: WeeklyRitualSectionKey; text: string } | null => {
  const decoded = decodeProposal(proposal);
  if (decoded.type !== "review_section_draft" || !isWeeklySectionKey(decoded.payload.sectionKey))
    return null;
  return { sectionKey: decoded.payload.sectionKey, text: decoded.payload.text };
};
