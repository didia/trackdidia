import { DEFAULT_AI_MAX_TOKENS, defaultAppSettings } from "../../domain/daily-entry";
import * as debug from "../debug";
import type { DailySnapshot } from "./context/daily-snapshot";
import type { GoalPacingSnapshot } from "./context/goal-pacing-snapshot";
import type { MonthlySnapshot } from "./context/monthly-snapshot";
import type { PastorSnapshot } from "./context/pastor-snapshot";
import type { WeeklySnapshot } from "./context/weekly-snapshot";
import {
  AI_MAX_TOKENS_TRUNCATED_ERROR,
  buildSystemPrompt,
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
        previousDay: null,
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
    expect(systemPrompt).toContain("previousDay est null");
    expect(systemPrompt).toContain("Omets intentionDraft");
    expect(systemPrompt).not.toContain("ancre intentionDraft");
  });

  it("anchors the open prompt on yesterday's focus only when notes are in the payload", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        choices: [
          {
            message: { content: '{"stance":"open","headline":"Bonjour","read":"Go","move":null}' },
          },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    const provider = new OpenRouterProvider();
    const settings = defaultAppSettings();
    settings.aiApiKey = "sk-or-test";
    const base = {
      surface: "daily" as const,
      date: "2026-07-29",
      status: "not_started" as const,
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
    };

    await provider.generateStructured({
      surface: "coach_pulse",
      stance: "open",
      settings,
      snapshot: {
        ...base,
        scope: "full",
        previousDay: {
          date: "2026-07-28",
          status: "closed",
          metrics: [],
          principles: [],
          notes: {
            morningIntention: "",
            nightReflection: "Soir calme",
            tomorrowFocus: "Finir le module",
          },
        },
      },
    });
    await provider.generateStructured({
      surface: "coach_pulse",
      stance: "open",
      settings,
      snapshot: {
        ...base,
        scope: "metrics",
        previousDay: {
          date: "2026-07-28",
          status: "closed",
          metrics: [],
          principles: [],
        },
      },
    });

    const promptFor = (callIndex: number) => {
      const [, init] = fetchMock.mock.calls[callIndex] as unknown as [string, RequestInit];
      const body = JSON.parse(String(init.body));
      return body.messages[0].content as string;
    };

    const fullPrompt = promptFor(0);
    const restrictedPrompt = promptFor(1);
    expect(fullPrompt).toContain("previousDay.notes.tomorrowFocus");
    expect(fullPrompt).toContain("ancre intentionDraft");
    expect(restrictedPrompt).toContain("Omets intentionDraft");
    expect(restrictedPrompt).not.toContain("ancre intentionDraft");
    expect(restrictedPrompt).not.toContain("Finir le module");
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
          staleNextActionsSample: [],
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
        rescueTimeGoals: [],
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
            measurementType: "numeric",
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
            measurementType: "numeric",
            status: "active",
            direction: "increase",
            currentValue: 60,
            targetValue: 100,
            unit: "%",
            progressRatio: 0.6,
            expectedProgressRatio: 0.66,
            onPace: true,
            monthlyProgress: [],
            evaluationScore: null,
            evaluationTrend: null,
            currentPeriodKey: null,
            currentPeriodCount: null,
            cadenceTarget: null,
            cadencePeriod: "week",
            adherenceRatio: null,
            periodsMet: 0,
            periodsElapsed: 0,
            currentStreak: 0,
            milestonesTotal: 0,
            milestonesCompleted: 0,
            milestoneProgressRatio: null,
            milestones: [],
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

  it("includes pastor_verse schema fields and allowed ids in the system prompt", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                pick: "list",
                verseId: "php-4-6-7",
                principleKey: null,
                intent: "reinforcement",
                title: "Titre",
                explanation: "Explication",
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
    settings.aiSurfaceModels.pastor_verse = "pastor-model";

    await provider.generateStructured({
      surface: "pastor_verse",
      settings,
      snapshot: {
        surface: "pastor",
        scope: "full",
        date: "2026-08-29",
        days: [],
        principleSignals: { signals: [], struggling: [] },
        catalog: [
          {
            id: "php-4-6-7",
            label: "Philippiens 4, 6-7",
            principleKeys: [],
            themes: [],
            lastShownDate: null,
            timesShown30: 0,
          },
        ],
        recentVerses: [],
        blockedVerseIds: ["blocked-verse"],
        offListAllowed: true,
      },
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("pastor-model");
    const systemPrompt = body.messages[0].content as string;
    expect(systemPrompt).toContain("Schema pastor_verse");
    expect(systemPrompt).toContain("php-4-6-7");
    expect(systemPrompt).not.toContain("blocked-verse");
    expect(systemPrompt).not.toContain("Schema coach_pulse");
    // Off-list is allowed here, so the model must be told the accepted `reference.book` codes.
    expect(systemPrompt).toContain("PHP=Philippiens");
    expect(systemPrompt).toContain("Ne cite jamais le journal");
    expect(systemPrompt).toContain("Ne moralise pas");
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
        previousDay: null,
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
          previousDay: null,
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
          previousDay: null,
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
    previousDay: null,
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

describe("buildSystemPrompt snapshots", () => {
  const settings = defaultAppSettings();

  const dailySnapshot = (previousDay: DailySnapshot["previousDay"] = null): DailySnapshot => ({
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
    previousDay,
    weeklyScoreTrend: null,
    findings: [],
  });

  const weeklySnapshot: WeeklySnapshot = {
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
      staleNextActionsSample: [],
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
    rescueTimeGoals: [],
    findings: [],
  };

  const monthlySnapshot: MonthlySnapshot = {
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
        measurementType: "numeric",
        currentValue: 70,
        targetValue: 100,
        unit: "%",
        progressRatio: 0.7,
        monthValue: 75,
        evaluationScore: null,
        evaluationTrend: null,
      },
    ],
  };

  const goalPacingSnapshot: GoalPacingSnapshot = {
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
        measurementType: "numeric",
        status: "active",
        direction: "increase",
        currentValue: 60,
        targetValue: 100,
        unit: "%",
        progressRatio: 0.6,
        expectedProgressRatio: 0.66,
        onPace: true,
        monthlyProgress: [],
        evaluationScore: null,
        evaluationTrend: null,
        currentPeriodKey: null,
        currentPeriodCount: null,
        cadenceTarget: null,
        cadencePeriod: "week",
        adherenceRatio: null,
        periodsMet: 0,
        periodsElapsed: 0,
        currentStreak: 0,
        milestonesTotal: 0,
        milestonesCompleted: 0,
        milestoneProgressRatio: null,
        milestones: [],
      },
    ],
  };

  const pastorSnapshot: PastorSnapshot = {
    surface: "pastor",
    scope: "full",
    date: "2026-08-29",
    days: [],
    principleSignals: { signals: [], struggling: [] },
    catalog: [
      {
        id: "php-4-6-7",
        label: "Philippiens 4, 6-7",
        principleKeys: [],
        themes: [],
        lastShownDate: null,
        timesShown30: 0,
      },
    ],
    recentVerses: [],
    blockedVerseIds: ["blocked-verse"],
    offListAllowed: true,
  };

  it("coach_pulse / open / previousDay null", () => {
    expect(
      buildSystemPrompt({
        surface: "coach_pulse",
        stance: "open",
        settings,
        snapshot: dailySnapshot(null),
      }),
    ).toMatchInlineSnapshot(`
      "Tu es un coach de discipline pour l'ouverture de journee. Reponds en francais avec un JSON strict conforme au schema coach_pulse. previousDay est null. N'invente pas d'intention. Omets intentionDraft.

      Schema coach_pulse:
      Champs communs (toujours requis):
      - stance: "open" | "steer" | "wind_down" | "close"
      - headline: string (une ligne)
      - read: string (lecture des signaux depuis la derniere pulsation)
      - move: { what: string; why: string; horizon: "now" | "today" | "tomorrow" } | null

      Champs stance "open":
      - priorities?: Array<{ taskId: string | null; title: string; why: string }> (max 3)
      - intentionDraft?: string
      - commitmentCheck?: { commitment: string; progress: string; question: string } | null

      Exemple minimal open:
      {"stance":"open","headline":"Cap clair","read":"...","move":{"what":"...","why":"...","horizon":"now"},"intentionDraft":"..."}"
    `);
  });

  it("coach_pulse / open / previousDay present without notes", () => {
    expect(
      buildSystemPrompt({
        surface: "coach_pulse",
        stance: "open",
        settings,
        snapshot: dailySnapshot({
          date: "2026-07-28",
          status: "closed",
          metrics: [],
          principles: [],
        }),
      }),
    ).toMatchInlineSnapshot(`
      "Tu es un coach de discipline pour l'ouverture de journee. Reponds en francais avec un JSON strict conforme au schema coach_pulse. previousDay est present mais ses notes ne sont pas dans ce payload. Utilise seulement les metriques et principes de la veille. N'invente pas d'intention. Omets intentionDraft.

      Schema coach_pulse:
      Champs communs (toujours requis):
      - stance: "open" | "steer" | "wind_down" | "close"
      - headline: string (une ligne)
      - read: string (lecture des signaux depuis la derniere pulsation)
      - move: { what: string; why: string; horizon: "now" | "today" | "tomorrow" } | null

      Champs stance "open":
      - priorities?: Array<{ taskId: string | null; title: string; why: string }> (max 3)
      - intentionDraft?: string
      - commitmentCheck?: { commitment: string; progress: string; question: string } | null

      Exemple minimal open:
      {"stance":"open","headline":"Cap clair","read":"...","move":{"what":"...","why":"...","horizon":"now"},"intentionDraft":"..."}"
    `);
  });

  it("coach_pulse / open / previousDay present with yesterday's focus", () => {
    expect(
      buildSystemPrompt({
        surface: "coach_pulse",
        stance: "open",
        settings,
        snapshot: dailySnapshot({
          date: "2026-07-28",
          status: "closed",
          metrics: [],
          principles: [],
          notes: {
            morningIntention: "",
            nightReflection: "Soir calme",
            tomorrowFocus: "Finir le module",
          },
        }),
      }),
    ).toMatchInlineSnapshot(`
      "Tu es un coach de discipline pour l'ouverture de journee. Reponds en francais avec un JSON strict conforme au schema coach_pulse. Si les notes du jour sont vides, ancre intentionDraft et move sur previousDay.notes.tomorrowFocus (l'intention posee hier pour aujourd'hui) et tiens compte de previousDay.notes.nightReflection ainsi que des metriques et principes de la veille.

      Schema coach_pulse:
      Champs communs (toujours requis):
      - stance: "open" | "steer" | "wind_down" | "close"
      - headline: string (une ligne)
      - read: string (lecture des signaux depuis la derniere pulsation)
      - move: { what: string; why: string; horizon: "now" | "today" | "tomorrow" } | null

      Champs stance "open":
      - priorities?: Array<{ taskId: string | null; title: string; why: string }> (max 3)
      - intentionDraft?: string
      - commitmentCheck?: { commitment: string; progress: string; question: string } | null

      Exemple minimal open:
      {"stance":"open","headline":"Cap clair","read":"...","move":{"what":"...","why":"...","horizon":"now"},"intentionDraft":"..."}"
    `);
  });

  it("coach_pulse / open", () => {
    expect(
      buildSystemPrompt({
        surface: "coach_pulse",
        stance: "open",
        settings,
        snapshot: dailySnapshot(null),
      }),
    ).toMatchInlineSnapshot(`
      "Tu es un coach de discipline pour l'ouverture de journee. Reponds en francais avec un JSON strict conforme au schema coach_pulse. previousDay est null. N'invente pas d'intention. Omets intentionDraft.

      Schema coach_pulse:
      Champs communs (toujours requis):
      - stance: "open" | "steer" | "wind_down" | "close"
      - headline: string (une ligne)
      - read: string (lecture des signaux depuis la derniere pulsation)
      - move: { what: string; why: string; horizon: "now" | "today" | "tomorrow" } | null

      Champs stance "open":
      - priorities?: Array<{ taskId: string | null; title: string; why: string }> (max 3)
      - intentionDraft?: string
      - commitmentCheck?: { commitment: string; progress: string; question: string } | null

      Exemple minimal open:
      {"stance":"open","headline":"Cap clair","read":"...","move":{"what":"...","why":"...","horizon":"now"},"intentionDraft":"..."}"
    `);
  });

  it("coach_pulse / steer", () => {
    expect(
      buildSystemPrompt({
        surface: "coach_pulse",
        stance: "steer",
        settings,
        snapshot: dailySnapshot(null),
      }),
    ).toMatchInlineSnapshot(`
      "Tu es un coach de discipline pour un ajustement de mi-journee. Reponds en francais avec un JSON strict conforme au schema coach_pulse.

      Schema coach_pulse:
      Champs communs (toujours requis):
      - stance: "open" | "steer" | "wind_down" | "close"
      - headline: string (une ligne)
      - read: string (lecture des signaux depuis la derniere pulsation)
      - move: { what: string; why: string; horizon: "now" | "today" | "tomorrow" } | null

      Champs stance "steer" ou "wind_down":
      - commitmentCheck?: { commitment: string; progress: string; question: string } | null

      Exemple minimal steer:
      {"stance":"steer","headline":"Mi-journee","read":"...","move":{"what":"...","why":"...","horizon":"now"}}"
    `);
  });

  it("coach_pulse / wind_down", () => {
    expect(
      buildSystemPrompt({
        surface: "coach_pulse",
        stance: "wind_down",
        settings,
        snapshot: dailySnapshot(null),
      }),
    ).toMatchInlineSnapshot(`
      "Tu es un coach de discipline pour la fin de journee active. Reponds en francais avec un JSON strict conforme au schema coach_pulse.

      Schema coach_pulse:
      Champs communs (toujours requis):
      - stance: "open" | "steer" | "wind_down" | "close"
      - headline: string (une ligne)
      - read: string (lecture des signaux depuis la derniere pulsation)
      - move: { what: string; why: string; horizon: "now" | "today" | "tomorrow" } | null

      Champs stance "steer" ou "wind_down":
      - commitmentCheck?: { commitment: string; progress: string; question: string } | null

      Exemple minimal wind_down:
      {"stance":"wind_down","headline":"Fin active","read":"...","move":{"what":"...","why":"...","horizon":"today"}}"
    `);
  });

  it("coach_pulse / close", () => {
    expect(
      buildSystemPrompt({
        surface: "coach_pulse",
        stance: "close",
        settings,
        snapshot: dailySnapshot(null),
      }),
    ).toMatchInlineSnapshot(`
      "Tu es un coach de discipline pour la cloture de journee. Reponds en francais avec un JSON strict conforme au schema coach_pulse.

      Schema coach_pulse:
      Champs communs (toujours requis):
      - stance: "open" | "steer" | "wind_down" | "close"
      - headline: string (une ligne)
      - read: string (lecture des signaux depuis la derniere pulsation)
      - move: { what: string; why: string; horizon: "now" | "today" | "tomorrow" } | null

      Champs stance "close":
      - wins?: string[]
      - frictionPoint?: { what: string; why: string; adjustment: string }
      - principleToRecover?: string | null (cle de principe valide ou null)
      - tomorrowFocusDraft: string (requis)
      - commitment?: { statement: string; metricKey: string | null; target: number | null } | null
      - memoryCandidates?: Array<{ kind: "pattern" | "preference" | "context" | "commitment" | "principle"; statement: string; confidence: number }>

      Exemple minimal close:
      {"stance":"close","headline":"Bilan","read":"...","move":{"what":"...","why":"...","horizon":"tomorrow"},"tomorrowFocusDraft":"..."}"
    `);
  });

  it("coach_pulse with a memory block and repair hint", () => {
    expect(
      buildSystemPrompt(
        {
          surface: "coach_pulse",
          stance: "steer",
          settings,
          snapshot: dailySnapshot(null),
          memoryBlock: "L'utilisateur prefere des rappels courts.",
        },
        "Le JSON doit respecter le schema strictement.",
      ),
    ).toMatchInlineSnapshot(`
      "Tu es un coach de discipline pour un ajustement de mi-journee. Reponds en francais avec un JSON strict conforme au schema coach_pulse.

      Schema coach_pulse:
      Champs communs (toujours requis):
      - stance: "open" | "steer" | "wind_down" | "close"
      - headline: string (une ligne)
      - read: string (lecture des signaux depuis la derniere pulsation)
      - move: { what: string; why: string; horizon: "now" | "today" | "tomorrow" } | null

      Champs stance "steer" ou "wind_down":
      - commitmentCheck?: { commitment: string; progress: string; question: string } | null

      Exemple minimal steer:
      {"stance":"steer","headline":"Mi-journee","read":"...","move":{"what":"...","why":"...","horizon":"now"}}

      Contexte memoire durable:
      L'utilisateur prefere des rappels courts.

      Correction demandee: Le JSON doit respecter le schema strictement."
    `);
  });

  it("weekly_synthesis", () => {
    expect(
      buildSystemPrompt({
        surface: "weekly_synthesis",
        settings,
        snapshot: weeklySnapshot,
      }),
    ).toMatchInlineSnapshot(`
      "Tu es un coach de revue hebdomadaire pour le rituel du dimanche. Reponds en francais avec un JSON strict conforme au schema weekly_synthesis (S2).

      Schema weekly_synthesis:
      Champs requis (weekly_synthesis S2):
      - headline: string (une ligne)
      - scoreExplanation: string (lecture du score hebdo)
      - strongestAxis: string (libelle d'axe)
      - weakestAxes: string[2] (exactement deux libelles d'axes)
      - sectionDrafts?: objet optionnel — cles autorisees: bilan, budget, tempsEtPlan, collecte, calendrier, gtd, alignement, dimanche; chaque valeur est un string
        - "tempsEtPlan" doit tenir compte non seulement des Pomodoros mais aussi, quand \`rescueTimeGoals\`
          est present dans le snapshot, de l'atteinte de chaque objectif RescueTime (\`achievement\`,
          \`actualHours\` vs \`weeklyTargetHours\`) — mentionner explicitement les objectifs mal atteints.
      - nextWeekObjectives: Array<{ title: string; kind: "time" | "manual"; targetHours: number | null; rescuetimeKind: "overview" | "category" | "activity" | "productivity" | null; rescuetimeThing: string | null }> (max 5)
        - kind "time": targetHours > 0 requis; rescuetimeKind + rescuetimeThing non vides requis
        - kind "manual": targetHours, rescuetimeKind et rescuetimeThing doivent etre null
      - gtdActions: Array<{ taskId: string; taskTitle: string; action: "schedule" | "defer" | "delegate" | "drop"; reason: string }>
        - taskTitle doit reprendre exactement le titre de la tache concernee, tel que fourni dans le
          snapshot (ex. \`gtd.staleNextActionsSample\`) — ne jamais laisser une action GTD sans titre.

      Exemple minimal:
      {"headline":"Semaine solide","scoreExplanation":"Le score reflete une bonne discipline.","strongestAxis":"Discipline","weakestAxes":["Temps d'ecran","Pomodoris"],"sectionDrafts":{"bilan":"Note de bilan"},"nextWeekObjectives":[{"title":"Deep work","kind":"manual","targetHours":null,"rescuetimeKind":null,"rescuetimeThing":null}],"gtdActions":[{"taskId":"task-1","taskTitle":"Relancer le fournisseur","action":"defer","reason":"Stale"}]}"
    `);
  });

  it("monthly_synthesis", () => {
    expect(
      buildSystemPrompt({
        surface: "monthly_synthesis",
        settings,
        snapshot: monthlySnapshot,
      }),
    ).toMatchInlineSnapshot(`
      "Tu es un coach de revue mensuelle. Reponds en francais avec un JSON strict conforme au schema monthly_synthesis (S3).

      Schema monthly_synthesis:
      Champs requis (monthly_synthesis S3):
      - headline: string (une ligne)
      - weekPattern: string (lecture des semaines du mois)
      - sectionDrafts?: objet optionnel — cles autorisees: bilan, journaux, finances, temps, progressionObjectifs, missionObjectifs, nettoyageListes, calendrier, grosProjets, developpement; chaque valeur est un string
      - goalEvaluationDrafts: Array<{ goalId: string; score: number | null; trend: "up" | "steady" | "down" | null; notes: string; blockers: string }>
        - goalId doit etre l'un des identifiants du snapshot: goal-1
        - score: entier ou decimal entre 0 et 100 inclusivement, ou null

      Exemple minimal:
      {"headline":"Mois solide","weekPattern":"Score stable sur quatre semaines.","sectionDrafts":{"bilan":"Note de bilan"},"goalEvaluationDrafts":[{"goalId":"goal-1","score":75,"trend":"up","notes":"Bonne progression","blockers":""}]}"
    `);
  });

  it("goal_pacing", () => {
    expect(
      buildSystemPrompt({
        surface: "goal_pacing",
        settings,
        snapshot: goalPacingSnapshot,
      }),
    ).toMatchInlineSnapshot(`
      "Tu es un coach de pilotage d'objectifs annuels. Reponds en francais avec un JSON strict conforme au schema goal_pacing (S4).

      Schema goal_pacing:
      Chaque objectif du snapshot porte un measurementType — adapte ton discours en consequence,
      ne parle jamais d'un objectif en pourcentage s'il n'en a pas:
      - "binary": termine ou non (status "achieved" = fait). S'il a des milestones, parle de leur progression
        (milestonesCompleted / milestonesTotal), jamais d'un ratio numerique global.
      - "numeric": une valeur actuelle qui converge vers une cible (progressRatio est un vrai pourcentage,
        direction "increase" ou "decrease").
      - "cumulative": une somme qui s'accumule sur l'annee (ex: "17 sur 24 livres"), monthlyProgress est un
        total cumule mois par mois.
      - "recurring": une cadence a tenir (ex: "3x/semaine"), jamais "termine" — parle d'adherence
        (adherenceRatio, periodsMet/periodsElapsed) et de currentStreak, pas de pourcentage de cible annuelle.

      Champs requis (goal_pacing S4):
      - goals: Array<{ goalId: string; onPace: boolean; gap: string; requiredWeeklyBehaviour: string; riskLevel: "low" | "medium" | "high"; recommendation: string }>
        - goalId doit etre l'un des identifiants du snapshot: goal-1
        - onPace: boolean (reprends measurement.onPace du snapshot pour cet objectif)
        - gap: string (ecart vs l'attendu — adherence pour "recurring", milestones pour "binary" sans cible chiffree)
        - requiredWeeklyBehaviour: string (comportement hebdo necessaire, en langage adapte au type)
        - riskLevel: "low" | "medium" | "high"
        - recommendation: string

      Exemple minimal:
      {"goals":[{"goalId":"goal-1","onPace":true,"gap":"Proche de la cible annuelle","requiredWeeklyBehaviour":"Maintenir 4 sessions focus","riskLevel":"low","recommendation":"Continuer le rythme actuel"}]}"
    `);
  });

  it("pastor_verse", () => {
    expect(
      buildSystemPrompt({
        surface: "pastor_verse",
        settings,
        snapshot: pastorSnapshot,
      }),
    ).toMatchInlineSnapshot(`
      "Tu es un compagnon pastoral chretien, bienveillant et respectueux de la sensibilite catholique, non polemique. Lis le journal avec bienveillance pour percevoir comment la personne va, puis choisis un seul verset (de preference dans le catalogue) et explique-le en francais avec un JSON strict conforme au schema pastor_verse.

      Schema pastor_verse:
      Champs requis (pastor_verse.v1):
      - pick: "list" | "outside"
      - verseId: obligatoire si pick="list", un des identifiants suivants : php-4-6-7
      - reference: obligatoire si pick="outside" — {book, chapter, verseStart, verseEnd} ; ne fournis jamais le texte du verset
      - principleKey: une clé de principe pertinente, ou null
      - intent: "reinforcement" | "new_teaching" | "both"
      - title (<= 80 caractères) : référence ou titre court en français
      - explanation (<= 900 caractères, 3 à 5 phrases) : ancrage (lien avec le journal ou le principe) puis enseignement (angle nouveau ou pratique concrète)
      - practice (optionnel, <= 160 caractères) : un geste concret pour aujourd'hui

      Tu peux exceptionnellement choisir un verset hors catalogue ("pick":"outside") si aucun verset du catalogue ne convient vraiment. Dans ce cas fournis uniquement "reference" ({book, chapter, verseStart, verseEnd}, numérotation NRSVue/anglaise) — jamais de texte du verset lui-même, ni citation ni paraphrase : l'app affiche seulement la référence et invite à lire le passage dans une Bible. Codes de livres valides pour reference.book : GEN=Genèse, EXO=Exode, LEV=Lévitique, NUM=Nombres, DEU=Deutéronome, JOS=Josué, JDG=Juges, RUT=Ruth, 1SA=1 Samuel, 2SA=2 Samuel, 1KI=1 Rois, 2KI=2 Rois, 1CH=1 Chroniques, 2CH=2 Chroniques, EZR=Esdras, NEH=Néhémie, EST=Esther, JOB=Job, PSA=Psaumes, PRO=Proverbes, ECC=Ecclésiaste, SNG=Cantique des cantiques, ISA=Isaïe, JER=Jérémie, LAM=Lamentations, EZK=Ézéchiel, DAN=Daniel, HOS=Osée, JOL=Joël, AMO=Amos, OBA=Abdias, JON=Jonas, MIC=Michée, NAM=Nahum, HAB=Habacuc, ZEP=Sophonie, HAG=Aggée, ZEC=Zacharie, MAL=Malachie, MAT=Matthieu, MRK=Marc, LUK=Luc, JHN=Jean, ACT=Actes des Apôtres, ROM=Romains, 1CO=1 Corinthiens, 2CO=2 Corinthiens, GAL=Galates, EPH=Éphésiens, PHP=Philippiens, COL=Colossiens, 1TH=1 Thessaloniciens, 2TH=2 Thessaloniciens, 1TI=1 Timothée, 2TI=2 Timothée, TIT=Tite, PHM=Philémon, HEB=Hébreux, JAS=Jacques, 1PE=1 Pierre, 2PE=2 Pierre, 1JN=1 Jean, 2JN=2 Jean, 3JN=3 Jean, JUD=Jude, REV=Apocalypse, TOB=Tobie, JDT=Judith, WIS=Sagesse, SIR=Siracide (Ecclésiastique), BAR=Baruch, 1MA=1 Maccabées, 2MA=2 Maccabées.

      Ne cite jamais un verset biblique mot pour mot, même en paraphrasant de très près. Ne cite jamais le journal de l'utilisateur mot pour mot. Ne moralise pas et ne fais pas la leçon. Ne te présente jamais comme un message divin. Pas de diagnostic médical ou psychologique. Si le journal évoque une détresse, oriente doucement vers la prière et un soutien humain de confiance. Si les données sont peu nombreuses, choisis un verset largement encourageant.

      Exemple minimal (pick="list"):
      {"pick":"list","verseId":"php-4-6-7","principleKey":null,"intent":"reinforcement","title":"Référence courte","explanation":"Ancrage bref lié au journal. Enseignement bref et concret.","practice":null}"
    `);
  });
});
