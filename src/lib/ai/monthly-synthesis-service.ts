import type {
  AiMessage,
  AiProposal,
  AppSettings,
  MonthlyReviewSectionKey,
  MonthlySynthesisResponse,
  MonthlySynthesisResult
} from "../../domain/types";
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
  createdAt: string
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
      createdAt
    });
  }

  for (const evaluation of synthesis.goalEvaluationDrafts ?? []) {
    if (!evaluation.goalId?.trim()) {
      continue;
    }

    proposals.push({
      id: createEntityId("ai-proposal"),
      messageId,
      type: "goal_evaluation",
      payloadJson: JSON.stringify({ monthKey, ...evaluation }),
      status: "pending",
      appliedEntityId: null,
      decidedAt: null,
      createdAt
    });
  }

  return proposals;
};

const cachedResult = async (
  repository: AppRepository,
  message: AiMessage
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
    source: "cache"
  };
};

const persistResult = async (
  repository: AppRepository,
  message: AiMessage,
  monthKey: string,
  synthesis: MonthlySynthesisResponse
): Promise<MonthlySynthesisResult> => {
  const savedMessage = await repository.saveAiMessage(message);
  await repository.clearPendingAiProposals(savedMessage.id);
  const proposals = buildProposals(savedMessage.id, monthKey, synthesis, savedMessage.createdAt);

  for (const proposal of proposals) {
    await repository.saveAiProposal(proposal);
  }

  return {
    message: savedMessage,
    synthesis,
    proposals,
    source: message.status === "ok" ? "ai" : message.status === "fallback" ? "fallback" : "local"
  };
};

export class MonthlySynthesisService {
  constructor(private readonly provider: AiProvider) {}

  async resultFromMessage(repository: AppRepository, message: AiMessage): Promise<MonthlySynthesisResult | null> {
    return cachedResult(repository, message);
  }

  async buildSynthesis(
    repository: AppRepository,
    request: MonthlySynthesisRequest
  ): Promise<MonthlySynthesisResult> {
    const { monthKey, settings, snapshotInputs, bypassCache = false } = request;
    const snapshot = buildMonthlySnapshot(snapshotInputs, settings.aiPayloadScope);
    const scopeKey = monthKey;
    const createdAt = nowIso();

    const activeMemories = await repository.listAiMemories({
      status: "active",
      activeOnDate: snapshot.monthEndDate
    });
    const { block: memoryBlock, selected } = retrieveMemoriesForMonthly(activeMemories, settings, {
      nowIso: createdAt
    });
    const memoryIds = selected.map((memory) => memory.id).sort();
    const inputHash = buildAiInputHash({
      promptVersion: MONTHLY_SYNTHESIS_PROMPT_VERSION,
      scope: settings.aiPayloadScope,
      snapshot,
      memoryIds
    });

    if (!bypassCache) {
      const cached = await repository.getAiMessage("monthly_synthesis", scopeKey, inputHash);
      if (cached) {
        const result = await cachedResult(repository, cached);
        if (result) {
          return result;
        }
      }
    }

    const localSynthesis = buildLocalMonthlySynthesis(snapshot);
    const existingMessage = await repository.getAiMessage("monthly_synthesis", scopeKey, inputHash);
    const baseMessage = (): AiMessage => ({
      id: existingMessage?.id ?? createEntityId("ai-message"),
      surface: "monthly_synthesis",
      scopeKey,
      stance: null,
      kind: "monthly",
      inputHash,
      promptVersion: MONTHLY_SYNTHESIS_PROMPT_VERSION,
      model: settings.aiSurfaceModels.monthly_synthesis ?? settings.aiModel,
      status: "ok",
      bodyJson: JSON.stringify(localSynthesis),
      bodyText: synthesisToBodyText(localSynthesis),
      deltaClass: null,
      notified: false,
      tokensPrompt: null,
      tokensCompletion: null,
      latencyMs: null,
      createdAt
    });

    const aiConfigured = settings.aiEnabled && settings.aiApiKey.trim().length > 0;

    if (!aiConfigured) {
      const skippedMessage = {
        ...baseMessage(),
        status: "skipped" as const,
        model: "local"
      };

      return persistResult(repository, skippedMessage, monthKey, localSynthesis);
    }

    try {
      const first = await this.provider.generateStructured({
        surface: "monthly_synthesis",
        settings,
        snapshot,
        memoryBlock
      });

      let parsed = parseMonthlySynthesisJson(first.text);
      let finalText = first.text;
      let usage = first.usage;
      let model = first.model;

      if (!parsed.ok) {
        const repair = await this.provider.generateStructured({
          surface: "monthly_synthesis",
          settings,
          snapshot,
          memoryBlock,
          repairHint: parsed.error
        });
        parsed = parseMonthlySynthesisJson(repair.text);
        finalText = repair.text;
        usage = {
          tokensPrompt: usage.tokensPrompt + repair.usage.tokensPrompt,
          tokensCompletion: usage.tokensCompletion + repair.usage.tokensCompletion,
          latencyMs: usage.latencyMs + repair.usage.latencyMs
        };
        model = repair.model;
      }

      if (!parsed.ok) {
        const message: AiMessage = {
          ...baseMessage(),
          status: "fallback",
          model,
          bodyJson: JSON.stringify(localSynthesis),
          bodyText: synthesisToBodyText(localSynthesis),
          tokensPrompt: usage.tokensPrompt,
          tokensCompletion: usage.tokensCompletion,
          latencyMs: usage.latencyMs
        };

        const result = await persistResult(repository, message, monthKey, localSynthesis);
        return {
          ...result,
          source: "fallback",
          warning: parsed.error
        };
      }

      const message: AiMessage = {
        ...baseMessage(),
        status: "ok",
        model,
        bodyJson: finalText,
        bodyText: synthesisToBodyText(parsed.value),
        tokensPrompt: usage.tokensPrompt,
        tokensCompletion: usage.tokensCompletion,
        latencyMs: usage.latencyMs
      };

      const result = await persistResult(repository, message, monthKey, parsed.value);
      return {
        ...result,
        source: "ai"
      };
    } catch (error) {
      const message: AiMessage = {
        ...baseMessage(),
        status: "fallback",
        bodyJson: JSON.stringify(localSynthesis),
        bodyText: synthesisToBodyText(localSynthesis)
      };

      const result = await persistResult(repository, message, monthKey, localSynthesis);
      return {
        ...result,
        source: "fallback",
        warning: error instanceof Error ? error.message : "L'IA n'a pas pu repondre."
      };
    }
  }
}

export const monthlySectionKeyFromProposal = (payloadJson: string): MonthlyReviewSectionKey | null => {
  try {
    const payload = JSON.parse(payloadJson) as { sectionKey?: MonthlyReviewSectionKey };
    return payload.sectionKey ?? null;
  } catch {
    return null;
  }
};
