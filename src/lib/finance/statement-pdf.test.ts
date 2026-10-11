import { describe, expect, it } from "vitest";

import { buildPageLines } from "./statement-pdf";

const item = (str: string, x: number, y: number, width = str.length * 5) => ({
  str,
  width,
  transform: [1, 0, 0, 1, x, y],
});

describe("buildPageLines", () => {
  it("joins fragments on one baseline left to right and separates columns", () => {
    const lines = buildPageLines([
      item("1 234,56 $", 400, 700),
      item("Nouveau solde", 50, 700.4),
      item("Période du 1er mars", 50, 720),
    ]);
    expect(lines).toEqual(["Période du 1er mars", "Nouveau solde   1 234,56 $"]);
  });

  it("drops blank fragments", () => {
    expect(buildPageLines([item(" ", 0, 10), item("x", 0, 10)])).toEqual(["x"]);
  });
});
