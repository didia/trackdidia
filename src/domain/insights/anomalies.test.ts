import { addDays } from "../../lib/gtd/shared";
import { createEmptyDailyEntry, updateMetric, updatePrinciple } from "../daily-entry";
import { morningPrincipleKeys, principleDefinitions } from "../definitions";
import type { DailyEntry, PrincipleKey } from "../types";
import { computeAnomalyFindings } from "./anomalies";

const withPrincipleAnswers = (
  date: string,
  answers: Partial<Record<PrincipleKey, boolean>>,
): DailyEntry => {
  let entry = createEmptyDailyEntry(date);
  for (const key of Object.keys(answers) as PrincipleKey[]) {
    entry = updatePrinciple(entry, key, answers[key] as boolean);
  }
  return entry;
};

const withTruePrinciples = (date: string, keys: PrincipleKey[]): DailyEntry =>
  withPrincipleAnswers(
    date,
    keys.reduce<Partial<Record<PrincipleKey, boolean>>>(
      (acc, key) => ({ ...acc, [key]: true }),
      {},
    ),
  );

/** A fully-answered day: every principle explicitly `true` or `false` (nothing left `null`). */
const withAllPrinciplesAnswered = (date: string, trueKeys: PrincipleKey[]): DailyEntry =>
  withPrincipleAnswers(
    date,
    principleDefinitions.reduce<Partial<Record<PrincipleKey, boolean>>>(
      (acc, { key }) => ({ ...acc, [key]: trueKeys.includes(key) }),
      {},
    ),
  );

