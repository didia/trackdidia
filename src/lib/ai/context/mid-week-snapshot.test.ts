import { describe, expect, it } from "vitest";
import { buildMidWeekInputs } from "../test-support/mid-week-fixtures";
import { buildMidWeekSnapshot } from "./mid-week-snapshot";

describe("buildMidWeekSnapshot", () => {
  it("lists ranked lagging keys as the only actionable keys", () => {
    const snapshot = buildMidWeekSnapshot(buildMidWeekInputs(), "full");
    expect(snapshot.actionableKeys).toContain("metric:pomodoris");
    expect(snapshot.actionableKeys).toContain("rescuetime:7");
    const statuses = new Map(snapshot.signals.map((signal) => [signal.key, signal.status]));
    for (const key of snapshot.actionableKeys) {
      expect(["lagging", "at_risk"]).toContain(statuses.get(key));
    }
    expect(snapshot).toMatchObject({
      surface: "midweek",
      asOfDate: "2026-08-05",
      completedDays: 3,
    });
  });

  it("redacts user-authored titles below metrics_and_structure", () => {
    const metrics = JSON.stringify(buildMidWeekSnapshot(buildMidWeekInputs(), "metrics"));
    const structure = JSON.stringify(
      buildMidWeekSnapshot(buildMidWeekInputs(), "metrics_and_structure"),
    );
    expect(metrics).not.toContain("Projet Secret");
    expect(structure).toContain("Projet Secret");
  });

  it("includes journal text and decisions only at full scope", () => {
    for (const scope of ["metrics", "metrics_and_structure"] as const) {
      const snapshot = buildMidWeekSnapshot(buildMidWeekInputs(), scope);
      const serialized = JSON.stringify(snapshot);
      expect(snapshot.journal).toBeUndefined();
      expect(snapshot.decisions).toBeUndefined();
      expect(serialized).not.toContain("Acme");
      expect(serialized).not.toContain("Couper le téléphone");
    }
    const full = buildMidWeekSnapshot(buildMidWeekInputs(), "full");
    expect(full.decisions).toBe("Couper le téléphone");
    expect(full.journal).toEqual([
      {
        date: "2026-08-03",
        notes: [{ key: "nightReflection", text: "Journée difficile chez Acme" }],
      },
    ]);
  });

  it("omits decisions when there are none", () => {
    expect(
      buildMidWeekSnapshot(buildMidWeekInputs({ decisions: null }), "full").decisions,
    ).toBeUndefined();
  });
});
