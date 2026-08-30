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
    vi.useRealTimers();
  });

  it("posts structured requests with max_tokens, temperature, and json response format", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        choices: [{ message: { content: '{"stance":"open","headline":"Bonjour","read":"Go","move":null}' } }],
        usage: { prompt_tokens: 12, completion_tokens: 34 }
      })
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const provider = new OpenRouterProvider();
    const settings = defaultAppSettings();
    settings.aiApiKey = "sk-or-test";
    settings.aiMaxTokens = 700;
    settings.aiTimeoutMs = 20_000;

    const result = await provider.generateStructured({
      surface: "coach_pulse",
      stance: "open",
      settings,
      snapshot: {
        surface: "daily",
        scope: "full",
        date: "2026-07-29",
        status: "not_started",
        metrics: [],
        principles: [],
        gtd: {
          inboxBacklog: 0,
          projectsWithoutNextAction: 0,
          projectsWithoutNextActionSample: [],
          staleNextActions: 0,
          agingWaitingFor: 0,
          overdueDeadlines: 0,
          scheduledVsCompletedRatio: 0
        },
        pomodoro: {
          completedFocusSessionCount: 0,
          totalFocusMinutes: 0,
          taskConcentration: null,
          topTask: null
        },
        rescueTime: { configured: false, productivityPulseWeekToDate: null },
        history: { daysConsidered: 0, disciplineAverage7d: 0, disciplineAverage28d: 0 },
        weeklyScoreTrend: null,
        findings: []
      }
    });

    expect(result.text).toContain("Bonjour");
    expect(result.usage.tokensPrompt).toBe(12);
    expect(result.usage.tokensCompletion).toBe(34);
    expect(result.usage.latencyMs).toBeGreaterThanOrEqual(0);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      model: settings.aiModel,
      max_tokens: 700,
      temperature: 0.4,
      response_format: { type: "json_object" }
    });
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-or-test");
    const systemPrompt = body.messages[0].content as string;
    expect(systemPrompt).toContain("Schema coach_pulse");
    expect(systemPrompt).toContain("intentionDraft");
  });

  it("includes weekly synthesis schema fields in the system prompt", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        choices: [{ message: { content: '{"headline":"Semaine","scoreExplanation":"ok","strongestAxis":"Discipline","weakestAxes":["A","B"],"nextWeekObjectives":[],"gtdActions":[]}' } }],
        usage: { prompt_tokens: 1, completion_tokens: 2 }
      })
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const provider = new OpenRouterProvider();
    const settings = defaultAppSettings();
    settings.aiApiKey = "sk-or-test";

    await provider.generateStructured({
      surface: "weekly_synthesis",
      settings,
      snapshot: {
        surface: "weekly",
        scope: "full",
        weekStartDate: "2026-08-02",
        weekEndDate: "2026-08-08",
        reviewStatus: "draft",
        weeklyScore: 0.5,
        axes: [],
        metrics: [],
        principles: [],
        gtd: {
          inboxBacklog: 0,
          projectsWithoutNextAction: 0,
          projectsWithoutNextActionSample: [],
          staleNextActions: 0,
          agingWaitingFor: 0,
          overdueDeadlines: 0,
          scheduledVsCompletedRatio: 0
        },
        focus: {
          completedFocusSessionCount: 0,
          totalFocusMinutes: 0,
          taskConcentration: null,
          topTask: null,
          productivityPulse: null,
          rescueTimeConfigured: false
        },
        findings: []
      }
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    const systemPrompt = body.messages[0].content as string;
    expect(systemPrompt).toContain("Schema weekly_synthesis");
    expect(systemPrompt).toContain("weakestAxes");
    expect(systemPrompt).toContain("nextWeekObjectives");
    expect(systemPrompt).toContain("gtdActions");
  });

  it("retries once on 429 responses", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: { message: "Rate limited" } }, { status: 429 }))
      .mockResolvedValueOnce(
        Response.json({
          choices: [{ message: { content: '{"stance":"open","headline":"Retry","read":"ok","move":null}' } }],
          usage: { prompt_tokens: 1, completion_tokens: 2 }
        })
      );
    globalThis.fetch = fetchMock as typeof fetch;

    const provider = new OpenRouterProvider();
    const settings = defaultAppSettings();
    settings.aiApiKey = "sk-or-test";

    const promise = provider.generateStructured({
      surface: "coach_pulse",
      stance: "open",
      settings,
      snapshot: {
        surface: "daily",
        scope: "full",
        date: "2026-07-29",
        status: "not_started",
        metrics: [],
        principles: [],
        gtd: {
          inboxBacklog: 0,
          projectsWithoutNextAction: 0,
          projectsWithoutNextActionSample: [],
          staleNextActions: 0,
          agingWaitingFor: 0,
          overdueDeadlines: 0,
          scheduledVsCompletedRatio: 0
        },
        pomodoro: {
          completedFocusSessionCount: 0,
          totalFocusMinutes: 0,
          taskConcentration: null,
          topTask: null
        },
        rescueTime: { configured: false, productivityPulseWeekToDate: null },
        history: { daysConsidered: 0, disciplineAverage7d: 0, disciplineAverage28d: 0 },
        weeklyScoreTrend: null,
        findings: []
      }
    });

    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.text).toContain("Retry");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("aborts on timeout", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    }) as typeof fetch;

    const provider = new OpenRouterProvider();
    const settings = defaultAppSettings();
    settings.aiApiKey = "sk-or-test";
    settings.aiTimeoutMs = 50;

    await expect(
      provider.generateStructured({
        surface: "coach_pulse",
        stance: "open",
        settings,
        snapshot: {
          surface: "daily",
          scope: "full",
          date: "2026-07-29",
          status: "not_started",
          metrics: [],
          principles: [],
          gtd: {
            inboxBacklog: 0,
            projectsWithoutNextAction: 0,
            projectsWithoutNextActionSample: [],
            staleNextActions: 0,
            agingWaitingFor: 0,
            overdueDeadlines: 0,
            scheduledVsCompletedRatio: 0
          },
          pomodoro: {
            completedFocusSessionCount: 0,
            totalFocusMinutes: 0,
            taskConcentration: null,
            topTask: null
          },
          rescueTime: { configured: false, productivityPulseWeekToDate: null },
          history: { daysConsidered: 0, disciplineAverage7d: 0, disciplineAverage28d: 0 },
          weeklyScoreTrend: null,
          findings: []
        }
      })
    ).rejects.toThrow("AI request timed out.");

    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("surfaces OpenRouter error messages without retry on 4xx", async () => {
    globalThis.fetch = vi.fn(async () =>
      Response.json({ error: { message: "Insufficient credits" } }, { status: 402 })
    ) as typeof fetch;

    const provider = new OpenRouterProvider();
    const settings = defaultAppSettings();
    settings.aiApiKey = "sk-or-test";

    await expect(
      provider.generateStructured({
        surface: "coach_pulse",
        stance: "close",
        settings,
        snapshot: {
          surface: "daily",
          scope: "full",
          date: "2026-07-29",
          status: "not_started",
          metrics: [],
          principles: [],
          gtd: {
            inboxBacklog: 0,
            projectsWithoutNextAction: 0,
            projectsWithoutNextActionSample: [],
            staleNextActions: 0,
            agingWaitingFor: 0,
            overdueDeadlines: 0,
            scheduledVsCompletedRatio: 0
          },
          pomodoro: {
            completedFocusSessionCount: 0,
            totalFocusMinutes: 0,
            taskConcentration: null,
            topTask: null
          },
          rescueTime: { configured: false, productivityPulseWeekToDate: null },
          history: { daysConsidered: 0, disciplineAverage7d: 0, disciplineAverage28d: 0 },
          weeklyScoreTrend: null,
          findings: []
        }
      })
    ).rejects.toThrow("Insufficient credits");
    expect(globalThis.fetch).toHaveBeenCalledOnce();
  });
});
