import { runStructuredSurface, sourceFromStatus } from "./structured-generation";
import type {
  AiMessage,
  AppSettings,
  GoalPacingResponse,
  GoalPacingResult,
} from "../../domain/types";
import { clampAiAsOfDate, stableAiNowIso } from "../date";
import { nowIso } from "../gtd/shared";
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

export const GOAL_PACING_PROMPT_VERSION = "goal_pacing.v2";

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

const cachedResult = async (
  _repository: AppRepository,
  message: AiMessage,
): Promise<GoalPacingResult | null> => {
  if (!message.bodyJson || message.promptVersion !== GOAL_PACING_PROMPT_VERSION) {
    // A stale prompt version (e.g. hydrated on page load via `loadLatestGoalPacing`, which only
    // filters by surface/scope/status) may be shaped for an older schema. Fall through to a fresh
    // `buildPacing` run instead of rendering it as-is.
    return null;
  }

  const parsed = parseGoalPacingJson(message.bodyJson);
  if (!parsed.ok) {
    return null;
  }

  return {
    message,
    pacing: parsed.value,
    source: sourceFromStatus(message.status, { cached: true }),
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
    const asOfDate = clampAiAsOfDate(snapshotInputs.asOfDate, `${year}-12-31`);
    const snapshot = buildGoalPacingSnapshot(
      { ...snapshotInputs, asOfDate },
      settings.aiPayloadScope,
    );
    const scopeKey = String(year);
    const createdAt = nowIso();

    const activeMemories = await repository.listAiMemories({
      status: "active",
      activeOnDate: snapshot.asOfDate,
    });
    const { block: memoryBlock, selected } = retrieveMemoriesForGoalPacing(
      activeMemories,
      settings,
      {
        nowIso: stableAiNowIso(snapshot.asOfDate),
      },
    );
    const memoryIds = selected.map((memory) => memory.id).sort();
    const inputHash = buildAiInputHash({
      promptVersion: GOAL_PACING_PROMPT_VERSION,
      scope: settings.aiPayloadScope,
      snapshot,
      memoryIds,
    });

    const result = await runStructuredSurface({
      repository,
      provider: this.provider,
      settings,
      surface: "goal_pacing",
      scopeKey,
      kind: "annual",
      promptVersion: GOAL_PACING_PROMPT_VERSION,
      inputHash,
      createdAt,
      bypassCache,
      reuseMessageId: true,
      localFallback: buildLocalGoalPacing(snapshot),
      toBodyText: pacingToBodyText,
      parse: parseGoalPacingJson,
      request: (repairHint) => ({
        surface: "goal_pacing",
        settings,
        snapshot,
        memoryBlock,
        repairHint,
      }),
      cachedResult: async (message) => {
        const cached = await cachedResult(repository, message);
        return cached ? { response: cached.pacing, proposals: [] } : null;
      },
    });
    return {
      message: result.message,
      pacing: result.response,
      source: result.source,
      warning: result.warning,
    };
  }
}
