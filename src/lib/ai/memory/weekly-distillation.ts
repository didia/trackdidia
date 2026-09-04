import { computeCorrelationFindings } from "../../../domain/insights/correlations";
import type { AiMessage, AiProposal, DailyEntry, PrincipleKey } from "../../../domain/types";
import { nowIso } from "../../gtd/shared";
import type { AppRepository } from "../../storage/repository";
import { COACH_PULSE_PROMPT_VERSION } from "../coach-pulse-service";
import { buildPatternMemoryPayload } from "./apply-proposal";

const MAX_WEEKLY_CANDIDATES = 3;

export const buildWeeklyDistillScopeKey = (weekStartDate: string): string =>
  `${weekStartDate}#weekly-distill`;

export const buildWeeklyDistillInputHash = (weekStartDate: string): string =>
  `weekly:${weekStartDate}`;

export const buildWeeklyDistillMessageId = (weekStartDate: string): string =>
  `ai-message:weekly-distill:${weekStartDate}`;

export const buildWeeklyDistillProposalId = (
  weekStartDate: string,
  principleKey: PrincipleKey,
): string => `ai-proposal:weekly-distill:${weekStartDate}:${principleKey}`;

const buildWeeklyDistillMessage = (weekStartDate: string, createdAt: string): AiMessage => ({
  id: buildWeeklyDistillMessageId(weekStartDate),
  surface: "coach_pulse",
  scopeKey: buildWeeklyDistillScopeKey(weekStartDate),
  stance: null,
  kind: "weekly_distill",
  inputHash: buildWeeklyDistillInputHash(weekStartDate),
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
  createdAt,
});

const buildExpectedWeeklyProposals = (
  weekStartDate: string,
  messageId: string,
  createdAt: string,
  historyEntries: DailyEntry[],
): AiProposal[] => {
  const findings = computeCorrelationFindings(historyEntries)
    .filter((finding) => Math.abs(finding.diff) >= 0.1)
    .sort((left, right) => Math.abs(right.diff) - Math.abs(left.diff))
    .slice(0, MAX_WEEKLY_CANDIDATES);

  return findings.map((finding) => {
    const payload = buildPatternMemoryPayload(
      finding.label,
      Math.min(0.95, 0.5 + Math.abs(finding.diff)),
      finding.principleKey,
      finding.diff,
      finding.evidenceWindow.from,
      finding.evidenceWindow.to,
    );

    return {
      id: buildWeeklyDistillProposalId(weekStartDate, finding.principleKey),
      messageId,
      type: "memory",
      payloadJson: JSON.stringify(payload),
      status: "pending",
      appliedEntityId: null,
      decidedAt: null,
      createdAt,
    };
  });
};

const expectedProposalsSatisfied = (existing: AiProposal[], expected: AiProposal[]): boolean => {
  if (expected.length === 0) {
    return true;
  }

  const existingById = new Map(existing.map((proposal) => [proposal.id, proposal]));
  return expected.every((proposal) => {
    const row = existingById.get(proposal.id);
    return row !== undefined && row.payloadJson === proposal.payloadJson;
  });
};

const persistMissingWeeklyProposals = async (
  repository: AppRepository,
  messageId: string,
  existing: AiProposal[],
  expected: AiProposal[],
): Promise<void> => {
  const existingIds = new Set(existing.map((proposal) => proposal.id));

  for (const proposal of expected) {
    if (existingIds.has(proposal.id)) {
      continue;
    }

    await repository.saveAiProposal({ ...proposal, messageId });
  }
};

export const loadWeeklyMemoryProposals = async (
  repository: AppRepository,
  weekStartDate: string,
): Promise<AiProposal[]> => {
  const scopeKey = buildWeeklyDistillScopeKey(weekStartDate);
  const inputHash = buildWeeklyDistillInputHash(weekStartDate);
  const message = await repository.getAiMessageRecord("coach_pulse", scopeKey, inputHash);
  if (!message) {
    return [];
  }

  const proposals = await repository.listAiProposals(message.id);
  return proposals.filter((proposal) => proposal.status === "pending");
};

export const createWeeklyMemoryProposals = async (
  repository: AppRepository,
  weekStartDate: string,
  historyEntries: DailyEntry[],
): Promise<AiProposal[]> => {
  const scopeKey = buildWeeklyDistillScopeKey(weekStartDate);
  const inputHash = buildWeeklyDistillInputHash(weekStartDate);
  const createdAt = nowIso();
  const messageId = buildWeeklyDistillMessageId(weekStartDate);
  const expectedProposals = buildExpectedWeeklyProposals(
    weekStartDate,
    messageId,
    createdAt,
    historyEntries,
  );

  if (expectedProposals.length === 0) {
    return [];
  }

  const existing = await repository.getAiMessageRecord("coach_pulse", scopeKey, inputHash);
  if (existing) {
    const current = await repository.listAiProposals(existing.id);
    if (!expectedProposalsSatisfied(current, expectedProposals)) {
      await persistMissingWeeklyProposals(
        repository,
        existing.id,
        current,
        expectedProposals.map((proposal) => ({ ...proposal, messageId: existing.id })),
      );
    }

    return loadWeeklyMemoryProposals(repository, weekStartDate);
  }

  const saved = await repository.saveCoachPulseEpisode(
    buildWeeklyDistillMessage(weekStartDate, createdAt),
    expectedProposals,
  );
  return saved.proposals.filter((proposal) => proposal.status === "pending");
};
