import { describe, expect, it } from "vitest";
import type { RescueTimeGoalRecord } from "../../domain/rescuetime-goals";
import { matchRankRowSeconds } from "./goals-client";

const overviewGoal = (name: string): RescueTimeGoalRecord => ({
  id: 1,
  display_name: `goal on ${name}`,
  amount_seconds: 3600,
  is_more: true,
  taxon_id: 1,
  taxonomy_name: "overview",
  overview: { name }
});

describe("matchRankRowSeconds", () => {
  const nestedRows = [
    { name: "Work", seconds: 100, hours: 100 / 3600 },
    { name: "Network Work", seconds: 200, hours: 200 / 3600 }
  ];

  it("prefers exact match over nested substring collision", () => {
    expect(matchRankRowSeconds(nestedRows, overviewGoal("Network Work"), "overview")).toBe(200);
  });

  it("matches shorter label exactly without picking nested row", () => {
    expect(matchRankRowSeconds(nestedRows, overviewGoal("Work"), "overview")).toBe(100);
  });

  it("returns nested row even when Work appears first in rank data", () => {
    const reversedRows = [
      { name: "Work", seconds: 100, hours: 100 / 3600 },
      { name: "Network Work", seconds: 200, hours: 200 / 3600 }
    ];
    expect(matchRankRowSeconds(reversedRows, overviewGoal("Network Work"), "overview")).toBe(200);
  });

  it("prefers longest partial match when no exact match exists", () => {
    const partialRows = [
      { name: "Dev", seconds: 50, hours: 50 / 3600 },
      { name: "Dev Tools", seconds: 150, hours: 150 / 3600 }
    ];
    expect(matchRankRowSeconds(partialRows, overviewGoal("Dev Tool"), "overview")).toBe(150);
  });
});
