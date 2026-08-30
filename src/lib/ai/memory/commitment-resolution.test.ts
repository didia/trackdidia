import { describe, expect, it } from "vitest";
import { createEmptyDailyEntry, updateMetric } from "../../../domain/daily-entry";
import { resolveCommitment } from "./commitment-resolution";
import type { AiMemory } from "../../../domain/types";
import { stringifyCommitmentDetail } from "./detail";

describe("commitment resolution", () => {
  it("resolves pomodoro commitments against the daily metric", () => {
    const entry = updateMetric(createEmptyDailyEntry("2026-08-29"), "pomodoris", 5);
    const memory: AiMemory = {
      id: "ai-memory:commitment",
      kind: "commitment",
      statement: "8 pomodoros demain",
      detail: stringifyCommitmentDetail({ metricKey: "pomodoris", target: 8 }),
      confidence: 1,
      source: "ai_extracted",
      status: "active",
      evidenceFrom: null,
      evidenceTo: null,
      createdAt: "2026-08-28T20:00:00.000Z",
      lastConfirmedAt: "2026-08-28T20:00:00.000Z",
      expiresAt: "2026-08-29",
      pinned: false
    };

    const resolution = resolveCommitment(memory, entry);
    expect(resolution.progressLabel).toBe("5/8");
    expect(resolution.met).toBe(false);
  });
});
