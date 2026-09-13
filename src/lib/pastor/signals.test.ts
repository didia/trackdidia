import { createEmptyDailyEntry } from "../../domain/daily-entry";
import type { PrincipleChecks } from "../../domain/types";
import { computePrincipleSignals, type PastorSignalDayInput } from "./signals";

const day = (date: string, overrides: Partial<PrincipleChecks> = {}): PastorSignalDayInput => ({
  date,
  principleChecks: { ...createEmptyDailyEntry(date).principleChecks, ...overrides },
});

describe("computePrincipleSignals", () => {
  it("counts true/false/null within the window", () => {
    const entries: PastorSignalDayInput[] = [
      day("2026-08-23", { priereDuMatin: true }),
      day("2026-08-24", { priereDuMatin: false }),
      day("2026-08-25", { priereDuMatin: null }),
      day("2026-08-26", { priereDuMatin: false }),
    ];

    const { signals } = computePrincipleSignals(entries, "2026-08-26");
    const priere = signals.find((signal) => signal.key === "priereDuMatin")!;
    expect(priere.trueCount).toBe(1);
    expect(priere.falseCount).toBe(2);
    expect(priere.nullCount).toBe(1);
  });

  it("computes daysSinceLastTrue only from entries inside the window", () => {
    const entries: PastorSignalDayInput[] = [
      day("2026-08-23", { priereDuMatin: true }),
      day("2026-08-26", { priereDuMatin: false }),
    ];

    const { signals } = computePrincipleSignals(entries, "2026-08-26");
    const priere = signals.find((signal) => signal.key === "priereDuMatin")!;
    expect(priere.daysSinceLastTrue).toBe(3);
  });

  it("returns null daysSinceLastTrue when no true value is in the window", () => {
    const entries: PastorSignalDayInput[] = [day("2026-08-26", { priereDuMatin: false })];
    const { signals } = computePrincipleSignals(entries, "2026-08-26");
    const priere = signals.find((signal) => signal.key === "priereDuMatin")!;
    expect(priere.daysSinceLastTrue).toBeNull();
  });

  it("flags a principle as struggling when false is >= 2 and outnumbers true", () => {
    const entries: PastorSignalDayInput[] = [
      day("2026-08-23", { attentionAMonEpouse: false }),
      day("2026-08-24", { attentionAMonEpouse: false }),
      day("2026-08-25", { attentionAMonEpouse: true }),
    ];

    const { struggling } = computePrincipleSignals(entries, "2026-08-25");
    expect(struggling).toContain("attentionAMonEpouse");
  });

  it("does not flag a principle as struggling when true meets or exceeds false", () => {
    const entries: PastorSignalDayInput[] = [
      day("2026-08-23", { attentionAMonEpouse: false }),
      day("2026-08-24", { attentionAMonEpouse: false }),
      day("2026-08-25", { attentionAMonEpouse: true }),
      day("2026-08-26", { attentionAMonEpouse: true }),
    ];

    const { struggling } = computePrincipleSignals(entries, "2026-08-26");
    expect(struggling).not.toContain("attentionAMonEpouse");
  });
});
