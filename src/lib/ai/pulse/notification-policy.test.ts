import { defaultAppSettings } from "../../../domain/daily-entry";
import type { AiMessage } from "../../../domain/types";
import { evaluatePulseNotification } from "./notification-policy";

const baseSettings = defaultAppSettings();

const buildMessage = (partial: Partial<AiMessage>): AiMessage => ({
  id: "ai-message:test",
  surface: "coach_pulse",
  scopeKey: "2026-08-29",
  stance: "steer",
  kind: "steer",
  inputHash: "hash",
  promptVersion: "coach_pulse.v1",
  model: "local",
  status: "ok",
  bodyJson: null,
  bodyText: null,
  deltaClass: "stall",
  notified: false,
  tokensPrompt: null,
  tokensCompletion: null,
  latencyMs: null,
  createdAt: "2026-08-29T13:00:00.000Z",
  ...partial,
});

describe("notification-policy", () => {
  it("is silent on the first stall", () => {
    const decision = evaluatePulseNotification({
      settings: baseSettings,
      deltaClass: "stall",
      nowIso: "2026-08-29T14:00:00",
      dayOfWeek: 5,
      todayMessages: [],
      focusSessionActive: false,
    });

    expect(decision.shouldNotify).toBe(false);
    expect(decision.reason).toBe("first_stall_silent");
  });

  it("notifies on the second consecutive stall on a weekday", () => {
    const decision = evaluatePulseNotification({
      settings: baseSettings,
      deltaClass: "stall",
      nowIso: "2026-08-29T20:00:00",
      dayOfWeek: 5,
      todayMessages: [buildMessage({ scopeKey: "2026-08-29#13", deltaClass: "stall" })],
      focusSessionActive: false,
    });

    expect(decision.shouldNotify).toBe(true);
    expect(decision.reason).toBe("second_consecutive_stall");
  });

  it("respects the daily notification cap", () => {
    const decision = evaluatePulseNotification({
      settings: { ...baseSettings, aiPulseMaxNotificationsPerDay: 1 },
      deltaClass: "stall",
      nowIso: "2026-08-29T20:00:00",
      dayOfWeek: 5,
      todayMessages: [
        buildMessage({ scopeKey: "2026-08-29#13", deltaClass: "stall", notified: true }),
        buildMessage({ scopeKey: "2026-08-29#13", id: "ai-message:prev", deltaClass: "stall" }),
      ],
      focusSessionActive: false,
    });

    expect(decision.shouldNotify).toBe(false);
    expect(decision.reason).toBe("daily_cap");
  });

  it("suppresses notifications outside configured weekdays", () => {
    const decision = evaluatePulseNotification({
      settings: { ...baseSettings, aiPulseNotifyDays: [1, 2, 3, 4, 5] },
      deltaClass: "stall",
      nowIso: "2026-08-29T20:00:00",
      dayOfWeek: 6,
      todayMessages: [buildMessage({ deltaClass: "stall" })],
      focusSessionActive: false,
    });

    expect(decision.shouldNotify).toBe(false);
    expect(decision.reason).toBe("weekend_suppressed");
  });

  it("suppresses notifications during an active focus session", () => {
    const decision = evaluatePulseNotification({
      settings: baseSettings,
      deltaClass: "stall",
      nowIso: "2026-08-29T20:00:00",
      dayOfWeek: 5,
      todayMessages: [buildMessage({ deltaClass: "stall" })],
      focusSessionActive: true,
    });

    expect(decision.shouldNotify).toBe(false);
    expect(decision.reason).toBe("pomodoro_active");
  });
});
