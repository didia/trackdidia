import { addDays } from "../../lib/gtd/shared";
import { createEmptyDailyEntry, updateMetric } from "../daily-entry";
import type { DailyEntry } from "../types";
import { computeMetricTrendFindings, computeWeeklyScoreTrend } from "./trends";

const buildEntries = (startDate: string, values: number[]): DailyEntry[] =>
  values.map((value, index) => updateMetric(createEmptyDailyEntry(addDays(startDate, index)), "course", value));

describe("trends insight module", () => {
  it("computes 7-day and 28-day trailing averages, delta and direction per metric", () => {
    const entries = buildEntries("2026-01-01", [10, 10, 10, 20, 20, 20, 20, 20, 20, 20]);

    const finding = computeMetricTrendFindings(entries).find((item) => item.metricKey === "course");

    expect(finding?.average7d).toBeCloseTo(20);
    expect(finding?.average28d).toBeCloseTo(17);
    expect(finding?.delta).toBeCloseTo(3);
    expect(finding?.direction).toBe("up");
    expect(finding?.sampleSize).toBe(10);
    expect(finding?.value).toBeCloseTo(20);
  });

  it("reports a flat direction when the short-term average barely moves", () => {
    const entries = buildEntries("2026-01-01", [20, 20, 20, 20, 20, 20, 20, 20, 20, 20]);

    const finding = computeMetricTrendFindings(entries).find((item) => item.metricKey === "course");

    expect(finding?.direction).toBe("flat");
  });

  it("returns no findings for empty history", () => {
    expect(computeMetricTrendFindings([])).toEqual([]);
  });

  it("does not report a false down trend when the trailing 7-day window has no observations", () => {
    // 14 days at 30/day, then a 7-day gap in tracking (no entries for the trailing week).
    const entries = buildEntries("2026-01-01", Array.from({ length: 14 }, () => 30));

    const finding = computeMetricTrendFindings(entries, "2026-01-21").find((item) => item.metricKey === "course");

    expect(finding?.shortSampleSize).toBe(0);
    expect(finding?.average7d).toBe(0);
    expect(finding?.average28d).toBeCloseTo(30);
    expect(finding?.delta).toBe(0);
    expect(finding?.direction).toBe("flat");
  });

  it("computes the weekly-score trajectory against prior weeks", () => {
    const points = [
      { weekStartDate: "2026-01-04", weeklyScore: 50 },
      { weekStartDate: "2026-01-11", weeklyScore: 55 },
      { weekStartDate: "2026-01-18", weeklyScore: 60 },
      { weekStartDate: "2026-01-25", weeklyScore: 80 }
    ];

    const finding = computeWeeklyScoreTrend(points);

    expect(finding?.latestScore).toBe(80);
    expect(finding?.baselineAverage).toBeCloseTo(55);
    expect(finding?.delta).toBeCloseTo(25);
    expect(finding?.direction).toBe("up");
    expect(finding?.sampleSize).toBe(3);
  });

  it("returns null for the weekly-score trajectory with no history", () => {
    expect(computeWeeklyScoreTrend([])).toBeNull();
  });

  it("returns null for the weekly-score trajectory with a single point (no prior weeks to compare)", () => {
    expect(computeWeeklyScoreTrend([{ weekStartDate: "2026-01-04", weeklyScore: 50 }])).toBeNull();
  });
});
