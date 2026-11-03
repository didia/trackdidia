import type { SettingsUpdater } from "../../../domain/settings";
import { createEmptyDailyEntry } from "../../../domain/daily-entry";
import type { AppOpenInterval } from "../../../domain/insights/movement";
import type {
  AiMessage,
  AppSettings,
  CoachPulseResult,
  CoachPulseStance,
} from "../../../domain/types";
import { t } from "../../../i18n";
import { createEntityId, nowIso } from "../../gtd/shared";
import { toLocalDateString } from "../../date";
import { notifyPomodoroCompletion } from "../../pomodoro/sound";
import type { AppRepository } from "../../storage/repository";
import type { CoachPulseService } from "../coach-pulse-service";
import { COACH_PULSE_PROMPT_VERSION } from "../coach-pulse-service";
import { resolveDailySnapshotInputs } from "../context/preview";
import { buildLocalCoachPulse, buildLocalUnknownPulse } from "../proposals/coach-pulse-fallback";
import { classifyPulseWindow } from "./delta-gate";
import { evaluatePulseNotification } from "./notification-policy";
import { buildPulseScopeKey, type ResolvedPulseSlot, resolvePulseSlots } from "./slot-resolution";

export interface PulseEngineContext {
  repository: AppRepository;
  coachService: CoachPulseService;
  settings: AppSettings;
  updateSettings: (updater: SettingsUpdater) => Promise<AppSettings>;
  nowIso?: string;
  appOpenIntervals: AppOpenInterval[];
  focusSessionActive: boolean;
  isAuthorized?: () => Promise<boolean>;
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
  createdAt: string,
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
    createdAt,
  };

  await repository.saveAiMessage(message);
};

const recordLocalPulse = async (
  repository: AppRepository,
  slot: ResolvedPulseSlot,
  _settings: AppSettings,
  deltaClass: AiMessage["deltaClass"],
  pulseBody: ReturnType<typeof buildLocalCoachPulse>,
  createdAt: string,
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
    createdAt,
  };

  const saved = await repository.saveAiMessage(message);
  return {
    message: saved,
    pulse: pulseBody,
    proposals: [],
    source: "local",
  };
};

export const ensureFirstOpenRecorded = async (
  settings: AppSettings,
  date: string,
  nowIso: string,
  updateSettings: (updater: SettingsUpdater) => Promise<AppSettings>,
): Promise<AppSettings> => {
  if (settings.aiPulseFirstOpenAt[date]) {
    return settings;
  }

  return updateSettings((current) =>
    current.aiPulseFirstOpenAt[date]
      ? current
      : {
          ...current,
          aiPulseFirstOpenAt: { ...current.aiPulseFirstOpenAt, [date]: nowIso },
        },
  );
};

/**
 * Evaluate catch-up pulse slots for today (spec §6.2).
 */
export const runPulseEngine = async (context: PulseEngineContext): Promise<PulseEngineResult> => {
  const authorized =
    context.isAuthorized ??
    (async () => (await context.repository.getSettings()).syncProfile === "personal");
  const ensureAuthorized = async () => {
    if (!(await authorized())) throw new Error("Pulse evaluation cancelled");
  };
  if (!context.settings.aiPulseEnabled || !(await authorized())) {
    return { ranSlot: null, result: null, recordedMissed: 0 };
  }

  const atIso = context.nowIso ?? nowIso();
  const date = toLocalDateString(atIso);
  const dayOfWeek = new Date(atIso).getDay();

  const settings = await ensureFirstOpenRecorded(context.settings, date, atIso, async (updater) => {
    await ensureAuthorized();
    return context.updateSettings((current) =>
      current.syncProfile === "personal" ? updater(current) : current,
    );
  });
  const todayMessages = await context.repository.listAiMessagesForDate(date);
  const processedScopeKeys = processedScopeKeysFromMessages(todayMessages);

  const { dueSlot, missedSlots } = resolvePulseSlots({
    date,
    nowIso: atIso,
    slotHours: settings.aiPulseSlots,
    firstOpenAtIso: settings.aiPulseFirstOpenAt[date] ?? null,
    processedScopeKeys,
  });

  let recordedMissed = 0;
  for (const missed of missedSlots) {
    if (!processedScopeKeys.has(missed.scopeKey)) {
      await ensureAuthorized();
      await recordMissedSlot(context.repository, missed, atIso);
      processedScopeKeys.add(missed.scopeKey);
      recordedMissed += 1;
    }
  }

  let messagesForNotification = todayMessages;
  if (recordedMissed > 0) {
    messagesForNotification = await context.repository.listAiMessagesForDate(date);
  }

  if (!dueSlot) {
    return { ranSlot: null, result: null, recordedMissed: missedSlots.length };
  }

  const entry = (await context.repository.getDailyEntry(date)) ?? createEmptyDailyEntry(date);
  const sinceIso = lastPulseTimestamp(todayMessages, date);
  const [focusSessions, tasks] = await Promise.all([
    context.repository.listPomodoroSessions(date),
    context.repository.listTasks({ includeCompleted: true }),
  ]);

  const window = classifyPulseWindow({
    sinceIso,
    nowIso: atIso,
    focusSessions,
    tasks,
    appOpenIntervals: context.appOpenIntervals,
    dayOfWeek,
  });

  // Morning `open` always reaches the model when AI is configured, even with no
  // movement yet — the brief is anchored on yesterday, not today's delta.
  // Midday/evening slots stay gated.
  if (
    (window.deltaClass === "idle" || window.deltaClass === "unknown") &&
    dueSlot.stance !== "open"
  ) {
    const localPulse =
      window.deltaClass === "unknown"
        ? buildLocalUnknownPulse(dueSlot.stance)
        : buildLocalCoachPulse(dueSlot.stance, [], window.deltaClass);

    await ensureAuthorized();
    const result = await recordLocalPulse(
      context.repository,
      dueSlot,
      settings,
      window.deltaClass,
      localPulse,
      atIso,
    );

    return { ranSlot: dueSlot, result, recordedMissed: missedSlots.length };
  }

  const snapshotInputs = await resolveDailySnapshotInputs(context.repository, date);

  await ensureAuthorized();
  const guardedRepository = new Proxy(context.repository, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (typeof property === "string" && /^(save|archive|delete|update|create)/.test(property)) {
        return async (...args: unknown[]) => {
          await ensureAuthorized();
          return value.apply(target, args);
        };
      }
      return value.bind(target);
    },
  });
  const result = await context.coachService.buildPulse(guardedRepository, {
    stance: dueSlot.stance as CoachPulseStance,
    entry,
    settings,
    snapshotInputs,
    trigger: "auto",
    deltaClass: window.deltaClass,
    slotHour: dueSlot.hour,
    ensureAuthorized,
  });

  const notification = evaluatePulseNotification({
    settings,
    deltaClass: window.deltaClass,
    nowIso: atIso,
    dayOfWeek,
    todayMessages: messagesForNotification,
    focusSessionActive: context.focusSessionActive,
  });

  if (notification.shouldNotify) {
    await ensureAuthorized();
    const notified = await notifyPomodoroCompletion(
      t("coachDayPaused", { ns: "notifications" }),
      result.pulse.headline,
    );

    if (notified) {
      await ensureAuthorized();
      await context.repository.saveAiMessage({
        ...result.message,
        notified: true,
      });
      result.message.notified = true;
    }
  }

  return { ranSlot: dueSlot, result, recordedMissed: missedSlots.length };
};

export { buildPulseScopeKey };
