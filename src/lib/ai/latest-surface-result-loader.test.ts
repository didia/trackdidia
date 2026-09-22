import type { AiMessage } from "../../domain/types";
import { MemoryRepository } from "../storage/memory-repository";
import { loadLatestSurfaceResult } from "./latest-surface-result-loader";

const message = (overrides: Partial<AiMessage> = {}): AiMessage => ({
  id: "ai-message:1",
  surface: "goal_pacing",
  scopeKey: "2026",
  stance: null,
  kind: "annual",
  inputHash: "hash",
  promptVersion: "v1",
  model: "local",
  status: "ok",
  bodyJson: JSON.stringify({ value: "hello" }),
  bodyText: "hello",
  deltaClass: null,
  notified: false,
  tokensPrompt: null,
  tokensCompletion: null,
  latencyMs: null,
  createdAt: "2026-08-29T10:00:00.000Z",
  ...overrides,
});

describe("loadLatestSurfaceResult", () => {
  it("returns null when there is no matching row", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    const result = await loadLatestSurfaceResult(
      repository,
      { surface: "goal_pacing", scopeKey: "2026" },
      async () => "unreachable",
    );

    expect(result).toBeNull();
  });

  it("hands the latest row to toResult and returns its value", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveAiMessage(message());

    const result = await loadLatestSurfaceResult(
      repository,
      { surface: "goal_pacing", scopeKey: "2026" },
      async (latest) => latest.bodyText,
    );

    expect(result).toBe("hello");
  });

  it("rejects a stale promptVersion without calling toResult", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveAiMessage(message({ promptVersion: "v0" }));

    const toResult = vi.fn(async () => "should not run");
    const result = await loadLatestSurfaceResult(
      repository,
      { surface: "goal_pacing", scopeKey: "2026", promptVersion: "v1" },
      toResult,
    );

    expect(result).toBeNull();
    expect(toResult).not.toHaveBeenCalled();
  });

  it("returns null when toResult itself returns null (e.g. a malformed body)", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveAiMessage(message({ bodyJson: "{not valid json" }));

    const result = await loadLatestSurfaceResult(
      repository,
      { surface: "goal_pacing", scopeKey: "2026" },
      async () => null,
    );

    expect(result).toBeNull();
  });
});
