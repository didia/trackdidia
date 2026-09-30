import { describe, expect, it } from "vitest";
import { addDays } from "../lib/gtd/shared";
import { createEmptyDailyEntry } from "./daily-entry";
import {
  buildMidWeekLaggingSnapshot,
  buildMidWeekPaceWindow,
  buildMidWeekReviewSummary,
  compareMidWeekSnapshot,
  computeMidWeekPaceRatio,
  computeMidWeekStatus,
  MID_WEEK_LAGGING_THRESHOLD,
  MID_WEEK_PACE_TOLERANCE,
  MID_WEEK_SHORTFALL_PRECISION,
  type MidWeekLaggingSnapshot,
  type MidWeekReviewSummary,
  type MidWeekSignal,
  parseMidWeekLaggingSnapshot,
  rankMidWeekSignals,
} from "./mid-week-review";
import {
  computeRescueTimeGoalsSnapshot,
  type RescueTimeGoalItemSnapshot,
} from "./rescuetime-goals";
import type { DailyEntry, PrincipleKey, WeeklyObjectivesSnapshot } from "./types";
import { createEmptyWeeklyObjective } from "./weekly-objectives";

const WEEK = "2026-08-02"; // Sunday
const WEDNESDAY = "2026-08-05";
const WEEK_OVER = "2026-08-09";

const makeWeek = (mutate?: (entries: DailyEntry[]) => void): DailyEntry[] => {
  const entries = Array.from({ length: 7 }, (_, index) =>
    createEmptyDailyEntry(addDays(WEEK, index)),
  );
  mutate?.(entries);
  return entries;
};

const summarize = (
  overrides: Partial<Parameters<typeof buildMidWeekReviewSummary>[0]> = {},
): MidWeekReviewSummary =>
  buildMidWeekReviewSummary({
    weekStartDate: WEEK,
    asOfDate: WEDNESDAY,
    weekEntries: makeWeek(),
    summary: null,
    goalsSnapshot: null,
    pulseSnapshot: null,
    objectivesSnapshot: null,
    ...overrides,
  });

const signalOf = (summary: MidWeekReviewSummary, key: string): MidWeekSignal => {
  const signal = summary.signals.find((item) => item.key === key);
  if (!signal) {
    throw new Error(`Missing signal ${key}`);
  }
  return signal;
};

const goalItem = (
  overrides: Partial<RescueTimeGoalItemSnapshot> = {},
): RescueTimeGoalItemSnapshot => ({
  goalId: 1,
  title: "Goal",
  isMore: true,
  actualHours: 0,
  weeklyTargetHours: 14,
  achievement: 0,
  scheduleLabel: "24x7",
  ...overrides,
});

const goalsOf = (items: RescueTimeGoalItemSnapshot[], configured = true, fetchError?: string) =>
  computeRescueTimeGoalsSnapshot(WEEK, "2026-08-08", items, {
    rescuetimeConfigured: configured,
    fetchError,
  });

const objectivesOf = (items: WeeklyObjectivesSnapshot["items"]): WeeklyObjectivesSnapshot => ({
  weekStartDate: WEEK,
  weekEndDate: "2026-08-08",
  items,
  totalAchievement: 0,
  score: null,
  rescuetimeConfigured: true,
});

const timeObjective = (id: string, targetHours: number | null = 7) =>
  createEmptyWeeklyObjective({
    id,
    title: `Objectif ${id}`,
    kind: "time",
    targetHours,
    rescuetimeKind: "category",
    rescuetimeThing: "Dev",
  });

