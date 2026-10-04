import { useCallback, useEffect, useState } from "react";
import type { AiProposal, WeeklyReview } from "../../domain/types";
import {
  createWeeklyMemoryProposals,
  loadWeeklyMemoryProposals,
} from "../../lib/ai/memory/weekly-distillation";
import { applyCoachProposal } from "../../lib/ai/proposals/apply-proposal";
import { useAppContext } from "../app-context";

/**
 * Memory-distillation proposals offered once a weekly review is closed. They are loaded for a
 * closed review, cleared for a draft one, and created on demand when the review is being closed.
 */
export const useWeeklyMemoryProposals = (review: WeeklyReview | null) => {
  const { repository } = useAppContext();
  const [proposals, setProposals] = useState<AiProposal[]>([]);
  const status = review?.status;
  const weekStartDate = review?.weekStartDate;

  useEffect(() => {
    if (status !== "closed" || !weekStartDate) {
      setProposals([]);
      return;
    }
    let cancelled = false;
    void loadWeeklyMemoryProposals(repository, weekStartDate).then((loaded) => {
      if (!cancelled) setProposals(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [repository, status, weekStartDate]);

  /** Distills the recent history into proposals for the review that is about to close. */
  const distillForClose = useCallback(
    async (closedReview: WeeklyReview) => {
      const historyEntries = await repository.listDailyEntries(120);
      setProposals(
        await createWeeklyMemoryProposals(repository, closedReview.weekStartDate, historyEntries),
      );
    },
    [repository],
  );

  const accept = useCallback(
    async (proposal: AiProposal, acceptedWeekStartDate: string) => {
      await applyCoachProposal(repository, proposal, acceptedWeekStartDate);
      setProposals((current) => current.filter((item) => item.id !== proposal.id));
    },
    [repository],
  );

  const dismiss = useCallback(
    async (proposal: AiProposal) => {
      await repository.decideAiProposal(proposal.id, "dismissed");
      setProposals((current) => current.filter((item) => item.id !== proposal.id));
    },
    [repository],
  );

  return { proposals, distillForClose, accept, dismiss };
};
