import { describe, expect, it } from "vitest";
import { computeProductivityPulse, productivitySecondsForGoal } from "./productivity-mapping";

describe("productivitySecondsForGoal", () => {
  const rows = [
    { productivity: 2, seconds: 3600 },
    { productivity: 1, seconds: 1800 },
    { productivity: 0, seconds: 900 },
    { productivity: -1, seconds: 600 },
    { productivity: -2, seconds: 300 },
  ];

  it("sums all distracting time for aggregate id 7", () => {
    expect(
      productivitySecondsForGoal(rows, {
        id: 1,
        display_name: "less distracting",
        amount_seconds: 3600,
        is_more: false,
        taxon_id: 7,
        productivity: { id: 7, sql_score_equals: "< 0" },
      }),
    ).toBe(900);
  });

  it("sums all time for aggregate id 10", () => {
    expect(
      productivitySecondsForGoal(rows, {
        id: 2,
        display_name: "all time",
        amount_seconds: 3600,
        is_more: false,
        taxon_id: 10,
        productivity: { id: 10, sql_score_equals: "BETWEEN -2 and 2" },
      }),
    ).toBe(7200);
  });

  it("matches individual focus-work goals by productivity name", () => {
    expect(
      productivitySecondsForGoal(rows, {
        id: 3,
        display_name: "more focus work",
        amount_seconds: 3600,
        is_more: true,
        taxon_id: 2,
        productivity: { id: 2, name: "very productive", display_name: "Focus Work" },
      }),
    ).toBe(3600);
  });
});

describe("computeProductivityPulse", () => {
  it("returns a time-weighted pulse on a 0-100 scale", () => {
    expect(
      computeProductivityPulse([
        { productivity: 2, seconds: 3600 },
        { productivity: 0, seconds: 3600 },
      ]),
    ).toBe(75);
  });

  it("returns null when no tracked seconds remain", () => {
    expect(computeProductivityPulse([])).toBeNull();
    expect(computeProductivityPulse([{ productivity: 1, seconds: 0 }])).toBeNull();
  });

  it("skips rows with non-finite values", () => {
    expect(
      computeProductivityPulse([
        { productivity: Number.NaN, seconds: 3600 },
        { productivity: 2, seconds: Number.POSITIVE_INFINITY },
        { productivity: 1, seconds: 1800 },
      ]),
    ).toBe(75);
  });

  it("clamps pulse to 0-100", () => {
    expect(computeProductivityPulse([{ productivity: 2, seconds: 3600 }])).toBe(100);
    expect(computeProductivityPulse([{ productivity: -2, seconds: 3600 }])).toBe(0);
  });
});