describe("buildMidWeekPaceWindow", () => {
  it("counts completed and remaining days through the week", () => {
    expect(buildMidWeekPaceWindow(WEEK, "2026-08-02")).toMatchObject({
      completedDays: 0,
      remainingDays: 7,
      dayIndex: 0,
    });
    expect(buildMidWeekPaceWindow(WEEK, WEDNESDAY)).toMatchObject({
      completedDays: 3,
      remainingDays: 4,
      dayIndex: 3,
      asOfDate: WEDNESDAY,
      weekEndDate: "2026-08-08",
    });
    expect(buildMidWeekPaceWindow(WEEK, "2026-08-08")).toMatchObject({
      completedDays: 6,
      remainingDays: 1,
      dayIndex: 6,
    });
  });

  it("reports 7/0 with a null dayIndex once the week is over, clamping asOfDate", () => {
    expect(buildMidWeekPaceWindow(WEEK, WEEK_OVER)).toMatchObject({
      completedDays: 7,
      remainingDays: 0,
      dayIndex: null,
      asOfDate: WEEK_OVER,
    });
    expect(buildMidWeekPaceWindow(WEEK, "2026-08-20")).toMatchObject({
      completedDays: 7,
      remainingDays: 0,
      dayIndex: null,
      asOfDate: WEEK_OVER,
    });
  });

  it("gives 0/7 for a date before the week", () => {
    expect(buildMidWeekPaceWindow(WEEK, "2026-07-20")).toMatchObject({
      completedDays: 0,
      remainingDays: 7,
      asOfDate: WEEK,
      dayIndex: 0,
    });
  });

  it("normalizes a non-Sunday week start", () => {
    expect(buildMidWeekPaceWindow("2026-08-05", WEDNESDAY)).toMatchObject({
      weekStartDate: WEEK,
      completedDays: 3,
    });
  });
});

describe("cumulative metrics", () => {
  const withPomodoris = (values: (number | null)[]) =>
    makeWeek((entries) => {
      values.forEach((value, index) => {
        entries[index].metrics.pomodoris = value;
      });
    });

  it("treats 24 pomodoros over 3 logged days as on_pace", () => {
    const signal = signalOf(
      summarize({ weekEntries: withPomodoris([8, 8, 8]) }),
      "metric:pomodoris",
    );
    expect(signal).toMatchObject({
      status: "on_pace",
      actual: 24,
      expected: 24,
      weekTarget: 56,
      daysApplicable: 3,
      daysWithData: 3,
      hasFullCoverage: true,
    });
  });

  it("marks 8 pomodoros as lagging with 48 left over 4 days", () => {
    const signal = signalOf(
      summarize({ weekEntries: withPomodoris([8, 0, 0]) }),
      "metric:pomodoris",
    );
    expect(signal).toMatchObject({
      status: "lagging",
      remaining: 48,
      perRemainingDay: 12,
    });
    expect(signal.recovery).toContain("48");
    expect(signal.recovery).toContain("12");
  });

  it("excludes completed days without a value from daysWithData", () => {
    const signal = signalOf(
      summarize({ weekEntries: withPomodoris([8, 8, null]) }),
      "metric:pomodoris",
    );
    expect(signal).toMatchObject({
      daysApplicable: 3,
      daysWithData: 2,
      expected: (56 / 7) * 2,
      hasFullCoverage: false,
    });
    expect(signal.recovery).toContain("2");
  });

  it("counts a suggested metric when the explicit value is null", () => {
    const entries = withPomodoris([null, null, null]);
    entries[0].suggestedMetrics = { pomodoris: 8 };
    const signal = signalOf(summarize({ weekEntries: entries }), "metric:pomodoris");
    expect(signal).toMatchObject({ actual: 8, daysWithData: 1 });
  });

  it("is unknown when nothing is logged", () => {
    const signal = signalOf(summarize(), "metric:pomodoris");
    expect(signal).toMatchObject({
      status: "unknown",
      paceRatio: null,
      severity: null,
      daysWithData: 0,
    });
  });

  it("sets weekTarget for calories from the daily target", () => {
    expect(signalOf(summarize(), "metric:depenseCalorique").weekTarget).toBe(3800 * 7);
  });
});

describe("less-is-better metrics (phone screen time)", () => {
  const phone = (actual: number) =>
    signalOf(
      summarize({
        weekEntries: makeWeek((entries) => {
          entries[0].metrics.tempsEcranTelephone = actual;
          entries[1].metrics.tempsEcranTelephone = 0;
          entries[2].metrics.tempsEcranTelephone = 0;
        }),
      }),
      "metric:tempsEcranTelephone",
    );

  it("is ahead with a finite ratio when nothing was used", () => {
    const signal = phone(0);
    expect(signal.status).toBe("ahead");
    expect(signal.paceRatio).toBe(2);
    expect(signal.weekTarget).toBe(840);
  });

  it("is ahead when more than 10 % under budget", () => {
    expect(phone(300).status).toBe("ahead"); // budget 360
  });

  it("is on_pace at exactly 10 % over, at_risk at 15 % and lagging far over", () => {
    expect(phone(396).status).toBe("on_pace");
    expect(phone(414).status).toBe("at_risk");
    expect(phone(600).status).toBe("lagging");
  });

  it("reports no remaining budget once it is spent", () => {
    expect(phone(900)).toMatchObject({ remaining: 0, status: "lagging" });
  });
});

