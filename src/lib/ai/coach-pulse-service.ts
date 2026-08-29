import type { Finding } from "../../domain/insights/types";
import type {
  AiMessage,
  AiProposal,
  AppSettings,
  CoachPulseResponse,
  CoachPulseResult,
  CoachPulseStance,
  DailyEntry
} from "../../domain/types";
import { createEntityId, nowIso } from "../gtd/shared";
import type { AppRepository } from "../storage/repository";
import { buildDailySnapshot, type DailySnapshotInputs } from "./context/daily-snapshot";
import { buildAiInputHash } from "./input-hash";
import { buildLocalCoachPulse } from "./proposals/coach-pulse-fallback";
import { parseCoachPulseJson } from "./proposals/coach-pulse-validator";
import type { AiProvider } from "./provider";

export const COACH_PULSE_PROMPT_VERSION = "coach_pulse.v1";

export interface CoachPulseRequest {
  stance: CoachPulseStance;
  entry: DailyEntry;
  settings: AppSettings;
  snapshotInputs: DailySnapshotInputs;
  bypassCache?: boolean;
  /** `auto` checks cache then local fallback; `explicit` may call the provider. */
  trigger?: "auto" | "explicit";
}

const buildScopeKey = (date: string, stance: CoachPulseStance): string =>
  stance === "open" ? date : `${date}#${stance}`;

const pulseToBodyText = (pulse: CoachPulseResponse): string =>
  [pulse.headline, pulse.read, pulse.move ? `${pulse.move.what} — ${pulse.move.why}` : null]
    .filter(Boolean)
    .join("\n\n");

const buildProposals = (messageId: string, pulse: CoachPulseResponse, createdAt: string): AiProposal[] => {
  const proposals: AiProposal[] = [];

  if (pulse.stance === "open" && pulse.intentionDraft?.trim()) {
    proposals.push({
      id: createEntityId("ai-proposal"),
      messageId,
      type: "intention_draft",
      payloadJson: JSON.stringify({ text: pulse.intentionDraft.trim() }),
      status: "pending",
      appliedEntityId: null,
      decidedAt: null,
      createdAt
    });
  }

  if (pulse.stance === "close" && pulse.tomorrowFocusDraft?.trim()) {
    proposals.push({
      id: createEntityId("ai-proposal"),
      messageId,
      type: "tomorrow_focus_draft",
      payloadJson: JSON.stringify({ text: pulse.tomorrowFocusDraft.trim() }),
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
): Promise<CoachPulseResult | null> => {
  if (!message.bodyJson) {
    return null;
  }

  try {
    const pulse = JSON.parse(message.bodyJson) as CoachPulseResponse;
    const proposals = await repository.listAiProposals(message.id);
    return {
      message,
      pulse,
      proposals,
      source: "cache"
    };
  } catch {
    return null;
  }
};

const persistResult = async (
  repository: AppRepository,
  message: AiMessage,
  pulse: CoachPulseResponse
): Promise<CoachPulseResult> => {
  const savedMessage = await repository.saveAiMessage(message);
  await repository.clearPendingAiProposals(savedMessage.id);
  const proposals = buildProposals(savedMessage.id, pulse, savedMessage.createdAt);

  for (const proposal of proposals) {
    await repository.saveAiProposal(proposal);
  }

  return {
    message: savedMessage,
    pulse,
    proposals,
    source: message.status === "ok" ? "ai" : message.status === "fallback" ? "fallback" : "local"
  };
};

export class CoachPulseService {
  constructor(private readonly provider: AiProvider) {}

  async buildPulse(
    repository: AppRepository,
    request: CoachPulseRequest
  ): Promise<CoachPulseResult> {
    const { stance, entry, settings, snapshotInputs, bypassCache = false, trigger = "auto" } = request;
    const snapshot = buildDailySnapshot(snapshotInputs, settings.aiPayloadScope);
    const scopeKey = buildScopeKey(entry.date, stance);
    const inputHash = buildAiInputHash({
      promptVersion: COACH_PULSE_PROMPT_VERSION,
      stance,
      scope: settings.aiPayloadScope,
      snapshot
    });

    if (!bypassCache) {
      const cached = await repository.getAiMessage("coach_pulse", scopeKey, inputHash);
      if (cached) {
        const result = await cachedResult(repository, cached);
        if (result) {
          return result;
        }
      }
    }

    const findings = snapshot.findings as Finding[];
    const localPulse = buildLocalCoachPulse(stance, findings);
    const createdAt = nowIso();
    const existingMessage = await repository.getAiMessage("coach_pulse", scopeKey, inputHash);
    const baseMessage = (): AiMessage => ({
      id: existingMessage?.id ?? createEntityId("ai-message"),
      surface: "coach_pulse",
      scopeKey,
      stance,
      kind: stance,
      inputHash,
      promptVersion: COACH_PULSE_PROMPT_VERSION,
      model: settings.aiSurfaceModels.coach_pulse ?? settings.aiModel,
      status: "ok",
      bodyJson: JSON.stringify(localPulse),
      bodyText: pulseToBodyText(localPulse),
      deltaClass: null,
      notified: false,
      tokensPrompt: null,
      tokensCompletion: null,
      latencyMs: null,
      createdAt
    });

    if (!settings.aiEnabled || !settings.aiApiKey.trim() || trigger === "auto") {
      const ephemeralMessage = {
        ...baseMessage(),
        status: "skipped" as const,
        model: "local"
      };

      if (trigger === "auto") {
        return {
          message: ephemeralMessage,
          pulse: localPulse,
          proposals: buildProposals(ephemeralMessage.id, localPulse, createdAt),
          source: "local"
        };
      }

      return persistResult(repository, ephemeralMessage, localPulse);
    }

    try {
      const first = await this.provider.generateStructured({
        surface: "coach_pulse",
        stance,
        settings,
        snapshot
      });

      let parsed = parseCoachPulseJson(first.text, stance);
      let finalText = first.text;
      let usage = first.usage;
      let model = first.model;

      if (!parsed.ok) {
        const repair = await this.provider.generateStructured({
          surface: "coach_pulse",
          stance,
          settings,
          snapshot,
          repairHint: parsed.error
        });
        parsed = parseCoachPulseJson(repair.text, stance);
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
          bodyJson: JSON.stringify(localPulse),
          bodyText: pulseToBodyText(localPulse),
          tokensPrompt: usage.tokensPrompt,
          tokensCompletion: usage.tokensCompletion,
          latencyMs: usage.latencyMs
        };

        const result = await persistResult(repository, message, localPulse);
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
        bodyText: pulseToBodyText(parsed.value),
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
        bodyJson: JSON.stringify(localPulse),
        bodyText: pulseToBodyText(localPulse)
      };

      const result = await persistResult(repository, message, localPulse);
      return {
        ...result,
        source: "fallback",
        warning: error instanceof Error ? error.message : "L'IA n'a pas pu repondre."
      };
    }
  }
}

/** @deprecated Use CoachPulseService for structured coach_pulse output. */
export { AiCoachService } from "./coach-service";
