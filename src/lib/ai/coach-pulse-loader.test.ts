import { createEmptyDailyEntry, defaultAppSettings } from "../../domain/daily-entry";
import type { AiMessage, AppSettings, CoachPulseResult } from "../../domain/types";
import { getTodayDate } from "../date";
import { MemoryRepository } from "../storage/memory-repository";
import {
  latestClosePulseMessage,
  latestScheduledPulseMessage,
  loadLatestClosePulseForDate,
  loadLatestCoachPulseForDate,
  loadPassiveCoachPulse,
  refreshCoachPulse,
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

describe("loadPassiveCoachPulse / refreshCoachPulse", () => {
  const entry = createEmptyDailyEntry(today);

  const setup = async (overrides: Partial<AppSettings> = {}, stored: AiMessage[] = []) => {
    const repository = new MemoryRepository();
    await repository.initialize();
    vi.spyOn(repository, "listAiMessagesForDate").mockResolvedValue(stored);
    const settings = { ...defaultAppSettings(), ...overrides };
    const built = (headline: string, source: CoachPulseResult["source"]) =>
      ({
        ...resultFrom(message("built", "open", "2026-08-29T09:00:00.000Z", headline)),
        source,
      }) as CoachPulseResult;
    const coachService = {
      resultFromMessage: vi.fn(async (_repo: unknown, stored: AiMessage) => resultFrom(stored)),
      buildPulse: vi.fn(async (_repo: unknown, request: { localOnly?: boolean }) =>
        request.localOnly ? built("local", "local") : built("ai", "ai"),
      ),
    };
    const published: string[] = [];
    const run = (stance: "open" | "close", isCurrent = () => true) =>
      loadPassiveCoachPulse(
        { repository, coachService: coachService as unknown as CoachPulseService, settings },
        {
          entry,
          stance,
          isCurrent,
          publish: (result) => published.push(result.message.bodyText ?? ""),
        },
      );
    return { repository, coachService, settings, published, run };
  };

  const aiOn = { aiEnabled: true, aiApiKey: "key", aiPulseEnabled: false };

  it("open: publishes a stored pulse and stops", async () => {
    const { coachService, published, run } = await setup(aiOn, [
      message("s", "steer", "2026-08-29T13:00:00.000Z", "stored"),
    ]);
    await run("open");
    expect(published).toEqual(["stored"]);
    expect(coachService.buildPulse).not.toHaveBeenCalled();
  });

  it("open: builds local then AI when nothing is stored", async () => {
    const { coachService, published, run } = await setup(aiOn);
    await run("open");
    expect(published).toEqual(["local", "ai"]);
    expect(coachService.buildPulse).toHaveBeenCalledTimes(2);
  });

  it("open: stops after local when AI is not configured", async () => {
    const { published, run } = await setup({ aiEnabled: true, aiApiKey: "  " });
    await run("open");
    expect(published).toEqual(["local"]);
  });

  it("open: pulse engine owns persistence when aiPulseEnabled", async () => {
    const { coachService, published, run } = await setup({ ...aiOn, aiPulseEnabled: true });
    await run("open");
    expect(published).toEqual(["local"]);
    expect(coachService.buildPulse).toHaveBeenCalledTimes(1);
  });

  it("open: does not publish once the request is stale", async () => {
    const { published, run } = await setup(aiOn);
    await run("open", () => false);
    expect(published).toEqual([]);
  });

  it("close: publishes stored close pulse then refreshes through AI", async () => {
    const { coachService, published, run } = await setup(aiOn, [
      message("c", "close", "2026-08-29T20:00:00.000Z", "stored-close"),
    ]);
    await run("close");
    expect(published).toEqual(["stored-close", "ai"]);
    expect(coachService.buildPulse).toHaveBeenCalledTimes(1);
  });

  it("close: builds a local brief only when AI is off and nothing is stored", async () => {
    const off = await setup();
    await off.run("close");
    expect(off.published).toEqual(["local"]);

    const offStored = await setup({}, [
      message("c", "close", "2026-08-29T20:00:00.000Z", "stored-close"),
    ]);
    await offStored.run("close");
    expect(offStored.published).toEqual(["stored-close"]);
    expect(offStored.coachService.buildPulse).not.toHaveBeenCalled();
  });

  it("refresh (open) keeps the latest stored stance and slot hour", async () => {
    const { repository, coachService, settings } = await setup(aiOn, [
      message("s", "steer", "2026-08-29T13:00:00.000Z", "stored"),
    ]);
    await refreshCoachPulse(
      { repository, coachService: coachService as unknown as CoachPulseService, settings },
      { entry, stance: "open", trigger: "explicit", bypassCache: true },
    );
    expect(coachService.buildPulse).toHaveBeenCalledWith(
      repository,
      expect.objectContaining({ stance: "steer", slotHour: 13, bypassCache: true }),
    );
  });

  it("refresh (close) always uses the close stance", async () => {
    const { repository, coachService, settings } = await setup(aiOn);
    await refreshCoachPulse(
      { repository, coachService: coachService as unknown as CoachPulseService, settings },
      { entry, stance: "close", trigger: "explicit" },
    );
    expect(coachService.buildPulse).toHaveBeenCalledWith(
      repository,
      expect.objectContaining({ stance: "close", bypassCache: false }),
    );
  });
});
