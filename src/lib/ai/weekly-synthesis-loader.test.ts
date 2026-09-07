import type { AiMessage } from "../../domain/types";
import { MemoryRepository } from "../storage/memory-repository";
import type { AiProvider } from "./provider";
import { loadLatestWeeklySynthesis } from "./weekly-synthesis-loader";
import { WeeklySynthesisService } from "./weekly-synthesis-service";

const weeklyBody = (headline: string) =>
  JSON.stringify({
    headline,
    scoreExplanation: "Score",
    strongestAxis: "Discipline",
    weakestAxes: ["Sommeil", "Pomodoris"],
    sectionDrafts: {},
    nextWeekObjectives: [],
    gtdActions: [],
  });

const weeklyMessage = (
  id: string,
  scopeKey: string,
  status: AiMessage["status"],
  createdAt: string,
  headline = "Semaine",
): AiMessage => ({
  id,
  surface: "weekly_synthesis",
  scopeKey,
  stance: null,
  kind: "weekly",
  inputHash: `hash-${id}`,
  promptVersion: "weekly_synthesis.v1",
  model: "local",
  status,
  bodyJson: weeklyBody(headline),
  bodyText: headline,
  deltaClass: null,
  notified: false,
  tokensPrompt: null,
  tokensCompletion: null,
  latencyMs: null,
  createdAt,
});

describe("loadLatestWeeklySynthesis", () => {
  it("hydrates the latest ok row for the week even when other weeks fill the global list", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const service = new WeeklySynthesisService({
      generateStructured: vi.fn(),
    } as unknown as AiProvider);

    for (let index = 0; index < 25; index += 1) {
      await repository.saveAiMessage(
        weeklyMessage(
          `ai-message:other-${index}`,
          "2026-07-05",
          "ok",
          `2026-08-29T08:00:${String(index).padStart(2, "0")}.000Z`,
          "Autre",
        ),
      );
    }
    await repository.saveAiMessage(
      weeklyMessage("ai-message:week", "2026-08-02", "ok", "2026-08-08T12:00:00.000Z", "Cible"),
    );

    const loaded = await loadLatestWeeklySynthesis(repository, service, "2026-08-02");
    expect(loaded?.message.id).toBe("ai-message:week");
    expect(loaded?.synthesis.headline).toBe("Cible");
  });

  it("does not hydrate fallback or skipped rows", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const service = new WeeklySynthesisService({
      generateStructured: vi.fn(),
    } as unknown as AiProvider);

    await repository.saveAiMessage(
      weeklyMessage("ai-message:ok", "2026-08-02", "ok", "2026-08-08T10:00:00.000Z", "Ok"),
    );
    await repository.saveAiMessage(
      weeklyMessage(
        "ai-message:fallback",
        "2026-08-02",
        "fallback",
        "2026-08-08T12:00:00.000Z",
        "Fallback",
      ),
    );

    const loaded = await loadLatestWeeklySynthesis(repository, service, "2026-08-02");
    expect(loaded?.message.id).toBe("ai-message:ok");
    expect(loaded?.synthesis.headline).toBe("Ok");
  });
});