describe("quality, principles and discipline", () => {
  it("averages sleep quality over days that have a value", () => {
    const signal = signalOf(
      summarize({
        weekEntries: makeWeek((entries) => {
          entries[0].metrics.qualiteSommeil = 80;
          entries[2].metrics.qualiteSommeil = 60;
        }),
      }),
      "metric:qualiteSommeil",
    );
    expect(signal).toMatchObject({
      actual: 70,
      expected: 100,
      weekTarget: 100,
      status: "lagging",
      daysApplicable: 3,
      daysWithData: 2,
    });
  });

  it("does not count an unanswered principle as a miss, but a false answer is", () => {
    const signal = signalOf(
      summarize({
        weekEntries: makeWeek((entries) => {
          entries[0].principleChecks.respectTrc = true;
          entries[2].principleChecks.respectTrc = false;
        }),
      }),
      "principle:respectTrc",
    );
    expect(signal).toMatchObject({
      actual: 1,
      expected: 2,
      weekTarget: 7,
      daysApplicable: 3,
      daysWithData: 2,
      status: "lagging",
    });
  });

  it("is unknown when a principle was never answered", () => {
    expect(signalOf(summarize(), "principle:respectTrc").status).toBe("unknown");
  });

  it("scores discipline over answered principles only", () => {
    const signal = signalOf(
      summarize({
        weekEntries: makeWeek((entries) => {
          entries[0].principleChecks.priereDuMatin = true;
          entries[0].principleChecks.ecriture = false;
          entries[2].principleChecks.priereDuMatin = true;
        }),
      }),
      "habit:discipline",
    );
    expect(signal).toMatchObject({
      key: "habit:discipline",
      category: "habit",
      actual: 0.75,
      expected: 1,
      weekTarget: 1,
      daysApplicable: 3,
      daysWithData: 2,
    });
  });
});

describe("tasks", () => {
  const tasks = (rows: [number | null, number | null][], asOfDate = WEDNESDAY) =>
    signalOf(
      summarize({
        asOfDate,
        weekEntries: makeWeek((entries) => {
          rows.forEach(([added, done], index) => {
            entries[index].metrics.tachesAjoutes = added;
            entries[index].metrics.tachesRealises = done;
          });
        }),
      }),
      "tasks:completion",
    );

  it("is unknown when nothing was added or completed", () => {
    expect(tasks([[0, 0]]).status).toBe("unknown");
    expect(tasks([]).status).toBe("unknown");
  });

  it("handles break-even counts", () => {
    expect(
      tasks([
        [3, 3],
        [2, 2],
      ]),
    ).toMatchObject({
      status: "on_pace",
      remaining: 0,
      actual: 5,
      expected: 5,
    });
    expect(tasks([[4, 2]])).toMatchObject({ status: "lagging", remaining: 2, paceRatio: 0.5 });
    expect(tasks([[0, 3]])).toMatchObject({ paceRatio: 1, status: "on_pace" });
  });

  it("uses the week's added total as weekTarget", () => {
    expect(
      tasks([
        [3, 3],
        [2, 2],
        [0, 0],
        [5, 0],
      ]).weekTarget,
    ).toBe(10);
  });
});

describe("journal", () => {
  it("counts non-empty reflections against logged days, not calendar days", () => {
    const entries = makeWeek((week) => {
      week[1].status = "closed";
      week[1].nightReflection = "Bien";
      week[2].status = "closed";
      week[2].nightReflection = "Calme";
    });
    const signal = signalOf(summarize({ weekEntries: entries }), "journal:reflections");
    expect(signal).toMatchObject({
      actual: 2,
      expected: 2,
      status: "on_pace",
      daysApplicable: 3,
      daysWithData: 2,
      weekTarget: 7,
      hasFullCoverage: false,
    });
  });

  it("treats a closed day with an empty reflection as a miss", () => {
    const entries = makeWeek((week) => {
      week[0].status = "closed";
      week[1].status = "closed";
      week[1].nightReflection = "Ok";
    });
    expect(signalOf(summarize({ weekEntries: entries }), "journal:reflections")).toMatchObject({
      actual: 1,
      expected: 2,
      status: "lagging",
    });
  });

  it("ignores whitespace-only reflections on unclosed days", () => {
    const entries = makeWeek((week) => {
      week[0].nightReflection = "   ";
    });
    expect(signalOf(summarize({ weekEntries: entries }), "journal:reflections").status).toBe(
      "unknown",
    );
  });
});

