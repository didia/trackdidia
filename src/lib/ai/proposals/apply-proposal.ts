import { updateWeeklyReviewNote } from "../../../domain/weekly-review";
import { updateMonthlyReviewNote } from "../../../domain/monthly-review";
import { createEmptyDailyEntry, updateNote } from "../../../domain/daily-entry";
import type {
  AiProposal,
  DailyEntry,
  MonthlyReview,
  MonthlyReviewSectionKey,
  WeeklyReview,
  WeeklyRitualSectionKey,
} from "../../../domain/types";
import { t } from "../../../i18n";
import { getTodayDate } from "../../date";
import type { AppRepository } from "../../storage/repository";
import { buildMemoryFromProposal } from "../memory/apply-proposal";
import type { AcceptEffect } from "./accept-effect";
import { decodeProposal, isMonthlySectionKey, isWeeklySectionKey } from "./payloads";
import { buildWeeklyObjectiveFromProposal } from "./weekly-proposal-ids";

export interface ProposalApplyContext {
  acceptedDate: string;
  dailyEntry?: DailyEntry;
  weekly?: {
    withReview(
      sectionKey: WeeklyRitualSectionKey,
      work: (review: WeeklyReview) => Promise<ProposalApplyResult>,
    ): Promise<ProposalApplyResult>;
  };
  monthly?: {
    monthKey: string;
    withReview(
      sectionKey: MonthlyReviewSectionKey,
      work: (review: MonthlyReview) => Promise<ProposalApplyResult>,
    ): Promise<ProposalApplyResult>;
  };
}
export interface ProposalApplyResult {
  proposal?: AiProposal;
  accepted?: boolean;
  text?: string;
  memoryId?: string;
  proposalDecided?: boolean;
  sectionKey?: WeeklyRitualSectionKey | MonthlyReviewSectionKey;
  reviewScope?: string;
  weeklyReview?: WeeklyReview;
  monthlyReview?: MonthlyReview;
  objectiveId?: string;
  taskId?: string;
  goalId?: string;
  monthKey?: string;
  goalMissing?: boolean;
  dailyNote?: { field: "morningIntention" | "tomorrowFocus"; text: string; entry: DailyEntry };
}

/** One decoder and one atomic repository decision path for every screen. */
export const applyCoachProposal = async (
  repository: AppRepository,
  proposal: AiProposal,
  contextOrDate: ProposalApplyContext | string,
): Promise<ProposalApplyResult> => {
  const context =
    typeof contextOrDate === "string" ? { acceptedDate: contextOrDate } : contextOrDate;
  const decoded = decodeProposal(proposal);
  let effect: AcceptEffect;
  const result: ProposalApplyResult = {};
  switch (decoded.type) {
    case "invalid":
      return result;
    case "intention_draft":
    case "tomorrow_focus_draft": {
      const field = decoded.type === "intention_draft" ? "morningIntention" : "tomorrowFocus";
      const entry =
        context.dailyEntry ??
        (await repository.getDailyEntry(context.acceptedDate)) ??
        createEmptyDailyEntry(context.acceptedDate);
      const next = updateNote(entry, field, decoded.payload.text);
      effect = { kind: "dailyEntry", entry: next };
      result.text = decoded.payload.text;
      result.dailyNote = { field, text: decoded.payload.text, entry: next };
      break;
    }
    case "review_section_draft": {
      const { sectionKey, text } = decoded.payload;
      if (context.weekly && isWeeklySectionKey(sectionKey)) {
        return context.weekly.withReview(sectionKey, async (current) => {
          const review = updateWeeklyReviewNote(current, sectionKey, text);
          return acceptEffect(
            repository,
            proposal,
            { kind: "weeklyReview", review },
            { sectionKey, text, reviewScope: review.weekStartDate, weeklyReview: review },
            context,
          );
        });
      }
      if (context.monthly && isMonthlySectionKey(sectionKey)) {
        return context.monthly.withReview(sectionKey, async (current) => {
          const review = updateMonthlyReviewNote(current, sectionKey, text);
          return acceptEffect(
            repository,
            proposal,
            { kind: "monthlyReview", review },
            { sectionKey, text, reviewScope: review.monthKey, monthlyReview: review },
            context,
          );
        });
      }
      return {};
    }
    case "weekly_objective": {
      const objectives = await repository.listWeeklyObjectives();
      const objective = buildWeeklyObjectiveFromProposal(
        proposal,
        objectives.length,
        context.acceptedDate,
      );
      if (!objective) return {};
      effect = { kind: "weeklyObjective", objective };
      break;
    }
    case "gtd_action":
      effect = {
        kind: "gtdTask",
        taskId: decoded.payload.taskId,
        action: decoded.payload.action,
        scheduledDate: getTodayDate(),
      };
      break;
    case "goal_evaluation": {
      const { goalId, monthKey, score, trend, notes, blockers } = decoded.payload;
      if (context.monthly && context.monthly.monthKey !== monthKey) return {};
      effect = {
        kind: "goalEvaluation",
        goalId,
        monthKey,
        evaluation: { score, trend, notes, blockers },
      };
      result.monthKey = monthKey;
      break;
    }
    case "memory":
    case "commitment": {
      const memory = buildMemoryFromProposal(proposal, context.acceptedDate);
      if (!memory) return {};
      effect = { kind: "memory", memory };
      break;
    }
  }
  return acceptEffect(repository, proposal, effect, result, context);
};

