import type { AiMemory, AiProposal, MemoryKind, MetricKey, PrincipleKey } from "../../../domain/types";
import { createEntityId, nowIso } from "../../gtd/shared";
import type { AppRepository } from "../../storage/repository";
import { commitmentExpiresAt } from "./lifecycle";
import { stringifyCommitmentDetail, stringifyPatternDetail } from "./detail";

export interface MemoryProposalPayload {
  kind: MemoryKind;
  statement: string;
  confidence: number;
  detail?: string;
  evidenceFrom?: string | null;
  evidenceTo?: string | null;
  expiresAt?: string | null;
  source?: AiMemory["source"];
  pinned?: boolean;
}

export interface CommitmentProposalPayload {
  statement: string;
  metricKey?: MetricKey | null;
  target?: number | null;
}

export const createMemoryFromProposal = (
  payload: MemoryProposalPayload,
  acceptedDate: string
): AiMemory => {
  const timestamp = nowIso();
  return {
    id: createEntityId("ai-memory"),
    kind: payload.kind,
    statement: payload.statement.trim(),
    detail: payload.detail ?? "",
    confidence: payload.confidence,
    source: payload.source ?? "ai_extracted",
    status: "active",
    evidenceFrom: payload.evidenceFrom ?? null,
    evidenceTo: payload.evidenceTo ?? null,
    createdAt: timestamp,
    lastConfirmedAt: timestamp,
    expiresAt:
      payload.expiresAt ??
      (payload.kind === "commitment" ? commitmentExpiresAt(acceptedDate) : payload.kind === "context" ? null : null),
    pinned: payload.pinned ?? false
  };
};

export const applyAcceptedProposal = async (
  repository: AppRepository,
  proposal: AiProposal,
  acceptedDate: string
): Promise<AiMemory | null> => {
  if (proposal.type === "memory") {
    const payload = JSON.parse(proposal.payloadJson) as MemoryProposalPayload;
    const memory = createMemoryFromProposal(payload, acceptedDate);
    return repository.saveAiMemory(memory);
  }

  if (proposal.type === "commitment") {
    const payload = JSON.parse(proposal.payloadJson) as CommitmentProposalPayload;
    const memory = createMemoryFromProposal(
      {
        kind: "commitment",
        statement: payload.statement,
        confidence: 1,
        detail: stringifyCommitmentDetail({
          metricKey: payload.metricKey ?? null,
          target: payload.target ?? null
        }),
        source: "ai_extracted"
      },
      acceptedDate
    );
    return repository.saveAiMemory(memory);
  }

  return null;
};

export const buildPatternMemoryPayload = (
  statement: string,
  confidence: number,
  principleKey: PrincipleKey,
  diff: number,
  evidenceFrom: string,
  evidenceTo: string
): MemoryProposalPayload => ({
  kind: "pattern",
  statement,
  confidence,
  detail: stringifyPatternDetail({ principleKey, diff }),
  evidenceFrom,
  evidenceTo,
  source: "derived"
});
