import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { resetPastorVerseAutoAttemptsForTesting } from "../app/use-pastor-verse";
import { createEmptyDailyEntry, defaultAppSettings } from "../domain/daily-entry";
import type { AiMessage, AiProposal, AppSettings, CoachPulseResult } from "../domain/types";
import type { CoachPulseService } from "../lib/ai/coach-pulse-service";
import { PASTOR_VERSE_PROMPT_VERSION, PastorVerseService } from "../lib/ai/pastor-verse-service";
import { getTodayDate } from "../lib/date";
import { addDays } from "../lib/gtd/shared";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { renderWithApp } from "../test/test-utils";
import { TodayPage } from "./TodayPage";

const enabledAiSettings = (): AppSettings => {
  const settings = defaultAppSettings();
  settings.aiEnabled = true;
  settings.aiApiKey = "secret";
  return settings;
};

const buildCoachResult = (proposal: AiProposal): CoachPulseResult => ({
  message: {
    id: "ai-message:test",
    surface: "coach_pulse",
    scopeKey: getTodayDate(),
    stance: "open",
    kind: "open",
    inputHash: "hash",
    promptVersion: "coach_pulse.v1",
    model: "local",
    status: "skipped",
    bodyJson: JSON.stringify({
      stance: "open",
      headline: "Coach",
      read: "Lecture",
      move: null,
    }),
    bodyText: "Coach",
    deltaClass: null,
    notified: false,
    tokensPrompt: null,
    tokensCompletion: null,
    latencyMs: null,
    createdAt: "2026-08-29T08:00:00.000Z",
  },
  pulse: {
    stance: "open",
    headline: "Coach",
    read: "Lecture",
    move: null,
  },
  proposals: [proposal],
  source: "local",
});

describe("TodayPage coach proposals", () => {
  it("prefills and saves morning intention on accept", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    const proposal: AiProposal = {
      id: "ai-proposal:intention",
      messageId: "ai-message:test",
      type: "intention_draft",
      payloadJson: JSON.stringify({ text: "Focus profond" }),
      status: "pending",
      appliedEntityId: null,
      decidedAt: null,
      createdAt: "2026-08-29T08:00:00.000Z",
    };

    const coachService = {
      resultFromMessage: vi.fn(async () => buildCoachResult(proposal)),
      buildPulse: vi.fn(async () => buildCoachResult(proposal)),
    } as unknown as CoachPulseService;

    await repository.saveAiMessage(buildCoachResult(proposal).message);
    await repository.saveAiProposal(proposal);
    const saveDailyEntry = vi.spyOn(repository, "saveDailyEntry");
    const decideAiProposal = vi.spyOn(repository, "decideAiProposal");

    const user = userEvent.setup();
    await renderWithApp(<TodayPage />, {
      repository,
      contextOverrides: { coachService, settings: defaultAppSettings() },
    });

    await screen.findByText("Focus profond");
    saveDailyEntry.mockClear();

    await user.click(screen.getByRole("button", { name: /accepter/i }));

    expect(await screen.findByDisplayValue("Focus profond")).toBeInTheDocument();
    expect(decideAiProposal).toHaveBeenCalledWith(
      "ai-proposal:intention",
      "accepted",
      getTodayDate(),
    );
    expect(saveDailyEntry).toHaveBeenCalled();
  });

  it("records dismissed proposals without saving the daily entry", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    const proposal: AiProposal = {
      id: "ai-proposal:intention",
      messageId: "ai-message:test",
      type: "intention_draft",
      payloadJson: JSON.stringify({ text: "Focus profond" }),
      status: "pending",
      appliedEntityId: null,
      decidedAt: null,
      createdAt: "2026-08-29T08:00:00.000Z",
    };

    const coachService = {
      resultFromMessage: vi.fn(async () => buildCoachResult(proposal)),
      buildPulse: vi.fn(async () => buildCoachResult(proposal)),
    } as unknown as CoachPulseService;

    await repository.saveAiMessage(buildCoachResult(proposal).message);
    await repository.saveAiProposal(proposal);
    const saveDailyEntry = vi.spyOn(repository, "saveDailyEntry");
    const decideAiProposal = vi.spyOn(repository, "decideAiProposal");

    const user = userEvent.setup();
    await renderWithApp(<TodayPage />, {
      repository,
      contextOverrides: { coachService, settings: defaultAppSettings() },
    });

    await screen.findByText("Focus profond");
    saveDailyEntry.mockClear();

    await user.click(screen.getByRole("button", { name: /ignorer/i }));

    await waitFor(() => {
      expect(decideAiProposal).toHaveBeenCalledWith("ai-proposal:intention", "dismissed");
    });
    expect(saveDailyEntry).not.toHaveBeenCalled();
  });
});