const acceptEffect = async (
  repository: AppRepository,
  proposal: AiProposal,
  effect: AcceptEffect,
  result: ProposalApplyResult,
  context: ProposalApplyContext,
): Promise<ProposalApplyResult> => {
  const accepted = await repository.acceptAiProposal(proposal.id, effect);
  if (accepted.proposal.status !== "accepted" || !accepted.appliedEntityId) {
    if (
      effect.kind === "goalEvaluation" &&
      context.monthly &&
      accepted.proposal.status === "pending"
    ) {
      return {
        goalMissing: true,
        proposal: await repository.decideAiProposal(proposal.id, "dismissed"),
        accepted: false,
      };
    }
    return {};
  }
  switch (effect.kind) {
    case "memory":
      result.memoryId = accepted.appliedEntityId;
      break;
    case "weeklyObjective":
      result.objectiveId = accepted.appliedEntityId;
      break;
    case "gtdTask":
      result.taskId = accepted.appliedEntityId;
      break;
    case "goalEvaluation":
      result.goalId = accepted.appliedEntityId;
      break;
  }
  return { ...result, proposal: accepted.proposal, accepted: true, proposalDecided: true };
};

export const proposalPreviewText = (
  proposal: AiProposal,
  surface?: "monthly" | "weekly",
): string => {
  const decoded = decodeProposal(proposal);
  switch (decoded.type) {
    case "invalid":
      return "";
    case "intention_draft":
    case "tomorrow_focus_draft":
      return decoded.payload.text;
    case "review_section_draft":
      return `[${decoded.payload.sectionKey}] ${decoded.payload.text}`;
    case "weekly_objective":
      return decoded.payload.title;
    case "gtd_action":
      return surface === "weekly"
        ? `${decoded.payload.taskTitle ?? t("proposal.taskFallback", { ns: "coach" })} — ${decoded.payload.action} — ${decoded.payload.reason}`
        : `${decoded.payload.action} — ${decoded.payload.reason}`;
    case "goal_evaluation": {
      const payload = decoded.payload;
      const score = payload.score ?? t("emDash", { ns: "common" });
      return surface === "monthly"
        ? `[${payload.goalId}] ${score}/100 — ${payload.notes}`
        : `[${payload.goalId}] score ${score} — ${payload.notes}`;
    }
    case "commitment":
      return decoded.payload.statement;
    case "memory":
      return `[${decoded.payload.kind}] ${decoded.payload.statement}`;
  }
};
