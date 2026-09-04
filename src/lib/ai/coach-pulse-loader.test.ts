import type { AiMessage, CoachPulseResult } from "../../domain/types";
import { getTodayDate } from "../date";
import { MemoryRepository } from "../storage/memory-repository";
import {
  latestClosePulseMessage,
  latestScheduledPulseMessage,
  loadLatestClosePulseForDate,
  loadLatestCoachPulseForDate,
} from "./coach-pulse-loader";
import { CoachPulseService } from "./coach-pulse-service";

const today = getTodayDate();

const pulseBody = (
  stance: AiMessage["stance"],
  headline: string,
  extra: Record<string, unknown> = {},
) =>
  JSON.stringify({
    stance,
    headline,
    read: "Lecture",
    move: null,
    ...extra,
  });

const message = (
  id: string,
  stance: NonNullable<AiMessage["stance"]>,
  createdAt: string,
  headline: string,
  status: AiMessage["status"] = "ok",
): AiMessage => ({
  id,
  surface: "coach_pulse",
  scopeKey: stance === "open" ? today : `${today}#${stance === "close" ? "close" : "13"}`,
  stance,
  kind: stance,
  inputHash: `hash-${id}`,
  promptVersion: "coach_pulse.v1",
  model: "local",
  status,
  bodyJson: pulseBody(stance, headline),
  bodyText: headline,
  deltaClass: null,
  notified: false,
  tokensPrompt: null,
  tokensCompletion: null,
  latencyMs: null,
  createdAt,
});

const resultFrom = (stored: AiMessage): CoachPulseResult => ({
  message: stored,
  pulse: JSON.parse(stored.bodyJson ?? "{}"),
  proposals: [],
  source: "cache",
});

describe("coach-pulse-loader", () => {
  it("ignores evening close when loading the scheduled Today pulse", () => {
    const close = message("ai-message:close", "close", "2026-08-29T20:00:00.000Z", "Cloture");
    const steer = message("ai-message:steer", "steer", "2026-08-29T13:00:00.000Z", "Mi-journee");

    expect(latestScheduledPulseMessage([close, steer])?.id).toBe("ai-message:steer");
    expect(latestClosePulseMessage([close, steer])?.id).toBe("ai-message:close");
  });

  it("does not reuse fallback or skipped close pulses", () => {
    const fallback = message(
      "ai-message:fallback",
      "close",
      "2026-08-29T21:00:00.000Z",
      "Local",
      "fallback",
    );
    const skipped = message(
      "ai-message:skipped",
      "close",
      "2026-08-29T20:30:00.000Z",
      "Local",
      "skipped",
    );
    const ok = message("ai-message:ok", "close", "2026-08-29T20:00:00.000Z", "Cloture");

    expect(latestClosePulseMessage([fallback, skipped])).toBeNull();
    expect(latestClosePulseMessage([fallback, skipped, ok])?.id).toBe("ai-message:ok");
  });

  it("hydrates a persisted ok close pulse without going through buildPulse", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const close = message("ai-message:close", "close", "2026-08-29T20:00:00.000Z", "Cloture");
    await repository.saveAiMessage(close);

    const coachService = {
      resultFromMessage: vi.fn(async (_repo: unknown, stored: AiMessage) => resultFrom(stored)),
      buildPulse: vi.fn(),
    } as unknown as CoachPulseService;

    const loaded = await loadLatestClosePulseForDate(repository, coachService, today);

    expect(loaded?.pulse.headline).toBe("Cloture");
    expect(coachService.resultFromMessage).toHaveBeenCalledOnce();
    expect(coachService.buildPulse).not.toHaveBeenCalled();
  });

  it("returns null for a close pulse whose proposals were not persisted", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const close = message("ai-message:close", "close", "2026-08-29T20:00:00.000Z", "Cloture");
    close.bodyJson = pulseBody("close", "Cloture", { tomorrowFocusDraft: "Dormir tot" });
    await repository.saveAiMessage(close);

    const loaded = await loadLatestClosePulseForDate(
      repository,
      new CoachPulseService({ generateStructured: vi.fn() }),
      today,
    );

    expect(loaded).toBeNull();
  });

  it("does not treat a close pulse as the Today scheduled thread", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveAiMessage(
      message("ai-message:close", "close", "2026-08-29T20:00:00.000Z", "Cloture"),
    );

    const coachService = {
      resultFromMessage: vi.fn(async (_repo: unknown, stored: AiMessage) => resultFrom(stored)),
      buildPulse: vi.fn(),
    } as unknown as CoachPulseService;

    await expect(loadLatestCoachPulseForDate(repository, coachService, today)).resolves.toBeNull();
    expect(coachService.resultFromMessage).not.toHaveBeenCalled();
  });
});
