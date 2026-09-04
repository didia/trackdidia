import type { AiDeltaClass, AiMessage, AppSettings } from "../../../domain/types";

export interface PulseNotificationContext {
  settings: AppSettings;
  deltaClass: AiDeltaClass;
  nowIso: string;
  dayOfWeek: number;
  todayMessages: AiMessage[];
  focusSessionActive: boolean;
}

export interface PulseNotificationDecision {
  shouldNotify: boolean;
  reason: string;
}

const isWeekend = (dayOfWeek: number): boolean => dayOfWeek === 0 || dayOfWeek === 6;

const countNotificationsToday = (messages: AiMessage[]): number =>
  messages.filter((message) => message.notified).length;

const lastTwoScheduledStances = (messages: AiMessage[]): AiDeltaClass[] =>
  messages
    .filter((message) => message.stance && message.stance !== "close")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, 2)
    .map((message) => message.deltaClass)
    .filter((value): value is AiDeltaClass => value !== null);

/**
 * Deterministic OS notification policy (spec §6.4).
 * Silent by default; second consecutive stall on configured weekdays only.
 */
export const evaluatePulseNotification = (
  context: PulseNotificationContext,
): PulseNotificationDecision => {
  if (!context.settings.aiPulseNotifyEnabled) {
    return { shouldNotify: false, reason: "notifications_disabled" };
  }

  if (isWeekend(context.dayOfWeek)) {
    return { shouldNotify: false, reason: "weekend_suppressed" };
  }

  if (!context.settings.aiPulseNotifyDays.includes(context.dayOfWeek)) {
    return { shouldNotify: false, reason: "outside_notify_days" };
  }

  if (context.focusSessionActive) {
    return { shouldNotify: false, reason: "pomodoro_active" };
  }

  if (context.deltaClass !== "stall") {
    return { shouldNotify: false, reason: "not_stall" };
  }

  const notifiedCount = countNotificationsToday(context.todayMessages);
  if (notifiedCount >= context.settings.aiPulseMaxNotificationsPerDay) {
    return { shouldNotify: false, reason: "daily_cap" };
  }

  const recentClasses = lastTwoScheduledStances(context.todayMessages);
  const isSecondConsecutiveStall =
    context.deltaClass === "stall" && recentClasses.length >= 1 && recentClasses[0] === "stall";

  if (!isSecondConsecutiveStall) {
    return { shouldNotify: false, reason: "first_stall_silent" };
  }

  return { shouldNotify: true, reason: "second_consecutive_stall" };
};
