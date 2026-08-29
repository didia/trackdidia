import { describe, expect, it } from "vitest";
import { createEmptyDailyEntry, updatePrinciple } from "../../../domain/daily-entry";
import { principleDefinitions } from "../../../domain/definitions";
import type { AiMemory, DailyEntry } from "../../../domain/types";
import { MemoryRepository } from "../../storage/memory-repository";
import { runMemoryLifecycle } from "./lifecycle";
import { stringifyPatternDetail } from "./detail";

const buildOppositeCorrelationHistory = (): DailyEntry[] => {
  const entries: DailyEntry[] = [];
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

describe("memory lifecycle", () => {
  it("archives expired context memories", async () => {
    const repository = new MemoryRepository();
    await repository.saveAiMemory({
      id: "ai-memory:context",
      kind: "context",
      statement: "Charge elevee",
      detail: "",
      confidence: 0.9,
      source: "ai_extracted",
      status: "active",
      evidenceFrom: null,
      evidenceTo: null,
      createdAt: "2026-08-01T00:00:00.000Z",
      lastConfirmedAt: "2026-08-01T00:00:00.000Z",
      expiresAt: "2026-08-20",
      pinned: false
    });

    await runMemoryLifecycle(repository, "2026-08-29", [], "2026-08-29T12:00:00.000Z");
    const memories = await repository.listAiMemories({ status: "archived" });
    expect(memories).toHaveLength(1);
  });

  it("marks contradicted pattern memories when correlation sign flips", async () => {
    const repository = new MemoryRepository();
    const history = buildOppositeCorrelationHistory();

    const memory: AiMemory = {
      id: "ai-memory:pattern",
      kind: "pattern",
      statement: "Pattern test",
      detail: stringifyPatternDetail({ principleKey: "priereDuMatin", diff: -0.25 }),
      confidence: 0.9,
      source: "derived",
      status: "active",
      evidenceFrom: "2026-08-01",
      evidenceTo: "2026-08-12",
      createdAt: "2026-08-12T00:00:00.000Z",
      lastConfirmedAt: "2026-08-12T00:00:00.000Z",
      expiresAt: null,
      pinned: false
    };

    await repository.saveAiMemory(memory);
    await runMemoryLifecycle(repository, "2026-08-29", history, "2026-08-29T12:00:00.000Z");
    const contradicted = await repository.listAiMemories({ status: "contradicted" });
    expect(contradicted).toHaveLength(1);
  });
});
