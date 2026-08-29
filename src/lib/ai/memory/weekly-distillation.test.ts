import { describe, expect, it } from "vitest";
import { createEmptyDailyEntry, updatePrinciple } from "../../../domain/daily-entry";
import { principleDefinitions } from "../../../domain/definitions";
import { MemoryRepository } from "../../storage/memory-repository";
import {
  buildWeeklyDistillInputHash,
  buildWeeklyDistillScopeKey,
  createWeeklyMemoryProposals,
  loadWeeklyMemoryProposals
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
  it("uses getAiMessage scope/hash for idempotent proposal creation", async () => {
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
    await expect(repository.getAiMessage("coach_pulse", scopeKey, inputHash)).resolves.not.toBeNull();
    await expect(loadWeeklyMemoryProposals(repository, weekStartDate)).resolves.toHaveLength(first.length);
  });
});
