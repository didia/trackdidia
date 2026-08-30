import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { defaultAppSettings } from "../domain/daily-entry";
import type { AiProposal, CoachPulseResult } from "../domain/types";
import { CoachPulseService } from "../lib/ai/coach-pulse-service";
import { getTodayDate } from "../lib/date";
import { renderWithApp } from "../test/test-utils";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { EveningClosurePage } from "./EveningClosurePage";

const buildCoachResult = (proposal: AiProposal): CoachPulseResult => ({
  message: {
    id: "ai-message:close",
    surface: "coach_pulse",
    scopeKey: `${getTodayDate()}#close`,
    stance: "close",
    kind: "close",
    inputHash: "hash-close",
    promptVersion: "coach_pulse.v1",
    model: "local",
    status: "skipped",
    bodyJson: JSON.stringify({
      stance: "close",
      headline: "Cloture",
      read: "Lecture",
      move: null,
      tomorrowFocusDraft: "Dormir tot"
    }),
    bodyText: "Cloture",
    deltaClass: null,
    notified: false,
    tokensPrompt: null,
    tokensCompletion: null,
    latencyMs: null,
    createdAt: "2026-08-29T20:00:00.000Z"
  },
  pulse: {
    stance: "close",
    headline: "Cloture",
    read: "Lecture",
    move: null,
    tomorrowFocusDraft: "Dormir tot"
  },
  proposals: [proposal],
  source: "local"
});

describe("EveningClosurePage coach proposals", () => {
  it("prefills and saves tomorrow focus on accept", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    const proposal: AiProposal = {
      id: "ai-proposal:tomorrow",
      messageId: "ai-message:close",
      type: "tomorrow_focus_draft",
      payloadJson: JSON.stringify({ text: "Preparer la presentation" }),
      status: "pending",
      appliedEntityId: null,
      decidedAt: null,
      createdAt: "2026-08-29T20:00:00.000Z"
    };

    const coachService = {
      buildPulse: vi.fn(async () => buildCoachResult(proposal))
    } as unknown as CoachPulseService;

    await repository.saveAiProposal(proposal);
    const saveDailyEntry = vi.spyOn(repository, "saveDailyEntry");
    const decideAiProposal = vi.spyOn(repository, "decideAiProposal");

    const user = userEvent.setup();
    await renderWithApp(<EveningClosurePage />, {
      repository,
      route: "/fermeture-soir",
      contextOverrides: { coachService, settings: defaultAppSettings() }
    });

    await screen.findByText("Preparer la presentation");
    saveDailyEntry.mockClear();

    await user.click(screen.getByRole("button", { name: /accepter/i }));

    expect(await screen.findByDisplayValue("Preparer la presentation")).toBeInTheDocument();
    expect(decideAiProposal).toHaveBeenCalledWith("ai-proposal:tomorrow", "accepted", getTodayDate());
    expect(saveDailyEntry).toHaveBeenCalled();
  });

  it("records dismissed proposals without saving the daily entry", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    const proposal: AiProposal = {
      id: "ai-proposal:tomorrow",
      messageId: "ai-message:close",
      type: "tomorrow_focus_draft",
      payloadJson: JSON.stringify({ text: "Preparer la presentation" }),
      status: "pending",
      appliedEntityId: null,
      decidedAt: null,
      createdAt: "2026-08-29T20:00:00.000Z"
    };

    const coachService = {
      buildPulse: vi.fn(async () => buildCoachResult(proposal))
    } as unknown as CoachPulseService;

    await repository.saveAiProposal(proposal);
    const saveDailyEntry = vi.spyOn(repository, "saveDailyEntry");
    const decideAiProposal = vi.spyOn(repository, "decideAiProposal");

    const user = userEvent.setup();
    await renderWithApp(<EveningClosurePage />, {
      repository,
      route: "/fermeture-soir",
      contextOverrides: { coachService, settings: defaultAppSettings() }
    });

    await screen.findByText("Preparer la presentation");
    saveDailyEntry.mockClear();

    await user.click(screen.getByRole("button", { name: /ignorer/i }));

    await waitFor(() => {
      expect(decideAiProposal).toHaveBeenCalledWith("ai-proposal:tomorrow", "dismissed");
    });
    expect(saveDailyEntry).not.toHaveBeenCalled();
  });
});
