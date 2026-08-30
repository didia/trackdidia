import { describe, expect, it } from "vitest";
import type { AiProposal } from "../../../domain/types";
import { MemoryRepository } from "../../storage/memory-repository";
import { applyAcceptedProposal, buildMemoryFromProposal, memoryIdFromProposal } from "./apply-proposal";

describe("applyAcceptedProposal", () => {
  const seedProposal = async (repository: MemoryRepository, proposal: AiProposal) => {
    await repository.saveAiProposal(proposal);
  };

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

    await seedProposal(repository, proposal);
    const memory = await applyAcceptedProposal(repository, proposal, "2026-08-29");
    expect(memory).not.toBeNull();
    expect(memory?.kind).toBe("preference");
    expect(memory?.id).toBe(memoryIdFromProposal(proposal.id));

    const stored = await repository.listAiMemories({ status: "active", kind: "preference" });
    expect(stored).toHaveLength(1);

    const decided = await repository.listAiProposals(proposal.messageId);
    expect(decided[0]?.status).toBe("accepted");
    expect(decided[0]?.appliedEntityId).toBe(memory?.id);
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

    await seedProposal(repository, proposal);
    const memory = await applyAcceptedProposal(repository, proposal, "2026-08-28");
    expect(memory?.kind).toBe("commitment");
    expect(memory?.expiresAt).toBe("2026-08-29");
  });

  it("reconciles after a partial accept when memory exists but proposal stays pending", async () => {
    const repository = new MemoryRepository();
    const proposal: AiProposal = {
      id: "ai-proposal:partial",
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

    await seedProposal(repository, proposal);
    const memory = buildMemoryFromProposal(proposal, "2026-08-29");
    expect(memory).not.toBeNull();
    await repository.saveAiMemory(memory!);

    const retried = await applyAcceptedProposal(repository, proposal, "2026-08-29");
    expect(retried?.id).toBe(memory!.id);

    const stored = await repository.listAiMemories({ status: "active", kind: "preference" });
    expect(stored).toHaveLength(1);

    const decided = await repository.listAiProposals(proposal.messageId);
    expect(decided[0]?.status).toBe("accepted");
    expect(decided[0]?.appliedEntityId).toBe(memory!.id);
  });

  it("does not duplicate memory rows when accept is retried", async () => {
    const repository = new MemoryRepository();
    const proposal: AiProposal = {
      id: "ai-proposal:retry",
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

    await seedProposal(repository, proposal);
    await applyAcceptedProposal(repository, proposal, "2026-08-29");
    await applyAcceptedProposal(repository, proposal, "2026-08-29");

    const stored = await repository.listAiMemories({ status: "active", kind: "preference" });
    expect(stored).toHaveLength(1);
  });
});
