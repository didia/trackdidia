import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createEmptyDailyEntry, defaultAppSettings } from "../domain/daily-entry";
import type { AiProposal, AppSettings, CoachPulseResult } from "../domain/types";
import { CoachPulseService } from "../lib/ai/coach-pulse-service";
import { stringifyCommitmentDetail } from "../lib/ai/memory/detail";
import { getTodayDate } from "../lib/date";
import { renderWithApp } from "../test/test-utils";
import { MemoryRepository } from "../lib/storage/memory-repository";
import { EveningClosurePage } from "./EveningClosurePage";

const today = getTodayDate();

const enabledAiSettings = (): AppSettings => {
  const settings = defaultAppSettings();
  settings.aiEnabled = true;
  settings.aiApiKey = "secret";
  return settings;
};

const buildCoachResult = (proposal: AiProposal, status: CoachPulseResult["message"]["status"] = "ok"): CoachPulseResult => ({
  message: {
    id: "ai-message:close",
    surface: "coach_pulse",
    scopeKey: `${today}#close`,
    stance: "close",
    kind: "close",
    inputHash: "hash-close",
    promptVersion: "coach_pulse.v1",
    model: "local",
    status,
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
  source: status === "ok" ? "cache" : "local"
});

const tomorrowProposal = (): AiProposal => ({
  id: "ai-proposal:tomorrow",
  messageId: "ai-message:close",
  type: "tomorrow_focus_draft",
  payloadJson: JSON.stringify({ text: "Preparer la presentation" }),
  status: "pending",
  appliedEntityId: null,
  decidedAt: null,
  createdAt: "2026-08-29T20:00:00.000Z"
});

describe("EveningClosurePage coach proposals", () => {
  it("prefills and saves tomorrow focus on accept", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const proposal = tomorrowProposal();
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
    expect(decideAiProposal).toHaveBeenCalledWith("ai-proposal:tomorrow", "accepted", today);
    expect(saveDailyEntry).toHaveBeenCalled();
  });

  it("records dismissed proposals without saving the daily entry", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const proposal = tomorrowProposal();
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

  it("shows a stored ok close pulse when AI is off without calling the model", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const proposal = tomorrowProposal();
    const stored = buildCoachResult(proposal);
    await repository.saveAiMessage(stored.message);
    await repository.saveAiProposal(proposal);

    const coachService = {
      resultFromMessage: vi.fn(async () => stored),
      buildPulse: vi.fn(async () => stored)
    } as unknown as CoachPulseService;

    await renderWithApp(<EveningClosurePage />, {
      repository,
      route: "/fermeture-soir",
      contextOverrides: { coachService, settings: defaultAppSettings() }
    });

    expect(await screen.findByText("Cloture")).toBeInTheDocument();
    expect(await screen.findByText("Preparer la presentation")).toBeInTheDocument();
    expect(coachService.buildPulse).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /demander au coach/i })).not.toBeInTheDocument();
    expect(screen.getByText("Active l'IA dans les paramètres")).toBeInTheDocument();
  });

  it("still hash-checks an ok close pulse when AI is configured", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const proposal = tomorrowProposal();
    const stored = buildCoachResult(proposal);
    await repository.saveAiMessage(stored.message);
    await repository.saveAiProposal(proposal);

    const coachService = {
      resultFromMessage: vi.fn(async () => stored),
      buildPulse: vi.fn(async () => stored)
    } as unknown as CoachPulseService;

    await renderWithApp(<EveningClosurePage />, {
      repository,
      route: "/fermeture-soir",
      contextOverrides: { coachService, settings: enabledAiSettings() }
    });

    expect(await screen.findByText("Cloture")).toBeInTheDocument();
    await waitFor(() => {
      expect(coachService.buildPulse).toHaveBeenCalledOnce();
    });
    expect(coachService.buildPulse).toHaveBeenCalledWith(
      repository,
      expect.objectContaining({
        stance: "close",
        trigger: "auto",
        snapshotInputs: expect.objectContaining({ productivityPulseWeekToDate: null })
      })
    );
  });

  it("retries after a persisted fallback close pulse", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const proposal = tomorrowProposal();
    const fallback = buildCoachResult(proposal, "fallback");
    await repository.saveAiMessage(fallback.message);
    await repository.saveAiProposal(proposal);

    const coachService = {
      resultFromMessage: vi.fn(async () => fallback),
      buildPulse: vi.fn(async () => buildCoachResult(proposal))
    } as unknown as CoachPulseService;

    await renderWithApp(<EveningClosurePage />, {
      repository,
      route: "/fermeture-soir",
      contextOverrides: { coachService, settings: enabledAiSettings() }
    });

    await waitFor(() => {
      expect(coachService.buildPulse).toHaveBeenCalledOnce();
    });
    expect(coachService.resultFromMessage).not.toHaveBeenCalled();
  });

  it("resolves due commitments on open when AI is disabled", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const proposal = tomorrowProposal();
    await repository.saveAiMemory({
      id: "ai-memory:commitment",
      kind: "commitment",
      statement: "8 pomodoros",
      detail: stringifyCommitmentDetail({ metricKey: "pomodoris", target: 8 }),
      confidence: 1,
      source: "ai_extracted",
      status: "active",
      evidenceFrom: null,
      evidenceTo: null,
      createdAt: "2026-08-28T20:00:00.000Z",
      lastConfirmedAt: "2026-08-28T20:00:00.000Z",
      expiresAt: today,
      pinned: false
    });
    await repository.saveDailyEntry(createEmptyDailyEntry(today));

    const coachService = {
      buildPulse: vi.fn(async () => buildCoachResult(proposal))
    } as unknown as CoachPulseService;

    await renderWithApp(<EveningClosurePage />, {
      repository,
      route: "/fermeture-soir",
      contextOverrides: { coachService, settings: defaultAppSettings() }
    });

    await screen.findByText("Preparer la presentation");

    const archived = await repository.listAiMemories({ status: "archived", kind: "commitment" });
    expect(archived).toHaveLength(1);
    expect(archived[0]?.detail.match(/\[resolved:/g)).toHaveLength(1);
    await expect(repository.listAiMemories({ status: "active", kind: "commitment" })).resolves.toHaveLength(0);
  });
});
