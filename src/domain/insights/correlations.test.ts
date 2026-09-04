import { addDays } from "../../lib/gtd/shared";
import { createEmptyDailyEntry, updatePrinciple } from "../daily-entry";
import type { DailyEntry } from "../types";
import { computeCorrelationFindings } from "./correlations";

const buildEntry = (date: string, isTrue: boolean): DailyEntry => {
  let entry = createEmptyDailyEntry(date);
  entry = updatePrinciple(entry, "priereDuMatin", isTrue);

  if (isTrue) {
    entry = updatePrinciple(entry, "oxytocineDuMatin", true);
    entry = updatePrinciple(entry, "ecriture", true);
    entry = updatePrinciple(entry, "apprentissage", true);
    entry = updatePrinciple(entry, "managedSolitude", true);
  }

  return entry;
};

describe("correlations insight module", () => {
  it("reports the discipline difference between true and false days once the sample floor is met", () => {
    const trueDays = Array.from({ length: 6 }, (_, index) =>
      buildEntry(addDays("2026-01-01", index), true),
    );
    const falseDays = Array.from({ length: 6 }, (_, index) =>
      buildEntry(addDays("2026-01-07", index), false),
    );
    const entries = [...trueDays, ...falseDays];

    const finding = computeCorrelationFindings(entries).find(
      (item) => item.principleKey === "priereDuMatin",
    );

    expect(finding).toBeDefined();
    expect(finding?.sampleSize).toBe(12);
    expect(finding?.sampleSizeTrue).toBe(6);
    expect(finding?.sampleSizeFalse).toBe(6);
    expect(finding?.meanDisciplineWhenTrue).toBeCloseTo(5 / 14);
    expect(finding?.meanDisciplineWhenFalse).toBeCloseTo(0);
    expect(finding?.diff).toBeCloseTo(5 / 14);
    expect(finding?.value).toBeCloseTo(5 / 14);
    expect(finding?.severity).toBe("positive");
    expect(finding?.label).toContain("associée");
    expect(finding?.label.toLowerCase()).not.toContain("cause");
  });

  it("omits the finding below the minimum sample floor", () => {
    const trueDays = Array.from({ length: 4 }, (_, index) =>
      buildEntry(addDays("2026-01-01", index), true),
    );
    const falseDays = Array.from({ length: 4 }, (_, index) =>
      buildEntry(addDays("2026-01-05", index), false),
    );
    const entries = [...trueDays, ...falseDays];

    const finding = computeCorrelationFindings(entries).find(
      (item) => item.principleKey === "priereDuMatin",
    );

    expect(finding).toBeUndefined();
  });

  it("omits the finding when one side of the comparison has no data", () => {
    const entries = Array.from({ length: 12 }, (_, index) =>
      buildEntry(addDays("2026-01-01", index), true),
    );

    const finding = computeCorrelationFindings(entries).find(
      (item) => item.principleKey === "priereDuMatin",
    );

    expect(finding).toBeUndefined();
  });

  it("returns no findings for empty history", () => {
    expect(computeCorrelationFindings([])).toEqual([]);
  });
});