describe("RescueTime goals", () => {
  it("marks a 24x7 more goal at half the pro-rated target as lagging", () => {
    const goal = goalItem({ actualHours: 3, weeklyTargetHours: 14 });
    const signal = signalOf(summarize({ goalsSnapshot: goalsOf([goal]) }), "rescuetime:1");
    expect(signal).toMatchObject({
      expected: 6,
      actual: 3,
      status: "lagging",
      weekTarget: 14,
      daysApplicable: 3,
      daysWithData: 3,
      hasFullCoverage: true,
    });
  });

  it("counts 2 completed weekdays for a 5-day goal on Wednesday", () => {
    const goal = goalItem({
      scheduleLabel: "Working hours",
      weeklyTargetHours: 10,
      actualHours: 4,
    });
    const signal = signalOf(summarize({ goalsSnapshot: goalsOf([goal]) }), "rescuetime:1");
    expect(signal.daysApplicable).toBe(2);
    expect(signal.expected).toBe(4);
    expect(signal.status).toBe("on_pace");
  });

  it("includes today for a less goal but not for a more goal on the same fixture", () => {
    const base = { scheduleLabel: "Working hours", weeklyTargetHours: 10, actualHours: 4 };
    const summary = summarize({
      goalsSnapshot: goalsOf([
        goalItem({ ...base, goalId: 1, isMore: true }),
        goalItem({ ...base, goalId: 2, isMore: false }),
      ]),
    });
    expect(signalOf(summary, "rescuetime:1").daysApplicable).toBe(2);
    expect(signalOf(summary, "rescuetime:2").daysApplicable).toBe(3);
    expect(signalOf(summary, "rescuetime:2").expected).toBe(6);
  });

  it("does not add today for a less goal on a non-schedule day", () => {
    const summary = summarize({
      asOfDate: "2026-08-08", // Saturday
      goalsSnapshot: goalsOf([
        goalItem({ scheduleLabel: "Working hours", weeklyTargetHours: 10, isMore: false }),
      ]),
    });
    expect(signalOf(summary, "rescuetime:1").daysApplicable).toBe(5);
  });

  it("gives a less goal exactly weeklyTargetHours once the week is over", () => {
    const summary = summarize({
      asOfDate: WEEK_OVER,
      goalsSnapshot: goalsOf([goalItem({ isMore: false, weeklyTargetHours: 14, actualHours: 14 })]),
    });
    const signal = signalOf(summary, "rescuetime:1");
    expect(signal.expected).toBe(14);
    expect(signal.expected).toBeLessThanOrEqual(signal.weekTarget as number);
    expect(signal.daysApplicable).toBe(7);
  });

  it("is unknown without a configured key or with a fetchError, while other signals compute", () => {
    const entries = makeWeek((week) => {
      week[0].metrics.pomodoris = 8;
    });
    for (const goalsSnapshot of [
      goalsOf([goalItem({ actualHours: 5 })], false),
      goalsOf([goalItem({ actualHours: 5 })], true, "offline"),
    ]) {
      const summary = summarize({ goalsSnapshot, weekEntries: entries });
      expect(signalOf(summary, "rescuetime:1")).toMatchObject({
        status: "unknown",
        daysWithData: 0,
      });
      expect(signalOf(summary, "metric:pomodoris").status).not.toBe("unknown");
    }
  });

  it("emits no goal signals without a snapshot", () => {
    expect(summarize().signals.some((signal) => signal.key.startsWith("rescuetime:"))).toBe(false);
  });
});