describe("TodayPage", () => {
  it("shows added and completed tasks when clicking GTD counters", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const today = getTodayDate();
    const yesterday = addDays(today, -1);

    await repository.createTask({
      id: "task-added",
      title: "Nouvelle action du jour",
      bucket: "next_action",
      createdAt: `${today}T09:00:00.000Z`,
    });

    await repository.createTask({
      id: "task-completed",
      title: "Action terminee du jour",
      bucket: "next_action",
      createdAt: `${yesterday}T09:00:00.000Z`,
    });
    await repository.completeTask("task-completed", `${today}T18:00:00.000Z`);

    const coachService = {
      buildPulse: vi.fn(async () => ({
        message: {
          id: "ai-message:local",
          surface: "coach_pulse" as const,
          scopeKey: today,
          stance: "open" as const,
          kind: "open",
          inputHash: "local",
          promptVersion: "coach_pulse.v1",
          model: "local",
          status: "skipped" as const,
          bodyJson: null,
          bodyText: null,
          deltaClass: null,
          notified: false,
          tokensPrompt: null,
          tokensCompletion: null,
          latencyMs: null,
          createdAt: "2026-08-29T08:00:00.000Z",
        },
        pulse: {
          stance: "open" as const,
          headline: "Local",
          read: "Brief local",
          move: null,
        },
        proposals: [],
        source: "local" as const,
      })),
    } as unknown as CoachPulseService;

    const user = userEvent.setup();
    await renderWithApp(<TodayPage />, {
      repository,
      route: "/",
      contextOverrides: { coachService },
    });

    await user.click(await screen.findByRole("button", { name: /ajoutées/i }));
    expect(await screen.findByText("Nouvelle action du jour")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /réalisées/i }));
    expect(await screen.findByText("Action terminee du jour")).toBeInTheDocument();
  });

  it("saves night reflection from the daily state section", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const today = getTodayDate();
    const seeded = createEmptyDailyEntry(today);
    seeded.nightReflection = "Reflexion initiale";
    await repository.saveDailyEntry(seeded);
    const saveDailyEntry = vi.spyOn(repository, "saveDailyEntry");

    const coachService = {
      buildPulse: vi.fn(async () => ({
        message: {
          id: "ai-message:local",
          surface: "coach_pulse" as const,
          scopeKey: today,
          stance: "open" as const,
          kind: "open",
          inputHash: "local",
          promptVersion: "coach_pulse.v1",
          model: "local",
          status: "skipped" as const,
          bodyJson: null,
          bodyText: null,
          deltaClass: null,
          notified: false,
          tokensPrompt: null,
          tokensCompletion: null,
          latencyMs: null,
          createdAt: "2026-08-29T08:00:00.000Z",
        },
        pulse: {
          stance: "open" as const,
          headline: "Local",
          read: "Brief local",
          move: null,
        },
        proposals: [],
        source: "local" as const,
      })),
    } as unknown as CoachPulseService;

    const user = userEvent.setup();
    await renderWithApp(<TodayPage />, {
      repository,
      route: "/",
      contextOverrides: { coachService },
    });

    const field = await screen.findByRole("textbox", { name: /réflexion/i });
    await user.clear(field);
    await user.type(field, "Reflexion mise a jour");
    await user.tab();

    await waitFor(() => {
      expect(saveDailyEntry).toHaveBeenCalled();
    });
    const saved = await repository.getDailyEntry(today);
    expect(saved?.nightReflection).toBe("Reflexion mise a jour");
  });

  it("keeps both journal fields when the second persist starts before the first save resolves", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const today = getTodayDate();
    const originalSave = repository.saveDailyEntry.bind(repository);
    const saveDailyEntry = vi
      .spyOn(repository, "saveDailyEntry")
      .mockImplementation(async (entry) => {
        await new Promise((resolve) => {
          window.setTimeout(resolve, 120);
        });
        return originalSave(entry);
      });

    const coachService = {
      buildPulse: vi.fn(async () => ({
        message: {
          id: "ai-message:local",
          surface: "coach_pulse" as const,
          scopeKey: today,
          stance: "open" as const,
          kind: "open",
          inputHash: "local",
          promptVersion: "coach_pulse.v1",
          model: "local",
          status: "skipped" as const,
          bodyJson: null,
          bodyText: null,
          deltaClass: null,
          notified: false,
          tokensPrompt: null,
          tokensCompletion: null,
          latencyMs: null,
          createdAt: "2026-08-29T08:00:00.000Z",
        },
        pulse: {
          stance: "open" as const,
          headline: "Local",
          read: "Brief local",
          move: null,
        },
        proposals: [],
        source: "local" as const,
      })),
    } as unknown as CoachPulseService;

    const user = userEvent.setup();
    await renderWithApp(<TodayPage />, {
      repository,
      route: "/",
      contextOverrides: { coachService },
    });

    const intention = await screen.findByRole("textbox", { name: /intention/i });
    const reflection = screen.getByRole("textbox", { name: /réflexion/i });
    await user.type(intention, "Mon intention");
    await user.click(reflection);
    await user.type(reflection, "Ma reflexion");
    await user.tab();

    await waitFor(() => {
      expect(saveDailyEntry.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    await waitFor(
      async () => {
        const saved = await repository.getDailyEntry(today);
        expect(saved?.morningIntention).toBe("Mon intention");
        expect(saved?.nightReflection).toBe("Ma reflexion");
      },
      { timeout: 3000 },
    );
  });

  it("does not reload the coach pulse when journal fields are saved", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const proposal: AiProposal = {
      id: "ai-proposal:intention",
      messageId: "ai-message:test",
      type: "intention_draft",
      payloadJson: JSON.stringify({ text: "Focus profond" }),
      status: "pending",
      appliedEntityId: null,
      decidedAt: null,
      createdAt: "2026-08-29T08:00:00.000Z",
    };
    const stored = buildCoachResult(proposal);
    stored.message.status = "ok";
    stored.source = "cache";
    await repository.saveAiMessage(stored.message);
    await repository.saveAiProposal(proposal);
    const saveDailyEntry = vi.spyOn(repository, "saveDailyEntry");

    const coachService = {
      resultFromMessage: vi.fn(async () => stored),
      buildPulse: vi.fn(async () => stored),
    } as unknown as CoachPulseService;

    const user = userEvent.setup();
    await renderWithApp(<TodayPage />, {
      repository,
      route: "/",
      contextOverrides: { coachService, settings: enabledAiSettings() },
    });

    expect(await screen.findByText("Coach")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /régénérer/i })).toBeEnabled();
    vi.mocked(coachService.buildPulse).mockClear();
    vi.mocked(coachService.resultFromMessage).mockClear();
    saveDailyEntry.mockClear();

    const field = screen.getByRole("textbox", { name: /réflexion/i });
    await user.type(field, "Reflexion du jour");
    await user.tab();

    await waitFor(() => {
      expect(saveDailyEntry).toHaveBeenCalled();
    });
    expect(coachService.buildPulse).not.toHaveBeenCalled();
    expect(coachService.resultFromMessage).not.toHaveBeenCalled();
  });

  it("reloads the coach pulse when regenerate is clicked after journal edits", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const proposal: AiProposal = {
      id: "ai-proposal:intention",
      messageId: "ai-message:test",
      type: "intention_draft",
      payloadJson: JSON.stringify({ text: "Focus profond" }),
      status: "pending",
      appliedEntityId: null,
      decidedAt: null,
      createdAt: "2026-08-29T08:00:00.000Z",
    };
    const stored = buildCoachResult(proposal);
    stored.message.status = "ok";
    stored.source = "cache";
    await repository.saveAiMessage(stored.message);
    await repository.saveAiProposal(proposal);
    const saveDailyEntry = vi.spyOn(repository, "saveDailyEntry");

    const coachService = {
      resultFromMessage: vi.fn(async () => stored),
      buildPulse: vi.fn(async () => stored),
    } as unknown as CoachPulseService;

    const user = userEvent.setup();
    await renderWithApp(<TodayPage />, {
      repository,
      route: "/",
      contextOverrides: { coachService, settings: enabledAiSettings() },
    });

    expect(await screen.findByText("Coach")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /régénérer/i })).toBeEnabled();
    vi.mocked(coachService.buildPulse).mockClear();
    vi.mocked(coachService.resultFromMessage).mockClear();

    const field = screen.getByRole("textbox", { name: /réflexion/i });
    await user.type(field, "Reflexion du jour");
    await user.tab();
    await waitFor(() => {
      expect(saveDailyEntry).toHaveBeenCalled();
    });
    expect(coachService.resultFromMessage).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: /régénérer/i })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: /régénérer/i }));
    await waitFor(() => {
      expect(coachService.buildPulse).toHaveBeenCalledOnce();
    });
    expect(coachService.buildPulse).toHaveBeenCalledWith(
      repository,
      expect.objectContaining({
        trigger: "explicit",
        bypassCache: true,
      }),
    );
  });
});