describe("anomalies insight module", () => {
  it("compares today's discipline to a personal baseline once the sample floor is met", () => {
    const baseline = Array.from({ length: 10 }, (_, index) =>
      withAllPrinciplesAnswered(addDays("2026-01-01", index), []),
    );
    const today = withTruePrinciples(
      "2026-01-11",
      principleDefinitions.slice(0, 7).map((definition) => definition.key),
    );
    const entries = [...baseline, today];

    const finding = computeAnomalyFindings(entries, "2026-01-11").find(
      (item) => item.subject === "discipline" && item.scope === "today",
    );

    // Today has exactly 7 principles answered, all `true`, and the other 7 still unanswered —
    // scored over the answered subset only, that's a perfect 1.00 against a fully-answered,
    // all-`false` baseline of 0.00.
    expect(finding).toBeDefined();
    expect(finding?.currentValue).toBeCloseTo(1);
    expect(finding?.baselineMean).toBeCloseTo(0);
    expect(finding?.delta).toBeCloseTo(1);
    expect(finding?.sampleSize).toBe(10);
    expect(finding?.severity).toBe("positive");
  });

  it("omits the today comparison below the minimum sample floor", () => {
    const baseline = Array.from({ length: 9 }, (_, index) =>
      withAllPrinciplesAnswered(addDays("2026-01-01", index), []),
    );
    const today = withAllPrinciplesAnswered(
      "2026-01-10",
      principleDefinitions.map((definition) => definition.key),
    );
    const entries = [...baseline, today];

    const finding = computeAnomalyFindings(entries, "2026-01-10").find(
      (item) => item.subject === "discipline" && item.scope === "today",
    );

    expect(finding).toBeUndefined();
  });

  it("does not fire a false week watch for a genuinely in-progress week", () => {
    const baseline = Array.from({ length: 10 }, (_, index) =>
      withAllPrinciplesAnswered(
        addDays("2026-01-01", index),
        principleDefinitions.map((definition) => definition.key),
      ),
    );
    // Sunday and Monday are fully-answered, perfect days. Tuesday (today) is only as far as the
    // morning routine: the morning/anytime principles are all answered `true`, the evening ones
    // are still `null`. This week is not a coincidental 7-of-14 boundary case — it's a real
    // in-progress week that should read as consistent with a perfect baseline, not a collapse.
    const currentWeek = [
      withAllPrinciplesAnswered(
        "2026-01-11",
        principleDefinitions.map((definition) => definition.key),
      ),
      withAllPrinciplesAnswered(
        "2026-01-12",
        principleDefinitions.map((definition) => definition.key),
      ),
      withTruePrinciples("2026-01-13", morningPrincipleKeys),
    ];
    const entries = [...baseline, ...currentWeek];

    const finding = computeAnomalyFindings(entries, "2026-01-13").find(
      (item) => item.subject === "discipline" && item.scope === "week",
    );

    expect(finding).toBeDefined();
    expect(finding?.currentValue).toBeCloseTo(1);
    expect(finding?.severity).not.toBe("watch");
  });

  it("returns no findings for empty history", () => {
    expect(computeAnomalyFindings([])).toEqual([]);
  });

  it("does not fire a false today watch for a routinely-incomplete morning", () => {
    const baseline = Array.from({ length: 12 }, (_, index) =>
      withAllPrinciplesAnswered(
        addDays("2026-01-01", index),
        principleDefinitions.map((definition) => definition.key),
      ),
    );
    const today = createEmptyDailyEntry("2026-01-13");
    const entries = [...baseline, today];

    const finding = computeAnomalyFindings(entries, "2026-01-13").find(
      (item) => item.subject === "discipline" && item.scope === "today",
    );

    expect(finding).toBeUndefined();
  });

  it("does not fire a false today watch when only the morning principles are answered so far", () => {
    // Reviewer's repro: 12 perfect baseline days, then today has all 8 morning/anytime
    // principles logged `true` and the 6 evening principles still unanswered (i.e. the user
    // just finished their morning routine). Scoring over all 14 principles used to make this
    // score 8/14 = 0.57 against a baseline of 1.00 and fire a false "watch"; scored over the
    // 8 answered principles only, it's a genuine 1.00 and no anomaly fires.
    const baseline = Array.from({ length: 12 }, (_, index) =>
      withAllPrinciplesAnswered(
        addDays("2026-01-01", index),
        principleDefinitions.map((definition) => definition.key),
      ),
    );
    const today = withTruePrinciples("2026-01-13", morningPrincipleKeys);
    const entries = [...baseline, today];

    const finding = computeAnomalyFindings(entries, "2026-01-13").find(
      (item) => item.subject === "discipline" && item.scope === "today",
    );

    expect(finding).toBeDefined();
    expect(finding?.currentValue).toBeCloseTo(1);
    expect(finding?.baselineMean).toBeCloseTo(1);
    expect(finding?.severity).not.toBe("watch");
  });

  it("still fires a watch when the principles answered so far are already worse than baseline", () => {
    const baseline = Array.from({ length: 12 }, (_, index) =>
      withAllPrinciplesAnswered(
        addDays("2026-01-01", index),
        principleDefinitions.map((definition) => definition.key),
      ),
    );
    // Only the first 4 morning principles are answered so far, and 3 of the 4 are `false` — a
    // real collapse among the principles actually answered, not just an incomplete day.
    const today = withPrincipleAnswers("2026-01-13", {
      [morningPrincipleKeys[0]]: false,
      [morningPrincipleKeys[1]]: false,
      [morningPrincipleKeys[2]]: false,
      [morningPrincipleKeys[3]]: true,
    });
    const entries = [...baseline, today];

    const finding = computeAnomalyFindings(entries, "2026-01-13").find(
      (item) => item.subject === "discipline" && item.scope === "today",
    );

    expect(finding).toBeDefined();
    expect(finding?.currentValue).toBeCloseTo(0.25);
    expect(finding?.severity).toBe("watch");
  });

  it("flags a real metric anomaly regardless of principle-answering state", () => {
    const baseline = Array.from({ length: 12 }, (_, index) =>
      updateMetric(createEmptyDailyEntry(addDays("2026-01-01", index)), "course", 5),
    );
    // Nothing has been answered for any principle today, which used to suppress every subject
    // (including unrelated metrics) via the principle-completeness gate. The `course` metric was
    // fully and validly logged at 0, so it should fire on its own merits.
    const today = updateMetric(createEmptyDailyEntry("2026-01-13"), "course", 0);
    const entries = [...baseline, today];

    const finding = computeAnomalyFindings(entries, "2026-01-13").find(
      (item) => item.subject === "course" && item.scope === "today",
    );

    expect(finding).toBeDefined();
    expect(finding?.currentValue).toBeCloseTo(0);
    expect(finding?.baselineMean).toBeCloseTo(5);
    expect(finding?.severity).toBe("watch");
  });
});
