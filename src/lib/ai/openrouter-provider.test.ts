import { createEmptyDailyEntry, defaultAppSettings } from "../../domain/daily-entry";
import {
  DEFAULT_OPENROUTER_BASE_URL,
  normalizeAiBaseUrl,
  OpenRouterProvider
} from "./openrouter-provider";

describe("normalizeAiBaseUrl", () => {
  it("keeps a bare OpenRouter root", () => {
    expect(normalizeAiBaseUrl("https://openrouter.ai/api/v1")).toBe(DEFAULT_OPENROUTER_BASE_URL);
  });

  it("strips chat completions and responses suffixes", () => {
    expect(normalizeAiBaseUrl("https://openrouter.ai/api/v1/chat/completions")).toBe(
      DEFAULT_OPENROUTER_BASE_URL
    );
    expect(normalizeAiBaseUrl("https://openrouter.ai/api/v1/responses/")).toBe(DEFAULT_OPENROUTER_BASE_URL);
  });
});

describe("OpenRouterProvider", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("posts to OpenRouter chat completions and returns message text", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        choices: [{ message: { content: "  Bonjour, focuse-toi.  " } }]
      })
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const provider = new OpenRouterProvider();
    const settings = defaultAppSettings();
    settings.aiApiKey = "sk-or-test";
    settings.aiBaseUrl = "https://openrouter.ai/api/v1/chat/completions";
    settings.aiModel = "moonshotai/kimi-k2.6";

    const text = await provider.generate("morning", {
      entry: createEmptyDailyEntry("2026-07-29"),
      recentEntries: [],
      settings,
      timeZone: "America/Toronto",
      partOfDay: "morning",
      currentPartOfDay: "morning",
      inputContent: "Rester net"
    });

    expect(text).toBe("Bonjour, focuse-toi.");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]).toBeDefined();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-or-test");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      model: "moonshotai/kimi-k2.6",
      messages: [{ role: "system" }, { role: "user" }]
    });
    expect(JSON.parse(body.messages[1].content)).toMatchObject({
      timeZone: "America/Toronto",
      partOfDay: "morning",
      inputContent: "Rester net"
    });
  });

  it("surfaces OpenRouter error messages", async () => {
    globalThis.fetch = vi.fn(async () =>
      Response.json({ error: { message: "Insufficient credits" } }, { status: 402 })
    ) as typeof fetch;

    const provider = new OpenRouterProvider();
    const settings = defaultAppSettings();
    settings.aiApiKey = "sk-or-test";

    await expect(
      provider.generate("evening", {
        entry: createEmptyDailyEntry("2026-07-29"),
        recentEntries: [],
        settings,
        timeZone: "America/Toronto",
        partOfDay: "evening",
        currentPartOfDay: "evening",
        inputContent: "Bilan"
      })
    ).rejects.toThrow("Insufficient credits");
  });
});
