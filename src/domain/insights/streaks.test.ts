import { addDays } from "../../lib/gtd/shared";
import { createEmptyDailyEntry, updatePrinciple } from "../daily-entry";
import type { DailyEntry, PrincipleKey } from "../types";
import { computeStreakFindings } from "./streaks";

const buildEntries = (startDate: string, values: boolean[], key: PrincipleKey): DailyEntry[] =>
  values.map((value, index) =>
    updatePrinciple(createEmptyDailyEntry(addDays(startDate, index)), key, value),
  );

describe("streaks insight module", () => {
  it("computes current streak, longest streak, days since last true and 28-day rate", () => {
    const values = [true, true, false, true, true, true, false, true, true, true];
    const entries = buildEntries("2026-01-01", values, "priereDuMatin");

    const findings = computeStreakFindings(entries);
    const finding = findings.find((item) => item.principleKey === "priereDuMatin");

    expect(finding).toBeDefined();
    expect(finding?.currentStreak).toBe(3);
    expect(finding?.longestStreak).toBe(3);
    expect(finding?.daysSinceLastTrue).toBe(0);
    expect(finding?.rate28d).toBeCloseTo(0.8);
    expect(finding?.sampleSize).toBe(10);
    expect(finding?.value).toBe(3);
    expect(finding?.severity).toBe("positive");
  });

  it("reports daysSinceLastTrue as null when the principle was never true", () => {
    const entries = buildEntries("2026-01-01", [false, false, false], "priereDuSoir");

    const finding = computeStreakFindings(entries).find(
      (item) => item.principleKey === "priereDuSoir",
    );

    expect(finding?.currentStreak).toBe(0);
    expect(finding?.longestStreak).toBe(0);
    expect(finding?.daysSinceLastTrue).toBeNull();
  });

  it("returns no findings for empty history", () => {
    expect(computeStreakFindings([])).toEqual([]);
  });

  it("ignores null (unanswered) days when computing the 28-day rate", () => {
    const entries = buildEntries("2026-01-01", [true, true], "ecriture");
    entries.push(createEmptyDailyEntry("2026-01-03"));

    const finding = computeStreakFindings(entries).find((item) => item.principleKey === "ecriture");

    expect(finding?.sampleSize).toBe(2);
    expect(finding?.rate28d).toBeCloseTo(1);
  });

  it("skips past an unanswered reference day to find the last answered day for currentStreak", () => {
    const trueEntries = buildEntries(
      "2026-01-01",
      Array.from({ length: 10 }, () => true),
      "priereDuMatin",
    );
    const unansweredToday = createEmptyDailyEntry("2026-01-11");
    const entries = [...trueEntries, unansweredToday];

    const finding = computeStreakFindings(entries).find(
      (item) => item.principleKey === "priereDuMatin",
    );

    expect(finding?.currentStreak).toBe(10);
    expect(finding?.longestStreak).toBe(10);
    expect(finding?.daysSinceLastTrue).toBe(1);
  });

  it("does not bridge a streak across a calendar-date gap between entries", () => {
    const entries = [
      updatePrinciple(createEmptyDailyEntry("2026-01-01"), "priereDuMatin", true),
      updatePrinciple(createEmptyDailyEntry("2026-01-10"), "priereDuMatin", true),
    ];

    const finding = computeStreakFindings(entries).find(
      (item) => item.principleKey === "priereDuMatin",
    );

    expect(finding?.currentStreak).toBe(1);
    expect(finding?.longestStreak).toBe(1);
  });
});
