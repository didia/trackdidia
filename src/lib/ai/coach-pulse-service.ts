import type { Finding } from "../../domain/insights/types";
import type {
  AiDeltaClass,
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
import { normalizeAiBaseUrl } from "./openrouter-provider";
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
  /** `auto` loads cache then may call the provider when AI is configured; `explicit` always may. */
  trigger?: "auto" | "explicit";
  /** When true, never call the provider and return an ephemeral local brief without proposals. */
  localOnly?: boolean;
  deltaClass?: AiDeltaClass | null;
  /** Local hour for steer/wind_down scope keys (`YYYY-MM-DD#13`). */
  slotHour?: number;
}

const buildScopeKey = (date: string, stance: CoachPulseStance, slotHour?: number): string => {
  if (stance === "open") {
    return date;
  }

  if (stance === "close") {
    return `${date}#close`;
  }

  return `${date}#${slotHour ?? (stance === "steer" ? 13 : 20)}`;
};

const buildConfigFingerprint = (settings: AppSettings): Record<string, string> => ({
  model: settings.aiSurfaceModels.coach_pulse?.trim() || settings.aiModel,
  baseUrl: normalizeAiBaseUrl(settings.aiBaseUrl)
});

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

const expectedProposalCount = (pulse: CoachPulseResponse): number => {
  let count = 0;
  if (pulse.stance === "open" && pulse.intentionDraft?.trim()) {
    count += 1;
  }
  if (pulse.stance === "close" && pulse.tomorrowFocusDraft?.trim()) {
    count += 1;
  }
  return count;
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

    if (proposals.length < expectedProposalCount(pulse)) {
      return null;
    }

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
  const proposals = buildProposals(message.id, pulse, message.createdAt);
  const saved = await repository.saveCoachPulseEpisode(message, proposals);

  return {
    message: saved.message,
    pulse,
    proposals: saved.proposals,
    source: message.status === "ok" ? "ai" : message.status === "fallback" ? "fallback" : "local"
  };
};

export class CoachPulseService {
  constructor(private readonly provider: AiProvider) {}

  async resultFromMessage(repository: AppRepository, message: AiMessage): Promise<CoachPulseResult | null> {
    return cachedResult(repository, message);
  }

  async buildPulse(
    repository: AppRepository,
    request: CoachPulseRequest
  ): Promise<CoachPulseResult> {
    const {
      stance,
      entry,
      settings,
      snapshotInputs,
      bypassCache = false,
      trigger = "auto",
      localOnly = false,
      deltaClass = null,
      slotHour
    } = request;
    const snapshot = buildDailySnapshot(snapshotInputs, settings.aiPayloadScope);
    const scopeKey = buildScopeKey(entry.date, stance, slotHour);
    const inputHash = buildAiInputHash({
      promptVersion: COACH_PULSE_PROMPT_VERSION,
      stance,
      scope: settings.aiPayloadScope,
      snapshot,
      config: buildConfigFingerprint(settings)
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
    const localPulse = buildLocalCoachPulse(stance, findings, deltaClass ?? undefined);
    const createdAt = nowIso();
    const aiConfigured = settings.aiEnabled && settings.aiApiKey.trim().length > 0;
    const autoMayCallProvider =
      trigger === "auto" && (deltaClass === null || deltaClass === "progress" || deltaClass === "stall");
    const shouldCallProvider = !localOnly && aiConfigured && (trigger === "explicit" || autoMayCallProvider);

    const baseMessage = (): AiMessage => ({
      id: createEntityId("ai-message"),
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
      deltaClass,
      notified: false,
      tokensPrompt: null,
      tokensCompletion: null,
      latencyMs: null,
      createdAt
    });

    if (!shouldCallProvider) {
      const skippedMessage = {
        ...baseMessage(),
        status: "skipped" as const,
        model: "local"
      };

      if (trigger === "explicit" || deltaClass !== null) {
        return persistResult(repository, skippedMessage, localPulse);
      }

      return {
        message: skippedMessage,
        pulse: localPulse,
        proposals: [],
        source: "local"
      };
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
