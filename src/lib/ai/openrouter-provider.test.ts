import { DEFAULT_AI_MAX_TOKENS, defaultAppSettings } from "../../domain/daily-entry";
import * as debug from "../debug";
import type { DailySnapshot } from "./context/daily-snapshot";
import {
  AI_MAX_TOKENS_TRUNCATED_ERROR,
  DEFAULT_OPENROUTER_BASE_URL,
  normalizeAiBaseUrl,
  OpenRouterProvider,
} from "./openrouter-provider";

describe("normalizeAiBaseUrl", () => {
  it("keeps a bare OpenRouter root", () => {
    expect(normalizeAiBaseUrl("https://openrouter.ai/api/v1")).toBe(DEFAULT_OPENROUTER_BASE_URL);
  });

  it("strips chat completions and responses suffixes", () => {
    expect(normalizeAiBaseUrl("https://openrouter.ai/api/v1/chat/completions")).toBe(
      DEFAULT_OPENROUTER_BASE_URL,
    );
    expect(normalizeAiBaseUrl("https://openrouter.ai/api/v1/responses/")).toBe(
      DEFAULT_OPENROUTER_BASE_URL,
    );
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
        choices: [
          {
            message: { content: '{"stance":"open","headline":"Bonjour","read":"Go","move":null}' },
          },
        ],
        usage: { prompt_tokens: 12, completion_tokens: 34 },
      }),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const provider = new OpenRouterProvider();
    const settings = defaultAppSettings();
    settings.aiApiKey = "sk-or-test";
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
          scheduledVsCompletedRatio: 0,
        },
        pomodoro: {
          completedFocusSessionCount: 0,
          totalFocusMinutes: 0,
          taskConcentration: null,
          topTask: null,
        },
        rescueTime: { configured: false, productivityPulseWeekToDate: null },
        history: { daysConsidered: 0, disciplineAverage7d: 0, disciplineAverage28d: 0 },
        weeklyScoreTrend: null,
        findings: [],
      },
    });

    expect(result.text).toContain("Bonjour");
    expect(result.usage.tokensPrompt).toBe(12);
    expect(result.usage.tokensCompletion).toBe(34);
    expect(result.usage.latencyMs).toBeGreaterThanOrEqual(0);

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      model: settings.aiModel,
      max_tokens: DEFAULT_AI_MAX_TOKENS,
      temperature: 0.4,
      response_format: { type: "json_object" },
    });
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-or-test");
    const systemPrompt = body.messages[0].content as string;
    expect(systemPrompt).toContain("Schema coach_pulse");
    expect(systemPrompt).toContain("intentionDraft");
  });

  it("includes weekly synthesis schema fields in the system prompt", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        choices: [
          {
            message: {
              content:
                '{"headline":"Semaine","scoreExplanation":"ok","strongestAxis":"Discipline","weakestAxes":["A","B"],"nextWeekObjectives":[],"gtdActions":[]}',
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      }),
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
          scheduledVsCompletedRatio: 0,
        },
        focus: {
          completedFocusSessionCount: 0,
          totalFocusMinutes: 0,
          taskConcentration: null,
          topTask: null,
          productivityPulse: null,
          rescueTimeConfigured: false,
        },
        findings: [],
      },
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    const systemPrompt = body.messages[0].content as string;
    expect(systemPrompt).toContain("Schema weekly_synthesis");
    expect(systemPrompt).toContain("weakestAxes");
    expect(systemPrompt).toContain("nextWeekObjectives");
    expect(systemPrompt).toContain("gtdActions");
  });

  it("includes monthly synthesis schema fields in the system prompt", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                headline: "Mois solide",
                weekPattern: "Stable",
                goalEvaluationDrafts: [
                  { goalId: "goal-1", score: 75, trend: "up", notes: "", blockers: "" },
                ],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      }),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const provider = new OpenRouterProvider();
    const settings = defaultAppSettings();
    settings.aiApiKey = "sk-or-test";

    await provider.generateStructured({
      surface: "monthly_synthesis",
      settings,
      snapshot: {
        surface: "monthly",
        scope: "full",
        monthKey: "2026-04",
        monthStartDate: "2026-04-01",
        monthEndDate: "2026-04-30",
        reviewStatus: "draft",
        daysTracked: 10,
        weeksCovered: 4,
        weeklyReviewsCompleted: 2,
        sleepAverage: 80,
        trcRate: 70,
        screenTimeTotalMinutes: 1200,
        pomodorisTotal: 40,
        disciplineAverage: 0.75,
        tasksCompletionRate: 80,
        weeklyScoreAverage: 0.72,
        weeks: [],
        goals: [
          {
            goalId: "goal-1",
            title: "Sommeil",
            dimension: "global",
            currentValue: 70,
            targetValue: 100,
            unit: "%",
            progressRatio: 0.7,
            monthValue: 75,
            evaluationScore: null,
            evaluationTrend: null,
          },
        ],
      },
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    const systemPrompt = body.messages[0].content as string;
    expect(systemPrompt).toContain("Schema monthly_synthesis");
    expect(systemPrompt).toContain("goalEvaluationDrafts");
    expect(systemPrompt).toContain("goal-1");
    expect(systemPrompt).toContain("0 et 100");
  });

  it("includes goal pacing schema fields in the system prompt", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                goals: [
                  {
                    goalId: "goal-1",
                    onPace: true,
                    gap: "Proche",
                    requiredWeeklyBehaviour: "Focus",
                    riskLevel: "low",
                    recommendation: "Continuer",
                  },
                ],
              }),
            },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      }),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const provider = new OpenRouterProvider();
    const settings = defaultAppSettings();
    settings.aiApiKey = "sk-or-test";

    await provider.generateStructured({
      surface: "goal_pacing",
      settings,
      snapshot: {
        surface: "annual",
        scope: "full",
        year: 2026,
        asOfDate: "2026-08-29",
        expectedProgressRatio: 0.66,
        goals: [
          {
            goalId: "goal-1",
            title: "Discipline",
            dimension: "global",
            currentValue: 60,
            targetValue: 100,
            unit: "%",
            progressRatio: 0.6,
            onPace: true,
            monthlyProgress: [],
            evaluationScore: null,
            evaluationTrend: null,
          },
        ],
      },
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    const systemPrompt = body.messages[0].content as string;
    expect(systemPrompt).toContain("Schema goal_pacing");
    expect(systemPrompt).toContain("onPace");
    expect(systemPrompt).toContain("riskLevel");
    expect(systemPrompt).toContain("requiredWeeklyBehaviour");
  });

  it("retries once on 429 responses", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: { message: "Rate limited" } }, { status: 429 }))
      .mockResolvedValueOnce(
        Response.json({
          choices: [
            {
              message: { content: '{"stance":"open","headline":"Retry","read":"ok","move":null}' },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 2 },
        }),
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
          scheduledVsCompletedRatio: 0,
        },
        pomodoro: {
          completedFocusSessionCount: 0,
          totalFocusMinutes: 0,
          taskConcentration: null,
          topTask: null,
        },
        rescueTime: { configured: false, productivityPulseWeekToDate: null },
        history: { daysConsidered: 0, disciplineAverage7d: 0, disciplineAverage28d: 0 },
        weeklyScoreTrend: null,
        findings: [],
      },
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
            scheduledVsCompletedRatio: 0,
          },
          pomodoro: {
            completedFocusSessionCount: 0,
            totalFocusMinutes: 0,
            taskConcentration: null,
            topTask: null,
          },
          rescueTime: { configured: false, productivityPulseWeekToDate: null },
          history: { daysConsidered: 0, disciplineAverage7d: 0, disciplineAverage28d: 0 },
          weeklyScoreTrend: null,
          findings: [],
        },
      }),
    ).rejects.toThrow("AI request timed out.");

    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("surfaces OpenRouter error messages without retry on 4xx", async () => {
    globalThis.fetch = vi.fn(async () =>
      Response.json({ error: { message: "Insufficient credits" } }, { status: 402 }),
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
            scheduledVsCompletedRatio: 0,
          },
          pomodoro: {
            completedFocusSessionCount: 0,
            totalFocusMinutes: 0,
            taskConcentration: null,
            topTask: null,
          },
          rescueTime: { configured: false, productivityPulseWeekToDate: null },
          history: { daysConsidered: 0, disciplineAverage7d: 0, disciplineAverage28d: 0 },
          weeklyScoreTrend: null,
          findings: [],
        },
      }),
    ).rejects.toThrow("Insufficient credits");
    expect(globalThis.fetch).toHaveBeenCalledOnce();
  });

  const dailySnapshot = (): DailySnapshot => ({
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
      scheduledVsCompletedRatio: 0,
    },
    pomodoro: {
      completedFocusSessionCount: 0,
      totalFocusMinutes: 0,
      taskConcentration: null,
      topTask: null,
    },
    rescueTime: { configured: false, productivityPulseWeekToDate: null },
    history: { daysConsidered: 0, disciplineAverage7d: 0, disciplineAverage28d: 0 },
    weeklyScoreTrend: null,
    findings: [],
  });

  it("logs a debug warn and throws when finish_reason length truncates JSON", async () => {
    const logSpy = vi.spyOn(debug, "logDebug");
    globalThis.fetch = vi.fn(async () =>
      Response.json({
        choices: [
          {
            finish_reason: "length",
            message: { content: '{"stance":"open","headline":"Tronque' },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 700 },
      }),
    ) as typeof fetch;

    const provider = new OpenRouterProvider();
    const settings = defaultAppSettings();
    settings.aiApiKey = "sk-or-test";

    await expect(
      provider.generateStructured({
        surface: "coach_pulse",
        stance: "open",
        settings,
        snapshot: dailySnapshot(),
      }),
    ).rejects.toThrow(AI_MAX_TOKENS_TRUNCATED_ERROR);

    expect(globalThis.fetch).toHaveBeenCalledOnce();
    expect(logSpy).toHaveBeenCalledWith(
      "warn",
      "ai.openrouter",
      "Reponse IA illisible: max_tokens atteint",
      expect.objectContaining({
        surface: "coach_pulse",
        maxTokens: DEFAULT_AI_MAX_TOKENS,
        finishReason: "length",
        tokensCompletion: 700,
      }),
    );
    logSpy.mockRestore();
  });

  it("returns complete JSON even when finish_reason is length", async () => {
    const logSpy = vi.spyOn(debug, "logDebug");
    globalThis.fetch = vi.fn(async () =>
      Response.json({
        choices: [
          {
            finish_reason: "length",
            message: { content: '{"stance":"open","headline":"Ok","read":"Go","move":null}' },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: DEFAULT_AI_MAX_TOKENS },
      }),
    ) as typeof fetch;

    const provider = new OpenRouterProvider();
    const settings = defaultAppSettings();
    settings.aiApiKey = "sk-or-test";

    const result = await provider.generateStructured({
      surface: "coach_pulse",
      stance: "open",
      settings,
      snapshot: dailySnapshot(),
    });

    expect(result.text).toContain("Ok");
    expect(logSpy).not.toHaveBeenCalledWith(
      "warn",
      "ai.openrouter",
      "Reponse IA illisible: max_tokens atteint",
      expect.anything(),
    );
    logSpy.mockRestore();
  });

  it("treats completion_tokens at the cap with unreadable JSON as a max_tokens stop", async () => {
    const logSpy = vi.spyOn(debug, "logDebug");
    globalThis.fetch = vi.fn(async () =>
      Response.json({
        choices: [
          {
            finish_reason: "stop",
            native_finish_reason: "MAX_TOKENS",
            message: { content: '{"headline":' },
          },
        ],
        usage: { prompt_tokens: 4, completion_tokens: 8000 },
      }),
    ) as typeof fetch;

    const provider = new OpenRouterProvider();
    const settings = defaultAppSettings();
    settings.aiApiKey = "sk-or-test";
    settings.aiMaxTokens = 8000;

    await expect(
      provider.generateStructured({
        surface: "coach_pulse",
        stance: "open",
        settings,
        snapshot: dailySnapshot(),
      }),
    ).rejects.toThrow(AI_MAX_TOKENS_TRUNCATED_ERROR);

    expect(globalThis.fetch).toHaveBeenCalledOnce();
    expect(logSpy).toHaveBeenCalledWith(
      "warn",
      "ai.openrouter",
      "Reponse IA illisible: max_tokens atteint",
      expect.objectContaining({
        surface: "coach_pulse",
        maxTokens: 8000,
        finishReason: "stop,MAX_TOKENS",
        tokensCompletion: 8000,
      }),
    );
    logSpy.mockRestore();
  });
});
