import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { defaultAppSettings, createEmptyDailyEntry } from "../domain/daily-entry";
import type { AiProposal, CoachPulseResult } from "../domain/types";
import { CoachPulseService } from "../lib/ai/coach-pulse-service";
import { getTodayDate } from "../lib/date";
import { addDays } from "../lib/gtd/shared";
import { renderWithApp } from "../test/test-utils";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { TodayPage } from "./TodayPage";

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
      move: null
    }),
    bodyText: "Coach",
    deltaClass: null,
    notified: false,
    tokensPrompt: null,
    tokensCompletion: null,
    latencyMs: null,
    createdAt: "2026-08-29T08:00:00.000Z"
  },
  pulse: {
    stance: "open",
    headline: "Coach",
    read: "Lecture",
    move: null
  },
  proposals: [proposal],
  source: "local"
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
      createdAt: "2026-08-29T08:00:00.000Z"
    };

    const coachService = {
      resultFromMessage: vi.fn(async () => buildCoachResult(proposal)),
      buildPulse: vi.fn(async () => buildCoachResult(proposal))
    } as unknown as CoachPulseService;

    await repository.saveAiMessage(buildCoachResult(proposal).message);
    await repository.saveAiProposal(proposal);
    const saveDailyEntry = vi.spyOn(repository, "saveDailyEntry");
    const decideAiProposal = vi.spyOn(repository, "decideAiProposal");

    const user = userEvent.setup();
    await renderWithApp(<TodayPage />, {
      repository,
      contextOverrides: { coachService, settings: defaultAppSettings() }
    });

    await screen.findByText("Focus profond");
    saveDailyEntry.mockClear();

    await user.click(screen.getByRole("button", { name: /accepter/i }));

    expect(await screen.findByDisplayValue("Focus profond")).toBeInTheDocument();
    expect(decideAiProposal).toHaveBeenCalledWith("ai-proposal:intention", "accepted", getTodayDate());
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
      createdAt: "2026-08-29T08:00:00.000Z"
    };

    const coachService = {
      resultFromMessage: vi.fn(async () => buildCoachResult(proposal)),
      buildPulse: vi.fn(async () => buildCoachResult(proposal))
    } as unknown as CoachPulseService;

    await repository.saveAiMessage(buildCoachResult(proposal).message);
    await repository.saveAiProposal(proposal);
    const saveDailyEntry = vi.spyOn(repository, "saveDailyEntry");
    const decideAiProposal = vi.spyOn(repository, "decideAiProposal");

    const user = userEvent.setup();
    await renderWithApp(<TodayPage />, {
      repository,
      contextOverrides: { coachService, settings: defaultAppSettings() }
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
      createdAt: `${today}T09:00:00.000Z`
    });

    await repository.createTask({
      id: "task-completed",
      title: "Action terminee du jour",
      bucket: "next_action",
      createdAt: `${yesterday}T09:00:00.000Z`
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
          createdAt: "2026-08-29T08:00:00.000Z"
        },
        pulse: {
          stance: "open" as const,
          headline: "Local",
          read: "Brief local",
          move: null
        },
        proposals: [],
        source: "local" as const
      }))
    } as unknown as CoachPulseService;

    const user = userEvent.setup();
    await renderWithApp(<TodayPage />, { repository, route: "/", contextOverrides: { coachService } });

    await user.click(await screen.findByRole("button", { name: /ajoutees/i }));
    expect(await screen.findByText("Nouvelle action du jour")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /realisees/i }));
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
          createdAt: "2026-08-29T08:00:00.000Z"
        },
        pulse: {
          stance: "open" as const,
          headline: "Local",
          read: "Brief local",
          move: null
        },
        proposals: [],
        source: "local" as const
      }))
    } as unknown as CoachPulseService;

    const user = userEvent.setup();
    await renderWithApp(<TodayPage />, { repository, route: "/", contextOverrides: { coachService } });

    const field = await screen.findByRole("textbox", { name: /reflection/i });
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
    const saveDailyEntry = vi.spyOn(repository, "saveDailyEntry").mockImplementation(async (entry) => {
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
          createdAt: "2026-08-29T08:00:00.000Z"
        },
        pulse: {
          stance: "open" as const,
          headline: "Local",
          read: "Brief local",
          move: null
        },
        proposals: [],
        source: "local" as const
      }))
    } as unknown as CoachPulseService;

    const user = userEvent.setup();
    await renderWithApp(<TodayPage />, { repository, route: "/", contextOverrides: { coachService } });

    const intention = await screen.findByRole("textbox", { name: /intention/i });
    const reflection = screen.getByRole("textbox", { name: /reflection/i });
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
      { timeout: 3000 }
    );
  });
});
