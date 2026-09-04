import type {
  AiMessage,
  AppSettings,
  GoalPacingResponse,
  GoalPacingResult,
} from "../../domain/types";
import { createEntityId, nowIso } from "../gtd/shared";
import type { AppRepository } from "../storage/repository";
import {
  buildGoalPacingSnapshot,
  type GoalPacingSnapshotInputs,
} from "./context/goal-pacing-snapshot";
import { buildAiInputHash } from "./input-hash";
import { retrieveMemoriesForGoalPacing } from "./memory/retrieval";
import { buildLocalGoalPacing } from "./proposals/goal-pacing-fallback";
import { parseGoalPacingJson } from "./proposals/goal-pacing-validator";
import type { AiProvider } from "./provider";

export const GOAL_PACING_PROMPT_VERSION = "goal_pacing.v1";

export interface GoalPacingRequest {
  year: number;
  settings: AppSettings;
  snapshotInputs: GoalPacingSnapshotInputs;
  bypassCache?: boolean;
  trigger?: "auto" | "explicit";
}

const pacingToBodyText = (pacing: GoalPacingResponse): string =>
  pacing.goals
    .slice(0, 3)
    .map((goal) => `${goal.onPace ? "Sur la bonne voie" : "A surveiller"} — ${goal.gap}`)
    .join("\n");

const resultSourceFromMessage = (message: AiMessage): GoalPacingResult["source"] => {
  if (message.status === "ok") {
    return "cache";
  }

  if (message.status === "fallback") {
    return "fallback";
  }

  return "local";
};

const cachedResult = async (
  _repository: AppRepository,
  message: AiMessage,
): Promise<GoalPacingResult | null> => {
  if (!message.bodyJson) {
    return null;
  }

  const parsed = parseGoalPacingJson(message.bodyJson);
  if (!parsed.ok) {
    return null;
  }

  return {
    message,
    pacing: parsed.value,
    source: resultSourceFromMessage(message),
  };
};

const persistResult = async (
  repository: AppRepository,
  message: AiMessage,
  pacing: GoalPacingResponse,
): Promise<GoalPacingResult> => {
  const saved = await repository.saveCoachPulseEpisode(message, []);

  return {
    message: saved.message,
    pacing,
    source: message.status === "ok" ? "ai" : message.status === "fallback" ? "fallback" : "local",
  };
};

export class GoalPacingService {
  constructor(private readonly provider: AiProvider) {}

  async resultFromMessage(
    repository: AppRepository,
    message: AiMessage,
  ): Promise<GoalPacingResult | null> {
    return cachedResult(repository, message);
  }

  async buildPacing(
    repository: AppRepository,
    request: GoalPacingRequest,
  ): Promise<GoalPacingResult> {
    const { year, settings, snapshotInputs, bypassCache = false } = request;
    const snapshot = buildGoalPacingSnapshot(snapshotInputs, settings.aiPayloadScope);
    const scopeKey = String(year);
    const createdAt = nowIso();
    const aiConfigured = settings.aiEnabled && settings.aiApiKey.trim().length > 0;

    const activeMemories = await repository.listAiMemories({
      status: "active",
      activeOnDate: snapshot.asOfDate,
    });
    const { block: memoryBlock, selected } = retrieveMemoriesForGoalPacing(
      activeMemories,
      settings,
      {
        nowIso: createdAt,
      },
    );
    const memoryIds = selected.map((memory) => memory.id).sort();
    const inputHash = buildAiInputHash({
      promptVersion: GOAL_PACING_PROMPT_VERSION,
      scope: settings.aiPayloadScope,
      snapshot,
      memoryIds,
    });

    if (!bypassCache) {
      if (aiConfigured) {
        const cached = await repository.getAiMessage("goal_pacing", scopeKey, inputHash);
        if (cached) {
          const result = await cachedResult(repository, cached);
          if (result) {
            return { ...result, source: "cache" };
          }
        }
      } else {
        const skipped = await repository.getAiMessageRecord("goal_pacing", scopeKey, inputHash);
        if (skipped?.status === "skipped") {
          const result = await cachedResult(repository, skipped);
          if (result) {
            return { ...result, source: "cache" };
          }
        }
      }
    }

    const localPacing = buildLocalGoalPacing(snapshot);
    const existingMessage = await repository.getAiMessageRecord("goal_pacing", scopeKey, inputHash);
    const baseMessage = (): AiMessage => ({
      id: existingMessage?.id ?? createEntityId("ai-message"),
      surface: "goal_pacing",
      scopeKey,
      stance: null,
      kind: "annual",
      inputHash,
      promptVersion: GOAL_PACING_PROMPT_VERSION,
      model: settings.aiSurfaceModels.goal_pacing ?? settings.aiModel,
      status: "ok",
      bodyJson: JSON.stringify(localPacing),
      bodyText: pacingToBodyText(localPacing),
      deltaClass: null,
      notified: false,
      tokensPrompt: null,
      tokensCompletion: null,
      latencyMs: null,
      createdAt,
    });

    if (!aiConfigured) {
      const skippedMessage = {
        ...baseMessage(),
        status: "skipped" as const,
        model: "local",
      };

      return persistResult(repository, skippedMessage, localPacing);
    }

    try {
      const first = await this.provider.generateStructured({
        surface: "goal_pacing",
        settings,
        snapshot,
        memoryBlock,
      });

      let parsed = parseGoalPacingJson(first.text);
      let finalText = first.text;
      let usage = first.usage;
      let model = first.model;

      if (!parsed.ok) {
        const repair = await this.provider.generateStructured({
          surface: "goal_pacing",
          settings,
          snapshot,
          memoryBlock,
          repairHint: parsed.error,
        });
        parsed = parseGoalPacingJson(repair.text);
        finalText = repair.text;
        usage = {
          tokensPrompt: usage.tokensPrompt + repair.usage.tokensPrompt,
          tokensCompletion: usage.tokensCompletion + repair.usage.tokensCompletion,
          latencyMs: usage.latencyMs + repair.usage.latencyMs,
        };
        model = repair.model;
      }

      if (!parsed.ok) {
        const message: AiMessage = {
          ...baseMessage(),
          status: "fallback",
          model,
          bodyJson: JSON.stringify(localPacing),
          bodyText: pacingToBodyText(localPacing),
          tokensPrompt: usage.tokensPrompt,
          tokensCompletion: usage.tokensCompletion,
          latencyMs: usage.latencyMs,
        };

        const result = await persistResult(repository, message, localPacing);
        return {
          ...result,
          source: "fallback",
          warning: parsed.error,
        };
      }

      const message: AiMessage = {
        ...baseMessage(),
        status: "ok",
        model,
        bodyJson: finalText,
        bodyText: pacingToBodyText(parsed.value),
        tokensPrompt: usage.tokensPrompt,
        tokensCompletion: usage.tokensCompletion,
        latencyMs: usage.latencyMs,
      };

      const result = await persistResult(repository, message, parsed.value);
      return {
        ...result,
        source: "ai",
      };
    } catch (error) {
      const message: AiMessage = {
        ...baseMessage(),
        status: "fallback",
        bodyJson: JSON.stringify(localPacing),
        bodyText: pacingToBodyText(localPacing),
      };

      const result = await persistResult(repository, message, localPacing);
      return {
        ...result,
        source: "fallback",
        warning: error instanceof Error ? error.message : "L'IA n'a pas pu repondre.",
      };
    }
  }
}
