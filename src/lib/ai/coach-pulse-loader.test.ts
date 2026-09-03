import { createEmptyDailyEntry } from "../../domain/daily-entry";
import type { AiMessage, CoachPulseResult } from "../../domain/types";
import { getTodayDate } from "../date";
import { MemoryRepository } from "../storage/memory-repository";
import {
  latestClosePulseMessage,
  latestScheduledPulseMessage,
  loadLatestClosePulseForDate,
  loadLatestCoachPulseForDate
} from "./coach-pulse-loader";
import { CoachPulseService } from "./coach-pulse-service";

const today = getTodayDate();

const pulseBody = (stance: AiMessage["stance"], headline: string) =>
  JSON.stringify({
    stance,
    headline,
    read: "Lecture",
    move: null
  });

const message = (
  id: string,
  stance: NonNullable<AiMessage["stance"]>,
  createdAt: string,
  headline: string
): AiMessage => ({
  id,
  surface: "coach_pulse",
  scopeKey: stance === "open" ? today : `${today}#${stance === "close" ? "close" : "13"}`,
  stance,
  kind: stance,
  inputHash: `hash-${id}`,
  promptVersion: "coach_pulse.v1",
  model: "local",
  status: "ok",
  bodyJson: pulseBody(stance, headline),
  bodyText: headline,
  deltaClass: null,
  notified: false,
  tokensPrompt: null,
  tokensCompletion: null,
  latencyMs: null,
  createdAt
});

const resultFrom = (stored: AiMessage): CoachPulseResult => ({
  message: stored,
  pulse: JSON.parse(stored.bodyJson ?? "{}"),
  proposals: [],
  source: "cache"
});

describe("coach-pulse-loader", () => {
  it("ignores evening close when loading the scheduled Today pulse", () => {
    const close = message("ai-message:close", "close", "2026-08-29T20:00:00.000Z", "Cloture");
    const steer = message("ai-message:steer", "steer", "2026-08-29T13:00:00.000Z", "Mi-journee");

    expect(latestScheduledPulseMessage([close, steer])?.id).toBe("ai-message:steer");
    expect(latestClosePulseMessage([close, steer])?.id).toBe("ai-message:close");
  });

  it("hydrates a persisted close pulse without going through buildPulse", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const close = message("ai-message:close", "close", "2026-08-29T20:00:00.000Z", "Cloture");
    await repository.saveAiMessage(close);

    const coachService = {
      resultFromMessage: vi.fn(async (_repo: unknown, stored: AiMessage) => resultFrom(stored)),
      buildPulse: vi.fn()
    } as unknown as CoachPulseService;

    const loaded = await loadLatestClosePulseForDate(
      repository,
      coachService,
      today,
      createEmptyDailyEntry(today)
    );

    expect(loaded?.pulse.headline).toBe("Cloture");
    expect(coachService.resultFromMessage).toHaveBeenCalledOnce();
    expect(coachService.buildPulse).not.toHaveBeenCalled();
  });

  it("does not treat a close pulse as the Today scheduled thread", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveAiMessage(message("ai-message:close", "close", "2026-08-29T20:00:00.000Z", "Cloture"));

    const coachService = {
      resultFromMessage: vi.fn(async (_repo: unknown, stored: AiMessage) => resultFrom(stored)),
      buildPulse: vi.fn()
    } as unknown as CoachPulseService;

    await expect(loadLatestCoachPulseForDate(repository, coachService, today)).resolves.toBeNull();
    expect(coachService.resultFromMessage).not.toHaveBeenCalled();
  });
});
