import { computeCorrelationFindings } from "../../../domain/insights/correlations";
import type { AiMessage, AiProposal, DailyEntry } from "../../../domain/types";
import { createEntityId, nowIso } from "../../gtd/shared";
import type { AppRepository } from "../../storage/repository";
import { COACH_PULSE_PROMPT_VERSION } from "../coach-pulse-service";
import { buildPatternMemoryPayload } from "./apply-proposal";

const MAX_WEEKLY_CANDIDATES = 3;

export const buildWeeklyDistillScopeKey = (weekStartDate: string): string =>
  `${weekStartDate}#weekly-distill`;

export const buildWeeklyDistillInputHash = (weekStartDate: string): string => `weekly:${weekStartDate}`;

export const loadWeeklyMemoryProposals = async (
  repository: AppRepository,
  weekStartDate: string
): Promise<AiProposal[]> => {
  const scopeKey = buildWeeklyDistillScopeKey(weekStartDate);
  const inputHash = buildWeeklyDistillInputHash(weekStartDate);
  const message = await repository.getAiMessage("coach_pulse", scopeKey, inputHash);
  if (!message) {
    return [];
  }

  const proposals = await repository.listAiProposals(message.id);
  return proposals.filter((proposal) => proposal.status === "pending");
};

export const createWeeklyMemoryProposals = async (
  repository: AppRepository,
  weekStartDate: string,
  historyEntries: DailyEntry[]
): Promise<AiProposal[]> => {
  const scopeKey = buildWeeklyDistillScopeKey(weekStartDate);
  const inputHash = buildWeeklyDistillInputHash(weekStartDate);
  const existing = await repository.getAiMessage("coach_pulse", scopeKey, inputHash);
  if (existing) {
    return loadWeeklyMemoryProposals(repository, weekStartDate);
  }

  const findings = computeCorrelationFindings(historyEntries)
    .filter((finding) => Math.abs(finding.diff) >= 0.1)
    .sort((left, right) => Math.abs(right.diff) - Math.abs(left.diff))
    .slice(0, MAX_WEEKLY_CANDIDATES);

  if (findings.length === 0) {
    return [];
  }

  const createdAt = nowIso();
  const message: AiMessage = {
    id: createEntityId("ai-message"),
    surface: "coach_pulse",
    scopeKey,
    stance: null,
    kind: "weekly_distill",
    inputHash,
    promptVersion: COACH_PULSE_PROMPT_VERSION,
    model: "derived",
    status: "skipped",
    bodyJson: null,
    bodyText: null,
    deltaClass: null,
    notified: false,
    tokensPrompt: null,
    tokensCompletion: null,
    latencyMs: null,
    createdAt
  };

  await repository.saveAiMessage(message);

  const proposals: AiProposal[] = findings.map((finding) => {
    const payload = buildPatternMemoryPayload(
      finding.label,
      Math.min(0.95, 0.5 + Math.abs(finding.diff)),
      finding.principleKey,
      finding.diff,
      finding.evidenceWindow.from,
      finding.evidenceWindow.to
    );

    return {
      id: createEntityId("ai-proposal"),
      messageId: message.id,
      type: "memory",
      payloadJson: JSON.stringify(payload),
      status: "pending",
      appliedEntityId: null,
      decidedAt: null,
      createdAt
    };
  });

  for (const proposal of proposals) {
    await repository.saveAiProposal(proposal);
  }

  return proposals;
};