describe("TodayPage pastor verse card", () => {
  const today = getTodayDate();

  const pastorSettings = (overrides: Partial<AppSettings> = {}): AppSettings => ({
    ...defaultAppSettings(),
    aiPastorEnabled: true,
    ...overrides,
  });

  const storedPastorMessage = (
    overrides: Partial<AiMessage> & { bodyJson?: string } = {},
  ): AiMessage => ({
    id: "ai-message:pastor-stored",
    surface: "pastor_verse",
    scopeKey: `pastor:${today}`,
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
      explanation: "Explication stockee",
      practice: null,
    }),
    bodyText: "Philippiens 4, 6-7 — Titre",
    deltaClass: null,
    notified: false,
    tokensPrompt: null,
    tokensCompletion: null,
    latencyMs: null,
    createdAt: `${today}T08:00:00.000Z`,
    ...overrides,
  });

  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetPastorVerseAutoAttemptsForTesting();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** Stubs the network so a real (non-`localOnly`) `buildVerse` call never reaches OpenRouter. */
  const mockOpenRouterFetch = (verseId = "rom-8-28") => {
    globalThis.fetch = vi.fn(async () =>
      Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                pick: "list",
                verseId,
                principleKey: null,
                intent: "reinforcement",
                title: "Titre IA",
                explanation: "Explication IA",
              }),
            },
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 10 },
      }),
    ) as typeof fetch;
  };

  it("renders no card and makes no calls when the flag is off", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const buildVerseSpy = vi.spyOn(PastorVerseService.prototype, "buildVerse");

    await renderWithApp(<TodayPage />, {
      repository,
      contextOverrides: { settings: defaultAppSettings() },
    });

    await screen.findByText(/coach du jour|coach/i);
    expect(screen.queryByText("Verset du jour")).not.toBeInTheDocument();
    expect(buildVerseSpy).not.toHaveBeenCalled();
  });

  it("shows a local verse with a disabled regenerate button when AI is off", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    await renderWithApp(<TodayPage />, {
      repository,
      contextOverrides: { settings: pastorSettings({ aiEnabled: false }) },
    });

    const title = await screen.findByText("Verset du jour");
    const pastorSection = title.closest("section") as HTMLElement;
    await waitFor(() => {
      expect(within(pastorSection).getByRole("button", { name: /nouveau verset/i })).toBeDisabled();
    });
    expect(within(pastorSection).getByText("Active l'IA dans les paramètres")).toBeInTheDocument();
  });

  it("renders a stored ok verse without calling buildVerse", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveAiMessage(storedPastorMessage());
    const buildVerseSpy = vi.spyOn(PastorVerseService.prototype, "buildVerse");

    await renderWithApp(<TodayPage />, {
      repository,
      contextOverrides: { settings: pastorSettings({ aiEnabled: true, aiApiKey: "secret" }) },
    });

    expect(await screen.findByText("Explication stockee")).toBeInTheDocument();
    expect(buildVerseSpy).not.toHaveBeenCalled();
  });

  it("calls buildVerse once for the auto AI attempt when nothing is stored", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    mockOpenRouterFetch();
    const buildVerseSpy = vi.spyOn(PastorVerseService.prototype, "buildVerse");

    await renderWithApp(<TodayPage />, {
      repository,
      contextOverrides: { settings: pastorSettings({ aiEnabled: true, aiApiKey: "secret" }) },
    });

    await screen.findByText("Verset du jour");
    await waitFor(() => {
      const autoCalls = buildVerseSpy.mock.calls.filter(
        ([, request]) => request.trigger === "auto" && !request.localOnly,
      );
      expect(autoCalls).toHaveLength(1);
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("renders inside StrictMode with exactly one AI call and one saved row", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    mockOpenRouterFetch();
    const buildVerseSpy = vi.spyOn(PastorVerseService.prototype, "buildVerse");

    await renderWithApp(<TodayPage />, {
      repository,
      strictMode: true,
      contextOverrides: { settings: pastorSettings({ aiEnabled: true, aiApiKey: "secret" }) },
    });

    await screen.findByText("Verset du jour");
    await waitFor(() => {
      const autoCalls = buildVerseSpy.mock.calls.filter(
        ([, request]) => request.trigger === "auto" && !request.localOnly,
      );
      expect(autoCalls).toHaveLength(1);
    });

    await waitFor(async () => {
      const messages = await repository.listAiMessages("pastor_verse");
      const okRows = messages.filter((message) => message.status === "ok");
      expect(okRows).toHaveLength(1);
    });
  });

  it("does not attempt AI again when a fallback row is less than 60 minutes old", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveAiMessage(
      storedPastorMessage({
        id: "ai-message:pastor-fallback",
        status: "fallback",
        createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      }),
    );
    const buildVerseSpy = vi.spyOn(PastorVerseService.prototype, "buildVerse");

    await renderWithApp(<TodayPage />, {
      repository,
      contextOverrides: { settings: pastorSettings({ aiEnabled: true, aiApiKey: "secret" }) },
    });

    await screen.findByText("Verset du jour");
    await waitFor(() => {
      expect(buildVerseSpy).toHaveBeenCalledTimes(1);
    });
    expect(buildVerseSpy).toHaveBeenCalledWith(
      repository,
      expect.objectContaining({ localOnly: true }),
    );
  });

  it("does not retrigger the pastor verse effect when journal fields are saved", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveAiMessage(storedPastorMessage());
    const buildVerseSpy = vi.spyOn(PastorVerseService.prototype, "buildVerse");

    const user = userEvent.setup();
    await renderWithApp(<TodayPage />, {
      repository,
      route: "/",
      contextOverrides: { settings: pastorSettings({ aiEnabled: true, aiApiKey: "secret" }) },
    });

    await screen.findByText("Explication stockee");
    buildVerseSpy.mockClear();

    const field = screen.getByRole("textbox", { name: /réflexion/i });
    await user.type(field, "Reflexion du jour");
    await user.tab();

    await waitFor(async () => {
      const saved = await repository.getDailyEntry(today);
      expect(saved?.nightReflection).toBe("Reflexion du jour");
    });
    expect(buildVerseSpy).not.toHaveBeenCalled();
  });

  it("calls buildVerse with explicit trigger and excluded ids on Nouveau verset", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveAiMessage(storedPastorMessage());
    mockOpenRouterFetch();

    const user = userEvent.setup();
    await renderWithApp(<TodayPage />, {
      repository,
      contextOverrides: { settings: pastorSettings({ aiEnabled: true, aiApiKey: "secret" }) },
    });

    await screen.findByText("Explication stockee");
    const buildVerseSpy = vi.spyOn(PastorVerseService.prototype, "buildVerse");

    await user.click(screen.getByRole("button", { name: /nouveau verset/i }));

    await waitFor(() => {
      expect(buildVerseSpy).toHaveBeenCalledWith(
        repository,
        expect.objectContaining({
          trigger: "explicit",
          excludeVerseIds: ["php-4-6-7"],
        }),
      );
    });
  });

  it("shows the off-list paraphrase label for an outside pick", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveAiMessage(
      storedPastorMessage({
        bodyJson: JSON.stringify({
          pick: "outside",
          verseId: null,
          reference: { book: "GEN", chapter: 1, verseStart: 1, verseEnd: 1 },
          paraphraseFr: "Une paraphrase du debut de la Genese.",
          principleKey: null,
          intent: "new_teaching",
          title: "Genèse 1, 1",
          explanation: "Explication hors catalogue",
          practice: null,
        }),
      }),
    );

    await renderWithApp(<TodayPage />, {
      repository,
      contextOverrides: { settings: pastorSettings({ aiEnabled: true, aiApiKey: "secret" }) },
    });

    expect(await screen.findByText("Une paraphrase du debut de la Genese.")).toBeInTheDocument();
    expect(screen.getByText("Paraphrase IA — lis le passage dans ta Bible.")).toBeInTheDocument();
  });
});
