import { defaultAppSettings } from "../../domain/daily-entry";
import { MemoryRepository } from "../storage/memory-repository";
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
  it("returns a local pick without saving a row when AI is disabled", async () => {
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
    expect(result.message).toBeNull();
    expect(provider.generateStructured).not.toHaveBeenCalled();

    const messages = await repository.listAiMessages("pastor_verse");
    expect(messages).toHaveLength(0);
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
        paraphraseFr: null,
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
