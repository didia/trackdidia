import { formatTimestamp } from "../lib/format";
import { useState } from "react";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { enqueueMidWeekDecisionSave } from "../app/mid-week-decision-saves";
import { AppContext, useAppContext } from "../app/app-context";
import { createEmptyDailyEntry, defaultAppSettings, updatePrinciple } from "../domain/daily-entry";
import { principleDefinitions } from "../domain/definitions";
import {
  applyWeeklyScoreExternalAxes,
  createEmptyWeeklyReview,
  localWeeklyScoreAxes,
  updateWeeklyReviewNote,
} from "../domain/weekly-review";
import { createWeeklyMemoryProposals } from "../lib/ai/memory/weekly-distillation";
import { loadLatestWeeklySynthesis } from "../lib/ai/weekly-synthesis-loader";
import { WeeklySynthesisService } from "../lib/ai/weekly-synthesis-service";
import * as dateModule from "../lib/date";
import { formatDateLong } from "../lib/date";
import { formatPercent } from "../lib/format";
import { addDays } from "../lib/date";
import { WeeklyObjectivesService } from "../lib/rescuetime/weekly-objectives-service";
import { createEmptyWeeklyObjective } from "../domain/weekly-objectives";
import { RescueTimeGoalsService } from "../lib/rescuetime/rescuetime-goals-service";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { renderWithApp } from "../test/test-utils";
import { WeeklyReviewPage } from "./WeeklyReviewPage";

