import { decodeProposal, isMonthlySectionKey } from "./proposals/payloads";
import { runStructuredSurface, sourceFromStatus } from "./structured-generation";
import type {
  AiMessage,
  AiProposal,
  AppSettings,
  MonthlyReviewSectionKey,
  MonthlySynthesisResponse,
  MonthlySynthesisResult,
} from "../../domain/types";
import { clampAiAsOfDate, getTodayDate, stableAiNowIso } from "../date";
import { createEntityId, nowIso } from "../gtd/shared";
import type { AppRepository } from "../storage/repository";
import { buildMonthlySnapshot, type MonthlySnapshotInputs } from "./context/monthly-snapshot";
import { buildAiInputHash } from "./input-hash";
import { retrieveMemoriesForMonthly } from "./memory/retrieval";
import { buildLocalMonthlySynthesis } from "./proposals/monthly-synthesis-fallback";
import { parseMonthlySynthesisJson } from "./proposals/monthly-synthesis-validator";
import type { AiProvider } from "./provider";

export const MONTHLY_SYNTHESIS_PROMPT_VERSION = "monthly_synthesis.v1";

export interface MonthlySynthesisRequest {
  monthKey: string;
  settings: AppSettings;
  snapshotInputs: MonthlySnapshotInputs;
  bypassCache?: boolean;
  trigger?: "auto" | "explicit";
}

const synthesisToBodyText = (synthesis: MonthlySynthesisResponse): string =>
  [synthesis.headline, synthesis.weekPattern].filter(Boolean).join("\n\n");

const buildProposals = (
  messageId: string,
  monthKey: string,
  synthesis: MonthlySynthesisResponse,
  createdAt: string,
  knownGoalIds: Set<string>,
): AiProposal[] => {
  const proposals: AiProposal[] = [];

  for (const [sectionKey, text] of Object.entries(synthesis.sectionDrafts ?? {})) {
    if (!text?.trim()) {
      continue;
    }

    proposals.push({
      id: createEntityId("ai-proposal"),
      messageId,
      type: "review_section_draft",
      payloadJson: JSON.stringify({ sectionKey, text: text.trim() }),
      status: "pending",
      appliedEntityId: null,
      decidedAt: null,
      createdAt,
    });
  }

  const evaluationsByGoalId = new Map<
    string,
    MonthlySynthesisResponse["goalEvaluationDrafts"][number]
  >();
  for (const evaluation of synthesis.goalEvaluationDrafts ?? []) {
    if (!evaluation.goalId?.trim() || !knownGoalIds.has(evaluation.goalId)) {
      continue;
    }

    // A model response can list the same goalId more than once; keep the last
    // draft so at most one pending goal_evaluation proposal exists per goal.
    evaluationsByGoalId.set(evaluation.goalId, evaluation);
  }

  for (const evaluation of evaluationsByGoalId.values()) {
    proposals.push({
      id: createEntityId("ai-proposal"),
      messageId,
      type: "goal_evaluation",
      payloadJson: JSON.stringify({ monthKey, ...evaluation }),
      status: "pending",
      appliedEntityId: null,
      decidedAt: null,
      createdAt,
    });
  }

  return proposals;
};

const cachedResult = async (
  repository: AppRepository,
  message: AiMessage,
): Promise<MonthlySynthesisResult | null> => {
  if (!message.bodyJson) {
    return null;
  }

  const parsed = parseMonthlySynthesisJson(message.bodyJson);
  if (!parsed.ok) {
    return null;
  }

  const proposals = await repository.listAiProposals(message.id);
  return {
    message,
    synthesis: parsed.value,
    proposals,
    source: sourceFromStatus(message.status, { cached: true }),
  };
};

export class MonthlySynthesisService {
  constructor(private readonly provider: AiProvider) {}

  async resultFromMessage(
    repository: AppRepository,
    message: AiMessage,
  ): Promise<MonthlySynthesisResult | null> {
    return cachedResult(repository, message);
  }

  async buildSynthesis(
    repository: AppRepository,
    request: MonthlySynthesisRequest,
  ): Promise<MonthlySynthesisResult> {
    const { monthKey, settings, snapshotInputs, bypassCache = false } = request;
    const snapshot = buildMonthlySnapshot(snapshotInputs, settings.aiPayloadScope);
    const knownGoalIds = new Set(snapshot.goals.map((goal) => goal.goalId));
    const scopeKey = monthKey;
    const createdAt = nowIso();
    const asOfDate = clampAiAsOfDate(getTodayDate(), snapshot.monthEndDate);

    const activeMemories = await repository.listAiMemories({
      status: "active",
      activeOnDate: snapshot.monthEndDate,
    });
    const { block: memoryBlock, selected } = retrieveMemoriesForMonthly(activeMemories, settings, {
      nowIso: stableAiNowIso(asOfDate),
    });
    const memoryIds = selected.map((memory) => memory.id).sort();
    const inputHash = buildAiInputHash({
      promptVersion: MONTHLY_SYNTHESIS_PROMPT_VERSION,
      scope: settings.aiPayloadScope,
      snapshot,
      memoryIds,
      asOfDate,
    });

    const result = await runStructuredSurface({
      repository,
      provider: this.provider,
      settings,
      surface: "monthly_synthesis",
      scopeKey,
      kind: "monthly",
      promptVersion: MONTHLY_SYNTHESIS_PROMPT_VERSION,
      inputHash,
      createdAt,
      bypassCache,
      reuseMessageId: true,
      localFallback: buildLocalMonthlySynthesis(snapshot),
      toBodyText: synthesisToBodyText,
      parse: parseMonthlySynthesisJson,
      request: (repairHint) => ({
        surface: "monthly_synthesis",
        settings,
        snapshot,
        memoryBlock,
        repairHint,
      }),
      buildProposals: (id, response, at) =>
        buildProposals(id, monthKey, response, at, knownGoalIds),
      cachedResult: async (message) => {
        const cached = await cachedResult(repository, message);
        return cached ? { response: cached.synthesis, proposals: cached.proposals } : null;
      },
    });
    return {
      message: result.message,
      synthesis: result.response,
      proposals: result.proposals,
      source: result.source,
      warning: result.warning,
    };
  }
}

export const monthlySectionKeyFromProposal = (
  payloadJson: string,
): MonthlyReviewSectionKey | null => {
  const decoded = decodeProposal({ type: "review_section_draft", payloadJson });
  return decoded.type === "review_section_draft" && isMonthlySectionKey(decoded.payload.sectionKey)
    ? decoded.payload.sectionKey
    : null;
};

export const monthlyReviewSectionFromProposal = (
  proposal: AiProposal,
): { sectionKey: MonthlyReviewSectionKey; text: string } | null => {
  const decoded = decodeProposal(proposal);
  return decoded.type === "review_section_draft" && isMonthlySectionKey(decoded.payload.sectionKey)
    ? { sectionKey: decoded.payload.sectionKey, text: decoded.payload.text }
    : null;
};