describe("objectives", () => {
  it("pro-rates time objectives", () => {
    const item = {
      objective: timeObjective("a", 7),
      actualHours: 3,
      achievement: 0.4,
      source: "rescuetime" as const,
    };
    const signal = signalOf(summarize({ objectivesSnapshot: objectivesOf([item]) }), "objective:a");
    expect(signal).toMatchObject({
      expected: 3,
      actual: 3,
      status: "on_pace",
      weekTarget: 7,
      daysApplicable: 3,
      daysWithData: 3,
    });
  });

  it("is unknown for a null hours value or an item error", () => {
    const nullHours = {
      objective: timeObjective("a"),
      actualHours: null,
      achievement: 0,
      source: "missing" as const,
    };
    const errored = {
      objective: timeObjective("b"),
      actualHours: 2,
      achievement: 0,
      source: "missing" as const,
      error: "down",
    };
    const summary = summarize({ objectivesSnapshot: objectivesOf([nullHours, errored]) });
    expect(signalOf(summary, "objective:a")).toMatchObject({ status: "unknown", daysWithData: 0 });
    expect(signalOf(summary, "objective:b")).toMatchObject({ status: "unknown", daysWithData: 0 });
  });

  it("is ahead for an achieved manual objective and unknown otherwise", () => {
    const manual = createEmptyWeeklyObjective({ id: "m", title: "Manuel", kind: "manual" });
    const done = {
      objective: manual,
      actualHours: null,
      achievement: 1,
      source: "manual" as const,
    };
    const open = { ...done, achievement: 0 };
    expect(
      signalOf(summarize({ objectivesSnapshot: objectivesOf([done]) }), "objective:m"),
    ).toMatchObject({ status: "ahead", daysApplicable: 1, daysWithData: 1, weekTarget: 1 });
    expect(
      signalOf(summarize({ objectivesSnapshot: objectivesOf([open]) }), "objective:m"),
    ).toMatchObject({ status: "unknown", daysApplicable: 1, daysWithData: 0 });
  });
});

describe("status thresholds and floating point", () => {
  it("uses the exported constants and inclusive boundaries", () => {
    expect(MID_WEEK_PACE_TOLERANCE).toBe(0.1);
    expect(MID_WEEK_LAGGING_THRESHOLD).toBe(0.25);
    expect(MID_WEEK_SHORTFALL_PRECISION).toBe(1e9);
    expect(computeMidWeekStatus(1 + MID_WEEK_PACE_TOLERANCE)).toBe("ahead");
    expect(computeMidWeekStatus(1 + MID_WEEK_PACE_TOLERANCE - 0.001)).toBe("on_pace");
    expect(computeMidWeekStatus(1)).toBe("on_pace");
    expect(computeMidWeekStatus(1 - MID_WEEK_PACE_TOLERANCE)).toBe("on_pace");
    expect(computeMidWeekStatus(1 - MID_WEEK_PACE_TOLERANCE - 0.001)).toBe("at_risk");
    expect(computeMidWeekStatus(1 - MID_WEEK_LAGGING_THRESHOLD + 0.001)).toBe("at_risk");
    expect(computeMidWeekStatus(1 - MID_WEEK_LAGGING_THRESHOLD)).toBe("lagging");
    expect(computeMidWeekStatus(null)).toBe("unknown");
  });

  const statusFor = (direction: "more" | "less", expected: number, actual: number) =>
    computeMidWeekStatus(computeMidWeekPaceRatio(direction, actual, expected));

  it("keeps exact decimal and integer boundaries stable", () => {
    expect(2 - 110 / 100).not.toBe(0.9); // the raw ratio is off by one ulp
    expect(statusFor("less", 100, 110)).toBe("on_pace");
    expect(statusFor("less", 0.3, 0.33)).toBe("on_pace");
    expect(statusFor("less", 7.7, 9.625)).toBe("lagging");
    expect(statusFor("more", 0.7, 0.63)).toBe("on_pace");
    expect(statusFor("more", 0.7, 0.525)).toBe("lagging");
    expect(statusFor("more", 0.7, 0.77)).toBe("ahead");
  });

  it("applies the same policy end to end for a less goal at exactly 10 % over", () => {
    const summary = summarize({
      asOfDate: WEEK_OVER,
      goalsSnapshot: goalsOf([
        goalItem({ isMore: false, weeklyTargetHours: 100, actualHours: 110 }),
      ]),
    });
    expect(signalOf(summary, "rescuetime:1").status).toBe("on_pace");
  });

  it("returns null ratios for a non-positive expected value", () => {
    expect(computeMidWeekPaceRatio("more", 3, 0)).toBeNull();
    expect(computeMidWeekPaceRatio("less", 3, 0)).toBeNull();
    expect(computeMidWeekPaceRatio("more", null, 5)).toBeNull();
  });
});

