import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createEmptyDailyEntry, updatePrinciple } from "../domain/daily-entry";
import { addDays } from "../lib/gtd/shared";
import { principleDefinitions } from "../domain/definitions";
import {
  applyWeeklyScoreExternalAxes,
  createEmptyWeeklyReview,
  localWeeklyScoreAxes
} from "../domain/weekly-review";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { createWeeklyMemoryProposals } from "../lib/ai/memory/weekly-distillation";
import { WeeklySynthesisService } from "../lib/ai/weekly-synthesis-service";
import { formatPercent } from "../lib/format";
import * as dateModule from "../lib/date";
import { RescueTimeGoalsService } from "../lib/rescuetime/rescuetime-goals-service";
import { renderWithApp } from "../test/test-utils";
import { WeeklyReviewPage } from "./WeeklyReviewPage";

vi.mock("../lib/ai/weekly-synthesis-loader", () => ({
  loadLatestWeeklySynthesis: vi.fn(async () => null)
}));

describe("WeeklyReviewPage", () => {
  const originalFetch = globalThis.fetch;

  const mockEmptySynthesis = () => {
    vi.spyOn(WeeklySynthesisService.prototype, "buildSynthesis").mockResolvedValue({
      message: {
        id: "ai-message-empty",
        surface: "weekly_synthesis",
        scopeKey: "ignored",
        stance: null,
        kind: "weekly",
        inputHash: "hash",
        promptVersion: "weekly_synthesis.v1",
        model: "local",
        status: "skipped",
        bodyJson: JSON.stringify({
          headline: "Semaine",
          scoreExplanation: "Score",
          strongestAxis: "Discipline",
          weakestAxes: ["Sommeil", "Pomodoris"],
          sectionDrafts: {},
          nextWeekObjectives: [],
          gtdActions: []
        }),
        bodyText: "Semaine",
        deltaClass: null,
        notified: false,
        tokensPrompt: null,
        tokensCompletion: null,
        latencyMs: null,
        createdAt: new Date().toISOString()
      },
      synthesis: {
        headline: "Semaine",
        scoreExplanation: "Score",
        strongestAxis: "Discipline",
        weakestAxes: ["Sommeil", "Pomodoris"],
        sectionDrafts: {},
        nextWeekObjectives: [],
        gtdActions: []
      },
      proposals: [],
      source: "local"
    });
  };

  beforeEach(() => {
    mockEmptySynthesis();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("loads a week summary and saves ritual notes and checklist", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    const weekDates = [
      "2026-03-29",
      "2026-03-30",
      "2026-03-31",
      "2026-04-01",
      "2026-04-02",
      "2026-04-03",
      "2026-04-04"
    ];

    for (const date of weekDates) {
      const entry = createEmptyDailyEntry(date);
      entry.metrics.qualiteSommeil = 80;
      entry.metrics.tempsEcranTelephone = 100;
      entry.metrics.pomodoris = 4;
      entry.metrics.tachesAjoutes = 4;
      entry.metrics.tachesRealises = 3;
      entry.principleChecks.priereDuMatin = true;
      entry.principleChecks.respectTrc = true;
      await repository.saveDailyEntry(entry);
    }

    const user = userEvent.setup();
    await renderWithApp(<WeeklyReviewPage />, { repository, route: "/semaine" });

    const dateInput = await screen.findByLabelText(/debut de semaine/i);
    await user.clear(dateInput);
    await user.type(dateInput, "2026-03-29");
    await user.click(screen.getByRole("button", { name: /charger la semaine/i }));

    expect(await screen.findByText("Score hebdo")).toBeInTheDocument();
    expect(await screen.findByText("21 / 28")).toBeInTheDocument();

    await user.click(screen.getByLabelText(/marquer bilan comme fait/i));
    const bilanField = screen.getByLabelText(/notes bilan/i);
    await user.type(bilanField, "Semaine solide.");

    await waitFor(async () => {
      await expect(repository.getWeeklyReview("2026-03-29")).resolves.toMatchObject({
        ritualChecklist: expect.objectContaining({
          bilan: true
        }),
        notes: expect.objectContaining({
          bilan: "Semaine solide."
        })
      });
    });
  });

  it("renders RescueTime goals score", async () => {
    const goalsSnapshot = {
      weekStartDate: "2026-08-02",
      weekEndDate: "2026-08-08",
      score: 0.25,
      totalAchievement: 0.25,
      items: [
        {
          goalId: 1,
          title: "more than 2h on Personal (24x7)",
          isMore: true,
          actualHours: 3.5,
          weeklyTargetHours: 14,
          achievement: 0.25,
          scheduleLabel: "24x7"
        }
      ],
      rescuetimeConfigured: true
    };

    vi.spyOn(RescueTimeGoalsService.prototype, "computeGoalsSnapshot").mockResolvedValue(goalsSnapshot);
    vi.spyOn(RescueTimeGoalsService.prototype, "computeProductivityPulse").mockResolvedValue({
      weekStartDate: "2026-08-02",
      weekEndDate: "2026-08-08",
      pulse: null,
      rescuetimeConfigured: true
    });

    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveSettings({
      ...(await repository.getSettings()),
      rescuetimeApiKey: "rt-test-key"
    });

    const user = userEvent.setup();
    await renderWithApp(<WeeklyReviewPage />, {
      repository,
      route: "/semaine",
      contextOverrides: {
        settings: {
          ...(await repository.getSettings()),
          rescuetimeApiKey: "rt-test-key"
        }
      }
    });

    const dateInput = await screen.findByLabelText(/debut de semaine/i);
    await user.clear(dateInput);
    await user.type(dateInput, "2026-08-02");
    await user.click(screen.getByRole("button", { name: /charger la semaine/i }));

    await waitFor(() => {
      expect(screen.getByText("more than 2h on Personal (24x7)")).toBeInTheDocument();
      expect(screen.getByText("0.25/1")).toBeInTheDocument();
    });
  });

  it("overlays RescueTime axes into the weekly score when snapshots match the week", async () => {
    const weekStart = "2026-08-02";
    const goalsSnapshot = {
      weekStartDate: weekStart,
      weekEndDate: "2026-08-08",
      score: 1,
      totalAchievement: 1,
      items: [],
      rescuetimeConfigured: true
    };
    const pulseSnapshot = {
      weekStartDate: weekStart,
      weekEndDate: "2026-08-08",
      pulse: 100,
      rescuetimeConfigured: true
    };

    vi.spyOn(RescueTimeGoalsService.prototype, "computeGoalsSnapshot").mockResolvedValue(goalsSnapshot);
    vi.spyOn(RescueTimeGoalsService.prototype, "computeProductivityPulse").mockResolvedValue(pulseSnapshot);

    const repository = new MemoryRepository();
    await repository.initialize();

    const weekDates = [
      weekStart,
      "2026-08-03",
      "2026-08-04",
      "2026-08-05",
      "2026-08-06",
      "2026-08-07",
      "2026-08-08"
    ];

    for (const date of weekDates) {
      const entry = createEmptyDailyEntry(date);
      entry.metrics.qualiteSommeil = 80;
      entry.principleChecks.priereDuMatin = true;
      await repository.saveDailyEntry(entry);
    }

    await repository.saveSettings({
      ...(await repository.getSettings()),
      rescuetimeApiKey: "rt-test-key"
    });

    const user = userEvent.setup();
    await renderWithApp(<WeeklyReviewPage />, {
      repository,
      route: "/semaine",
      contextOverrides: {
        settings: {
          ...(await repository.getSettings()),
          rescuetimeApiKey: "rt-test-key"
        }
      }
    });

    const dateInput = await screen.findByLabelText(/debut de semaine/i);
    await user.clear(dateInput);
    await user.type(dateInput, weekStart);
    await user.click(screen.getByRole("button", { name: /charger la semaine/i }));

    const localSummary = await repository.computeWeeklyReviewSummary(weekStart);
    const expected = applyWeeklyScoreExternalAxes(localSummary, {
      rescueTimeGoalsScore: 1,
      productivityPulse: 100
    });
    const localAxesSum = localWeeklyScoreAxes(localSummary).reduce((sum, value) => sum + value, 0);
    expect(expected.weeklyScore).toBeCloseTo((localAxesSum + 1 + 1) / 9);

    await waitFor(() => {
      const scoreCard = screen.getAllByText("Score hebdo")[0].closest("article");
      expect(scoreCard?.querySelector("strong")?.textContent).toBe(formatPercent(expected.weeklyScore));
    });
  });

  it("shows Goals results while the pulse request is still pending", async () => {
    const weekStart = "2026-08-02";
    type PulseSnapshot = {
      weekStartDate: string;
      weekEndDate: string;
      pulse: number | null;
      rescuetimeConfigured: boolean;
    };
    let resolvePulse: ((value: PulseSnapshot) => void) | undefined;

    vi.spyOn(RescueTimeGoalsService.prototype, "computeGoalsSnapshot").mockResolvedValue({
      weekStartDate: weekStart,
      weekEndDate: "2026-08-08",
      score: 0.5,
      totalAchievement: 0.5,
      items: [
        {
          goalId: 1,
          title: "pending-pulse goal",
          isMore: true,
          actualHours: 1,
          weeklyTargetHours: 2,
          achievement: 0.5,
          scheduleLabel: "24x7"
        }
      ],
      rescuetimeConfigured: true
    });
    vi.spyOn(RescueTimeGoalsService.prototype, "computeProductivityPulse").mockImplementation(
      () =>
        new Promise<PulseSnapshot>((resolve) => {
          resolvePulse = resolve;
        })
    );

    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveSettings({
      ...(await repository.getSettings()),
      rescuetimeApiKey: "rt-test-key"
    });

    const user = userEvent.setup();
    await renderWithApp(<WeeklyReviewPage />, {
      repository,
      route: "/semaine",
      contextOverrides: {
        settings: {
          ...(await repository.getSettings()),
          rescuetimeApiKey: "rt-test-key"
        }
      }
    });

    const dateInput = await screen.findByLabelText(/debut de semaine/i);
    await user.clear(dateInput);
    await user.type(dateInput, weekStart);
    await user.click(screen.getByRole("button", { name: /charger la semaine/i }));

    await waitFor(() => {
      expect(screen.getByText("pending-pulse goal")).toBeInTheDocument();
      expect(screen.getByText("0.50/1")).toBeInTheDocument();
    });

    const refreshButton = screen.getByRole("button", { name: /rafraichir rescuetime/i });
    expect(refreshButton).not.toBeDisabled();

    expect(resolvePulse).toBeDefined();
    resolvePulse!({
      weekStartDate: weekStart,
      weekEndDate: "2026-08-08",
      pulse: 90,
      rescuetimeConfigured: true
    });

    await waitFor(() => {
      expect(screen.getAllByText("90 / 100").length).toBeGreaterThan(0);
    });
  });

  it("accepts weekly memory proposals into ai_memories after closing the review", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const weekStartDate = "2026-08-02";
    const historyEntries = [];

    for (let index = 0; index < 12; index += 1) {
      const date = `2026-08-${String(index + 1).padStart(2, "0")}`;
      let entry = createEmptyDailyEntry(date);
      const priereTrue = index % 2 === 0;
      for (const { key } of principleDefinitions) {
        entry = updatePrinciple(entry, key, priereTrue);
      }
      historyEntries.push(entry);
      await repository.saveDailyEntry(entry);
    }

    const proposals = await createWeeklyMemoryProposals(repository, weekStartDate, historyEntries);
    expect(proposals.length).toBeGreaterThan(0);

    await repository.saveWeeklyReview({
      ...createEmptyWeeklyReview(weekStartDate),
      status: "closed",
      updatedAt: new Date().toISOString()
    });

    const user = userEvent.setup();
    await renderWithApp(<WeeklyReviewPage />, { repository, route: "/semaine" });

    const dateInput = await screen.findByLabelText(/debut de semaine/i);
    await user.clear(dateInput);
    await user.type(dateInput, weekStartDate);
    await user.click(screen.getByRole("button", { name: /charger la semaine/i }));

    expect(await screen.findByText("Memoires candidates")).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: /^accepter$/i })[0]);

    await waitFor(async () => {
      const memories = await repository.listAiMemories({ status: "active", kind: "pattern" });
      expect(memories.length).toBeGreaterThan(0);
    });
  });

  it("persists a section draft into the weekly review on accept", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const weekStartDate = "2026-08-02";

    for (let index = 0; index < 7; index += 1) {
      const date = addDays(weekStartDate, index);
      await repository.saveDailyEntry(createEmptyDailyEntry(date));
    }

    const message = {
      id: "ai-message-weekly",
      surface: "weekly_synthesis" as const,
      scopeKey: weekStartDate,
      stance: null,
      kind: "weekly",
      inputHash: "hash",
      promptVersion: "weekly_synthesis.v1",
      model: "local",
      status: "skipped" as const,
      bodyJson: JSON.stringify({
        headline: "Semaine",
        scoreExplanation: "Score",
        strongestAxis: "Discipline",
        weakestAxes: ["Sommeil", "Pomodoris"],
        sectionDrafts: { bilan: "Brouillon coach" },
        nextWeekObjectives: [],
        gtdActions: []
      }),
      bodyText: "Local",
      deltaClass: null,
      notified: false,
      tokensPrompt: null,
      tokensCompletion: null,
      latencyMs: null,
      createdAt: new Date().toISOString()
    };
    const proposal = {
      id: "proposal-section",
      messageId: message.id,
      type: "review_section_draft" as const,
      payloadJson: JSON.stringify({ sectionKey: "bilan", text: "Brouillon coach" }),
      status: "pending" as const,
      appliedEntityId: null,
      decidedAt: null,
      createdAt: new Date().toISOString()
    };
    await repository.saveAiMessage(message);
    await repository.saveAiProposal(proposal);

    vi.spyOn(WeeklySynthesisService.prototype, "buildSynthesis").mockResolvedValue({
      message,
      synthesis: {
        headline: "Semaine",
        scoreExplanation: "Score",
        strongestAxis: "Discipline",
        weakestAxes: ["Sommeil", "Pomodoris"],
        sectionDrafts: { bilan: "Brouillon coach" },
        nextWeekObjectives: [],
        gtdActions: []
      },
      proposals: [proposal],
      source: "local"
    });

    const user = userEvent.setup();
    await renderWithApp(<WeeklyReviewPage />, { repository, route: "/semaine" });

    const dateInput = await screen.findByLabelText(/debut de semaine/i);
    await user.clear(dateInput);
    await user.type(dateInput, weekStartDate);
    await user.click(screen.getByRole("button", { name: /charger la semaine/i }));

    expect(await screen.findByRole("heading", { name: /coach hebdomadaire/i })).toBeInTheDocument();
    const acceptButtons = await screen.findAllByRole("button", { name: /^accepter$/i });
    await user.click(acceptButtons[0]);

    await waitFor(() => {
      expect(screen.getByLabelText(/notes bilan/i)).toHaveValue("Brouillon coach");
    });

    await waitFor(async () => {
      await expect(repository.getWeeklyReview(weekStartDate)).resolves.toMatchObject({
        notes: expect.objectContaining({
          bilan: "Brouillon coach"
        })
      });
    });
  });

  it("accepting a weekly objective proposal shows it in standing objectives", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const weekStartDate = "2026-08-02";

    for (let index = 0; index < 7; index += 1) {
      const date = addDays(weekStartDate, index);
      await repository.saveDailyEntry(createEmptyDailyEntry(date));
    }

    const message = {
      id: "ai-message-weekly-objective",
      surface: "weekly_synthesis" as const,
      scopeKey: weekStartDate,
      stance: null,
      kind: "weekly",
      inputHash: "hash",
      promptVersion: "weekly_synthesis.v1",
      model: "local",
      status: "skipped" as const,
      bodyJson: JSON.stringify({
        headline: "Semaine",
        scoreExplanation: "Score",
        strongestAxis: "Discipline",
        weakestAxes: ["Sommeil", "Pomodoris"],
        sectionDrafts: { bilan: "Brouillon coach" },
        nextWeekObjectives: [],
        gtdActions: []
      }),
      bodyText: "Local",
      deltaClass: null,
      notified: false,
      tokensPrompt: null,
      tokensCompletion: null,
      latencyMs: null,
      createdAt: new Date().toISOString()
    };
    const proposal = {
      id: "proposal-objective",
      messageId: message.id,
      type: "weekly_objective" as const,
      payloadJson: JSON.stringify({
        title: "Lire 2h",
        kind: "manual",
        targetHours: null,
        rescuetimeKind: null,
        rescuetimeThing: null
      }),
      status: "pending" as const,
      appliedEntityId: null,
      decidedAt: null,
      createdAt: new Date().toISOString()
    };
    await repository.saveAiMessage(message);
    await repository.saveAiProposal(proposal);

    vi.spyOn(WeeklySynthesisService.prototype, "buildSynthesis").mockResolvedValue({
      message,
      synthesis: {
        headline: "Semaine",
        scoreExplanation: "Score",
        strongestAxis: "Discipline",
        weakestAxes: ["Sommeil", "Pomodoris"],
        sectionDrafts: {},
        nextWeekObjectives: [
          {
            title: "Lire 2h",
            kind: "manual",
            targetHours: null,
            rescuetimeKind: null,
            rescuetimeThing: null
          }
        ],
        gtdActions: []
      },
      proposals: [proposal],
      source: "local"
    });

    const user = userEvent.setup();
    await renderWithApp(<WeeklyReviewPage />, { repository, route: "/semaine" });

    const dateInput = await screen.findByLabelText(/debut de semaine/i);
    await user.clear(dateInput);
    await user.type(dateInput, weekStartDate);
    await user.click(screen.getByRole("button", { name: /charger la semaine/i }));

    const acceptButtons = await screen.findAllByRole("button", { name: /^accepter$/i });
    await user.click(acceptButtons[0]);

    await waitFor(() => {
      expect(screen.getByText("Lire 2h")).toBeInTheDocument();
      expect(screen.getByText("Objectifs permanents")).toBeInTheDocument();
    });
  });

  it("accepts a gtd_action schedule proposal for today", async () => {
    vi.spyOn(dateModule, "getTodayDate").mockReturnValue("2026-08-29");

    const repository = new MemoryRepository();
    await repository.initialize();
    const weekStartDate = "2026-08-02";
    const timestamp = new Date().toISOString();

    for (let index = 0; index < 7; index += 1) {
      await repository.saveDailyEntry(createEmptyDailyEntry(addDays(weekStartDate, index)));
    }

    await repository.saveTask({
      id: "task-gtd-schedule",
      title: "Clarifier inbox",
      notes: "",
      status: "active",
      bucket: "next_action",
      contextIds: [],
      projectId: null,
      parentTaskId: null,
      scheduledFor: null,
      deadline: null,
      recurringTemplateId: null,
      recurrenceDueDate: null,
      isRecurringInstance: false,
      completedAt: null,
      recurrenceGroupId: null,
      pendingPastRecurrences: 0,
      source: "manual",
      sourceExternalId: null,
      createdAt: timestamp,
      updatedAt: timestamp
    });

    const message = {
      id: "ai-message-gtd",
      surface: "weekly_synthesis" as const,
      scopeKey: weekStartDate,
      stance: null,
      kind: "weekly",
      inputHash: "hash-gtd",
      promptVersion: "weekly_synthesis.v1",
      model: "local",
      status: "skipped" as const,
      bodyJson: JSON.stringify({
        headline: "Semaine",
        scoreExplanation: "Score",
        strongestAxis: "Discipline",
        weakestAxes: ["Sommeil", "Pomodoris"],
        sectionDrafts: {},
        nextWeekObjectives: [],
        gtdActions: [{ taskId: "task-gtd-schedule", action: "schedule", reason: "Planifier" }]
      }),
      bodyText: "Semaine",
      deltaClass: null,
      notified: false,
      tokensPrompt: null,
      tokensCompletion: null,
      latencyMs: null,
      createdAt: timestamp
    };
    const proposal = {
      id: "proposal-gtd",
      messageId: message.id,
      type: "gtd_action" as const,
      payloadJson: JSON.stringify({
        taskId: "task-gtd-schedule",
        action: "schedule",
        reason: "Planifier"
      }),
      status: "pending" as const,
      appliedEntityId: null,
      decidedAt: null,
      createdAt: timestamp
    };
    await repository.saveAiMessage(message);
    await repository.saveAiProposal(proposal);

    vi.spyOn(WeeklySynthesisService.prototype, "buildSynthesis").mockResolvedValue({
      message,
      synthesis: {
        headline: "Semaine",
        scoreExplanation: "Score",
        strongestAxis: "Discipline",
        weakestAxes: ["Sommeil", "Pomodoris"],
        sectionDrafts: {},
        nextWeekObjectives: [],
        gtdActions: [{ taskId: "task-gtd-schedule", action: "schedule", reason: "Planifier" }]
      },
      proposals: [proposal],
      source: "local"
    });

    const user = userEvent.setup();
    await renderWithApp(<WeeklyReviewPage />, { repository, route: "/semaine" });

    const dateInput = await screen.findByLabelText(/debut de semaine/i);
    await user.clear(dateInput);
    await user.type(dateInput, weekStartDate);
    await user.click(screen.getByRole("button", { name: /charger la semaine/i }));

    await user.click(await screen.findByRole("button", { name: /^accepter$/i }));

    await waitFor(async () => {
      const tasks = await repository.listTasks({ includeCompleted: true });
      expect(tasks.find((task) => task.id === "task-gtd-schedule")?.scheduledFor).toBe("2026-08-29");
      const updated = await repository.listAiProposals(message.id);
      expect(updated[0]?.status).toBe("accepted");
    });
  });

  it("does not apply proposals from a different week", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const weekA = "2026-08-02";
    const weekB = "2026-08-09";

    for (const weekStart of [weekA, weekB]) {
      for (let index = 0; index < 7; index += 1) {
        await repository.saveDailyEntry(createEmptyDailyEntry(addDays(weekStart, index)));
      }
    }

    const message = {
      id: "ai-message-week-a",
      surface: "weekly_synthesis" as const,
      scopeKey: weekA,
      stance: null,
      kind: "weekly",
      inputHash: "hash-a",
      promptVersion: "weekly_synthesis.v1",
      model: "local",
      status: "skipped" as const,
      bodyJson: JSON.stringify({
        headline: "Semaine A",
        scoreExplanation: "Score",
        strongestAxis: "Discipline",
        weakestAxes: ["Sommeil", "Pomodoris"],
        sectionDrafts: { bilan: "Semaine A" },
        nextWeekObjectives: [],
        gtdActions: []
      }),
      bodyText: "Semaine A",
      deltaClass: null,
      notified: false,
      tokensPrompt: null,
      tokensCompletion: null,
      latencyMs: null,
      createdAt: new Date().toISOString()
    };
    const proposal = {
      id: "proposal-week-a",
      messageId: message.id,
      type: "review_section_draft" as const,
      payloadJson: JSON.stringify({ sectionKey: "bilan", text: "Semaine A" }),
      status: "pending" as const,
      appliedEntityId: null,
      decidedAt: null,
      createdAt: new Date().toISOString()
    };
    await repository.saveAiMessage(message);
    await repository.saveAiProposal(proposal);

    vi.spyOn(WeeklySynthesisService.prototype, "buildSynthesis").mockImplementation(async (_repo, request) => ({
      message: { ...message, scopeKey: request.weekStartDate, inputHash: `hash-${request.weekStartDate}` },
      synthesis: {
        headline: request.weekStartDate === weekA ? "Semaine A" : "Semaine B",
        scoreExplanation: "Score",
        strongestAxis: "Discipline",
        weakestAxes: ["Sommeil", "Pomodoris"],
        sectionDrafts: {},
        nextWeekObjectives: [],
        gtdActions: []
      },
      proposals: request.weekStartDate === weekA ? [proposal] : [],
      source: "local" as const
    }));

    const user = userEvent.setup();
    await renderWithApp(<WeeklyReviewPage />, { repository, route: "/semaine" });

    const dateInput = await screen.findByLabelText(/debut de semaine/i);
    await user.clear(dateInput);
    await user.type(dateInput, weekB);
    await user.click(screen.getByRole("button", { name: /charger la semaine/i }));

    expect(await screen.findByRole("heading", { name: /coach hebdomadaire/i })).toBeInTheDocument();
    expect(screen.queryByText("Semaine A")).not.toBeInTheDocument();

    const acceptButtons = screen.queryAllByRole("button", { name: /^accepter$/i });
    if (acceptButtons.length > 0) {
      await user.click(acceptButtons[0]);
    }

    await expect(repository.getWeeklyReview(weekB)).resolves.toBeNull();
    await expect(repository.listAiProposals(message.id)).resolves.toEqual([
      expect.objectContaining({ status: "pending" })
    ]);
  });
});

