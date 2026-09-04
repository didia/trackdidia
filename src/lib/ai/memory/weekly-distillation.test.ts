import { describe, expect, it } from "vitest";
import { createEmptyDailyEntry, updatePrinciple } from "../../../domain/daily-entry";
import { principleDefinitions } from "../../../domain/definitions";
import { MemoryRepository } from "../../storage/memory-repository";
import { COACH_PULSE_PROMPT_VERSION } from "../coach-pulse-service";
import {
  buildWeeklyDistillInputHash,
  buildWeeklyDistillMessageId,
  buildWeeklyDistillScopeKey,
  createWeeklyMemoryProposals,
  loadWeeklyMemoryProposals,
} from "./weekly-distillation";

const buildCorrelationHistory = () => {
  const entries = [];
  for (let index = 0; index < 12; index += 1) {
    const date = `2026-08-${String(index + 1).padStart(2, "0")}`;
    let entry = createEmptyDailyEntry(date);
    const priereTrue = index % 2 === 0;
    for (const { key } of principleDefinitions) {
      entry = updatePrinciple(entry, key, priereTrue);
    }
    entries.push(entry);
  }
  return entries;
};

describe("weekly distillation", () => {
  it("uses getAiMessageRecord scope/hash for idempotent proposal creation", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const weekStartDate = "2026-08-03";
    const history = buildCorrelationHistory();

    const first = await createWeeklyMemoryProposals(repository, weekStartDate, history);
    const second = await createWeeklyMemoryProposals(repository, weekStartDate, history);

    expect(first.length).toBeGreaterThan(0);
    expect(second).toHaveLength(first.length);
    expect(second.map((proposal) => proposal.id)).toEqual(first.map((proposal) => proposal.id));

    const scopeKey = buildWeeklyDistillScopeKey(weekStartDate);
    const inputHash = buildWeeklyDistillInputHash(weekStartDate);
    await expect(repository.getAiMessage("coach_pulse", scopeKey, inputHash)).resolves.toBeNull();
    await expect(
      repository.getAiMessageRecord("coach_pulse", scopeKey, inputHash),
    ).resolves.not.toBeNull();
    await expect(loadWeeklyMemoryProposals(repository, weekStartDate)).resolves.toHaveLength(
      first.length,
    );
  });

  it("rebuilds missing child proposals when the marker exists without a full set", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const weekStartDate = "2026-08-03";
    const history = buildCorrelationHistory();
    const scopeKey = buildWeeklyDistillScopeKey(weekStartDate);
    const inputHash = buildWeeklyDistillInputHash(weekStartDate);

    const full = await createWeeklyMemoryProposals(repository, weekStartDate, history);
    expect(full.length).toBeGreaterThan(0);

    const marker = await repository.getAiMessageRecord("coach_pulse", scopeKey, inputHash);
    expect(marker).not.toBeNull();
    await repository.clearPendingAiProposals(marker!.id);

    const rebuilt = await createWeeklyMemoryProposals(repository, weekStartDate, history);
    expect(rebuilt).toHaveLength(full.length);
    expect(rebuilt.map((proposal) => proposal.id)).toEqual(full.map((proposal) => proposal.id));
    await expect(loadWeeklyMemoryProposals(repository, weekStartDate)).resolves.toHaveLength(
      full.length,
    );
  });

  it("does not duplicate proposals when create is called twice after partial marker insert", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const weekStartDate = "2026-08-10";
    const history = buildCorrelationHistory();
    const scopeKey = buildWeeklyDistillScopeKey(weekStartDate);
    const inputHash = buildWeeklyDistillInputHash(weekStartDate);

    await repository.saveAiMessage({
      id: buildWeeklyDistillMessageId(weekStartDate),
      surface: "coach_pulse",
      scopeKey,
      stance: null,
      kind: "weekly_distill",
      inputHash,
      promptVersion: "coach_pulse.v1",
      model: "derived",
      status: "skipped",
      bodyJson: null,
      bodyText: null,
      deltaClass: null,
      notified: false,
      tokensPrompt: null,
      tokensCompletion: null,
      latencyMs: null,
      createdAt: "2026-08-16T12:00:00.000Z",
    });

    const first = await createWeeklyMemoryProposals(repository, weekStartDate, history);
    const second = await createWeeklyMemoryProposals(repository, weekStartDate, history);

    expect(first.length).toBeGreaterThan(0);
    expect(second.map((proposal) => proposal.id)).toEqual(first.map((proposal) => proposal.id));

    const message = await repository.getAiMessageRecord("coach_pulse", scopeKey, inputHash);
    expect(message).not.toBeNull();
    const proposals = await repository.listAiProposals(message!.id);
    const pending = proposals.filter((proposal) => proposal.status === "pending");
    expect(pending).toHaveLength(first.length);
  });

  it("persists only missing siblings when the marker has accepted proposals", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    const weekStartDate = "2026-08-17";
    const history = buildCorrelationHistory();
    const scopeKey = buildWeeklyDistillScopeKey(weekStartDate);
    const inputHash = buildWeeklyDistillInputHash(weekStartDate);
    const messageId = buildWeeklyDistillMessageId(weekStartDate);

    const seedRepository = new MemoryRepository();
    await seedRepository.initialize();
    const expected = await createWeeklyMemoryProposals(seedRepository, weekStartDate, history);
    expect(expected.length).toBeGreaterThanOrEqual(3);

    await repository.saveAiMessage({
      id: messageId,
      surface: "coach_pulse",
      scopeKey,
      stance: null,
      kind: "weekly_distill",
      inputHash,
      promptVersion: COACH_PULSE_PROMPT_VERSION,
      model: "derived",
      status: "skipped",
      bodyJson: null,
      bodyText: null,
      deltaClass: null,
      notified: false,
      tokensPrompt: null,
      tokensCompletion: null,
      latencyMs: null,
      createdAt: "2026-08-23T12:00:00.000Z",
    });

    const [acceptedProposal, missingProposal, pendingProposal] = expected;
    await repository.saveAiProposal({
      ...acceptedProposal,
      messageId,
      status: "accepted",
      appliedEntityId: "ai-memory:accepted",
      decidedAt: "2026-08-23T12:05:00.000Z",
    });
    await repository.saveAiProposal({ ...pendingProposal, messageId });

    const pending = await createWeeklyMemoryProposals(repository, weekStartDate, history);
    expect(pending.map((proposal) => proposal.id).sort()).toEqual(
      [missingProposal.id, pendingProposal.id].sort(),
    );

    const stored = await repository.listAiProposals(messageId);
    expect(stored).toHaveLength(3);
    expect(stored.find((proposal) => proposal.id === acceptedProposal.id)?.status).toBe("accepted");
    expect(stored.find((proposal) => proposal.id === missingProposal.id)?.status).toBe("pending");
    expect(stored.find((proposal) => proposal.id === pendingProposal.id)?.status).toBe("pending");
    await expect(loadWeeklyMemoryProposals(repository, weekStartDate)).resolves.toHaveLength(2);
  });
});
