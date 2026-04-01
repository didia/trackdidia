import { createEmptyDailyEntry, defaultAppSettings } from "../../domain/daily-entry";
import { AiCoachService } from "./coach-service";

describe("AiCoachService", () => {
  it("falls back to local guidance when AI is disabled", async () => {
    const provider = {
      generate: vi.fn()
    };
    const service = new AiCoachService(provider);
    const settings = defaultAppSettings();
    const entry = createEmptyDailyEntry("2026-03-31");

    const result = await service.buildMessage("morning", entry, [], settings);

    expect(result.source).toBe("local");
    expect(provider.generate).not.toHaveBeenCalled();
  });

  it("falls back gracefully when the provider fails", async () => {
    const provider = {
      generate: vi.fn(async () => {
        throw new Error("boom");
      })
    };
    const service = new AiCoachService(provider);
    const settings = defaultAppSettings();
    settings.aiEnabled = true;
    settings.aiApiKey = "secret";

    const result = await service.buildMessage("evening", createEmptyDailyEntry("2026-03-31"), [], settings);

    expect(result.source).toBe("fallback");
    expect(result.warning).toContain("boom");
  });
});