describe("ranking and pace score", () => {
  it("ranks a one-day signal below an equally lagging three-day signal and breaks ties on key", () => {
    const entries = makeWeek((week) => {
      for (const key of ["priereDuMatin", "ecriture"] as PrincipleKey[]) {
        week[0].principleChecks[key] = false;
        week[1].principleChecks[key] = false;
        week[2].principleChecks[key] = false;
      }
      week[0].principleChecks.apprentissage = false;
    });
    const summary = summarize({ weekEntries: entries });
    const keys = summary.lagging.map((signal) => signal.key);
    expect(keys.indexOf("principle:ecriture")).toBeLessThan(
      keys.indexOf("principle:priereDuMatin"),
    );
    expect(keys.indexOf("principle:priereDuMatin")).toBeLessThan(
      keys.indexOf("principle:apprentissage"),
    );
    const apprentissage = signalOf(summary, "principle:apprentissage");
    const ecriture = signalOf(summary, "principle:ecriture");
    expect(apprentissage.severity as number).toBeLessThan(ecriture.severity as number);
    expect(rankMidWeekSignals([apprentissage, ecriture]).map((s) => s.key)).toEqual([
      "principle:ecriture",
      "principle:apprentissage",
    ]);
  });

  it("returns a null paceScore when every signal is unknown", () => {
    expect(summarize().paceScore).toBeNull();
  });

  it("averages clamped pace ratios of known signals", () => {
    const entries = makeWeek((week) => {
      week[0].metrics.pomodoris = 16; // ratio 2, clamped to 1
      week[0].principleChecks.respectTrc = true;
      week[1].principleChecks.respectTrc = false;
    });
    const summary = summarize({ weekEntries: entries });
    const known = summary.signals.filter((signal) => signal.status !== "unknown");
    expect(known.map((signal) => signal.key).sort()).toEqual(
      ["habit:discipline", "metric:pomodoris", "principle:respectTrc"].sort(),
    );
    expect(summary.paceScore).toBeCloseTo((1 + 0.5 + 0.5) / 3, 10);
  });
});

describe("coverage per category", () => {
  const fullWeek = makeWeek((week) => {
    for (const entry of week) {
      entry.metrics.tachesAjoutes = 2;
      entry.metrics.tachesRealises = 2;
    }
    week[3].status = "closed";
    week[3].nightReflection = "A";
    week[4].status = "closed";
    week[4].nightReflection = "B";
  });
  const atEnd = () =>
    summarize({
      asOfDate: WEEK_OVER,
      weekEntries: fullWeek,
      goalsSnapshot: goalsOf([
        goalItem({
          goalId: 1,
          scheduleLabel: "Working hours",
          weeklyTargetHours: 10,
          actualHours: 10,
        }),
        goalItem({ goalId: 2, actualHours: 14 }),
      ]),
      objectivesSnapshot: objectivesOf([
        { objective: timeObjective("t", 7), actualHours: 7, achievement: 1, source: "rescuetime" },
        {
          objective: createEmptyWeeklyObjective({ id: "m", title: "M", kind: "manual" }),
          actualHours: null,
          achievement: 1,
          source: "manual",
        },
      ]),
    });

  it("matches the coverage table mid-week", () => {
    const summary = summarize({
      weekEntries: makeWeek((week) => {
        week[0].metrics.pomodoris = 8;
        week[1].principleChecks.respectTrc = true;
        week[0].metrics.tachesAjoutes = 1;
        week[1].status = "closed";
      }),
    });
    expect(signalOf(summary, "metric:pomodoris")).toMatchObject({
      daysApplicable: 3,
      daysWithData: 1,
    });
    expect(signalOf(summary, "principle:respectTrc")).toMatchObject({
      daysApplicable: 3,
      daysWithData: 1,
    });
    expect(signalOf(summary, "habit:discipline")).toMatchObject({
      daysApplicable: 3,
      daysWithData: 1,
    });
    expect(signalOf(summary, "tasks:completion")).toMatchObject({
      daysApplicable: 3,
      daysWithData: 1,
    });
    expect(signalOf(summary, "journal:reflections")).toMatchObject({
      daysApplicable: 3,
      daysWithData: 1,
    });
    expect(signalOf(summary, "metric:pomodoris").hasFullCoverage).toBe(false);
  });

  it("is full for known automatic signals at the end of the week", () => {
    const summary = atEnd();
    expect(signalOf(summary, "rescuetime:1")).toMatchObject({
      daysApplicable: 5,
      daysWithData: 5,
      hasFullCoverage: true,
    });
    expect(signalOf(summary, "rescuetime:2")).toMatchObject({
      daysApplicable: 7,
      daysWithData: 7,
      hasFullCoverage: true,
    });
    expect(signalOf(summary, "tasks:completion")).toMatchObject({
      daysApplicable: 7,
      daysWithData: 7,
      hasFullCoverage: true,
    });
    expect(signalOf(summary, "objective:t")).toMatchObject({
      daysApplicable: 7,
      daysWithData: 7,
      hasFullCoverage: true,
    });
    expect(signalOf(summary, "objective:m")).toMatchObject({
      daysApplicable: 1,
      daysWithData: 1,
      hasFullCoverage: true,
    });
  });

  it("marks the journal with two closed days and five unlogged days as 2/7, not full", () => {
    expect(signalOf(atEnd(), "journal:reflections")).toMatchObject({
      daysApplicable: 7,
      daysWithData: 2,
      hasFullCoverage: false,
    });
  });
});

