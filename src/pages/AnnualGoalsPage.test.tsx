import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

    expect(await screen.findByText("Discipline annuelle")).toBeInTheDocument();

    const scoreInput = screen.getByLabelText(/score \d{4}-\d{2}/i);
    await user.clear(scoreInput);
    await user.type(scoreInput, "72");
    await user.tab();

    await waitFor(async () => {
      const goals = await repository.listAnnualGoals();
      expect(goals[0].evaluations["2026-04"]).toMatchObject({
        score: 72
      });
    });
  });
});
