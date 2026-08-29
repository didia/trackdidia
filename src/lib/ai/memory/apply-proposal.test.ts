import { describe, expect, it } from "vitest";
import type { AiProposal } from "../../../domain/types";
import { MemoryRepository } from "../../storage/memory-repository";
import { applyAcceptedProposal } from "./apply-proposal";

describe("applyAcceptedProposal", () => {
  it("creates an ai_memories row when a memory proposal is accepted", async () => {
    const repository = new MemoryRepository();
    const proposal: AiProposal = {
      id: "ai-proposal:memory",
      messageId: "ai-message:test",
      type: "memory",
      payloadJson: JSON.stringify({
        kind: "preference",
        statement: "Prefere un seul conseil concret",
        confidence: 0.85,
        source: "ai_extracted"
      }),
      status: "pending",
      appliedEntityId: null,
      decidedAt: null,
      createdAt: "2026-08-29T20:00:00.000Z"
    };

    const memory = await applyAcceptedProposal(repository, proposal, "2026-08-29");
    expect(memory).not.toBeNull();
    expect(memory?.kind).toBe("preference");

    const stored = await repository.listAiMemories({ status: "active", kind: "preference" });
    expect(stored).toHaveLength(1);
  });

  it("creates a commitment memory with next-day expiry", async () => {
    const repository = new MemoryRepository();
    const proposal: AiProposal = {
      id: "ai-proposal:commitment",
      messageId: "ai-message:test",
      type: "commitment",
      payloadJson: JSON.stringify({
        statement: "8 pomodoros demain",
        metricKey: "pomodoris",
        target: 8
      }),
      status: "pending",
      appliedEntityId: null,
      decidedAt: null,
      createdAt: "2026-08-28T20:00:00.000Z"
    };

    const memory = await applyAcceptedProposal(repository, proposal, "2026-08-28");
    expect(memory?.kind).toBe("commitment");
    expect(memory?.expiresAt).toBe("2026-08-29");
  });
});
