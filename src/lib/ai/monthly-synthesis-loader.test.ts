import type { AiMessage } from "../../domain/types";
import { MemoryRepository } from "../storage/memory-repository";
import { loadLatestMonthlySynthesis } from "./monthly-synthesis-loader";
import {
  MONTHLY_SYNTHESIS_PROMPT_VERSION,
  MonthlySynthesisService,
} from "./monthly-synthesis-service";
import type { AiProvider } from "./provider";

const monthlyBody = (headline: string) =>
  JSON.stringify({
    headline,
    weekPattern: "Stable",
    sectionDrafts: {},
    goalEvaluationDrafts: [],
  });

const monthlyMessage = (
  id: string,
  scopeKey: string,
  status: AiMessage["status"],
  createdAt: string,
  headline: string,
  promptVersion: string = MONTHLY_SYNTHESIS_PROMPT_VERSION,
): AiMessage => ({
  id,
  surface: "monthly_synthesis",
  scopeKey,
  stance: null,
  kind: "monthly",
  inputHash: `hash-${id}`,
  promptVersion,
  model: "local",
  status,
  bodyJson: monthlyBody(headline),
  bodyText: headline,
  deltaClass: null,
  notified: false,
  tokensPrompt: null,
  tokensCompletion: null,
  latencyMs: null,
  createdAt,
});

describe("loadLatestMonthlySynthesis", () => {
  it("hydrates the latest ok row and ignores a newer fallback", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const service = new MonthlySynthesisService({
      generateStructured: vi.fn(),
    } as unknown as AiProvider);

    await repository.saveAiMessage(
      monthlyMessage("ai-message:ok", "2026-04", "ok", "2026-04-30T10:00:00.000Z", "Ok"),
    );
    await repository.saveAiMessage(
      monthlyMessage(
        "ai-message:fallback",
        "2026-04",
        "fallback",
        "2026-04-30T12:00:00.000Z",
        "Fallback",
      ),
    );

    const loaded = await loadLatestMonthlySynthesis(repository, service, "2026-04");
    expect(loaded?.message.id).toBe("ai-message:ok");
    expect(loaded?.synthesis.headline).toBe("Ok");
  });

  it("labels a hydrated stored row as cache, not a fresh AI call", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const service = new MonthlySynthesisService({
      generateStructured: vi.fn(),
    } as unknown as AiProvider);

    await repository.saveAiMessage(
      monthlyMessage("ai-message:ok", "2026-04", "ok", "2026-04-30T10:00:00.000Z", "Ok"),
    );

    const loaded = await loadLatestMonthlySynthesis(repository, service, "2026-04");
    expect(loaded?.source).toBe("cache");
  });

  it("does not hydrate a stored ok row whose promptVersion predates the current prompt", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const service = new MonthlySynthesisService({
      generateStructured: vi.fn(),
    } as unknown as AiProvider);

    await repository.saveAiMessage(
      monthlyMessage(
        "ai-message:stale",
        "2026-04",
        "ok",
        "2026-04-30T10:00:00.000Z",
        "Stale",
        "monthly_synthesis.v0",
      ),
    );

    const loaded = await loadLatestMonthlySynthesis(repository, service, "2026-04");
    expect(loaded).toBeNull();
  });

  it("returns null when the stored body is malformed", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const service = new MonthlySynthesisService({
      generateStructured: vi.fn(),
    } as unknown as AiProvider);

    await repository.saveAiMessage({
      ...monthlyMessage("ai-message:malformed", "2026-04", "ok", "2026-04-30T10:00:00.000Z", "Ok"),
      bodyJson: "{not valid json",
    });

    const loaded = await loadLatestMonthlySynthesis(repository, service, "2026-04");
    expect(loaded).toBeNull();
  });
});
