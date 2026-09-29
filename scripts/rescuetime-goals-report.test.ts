import { computeRescueTimeGoalsSnapshot } from "../src/domain/rescuetime-goals";
import { formatSnapshotReport, parseWeekArg } from "./rescuetime-goals-report";

describe("parseWeekArg", () => {
  it("reads the value following --week", () => {
    expect(parseWeekArg(["node", "script.ts", "--week", "2026-08-02"])).toBe("2026-08-02");
  });

  it("returns undefined when --week is absent", () => {
    expect(parseWeekArg(["node", "script.ts"])).toBeUndefined();
  });
});

describe("formatSnapshotReport", () => {
  it("reports the fetch error without leaking any secret", () => {
    const snapshot = computeRescueTimeGoalsSnapshot("2026-08-02", "2026-08-08", [], {
      rescuetimeConfigured: true,
      fetchError: "RescueTime API 401: unauthorized",
    });

    const report = formatSnapshotReport(snapshot);

    expect(report).toBe("RescueTime request failed: RescueTime API 401: unauthorized");
  });

  it("matches the same score the Weekly Review page would show for a known week", () => {
    // Same fixture as RescueTimeGoalsService's test: a single "more than 2h on
    // Personal (24x7)" goal with 3.5h logged against a 2h target, achieved at 0.25.
    const snapshot = computeRescueTimeGoalsSnapshot(
      "2026-08-02",
      "2026-08-08",
      [
        {
          goalId: 1,
          title: "more than 2h on Personal (24x7)",
          isMore: true,
          actualHours: 3.5,
          weeklyTargetHours: 14,
          achievement: 0.25,
          scheduleLabel: "24x7",
        },
      ],
      { rescuetimeConfigured: true },
    );

    expect(snapshot.score).toBe(0.25);

    const report = formatSnapshotReport(snapshot);

    expect(report).toContain("RescueTime Goals — week 2026-08-02 → 2026-08-08");
    expect(report).toContain("more than 2h on Personal (24x7)");
    expect(report).toContain("→ 0.25/1");
    expect(report).toContain("Weekly objectives score: 0.25 / 1 = 25.0%");
  });

  it("reports no goals cleanly", () => {
    const snapshot = computeRescueTimeGoalsSnapshot("2026-08-02", "2026-08-08", [], {
      rescuetimeConfigured: true,
    });

    expect(formatSnapshotReport(snapshot)).toContain(
      "No enabled RescueTime goals found for this week.",
    );
  });
});
