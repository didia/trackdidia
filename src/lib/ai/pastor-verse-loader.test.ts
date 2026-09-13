import { latestPastorFallbackAt, loadLatestPastorVerse } from "./pastor-verse-loader";
import { PASTOR_VERSE_PROMPT_VERSION, PastorVerseService } from "./pastor-verse-service";
import { MemoryRepository } from "../storage/memory-repository";
import type { AiProvider } from "./provider";

const fakeProvider = { generateStructured: vi.fn() } as unknown as AiProvider;

const okMessage = (overrides: Partial<Parameters<MemoryRepository["saveAiMessage"]>[0]> = {}) => ({
  id: "ai-message:pastor-ok",
  surface: "pastor_verse" as const,
  scopeKey: "pastor:2026-08-29",
  stance: null,
  kind: "daily",
  inputHash: "hash",
  promptVersion: PASTOR_VERSE_PROMPT_VERSION,
  model: "local",
  status: "ok" as const,
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
  createdAt: "2026-08-29T08:00:00.000Z",
  ...overrides,
});

describe("loadLatestPastorVerse", () => {
  it("returns the latest ok row for the date", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveAiMessage(okMessage());

    const service = new PastorVerseService(fakeProvider);
    const result = await loadLatestPastorVerse(repository, service, "2026-08-29");
    expect(result?.verse?.id).toBe("php-4-6-7");
    expect(result?.source).toBe("cache");
  });

  it("returns null when there is no stored row", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const service = new PastorVerseService(fakeProvider);
    const result = await loadLatestPastorVerse(repository, service, "2026-08-29");
    expect(result).toBeNull();
  });

  it("ignores fallback rows", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveAiMessage(
      okMessage({ id: "ai-message:pastor-fallback", status: "fallback" }),
    );

    const service = new PastorVerseService(fakeProvider);
    const result = await loadLatestPastorVerse(repository, service, "2026-08-29");
    expect(result).toBeNull();
  });

  it("returns null for a stale prompt version", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveAiMessage(okMessage({ promptVersion: "pastor_verse.v0" }));

    const service = new PastorVerseService(fakeProvider);
    const result = await loadLatestPastorVerse(repository, service, "2026-08-29");
    expect(result).toBeNull();
  });
});

describe("latestPastorFallbackAt", () => {
  it("returns the createdAt of the latest fallback row", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveAiMessage(
      okMessage({
        id: "ai-message:pastor-fallback",
        status: "fallback",
        createdAt: "2026-08-29T09:30:00.000Z",
      }),
    );

    const result = await latestPastorFallbackAt(repository, "2026-08-29");
    expect(result).toBe("2026-08-29T09:30:00.000Z");
  });

  it("returns null when there is no fallback row", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const result = await latestPastorFallbackAt(repository, "2026-08-29");
    expect(result).toBeNull();
  });
});
