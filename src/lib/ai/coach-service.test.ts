import { createEmptyDailyEntry, defaultAppSettings, updateNote } from "../../domain/daily-entry";
import { AiCoachService } from "./coach-service";
import {
  buildCoachCacheKey,
  getCoachInputText,
  resolveCoachCachePartOfDay,
  resolvePartOfDay
} from "./coach-input";

describe("coach-input", () => {
  it("builds cache keys from date, part of day, and input content", () => {
    expect(buildCoachCacheKey("2026-07-29", "morning", "Rester net")).toBe(
      "2026-07-29|morning|Rester net"
    );
  });

  it("resolves part of day from local hour", () => {
    expect(resolvePartOfDay(new Date(2026, 6, 29, 8))).toBe("morning");
    expect(resolvePartOfDay(new Date(2026, 6, 29, 14))).toBe("afternoon");
    expect(resolvePartOfDay(new Date(2026, 6, 29, 20))).toBe("evening");
  });

  it("maps morning coach cache part to morning or afternoon", () => {
    expect(resolveCoachCachePartOfDay("morning", new Date(2026, 6, 29, 8))).toBe("morning");
    expect(resolveCoachCachePartOfDay("morning", new Date(2026, 6, 29, 14))).toBe("afternoon");
    expect(resolveCoachCachePartOfDay("morning", new Date(2026, 6, 29, 20))).toBe("morning");
    expect(resolveCoachCachePartOfDay("evening", new Date(2026, 6, 29, 14))).toBe("evening");
  });

  it("reads morning intention and evening notes as coach input", () => {
    let entry = createEmptyDailyEntry("2026-07-29");
    entry = updateNote(entry, "morningIntention", "  Focus  ");
    entry = updateNote(entry, "nightReflection", "Bien");
    entry = updateNote(entry, "tomorrowFocus", "Dormir tot");

    expect(getCoachInputText(entry, "morning")).toBe("Focus");
    expect(getCoachInputText(entry, "afternoon")).toBe("Focus");
    expect(getCoachInputText(entry, "evening")).toBe("Bien\n\nDormir tot");
  });
});

describe("AiCoachService", () => {
  it("falls back to local guidance when AI is disabled", async () => {
    const provider = {
      generate: vi.fn()
    };
    const service = new AiCoachService(provider);
    const settings = defaultAppSettings();
    const entry = updateNote(createEmptyDailyEntry("2026-03-31"), "morningIntention", "Aller droit");

    const result = await service.buildMessage("morning", entry, [], settings);

    expect(result.source).toBe("local");
    expect(provider.generate).not.toHaveBeenCalled();
  });

  it("does not call the provider when coach input is empty", async () => {
    const provider = {
      generate: vi.fn(async () => "should not run")
    };
    const service = new AiCoachService(provider);
    const settings = defaultAppSettings();
    settings.aiEnabled = true;
    settings.aiApiKey = "secret";

    const result = await service.buildMessage(
      "morning",
      createEmptyDailyEntry("2026-03-31"),
      [],
      settings
    );

    expect(result.source).toBe("local");
    expect(provider.generate).not.toHaveBeenCalled();
  });

  it("caches AI responses for the same date, part of day, and input", async () => {
    const provider = {
      generate: vi.fn(async () => "Conseil IA")
    };
    const service = new AiCoachService(provider);
    const settings = defaultAppSettings();
    settings.aiEnabled = true;
    settings.aiApiKey = "secret";
    const entry = updateNote(createEmptyDailyEntry("2026-03-31"), "morningIntention", "Rester calme");

    const first = await service.buildMessage("morning", entry, [], settings);
    const second = await service.buildMessage("morning", entry, [], settings);

    expect(first.source).toBe("ai");
    expect(second.body).toBe("Conseil IA");
    expect(provider.generate).toHaveBeenCalledOnce();
  });

  it("calls again when the input content changes", async () => {
    const provider = {
      generate: vi.fn(async (_kind, context) => `AI:${context.inputContent}`)
    };
    const service = new AiCoachService(provider);
    const settings = defaultAppSettings();
    settings.aiEnabled = true;
    settings.aiApiKey = "secret";

    const firstEntry = updateNote(createEmptyDailyEntry("2026-03-31"), "morningIntention", "A");
    const secondEntry = updateNote(createEmptyDailyEntry("2026-03-31"), "morningIntention", "B");

    await service.buildMessage("morning", firstEntry, [], settings);
    const second = await service.buildMessage("morning", secondEntry, [], settings);

    expect(provider.generate).toHaveBeenCalledTimes(2);
    expect(second.body).toBe("AI:B");
  });

  it("passes timezone and part of day to the provider", async () => {
    const provider = {
      generate: vi.fn(async () => "ok")
    };
    const service = new AiCoachService(provider);
    const settings = defaultAppSettings();
    settings.aiEnabled = true;
    settings.aiApiKey = "secret";
    const entry = updateNote(createEmptyDailyEntry("2026-03-31"), "morningIntention", "Go");

    await service.buildMessage("morning", entry, [], settings);

    expect(provider.generate).toHaveBeenCalledWith(
      "morning",
      expect.objectContaining({
        timeZone: expect.any(String),
        partOfDay: expect.stringMatching(/^(morning|afternoon)$/),
        currentPartOfDay: expect.stringMatching(/^(morning|afternoon|evening)$/),
        inputContent: "Go"
      })
    );
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
    const entry = updateNote(
      createEmptyDailyEntry("2026-03-31"),
      "nightReflection",
      "Journee difficile"
    );

    const result = await service.buildMessage("evening", entry, [], settings);

    expect(result.source).toBe("fallback");
    expect(result.warning).toContain("boom");
  });
});
