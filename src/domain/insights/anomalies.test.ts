import { addDays } from "../../lib/gtd/shared";
import { createEmptyDailyEntry, updatePrinciple } from "../daily-entry";
import type { DailyEntry, PrincipleKey } from "../types";
import { principleDefinitions } from "../definitions";
import { computeAnomalyFindings } from "./anomalies";

const withTruePrinciples = (date: string, keys: PrincipleKey[]): DailyEntry => {
  let entry = createEmptyDailyEntry(date);
  for (const key of keys) {
    entry = updatePrinciple(entry, key, true);
  }
  return entry;
};

describe("anomalies insight module", () => {
  it("compares today's discipline to a personal baseline once the sample floor is met", () => {
    const baseline = Array.from({ length: 10 }, (_, index) => withTruePrinciples(addDays("2026-01-01", index), []));
    const today = withTruePrinciples("2026-01-11", principleDefinitions.slice(0, 7).map((definition) => definition.key));
    const entries = [...baseline, today];

    const finding = computeAnomalyFindings(entries, "2026-01-11").find(
      (item) => item.subject === "discipline" && item.scope === "today"
    );

    expect(finding).toBeDefined();
    expect(finding?.currentValue).toBeCloseTo(0.5);
    expect(finding?.baselineMean).toBeCloseTo(0);
    expect(finding?.delta).toBeCloseTo(0.5);
    expect(finding?.sampleSize).toBe(10);
    expect(finding?.severity).toBe("positive");
  });

  it("omits the today comparison below the minimum sample floor", () => {
    const baseline = Array.from({ length: 9 }, (_, index) => withTruePrinciples(addDays("2026-01-01", index), []));
    const today = withTruePrinciples("2026-01-10", []);
    const entries = [...baseline, today];

    const finding = computeAnomalyFindings(entries, "2026-01-10").find(
      (item) => item.subject === "discipline" && item.scope === "today"
    );

    expect(finding).toBeUndefined();
  });

  it("compares this week's average to a personal baseline of prior weeks", () => {
    const baseline = Array.from({ length: 10 }, (_, index) => withTruePrinciples(addDays("2026-01-01", index), []));
    const currentWeek = ["2026-01-11", "2026-01-12", "2026-01-13"].map((date) =>
      withTruePrinciples(date, principleDefinitions.slice(0, 7).map((definition) => definition.key))
    );
    const entries = [...baseline, ...currentWeek];

    const finding = computeAnomalyFindings(entries, "2026-01-13").find(
      (item) => item.subject === "discipline" && item.scope === "week"
    );

    expect(finding).toBeDefined();
    expect(finding?.currentValue).toBeCloseTo(0.5);
    expect(finding?.baselineMean).toBeCloseTo(0);
    expect(finding?.sampleSize).toBe(10);
  });

  it("returns no findings for empty history", () => {
    expect(computeAnomalyFindings([])).toEqual([]);
  });
});
