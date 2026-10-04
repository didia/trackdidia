import { defaultAppSettings } from "../../domain/daily-entry";
import { MemoryRepository } from "../storage/memory-repository";
import { buildGoalPacingSnapshot } from "./context/goal-pacing-snapshot";
import type { AiProvider } from "./provider";
import {
  runStructuredSurface,
  sourceFromStatus,
  sumUsage,
  type ParseResult,
} from "./structured-generation";

const usage = { tokensPrompt: 10, tokensCompletion: 20, latencyMs: 100 };
const makeOptions = async (provider: AiProvider) => {
  const repository = new MemoryRepository();
  await repository.initialize();
  const settings = { ...defaultAppSettings(), aiEnabled: true, aiApiKey: "test-only-key" };
  const snapshot = buildGoalPacingSnapshot(
    { year: 2026, asOfDate: "2026-08-29", evaluationMonthKey: "2026-08", goalSnapshots: [] },
    "full",
  );
  return {
    repository,
    provider,
    settings,
    surface: "goal_pacing" as const,
    scopeKey: "2026",
    kind: "annual",
    promptVersion: "fixture.v1",
    inputHash: "stable-input",
    createdAt: "2026-08-29T12:00:00.000Z",
    localFallback: { text: "local" },
    toBodyText: (body: { text: string }) => body.text,
    parse: (text: string): ParseResult<{ text: string }> =>
      text.includes("text")
        ? { ok: true, value: JSON.parse(text) }
        : { ok: false, error: "missing text" },
    request: (repairHint?: string) => ({
      surface: "goal_pacing" as const,
      settings,
      snapshot,
      repairHint,
    }),
  };
};

it("sums usage without altering either provider result", () => {
  expect(sumUsage(usage, usage)).toEqual({
    tokensPrompt: 20,
    tokensCompletion: 40,
    latencyMs: 200,
  });
  expect(usage.tokensPrompt).toBe(10);
  expect(sourceFromStatus("ok")).toBe("ai");
  expect(sourceFromStatus("ok", { cached: true })).toBe("cache");
  expect(sourceFromStatus("fallback", { cached: true })).toBe("fallback");
  expect(sourceFromStatus("local")).toBe("local");
});

it("repairs once, preserving raw accepted JSON and adding both usages", async () => {
  const generateStructured = vi
    .fn()
    .mockResolvedValueOnce({ text: "bad", model: "first", usage })
    .mockResolvedValueOnce({ text: '{ "text": "repaired" }', model: "repair", usage });
  const options = await makeOptions({ generateStructured });
  const result = await runStructuredSurface(options);
  expect(generateStructured).toHaveBeenCalledTimes(2);
  expect(generateStructured.mock.calls[1][0].repairHint).toBe("missing text");
  const { id, ...message } = result.message;
  expect(message).toEqual({
    surface: "goal_pacing",
    scopeKey: "2026",
    stance: null,
    kind: "annual",
    inputHash: "stable-input",
    promptVersion: "fixture.v1",
    model: "repair",
    status: "ok",
    bodyJson: '{ "text": "repaired" }',
    bodyText: "repaired",
    deltaClass: null,
    notified: false,
    tokensPrompt: 20,
    tokensCompletion: 40,
    latencyMs: 200,
    createdAt: options.createdAt,
  });
  expect(await options.repository.listAiMessages()).toEqual([result.message]);
});

it("keeps null usage and configured model when a repair throws", async () => {
  const generateStructured = vi
    .fn()
    .mockResolvedValueOnce({ text: "bad", model: "first", usage })
    .mockRejectedValueOnce(new Error("repair failed"));
  const options = await makeOptions({ generateStructured });
  const result = await runStructuredSurface(options);
  expect(result).toMatchObject({
    source: "fallback",
    warning: "repair failed",
    message: {
      status: "fallback",
      model: options.settings.aiModel,
      tokensPrompt: null,
      tokensCompletion: null,
      latencyMs: null,
    },
  });
});

it("never makes a third model call and can leave an explicit fallback unpersisted", async () => {
  const generateStructured = vi.fn().mockResolvedValue({ text: "bad", model: "first", usage });
  const options = await makeOptions({ generateStructured });
  const result = await runStructuredSurface({ ...options, persistFallback: false });
  expect(result).toMatchObject({ message: null, source: "fallback", warning: "missing text" });
  expect(generateStructured).toHaveBeenCalledTimes(2);
  expect(await options.repository.listAiMessages()).toEqual([]);
});

it("reuses successful cached messages without provider calls, and honors bypass", async () => {
  const generateStructured = vi
    .fn()
    .mockResolvedValue({ text: '{"text":"ok"}', model: "model", usage });
  const options = await makeOptions({ generateStructured });
  const first = await runStructuredSurface(options);
  const cached = await runStructuredSurface(options);
  expect(cached.source).toBe("cache");
  expect(cached.message).toEqual(first.message);
  expect(generateStructured).toHaveBeenCalledOnce();
  await runStructuredSurface({ ...options, bypassCache: true });
  expect(generateStructured).toHaveBeenCalledTimes(2);
});

it("reuses skipped local cache while an ephemeral local outcome creates no row", async () => {
  const generateStructured = vi.fn();
  const options = await makeOptions({ generateStructured });
  options.settings.aiEnabled = false;
  await runStructuredSurface({ ...options, persistLocal: false });
  expect(await options.repository.listAiMessages()).toEqual([]);
  const first = await runStructuredSurface(options);
  const cached = await runStructuredSurface(options);
  expect(cached).toMatchObject({ source: "cache", message: first.message });
  expect(generateStructured).not.toHaveBeenCalled();
});

it("persists a fallback if saving the valid response fails, preserving the original exception policy", async () => {
  const options = await makeOptions({
    generateStructured: vi.fn().mockResolvedValue({ text: '{"text":"ok"}', model: "model", usage }),
  });
  vi.spyOn(options.repository, "saveCoachPulseEpisode").mockRejectedValueOnce(
    new Error("persist failed"),
  );
  const result = await runStructuredSurface(options);
  expect(result).toMatchObject({
    source: "fallback",
    warning: "persist failed",
    message: { status: "fallback", tokensPrompt: null },
  });
  expect(await options.repository.listAiMessages()).toEqual([result.message]);
});
