import { describe, expect, it } from "vitest";
import { buildMidWeekSnapshot } from "../context/mid-week-snapshot";
import { buildMidWeekInputs } from "../test-support/mid-week-fixtures";
import { buildLocalMidWeekSteering } from "./mid-week-steering-fallback";
import { validateMidWeekSteeringResponse } from "./mid-week-steering-validator";

describe("buildLocalMidWeekSteering", () => {
  it("builds ranked actions from lagging signals with their recovery lines", () => {
    const snapshot = buildMidWeekSnapshot(buildMidWeekInputs(), "full");
    const steering = buildLocalMidWeekSteering(snapshot);

    expect(steering.asOfDate).toBe("2026-08-05");
    expect(steering.actions.length).toBeGreaterThan(0);
    expect(steering.actions.length).toBeLessThanOrEqual(3);
    for (const item of steering.actions) {
      expect(snapshot.actionableKeys).toContain(item.signalKey);
    }
    const pomodoris = snapshot.signals.find((signal) => signal.key === "metric:pomodoris");
    const local = steering.actions.find((item) => item.signalKey === "metric:pomodoris");
    if (local) {
      expect(local.why).toBe(pomodoris?.recovery);
    }
    expect(validateMidWeekSteeringResponse(steering, snapshot.actionableKeys).ok).toBe(true);
  });

  it("returns no actions when nothing is actionable", () => {
    const snapshot = buildMidWeekSnapshot(buildMidWeekInputs(), "full");
    const steering = buildLocalMidWeekSteering({ ...snapshot, actionableKeys: [] });
    expect(steering.actions).toEqual([]);
    expect(validateMidWeekSteeringResponse(steering, []).ok).toBe(true);
  });
});
