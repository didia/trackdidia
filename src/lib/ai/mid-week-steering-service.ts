import type {
  AiMessage,
  AppSettings,
  MidWeekSteeringResponse,
  MidWeekSteeringResult,
} from "../../domain/types";
import { stableAiNowIso } from "../date";
import { createEntityId, nowIso } from "../gtd/shared";
import type { AppRepository } from "../storage/repository";
import { buildMidWeekSnapshot, type MidWeekSnapshotInputs } from "./context/mid-week-snapshot";
import { buildAiInputHash } from "./input-hash";
import { retrieveMemoriesForWeekly } from "./memory/retrieval";
import { buildLocalMidWeekSteering } from "./proposals/mid-week-steering-fallback";
import { parseMidWeekSteeringJson } from "./proposals/mid-week-steering-validator";
import type { AiProvider } from "./provider";

export const MID_WEEK_STEERING_PROMPT_VERSION = "mid_week_steering.v1";

export interface MidWeekSteeringRequest {
  settings: AppSettings;
  snapshotInputs: MidWeekSnapshotInputs;
  bypassCache?: boolean;
  trigger?: "auto" | "explicit";
}

const steeringToBodyText = (steering: MidWeekSteeringResponse): string =>
  [steering.headline, steering.focusShift].join("\n");

const resultSourceFromMessage = (message: AiMessage): MidWeekSteeringResult["source"] => {
  if (message.status === "ok") {
    return "cache";
  }
  return message.status === "fallback" ? "fallback" : "local";
};

const cachedResult = async (
  _repository: AppRepository,
  message: AiMessage,
): Promise<MidWeekSteeringResult | null> => {
  // A stale prompt version may be shaped for an older schema: never render it as current.
  if (!message.bodyJson || message.promptVersion !== MID_WEEK_STEERING_PROMPT_VERSION) {
    return null;
  }
  const parsed = parseMidWeekSteeringJson(message.bodyJson);
  if (!parsed.ok) {
    return null;
  }
  return { message, steering: parsed.value, source: resultSourceFromMessage(message) };
};

const persistResult = async (
  repository: AppRepository,
  message: AiMessage,
  steering: MidWeekSteeringResponse,
): Promise<MidWeekSteeringResult> => {
  const saved = await repository.saveCoachPulseEpisode(message, []);
  return {
    message: saved.message,
    steering,
    source: message.status === "ok" ? "ai" : message.status === "fallback" ? "fallback" : "local",
  };
};

export class MidWeekSteeringService {
  constructor(private readonly provider: AiProvider) {}

  async resultFromMessage(
    repository: AppRepository,
    message: AiMessage,
  ): Promise<MidWeekSteeringResult | null> {
    return cachedResult(repository, message);
  }

  async buildSteering(
    repository: AppRepository,
    request: MidWeekSteeringRequest,
  ): Promise<MidWeekSteeringResult> {
    const { settings, snapshotInputs, bypassCache = false } = request;
    const snapshot = buildMidWeekSnapshot(snapshotInputs, settings.aiPayloadScope);
    if (snapshot.completedDays === 0) {
      // Sunday: no day of the week has elapsed. The page never asks; this is a tripwire so an
      // evidence-free response can never be cached.
      throw new Error("Mid-week steering needs at least one completed day.");
    }

    const scopeKey = snapshot.weekStartDate;
    const createdAt = nowIso();
    const aiConfigured = settings.aiEnabled && settings.aiApiKey.trim().length > 0;

    const activeMemories = await repository.listAiMemories({
      status: "active",
      activeOnDate: snapshot.asOfDate,
    });
    const { block: memoryBlock, selected } = retrieveMemoriesForWeekly(activeMemories, settings, {
      nowIso: stableAiNowIso(snapshot.asOfDate),
    });
    const memoryIds = selected.map((memory) => memory.id).sort();
    const inputHash = buildAiInputHash({
      promptVersion: MID_WEEK_STEERING_PROMPT_VERSION,
      scope: settings.aiPayloadScope,
      snapshot,
      memoryIds,
      asOfDate: snapshot.asOfDate,
    });

    if (!bypassCache) {
      if (aiConfigured) {
        const cached = await repository.getAiMessage("mid_week_steering", scopeKey, inputHash);
        if (cached) {
          const result = await cachedResult(repository, cached);
          if (result) {
            return { ...result, source: "cache" };
          }
        }
      } else {
        const skipped = await repository.getAiMessageRecord(
          "mid_week_steering",
          scopeKey,
          inputHash,
        );
        if (skipped?.status === "skipped") {
          const result = await cachedResult(repository, skipped);
          if (result) {
            return { ...result, source: "cache" };
          }
        }
      }
    }

    const localSteering = buildLocalMidWeekSteering(snapshot);
    const baseMessage = (): AiMessage => ({
      // ai_messages is append-only: every attempt needs its own primary key, even for a known hash.
      id: createEntityId("ai-message"),
      surface: "mid_week_steering",
      scopeKey,
      stance: null,
      kind: "weekly",
      inputHash,
      promptVersion: MID_WEEK_STEERING_PROMPT_VERSION,
      model: settings.aiSurfaceModels.mid_week_steering ?? settings.aiModel,
      status: "ok",
      bodyJson: JSON.stringify(localSteering),
      bodyText: steeringToBodyText(localSteering),
      deltaClass: null,
      notified: false,
      tokensPrompt: null,
      tokensCompletion: null,
      latencyMs: null,
      createdAt,
    });

    if (!aiConfigured) {
      return persistResult(
        repository,
        { ...baseMessage(), status: "skipped", model: "local" },
        localSteering,
      );
    }

    try {
      const first = await this.provider.generateStructured({
        surface: "mid_week_steering",
        settings,
        snapshot,
        memoryBlock,
      });

      let parsed = parseMidWeekSteeringJson(first.text, snapshot.actionableKeys);
      let usage = first.usage;
      let model = first.model;

      if (!parsed.ok) {
        const repair = await this.provider.generateStructured({
          surface: "mid_week_steering",
          settings,
          snapshot,
          memoryBlock,
          repairHint: parsed.error,
        });
        parsed = parseMidWeekSteeringJson(repair.text, snapshot.actionableKeys);
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
          tokensPrompt: usage.tokensPrompt,
          tokensCompletion: usage.tokensCompletion,
          latencyMs: usage.latencyMs,
        };
        const result = await persistResult(repository, message, localSteering);
        return { ...result, source: "fallback", warning: parsed.error };
      }

      const steering: MidWeekSteeringResponse = { ...parsed.value, asOfDate: snapshot.asOfDate };
      const message: AiMessage = {
        ...baseMessage(),
        status: "ok",
        model,
        bodyJson: JSON.stringify(steering),
        bodyText: steeringToBodyText(steering),
        tokensPrompt: usage.tokensPrompt,
        tokensCompletion: usage.tokensCompletion,
        latencyMs: usage.latencyMs,
      };
      const result = await persistResult(repository, message, steering);
      return { ...result, source: "ai" };
    } catch (error) {
      const result = await persistResult(
        repository,
        { ...baseMessage(), status: "fallback" },
        localSteering,
      );
      return {
        ...result,
        source: "fallback",
        warning: error instanceof Error ? error.message : "L'IA n'a pas pu repondre.",
      };
    }
  }
}
