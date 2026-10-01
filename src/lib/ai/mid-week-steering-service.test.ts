import { describe, expect, it, vi } from "vitest";
import { defaultAppSettings } from "../../domain/daily-entry";
import type { AiMessage } from "../../domain/types";
import { MemoryRepository } from "../storage/memory-repository";
import { loadLatestMidWeekSteering } from "./mid-week-steering-loader";
import {
  MID_WEEK_STEERING_PROMPT_VERSION,
  MidWeekSteeringService,
} from "./mid-week-steering-service";
import type { AiProvider } from "./provider";
import { buildMidWeekInputs, MID_WEEK_TEST_WEEK } from "./test-support/mid-week-fixtures";

const validBody = (key: string) =>
  JSON.stringify({
    headline: "Semaine à rattraper",
    read: "Le focus est en retard.",
    focusShift: "Réserver du temps",
    actions: [{ signalKey: key, title: "Deux blocs", why: "En retard", effort: "medium" }],
  });

const usage = { tokensPrompt: 10, tokensCompletion: 20, latencyMs: 100 };
const aiSettings = () => {
  const settings = defaultAppSettings();
  settings.aiEnabled = true;
  settings.aiApiKey = "secret";
  return settings;
};
const setup = async (provider?: AiProvider) => {
  const repository = new MemoryRepository();
  await repository.initialize();
  const generateStructured = vi.fn(async () => ({
    text: validBody("metric:pomodoris"),
    model: "test-model",
    usage,
  }));
  const service = new MidWeekSteeringService(provider ?? { generateStructured });
  return { repository, service, generateStructured };
};