vi.mock("../lib/ai/weekly-synthesis-loader", () => ({
  loadLatestWeeklySynthesis: vi.fn(async () => null),
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
          gtdActions: [],
        }),
        bodyText: "Semaine",
        deltaClass: null,
        notified: false,
        tokensPrompt: null,
        tokensCompletion: null,
        latencyMs: null,
        createdAt: new Date().toISOString(),
      },
      synthesis: {
        headline: "Semaine",
        scoreExplanation: "Score",
        strongestAxis: "Discipline",
        weakestAxes: ["Sommeil", "Pomodoris"],
        sectionDrafts: {},
        nextWeekObjectives: [],
        gtdActions: [],
      },
      proposals: [],
      source: "local",
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
      "2026-04-04",
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

    const dateInput = await screen.findByLabelText(/début de semaine/i);
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
          bilan: true,
        }),
        notes: expect.objectContaining({
          bilan: "Semaine solide.",
        }),
      });
    });
  });

  it.each([
    ["bilan", "before returning"],
    ["bilan", "while loading"],
    ["dimanche", "before returning"],
    ["dimanche", "while loading"],
  ] as const)("restores failed %s notes when the save rejects %s and allows retry", async (section, failureTiming) => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const week = "2026-03-29";
    const notesWeek = section === "dimanche" ? "2026-04-05" : week;
    const label = section === "dimanche" ? /notes pour la semaine suivante/i : /notes bilan/i;
    await repository.saveWeeklyReview(
      updateWeeklyReviewNote(createEmptyWeeklyReview(notesWeek), section, "Stored notes"),
    );
    const originalSave = repository.saveWeeklyReview.bind(repository);
    let releaseSave!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    let failWrites = true;
    let failedWrites = 0;
    const saveSpy = vi.spyOn(repository, "saveWeeklyReview").mockImplementation(async (review) => {
      if (failWrites) {
        await gate;
        failedWrites += 1;
        throw new Error("disk full");
      }
      return originalSave(review);
    });
    await renderWithApp(<WeeklyReviewPage />, {
      repository,
      route: `/semaine?date=${week}`,
      contextOverrides: { calendarDay: "2026-04-08" },
    });
    const notes = await screen.findByLabelText(label);
    fireEvent.change(notes, { target: { value: "Unsaved notes" } });
    await waitFor(() => expect(saveSpy).toHaveBeenCalled());
    if (failureTiming === "before returning") {
      await act(async () => releaseSave());
      await waitFor(() => expect(failedWrites).toBeGreaterThan(0));
    }
    fireEvent.change(screen.getByLabelText(/début de semaine/i), {
      target: { value: "2026-03-15" },
    });
    fireEvent.click(screen.getByRole("button", { name: /charger la semaine/i }));
    await waitFor(() => expect(screen.getByLabelText(label)).toHaveValue(""));
    fireEvent.change(screen.getByLabelText(/début de semaine/i), { target: { value: week } });
    fireEvent.click(screen.getByRole("button", { name: /charger la semaine/i }));
    if (failureTiming === "while loading") {
      expect(screen.getByText("Chargement de la revue hebdomadaire...")).toBeInTheDocument();
      await act(async () => releaseSave());
    }
    await waitFor(() => expect(screen.getByLabelText(label)).toHaveValue("Unsaved notes"));
    expect(screen.getByLabelText(/début de semaine/i)).toHaveValue(week);
    expect((await repository.getWeeklyReview(notesWeek))?.notes[section]).toBe("Stored notes");
    failWrites = false;
    fireEvent.change(screen.getByLabelText(label), { target: { value: "Unsaved notes retry" } });
    await waitFor(async () => {
      expect((await repository.getWeeklyReview(notesWeek))?.notes[section]).toBe(
        "Unsaved notes retry",
      );
    });
    fireEvent.click(screen.getByRole("button", { name: /charger la semaine/i }));
    await waitFor(() => expect(screen.getByLabelText(label)).toHaveValue("Unsaved notes retry"));
  });

  it("defaults to the previous week on Sunday so the ritual closes the week that just ended", async () => {
    vi.spyOn(dateModule, "getTodayDate").mockReturnValue("2026-09-20");

    const repository = new MemoryRepository();
    await repository.initialize();
    let previous = createEmptyWeeklyReview("2026-09-13");
    previous = updateWeeklyReviewNote(previous, "bilan", "Semaine a cloturer");
    await repository.saveWeeklyReview(previous);
    let current = createEmptyWeeklyReview("2026-09-20");
    current = updateWeeklyReviewNote(current, "bilan", "Semaine qui commence");
    await repository.saveWeeklyReview(current);

    await renderWithApp(<WeeklyReviewPage />, { repository, route: "/semaine" });

    expect(await screen.findByLabelText(/début de semaine/i)).toHaveValue("2026-09-13");
    expect(await screen.findByDisplayValue("Semaine a cloturer")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Semaine qui commence")).not.toBeInTheDocument();
  });

  it("opens the week from the query string even when it is not this week", async () => {
    vi.spyOn(dateModule, "getTodayDate").mockReturnValue("2026-04-12");

    const repository = new MemoryRepository();
    await repository.initialize();
    let review = createEmptyWeeklyReview("2026-03-29");
    review = updateWeeklyReviewNote(review, "bilan", "Note via lien");
    await repository.saveWeeklyReview(review);

    await renderWithApp(<WeeklyReviewPage />, {
      repository,
      route: "/semaine?date=2026-03-31",
    });

    expect(await screen.findByLabelText(/début de semaine/i)).toHaveValue("2026-03-29");
    expect(await screen.findByDisplayValue("Note via lien")).toBeInTheDocument();
  });

  it("keeps the latest ritual notes after leaving the page even if an earlier save is still in flight", async () => {
    vi.spyOn(dateModule, "getTodayDate").mockReturnValue("2026-03-30");

    const repository = new MemoryRepository();
    await repository.initialize();
    const originalSave = repository.saveWeeklyReview.bind(repository);
    let startedSaves = 0;
    let settledSaves = 0;
    let releaseFirstSave: () => void = () => undefined;
    const firstSaveGate = new Promise<void>((resolve) => {
      releaseFirstSave = resolve;
    });
    repository.saveWeeklyReview = async (review) => {
      startedSaves += 1;
      const call = startedSaves;
      try {
        if (call === 1) {
          await firstSaveGate;
        }
        return await originalSave(review);
      } finally {
        settledSaves += 1;
      }
    };

    const user = userEvent.setup();
    const rendered = await renderWithApp(<WeeklyReviewPage />, { repository, route: "/semaine" });

    const bilanField = await screen.findByLabelText(/notes bilan/i);
    await user.type(bilanField, "AB");
    rendered.unmount();
    releaseFirstSave();

    await waitFor(() => {
      expect(startedSaves).toBeGreaterThanOrEqual(2);
      expect(settledSaves).toBe(startedSaves);
    });

    await expect(repository.getWeeklyReview("2026-03-29")).resolves.toMatchObject({
      notes: expect.objectContaining({
        bilan: "AB",
      }),
    });

    await renderWithApp(<WeeklyReviewPage />, { repository, route: "/semaine" });
    expect(await screen.findByLabelText(/notes bilan/i)).toHaveValue("AB");
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
          scheduleLabel: "24x7",
        },
      ],
      rescuetimeConfigured: true,
    };

    vi.spyOn(RescueTimeGoalsService.prototype, "computeGoalsSnapshot").mockResolvedValue(
      goalsSnapshot,
    );
    vi.spyOn(RescueTimeGoalsService.prototype, "computeProductivityPulse").mockResolvedValue({
      weekStartDate: "2026-08-02",
      weekEndDate: "2026-08-08",
      pulse: null,
      rescuetimeConfigured: true,
    });

    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveSettings({
      ...(await repository.getSettings()),
      rescuetimeApiKey: "rt-test-key",
    });

    const user = userEvent.setup();
    await renderWithApp(<WeeklyReviewPage />, {
      repository,
      route: "/semaine",
      contextOverrides: {
        settings: {
          ...(await repository.getSettings()),
          rescuetimeApiKey: "rt-test-key",
        },
      },
    });

    const dateInput = await screen.findByLabelText(/début de semaine/i);
    await user.clear(dateInput);
    await user.type(dateInput, "2026-08-02");
    await user.click(screen.getByRole("button", { name: /charger la semaine/i }));

    await waitFor(() => {
      expect(screen.getByText("more than 2h on Personal (24x7)")).toBeInTheDocument();
      expect(screen.getByText("0.25/1")).toBeInTheDocument();
    });
  });

  it("shows the goals list with a cached notice when the snapshot comes from the cache", async () => {
    vi.spyOn(RescueTimeGoalsService.prototype, "computeGoalsSnapshot").mockResolvedValue({
      weekStartDate: "2026-08-02",
      weekEndDate: "2026-08-08",
      score: 0.25,
      totalAchievement: 0.25,
      items: [
        {
          goalId: 1,
          title: "Goal en cache",
          isMore: true,
          actualHours: 3.5,
          weeklyTargetHours: 14,
          achievement: 0.25,
          scheduleLabel: "24x7",
        },
      ],
      rescuetimeConfigured: true,
      cachedAt: "2026-08-05T10:00:00.000Z",
    });
    vi.spyOn(RescueTimeGoalsService.prototype, "computeProductivityPulse").mockResolvedValue({
      weekStartDate: "2026-08-02",
      weekEndDate: "2026-08-08",
      pulse: null,
      rescuetimeConfigured: true,
    });

    const repository = new MemoryRepository();
    await repository.initialize();
    const settings = { ...(await repository.getSettings()), rescuetimeApiKey: "rt-test-key" };
    await repository.saveSettings(settings);

    const user = userEvent.setup();
    await renderWithApp(<WeeklyReviewPage />, {
      repository,
      route: "/semaine",
      contextOverrides: { settings },
    });
    const dateInput = await screen.findByLabelText(/début de semaine/i);
    await user.clear(dateInput);
    await user.type(dateInput, "2026-08-02");
    await user.click(screen.getByRole("button", { name: /charger la semaine/i }));

    expect(await screen.findByText("Goal en cache")).toBeInTheDocument();
    expect(screen.getByText(/RescueTime est injoignable/)).toBeInTheDocument();
    expect(screen.getByText("Cache RescueTime")).toBeInTheDocument();
  });

  it("labels the cached notice with the oldest snapshot timestamp", async () => {
    vi.spyOn(RescueTimeGoalsService.prototype, "computeGoalsSnapshot").mockResolvedValue({
      weekStartDate: "2026-08-02",
      weekEndDate: "2026-08-08",
      score: 0.25,
      totalAchievement: 0.25,
      items: [
        {
          goalId: 1,
          title: "Goal en cache",
          isMore: true,
          actualHours: 3.5,
          weeklyTargetHours: 14,
          achievement: 0.25,
          scheduleLabel: "24x7",
        },
      ],
      rescuetimeConfigured: true,
      cachedAt: "2026-08-05T10:00:00.000Z",
    });
    vi.spyOn(RescueTimeGoalsService.prototype, "computeProductivityPulse").mockResolvedValue({
      weekStartDate: "2026-08-02",
      weekEndDate: "2026-08-08",
      pulse: 0.5,
      rescuetimeConfigured: true,
      cachedAt: "2026-08-03T10:00:00.000Z",
    });

    const repository = new MemoryRepository();
    await repository.initialize();
    const settings = { ...(await repository.getSettings()), rescuetimeApiKey: "rt-test-key" };
    await repository.saveSettings(settings);

    const user = userEvent.setup();
    await renderWithApp(<WeeklyReviewPage />, {
      repository,
      route: "/semaine",
      contextOverrides: { settings },
    });
    const dateInput = await screen.findByLabelText(/début de semaine/i);
    await user.clear(dateInput);
    await user.type(dateInput, "2026-08-02");
    await user.click(screen.getByRole("button", { name: /charger la semaine/i }));

    expect(await screen.findByText("Goal en cache")).toBeInTheDocument();
    expect(screen.getByText(/RescueTime est injoignable/).textContent).toContain(
      formatTimestamp("2026-08-03T10:00:00.000Z"),
    );
  });

  it("renders the standing objectives list next to a partial fetchError", async () => {
    vi.spyOn(RescueTimeGoalsService.prototype, "computeGoalsSnapshot").mockResolvedValue({
      weekStartDate: "2026-08-02",
      weekEndDate: "2026-08-08",
      score: null,
      totalAchievement: 0,
      items: [],
      rescuetimeConfigured: true,
    });
    vi.spyOn(RescueTimeGoalsService.prototype, "computeProductivityPulse").mockResolvedValue({
      weekStartDate: "2026-08-02",
      weekEndDate: "2026-08-08",
      pulse: null,
      rescuetimeConfigured: true,
    });
    const objective = createEmptyWeeklyObjective({
      id: "objective-partial",
      title: "Objectif partiel",
      kind: "time",
      targetHours: 2,
    });
    vi.spyOn(
      WeeklyObjectivesService.prototype,
      "computeWeeklyObjectivesSnapshot",
    ).mockResolvedValue({
      weekStartDate: "2026-08-02",
      weekEndDate: "2026-08-08",
      items: [
        {
          objective,
          actualHours: null,
          achievement: 0,
          source: "missing",
          error: "Panne partielle",
        },
      ],
      totalAchievement: 0,
      score: 0,
      rescuetimeConfigured: true,
      fetchError: "Panne partielle",
    });

    const repository = new MemoryRepository();
    await repository.initialize();
    const settings = { ...(await repository.getSettings()), rescuetimeApiKey: "rt-test-key" };
    await repository.saveSettings(settings);

    const user = userEvent.setup();
    await renderWithApp(<WeeklyReviewPage />, {
      repository,
      route: "/semaine",
      contextOverrides: { settings },
    });
    const dateInput = await screen.findByLabelText(/début de semaine/i);
    await user.clear(dateInput);
    await user.type(dateInput, "2026-08-02");
    await user.click(screen.getByRole("button", { name: /charger la semaine/i }));

    expect(await screen.findByRole("heading", { name: "Objectif partiel" })).toBeInTheDocument();
    expect(screen.getAllByText("Panne partielle").length).toBeGreaterThan(0);
  });

  it("overlays RescueTime axes into the weekly score when snapshots match the week", async () => {
    const weekStart = "2026-08-02";
    const goalsSnapshot = {
      weekStartDate: weekStart,
      weekEndDate: "2026-08-08",
      score: 1,
      totalAchievement: 1,
      items: [],
      rescuetimeConfigured: true,
    };
    const pulseSnapshot = {
      weekStartDate: weekStart,
      weekEndDate: "2026-08-08",
      pulse: 100,
      rescuetimeConfigured: true,
    };

    vi.spyOn(RescueTimeGoalsService.prototype, "computeGoalsSnapshot").mockResolvedValue(
      goalsSnapshot,
    );
    vi.spyOn(RescueTimeGoalsService.prototype, "computeProductivityPulse").mockResolvedValue(
      pulseSnapshot,
    );

    const repository = new MemoryRepository();
    await repository.initialize();

    const weekDates = [
      weekStart,
      "2026-08-03",
      "2026-08-04",
      "2026-08-05",
      "2026-08-06",
      "2026-08-07",
      "2026-08-08",
    ];

    for (const date of weekDates) {
      const entry = createEmptyDailyEntry(date);
      entry.metrics.qualiteSommeil = 80;
      entry.principleChecks.priereDuMatin = true;
      await repository.saveDailyEntry(entry);
    }

    await repository.saveSettings({
      ...(await repository.getSettings()),
      rescuetimeApiKey: "rt-test-key",
    });

    const user = userEvent.setup();
    await renderWithApp(<WeeklyReviewPage />, {
      repository,
      route: "/semaine",
      contextOverrides: {
        settings: {
          ...(await repository.getSettings()),
          rescuetimeApiKey: "rt-test-key",
        },
      },
    });

    const dateInput = await screen.findByLabelText(/début de semaine/i);
    await user.clear(dateInput);
    await user.type(dateInput, weekStart);
    await user.click(screen.getByRole("button", { name: /charger la semaine/i }));

    const localSummary = await repository.computeWeeklyReviewSummary(weekStart);
    const expected = applyWeeklyScoreExternalAxes(localSummary, {
      rescueTimeGoalsScore: 1,
      productivityPulse: 100,
    });
    const localAxesSum = localWeeklyScoreAxes(localSummary).reduce((sum, value) => sum + value, 0);
    expect(expected.weeklyScore).toBeCloseTo((localAxesSum + 1 + 1) / 9);

    await waitFor(() => {
      const scoreCard = screen.getAllByText("Score hebdo")[0].closest("article");
      expect(scoreCard?.querySelector("strong")?.textContent).toBe(
        formatPercent(expected.weeklyScore),
      );
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
          scheduleLabel: "24x7",
        },
      ],
      rescuetimeConfigured: true,
    });
    vi.spyOn(RescueTimeGoalsService.prototype, "computeProductivityPulse").mockImplementation(
      () =>
        new Promise<PulseSnapshot>((resolve) => {
          resolvePulse = resolve;
        }),
    );

    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveSettings({
      ...(await repository.getSettings()),
      rescuetimeApiKey: "rt-test-key",
    });

    const user = userEvent.setup();
    await renderWithApp(<WeeklyReviewPage />, {
      repository,
      route: "/semaine",
      contextOverrides: {
        settings: {
          ...(await repository.getSettings()),
          rescuetimeApiKey: "rt-test-key",
        },
      },
    });

    const dateInput = await screen.findByLabelText(/début de semaine/i);
    await user.clear(dateInput);
    await user.type(dateInput, weekStart);
    await user.click(screen.getByRole("button", { name: /charger la semaine/i }));

    await waitFor(() => {
      expect(screen.getByText("pending-pulse goal")).toBeInTheDocument();
      expect(screen.getByText("0.50/1")).toBeInTheDocument();
    });

    const refreshButton = screen.getByRole("button", { name: /rafraîchir rescuetime/i });
    expect(refreshButton).not.toBeDisabled();

    expect(resolvePulse).toBeDefined();
    resolvePulse?.({
      weekStartDate: weekStart,
      weekEndDate: "2026-08-08",
      pulse: 90,
      rescuetimeConfigured: true,
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
      updatedAt: new Date().toISOString(),
    });

    const user = userEvent.setup();
    await renderWithApp(<WeeklyReviewPage />, { repository, route: "/semaine" });

    const dateInput = await screen.findByLabelText(/début de semaine/i);
    await user.clear(dateInput);
    await user.type(dateInput, weekStartDate);
    await user.click(screen.getByRole("button", { name: /charger la semaine/i }));

    expect(await screen.findByText("Mémoires candidates")).toBeInTheDocument();
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
        gtdActions: [],
      }),
      bodyText: "Local",
      deltaClass: null,
      notified: false,
      tokensPrompt: null,
      tokensCompletion: null,
      latencyMs: null,
      createdAt: new Date().toISOString(),
    };
    const proposal = {
      id: "proposal-section",
      messageId: message.id,
      type: "review_section_draft" as const,
      payloadJson: JSON.stringify({ sectionKey: "bilan", text: "Brouillon coach" }),
      status: "pending" as const,
      appliedEntityId: null,
      decidedAt: null,
      createdAt: new Date().toISOString(),
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
        gtdActions: [],
      },
      proposals: [proposal],
      source: "local",
    });

    const user = userEvent.setup();
    await renderWithApp(<WeeklyReviewPage />, { repository, route: "/semaine" });

    const dateInput = await screen.findByLabelText(/début de semaine/i);
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
          bilan: "Brouillon coach",
        }),
      });
    });
  });

  it("accepting a weekly objective proposal starts it on the following week", async () => {
    vi.spyOn(dateModule, "getTodayDate").mockReturnValue("2026-08-10");

    const repository = new MemoryRepository();
    await repository.initialize();
    const weekStartDate = "2026-08-02";
    const nextWeekStartDate = addDays(weekStartDate, 7);

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
        gtdActions: [],
      }),
      bodyText: "Local",
      deltaClass: null,
      notified: false,
      tokensPrompt: null,
      tokensCompletion: null,
      latencyMs: null,
      createdAt: new Date().toISOString(),
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
        rescuetimeThing: null,
      }),
      status: "pending" as const,
      appliedEntityId: null,
      decidedAt: null,
      createdAt: new Date().toISOString(),
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
            rescuetimeThing: null,
          },
        ],
        gtdActions: [],
      },
      proposals: [proposal],
      source: "local",
    });

    const user = userEvent.setup();
    await renderWithApp(<WeeklyReviewPage />, { repository, route: "/semaine" });

    const dateInput = await screen.findByLabelText(/début de semaine/i);
    await user.clear(dateInput);
    await user.type(dateInput, weekStartDate);
    await user.click(screen.getByRole("button", { name: /charger la semaine/i }));

    const acceptButtons = await screen.findAllByRole("button", { name: /^accepter$/i });
    await user.click(acceptButtons[0]);

    await waitFor(async () => {
      await expect(repository.listWeeklyObjectives()).resolves.toEqual([
        expect.objectContaining({
          title: "Lire 2h",
          startsOnWeekStartDate: nextWeekStartDate,
        }),
      ]);
    });
    expect(screen.queryByRole("heading", { name: "Lire 2h" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /semaine suivante/i }));
    expect(await screen.findByRole("heading", { name: "Lire 2h" })).toBeInTheDocument();
  });

  it("saves Dimanche notes onto the following week and shows them there", async () => {
    vi.spyOn(dateModule, "getTodayDate").mockReturnValue("2026-08-10");

    const repository = new MemoryRepository();
    await repository.initialize();
    const weekStartDate = "2026-08-02";
    const nextWeekStartDate = addDays(weekStartDate, 7);

    for (let index = 0; index < 7; index += 1) {
      await repository.saveDailyEntry(createEmptyDailyEntry(addDays(weekStartDate, index)));
    }

    const user = userEvent.setup();
    await renderWithApp(<WeeklyReviewPage />, { repository, route: "/semaine" });

    const dateInput = await screen.findByLabelText(/début de semaine/i);
    await user.clear(dateInput);
    await user.type(dateInput, weekStartDate);
    await user.click(screen.getByRole("button", { name: /charger la semaine/i }));

    const nextWeekField = await screen.findByLabelText(/notes pour la semaine suivante/i);
    await user.type(nextWeekField, "Porter le calme");

    await waitFor(async () => {
      await expect(repository.getWeeklyReview(nextWeekStartDate)).resolves.toMatchObject({
        notes: expect.objectContaining({
          dimanche: "Porter le calme",
        }),
      });
    });
    await expect(repository.getWeeklyReview(weekStartDate)).resolves.toBeNull();

    await user.click(screen.getByRole("button", { name: /semaine suivante/i }));
    expect(await screen.findByLabelText(/notes dimanche/i)).toHaveValue("Porter le calme");
  });

  it("accepts a Dimanche draft onto the following week", async () => {
    vi.spyOn(dateModule, "getTodayDate").mockReturnValue("2026-08-10");

    const repository = new MemoryRepository();
    await repository.initialize();
    const weekStartDate = "2026-08-02";
    const nextWeekStartDate = addDays(weekStartDate, 7);

    for (let index = 0; index < 7; index += 1) {
      await repository.saveDailyEntry(createEmptyDailyEntry(addDays(weekStartDate, index)));
    }

    const message = {
      id: "ai-message-dimanche",
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
        sectionDrafts: { dimanche: "Ton pose" },
        nextWeekObjectives: [],
        gtdActions: [],
      }),
      bodyText: "Local",
      deltaClass: null,
      notified: false,
      tokensPrompt: null,
      tokensCompletion: null,
      latencyMs: null,
      createdAt: new Date().toISOString(),
    };
    const proposal = {
      id: "proposal-dimanche",
      messageId: message.id,
      type: "review_section_draft" as const,
      payloadJson: JSON.stringify({ sectionKey: "dimanche", text: "Ton pose" }),
      status: "pending" as const,
      appliedEntityId: null,
      decidedAt: null,
      createdAt: new Date().toISOString(),
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
        sectionDrafts: { dimanche: "Ton pose" },
        nextWeekObjectives: [],
        gtdActions: [],
      },
      proposals: [proposal],
      source: "local",
    });

    const user = userEvent.setup();
    await renderWithApp(<WeeklyReviewPage />, { repository, route: "/semaine" });

    const dateInput = await screen.findByLabelText(/début de semaine/i);
    await user.clear(dateInput);
    await user.type(dateInput, weekStartDate);
    await user.click(screen.getByRole("button", { name: /charger la semaine/i }));

    const acceptButtons = await screen.findAllByRole("button", { name: /^accepter$/i });
    await user.click(acceptButtons[0]);

    await waitFor(() => {
      expect(screen.getByLabelText(/notes pour la semaine suivante/i)).toHaveValue("Ton pose");
    });
    await waitFor(async () => {
      await expect(repository.getWeeklyReview(nextWeekStartDate)).resolves.toMatchObject({
        notes: expect.objectContaining({
          dimanche: "Ton pose",
        }),
      });
    });
    expect(await repository.getWeeklyReview(weekStartDate)).toBeNull();
  });

  it("shows stored Dimanche notes when the opened week is also in the past", async () => {
    vi.spyOn(dateModule, "getTodayDate").mockReturnValue("2026-09-14");

    const repository = new MemoryRepository();
    await repository.initialize();
    const storedWeek = "2026-08-09";

    for (let index = 0; index < 7; index += 1) {
      await repository.saveDailyEntry(createEmptyDailyEntry(addDays(storedWeek, index)));
    }
    await repository.saveWeeklyReview(
      updateWeeklyReviewNote(createEmptyWeeklyReview(storedWeek), "dimanche", "Deja pose"),
    );

    const user = userEvent.setup();
    await renderWithApp(<WeeklyReviewPage />, { repository, route: "/semaine" });

    const dateInput = await screen.findByLabelText(/début de semaine/i);
    await user.clear(dateInput);
    await user.type(dateInput, storedWeek);
    await user.click(screen.getByRole("button", { name: /charger la semaine/i }));

    expect(await screen.findByLabelText(/notes dimanche/i)).toHaveValue("Deja pose");
    expect(screen.getByLabelText(/notes pour la semaine suivante/i)).toHaveValue("");
  });

  it("keeps a delayed Dimanche write when the next week is edited afterward", async () => {
    vi.spyOn(dateModule, "getTodayDate").mockReturnValue("2026-08-10");

    const repository = new MemoryRepository();
    await repository.initialize();
    const weekStartDate = "2026-08-02";
    const nextWeekStartDate = addDays(weekStartDate, 7);

    for (let index = 0; index < 7; index += 1) {
      await repository.saveDailyEntry(createEmptyDailyEntry(addDays(weekStartDate, index)));
    }

    const originalSave = repository.saveWeeklyReview.bind(repository);
    let startedSaves = 0;
    let releaseFirstSave: () => void = () => undefined;
    const firstSaveGate = new Promise<void>((resolve) => {
      releaseFirstSave = resolve;
    });
    repository.saveWeeklyReview = async (review) => {
      startedSaves += 1;
      if (startedSaves === 1) {
        await firstSaveGate;
      }
      return originalSave(review);
    };

    const user = userEvent.setup();
    await renderWithApp(<WeeklyReviewPage />, { repository, route: "/semaine" });

    const dateInput = await screen.findByLabelText(/début de semaine/i);
    await user.clear(dateInput);
    await user.type(dateInput, weekStartDate);
    await user.click(screen.getByRole("button", { name: /charger la semaine/i }));

    await user.type(await screen.findByLabelText(/notes pour la semaine suivante/i), "Porter");
    await user.click(screen.getByRole("button", { name: /semaine suivante/i }));
    releaseFirstSave();

    const bilanField = await screen.findByLabelText(/notes bilan/i);
    await user.type(bilanField, "Suite");

    await waitFor(async () => {
      await expect(repository.getWeeklyReview(nextWeekStartDate)).resolves.toMatchObject({
        notes: expect.objectContaining({
          dimanche: "Porter",
          bilan: "Suite",
        }),
      });
    });
  });

  it("keeps in-progress Dimanche edits when the local day rolls into a past week", async () => {
    vi.spyOn(dateModule, "getTodayDate").mockReturnValue("2026-08-08");

    const repository = new MemoryRepository();
    await repository.initialize();
    const weekStartDate = "2026-08-02";

    for (let index = 0; index < 7; index += 1) {
      await repository.saveDailyEntry(createEmptyDailyEntry(addDays(weekStartDate, index)));
    }

    const DayBridge = () => {
      const parent = useAppContext();
      const [day, setDay] = useState("2026-08-08");
      return (
        <AppContext.Provider value={{ ...parent, calendarDay: day }}>
          <button type="button" onClick={() => setDay("2026-08-09")}>
            Passer minuit
          </button>
          <WeeklyReviewPage />
        </AppContext.Provider>
      );
    };

    const user = userEvent.setup();
    await renderWithApp(<DayBridge />, { repository, route: "/semaine" });

    const dimancheField = await screen.findByLabelText(/notes dimanche/i);
    await user.type(dimancheField, "Calme");
    await waitFor(async () => {
      await expect(repository.getWeeklyReview(weekStartDate)).resolves.toMatchObject({
        notes: expect.objectContaining({ dimanche: "Calme" }),
      });
    });

    await user.click(screen.getByRole("button", { name: /passer minuit/i }));

    expect(await screen.findByLabelText(/notes dimanche/i)).toHaveValue("Calme");
    expect(screen.getByLabelText(/notes pour la semaine suivante/i)).toHaveValue("");
    await expect(repository.getWeeklyReview(weekStartDate)).resolves.toMatchObject({
      notes: expect.objectContaining({ dimanche: "Calme" }),
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
      plannedOrder: null,
      source: "manual",
      sourceExternalId: null,
      sourceUrl: null,
      createdAt: timestamp,
      updatedAt: timestamp,
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
        gtdActions: [
          {
            taskId: "task-gtd-schedule",
            taskTitle: "Tache GTD",
            action: "schedule",
            reason: "Planifier",
          },
        ],
      }),
      bodyText: "Semaine",
      deltaClass: null,
      notified: false,
      tokensPrompt: null,
      tokensCompletion: null,
      latencyMs: null,
      createdAt: timestamp,
    };
    const proposal = {
      id: "proposal-gtd",
      messageId: message.id,
      type: "gtd_action" as const,
      payloadJson: JSON.stringify({
        taskId: "task-gtd-schedule",
        action: "schedule",
        reason: "Planifier",
      }),
      status: "pending" as const,
      appliedEntityId: null,
      decidedAt: null,
      createdAt: timestamp,
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
        gtdActions: [
          {
            taskId: "task-gtd-schedule",
            taskTitle: "Tache GTD",
            action: "schedule",
            reason: "Planifier",
          },
        ],
      },
      proposals: [proposal],
      source: "local",
    });

    const user = userEvent.setup();
    await renderWithApp(<WeeklyReviewPage />, { repository, route: "/semaine" });

    const dateInput = await screen.findByLabelText(/début de semaine/i);
    await user.clear(dateInput);
    await user.type(dateInput, weekStartDate);
    await user.click(screen.getByRole("button", { name: /charger la semaine/i }));

    await user.click(await screen.findByRole("button", { name: /^accepter$/i }));

    await waitFor(async () => {
      const tasks = await repository.listTasks({ includeCompleted: true });
      expect(tasks.find((task) => task.id === "task-gtd-schedule")).toMatchObject({
        bucket: "next_action",
        scheduledFor: null,
      });
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
        gtdActions: [],
      }),
      bodyText: "Semaine A",
      deltaClass: null,
      notified: false,
      tokensPrompt: null,
      tokensCompletion: null,
      latencyMs: null,
      createdAt: new Date().toISOString(),
    };
    const proposal = {
      id: "proposal-week-a",
      messageId: message.id,
      type: "review_section_draft" as const,
      payloadJson: JSON.stringify({ sectionKey: "bilan", text: "Semaine A" }),
      status: "pending" as const,
      appliedEntityId: null,
      decidedAt: null,
      createdAt: new Date().toISOString(),
    };
    await repository.saveAiMessage(message);
    await repository.saveAiProposal(proposal);

    vi.spyOn(WeeklySynthesisService.prototype, "buildSynthesis").mockImplementation(
      async (_repo, request) => ({
        message: {
          ...message,
          scopeKey: request.weekStartDate,
          inputHash: `hash-${request.weekStartDate}`,
        },
        synthesis: {
          headline: request.weekStartDate === weekA ? "Semaine A" : "Semaine B",
          scoreExplanation: "Score",
          strongestAxis: "Discipline",
          weakestAxes: ["Sommeil", "Pomodoris"],
          sectionDrafts: {},
          nextWeekObjectives: [],
          gtdActions: [],
        },
        proposals: request.weekStartDate === weekA ? [proposal] : [],
        source: "local" as const,
      }),
    );

    const user = userEvent.setup();
    await renderWithApp(<WeeklyReviewPage />, { repository, route: "/semaine" });

    const dateInput = await screen.findByLabelText(/début de semaine/i);
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
      expect.objectContaining({ status: "pending" }),
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
      rescuetimeConfigured: false,
    });
    vi.spyOn(RescueTimeGoalsService.prototype, "computeProductivityPulse").mockResolvedValue({
      weekStartDate: "2026-08-02",
      weekEndDate: "2026-08-08",
      pulse: null,
      rescuetimeConfigured: false,
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
      aiApiKey: "",
    };
    await repository.saveSettings(disabledSettings);

    const user = userEvent.setup();
    await renderWithApp(<WeeklyReviewPage />, {
      repository,
      route: "/semaine",
      contextOverrides: { settings: disabledSettings },
    });

    const dateInput = await screen.findByLabelText(/début de semaine/i);
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

describe("WeeklyReviewPage coach cache", () => {
  const weekStartDate = "2026-08-02";

  const enabledAiSettings = () => {
    const settings = defaultAppSettings();
    settings.aiEnabled = true;
    settings.aiApiKey = "secret";
    return settings;
  };

  const storedOk = () => ({
    message: {
      id: "ai-message-weekly-ok",
      surface: "weekly_synthesis" as const,
      scopeKey: weekStartDate,
      stance: null,
      kind: "weekly",
      inputHash: "hash-ok",
      promptVersion: "weekly_synthesis.v1",
      model: "test-model",
      status: "ok" as const,
      bodyJson: JSON.stringify({
        headline: "Coach cache",
        scoreExplanation: "Score",
        strongestAxis: "Discipline",
        weakestAxes: ["Sommeil", "Pomodoris"],
        sectionDrafts: {},
        nextWeekObjectives: [],
        gtdActions: [],
      }),
      bodyText: "Coach cache",
      deltaClass: null,
      notified: false,
      tokensPrompt: 1,
      tokensCompletion: 2,
      latencyMs: 3,
      createdAt: "2026-08-08T12:00:00.000Z",
    },
    synthesis: {
      headline: "Coach cache",
      scoreExplanation: "Score",
      strongestAxis: "Discipline",
      weakestAxes: ["Sommeil", "Pomodoris"],
      sectionDrafts: {},
      nextWeekObjectives: [],
      gtdActions: [],
    },
    proposals: [],
    source: "cache" as const,
  });

  afterEach(() => {
    vi.mocked(loadLatestWeeklySynthesis).mockResolvedValue(null);
    vi.restoreAllMocks();
  });

  it("shows a stored ok synthesis immediately then hash-checks after RescueTime settles", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    for (let index = 0; index < 7; index += 1) {
      await repository.saveDailyEntry(createEmptyDailyEntry(addDays(weekStartDate, index)));
    }

    const stored = storedOk();
    vi.mocked(loadLatestWeeklySynthesis).mockResolvedValue(stored);
    const fresh = {
      ...stored,
      synthesis: { ...stored.synthesis, headline: "Frais" },
      source: "ai" as const,
    };
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const buildSpy = vi
      .spyOn(WeeklySynthesisService.prototype, "buildSynthesis")
      .mockImplementation(async () => {
        await blocked;
        return fresh;
      });

    const user = userEvent.setup();
    await renderWithApp(<WeeklyReviewPage />, {
      repository,
      route: "/semaine",
      contextOverrides: { settings: enabledAiSettings() },
    });

    const dateInput = await screen.findByLabelText(/début de semaine/i);
    await user.clear(dateInput);
    await user.type(dateInput, weekStartDate);
    await user.click(screen.getByRole("button", { name: /charger la semaine/i }));

    expect(await screen.findByText("Coach cache")).toBeInTheDocument();
    expect(screen.queryByText("Frais")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(buildSpy).toHaveBeenCalled();
    });
    expect(buildSpy).toHaveBeenCalledWith(
      repository,
      expect.objectContaining({
        trigger: "auto",
      }),
    );
    release();
    expect(await screen.findByText("Frais")).toBeInTheDocument();
  });

  it("does not treat a fallback row as sticky auto-load cache", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    for (let index = 0; index < 7; index += 1) {
      await repository.saveDailyEntry(createEmptyDailyEntry(addDays(weekStartDate, index)));
    }

    await repository.saveAiMessage({
      id: "ai-message-weekly-fallback",
      surface: "weekly_synthesis",
      scopeKey: weekStartDate,
      stance: null,
      kind: "weekly",
      inputHash: "hash-fallback",
      promptVersion: "weekly_synthesis.v1",
      model: "local",
      status: "fallback",
      bodyJson: JSON.stringify({
        headline: "Fallback local",
        scoreExplanation: "Score",
        strongestAxis: "Discipline",
        weakestAxes: ["Sommeil", "Pomodoris"],
        sectionDrafts: {},
        nextWeekObjectives: [],
        gtdActions: [],
      }),
      bodyText: "Fallback local",
      deltaClass: null,
      notified: false,
      tokensPrompt: 1,
      tokensCompletion: 2,
      latencyMs: 3,
      createdAt: "2026-08-08T12:00:00.000Z",
    });
    vi.mocked(loadLatestWeeklySynthesis).mockResolvedValue(null);
    const fresh = {
      ...storedOk(),
      synthesis: { ...storedOk().synthesis, headline: "Nouveau brief" },
      source: "ai" as const,
    };
    const buildSpy = vi
      .spyOn(WeeklySynthesisService.prototype, "buildSynthesis")
      .mockResolvedValue(fresh);

    const user = userEvent.setup();
    await renderWithApp(<WeeklyReviewPage />, {
      repository,
      route: "/semaine",
      contextOverrides: { settings: enabledAiSettings() },
    });

    const dateInput = await screen.findByLabelText(/début de semaine/i);
    await user.clear(dateInput);
    await user.type(dateInput, weekStartDate);
    await user.click(screen.getByRole("button", { name: /charger la semaine/i }));

    expect(await screen.findByText("Nouveau brief")).toBeInTheDocument();
    expect(screen.queryByText("Fallback local")).not.toBeInTheDocument();
    expect(buildSpy).toHaveBeenCalled();
  });

  it("regenerates with bypassCache", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    for (let index = 0; index < 7; index += 1) {
      await repository.saveDailyEntry(createEmptyDailyEntry(addDays(weekStartDate, index)));
    }

    const stored = storedOk();
    vi.mocked(loadLatestWeeklySynthesis).mockResolvedValue(stored);
    const buildSpy = vi
      .spyOn(WeeklySynthesisService.prototype, "buildSynthesis")
      .mockResolvedValue(stored);

    const user = userEvent.setup();
    await renderWithApp(<WeeklyReviewPage />, {
      repository,
      route: "/semaine",
      contextOverrides: { settings: enabledAiSettings() },
    });

    const dateInput = await screen.findByLabelText(/début de semaine/i);
    await user.clear(dateInput);
    await user.type(dateInput, weekStartDate);
    await user.click(screen.getByRole("button", { name: /charger la semaine/i }));
    expect(await screen.findByText("Coach cache")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /régénérer/i }));
    await waitFor(() => {
      expect(buildSpy).toHaveBeenCalledWith(
        repository,
        expect.objectContaining({
          trigger: "explicit",
          bypassCache: true,
        }),
      );
    });
  });

  it("does not reload weekly synthesis when ritual notes are saved", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    for (let index = 0; index < 7; index += 1) {
      await repository.saveDailyEntry(createEmptyDailyEntry(addDays(weekStartDate, index)));
    }

    const stored = storedOk();
    vi.mocked(loadLatestWeeklySynthesis).mockResolvedValue(stored);
    const buildSpy = vi
      .spyOn(WeeklySynthesisService.prototype, "buildSynthesis")
      .mockResolvedValue(stored);

    const user = userEvent.setup();
    await renderWithApp(<WeeklyReviewPage />, {
      repository,
      route: "/semaine",
      contextOverrides: { settings: enabledAiSettings() },
    });

    const dateInput = await screen.findByLabelText(/début de semaine/i);
    await user.clear(dateInput);
    await user.type(dateInput, weekStartDate);
    await user.click(screen.getByRole("button", { name: /charger la semaine/i }));
    expect(await screen.findByText("Coach cache")).toBeInTheDocument();
    await waitFor(() => {
      expect(buildSpy).toHaveBeenCalled();
    });
    expect(await screen.findByRole("button", { name: /régénérer/i })).toBeEnabled();
    buildSpy.mockClear();

    const bilanField = screen.getByLabelText(/notes bilan/i);
    await user.type(bilanField, "Semaine solide.");
    await waitFor(async () => {
      await expect(repository.getWeeklyReview(weekStartDate)).resolves.toMatchObject({
        notes: expect.objectContaining({
          bilan: "Semaine solide.",
        }),
      });
    });
    expect(buildSpy).not.toHaveBeenCalled();
  });
});

