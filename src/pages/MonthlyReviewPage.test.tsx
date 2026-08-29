import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createEmptyDailyEntry, defaultAppSettings } from "../domain/daily-entry";
import { createEmptyAnnualGoal } from "../domain/annual-goals";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { renderWithApp } from "../test/test-utils";
import { MonthlyReviewPage } from "./MonthlyReviewPage";

describe("MonthlyReviewPage", () => {
  it("loads a month and saves ritual notes", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    for (const date of ["2026-04-01", "2026-04-02"]) {
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
    await renderWithApp(<MonthlyReviewPage />, { repository, route: "/mois" });

    const monthInput = await screen.findByLabelText(/mois a relire/i);
    await user.clear(monthInput);
    await user.type(monthInput, "2026-04");
    await user.click(screen.getByRole("button", { name: /charger le mois/i }));

    const notesField = await screen.findByLabelText(/notes bilan/i);
    await user.type(notesField, "Mois intense.");

    await waitFor(async () => {
      await expect(repository.getMonthlyReview("2026-04")).resolves.toMatchObject({
        notes: expect.objectContaining({
          bilan: "Mois intense."
        })
      });
    });
  });

  it("accepts a goal evaluation proposal from the monthly coach", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveAnnualGoal(
      createEmptyAnnualGoal({
        id: "goal-monthly",
        title: "Discipline",
        targetValue: 100,
        manualCurrentValue: 75,
        unit: "%"
      })
    );

    for (const date of ["2026-04-01", "2026-04-02"]) {
      const entry = createEmptyDailyEntry(date);
      entry.metrics.pomodoris = 4;
      await repository.saveDailyEntry(entry);
    }

    const user = userEvent.setup();
    await renderWithApp(<MonthlyReviewPage />, {
      repository,
      route: "/mois",
      contextOverrides: { settings: { ...defaultAppSettings(), aiEnabled: false } }
    });

    const monthInput = await screen.findByLabelText(/mois a relire/i);
    await user.clear(monthInput);
    await user.type(monthInput, "2026-04");
    await user.click(screen.getByRole("button", { name: /charger le mois/i }));

    await waitFor(() => {
      expect(screen.getByText(/\[goal-monthly\]/i)).toBeInTheDocument();
    });

    const proposalText = screen.getByText(/\[goal-monthly\]/i);
    const proposal = proposalText.closest("article");
    expect(proposal).not.toBeNull();
    await user.click(within(proposal!).getByRole("button", { name: /accepter/i }));

    await waitFor(async () => {
      const goal = (await repository.listAnnualGoals()).find((item) => item.id === "goal-monthly");
      expect(goal?.evaluations["2026-04"]?.score).toBe(75);
      expect(Object.keys(goal?.evaluations ?? {})).toEqual(["2026-04"]);
    });
  });
});
