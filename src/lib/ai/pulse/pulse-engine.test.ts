import { defaultAppSettings } from "../../../domain/daily-entry";
import type { AiMessage } from "../../../domain/types";
import { createEntityId, toLocalDateString } from "../../gtd/shared";
import { MemoryRepository } from "../../storage/memory-repository";
import { CoachPulseService } from "../coach-pulse-service";
import type { AiProvider } from "../provider";
import * as preview from "../context/preview";
import { runPulseEngine } from "./pulse-engine";

const { notifyCompletion } = vi.hoisted(() => ({ notifyCompletion: vi.fn(async () => true) }));

vi.mock("../../pomodoro/sound", () => ({
  unlockPomodoroSound: vi.fn(async () => undefined),
  playPomodoroChime: vi.fn(async () => undefined),
  notifyPomodoroCompletion: notifyCompletion,
  resolvePomodoroChimeVariant: vi.fn(() => "focus")
}));

const weekday = "2026-08-28"; // Friday

const longAppOpenInterval = {
  startedAt: `${weekday}T08:00:00.000Z`,
  endedAt: `${weekday}T21:00:00.000Z`
};

describe("pulse-engine integration", () => {
  afterEach(() => {
    notifyCompletion.mockClear();
    vi.restoreAllMocks();
  });

  it("persists idle/unknown pulses without calling the provider", async () => {
    const provider: AiProvider = {
      generateStructured: vi.fn()
    };
    const repository = new MemoryRepository();
    await repository.initialize();
    const coachService = new CoachPulseService(provider);
    const settings = defaultAppSettings();
    settings.aiEnabled = true;
    settings.aiApiKey = "secret";

    const result = await runPulseEngine({
      repository,
      coachService,
      settings,
      saveSettings: async () => undefined,
      nowIso: `${weekday}T16:00:00`,
      appOpenIntervals: [
        {
          startedAt: `${weekday}T16:00:00.000Z`,
          endedAt: `${weekday}T16:10:00.000Z`
        }
      ],
      focusSessionActive: false
    });

    expect(result.ranSlot?.stance).toBe("steer");
    expect(result.result?.source).toBe("local");
    expect(provider.generateStructured).not.toHaveBeenCalled();

    const messages = await repository.listAiMessagesForDate(weekday);
    expect(messages.some((message) => message.scopeKey === weekday && message.deltaClass === "idle")).toBe(true);
    expect(messages.some((message) => message.scopeKey === `${weekday}#13` && message.deltaClass === "unknown")).toBe(
      true
    );
  });

  it("does not fetch daily snapshot inputs on idle/unknown paths", async () => {
    const resolveSpy = vi.spyOn(preview, "resolveDailySnapshotInputs");
    const provider: AiProvider = {
      generateStructured: vi.fn()
    };
    const repository = new MemoryRepository();
    await repository.initialize();
    const coachService = new CoachPulseService(provider);
    const settings = defaultAppSettings();
    settings.aiEnabled = true;
    settings.aiApiKey = "secret";
    settings.rescuetimeApiKey = "rt-key";

    await runPulseEngine({
      repository,
      coachService,
      settings,
      saveSettings: async () => undefined,
      nowIso: `${weekday}T16:00:00`,
      appOpenIntervals: [
        {
          startedAt: `${weekday}T16:00:00.000Z`,
          endedAt: `${weekday}T16:10:00.000Z`
        }
      ],
      focusSessionActive: false
    });

    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it("classifies a completed task as progress even when listTasks excludes completed by default", async () => {
    const provider: AiProvider = {
      generateStructured: vi.fn(async () => ({
        text: JSON.stringify({
          stance: "steer",
          headline: "Relance",
          read: "Signal",
          move: null
        }),
        model: "test-model",
        usage: { tokensPrompt: 1, tokensCompletion: 1, latencyMs: 1 }
      }))
    };
    const repository = new MemoryRepository();
    await repository.initialize();
    const coachService = new CoachPulseService(provider);

    const task = await repository.createTask({
      title: "Terminer le rapport",
      bucket: "next_action"
    });
    await repository.completeTask(task.id, `${weekday}T15:30:00.000Z`);

    const settings = defaultAppSettings();
    settings.aiEnabled = true;
    settings.aiApiKey = "secret";

    const result = await runPulseEngine({
      repository,
      coachService,
      settings: {
        ...settings,
        aiPulseFirstOpenAt: { [weekday]: `${weekday}T08:00:00.000Z` }
      },
      saveSettings: async () => undefined,
      nowIso: `${weekday}T16:00:00`,
      appOpenIntervals: [longAppOpenInterval],
      focusSessionActive: false
    });

    expect(result.ranSlot?.stance).toBe("steer");
    expect(provider.generateStructured).toHaveBeenCalled();
    expect(result.result?.message.deltaClass).toBe("progress");
  });

  it("calls the provider on auto progress/stall when AI is configured", async () => {
    const provider: AiProvider = {
      generateStructured: vi.fn(async () => ({
        text: JSON.stringify({
          stance: "steer",
          headline: "Relance",
          read: "Signal",
          move: null
        }),
        model: "test-model",
        usage: { tokensPrompt: 1, tokensCompletion: 1, latencyMs: 1 }
      }))
    };
    const repository = new MemoryRepository();
    await repository.initialize();
    const coachService = new CoachPulseService(provider);

    const settings = defaultAppSettings();
    settings.aiEnabled = true;
    settings.aiApiKey = "secret";

    const result = await runPulseEngine({
      repository,
      coachService,
      settings: {
        ...settings,
        aiPulseFirstOpenAt: { [weekday]: `${weekday}T16:00:00.000Z` }
      },
      saveSettings: async () => undefined,
      nowIso: `${weekday}T16:00:00`,
      appOpenIntervals: [
        {
          startedAt: `${weekday}T08:00:00.000Z`,
          endedAt: `${weekday}T16:00:00.000Z`
        }
      ],
      focusSessionActive: false
    });

    expect(result.ranSlot?.stance).toBe("steer");
    expect(provider.generateStructured).toHaveBeenCalled();
  });

  it("does not notify on wind-down stall when an intervening slot was missed as idle", async () => {
    const provider: AiProvider = {
      generateStructured: vi.fn(async () => ({
        text: JSON.stringify({
          stance: "wind_down",
          headline: "Pause",
          read: "Signal",
          move: null
        }),
        model: "test-model",
        usage: { tokensPrompt: 1, tokensCompletion: 1, latencyMs: 1 }
      }))
    };
    const repository = new MemoryRepository();
    await repository.initialize();
    const coachService = new CoachPulseService(provider);

    const openStall: AiMessage = {
      id: createEntityId("ai-message"),
      surface: "coach_pulse",
      scopeKey: weekday,
      stance: "open",
      kind: "open",
      inputHash: "seed:open",
      promptVersion: "coach_pulse.v1",
      model: "test-model",
      status: "ok",
      bodyJson: null,
      bodyText: "Stall matinal",
      deltaClass: "stall",
      notified: false,
      tokensPrompt: null,
      tokensCompletion: null,
      latencyMs: null,
      createdAt: `${weekday}T08:30:00.000Z`
    };
    await repository.saveAiMessage(openStall);

    const settings = defaultAppSettings();
    settings.aiEnabled = true;
    settings.aiApiKey = "secret";
    settings.aiPulseNotifyEnabled = true;

    const result = await runPulseEngine({
      repository,
      coachService,
      settings: {
        ...settings,
        aiPulseFirstOpenAt: { [weekday]: `${weekday}T08:00:00.000Z` }
      },
      saveSettings: async () => undefined,
      nowIso: `${weekday}T21:00:00`,
      appOpenIntervals: [longAppOpenInterval],
      focusSessionActive: false
    });

    expect(result.ranSlot?.stance).toBe("wind_down");
    expect(result.result?.message.deltaClass).toBe("stall");

    const messages = await repository.listAiMessagesForDate(weekday);
    expect(messages.some((message) => message.scopeKey === `${weekday}#13` && message.deltaClass === "idle")).toBe(true);
    expect(notifyCompletion).not.toHaveBeenCalled();
    expect(result.result?.message.notified).toBe(false);
  });

  it("uses the local calendar day when UTC date prefix differs", async () => {
    const atIso = new Date(2026, 7, 29, 20, 30).toISOString();
    const localDate = toLocalDateString(atIso);

    expect(localDate).toBe("2026-08-29");
    if (atIso.slice(0, 10) !== localDate) {
      expect(atIso.slice(0, 10)).toBe("2026-08-30");
    }

    const provider: AiProvider = {
      generateStructured: vi.fn()
    };
    const repository = new MemoryRepository();
    await repository.initialize();
    const coachService = new CoachPulseService(provider);
    const settings = defaultAppSettings();
    let savedSettings = settings;

    await runPulseEngine({
      repository,
      coachService,
      settings,
      saveSettings: async (nextSettings) => {
        savedSettings = nextSettings;
      },
      nowIso: atIso,
      appOpenIntervals: [{ startedAt: atIso, endedAt: atIso }],
      focusSessionActive: false
    });

    expect(savedSettings.aiPulseFirstOpenAt[localDate]).toBe(atIso);
    expect(savedSettings.aiPulseFirstOpenAt["2026-08-30"]).toBeUndefined();
    await expect(repository.listAiMessagesForDate(localDate)).resolves.not.toHaveLength(0);
    await expect(repository.listAiMessagesForDate("2026-08-30")).resolves.toHaveLength(0);
  });
});
