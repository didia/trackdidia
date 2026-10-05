import { type Dispatch, type SetStateAction, useCallback, useRef, useState } from "react";
import type { AiProposal } from "../domain/types";
import { logDebug } from "../lib/debug";
import { useAppContext } from "./app-context";

/** What a surface's `onAccept` reports back; no `proposal` means nothing was decided. */
export interface ApplyOutcome {
  proposal?: AiProposal;
}

export interface ProposalDecisionResult {
  proposals: AiProposal[];
}

export interface ProposalDecisions {
  accept: (proposal: AiProposal) => Promise<void>;
  dismiss: (proposal: AiProposal) => Promise<void>;
  isApplying: (id: string) => boolean;
}

interface ProposalDecisionHandlers {
  /** Surface-specific side effects; resolve with the decided proposal row when it was applied. */
  onAccept: (proposal: AiProposal) => Promise<ApplyOutcome>;
}

/** Status reducer: swap a proposal for its decided row. */
export const replaceProposal = <T extends ProposalDecisionResult>(
  result: T,
  decided: AiProposal,
): T => ({
  ...result,
  proposals: result.proposals.map((item) => (item.id === decided.id ? decided : item)),
});

/** Status reducer: mark a proposal dismissed locally after the repository accepted the decision. */
export const dismissProposal = <T extends ProposalDecisionResult>(
  result: T,
  id: string,
  decidedAt: string,
): T => ({
  ...result,
  proposals: result.proposals.map((item) =>
    item.id === id ? { ...item, status: "dismissed", decidedAt } : item,
  ),
});

/**
 * Shared accept/dismiss orchestration for AI suggestions. The in-flight set is a ref so a second
 * click is rejected synchronously, before React paints the disabled buttons.
 */
export const useProposalDecisions = <T extends ProposalDecisionResult>(
  result: T | null,
  setResult: Dispatch<SetStateAction<T | null>>,
  { onAccept }: ProposalDecisionHandlers,
): ProposalDecisions => {
  const { repository } = useAppContext();
  const inFlight = useRef(new Set<string>());
  const [, setApplyingIds] = useState<string[]>([]);
  const resultRef = useRef(result);
  resultRef.current = result;
  const onAcceptRef = useRef(onAccept);
  onAcceptRef.current = onAccept;

  const isApplying = useCallback((id: string) => inFlight.current.has(id), []);

  const begin = (id: string): boolean => {
    if (inFlight.current.has(id)) return false;
    inFlight.current.add(id);
    setApplyingIds([...inFlight.current]);
    return true;
  };
  const end = (id: string) => {
    inFlight.current.delete(id);
    setApplyingIds([...inFlight.current]);
  };

  // A decision is only valid for a proposal still shown by the current result.
  const isCurrent = (proposal: AiProposal) =>
    resultRef.current?.proposals.some((item) => item.id === proposal.id) === true;

  const accept = async (proposal: AiProposal): Promise<void> => {
    if (!isCurrent(proposal) || !begin(proposal.id)) return;
    try {
      const outcome = await onAcceptRef.current(proposal);
      const decided = outcome.proposal;
      if (!decided) {
        logDebug("info", "ai.proposals", "Proposal accept produced no decision", {
          id: proposal.id,
        });
        return;
      }
      setResult((current) => (current ? replaceProposal(current, decided) : current));
      logDebug("info", "ai.proposals", "Proposal accepted", { id: proposal.id });
    } catch (error) {
      logDebug("error", "ai.proposals", "Failed to accept proposal", error);
    } finally {
      end(proposal.id);
    }
  };

  const dismiss = async (proposal: AiProposal): Promise<void> => {
    if (!isCurrent(proposal) || !begin(proposal.id)) return;
    try {
      const decided = await repository.decideAiProposal(proposal.id, "dismissed");
      const decidedAt = decided?.decidedAt ?? new Date().toISOString();
      setResult((current) =>
        current ? dismissProposal(current, proposal.id, decidedAt) : current,
      );
      logDebug("info", "ai.proposals", "Proposal dismissed", { id: proposal.id });
    } catch (error) {
      logDebug("error", "ai.proposals", "Failed to dismiss proposal", error);
    } finally {
      end(proposal.id);
    }
  };

  return { accept, dismiss, isApplying };
};
