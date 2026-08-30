import { describe, expect, it } from "vitest";
import { defaultAppSettings } from "../../../domain/daily-entry";
import type { AiMemory } from "../../../domain/types";
import { rankMemories, retrieveMemories, selectMemoriesForPrompt } from "./retrieval";

const buildMemory = (partial: Partial<AiMemory>): AiMemory => ({
  id: partial.id ?? "ai-memory:test",
  kind: partial.kind ?? "pattern",
  statement: partial.statement ?? "Test",
  detail: partial.detail ?? "",
  confidence: partial.confidence ?? 0.8,
  source: partial.source ?? "ai_extracted",
  status: partial.status ?? "active",
  evidenceFrom: partial.evidenceFrom ?? null,
  evidenceTo: partial.evidenceTo ?? null,
  createdAt: partial.createdAt ?? "2026-08-01T00:00:00.000Z",
  lastConfirmedAt: partial.lastConfirmedAt ?? "2026-08-01T00:00:00.000Z",
  expiresAt: partial.expiresAt ?? null,
  pinned: partial.pinned ?? false
});

describe("retrieveMemories ranking", () => {
  it("ranks pinned memories first and caps non-pinned at eight", () => {
    const nowIso = "2026-08-29T12:00:00.000Z";
    const pinned = buildMemory({ id: "p1", pinned: true, kind: "principle", statement: "Mission" });
    const commitment = buildMemory({ id: "c1", kind: "commitment", statement: "8 pomodoros" });
    const nonPinned = Array.from({ length: 10 }, (_, index) =>
      buildMemory({ id: `n${index}`, kind: "pattern", statement: `Pattern ${index}` })
    );

    const selected = selectMemoriesForPrompt([...nonPinned, commitment, pinned], "open", nowIso);
    expect(selected[0].id).toBe("p1");
    expect(selected[1].id).toBe("c1");
    expect(selected).toHaveLength(9);
    expect(selected.filter((memory) => !memory.pinned)).toHaveLength(8);
  });

  it("prefers kind relevance for the stance", () => {
    const nowIso = "2026-08-29T12:00:00.000Z";
    const pattern = buildMemory({ id: "pattern", kind: "pattern", confidence: 0.99 });
    const commitment = buildMemory({ id: "commitment", kind: "commitment", confidence: 0.5 });

    const ranked = rankMemories([pattern, commitment], "open", nowIso);
    expect(ranked[0].id).toBe("commitment");
  });

  it("returns empty block when memory is disabled", () => {
    const settings = defaultAppSettings();
    settings.aiMemoryEnabled = false;
    const { block } = retrieveMemories([buildMemory({})], settings, {
      stance: "open",
      nowIso: "2026-08-29T12:00:00.000Z"
    });
    expect(block).toBe("");
  });
});
