import type { AppOpenInterval } from "../../../domain/insights/movement";
import type { AiMessage, AppSettings, CoachPulseResult, CoachPulseStance } from "../../../domain/types";
import { createEmptyDailyEntry } from "../../../domain/daily-entry";
import { createEntityId, nowIso, toLocalDateString } from "../../gtd/shared";
import type { AppRepository } from "../../storage/repository";
import { notifyPomodoroCompletion } from "../../pomodoro/sound";
import type { CoachPulseService } from "../coach-pulse-service";
import { COACH_PULSE_PROMPT_VERSION } from "../coach-pulse-service";
import { resolveDailySnapshotInputs } from "../context/preview";
import { buildLocalCoachPulse, buildLocalUnknownPulse } from "../proposals/coach-pulse-fallback";
import { classifyPulseWindow } from "./delta-gate";
import { evaluatePulseNotification } from "./notification-policy";
import { buildPulseScopeKey, resolvePulseSlots, type ResolvedPulseSlot } from "./slot-resolution";

export interface PulseEngineContext {
  repository: AppRepository;
  coachService: CoachPulseService;
  settings: AppSettings;
  saveSettings: (settings: AppSettings) => Promise<void>;
  nowIso?: string;
  appOpenIntervals: AppOpenInterval[];
  focusSessionActive: boolean;
}

export interface PulseEngineResult {
  ranSlot: ResolvedPulseSlot | null;
  result: CoachPulseResult | null;
  recordedMissed: number;
}

const pulseToBodyText = (headline: string, read: string): string => `${headline}\n\n${read}`;

const processedScopeKeysFromMessages = (messages: AiMessage[]): Set<string> =>
  new Set(messages.map((message) => message.scopeKey));

const lastPulseTimestamp = (messages: AiMessage[], date: string): string => {
  const scheduled = messages
    .filter((message) => message.stance && message.stance !== "close")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

  if (scheduled.length > 0) {
    return scheduled[0].createdAt;
  }

  return `${date}T00:00:00.000`;
};

const recordMissedSlot = async (
  repository: AppRepository,
  slot: ResolvedPulseSlot,
  createdAt: string
): Promise<void> => {
  const message: AiMessage = {
    id: createEntityId("ai-message"),
    surface: "coach_pulse",
    scopeKey: slot.scopeKey,
    stance: slot.stance,
    kind: slot.stance,
    inputHash: `missed:${slot.scopeKey}`,
    promptVersion: COACH_PULSE_PROMPT_VERSION,
    model: "local",
    status: "skipped",
    bodyJson: null,
    bodyText: null,
    deltaClass: "idle",
    notified: false,
    tokensPrompt: null,
    tokensCompletion: null,
    latencyMs: null,
    createdAt
  };

  await repository.saveAiMessage(message);
};

const recordLocalPulse = async (
  repository: AppRepository,
  slot: ResolvedPulseSlot,
  settings: AppSettings,
  deltaClass: AiMessage["deltaClass"],
  pulseBody: ReturnType<typeof buildLocalCoachPulse>,
  createdAt: string
): Promise<CoachPulseResult> => {
  const message: AiMessage = {
    id: createEntityId("ai-message"),
    surface: "coach_pulse",
    scopeKey: slot.scopeKey,
    stance: slot.stance,
    kind: slot.stance,
    inputHash: `local:${slot.scopeKey}:${deltaClass}`,
    promptVersion: COACH_PULSE_PROMPT_VERSION,
    model: "local",
    status: "skipped",
    bodyJson: JSON.stringify(pulseBody),
    bodyText: pulseToBodyText(pulseBody.headline, pulseBody.read),
    deltaClass,
    notified: false,
    tokensPrompt: null,
    tokensCompletion: null,
    latencyMs: null,
    createdAt
  };

  const saved = await repository.saveAiMessage(message);
  return {
    message: saved,
    pulse: pulseBody,
    proposals: [],
    source: "local"
  };
};