describe("empty week", () => {
  it("never throws and never produces a non-finite number", () => {
    for (const asOfDate of ["2026-07-01", WEEK, WEDNESDAY, "2026-08-08", WEEK_OVER, "2027-01-01"]) {
      const summary = buildMidWeekReviewSummary({
        weekStartDate: WEEK,
        asOfDate,
        weekEntries: [],
        summary: null,
        goalsSnapshot: null,
        pulseSnapshot: null,
        objectivesSnapshot: null,
      });
      const numbers: unknown[] = [
        summary.paceScore,
        summary.completedDayCount,
        summary.closedDayCount,
      ];
      for (const signal of summary.signals) {
        numbers.push(
          signal.actual,
          signal.expected,
          signal.weekTarget,
          signal.paceRatio,
          signal.remaining,
          signal.perRemainingDay,
          signal.severity,
          signal.daysApplicable,
          signal.daysWithData,
        );
      }
      for (const value of numbers) {
        expect(value === null || Number.isFinite(value as number)).toBe(true);
      }
      expect(summary.paceScore).toBeNull();
    }
  });

  it("gives no verdict on Sunday because no day has completed", () => {
    const summary = summarize({ asOfDate: WEEK });
    expect(summary.completedDayCount).toBe(0);
    expect(summary.lagging).toEqual([]);
  });
});

