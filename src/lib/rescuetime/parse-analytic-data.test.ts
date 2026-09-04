import { parseRankRows, resolveObjectiveSeconds } from "./parse-analytic-data";

describe("parseRankRows", () => {
  it("uses the Category column for names when present", () => {
    const rows = parseRankRows({
      row_headers: ["Rank", "Time Spent (seconds)", "Number of People", "Category"],
      rows: [
        [1, 7200, 1, "Software Development"],
        [2, 3600, 1, "Professional Networking"],
      ],
    });

    expect(rows).toEqual([
      { name: "Software Development", seconds: 7200, hours: 2 },
      { name: "Professional Networking", seconds: 3600, hours: 1 },
    ]);
  });

  it("resolves a specific thing or sums all rows", () => {
    const rows = parseRankRows({
      row_headers: ["Rank", "Time Spent (seconds)", "Category"],
      rows: [
        [1, 7200, "Software Development"],
        [2, 3600, "Professional Networking"],
      ],
    });

    expect(resolveObjectiveSeconds(rows, "Software Development")).toBe(7200);
    expect(resolveObjectiveSeconds(rows, "Missing Category")).toBe(0);
    expect(resolveObjectiveSeconds(rows, null)).toBe(10800);
  });
});