describe("WeeklyReviewPage local synthesis integration", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("persists and accepts a local section draft when AI is off", async () => {
    vi.spyOn(RescueTimeGoalsService.prototype, "computeGoalsSnapshot").mockResolvedValue({
      weekStartDate: "2026-08-02",
      weekEndDate: "2026-08-08",
      score: null,
      totalAchievement: 0,
      items: [],
      rescuetimeConfigured: false
    });
    vi.spyOn(RescueTimeGoalsService.prototype, "computeProductivityPulse").mockResolvedValue({
      weekStartDate: "2026-08-02",
      weekEndDate: "2026-08-08",
      pulse: null,
      rescuetimeConfigured: false
    });

    const repository = new MemoryRepository();
    await repository.initialize();
    const weekStartDate = "2026-08-02";

    for (let index = 0; index < 7; index += 1) {
      await repository.saveDailyEntry(createEmptyDailyEntry(addDays(weekStartDate, index)));
    }

    const disabledSettings = {
      ...(await repository.getSettings()),
      aiEnabled: false,
      aiApiKey: ""
    };
    await repository.saveSettings(disabledSettings);

    const user = userEvent.setup();
    await renderWithApp(<WeeklyReviewPage />, {
      repository,
      route: "/semaine",
      contextOverrides: { settings: disabledSettings }
    });

    const dateInput = await screen.findByLabelText(/debut de semaine/i);
    await user.clear(dateInput);
    await user.type(dateInput, weekStartDate);
    await user.click(screen.getByRole("button", { name: /charger la semaine/i }));

    expect(await screen.findByText("Guide local")).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: /^accepter$/i }).length).toBeGreaterThan(0);
    });

    const acceptButtons = screen.getAllByRole("button", { name: /^accepter$/i });
    await user.click(acceptButtons[0]);

    await waitFor(async () => {
      const messages = await repository.listAiMessages("weekly_synthesis");
      expect(messages.length).toBeGreaterThan(0);
      const proposals = await repository.listAiProposals(messages[0].id);
      expect(proposals.some((item) => item.status === "accepted")).toBe(true);
    });
  });
});
