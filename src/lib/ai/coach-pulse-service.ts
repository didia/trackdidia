import { runStructuredSurface } from "./structured-generation";
import type { Finding } from "../../domain/insights/types";
import type {
  AiDeltaClass,
  AiMemory,
  AiMessage,
  AiProposal,
  AppSettings,
  CoachPulseResponse,
  CoachPulseResult,
  CoachPulseStance,
  DailyEntry,
} from "../../domain/types";
import { createEntityId, nowIso } from "../gtd/shared";
import type { AppRepository } from "../storage/repository";
import { buildDailySnapshot, type DailySnapshotInputs } from "./context/daily-snapshot";
import { buildAiInputHash } from "./input-hash";
import {
  buildCloseMemoryIds,
  findDueCommitment,
  resolveCommitment,
} from "./memory/commitment-resolution";
import { resolveDueCommitmentsOnClose, runMemoryLifecycle } from "./memory/lifecycle";
import { retrieveMemories } from "./memory/retrieval";
import { normalizeAiBaseUrl } from "./openrouter-provider";
import { buildLocalCoachPulse } from "./proposals/coach-pulse-fallback";
import { parseCoachPulseJson } from "./proposals/coach-pulse-validator";
import type { AiProvider } from "./provider";

export const COACH_PULSE_PROMPT_VERSION = "coach_pulse.v2";

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

export interface CommitmentResolutionPayload {
  statement: string;
  progressLabel: string;
  met: boolean | null;
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
  baseUrl: normalizeAiBaseUrl(settings.aiBaseUrl),
});

const pulseToBodyText = (pulse: CoachPulseResponse): string =>
  [pulse.headline, pulse.read, pulse.move ? `${pulse.move.what} — ${pulse.move.why}` : null]
    .filter(Boolean)
    .join("\n\n");

const buildCommitmentResolution = (
  commitment: AiMemory | null,
  entry: DailyEntry,
): CommitmentResolutionPayload | null => {
  if (!commitment) {
    return null;
  }

  const resolution = resolveCommitment(commitment, entry);
  return {
    statement: resolution.statement,
    progressLabel: resolution.progressLabel,
    met: resolution.met,
  };
};

const buildProposals = (
  messageId: string,
  pulse: CoachPulseResponse,
  createdAt: string,
): AiProposal[] => {
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
      createdAt,
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
      createdAt,
    });
  }

  if (pulse.stance === "close" && pulse.commitment?.statement?.trim()) {
    proposals.push({
      id: createEntityId("ai-proposal"),
      messageId,
      type: "commitment",
      payloadJson: JSON.stringify({
        statement: pulse.commitment.statement.trim(),
        metricKey: pulse.commitment.metricKey,
        target: pulse.commitment.target,
      }),
      status: "pending",
      appliedEntityId: null,
      decidedAt: null,
      createdAt,
    });
  }

  if (pulse.stance === "close" && pulse.memoryCandidates?.length) {
    for (const candidate of pulse.memoryCandidates) {
      proposals.push({
        id: createEntityId("ai-proposal"),
        messageId,
        type: "memory",
        payloadJson: JSON.stringify({
          kind: candidate.kind,
          statement: candidate.statement,
          confidence: candidate.confidence,
          source: "ai_extracted",
        }),
        status: "pending",
        appliedEntityId: null,
        decidedAt: null,
        createdAt,
      });
    }
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
  message: AiMessage,
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
      source: "cache",
    };
  } catch {
    return null;
  }
};

export class CoachPulseService {
  constructor(private readonly provider: AiProvider) {}

  async resultFromMessage(
    repository: AppRepository,
    message: AiMessage,
  ): Promise<CoachPulseResult | null> {
    return cachedResult(repository, message);
  }

  async buildPulse(
    repository: AppRepository,
    request: CoachPulseRequest,
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
      slotHour,
    } = request;
    const snapshot = buildDailySnapshot(snapshotInputs, settings.aiPayloadScope);
    const scopeKey = buildScopeKey(entry.date, stance, slotHour);
    const createdAt = nowIso();

    await runMemoryLifecycle(repository, entry.date, snapshotInputs.historyEntries, createdAt);
    const activeMemories = await repository.listAiMemories({
      status: "active",
      activeOnDate: entry.date,
    });
    const { block: memoryBlock, selected } = retrieveMemories(activeMemories, settings, {
      stance,
      nowIso: createdAt,
    });
    const dueCommitment = await findDueCommitment(repository, entry.date, stance, activeMemories);
    const commitmentResolution = buildCommitmentResolution(dueCommitment, entry);
    const memoryIds =
      stance === "close"
        ? buildCloseMemoryIds(
            selected.map((memory) => memory.id),
            dueCommitment,
          )
        : selected.map((memory) => memory.id).sort();
    const inputHash = buildAiInputHash({
      promptVersion: COACH_PULSE_PROMPT_VERSION,
      stance,
      scope: settings.aiPayloadScope,
      snapshot,
      config: buildConfigFingerprint(settings),
      memoryIds,
      commitmentResolution,
    });

    const findings = snapshot.findings as Finding[];
    const localPulse = buildLocalCoachPulse(stance, findings, deltaClass ?? undefined, {
      previousDayTomorrowFocus:
        stance === "open" ? snapshotInputs.previousEntry?.tomorrowFocus : undefined,
    });
    const aiConfigured = settings.aiEnabled && settings.aiApiKey.trim().length > 0;
    // Morning open is allowed even on idle/unknown: there is no today-delta yet,
    // and the brief is anchored on yesterday. Other stances stay gated.
    const openIgnoresDeltaGate =
      stance === "open" && (deltaClass === "idle" || deltaClass === "unknown");
    const autoMayCallProvider =
      trigger === "auto" &&
      (deltaClass === null ||
        deltaClass === "progress" ||
        deltaClass === "stall" ||
        openIgnoresDeltaGate);
    const shouldCallProvider =
      !localOnly && aiConfigured && (trigger === "explicit" || autoMayCallProvider);
    const result = await runStructuredSurface({
      repository,
      provider: this.provider,
      settings,
      surface: "coach_pulse",
      scopeKey,
      stance,
      kind: stance,
      deltaClass,
      promptVersion: COACH_PULSE_PROMPT_VERSION,
      inputHash,
      createdAt,
      bypassCache,
      cachePolicy: "ok-only",
      shouldCallProvider,
      persistLocal: trigger === "explicit" || deltaClass !== null,
      localFallback: localPulse,
      toBodyText: pulseToBodyText,
      parse: (text) => parseCoachPulseJson(text, stance),
      request: (repairHint) => ({
        surface: "coach_pulse",
        stance,
        settings,
        snapshot,
        memoryBlock,
        commitmentResolution,
        repairHint,
      }),
      buildProposals,
      cachedResult: async (message) => {
        const cached = await cachedResult(repository, message);
        return cached ? { response: cached.pulse, proposals: cached.proposals } : null;
      },
      finalize:
        stance === "close"
          ? async () => {
              await resolveDueCommitmentsOnClose(repository, entry.date, entry, createdAt);
            }
          : undefined,
    });
    return {
      message: result.message,
      pulse: result.response,
      proposals: result.proposals,
      source: result.source,
      warning: result.warning,
    };
  }
}