describe("WeeklyReviewPage mid-week decisions card", () => {
  const WEEK = "2026-08-02";
  const CALENDAR_DAY = "2026-08-20"; // the displayed week is over

  const signal = (
    key: string,
    overrides: Partial<import("../domain/mid-week-review").MidWeekSnapshotSignal> = {},
  ): import("../domain/mid-week-review").MidWeekSnapshotSignal => ({
    key,
    category: "metric",
    label: key,
    direction: "more",
    status: "lagging",
    actual: 8,
    expected: 24,
    weekTarget: 56,
    unit: null,
    daysApplicable: 3,
    daysWithData: 3,
    hasFullCoverage: true,
    ...overrides,
  });

  const seed = async (
    repository: MemoryRepository,
    signals: ReturnType<typeof signal>[] | null,
    decidedOnDate = "2026-08-05",
  ) => {
    await repository.saveMidWeekDecisions({
      weekStartDate: WEEK,
      decisions: "Couper le téléphone le soir",
      decidedOnDate,
      updatedAt: "2026-08-05T10:00:00.000Z",
      ...(signals
        ? {
            laggingSnapshot: {
              version: 1 as const,
              asOfDate: "2026-08-05",
              completedDays: 3,
              signals,
            },
          }
        : {}),
    });
  };

  const seedWeek = async (
    repository: MemoryRepository,
    mutate: (entry: ReturnType<typeof createEmptyDailyEntry>, index: number) => void,
  ) => {
    for (let index = 0; index < 7; index += 1) {
      const entry = createEmptyDailyEntry(addDays(WEEK, index));
      mutate(entry, index);
      await repository.saveDailyEntry(entry);
    }
  };

  const mockRescueTimeEmpty = () => {
    vi.spyOn(RescueTimeGoalsService.prototype, "computeProductivityPulse").mockResolvedValue({
      weekStartDate: WEEK,
      weekEndDate: "2026-08-08",
      pulse: null,
      rescuetimeConfigured: true,
    });
  };

  const renderCard = async (repository: MemoryRepository) =>
    renderWithApp(<WeeklyReviewPage />, {
      repository,
      route: `/semaine?date=${WEEK}`,
      contextOverrides: { calendarDay: CALENDAR_DAY },
    });

  it("shows the empty state with a mid-week link when there is no row", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await renderCard(repository);

    expect(await screen.findByText(/Aucune décision de mi-semaine/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ouvrir la mi-semaine" })).toHaveAttribute(
      "href",
      "/mi-semaine",
    );
  });

  it("shows a read-only decisions text and loads no entries without a snapshot", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await seed(repository, null);
    const withoutSnapshotReads = vi.spyOn(repository, "getDailyEntry");
    const first = await renderCard(repository);

    expect(await screen.findByText("Couper le téléphone le soir")).toBeInTheDocument();
    expect(screen.queryByText("Avant / après")).not.toBeInTheDocument();
    const card = screen.getByRole("region", { name: "Décisions de mi-semaine" });
    expect(within(card).queryByRole("textbox")).not.toBeInTheDocument();
    expect(within(card).getByRole("link", { name: "Ouvrir la mi-semaine" })).toHaveAttribute(
      "href",
      "/mi-semaine",
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    const baseline = withoutSnapshotReads.mock.calls.length;
    first.unmount();

    // Same page with a snapshot: the card adds one read per day of the week on top.
    const withSnapshot = new MemoryRepository();
    await withSnapshot.initialize();
    await seed(withSnapshot, [signal("metric:pomodoris")]);
    mockRescueTimeEmpty();
    const reads = vi.spyOn(withSnapshot, "getDailyEntry");
    await renderCard(withSnapshot);
    await waitFor(() => expect(reads.mock.calls.length).toBeGreaterThanOrEqual(baseline + 7));
  });

  it("surfaces a failed save's draft for the selected week and retries it", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await expect(
      enqueueMidWeekDecisionSave(WEEK, "Texte perdu", async () => {
        throw new Error("disk");
      }),
    ).rejects.toThrow("disk");
    await renderCard(repository);

    const card = await screen.findByRole("region", { name: "Décisions de mi-semaine" });
    expect(await within(card).findByText("Texte perdu")).toBeInTheDocument();
    expect(within(card).getByRole("alert")).toHaveTextContent(/non enregistrées/);

    const user = userEvent.setup();
    await user.click(within(card).getByRole("button", { name: "Réessayer" }));
    await waitFor(() => expect(within(card).queryByRole("alert")).not.toBeInTheDocument());
    expect(within(card).getByText("Texte perdu")).toBeInTheDocument();
    expect((await repository.getMidWeekDecisions(WEEK))?.decisions).toBe("Texte perdu");
  });

  it("shows the week's row when the picker holds a non-Sunday date of that week", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await seed(repository, null);
    await renderCard(repository);
    expect(await screen.findByText("Couper le téléphone le soir")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Début de semaine"), {
      target: { value: "2026-08-05" },
    });

    expect(await screen.findByText("Couper le téléphone le soir")).toBeInTheDocument();
    expect(screen.queryByText("Chargement…")).not.toBeInTheDocument();
  });

  it("waits for a queued mid-week save before reading the row", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    void enqueueMidWeekDecisionSave(WEEK, "En attente", async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      await repository.saveMidWeekDecisions({
        weekStartDate: WEEK,
        decisions: "En attente",
        decidedOnDate: "2026-08-05",
        updatedAt: "2026-08-05T10:00:00.000Z",
      });
    });
    await renderCard(repository);

    expect(await screen.findByText("En attente")).toBeInTheDocument();
    expect(screen.queryByText(/Aucune décision de mi-semaine/)).not.toBeInTheDocument();
  });

  it("shows an error line with a retry, never the empty state, when the read fails", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    vi.spyOn(repository, "getMidWeekDecisions").mockRejectedValueOnce(new Error("boom"));
    await renderCard(repository);

    const card = await screen.findByRole("region", { name: "Décisions de mi-semaine" });
    expect(await within(card).findByRole("alert")).toHaveTextContent(/Impossible de charger/);
    expect(within(card).queryByText(/Aucune décision/)).not.toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Réessayer" })).toBeInTheDocument();
  });

  it("pairs recovered and not-recovered signals, labelling the before side with the snapshot date", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await seedWeek(repository, (entry) => {
      entry.metrics.pomodoris = 8;
      entry.metrics.depenseCalorique = 0;
    });
    await seed(
      repository,
      [
        signal("metric:pomodoris", { label: "Pomodoris" }),
        signal("metric:depenseCalorique", { label: "Calories" }),
      ],
      "2026-08-07",
    );
    mockRescueTimeEmpty();
    await renderCard(repository);

    const card = await screen.findByRole("region", { name: "Décisions de mi-semaine" });
    await waitFor(() => expect(within(card).getByText("Rattrapé")).toBeInTheDocument());
    expect(within(card).getByText("Pas rattrapé")).toBeInTheDocument();
    expect(card.textContent).toContain(`Au ${formatDateLong("2026-08-05")}`);
    expect(card.textContent).not.toContain(`Au ${formatDateLong("2026-08-07")} :`);
  });

  it("shows a dash for a missing key and its own label for an unknown after side", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await seedWeek(repository, () => undefined);
    await seed(repository, [
      signal("rescuetime:99", { label: "Goal supprimé", category: "rescuetime" }),
      signal("principle:respectTrc", { label: "TRC", category: "principle" }),
    ]);
    mockRescueTimeEmpty();
    await renderCard(repository);

    const card = await screen.findByRole("region", { name: "Décisions de mi-semaine" });
    await waitFor(() => expect(within(card).getByText("—")).toBeInTheDocument());
    expect(within(card).getByText("Sans données")).toBeInTheDocument();
  });

  it("adds the coverage caveat and a neutral marker without full coverage, but still credits a 5/5 goal", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await seedWeek(repository, (entry, index) => {
      entry.metrics.qualiteSommeil = index < 3 ? 80 : null;
    });
    await seed(repository, [
      signal("metric:qualiteSommeil", { label: "Sommeil", direction: "quality" }),
      signal("rescuetime:1", { label: "Goal 5 jours", category: "rescuetime" }),
    ]);
    vi.spyOn(RescueTimeGoalsService.prototype, "computeGoalsSnapshot").mockResolvedValue({
      weekStartDate: WEEK,
      weekEndDate: "2026-08-08",
      score: 1,
      totalAchievement: 1,
      items: [
        {
          goalId: 1,
          title: "Goal 5 jours",
          isMore: true,
          actualHours: 10,
          weeklyTargetHours: 10,
          achievement: 1,
          scheduleLabel: "Working hours",
        },
      ],
      rescuetimeConfigured: true,
    });
    mockRescueTimeEmpty();
    await renderCard(repository);

    const card = await screen.findByRole("region", { name: "Décisions de mi-semaine" });
    await waitFor(() =>
      expect(within(card).getByText(/sur 3 \/ 7 jours renseignés/)).toBeInTheDocument(),
    );
    expect(within(card).getAllByText("Rattrapé")).toHaveLength(1);
    expect(within(card).getByText("Sans verdict")).toBeInTheDocument();
  });
});
