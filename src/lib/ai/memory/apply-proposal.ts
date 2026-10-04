import { decodeProposal, type MemoryProposalPayload } from "../proposals/payloads";
import { applyCoachProposal } from "../proposals/apply-proposal";
import type { AiMemory, AiProposal, PrincipleKey } from "../../../domain/types";
import { createEntityId, nowIso } from "../../gtd/shared";
import type { AppRepository } from "../../storage/repository";
import { stringifyCommitmentDetail, stringifyPatternDetail } from "./detail";
import { commitmentExpiresAt } from "./lifecycle";

export type { MemoryProposalPayload, CommitmentProposalPayload } from "../proposals/payloads";

export const memoryIdFromProposal = (proposalId: string): string =>
  proposalId.replace(/^ai-proposal:/, "ai-memory:");

export const createMemoryFromProposal = (
  payload: MemoryProposalPayload,
  acceptedDate: string,
  memoryId?: string,
): AiMemory => {
  const timestamp = nowIso();
  return {
    id: memoryId ?? createEntityId("ai-memory"),
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
      (payload.kind === "commitment"
        ? commitmentExpiresAt(acceptedDate)
        : payload.kind === "context"
          ? null
          : null),
    pinned: payload.pinned ?? false,
  };
};

export const buildMemoryFromProposal = (
  proposal: AiProposal,
  acceptedDate: string,
): AiMemory | null => {
  const memoryId = memoryIdFromProposal(proposal.id);

  const decoded = decodeProposal(proposal);
  if (decoded.type === "memory") {
    const payload = decoded.payload;
    return createMemoryFromProposal(payload, acceptedDate, memoryId);
  }

  if (decoded.type === "commitment") {
    const payload = decoded.payload;
    return createMemoryFromProposal(
      {
        kind: "commitment",
        statement: payload.statement,
        confidence: 1,
        detail: stringifyCommitmentDetail({
          metricKey: payload.metricKey ?? null,
          target: payload.target ?? null,
        }),
        source: "ai_extracted",
      },
      acceptedDate,
      memoryId,
    );
  }

  return null;
};

export const applyAcceptedProposal = async (
  repository: AppRepository,
  proposal: AiProposal,
  acceptedDate: string,
): Promise<AiMemory | null> => {
  const applied = await applyCoachProposal(repository, proposal, acceptedDate);
  if (!applied.memoryId) return null;
  const stored = (await repository.listAiMemories()).find((item) => item.id === applied.memoryId);
  if (!stored) throw new Error(`AI memory not found: ${applied.memoryId}`);
  return stored;
};

export const buildPatternMemoryPayload = (
  statement: string,
  confidence: number,
  principleKey: PrincipleKey,
  diff: number,
  evidenceFrom: string,
  evidenceTo: string,
): MemoryProposalPayload => ({
  kind: "pattern",
  statement,
  confidence,
  detail: stringifyPatternDetail({ principleKey, diff }),
  evidenceFrom,
  evidenceTo,
  source: "derived",
});
