import type {
  AiMessage,
  AiProposal,
  AppSettings,
  WeeklyRitualSectionKey,
  WeeklySynthesisResponse,
  WeeklySynthesisResult
} from "../../domain/types";
import { createEntityId, nowIso } from "../gtd/shared";
import type { AppRepository } from "../storage/repository";
import { buildWeeklySnapshot, type WeeklySnapshotInputs } from "./context/weekly-snapshot";
import { buildAiInputHash } from "./input-hash";
import { retrieveMemoriesForWeekly } from "./memory/retrieval";
import { buildLocalWeeklySynthesis } from "./proposals/weekly-synthesis-fallback";
import { parseWeeklySynthesisJson } from "./proposals/weekly-synthesis-validator";
import type { AiProvider } from "./provider";

export const WEEKLY_SYNTHESIS_PROMPT_VERSION = "weekly_synthesis.v1";

export interface WeeklySynthesisRequest {
  weekStartDate: string;
  settings: AppSettings;
  snapshotInputs: WeeklySnapshotInputs;
  bypassCache?: boolean;
  trigger?: "auto" | "explicit";
}

const synthesisToBodyText = (synthesis: WeeklySynthesisResponse): string =>
  [synthesis.headline, synthesis.scoreExplanation].filter(Boolean).join("\n\n");

const buildProposals = (messageId: string, synthesis: WeeklySynthesisResponse, createdAt: string): AiProposal[] => {
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

  for (const objective of synthesis.nextWeekObjectives ?? []) {
    if (!objective.title?.trim()) {
      continue;
    }

    proposals.push({
      id: createEntityId("ai-proposal"),
      messageId,
      type: "weekly_objective",
      payloadJson: JSON.stringify(objective),
      status: "pending",
      appliedEntityId: null,
      decidedAt: null,
      createdAt
    });
  }

  for (const action of synthesis.gtdActions ?? []) {
    if (!action.taskId?.trim() || !action.reason?.trim()) {
      continue;
    }

    proposals.push({
      id: createEntityId("ai-proposal"),
      messageId,
      type: "gtd_action",
      payloadJson: JSON.stringify(action),
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
): Promise<WeeklySynthesisResult | null> => {
  if (!message.bodyJson) {
    return null;
  }

  const parsed = parseWeeklySynthesisJson(message.bodyJson);
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
  synthesis: WeeklySynthesisResponse
): Promise<WeeklySynthesisResult> => {
  const savedMessage = await repository.saveAiMessage(message);
  await repository.clearPendingAiProposals(savedMessage.id);
  const proposals = buildProposals(savedMessage.id, synthesis, savedMessage.createdAt);

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

export class WeeklySynthesisService {
  constructor(private readonly provider: AiProvider) {}

  async resultFromMessage(repository: AppRepository, message: AiMessage): Promise<WeeklySynthesisResult | null> {
    return cachedResult(repository, message);
  }

  async buildSynthesis(
    repository: AppRepository,
    request: WeeklySynthesisRequest
  ): Promise<WeeklySynthesisResult> {
    const { weekStartDate, settings, snapshotInputs, bypassCache = false, trigger = "auto" } = request;
    const snapshot = buildWeeklySnapshot(snapshotInputs, settings.aiPayloadScope);
    const scopeKey = weekStartDate;
    const createdAt = nowIso();

    const activeMemories = await repository.listAiMemories({
      status: "active",
      activeOnDate: snapshot.weekEndDate
    });
    const { block: memoryBlock, selected } = retrieveMemoriesForWeekly(activeMemories, settings, {
      nowIso: createdAt
    });
    const memoryIds = selected.map((memory) => memory.id).sort();
    const inputHash = buildAiInputHash({
      promptVersion: WEEKLY_SYNTHESIS_PROMPT_VERSION,
      scope: settings.aiPayloadScope,
      snapshot,
      memoryIds
    });

    if (!bypassCache) {
      const cached = await repository.getAiMessageRecord("weekly_synthesis", scopeKey, inputHash);
      if (cached) {
        const aiConfigured = settings.aiEnabled && settings.aiApiKey.trim().length > 0;
        const skippedBlocksProvider = cached.status === "skipped" && aiConfigured;
        if (!skippedBlocksProvider) {
          const result = await cachedResult(repository, cached);
          if (result) {
            return result;
          }
        }
      }
    }

    const localSynthesis = buildLocalWeeklySynthesis(snapshot);
    const existingMessage = await repository.getAiMessage("weekly_synthesis", scopeKey, inputHash);
    const baseMessage = (): AiMessage => ({
      id: existingMessage?.id ?? createEntityId("ai-message"),
      surface: "weekly_synthesis",
      scopeKey,
      stance: null,
      kind: "weekly",
      inputHash,
      promptVersion: WEEKLY_SYNTHESIS_PROMPT_VERSION,
      model: settings.aiSurfaceModels.weekly_synthesis ?? settings.aiModel,
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

      return persistResult(repository, skippedMessage, localSynthesis);
    }

    try {
      const first = await this.provider.generateStructured({
        surface: "weekly_synthesis",
        settings,
        snapshot,
        memoryBlock
      });

      let parsed = parseWeeklySynthesisJson(first.text);
      let finalText = first.text;
      let usage = first.usage;
      let model = first.model;

      if (!parsed.ok) {
        const repair = await this.provider.generateStructured({
          surface: "weekly_synthesis",
          settings,
          snapshot,
          memoryBlock,
          repairHint: parsed.error
        });
        parsed = parseWeeklySynthesisJson(repair.text);
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

        const result = await persistResult(repository, message, localSynthesis);
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

      const result = await persistResult(repository, message, parsed.value);
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

      const result = await persistResult(repository, message, localSynthesis);
      return {
        ...result,
        source: "fallback",
        warning: error instanceof Error ? error.message : "L'IA n'a pas pu repondre."
      };
    }
  }
}

export const weeklySectionKeyFromProposal = (payloadJson: string): WeeklyRitualSectionKey | null => {
  try {
    const payload = JSON.parse(payloadJson) as { sectionKey?: WeeklyRitualSectionKey };
    return payload.sectionKey ?? null;
  } catch {
    return null;
  }
};
