import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createEmptyDailyEntry } from "../domain/daily-entry";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { formatPercent } from "../lib/format";
import { RescueTimeGoalsService } from "../lib/rescuetime/rescuetime-goals-service";
import { renderWithApp } from "../test/test-utils";
import { WeeklyReviewPage } from "./WeeklyReviewPage";

describe("WeeklyReviewPage", () => {
  const originalFetch = globalThis.fetch;

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

    expect(await screen.findByText("Objectifs de la semaine")).toBeInTheDocument();

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

    await waitFor(() => {
      const scoreCard = screen.getAllByText("Score hebdo")[0].closest("article");
      expect(scoreCard?.querySelector("strong")?.textContent).not.toBe(formatPercent(localSummary.weeklyScore));
    });

    expect(localSummary.weeklyScore).toBeLessThan(0.5);
  });
});
