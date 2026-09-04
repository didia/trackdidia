import { describe, expect, it } from "vitest";
import type { AiMemory } from "../../../domain/types";
import { effectiveConfidence, isBelowRetrievalThreshold } from "./decay";

const buildMemory = (partial: Partial<AiMemory>): AiMemory => ({
  id: "ai-memory:test",
  kind: partial.kind ?? "pattern",
  statement: "Test",
  detail: "",
  confidence: partial.confidence ?? 0.8,
  source: "ai_extracted",
  status: "active",
  evidenceFrom: null,
  evidenceTo: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  lastConfirmedAt: partial.lastConfirmedAt ?? "2026-01-01T00:00:00.000Z",
  expiresAt: null,
  pinned: partial.pinned ?? false,
});

describe("memory decay", () => {
  it("decays pattern confidence with age", () => {
    const memory = buildMemory({ confidence: 0.8, lastConfirmedAt: "2026-01-01T00:00:00.000Z" });
    const fresh = effectiveConfidence(memory, "2026-02-01T00:00:00.000Z");
    const aged = effectiveConfidence(memory, "2026-08-01T00:00:00.000Z");
    expect(aged).toBeLessThan(fresh);
  });

  it("does not decay pinned memories", () => {
    const memory = buildMemory({
      pinned: true,
      confidence: 0.9,
      lastConfirmedAt: "2024-01-01T00:00:00.000Z",
    });
    expect(effectiveConfidence(memory, "2026-08-29T00:00:00.000Z")).toBe(0.9);
  });

  it("flags memories below retrieval threshold", () => {
    const memory = buildMemory({ confidence: 0.4, lastConfirmedAt: "2024-01-01T00:00:00.000Z" });
    expect(isBelowRetrievalThreshold(memory, "2026-08-29T00:00:00.000Z")).toBe(true);
  });
});