export const ensureFirstOpenRecorded = async (
  settings: AppSettings,
  date: string,
  nowIso: string,
  saveSettings: (settings: AppSettings) => Promise<void>
): Promise<AppSettings> => {
  if (settings.aiPulseFirstOpenAt[date]) {
    return settings;
  }

  const nextSettings: AppSettings = {
    ...settings,
    aiPulseFirstOpenAt: {
      ...settings.aiPulseFirstOpenAt,
      [date]: nowIso
    }
  };

  await saveSettings(nextSettings);
  return nextSettings;
};

/**
 * Evaluate catch-up pulse slots for today (spec §6.2).
 */
export const runPulseEngine = async (context: PulseEngineContext): Promise<PulseEngineResult> => {
  if (!context.settings.aiPulseEnabled) {
    return { ranSlot: null, result: null, recordedMissed: 0 };
  }

  const atIso = context.nowIso ?? nowIso();
  const date = toLocalDateString(atIso);
  const dayOfWeek = new Date(atIso).getDay();

  const settings = await ensureFirstOpenRecorded(context.settings, date, atIso, context.saveSettings);
  const todayMessages = await context.repository.listAiMessagesForDate(date);
  const processedScopeKeys = processedScopeKeysFromMessages(todayMessages);

  const { dueSlot, missedSlots } = resolvePulseSlots({
    date,
    nowIso: atIso,
    slotHours: settings.aiPulseSlots,
    firstOpenAtIso: settings.aiPulseFirstOpenAt[date] ?? null,
    processedScopeKeys
  });

  for (const missed of missedSlots) {
    if (!processedScopeKeys.has(missed.scopeKey)) {
      await recordMissedSlot(context.repository, missed, atIso);
      processedScopeKeys.add(missed.scopeKey);
    }
  }

  if (!dueSlot) {
    return { ranSlot: null, result: null, recordedMissed: missedSlots.length };
  }

  const entry = (await context.repository.getDailyEntry(date)) ?? createEmptyDailyEntry(date);
  const sinceIso = lastPulseTimestamp(todayMessages, date);
  const [focusSessions, tasks] = await Promise.all([
    context.repository.listPomodoroSessions(date),
    context.repository.listTasks()
  ]);

  const window = classifyPulseWindow({
    sinceIso,
    nowIso: atIso,
    focusSessions,
    tasks,
    appOpenIntervals: context.appOpenIntervals,
    dayOfWeek
  });

  const snapshotInputs = await resolveDailySnapshotInputs(context.repository, date);

  if (window.deltaClass === "idle" || window.deltaClass === "unknown") {
    const localPulse =
      window.deltaClass === "unknown"
        ? buildLocalUnknownPulse(dueSlot.stance)
        : buildLocalCoachPulse(dueSlot.stance, [], window.deltaClass);

    const result = await recordLocalPulse(
      context.repository,
      dueSlot,
      settings,
      window.deltaClass,
      localPulse,
      atIso
    );

    return { ranSlot: dueSlot, result, recordedMissed: missedSlots.length };
  }

  const result = await context.coachService.buildPulse(context.repository, {
    stance: dueSlot.stance as CoachPulseStance,
    entry,
    settings,
    snapshotInputs,
    trigger: "auto",
    deltaClass: window.deltaClass,
    slotHour: dueSlot.hour
  });

  const notification = evaluatePulseNotification({
    settings,
    deltaClass: window.deltaClass,
    nowIso: atIso,
    dayOfWeek,
    todayMessages,
    focusSessionActive: context.focusSessionActive
  });

  if (notification.shouldNotify) {
    const notified = await notifyPomodoroCompletion(
      "Coach — journee en pause",
      result.pulse.headline
    );

    if (notified) {
      await context.repository.saveAiMessage({
        ...result.message,
        notified: true
      });
      result.message.notified = true;
    }
  }

  return { ranSlot: dueSlot, result, recordedMissed: missedSlots.length };
};

export { buildPulseScopeKey };
