import type { AiMessage } from "../../domain/types";
import { MemoryRepository } from "../storage/memory-repository";
import { FINANCE_CATEGORIZATION_PROMPT_VERSION } from "./finance-categorization-service";
import { loadLatestFinanceCategorizationRun } from "./finance-categorization-loader";

const message = (
  id: string,
  createdAt: string,
  promptVersion: string = FINANCE_CATEGORIZATION_PROMPT_VERSION,
): AiMessage => ({
  id,
  surface: "finance_categorization",
  scopeKey: `hash-${id}`,
  stance: null,
  kind: "finance",
  inputHash: `hash-${id}`,
  promptVersion,
  model: "test-model",
  status: "ok",
  bodyJson: JSON.stringify({ merchants: [] }),
  bodyText: null,
  deltaClass: null,
  notified: false,
  tokensPrompt: null,
  tokensCompletion: null,
  latencyMs: null,
  createdAt,
});

describe("loadLatestFinanceCategorizationRun", () => {
  it("hydrates the most recent run across any batch/scope", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveAiMessage(message("ai-message:1", "2026-08-29T10:00:00.000Z"));
    await repository.saveAiMessage(message("ai-message:2", "2026-08-29T12:00:00.000Z"));

    const loaded = await loadLatestFinanceCategorizationRun(repository);
    expect(loaded?.id).toBe("ai-message:2");
  });

  it("rejects a stale prompt version", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.saveAiMessage(
      message("ai-message:stale", "2026-08-29T10:00:00.000Z", "finance_categorization.v0"),
    );

    const loaded = await loadLatestFinanceCategorizationRun(repository);
    expect(loaded).toBeNull();
  });

  it("returns null when nothing has run yet", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    const loaded = await loadLatestFinanceCategorizationRun(repository);
    expect(loaded).toBeNull();
  });
});