describe("lagging snapshot", () => {
  const allFalse = () =>
    makeWeek((week) => {
      for (const index of [0, 1, 2]) {
        for (const { key } of Object.keys(week[index].principleChecks).map((k) => ({ key: k }))) {
          week[index].principleChecks[key as PrincipleKey] = false;
        }
      }
      week[0].metrics.pomodoris = 8;
      week[1].metrics.pomodoris = 8;
      week[2].metrics.pomodoris = 8;
    });

  it("keeps only lagging and at_risk signals, ranked and capped at 10", () => {
    const summary = summarize({ weekEntries: allFalse() });
    expect(summary.lagging.length).toBeGreaterThan(10);
    const snapshot = buildMidWeekLaggingSnapshot(summary);
    expect(snapshot).toMatchObject({ version: 1, asOfDate: WEDNESDAY, completedDays: 3 });
    expect(snapshot.signals).toHaveLength(10);
    expect(snapshot.signals.map((signal) => signal.key)).toEqual(
      summary.lagging.slice(0, 10).map((signal) => signal.key),
    );
    expect(snapshot.signals.every((s) => s.status === "lagging" || s.status === "at_risk")).toBe(
      true,
    );
    expect(snapshot.signals.some((s) => s.key === "metric:pomodoris")).toBe(false);
  });

  it("round-trips through JSON and rejects bad JSON or an unknown version", () => {
    const snapshot = buildMidWeekLaggingSnapshot(summarize({ weekEntries: allFalse() }));
    expect(parseMidWeekLaggingSnapshot(JSON.stringify(snapshot))).toEqual(snapshot);
    expect(parseMidWeekLaggingSnapshot("{not json")).toBeNull();
    expect(parseMidWeekLaggingSnapshot(JSON.stringify({ ...snapshot, version: 2 }))).toBeNull();
    expect(parseMidWeekLaggingSnapshot(JSON.stringify({ version: 1 }))).toBeNull();
    expect(parseMidWeekLaggingSnapshot(null)).toBeNull();
  });

  const wasLagging = (
    key: string,
    overrides: Partial<MidWeekLaggingSnapshot["signals"][number]> = {},
  ): MidWeekLaggingSnapshot["signals"][number] => ({
    key,
    category: "rescuetime",
    label: key,
    direction: "more",
    status: "lagging",
    actual: 1,
    expected: 4,
    weekTarget: 14,
    unit: "h",
    daysApplicable: 3,
    daysWithData: 3,
    hasFullCoverage: true,
    ...overrides,
  });
  const snapshotOf = (...signals: MidWeekLaggingSnapshot["signals"]): MidWeekLaggingSnapshot => ({
    version: 1,
    asOfDate: WEDNESDAY,
    completedDays: 3,
    signals,
  });

  it("compares recovered, not recovered, missing, unknown and partially covered signals", () => {
    const current = summarize({
      asOfDate: WEEK_OVER,
      goalsSnapshot: goalsOf([
        goalItem({ goalId: 1, actualHours: 14 }),
        goalItem({ goalId: 2, actualHours: 2 }),
        goalItem({ goalId: 4, actualHours: 5 }),
      ]),
      weekEntries: makeWeek((week) => {
        week[0].metrics.pomodoris = 8; // partial coverage
      }),
    });
    const result = compareMidWeekSnapshot(
      snapshotOf(
        wasLagging("rescuetime:1"),
        wasLagging("rescuetime:2"),
        wasLagging("rescuetime:3"), // deleted goal
        wasLagging("principle:respectTrc"), // unknown now
        wasLagging("metric:pomodoris"), // not fully covered
      ),
      current,
    );
    const byKey = Object.fromEntries(result.map((row) => [row.key, row]));
    expect(byKey["rescuetime:1"].recovered).toBe(true);
    expect(byKey["rescuetime:2"].recovered).toBe(false);
    expect(byKey["rescuetime:3"]).toMatchObject({ after: null, recovered: null });
    expect(byKey["principle:respectTrc"]).toMatchObject({ recovered: null });
    expect(byKey["principle:respectTrc"].after?.status).toBe("unknown");
    expect(byKey["metric:pomodoris"].recovered).toBeNull();
    expect(byKey["rescuetime:1"].before.key).toBe("rescuetime:1");
  });

  it("reports end-of-week recovery markers per category", () => {
    const week = makeWeek((entries) => {
      for (const entry of entries) {
        entry.metrics.tachesAjoutes = 2;
        entry.metrics.tachesRealises = 2;
        entry.status = "closed";
        entry.nightReflection = "Ok";
      }
    });
    const current = summarize({
      asOfDate: WEEK_OVER,
      weekEntries: week,
      goalsSnapshot: goalsOf([
        goalItem({
          goalId: 1,
          scheduleLabel: "Working hours",
          weeklyTargetHours: 10,
          actualHours: 10,
        }),
        goalItem({ goalId: 2, actualHours: 14 }),
      ]),
      objectivesSnapshot: objectivesOf([
        { objective: timeObjective("t", 7), actualHours: 7, achievement: 1, source: "rescuetime" },
        {
          objective: createEmptyWeeklyObjective({ id: "m", title: "M", kind: "manual" }),
          actualHours: null,
          achievement: 1,
          source: "manual",
        },
      ]),
    });
    const result = compareMidWeekSnapshot(
      snapshotOf(
        wasLagging("rescuetime:1"),
        wasLagging("rescuetime:2"),
        wasLagging("tasks:completion", { category: "tasks" }),
        wasLagging("journal:reflections", { category: "journal" }),
        wasLagging("objective:t", { category: "objective" }),
        wasLagging("objective:m", { category: "objective", daysApplicable: 1, daysWithData: 0 }),
      ),
      current,
    );
    expect(result.map((row) => row.recovered)).toEqual([true, true, true, true, true, true]);
  });

  it("does not claim a journal verdict when only two days were closed", () => {
    const current = summarize({
      asOfDate: WEEK_OVER,
      weekEntries: makeWeek((entries) => {
        entries[0].status = "closed";
        entries[0].nightReflection = "A";
        entries[1].status = "closed";
        entries[1].nightReflection = "B";
      }),
    });
    const [row] = compareMidWeekSnapshot(
      snapshotOf(wasLagging("journal:reflections", { category: "journal" })),
      current,
    );
    expect(row.after?.status).toBe("on_pace");
    expect(row.recovered).toBeNull();
  });
});