describe("MidWeekSteeringService", () => {
  it("persists a skipped local result when AI is unconfigured and reuses it", async () => {
    const { repository, service, generateStructured } = await setup();
    const settings = defaultAppSettings();
    const first = await service.buildSteering(repository, {
      settings,
      snapshotInputs: buildMidWeekInputs(),
    });
    const second = await service.buildSteering(repository, {
      settings,
      snapshotInputs: buildMidWeekInputs(),
    });

    expect(first.source).toBe("local");
    expect(first.message.status).toBe("skipped");
    expect(second.source).toBe("cache");
    expect(second.message.id).toBe(first.message.id);
    expect(generateStructured).not.toHaveBeenCalled();
  });

  it("calls the provider once and serves an identical hash from the ok-only cache", async () => {
    const { repository, service, generateStructured } = await setup();
    const settings = aiSettings();
    const first = await service.buildSteering(repository, {
      settings,
      snapshotInputs: buildMidWeekInputs(),
    });
    const second = await service.buildSteering(repository, {
      settings,
      snapshotInputs: buildMidWeekInputs(),
    });

    expect(first.source).toBe("ai");
    expect(first.steering.asOfDate).toBe("2026-08-05");
    expect(second.source).toBe("cache");
    expect(generateStructured).toHaveBeenCalledOnce();
    expect(first.message).toMatchObject({
      surface: "mid_week_steering",
      scopeKey: MID_WEEK_TEST_WEEK,
      promptVersion: MID_WEEK_STEERING_PROMPT_VERSION,
    });
  });

  it("misses the cache when asOfDate changes or the decisions text changes", async () => {
    const { repository, service, generateStructured } = await setup();
    const settings = aiSettings();
    await service.buildSteering(repository, { settings, snapshotInputs: buildMidWeekInputs() });
    await service.buildSteering(repository, {
      settings,
      snapshotInputs: buildMidWeekInputs({ asOfDate: "2026-08-06" }),
    });
    await service.buildSteering(repository, {
      settings,
      snapshotInputs: buildMidWeekInputs({ decisions: "Autre décision" }),
    });
    expect(generateStructured).toHaveBeenCalledTimes(3);
  });

  it("does not include the decisions text in the hash below full scope", async () => {
    const { repository, service, generateStructured } = await setup();
    const settings = aiSettings();
    settings.aiPayloadScope = "metrics";
    await service.buildSteering(repository, { settings, snapshotInputs: buildMidWeekInputs() });
    await service.buildSteering(repository, {
      settings,
      snapshotInputs: buildMidWeekInputs({ decisions: "Autre décision" }),
    });
    expect(generateStructured).toHaveBeenCalledOnce();
  });

  it("uses a fresh message id on regenerate and on recovery from a skipped row (append-only)", async () => {
    const { repository, service, generateStructured } = await setup();
    const ids = new Set<string>();
    const original = repository.saveCoachPulseEpisode.bind(repository);
    repository.saveCoachPulseEpisode = async (message, proposals) => {
      if (ids.has(message.id)) {
        throw new Error("UNIQUE constraint failed: ai_messages.id");
      }
      ids.add(message.id);
      return original(message, proposals);
    };

    await service.buildSteering(repository, {
      settings: defaultAppSettings(),
      snapshotInputs: buildMidWeekInputs(),
    });
    const settings = aiSettings();
    const first = await service.buildSteering(repository, {
      settings,
      snapshotInputs: buildMidWeekInputs(),
    });
    const regenerated = await service.buildSteering(repository, {
      settings,
      snapshotInputs: buildMidWeekInputs(),
      bypassCache: true,
    });

    expect(first.source).toBe("ai");
    expect(regenerated.source).toBe("ai");
    expect(regenerated.message.id).not.toBe(first.message.id);
    expect(generateStructured).toHaveBeenCalledTimes(2);
    expect(ids.size).toBe(3);
  });

  it("falls back and persists the local body when the provider throws", async () => {
    const { repository, service } = await setup({
      generateStructured: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    const result = await service.buildSteering(repository, {
      settings: aiSettings(),
      snapshotInputs: buildMidWeekInputs(),
    });
    expect(result.source).toBe("fallback");
    expect(result.warning).toBe("boom");
    expect(result.message.status).toBe("fallback");
    expect(result.steering.actions.length).toBeGreaterThan(0);
  });

  it("repairs once, then falls back when the output keeps naming a non-actionable key", async () => {
    const { repository, service, generateStructured } = await setup({
      generateStructured: vi.fn(async () => ({
        text: validBody("principle:respectTrc"),
        model: "test-model",
        usage,
      })),
    });
    const provider = (service as unknown as { provider: AiProvider }).provider;
    const result = await service.buildSteering(repository, {
      settings: aiSettings(),
      snapshotInputs: buildMidWeekInputs(),
    });
    expect(result.source).toBe("fallback");
    expect(result.warning).toContain("not an actionable signal");
    expect(provider.generateStructured).toHaveBeenCalledTimes(2);
    expect(generateStructured).not.toHaveBeenCalled();
  });

  it("refuses to run with no completed day (Sunday)", async () => {
    const { repository, service, generateStructured } = await setup();
    await expect(
      service.buildSteering(repository, {
        settings: aiSettings(),
        snapshotInputs: buildMidWeekInputs({ asOfDate: MID_WEEK_TEST_WEEK }),
      }),
    ).rejects.toThrow();
    expect(generateStructured).not.toHaveBeenCalled();
    expect(await repository.listAiMessages("mid_week_steering")).toEqual([]);
  });
});

describe("loadLatestMidWeekSteering", () => {
  const message = (
    id: string,
    status: AiMessage["status"],
    createdAt: string,
    promptVersion = MID_WEEK_STEERING_PROMPT_VERSION,
  ): AiMessage => ({
    id,
    surface: "mid_week_steering",
    scopeKey: MID_WEEK_TEST_WEEK,
    stance: null,
    kind: "weekly",
    inputHash: `hash-${id}`,
    promptVersion,
    model: "local",
    status,
    bodyJson: JSON.stringify({
      asOfDate: "2026-08-05",
      headline: id,
      read: "r",
      focusShift: "f",
      actions: [],
    }),
    bodyText: id,
    deltaClass: null,
    notified: false,
    tokensPrompt: null,
    tokensCompletion: null,
    latencyMs: null,
    createdAt,
  });

  it("hydrates the latest ok row, exposes asOfDate and ignores a newer fallback", async () => {
    const { repository, service } = await setup();
    await repository.saveAiMessage(message("ok", "ok", "2026-08-05T10:00:00.000Z"));
    await repository.saveAiMessage(message("fb", "fallback", "2026-08-05T12:00:00.000Z"));
    const loaded = await loadLatestMidWeekSteering(repository, service, MID_WEEK_TEST_WEEK);
    expect(loaded?.message.id).toBe("ok");
    expect(loaded?.steering.asOfDate).toBe("2026-08-05");
    expect(loaded?.source).toBe("cache");
  });

  it("rejects a stale prompt version and a malformed body", async () => {
    const { repository, service } = await setup();
    await repository.saveAiMessage(
      message("old", "ok", "2026-08-05T10:00:00.000Z", "mid_week_steering.v0"),
    );
    expect(await loadLatestMidWeekSteering(repository, service, MID_WEEK_TEST_WEEK)).toBeNull();
    await repository.saveAiMessage({
      ...message("bad", "ok", "2026-08-05T11:00:00.000Z"),
      bodyJson: "{nope",
    });
    expect(await loadLatestMidWeekSteering(repository, service, MID_WEEK_TEST_WEEK)).toBeNull();
  });
});
