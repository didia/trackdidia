import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { defaultAppSettings } from "../domain/daily-entry";
import { createEmptyAnnualGoal } from "../domain/annual-goals";
import { GoalPacingService } from "../lib/ai/goal-pacing-service";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { renderWithApp } from "../test/test-utils";
import { AnnualGoalsPage } from "./AnnualGoalsPage";

describe("AnnualGoalsPage", () => {
  it("creates an annual goal and saves a monthly evaluation", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const user = userEvent.setup();

    await renderWithApp(<AnnualGoalsPage />, { repository, route: "/objectifs-annuels" });

    await user.type(await screen.findByLabelText(/^titre$/i), "Discipline annuelle");
    await user.clear(screen.getByLabelText(/cible/i));
    await user.type(screen.getByLabelText(/cible/i), "80");
    await user.type(screen.getByLabelText(/unite/i), "%");
    await user.selectOptions(screen.getByLabelText(/^source$/i), "weekly_discipline");
    await user.click(screen.getByRole("button", { name: /ajouter l'objectif/i }));

    expect((await screen.findAllByText("Discipline annuelle")).length).toBeGreaterThanOrEqual(1);

    const scoreInput = screen.getByLabelText(/score \d{4}-\d{2}/i);
    const evaluationMonthInput = screen.getByLabelText(/mois d'evaluation/i) as HTMLInputElement;
    const evaluationMonthKey = evaluationMonthInput.value;
    await user.clear(scoreInput);
    await user.type(scoreInput, "72");
    await user.tab();

    await waitFor(async () => {
      const goals = await repository.listAnnualGoals();
      expect(goals[0].evaluations[evaluationMonthKey]).toMatchObject({
        score: 72
      });
    });
  });

  it("does not run pacing while the year field is an incomplete value", async () => {
    const buildPacingSpy = vi.spyOn(GoalPacingService.prototype, "buildPacing");
    const repository = new MemoryRepository();
    await repository.initialize();

    await renderWithApp(<AnnualGoalsPage />, {
      repository,
      route: "/objectifs-annuels",
      contextOverrides: {
        settings: {
          ...defaultAppSettings(),
          aiEnabled: false
        }
      }
    });

    await screen.findByLabelText(/^annee$/i);
    await waitFor(() => {
      expect(buildPacingSpy).toHaveBeenCalledTimes(1);
    });
    const initialCalls = buildPacingSpy.mock.calls.length;

    const yearInput = screen.getByLabelText(/^annee$/i);
    fireEvent.change(yearInput, { target: { value: "202" } });

    await waitFor(() => {
      expect(buildPacingSpy.mock.calls.length).toBe(initialCalls);
    });

    buildPacingSpy.mockRestore();
  });

  it("clears pacing from the previous year when the year changes", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveAnnualGoal(
      createEmptyAnnualGoal({
        id: "goal-2026",
        title: "Objectif 2026",
        targetValue: 100,
        manualCurrentValue: 80,
        unit: "%"
      })
    );

    await renderWithApp(<AnnualGoalsPage />, {
      repository,
      route: "/objectifs-annuels",
      contextOverrides: { settings: { ...defaultAppSettings(), aiEnabled: false } }
    });

    await waitFor(() => {
      expect(screen.getByText(/dans les clous|hors rythme/i)).toBeInTheDocument();
    });

    const yearInput = screen.getByLabelText(/^annee$/i);
    fireEvent.change(yearInput, { target: { value: "2025" } });

    await waitFor(() => {
      expect(screen.queryByText(/dans les clous|hors rythme/i)).not.toBeInTheDocument();
    });
  });
});
