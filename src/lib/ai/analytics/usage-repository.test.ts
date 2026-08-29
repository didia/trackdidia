import { MemoryRepository } from "../../storage/memory-repository";
import { monthKeyToLocalRange } from "../analytics/month-range";

describe("MemoryRepository AI usage aggregation", () => {
  it("aggregates tokens by local calendar month boundaries", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    const { startIso, endIso } = monthKeyToLocalRange("2026-08");
    const beforeMonth = new Date(new Date(startIso).getTime() - 60_000).toISOString();
    const inMonth = new Date(new Date(startIso).getTime() + 60_000).toISOString();
    const afterMonth = endIso;

    await repository.saveAiMessage({
      id: "msg-before",
      surface: "coach_pulse",
      scopeKey: "2026-07-31",
      stance: "open",
      kind: "open",
      inputHash: "before",
      promptVersion: "coach_pulse.v1",
      model: "test",
      status: "ok",
      bodyJson: null,
      bodyText: null,
      deltaClass: null,
      notified: false,
      tokensPrompt: 999,
      tokensCompletion: 999,
      latencyMs: null,
      createdAt: beforeMonth
    });

    await repository.saveAiMessage({
      id: "msg-in",
      surface: "coach_pulse",
      scopeKey: "2026-08-01",
      stance: "open",
      kind: "open",
      inputHash: "in",
      promptVersion: "coach_pulse.v1",
      model: "test",
      status: "ok",
      bodyJson: null,
      bodyText: null,
      deltaClass: null,
      notified: false,
      tokensPrompt: 100,
      tokensCompletion: 40,
      latencyMs: null,
      createdAt: inMonth
    });

    await repository.saveAiMessage({
      id: "msg-after",
      surface: "coach_pulse",
      scopeKey: "2026-09-01",
      stance: "open",
      kind: "open",
      inputHash: "after",
      promptVersion: "coach_pulse.v1",
      model: "test",
      status: "ok",
      bodyJson: null,
      bodyText: null,
      deltaClass: null,
      notified: false,
      tokensPrompt: 500,
      tokensCompletion: 500,
      latencyMs: null,
      createdAt: afterMonth
    });

    await expect(repository.computeAiUsageForMonth("2026-08")).resolves.toEqual({
      monthKey: "2026-08",
      callCount: 1,
      tokensPrompt: 100,
      tokensCompletion: 40,
      tokensTotal: 140,
      estimatedCostUsd: 0
    });
  });

  it("lists proposals and messages since an ISO timestamp", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();

    const message = {
      id: "msg-since",
      surface: "coach_pulse" as const,
      scopeKey: "2026-08-29",
      stance: "open" as const,
      kind: "open",
      inputHash: "since",
      promptVersion: "coach_pulse.v1",
      model: "test",
      status: "ok" as const,
      bodyJson: null,
      bodyText: null,
      deltaClass: null,
      notified: false,
      tokensPrompt: null,
      tokensCompletion: null,
      latencyMs: null,
      createdAt: "2026-08-29T12:00:00.000Z"
    };

    await repository.saveAiMessage(message);
    await repository.saveAiProposal({
      id: "prop-since",
      messageId: message.id,
      type: "intention_draft",
      payloadJson: "{}",
      status: "pending",
      appliedEntityId: null,
      decidedAt: null,
      createdAt: "2026-08-29T12:05:00.000Z"
    });

    await expect(repository.listAiMessagesSince("2026-08-29T00:00:00.000Z")).resolves.toHaveLength(1);
    await expect(repository.listAiProposalsSince("2026-08-29T00:00:00.000Z")).resolves.toHaveLength(1);
    await expect(repository.listAiProposalsSince("2026-08-30T00:00:00.000Z")).resolves.toHaveLength(0);
  });
});
