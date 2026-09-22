import type {
  AiMessage,
  AppSettings,
  CoachPulseResult,
  CoachPulseStance,
  DailyEntry,
} from "../../domain/types";
import { nowIso } from "../gtd/shared";
import type { AppRepository } from "../storage/repository";
import type { CoachPulseService } from "./coach-pulse-service";
import { resolveDailySnapshotInputs } from "./context/preview";
import { resolveDueCommitmentsOnClose } from "./memory/lifecycle";
import { parseSlotHourFromScopeKey } from "./pulse/slot-resolution";

const latestPulseMessage = (
  messages: AiMessage[],
  predicate: (message: AiMessage) => boolean,
): AiMessage | null => {
  const matches = messages
    .filter((message) => Boolean(message.bodyJson) && predicate(message))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

  return matches[0] ?? null;
};

/** Latest scheduled pulse message for a day (excludes evening `close`). */
export const latestScheduledPulseMessage = (messages: AiMessage[]): AiMessage | null =>
  latestPulseMessage(messages, (message) => Boolean(message.stance && message.stance !== "close"));

/** Latest successful evening `close` pulse for a day. Failed/skipped rows are not reused. */
export const latestClosePulseMessage = (messages: AiMessage[]): AiMessage | null =>
  latestPulseMessage(messages, (message) => message.stance === "close" && message.status === "ok");

export const loadLatestCoachPulseForDate = async (
  repository: AppRepository,
  coachService: CoachPulseService,
  date: string,
): Promise<CoachPulseResult | null> => {
  const messages = await repository.listAiMessagesForDate(date);
  const latest = latestScheduledPulseMessage(messages);

  if (!latest) {
    return null;
  }

  return coachService.resultFromMessage(repository, latest);
};

export const loadLatestClosePulseForDate = async (
  repository: AppRepository,
  coachService: CoachPulseService,
  date: string,
): Promise<CoachPulseResult | null> => {
  const messages = await repository.listAiMessagesForDate(date);
  const latest = latestClosePulseMessage(messages);

  if (!latest) {
    return null;
  }

  return coachService.resultFromMessage(repository, latest);
};

export interface CoachPulseLoaderDeps {
  repository: AppRepository;
  coachService: CoachPulseService;
  settings: AppSettings;
}

export interface PassiveCoachPulseRequest {
  entry: DailyEntry;
  /** `open` covers the morning/scheduled pulse surface; `close` the evening closure. */
  stance: "open" | "close";
  /** Called with each progressively better result (stored, local, then AI). */
  publish: (result: CoachPulseResult) => void;
  /** Checked after every await; when false the loader stops without publishing. */
  isCurrent: () => boolean;
}

const aiConfigured = (settings: AppSettings) =>
  settings.aiEnabled && settings.aiApiKey.trim().length > 0;

/**
 * Passive (on page open) coach loading: stored pulse, else a local brief, else AI.
 * - open: a stored pulse wins and stops; otherwise a local brief is published and, unless
 *   the pulse engine owns persistence (`aiPulseEnabled`) or AI is not configured, the AI
 *   pulse replaces it.
 * - close: resolves due commitments, publishes any stored close pulse, then (AI configured)
 *   hash-checks/refreshes through the AI, or (not configured) builds a local brief when
 *   nothing is stored.
 * Errors propagate to the caller.
 */
export const loadPassiveCoachPulse = async (
  { repository, coachService, settings }: CoachPulseLoaderDeps,
  { entry, stance, publish, isCurrent }: PassiveCoachPulseRequest,
): Promise<void> => {
  if (stance === "close") {
    await resolveDueCommitmentsOnClose(repository, entry.date, entry, nowIso());

    const stored = await loadLatestClosePulseForDate(repository, coachService, entry.date);
    if (!isCurrent()) {
      return;
    }
    if (stored) {
      publish(stored);
    }

    const snapshotInputs = await resolveDailySnapshotInputs(repository, entry.date, {
      skipRescueTimeFetch: true,
    });
    if (!isCurrent()) {
      return;
    }

    if (!aiConfigured(settings)) {
      if (!stored) {
        const localResult = await coachService.buildPulse(repository, {
          stance: "close",
          entry,
          settings,
          snapshotInputs,
          trigger: "auto",
          localOnly: true,
        });
        if (isCurrent()) {
          publish(localResult);
        }
      }
      return;
    }

    const aiResult = await coachService.buildPulse(repository, {
      stance: "close",
      entry,
      settings,
      snapshotInputs,
      trigger: "auto",
    });
    if (isCurrent()) {
      publish(aiResult);
    }
    return;
  }

  const stored = await loadLatestCoachPulseForDate(repository, coachService, entry.date);
  if (!isCurrent()) {
    return;
  }
  if (stored) {
    publish(stored);
    return;
  }

  const fastInputs = await resolveDailySnapshotInputs(repository, entry.date, {
    skipRescueTimeFetch: true,
    entry,
  });
  const localResult = await coachService.buildPulse(repository, {
    stance: "open",
    entry,
    settings,
    snapshotInputs: fastInputs,
    trigger: "auto",
    localOnly: true,
  });
  if (!isCurrent()) {
    return;
  }
  publish(localResult);

  // Scheduled pulses own persistence when the pulse engine is enabled.
  if (settings.aiPulseEnabled || !aiConfigured(settings)) {
    return;
  }

  const fullInputs = await resolveDailySnapshotInputs(repository, entry.date, { entry });
  const aiResult = await coachService.buildPulse(repository, {
    stance: "open",
    entry,
    settings,
    snapshotInputs: fullInputs,
    trigger: "auto",
  });
  if (isCurrent()) {
    publish(aiResult);
  }
};

export interface ExplicitCoachPulseRequest {
  entry: DailyEntry;
  stance: "open" | "close";
  trigger: "auto" | "explicit";
  bypassCache?: boolean;
  skipRescueTimeFetch?: boolean;
  /** Open-stance only: overrides the stance of the latest stored pulse. */
  pulseStance?: CoachPulseStance;
  slotHour?: number;
}

/**
 * Explicit refresh. On the open surface the stance and slot default to the latest stored
 * scheduled pulse so a refresh keeps its slot; the close surface always uses `close`.
 */
export const refreshCoachPulse = async (
  { repository, coachService, settings }: CoachPulseLoaderDeps,
  request: ExplicitCoachPulseRequest,
): Promise<CoachPulseResult> => {
  const { entry } = request;

  if (request.stance === "close") {
    const snapshotInputs = await resolveDailySnapshotInputs(repository, entry.date);
    return coachService.buildPulse(repository, {
      stance: "close",
      entry,
      settings,
      snapshotInputs,
      trigger: request.trigger,
      bypassCache: request.bypassCache ?? false,
    });
  }

  const snapshotInputs = await resolveDailySnapshotInputs(repository, entry.date, {
    skipRescueTimeFetch: request.skipRescueTimeFetch ?? false,
    entry,
  });
  const latest = await loadLatestCoachPulseForDate(repository, coachService, entry.date);
  const stance = request.pulseStance ?? latest?.pulse.stance ?? "open";
  const slotHour =
    request.slotHour ?? (latest ? parseSlotHourFromScopeKey(latest.message.scopeKey) : undefined);

  return coachService.buildPulse(repository, {
    stance,
    entry,
    settings,
    snapshotInputs,
    trigger: request.trigger,
    bypassCache: request.bypassCache ?? false,
    slotHour,
  });
};
