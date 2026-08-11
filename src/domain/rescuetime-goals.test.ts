import { describe, expect, it } from "vitest";
import {
  computeRescueTimeGoalsSnapshot,
  rescueTimeLabelsMatch,
  scheduleDaysInWeek,
  scoreLessGoal,
  scoreMoreGoal
} from "./rescuetime-goals";

describe("rescuetime-goals", () => {
  it("scores fractional more-time goals", () => {
    expect(scoreMoreGoal(3600, 7200)).toBe(0.5);
    expect(scoreMoreGoal(10800, 7200)).toBe(1);
  });

  it("scores less-time goals with partial credit when over target", () => {
    expect(scoreLessGoal(1800, 3600)).toBe(1);
    expect(scoreLessGoal(7200, 3600)).toBe(0.5);
  });

  it("computes weekly score as average achievement", () => {
    const snapshot = computeRescueTimeGoalsSnapshot(
      "2026-08-02",
      "2026-08-08",
      [
        {
          goalId: 1,
          title: "A",
          isMore: true,
          actualHours: 1,
          weeklyTargetHours: 2,
          achievement: 0.5,
          scheduleLabel: "24x7"
        },
        {
          goalId: 2,
          title: "B",
          isMore: true,
          actualHours: 2,
          weeklyTargetHours: 2,
          achievement: 1,
          scheduleLabel: "24x7"
        }
      ],
      { rescuetimeConfigured: true }
    );

    expect(snapshot.totalAchievement).toBe(1.5);
    expect(snapshot.score).toBe(0.75);
  });

  it("maps working-day schedules to five days", () => {
    expect(scheduleDaysInWeek("Working days")).toBe(5);
    expect(scheduleDaysInWeek("24x7")).toBe(7);
  });

  it("matches project labels fuzzily", () => {
    expect(rescueTimeLabelsMatch("Advanceo - CTO", "Advanceo Fractional CTO")).toBe(true);
  });
});
