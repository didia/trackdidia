import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createEmptyAnnualGoal } from "../domain/annual-goals";
import { defaultAppSettings } from "../domain/daily-entry";
import { GoalPacingService } from "../lib/ai/goal-pacing-service";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { renderWithApp } from "../test/test-utils";
import { AnnualGoalsPage } from "./AnnualGoalsPage";

/** The goal pacing panel also renders the goal title, so scope lookups to the `.goal-card`. */
const findGoalCard = async (title: string): Promise<HTMLElement> => {
  const matches = await screen.findAllByText(title);
  const card = matches
    .map((element) => element.closest("article.goal-card"))
    .find((element): element is HTMLElement => element !== null);
  if (!card) {
    throw new Error(`No .goal-card found for "${title}"`);
  }
  return card;
};

describe("AnnualGoalsPage", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates an annual goal and saves a monthly evaluation", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const user = userEvent.setup();

    await renderWithApp(<AnnualGoalsPage />, { repository, route: "/objectifs-annuels" });

    await user.type(await screen.findByLabelText(/^titre$/i), "Discipline annuelle");
    await user.clear(screen.getByLabelText(/cible/i));
    await user.type(screen.getByLabelText(/cible/i), "80");
    await user.type(screen.getByLabelText(/unité/i), "%");
    await user.selectOptions(screen.getByLabelText(/^source$/i), "weekly_discipline");
    await user.click(screen.getByRole("button", { name: /ajouter l'objectif/i }));

    expect((await screen.findAllByText("Discipline annuelle")).length).toBeGreaterThanOrEqual(1);

    const scoreInput = screen.getByLabelText(/score \d{4}-\d{2}/i);
    const evaluationMonthInput = screen.getByLabelText(/mois d'évaluation/i) as HTMLInputElement;
    const evaluationMonthKey = evaluationMonthInput.value;
    await user.clear(scoreInput);
    await user.type(scoreInput, "72");
    await user.tab();

    await waitFor(async () => {
      const goals = await repository.listAnnualGoals();
      expect(goals[0].evaluations[evaluationMonthKey]).toMatchObject({
        score: 72,
      });
    });
  });

  it("does not remount the page while autosaving a monthly evaluation", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveAnnualGoal(
      createEmptyAnnualGoal({
        id: "goal-autosave",
        title: "Discipline autosave",
        targetValue: 100,
        manualCurrentValue: 80,
        unit: "%",
      }),
    );
    const user = userEvent.setup();

    await renderWithApp(<AnnualGoalsPage />, {
      repository,
      route: "/objectifs-annuels",
      contextOverrides: { settings: { ...defaultAppSettings(), aiEnabled: false } },
    });

    const notesField = await screen.findByLabelText(/notes/i);
    await user.click(notesField);
    await user.type(notesField, "Semaine correcte");

    await waitFor(async () => {
      const goals = await repository.listAnnualGoals();
      const evaluationMonthKey = Object.keys(goals[0].evaluations)[0];
      expect(goals[0].evaluations[evaluationMonthKey]?.notes).toBe("Semaine correcte");
    });

    expect(screen.queryByText(/^chargement/i)).not.toBeInTheDocument();
    expect(notesField).toHaveValue("Semaine correcte");
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
          aiEnabled: false,
        },
      },
    });

    await screen.findByLabelText(/^année$/i);
    await waitFor(() => {
      expect(buildPacingSpy).toHaveBeenCalledTimes(1);
    });
    const initialCalls = buildPacingSpy.mock.calls.length;

    const yearInput = screen.getByLabelText(/^année$/i);
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
        unit: "%",
      }),
    );

    await renderWithApp(<AnnualGoalsPage />, {
      repository,
      route: "/objectifs-annuels",
      contextOverrides: { settings: { ...defaultAppSettings(), aiEnabled: false } },
    });

    await waitFor(() => {
      expect(screen.getByText(/dans les clous|hors rythme/i)).toBeInTheDocument();
    });

    const yearInput = screen.getByLabelText(/^année$/i);
    fireEvent.change(yearInput, { target: { value: "2025" } });

    await waitFor(() => {
      expect(screen.queryByText(/dans les clous|hors rythme/i)).not.toBeInTheDocument();
    });
  });

  it("shows stored ok pacing on auto-load then hash-checks", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveAnnualGoal(
      createEmptyAnnualGoal({
        id: "goal-1",
        title: "Discipline",
        targetValue: 100,
        manualCurrentValue: 80,
        unit: "%",
      }),
    );

    const year = new Date().getFullYear();
    const message = {
      id: "ai-message-pacing-ok",
      surface: "goal_pacing" as const,
      scopeKey: String(year),
      stance: null,
      kind: "annual",
      inputHash: "hash-ok",
      promptVersion: "goal_pacing.v1",
      model: "test-model",
      status: "ok" as const,
      bodyJson: JSON.stringify({
        goals: [
          {
            goalId: "goal-1",
            onPace: true,
            gap: "Ecart cache",
            requiredWeeklyBehaviour: "Focus",
            riskLevel: "low",
            recommendation: "Continuer",
          },
        ],
      }),
      bodyText: "Ecart cache",
      deltaClass: null,
      notified: false,
      tokensPrompt: 1,
      tokensCompletion: 2,
      latencyMs: 3,
      createdAt: "2026-08-29T12:00:00.000Z",
    };
    await repository.saveAiMessage(message);

    const stored = {
      message,
      pacing: {
        goals: [
          {
            goalId: "goal-1",
            onPace: true,
            gap: "Ecart cache",
            requiredWeeklyBehaviour: "Focus",
            riskLevel: "low" as const,
            recommendation: "Continuer",
          },
        ],
      },
      source: "cache" as const,
    };
    const fresh = {
      ...stored,
      pacing: {
        goals: [{ ...stored.pacing.goals[0], gap: "Frais" }],
      },
      source: "ai" as const,
    };
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const buildSpy = vi
      .spyOn(GoalPacingService.prototype, "buildPacing")
      .mockImplementation(async () => {
        await blocked;
        return fresh;
      });

    await renderWithApp(<AnnualGoalsPage />, {
      repository,
      route: "/objectifs-annuels",
      contextOverrides: {
        settings: { ...defaultAppSettings(), aiEnabled: true, aiApiKey: "secret" },
      },
    });

    expect(await screen.findByText("Ecart cache")).toBeInTheDocument();
    expect(screen.queryByText("Frais")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(buildSpy).toHaveBeenCalledWith(
        repository,
        expect.objectContaining({
          year,
          trigger: "auto",
        }),
      );
    });
    release();
    expect(await screen.findByText("Frais")).toBeInTheDocument();
    buildSpy.mockRestore();
  });

  it("logs a cumulative increment and shows a running monthly total", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveAnnualGoal(
      createEmptyAnnualGoal({
        id: "goal-books",
        title: "Lire des livres",
        measurementType: "cumulative",
        targetValue: 24,
        unit: "livres",
      }),
    );

    await renderWithApp(<AnnualGoalsPage />, {
      repository,
      route: "/objectifs-annuels",
      contextOverrides: { settings: { ...defaultAppSettings(), aiEnabled: false } },
    });

    // Pin the pilot year so the 12-month log editor is deterministic regardless of the real date.
    const yearInput = await screen.findByLabelText(/^année$/i);
    fireEvent.change(yearInput, { target: { value: "2026" } });

    const card = await findGoalCard("Lire des livres");

    const januaryInput = within(card).getByLabelText("Incrément 2026-01");
    fireEvent.change(januaryInput, { target: { value: "2" } });
    fireEvent.blur(januaryInput);

    await waitFor(async () => {
      const goals = await repository.listAnnualGoals();
      expect(goals[0].progressLog["2026-01"]).toBe(2);
    });

    const updatedCard = await findGoalCard("Lire des livres");
    const februaryInput = within(updatedCard).getByLabelText("Incrément 2026-02");
    fireEvent.change(februaryInput, { target: { value: "3" } });
    fireEvent.blur(februaryInput);

    await waitFor(async () => {
      const goals = await repository.listAnnualGoals();
      expect(goals[0].progressLog["2026-02"]).toBe(3);
    });

    const finalCard = await findGoalCard("Lire des livres");
    const finalFebruaryInput = within(finalCard).getByLabelText("Incrément 2026-02");
    const februaryPill = finalFebruaryInput.closest("article.goal-progress-pill") as HTMLElement;
    // The running total for February should reflect January + February (2 + 3 = 5).
    expect(within(februaryPill).getByText("5")).toBeInTheDocument();
  });

  it("adds and completes a milestone, and hides an achieved goal from the default list", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveAnnualGoal(
      createEmptyAnnualGoal({
        id: "goal-binary",
        title: "Lancer le produit",
        measurementType: "binary",
      }),
    );

    await renderWithApp(<AnnualGoalsPage />, {
      repository,
      route: "/objectifs-annuels",
      contextOverrides: { settings: { ...defaultAppSettings(), aiEnabled: false } },
    });

    const user = userEvent.setup();
    const card = await findGoalCard("Lancer le produit");

    await user.type(within(card).getByPlaceholderText("Nouveau jalon"), "MVP livré");
    await user.click(within(card).getByRole("button", { name: /^ajouter$/i }));

    await waitFor(async () => {
      const goals = await repository.listAnnualGoals();
      expect(goals[0].milestones).toHaveLength(1);
      expect(goals[0].milestones[0]).toMatchObject({ title: "MVP livré", completedAt: null });
    });

    const cardWithMilestone = await findGoalCard("Lancer le produit");
    await user.click(within(cardWithMilestone).getByRole("checkbox", { name: "MVP livré" }));

    await waitFor(async () => {
      const goals = await repository.listAnnualGoals();
      expect(goals[0].milestones[0].completedAt).not.toBeNull();
    });

    const cardBeforeStatusChange = await findGoalCard("Lancer le produit");
    const statusSelect = within(cardBeforeStatusChange).getByLabelText(/^statut$/i);
    fireEvent.change(statusSelect, { target: { value: "achieved" } });
    await user.click(
      within(cardBeforeStatusChange).getByRole("button", { name: /^enregistrer$/i }),
    );

    await waitFor(async () => {
      const goals = await repository.listAnnualGoals();
      expect(goals[0].status).toBe("achieved");
    });

    // Only the active-goals list should hide it — the pacing panel keeps its own snapshot.
    await waitFor(() => {
      const goalList = document.querySelector(".goal-list") as HTMLElement;
      expect(within(goalList).queryByText("Lancer le produit")).not.toBeInTheDocument();
    });
  });
});
