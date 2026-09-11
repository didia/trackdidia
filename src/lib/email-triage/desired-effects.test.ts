import { describe, expect, it } from "vitest";
import {
  createDesiredEffect,
  pickNextPendingEffect,
  shouldSupersedeEffect,
} from "./desired-effects";

describe("desired effects", () => {
  it("supersedes older decision versions", () => {
    const effect = createDesiredEffect({
      accountId: "a1",
      accountGeneration: 1,
      conversationId: "c1",
      decisionVersion: 1,
      effectType: "provider_marker",
      targetMessageIds: ["m1"],
    });
    expect(shouldSupersedeEffect(effect, 2, 1)).toBe(true);
    expect(shouldSupersedeEffect(effect, 1, 2)).toBe(true);
  });

  it("skips a pending effect until its dependencies leave the pending set", () => {
    const gtd = createDesiredEffect({
      accountId: "a1",
      accountGeneration: 1,
      conversationId: "c1",
      decisionVersion: 1,
      effectType: "gtd_task",
      targetMessageIds: ["m1"],
    });
    const marker = {
      ...createDesiredEffect({
        accountId: "a1",
        accountGeneration: 1,
        conversationId: "c1",
        decisionVersion: 1,
        effectType: "provider_marker",
        targetMessageIds: ["m1"],
        dependencies: [gtd.id],
      }),
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const laterGtd = { ...gtd, createdAt: "2026-01-01T00:00:01.000Z" };
    expect(pickNextPendingEffect([marker, laterGtd])?.id).toBe(laterGtd.id);
    expect(pickNextPendingEffect([marker])?.id).toBe(marker.id);
  });
});
