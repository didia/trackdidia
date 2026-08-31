import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, vi } from "vitest";
import { createEmptyDailyEntry, defaultAppSettings } from "../domain/daily-entry";
import { createEmptyAnnualGoal } from "../domain/annual-goals";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { loadLatestMonthlySynthesis } from "../lib/ai/monthly-synthesis-loader";
import { MonthlySynthesisService } from "../lib/ai/monthly-synthesis-service";
import type { AiProvider } from "../lib/ai/provider";
import { renderWithApp } from "../test/test-utils";
import { MonthlyReviewPage } from "./MonthlyReviewPage";

const mockBuildSynthesisPreferStored = () => {
  const buildSynthesis = MonthlySynthesisService.prototype.buildSynthesis;
  vi.spyOn(MonthlySynthesisService.prototype, "buildSynthesis").mockImplementation(async (repository, request) => {
    const loaderService = new MonthlySynthesisService({ generateStructured: vi.fn() } as unknown as AiProvider);
    const stored = await loadLatestMonthlySynthesis(repository, loaderService, request.monthKey);
    if (stored) {
      return stored;
    }
    return buildSynthesis.call(new MonthlySynthesisService({ generateStructured: vi.fn() } as unknown as AiProvider), repository, request);
  });
};

describe("MonthlyReviewPage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it("dismisses a goal evaluation proposal when the goal no longer exists", async () => {
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

    await repository.deleteAnnualGoal("goal-monthly");

    const proposalText = screen.getByText(/\[goal-monthly\]/i);
    const proposal = proposalText.closest("article");
    expect(proposal).not.toBeNull();
    await user.click(within(proposal!).getByRole("button", { name: /accepter/i }));

    await waitFor(() => {
      expect(screen.getByText(/objectif introuvable, suggestion ignoree/i)).toBeInTheDocument();
    });

    const messages = await repository.listAiMessages("monthly_synthesis");
    const proposals = await repository.listAiProposals(messages[0].id);
    expect(proposals.find((item) => item.type === "goal_evaluation")?.status).toBe("dismissed");
  });

  it("persists a section draft into the monthly review on accept", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    for (const date of ["2026-04-01", "2026-04-02"]) {
      const entry = createEmptyDailyEntry(date);
      entry.metrics.pomodoris = 4;
      await repository.saveDailyEntry(entry);
    }

    const message = {
      id: "ai-message-monthly",
      surface: "monthly_synthesis" as const,
      scopeKey: "2026-04",
      stance: null,
      kind: "monthly",
      inputHash: "hash",
      promptVersion: "monthly_synthesis.v1",
      model: "local",
      status: "skipped" as const,
      bodyJson: JSON.stringify({
        headline: "Mois solide",
        weekPattern: "Rythme stable",
        sectionDrafts: { bilan: "Brouillon coach mensuel" },
        goalEvaluationDrafts: []
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
      id: "proposal-section-monthly",
      messageId: message.id,
      type: "review_section_draft" as const,
      payloadJson: JSON.stringify({ sectionKey: "bilan", text: "Brouillon coach mensuel" }),
      status: "pending" as const,
      appliedEntityId: null,
      decidedAt: null,
      createdAt: new Date().toISOString()
    };
    await repository.saveAiMessage(message);
    await repository.saveAiProposal(proposal);
    mockBuildSynthesisPreferStored();

    const user = userEvent.setup();
    await renderWithApp(<MonthlyReviewPage />, { repository, route: "/mois" });

    const monthInput = await screen.findByLabelText(/mois a relire/i);
    await user.clear(monthInput);
    await user.type(monthInput, "2026-04");
    await user.click(screen.getByRole("button", { name: /charger le mois/i }));

    expect(await screen.findByRole("heading", { name: /coach mensuel/i })).toBeInTheDocument();
    const acceptButtons = await screen.findAllByRole("button", { name: /^accepter$/i });
    await user.click(acceptButtons[0]);

    await waitFor(() => {
      expect(screen.getByLabelText(/notes bilan/i)).toHaveValue("Brouillon coach mensuel");
    });

    await waitFor(async () => {
      await expect(repository.getMonthlyReview("2026-04")).resolves.toMatchObject({
        notes: expect.objectContaining({
          bilan: "Brouillon coach mensuel"
        })
      });
    });
  });

  it("persists and accepts a local section draft when AI is off", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    for (const date of ["2026-04-01", "2026-04-02"]) {
      await repository.saveDailyEntry(createEmptyDailyEntry(date));
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
      expect(screen.getAllByRole("button", { name: /^accepter$/i }).length).toBeGreaterThan(0);
    });

    const acceptButtons = screen.getAllByRole("button", { name: /^accepter$/i });
    await user.click(acceptButtons[0]);

    await waitFor(async () => {
      const messages = await repository.listAiMessages("monthly_synthesis");
      expect(messages.length).toBeGreaterThan(0);
      const proposals = await repository.listAiProposals(messages[0].id);
      expect(proposals.some((item) => item.type === "review_section_draft" && item.status === "accepted")).toBe(true);
      await expect(repository.getMonthlyReview("2026-04")).resolves.toMatchObject({
        notes: expect.objectContaining({
          bilan: expect.any(String)
        })
      });
    });
  });

  it("clears synthesis from the previous month when the month changes", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    for (const date of ["2026-04-01", "2026-05-01"]) {
      await repository.saveDailyEntry(createEmptyDailyEntry(date));
    }

    let releaseApril: () => void = () => undefined;
    const aprilBlocked = new Promise<void>((resolve) => {
      releaseApril = resolve;
    });

    const buildSynthesis = MonthlySynthesisService.prototype.buildSynthesis;
    vi.spyOn(MonthlySynthesisService.prototype, "buildSynthesis").mockImplementation(async (repository, request) => {
      if (request.monthKey === "2026-04") {
        await aprilBlocked;
        return {
          message: {
            id: "ai-message-april-delayed",
            surface: "monthly_synthesis",
            scopeKey: "2026-04",
            stance: null,
            kind: "monthly",
            inputHash: "hash-april",
            promptVersion: "monthly_synthesis.v1",
            model: "local",
            status: "skipped",
            bodyJson: JSON.stringify({
              headline: "Headline Avril Unique",
              weekPattern: "Avril",
              sectionDrafts: {},
              goalEvaluationDrafts: []
            }),
            bodyText: "Avril",
            deltaClass: null,
            notified: false,
            tokensPrompt: null,
            tokensCompletion: null,
            latencyMs: null,
            createdAt: "2026-04-01T08:00:00.000Z"
          },
          synthesis: {
            headline: "Headline Avril Unique",
            weekPattern: "Avril",
            sectionDrafts: {},
            goalEvaluationDrafts: []
          },
          proposals: [],
          source: "local"
        };
      }

      return buildSynthesis.call(new MonthlySynthesisService({ generateStructured: vi.fn() } as unknown as AiProvider), repository, request);
    });

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

    expect(await screen.findByText("Preparation de la synthese...")).toBeInTheDocument();

    const mayInput = screen.getByLabelText(/mois a relire/i);
    fireEvent.change(mayInput, { target: { value: "2026-05" } });
    await waitFor(() => {
      expect(mayInput).toHaveValue("2026-05");
    });
    await user.click(screen.getByRole("button", { name: /charger le mois/i }));

    releaseApril();

    await waitFor(() => {
      expect(screen.queryByText("Headline Avril Unique")).not.toBeInTheDocument();
    });
  });
});
