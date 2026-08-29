import type { AiProposal } from "../../../domain/types";
import type { AppRepository } from "../../storage/repository";
import { applyAcceptedProposal } from "../memory/apply-proposal";

export interface ProposalApplyResult {
  text?: string;
  memoryId?: string;
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

  if (proposal.type === "memory" || proposal.type === "commitment") {
    const memory = await applyAcceptedProposal(repository, proposal, acceptedDate);
    return { memoryId: memory?.id };
  }

  return {};
};

export const proposalPreviewText = (proposal: AiProposal): string => {
  const payload = JSON.parse(proposal.payloadJson) as {
    text?: string;
    statement?: string;
    kind?: string;
  };

  if (proposal.type === "intention_draft" || proposal.type === "tomorrow_focus_draft") {
    return payload.text ?? "";
  }

  if (proposal.type === "commitment") {
    return payload.statement ?? "";
  }

  if (proposal.type === "memory") {
    return `[${payload.kind ?? "memoire"}] ${payload.statement ?? ""}`;
  }

  return "";
};
