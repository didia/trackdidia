import { createEmptyDailyEntry, defaultAppSettings } from "../../domain/daily-entry";
import { MemoryRepository } from "../storage/memory-repository";
import { getCurrentMonthKey } from "./analytics/month-range";
import { PASTOR_VERSE_PROMPT_VERSION, PastorVerseService } from "./pastor-verse-service";
import type { AiProvider } from "./provider";

const configuredSettings = () => {
  const settings = defaultAppSettings();
  settings.aiEnabled = true;
  settings.aiApiKey = "secret";
  settings.aiPastorEnabled = true;
  return settings;
};

const validAiPayload = (verseId: string) =>
  JSON.stringify({
    pick: "list",
    verseId,
    principleKey: null,
    intent: "reinforcement",
    title: "Titre IA",
    explanation: "Ancrage IA. Enseignement IA.",
  });

describe("PastorVerseService", () => {
  it("saves a local row when AI is disabled, so the 7-day no-repeat rule holds without AI", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const settings = defaultAppSettings();
    settings.aiPastorEnabled = true;
    settings.aiEnabled = false;

    const provider = { generateStructured: vi.fn() } as unknown as AiProvider;
    const service = new PastorVerseService(provider);

    const result = await service.buildVerse(repository, {
      date: "2026-08-29",
      settings,
      trigger: "auto",
    });

    expect(result.source).toBe("local");
    expect(result.message?.status).toBe("local");
    expect(provider.generateStructured).not.toHaveBeenCalled();

    const messages = await repository.listAiMessages("pastor_verse");
    expect(messages).toHaveLength(1);
    expect(messages[0].status).toBe("local");

    // `local` rows never called the model, so they must not count toward the cost dashboard.
    // `createdAt` uses the real wall clock (`nowIso()`), not the `date` request field, hence the
    // current month rather than "2026-08".
    const usage = await repository.computeAiUsageForMonth(getCurrentMonthKey());
    expect(usage.callCount).toBe(0);
  });

  it("does not persist an ephemeral `localOnly` placeholder", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const settings = configuredSettings();

    const provider = { generateStructured: vi.fn() } as unknown as AiProvider;
    const service = new PastorVerseService(provider);

    const result = await service.buildVerse(repository, {
      date: "2026-08-29",
      settings,
      trigger: "auto",
      localOnly: true,
    });

    expect(result.source).toBe("local");
    expect(result.message).toBeNull();
    expect(provider.generateStructured).not.toHaveBeenCalled();
    expect(await repository.listAiMessages("pastor_verse")).toHaveLength(0);
  });

  it("proves sequential no-AI days do not repeat a hash-collided verse (offline history)", async () => {
    // Reproduces the exact scenario from the original review comment: with "ecriture" as the
    // sole struggling principle, the checked-in catalog's 3 matching entries
    // (`hab-2-2`, `rev-1-19`, `jer-30-2`, in that order) are small enough that the date-hash
    // alone (`pickLocalVerse`) picks the same verse ("rev-1-19") on both 2026-08-01 and
    // 2026-08-04 — proven by `hashString(date) % 3` below, and previously unblocked because a
    // no-AI local pick was never persisted into history at all.
    const repository = new MemoryRepository();
    await repository.initialize();
    const settings = defaultAppSettings();
    settings.aiPastorEnabled = true;
    settings.aiEnabled = false;

    // Two "ecriture: false" checks inside every test date's 7-day-plus-today window make
    // "ecriture" the sole struggling principle throughout (>= 2 false, 0 true — see
    // `computePrincipleSignals`), without touching any other principle.
    const strugglingDay1 = createEmptyDailyEntry("2026-07-30");
    strugglingDay1.principleChecks.ecriture = false;
    const strugglingDay2 = createEmptyDailyEntry("2026-07-31");
    strugglingDay2.principleChecks.ecriture = false;
    await repository.saveDailyEntry(strugglingDay1);
    await repository.saveDailyEntry(strugglingDay2);

    const provider = { generateStructured: vi.fn() } as unknown as AiProvider;
    const service = new PastorVerseService(provider);

    const pick = async (date: string) => {
      const result = await service.buildVerse(repository, { date, settings, trigger: "auto" });
      return result.body.verseId;
    };

    const day1 = await pick("2026-08-01");
    const day2 = await pick("2026-08-02");
    const day3 = await pick("2026-08-03");
    const day4 = await pick("2026-08-04");

    // Without the fix (no persisted history to block against), 2026-08-01 and 2026-08-04 both
    // hash to the same index into the 3-verse "ecriture" pool and 2026-08-04 would repeat
    // "rev-1-19". With the fix, all four prior picks are blocked by the time 2026-08-04 runs (the
    // struggling pool is exhausted, so `pickLocalVerse` falls back to the full catalog minus
    // everything already blocked), so it can never repeat any of the first three.
    expect(day1).toBe("rev-1-19");
    expect(day4).not.toBe("rev-1-19");
    expect(new Set([day1, day2, day3, day4]).size).toBe(4);
  });

  it("saves an ok row and resolves the catalog verse when AI returns a valid pick", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const settings = configuredSettings();

    const provider: AiProvider = {
      generateStructured: vi.fn(async () => ({
        text: validAiPayload("php-4-6-7"),
        model: "test-model",
        usage: { tokensPrompt: 10, tokensCompletion: 20, latencyMs: 5 },
      })),
    };
    const service = new PastorVerseService(provider);

    const result = await service.buildVerse(repository, {
      date: "2026-08-29",
      settings,
      trigger: "auto",
    });

    expect(result.source).toBe("ai");
    expect(result.message?.surface).toBe("pastor_verse");
    expect(result.message?.scopeKey).toBe("pastor:2026-08-29");
    expect(result.message?.promptVersion).toBe(PASTOR_VERSE_PROMPT_VERSION);
    expect(result.message?.model).toBe("test-model");
    expect(result.message?.tokensPrompt).toBe(10);
    expect(result.verse?.id).toBe("php-4-6-7");
    expect(provider.generateStructured).toHaveBeenCalledOnce();
  });

  it("accepts and resolves a pick from settings.aiPastorCustomVerses", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const settings = configuredSettings();
    settings.aiPastorCustomVerses = [
      {
        id: "custom-job-42-10",
        reference: { book: "JOB", chapter: 42, verseStart: 10, verseEnd: 10 },
        principleKeys: ["managedSolitude"],
        note: "Verset ajoute depuis une suggestion hors catalogue.",
      },
    ];
    // `resultFromMessage` (used by the loader) reads settings from the repository, not from the
    // in-memory `settings` object passed to `buildVerse` — persist it so both paths agree.
    await repository.saveSettings(settings);

    const provider: AiProvider = {
      generateStructured: vi.fn(async () => ({
        text: validAiPayload("custom-job-42-10"),
        model: "test-model",
        usage: { tokensPrompt: 10, tokensCompletion: 20, latencyMs: 5 },
      })),
    };
    const service = new PastorVerseService(provider);

    const result = await service.buildVerse(repository, {
      date: "2026-08-29",
      settings,
      trigger: "auto",
    });

    expect(result.source).toBe("ai");
    expect(result.verse?.id).toBe("custom-job-42-10");

    // resultFromMessage (used by the loader) must resolve the same custom verse on a later read.
    const reloaded = await service.resultFromMessage(repository, result.message!);
    expect(reloaded?.verse?.id).toBe("custom-job-42-10");
  });

  it("repairs an invalid response once before accepting it", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const settings = configuredSettings();

    const provider: AiProvider = {
      generateStructured: vi
        .fn()
        .mockResolvedValueOnce({
          text: "not json",
          model: "test-model",
          usage: { tokensPrompt: 1, tokensCompletion: 1, latencyMs: 1 },
        })
        .mockResolvedValueOnce({
          text: validAiPayload("php-4-6-7"),
          model: "test-model",
          usage: { tokensPrompt: 1, tokensCompletion: 1, latencyMs: 1 },
        }),
    };
    const service = new PastorVerseService(provider);

    const result = await service.buildVerse(repository, {
      date: "2026-08-29",
      settings,
      trigger: "auto",
    });

    expect(result.source).toBe("ai");
    expect(provider.generateStructured).toHaveBeenCalledTimes(2);
  });

  it("falls back to the local pick and saves a fallback row when both attempts fail", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const settings = configuredSettings();

    const provider: AiProvider = {
      generateStructured: vi.fn(async () => ({
        text: "still not json",
        model: "test-model",
        usage: { tokensPrompt: 1, tokensCompletion: 1, latencyMs: 1 },
      })),
    };
    const service = new PastorVerseService(provider);

    const result = await service.buildVerse(repository, {
      date: "2026-08-29",
      settings,
      trigger: "auto",
    });

    expect(result.source).toBe("fallback");
    expect(result.warning).toBeTruthy();
    expect(result.message?.status).toBe("fallback");
  });

  it("falls back with a warning when the provider throws, without persisting a row for an explicit trigger", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const settings = configuredSettings();

    const provider: AiProvider = {
      generateStructured: vi.fn(async () => {
        throw new Error("network down");
      }),
    };
    const service = new PastorVerseService(provider);

    const result = await service.buildVerse(repository, {
      date: "2026-08-29",
      settings,
      trigger: "explicit",
    });

    expect(result.source).toBe("fallback");
    expect(result.warning).toBe("network down");
    // An explicit (regenerate) failure never persists: the hook keeps showing the verse already
    // on screen, so this local-pick body was never displayed and must not count as "shown today"
    // for future history blocking.
    expect(result.message).toBeNull();
    expect(await repository.listAiMessages("pastor_verse")).toHaveLength(0);
  });

  it("does not persist a fallback row when an explicit regenerate fails validation twice", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const settings = configuredSettings();

    const provider: AiProvider = {
      generateStructured: vi.fn(async () => ({
        text: "still not json",
        model: "test-model",
        usage: { tokensPrompt: 1, tokensCompletion: 1, latencyMs: 1 },
      })),
    };
    const service = new PastorVerseService(provider);

    const result = await service.buildVerse(repository, {
      date: "2026-08-29",
      settings,
      trigger: "explicit",
    });

    expect(result.source).toBe("fallback");
    expect(result.message).toBeNull();
    expect(await repository.listAiMessages("pastor_verse")).toHaveLength(0);
  });

  it("feeds prior history into blockedVerseIds and honors excludeVerseIds", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const settings = configuredSettings();

    // A prior `ok` row inside the 7-day-plus-today window: `summarizePastorHistory` should
    // block its verse from being picked again today.
    await repository.saveAiMessage({
      id: "ai-message:pastor-prior",
      surface: "pastor_verse",
      scopeKey: "pastor:2026-08-25",
      stance: null,
      kind: "daily",
      inputHash: "hash",
      promptVersion: PASTOR_VERSE_PROMPT_VERSION,
      model: "local",
      status: "ok",
      bodyJson: JSON.stringify({
        pick: "list",
        verseId: "php-4-6-7",
        reference: { book: "PHP", chapter: 4, verseStart: 6, verseEnd: 7 },
        principleKey: null,
        intent: "reinforcement",
        title: "Philippiens 4, 6-7",
        explanation: "Explication",
        practice: null,
      }),
      bodyText: "Philippiens 4, 6-7 — Titre",
      deltaClass: null,
      notified: false,
      tokensPrompt: null,
      tokensCompletion: null,
      latencyMs: null,
      createdAt: "2026-08-25T08:00:00.000Z",
    });

    let capturedBlocked: string[] = [];
    const provider: AiProvider = {
      generateStructured: vi.fn(async (request) => {
        if (request.surface === "pastor_verse") {
          capturedBlocked = request.snapshot.blockedVerseIds;
        }
        return {
          text: validAiPayload("rom-8-28"),
          model: "test-model",
          usage: { tokensPrompt: 1, tokensCompletion: 1, latencyMs: 1 },
        };
      }),
    };
    const service = new PastorVerseService(provider);

    await service.buildVerse(repository, {
      date: "2026-08-29",
      settings,
      trigger: "explicit",
      excludeVerseIds: ["excluded-verse"],
    });

    expect(capturedBlocked).toContain("php-4-6-7");
    expect(capturedBlocked).toContain("excluded-verse");
  });

  it("regression: listAiMessagesForDate never returns a pastor_verse row for the same date", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const settings = configuredSettings();

    const provider: AiProvider = {
      generateStructured: vi.fn(async () => ({
        text: validAiPayload("php-4-6-7"),
        model: "test-model",
        usage: { tokensPrompt: 1, tokensCompletion: 1, latencyMs: 1 },
      })),
    };
    const service = new PastorVerseService(provider);

    await service.buildVerse(repository, { date: "2026-08-29", settings, trigger: "auto" });

    const forDate = await repository.listAiMessagesForDate("2026-08-29");
    expect(forDate.find((message) => message.surface === "pastor_verse")).toBeUndefined();
  });
});
