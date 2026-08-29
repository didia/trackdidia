import { defaultAppSettings } from "../../../domain/daily-entry";
import { toLocalDateString } from "../../gtd/shared";
import { MemoryRepository } from "../../storage/memory-repository";
import { CoachPulseService } from "../coach-pulse-service";
import type { AiProvider } from "../provider";
import { runPulseEngine } from "./pulse-engine";

const weekday = "2026-08-28"; // Friday

describe("pulse-engine integration", () => {
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
