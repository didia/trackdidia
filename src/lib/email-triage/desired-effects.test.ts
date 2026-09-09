import { describe, expect, it } from "vitest";
import { createDesiredEffect, shouldSupersedeEffect } from "./desired-effects";

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
});
