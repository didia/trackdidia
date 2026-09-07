import type { AiMessage } from "../../domain/types";
import { MemoryRepository } from "../storage/memory-repository";
import { GoalPacingService } from "./goal-pacing-service";
import { loadLatestGoalPacing } from "./goal-pacing-loader";
import type { AiProvider } from "./provider";

const pacingBody = (gap: string) =>
  JSON.stringify({
    goals: [
      {
        goalId: "goal-1",
        onPace: true,
        gap,
        requiredWeeklyBehaviour: "Focus",
        riskLevel: "low",
        recommendation: "Continuer",
      },
    ],
  });

const pacingMessage = (
  id: string,
  year: string,
  status: AiMessage["status"],
  createdAt: string,
  gap: string,
): AiMessage => ({
  id,
  surface: "goal_pacing",
  scopeKey: year,
  stance: null,
  kind: "annual",
  inputHash: `hash-${id}`,
  promptVersion: "goal_pacing.v1",
  model: "local",
  status,
  bodyJson: pacingBody(gap),
  bodyText: gap,
  deltaClass: null,
  notified: false,
  tokensPrompt: null,
  tokensCompletion: null,
  latencyMs: null,
  createdAt,
});

describe("loadLatestGoalPacing", () => {
  it("hydrates the latest ok row and ignores a newer fallback", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const service = new GoalPacingService({ generateStructured: vi.fn() } as unknown as AiProvider);

    await repository.saveAiMessage(
      pacingMessage("ai-message:ok", "2026", "ok", "2026-08-29T10:00:00.000Z", "Ok"),
    );
    await repository.saveAiMessage(
      pacingMessage(
        "ai-message:fallback",
        "2026",
        "fallback",
        "2026-08-29T12:00:00.000Z",
        "Fallback",
      ),
    );

    const loaded = await loadLatestGoalPacing(repository, service, 2026);
    expect(loaded?.message.id).toBe("ai-message:ok");
    expect(loaded?.pacing.goals[0].gap).toBe("Ok");
  });
});
