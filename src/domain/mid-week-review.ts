import { t } from "../i18n";
import { addDays } from "../lib/gtd/shared";
import {
  computeAnsweredDisciplineScore,
  createEmptyDailyEntry,
  resolveMetricValue,
} from "./daily-entry";
import { metricDefinitions, principleDefinitions } from "./definitions";
import {
  completedScheduleDaysInWeek,
  isScheduleDay,
  type RescueTimeGoalItemSnapshot,
  type RescueTimeGoalsSnapshot,
  scheduleDaysInWeek,
} from "./rescuetime-goals";
import type {
  DailyEntry,
  MetricKey,
  PrincipleKey,
  WeeklyObjectivesSnapshot,
  WeeklyReviewSummary,
} from "./types";
import {
  buildWeekDates,
  calorieTargetDaily,
  phoneScreenTargetMinutes,
  pomodoroTarget,
} from "./weekly-review";

/** Tuning knobs for mid-week verdicts. Raise to be more forgiving. Documented in docs/reviews-and-goals.md. */
export const MID_WEEK_PACE_TOLERANCE = 0.1;
export const MID_WEEK_LAGGING_THRESHOLD = 0.25;

/**
 * `shortfall` is rounded to 9 decimal places before any comparison. Without it, an exact 10 %
 * over budget (`expected = 100, actual = 110`) yields `0.10000000000000009` and would read
 * `at_risk` instead of `on_pace`.
 */
export const MID_WEEK_SHORTFALL_PRECISION = 1e9;

/** Maximum number of signals kept in a saved lagging snapshot. */
export const MID_WEEK_SNAPSHOT_MAX_SIGNALS = 10;

export type MidWeekSignalCategory =
  | "metric"
  | "principle"
  | "habit"
  | "rescuetime"
  | "objective"
  | "tasks"
  | "journal";

export type MidWeekDirection = "more" | "less" | "quality";

export type MidWeekStatus = "ahead" | "on_pace" | "at_risk" | "lagging" | "unknown";

export interface MidWeekPaceWindow {
  weekStartDate: string;
  weekEndDate: string;
  /** Clamped into `[weekStartDate, weekEndDate + 1]`. */
  asOfDate: string;
  /** Local day of week (0 = Sunday) of `asOfDate`, or `null` once the week is over. */
  dayIndex: number | null;
  completedDays: number;
  remainingDays: number;
}

export interface MidWeekSignal {
  key: string;
  category: MidWeekSignalCategory;
  label: string;
  direction: MidWeekDirection;
  status: MidWeekStatus;
  actual: number | null;
  expected: number | null;
  weekTarget: number | null;
  unit: string | null;
  paceRatio: number | null;
  remaining: number | null;
  perRemainingDay: number | null;
  daysApplicable: number;
  daysWithData: number;
  hasFullCoverage: boolean;
  severity: number | null;
  recovery: string;
}

export interface MidWeekPulseSnapshotInput {
  pulse: number | null;
  rescuetimeConfigured: boolean;
  fetchError?: string;
}

export interface MidWeekReviewInputs {
  weekStartDate: string;
  asOfDate: string;
  /** Seven decorated entries (suggested pomodoro and task metrics applied). */
  weekEntries: DailyEntry[];
  summary: WeeklyReviewSummary | null;
  goalsSnapshot: RescueTimeGoalsSnapshot | null;
  pulseSnapshot: MidWeekPulseSnapshotInput | null;
  objectivesSnapshot: WeeklyObjectivesSnapshot | null;
}

export interface MidWeekReviewSummary {
  window: MidWeekPaceWindow;
  paceScore: number | null;
  signals: MidWeekSignal[];
  /** `lagging` and `at_risk` signals, ranked by severity. */
  lagging: MidWeekSignal[];
  ahead: MidWeekSignal[];
  unknown: MidWeekSignal[];
  completedDayCount: number;
  closedDayCount: number;
}

const finiteOrNull = (value: number | null | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const displayNumber = (value: number | null): string => {
  if (value === null) {
    return "-";
  }
  return String(Math.round(value * 10) / 10);
};

/** Days elapsed from `weekStartDate` to `asOfDate`, clamped to 0..7. Uses `addDays` only. */
const elapsedWeekDays = (weekStartDate: string, asOfDate: string): number => {
  if (asOfDate <= weekStartDate) {
    return 0;
  }
  for (let index = 1; index <= 7; index += 1) {
    if (asOfDate <= addDays(weekStartDate, index)) {
      return index;
    }
  }
  return 7;
};

export const buildMidWeekPaceWindow = (
  weekStartDate: string,
  asOfDate: string,
): MidWeekPaceWindow => {
  const normalized = buildWeekDates(weekStartDate);
  const weekEndDate = addDays(normalized, 6);
  const lastAsOf = addDays(weekEndDate, 1);
  const completedDays = elapsedWeekDays(normalized, asOfDate);
  const clampedAsOf =
    asOfDate < normalized ? normalized : asOfDate > lastAsOf ? lastAsOf : asOfDate;

  return {
    weekStartDate: normalized,
    weekEndDate,
    asOfDate: clampedAsOf,
    dayIndex: clampedAsOf <= weekEndDate ? elapsedWeekDays(normalized, clampedAsOf) : null,
    completedDays,
    remainingDays: 7 - completedDays,
  };
};

export const computeMidWeekStatus = (paceRatio: number | null): MidWeekStatus => {
  const shortfall = computeMidWeekShortfall(paceRatio);
  if (shortfall === null) {
    return "unknown";
  }
  if (shortfall <= -MID_WEEK_PACE_TOLERANCE) {
    return "ahead";
  }
  if (shortfall <= MID_WEEK_PACE_TOLERANCE) {
    return "on_pace";
  }
  if (shortfall < MID_WEEK_LAGGING_THRESHOLD) {
    return "at_risk";
  }
  return "lagging";
};

export const computeMidWeekShortfall = (paceRatio: number | null): number | null => {
  if (paceRatio === null || !Number.isFinite(paceRatio)) {
    return null;
  }
  return finiteOrNull(
    Math.round((1 - paceRatio) * MID_WEEK_SHORTFALL_PRECISION) / MID_WEEK_SHORTFALL_PRECISION,
  );
};

type RecoveryKind = "rate" | "less" | "quality" | "habit" | "principle" | "tasks" | "journal";

interface SignalDraft {
  key: string;
  category: MidWeekSignalCategory;
  label: string;
  direction: MidWeekDirection;
  actual: number | null;
  expected: number | null;
  weekTarget: number | null;
  unit: string | null;
  /** Overrides the direction-based ratio (tasks, manual objectives). */
  paceRatio?: number | null;
  remaining: number | null;
  daysApplicable: number;
  /** `"auto"` for automatically tracked signals: full when known, `0` when unknown. */
  daysWithData: number | "auto";
  recoveryKind: RecoveryKind;
  remainingDays: number;
  forcedStatus?: MidWeekStatus;
}

/** Ratio of actual to expected; "less" signals use `2 - actual / expected` so `ahead` stays reachable. */
export const computeMidWeekPaceRatio = (
  direction: MidWeekDirection,
  actual: number | null,
  expected: number | null,
): number | null => {
  if (actual === null || expected === null || !(expected > 0)) {
    return null;
  }
  return finiteOrNull(direction === "less" ? 2 - actual / expected : actual / expected);
};

const buildRecovery = (
  draft: SignalDraft,
  status: MidWeekStatus,
  remaining: number | null,
  perRemainingDay: number | null,
  daysWithData: number,
  hasFullCoverage: boolean,
): string => {
  if (status === "unknown") {
    return t("midWeek.recovery.unknown", { ns: "reviews" });
  }

  let text: string;
  if (status === "ahead" || status === "on_pace") {
    text = t("midWeek.recovery.onTrack", { ns: "reviews" });
  } else {
    const unit = draft.unit ?? "";
    const base = { ns: "reviews", unit, remainingDays: draft.remainingDays } as const;
    switch (draft.recoveryKind) {
      case "rate":
        text =
          remaining !== null && remaining > 0 && perRemainingDay !== null
            ? t("midWeek.recovery.more", {
                ...base,
                remaining: displayNumber(remaining),
                perDay: displayNumber(perRemainingDay),
              })
            : t("midWeek.recovery.moreWeekOver", {
                ...base,
                remaining: displayNumber(remaining ?? 0),
              });
        break;
      case "less":
        text =
          remaining !== null && remaining > 0 && perRemainingDay !== null
            ? t("midWeek.recovery.less", {
                ...base,
                remaining: displayNumber(remaining),
                perDay: displayNumber(perRemainingDay),
              })
            : t("midWeek.recovery.lessSpent", { ns: "reviews" });
        break;
      case "quality":
        text = t("midWeek.recovery.quality", {
          ns: "reviews",
          actual: displayNumber(draft.actual),
          target: displayNumber(draft.expected),
        });
        break;
      case "habit":
        text = t("midWeek.recovery.habit", {
          ns: "reviews",
          actual: displayNumber(draft.actual === null ? null : draft.actual * 100),
        });
        break;
      case "principle":
        text = t("midWeek.recovery.principle", {
          ns: "reviews",
          actual: displayNumber(draft.actual),
          expected: displayNumber(draft.expected),
        });
        break;
      case "tasks":
        text =
          draft.remainingDays > 0
            ? t("midWeek.recovery.tasks", {
                ns: "reviews",
                remaining: displayNumber(remaining ?? 0),
                remainingDays: draft.remainingDays,
              })
            : t("midWeek.recovery.tasksWeekOver", {
                ns: "reviews",
                remaining: displayNumber(remaining ?? 0),
              });
        break;
      case "journal":
        text = t("midWeek.recovery.journal", {
          ns: "reviews",
          actual: displayNumber(draft.actual),
          expected: displayNumber(draft.expected),
        });
        break;
    }
  }

  if (!hasFullCoverage && draft.daysApplicable > 0) {
    text = `${text} ${t("midWeek.recovery.partialCoverage", {
      ns: "reviews",
      withData: daysWithData,
      applicable: draft.daysApplicable,
    })}`;
  }
  return text;
};

const buildSignal = (draft: SignalDraft): MidWeekSignal => {
  const actual = finiteOrNull(draft.actual);
  const expected = finiteOrNull(draft.expected);
  const paceRatio = finiteOrNull(
    draft.paceRatio !== undefined
      ? draft.paceRatio
      : computeMidWeekPaceRatio(draft.direction, actual, expected),
  );
  const status = draft.forcedStatus ?? computeMidWeekStatus(paceRatio);
  const shortfall = computeMidWeekShortfall(paceRatio);
  const daysWithData =
    draft.daysWithData === "auto"
      ? paceRatio === null
        ? 0
        : draft.daysApplicable
      : draft.daysWithData;
  const hasFullCoverage = draft.daysApplicable > 0 && daysWithData >= draft.daysApplicable;
  const remaining = finiteOrNull(draft.remaining);
  const perRemainingDay =
    remaining !== null && draft.remainingDays > 0
      ? finiteOrNull(remaining / draft.remainingDays)
      : null;
  const severity =
    shortfall === null
      ? null
      : finiteOrNull(
          shortfall *
            (draft.daysApplicable > 0 ? Math.min(daysWithData / draft.daysApplicable, 1) : 0),
        );

  return {
    key: draft.key,
    category: draft.category,
    label: draft.label,
    direction: draft.direction,
    status,
    actual,
    expected,
    weekTarget: finiteOrNull(draft.weekTarget),
    unit: draft.unit,
    paceRatio,
    remaining,
    perRemainingDay,
    daysApplicable: draft.daysApplicable,
    daysWithData,
    hasFullCoverage,
    severity,
    recovery: buildRecovery(
      { ...draft, actual, expected },
      status,
      remaining,
      perRemainingDay,
      daysWithData,
      hasFullCoverage,
    ),
  };
};

const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);

const nonNull = (values: (number | null)[]): number[] =>
  values.filter((value): value is number => value !== null);

const metricLabel = (key: MetricKey): string =>
  metricDefinitions.find((definition) => definition.key === key)?.label ?? key;

const metricUnit = (key: MetricKey): string | null =>
  metricDefinitions.find((definition) => definition.key === key)?.unit ?? null;

const metricSignals = (completed: DailyEntry[], window: MidWeekPaceWindow): MidWeekSignal[] => {
  const applicable = completed.length;
  const valuesFor = (key: MetricKey) =>
    nonNull(completed.map((entry) => resolveMetricValue(entry, key)));

  const cumulative = (
    key: MetricKey,
    direction: "more" | "less",
    weekTarget: number,
    dailyTarget: number,
  ): MidWeekSignal => {
    const values = valuesFor(key);
    const hasData = values.length > 0;
    const actual = hasData ? sum(values) : null;
    return buildSignal({
      key: `metric:${key}`,
      category: "metric",
      label: metricLabel(key),
      direction,
      actual,
      expected: hasData ? dailyTarget * values.length : null,
      weekTarget,
      unit: metricUnit(key),
      remaining: actual === null ? null : Math.max(0, weekTarget - actual),
      daysApplicable: applicable,
      daysWithData: values.length,
      recoveryKind: direction === "less" ? "less" : "rate",
      remainingDays: window.remainingDays,
    });
  };

  const sleepValues = valuesFor("qualiteSommeil");
  const sleep = buildSignal({
    key: "metric:qualiteSommeil",
    category: "metric",
    label: metricLabel("qualiteSommeil"),
    direction: "quality",
    actual: sleepValues.length > 0 ? sum(sleepValues) / sleepValues.length : null,
    expected: sleepValues.length > 0 ? 100 : null,
    weekTarget: 100,
    unit: metricUnit("qualiteSommeil"),
    remaining: null,
    daysApplicable: applicable,
    daysWithData: sleepValues.length,
    recoveryKind: "quality",
    remainingDays: window.remainingDays,
  });

  return [
    cumulative("pomodoris", "more", pomodoroTarget, pomodoroTarget / 7),
    cumulative("depenseCalorique", "more", calorieTargetDaily * 7, calorieTargetDaily),
    cumulative(
      "tempsEcranTelephone",
      "less",
      phoneScreenTargetMinutes,
      phoneScreenTargetMinutes / 7,
    ),
    sleep,
  ];
};

const principleSignals = (completed: DailyEntry[], window: MidWeekPaceWindow): MidWeekSignal[] =>
  principleDefinitions.map(({ key, label }) => {
    const answers = completed
      .map((entry) => entry.principleChecks[key as PrincipleKey])
      .filter((value): value is boolean => value !== null);
    const answered = answers.length;
    return buildSignal({
      key: `principle:${key}`,
      category: "principle",
      label,
      direction: "more",
      actual: answered > 0 ? answers.filter(Boolean).length : null,
      expected: answered > 0 ? answered : null,
      weekTarget: 7,
      unit: null,
      remaining: null,
      daysApplicable: completed.length,
      daysWithData: answered,
      recoveryKind: "principle",
      remainingDays: window.remainingDays,
    });
  });

const disciplineSignal = (completed: DailyEntry[], window: MidWeekPaceWindow): MidWeekSignal => {
  const scores = nonNull(completed.map((entry) => computeAnsweredDisciplineScore(entry)));
  return buildSignal({
    key: "habit:discipline",
    category: "habit",
    label: t("midWeek.signal.discipline", { ns: "reviews" }),
    direction: "quality",
    actual: scores.length > 0 ? sum(scores) / scores.length : null,
    expected: scores.length > 0 ? 1 : null,
    weekTarget: 1,
    unit: null,
    remaining: null,
    daysApplicable: completed.length,
    daysWithData: scores.length,
    recoveryKind: "habit",
    remainingDays: window.remainingDays,
  });
};

const tasksSignal = (
  completed: DailyEntry[],
  weekEntries: DailyEntry[],
  window: MidWeekPaceWindow,
): MidWeekSignal => {
  const rows = completed
    .map((entry) => ({
      added: resolveMetricValue(entry, "tachesAjoutes"),
      done: resolveMetricValue(entry, "tachesRealises"),
    }))
    .filter((row) => row.added !== null || row.done !== null);
  const added = sum(rows.map((row) => row.added ?? 0));
  const done = sum(rows.map((row) => row.done ?? 0));
  const hasData = rows.length > 0;
  const weekAdded = nonNull(weekEntries.map((entry) => resolveMetricValue(entry, "tachesAjoutes")));

  return buildSignal({
    key: "tasks:completion",
    category: "tasks",
    label: t("midWeek.signal.tasks", { ns: "reviews" }),
    direction: "more",
    actual: hasData ? done : null,
    expected: hasData ? added : null,
    weekTarget: weekAdded.length > 0 ? sum(weekAdded) : null,
    unit: null,
    paceRatio: hasData ? (added > 0 ? done / added : done > 0 ? 1 : null) : null,
    remaining: hasData ? Math.max(0, added - done) : null,
    daysApplicable: completed.length,
    daysWithData: rows.length,
    recoveryKind: "tasks",
    remainingDays: window.remainingDays,
  });
};

const journalSignal = (completed: DailyEntry[], window: MidWeekPaceWindow): MidWeekSignal => {
  const hasReflection = (entry: DailyEntry) => entry.nightReflection.trim().length > 0;
  const logged = completed.filter((entry) => entry.status === "closed" || hasReflection(entry));
  return buildSignal({
    key: "journal:reflections",
    category: "journal",
    label: t("midWeek.signal.journal", { ns: "reviews" }),
    direction: "more",
    actual: logged.length > 0 ? logged.filter(hasReflection).length : null,
    expected: logged.length > 0 ? logged.length : null,
    weekTarget: 7,
    unit: null,
    remaining: null,
    daysApplicable: completed.length,
    daysWithData: logged.length,
    recoveryKind: "journal",
    remainingDays: window.remainingDays,
  });
};

const rescueTimeSignals = (
  snapshot: RescueTimeGoalsSnapshot | null,
  window: MidWeekPaceWindow,
): MidWeekSignal[] => {
  if (!snapshot) {
    return [];
  }
  const usable = snapshot.rescuetimeConfigured && !snapshot.fetchError;

  return snapshot.items.map((item: RescueTimeGoalItemSnapshot) => {
    const scheduleDays = scheduleDaysInWeek(item.scheduleLabel);
    const completedScheduleDays = completedScheduleDaysInWeek(
      item.scheduleLabel,
      window.completedDays,
    );
    // A "less" goal counts today: its minutes are already spent. A "more" goal does not: today's
    // hours can only help. Once the week is over `dayIndex` is null, so a "less" budget is exactly
    // `weeklyTargetHours` and `expected <= weekTarget` always holds.
    const todayCounts =
      !item.isMore &&
      window.dayIndex !== null &&
      isScheduleDay(item.scheduleLabel, window.dayIndex);
    const applicable = completedScheduleDays + (todayCounts ? 1 : 0);
    const expected = scheduleDays > 0 ? (item.weeklyTargetHours * applicable) / scheduleDays : null;
    const actual = usable ? item.actualHours : null;

    return buildSignal({
      key: `rescuetime:${item.goalId}`,
      category: "rescuetime",
      label: item.title,
      direction: item.isMore ? "more" : "less",
      actual,
      expected,
      weekTarget: item.weeklyTargetHours,
      unit: "h",
      remaining: actual === null ? null : Math.max(0, item.weeklyTargetHours - actual),
      daysApplicable: applicable,
      daysWithData: "auto",
      recoveryKind: item.isMore ? "rate" : "less",
      remainingDays: window.remainingDays,
    });
  });
};

const objectiveSignals = (
  snapshot: WeeklyObjectivesSnapshot | null,
  window: MidWeekPaceWindow,
): MidWeekSignal[] => {
  if (!snapshot) {
    return [];
  }

  return snapshot.items.map((item) => {
    const { objective } = item;
    if (objective.kind === "manual") {
      const achieved = item.achievement === 1;
      return buildSignal({
        key: `objective:${objective.id}`,
        category: "objective",
        label: objective.title,
        direction: "more",
        actual: achieved ? 1 : null,
        expected: 1,
        weekTarget: 1,
        unit: null,
        paceRatio: achieved ? 1 : null,
        forcedStatus: achieved ? "ahead" : "unknown",
        remaining: null,
        daysApplicable: 1,
        daysWithData: achieved ? 1 : 0,
        recoveryKind: "rate",
        remainingDays: window.remainingDays,
      });
    }

    const target = objective.targetHours;
    const known = !item.error && item.actualHours !== null;
    const actual = known ? item.actualHours : null;
    return buildSignal({
      key: `objective:${objective.id}`,
      category: "objective",
      label: objective.title,
      direction: "more",
      actual,
      expected: target === null ? null : (target * window.completedDays) / 7,
      weekTarget: target,
      unit: "h",
      remaining: actual === null || target === null ? null : Math.max(0, target - actual),
      daysApplicable: window.completedDays,
      daysWithData: "auto",
      recoveryKind: "rate",
      remainingDays: window.remainingDays,
    });
  });
};

/** Highest severity first; thin coverage already lowers severity. Ties break on `key`. */
export const rankMidWeekSignals = (signals: MidWeekSignal[]): MidWeekSignal[] =>
  [...signals].sort((left, right) => {
    const l = left.severity ?? Number.NEGATIVE_INFINITY;
    const r = right.severity ?? Number.NEGATIVE_INFINITY;
    if (l !== r) {
      return r - l;
    }
    return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
  });

/** Mean of `clamp(paceRatio, 0, 1)` over signals that are not `unknown`; `null` when none. */
export const computeMidWeekPaceScore = (signals: MidWeekSignal[]): number | null => {
  const ratios = signals
    .filter((signal) => signal.status !== "unknown" && signal.paceRatio !== null)
    .map((signal) => Math.min(Math.max(signal.paceRatio as number, 0), 1));
  return ratios.length > 0 ? finiteOrNull(sum(ratios) / ratios.length) : null;
};

export const buildMidWeekReviewSummary = (inputs: MidWeekReviewInputs): MidWeekReviewSummary => {
  const window = buildMidWeekPaceWindow(inputs.weekStartDate, inputs.asOfDate);
  const byDate = new Map(inputs.weekEntries.map((entry) => [entry.date, entry]));
  const weekEntries = Array.from({ length: 7 }, (_, index) => {
    const date = addDays(window.weekStartDate, index);
    return byDate.get(date) ?? createEmptyDailyEntry(date);
  });
  const completed = weekEntries.slice(0, window.completedDays);

  const signals: MidWeekSignal[] = [
    ...metricSignals(completed, window),
    ...principleSignals(completed, window),
    disciplineSignal(completed, window),
    tasksSignal(completed, weekEntries, window),
    journalSignal(completed, window),
    ...rescueTimeSignals(inputs.goalsSnapshot, window),
    ...objectiveSignals(inputs.objectivesSnapshot, window),
  ];

  return {
    window,
    paceScore: computeMidWeekPaceScore(signals),
    signals,
    lagging: rankMidWeekSignals(
      signals.filter((signal) => signal.status === "lagging" || signal.status === "at_risk"),
    ),
    ahead: signals.filter((signal) => signal.status === "ahead"),
    unknown: signals.filter((signal) => signal.status === "unknown"),
    completedDayCount: window.completedDays,
    closedDayCount: completed.filter((entry) => entry.status === "closed").length,
  };
};

export interface MidWeekSnapshotSignal {
  key: string;
  category: MidWeekSignalCategory;
  label: string;
  direction: MidWeekDirection;
  status: MidWeekStatus;
  actual: number | null;
  expected: number | null;
  weekTarget: number | null;
  unit: string | null;
  daysApplicable: number;
  daysWithData: number;
  hasFullCoverage: boolean;
}

export interface MidWeekLaggingSnapshot {
  version: 1;
  asOfDate: string;
  completedDays: number;
  signals: MidWeekSnapshotSignal[];
}

export const buildMidWeekLaggingSnapshot = (
  summary: MidWeekReviewSummary,
): MidWeekLaggingSnapshot => ({
  version: 1,
  asOfDate: summary.window.asOfDate,
  completedDays: summary.window.completedDays,
  signals: summary.lagging
    .filter((signal) => signal.status === "lagging" || signal.status === "at_risk")
    .slice(0, MID_WEEK_SNAPSHOT_MAX_SIGNALS)
    .map((signal) => ({
      key: signal.key,
      category: signal.category,
      label: signal.label,
      direction: signal.direction,
      status: signal.status,
      actual: signal.actual,
      expected: signal.expected,
      weekTarget: signal.weekTarget,
      unit: signal.unit,
      daysApplicable: signal.daysApplicable,
      daysWithData: signal.daysWithData,
      hasFullCoverage: signal.hasFullCoverage,
    })),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isSnapshotSignal = (value: unknown): value is MidWeekSnapshotSignal =>
  isRecord(value) &&
  typeof value.key === "string" &&
  typeof value.label === "string" &&
  typeof value.status === "string" &&
  typeof value.category === "string" &&
  typeof value.direction === "string" &&
  typeof value.daysApplicable === "number" &&
  typeof value.daysWithData === "number" &&
  typeof value.hasFullCoverage === "boolean";

/** Returns `null` on bad JSON, an unknown `version` or a malformed shape. */
export const parseMidWeekLaggingSnapshot = (
  json: string | null | undefined,
): MidWeekLaggingSnapshot | null => {
  if (!json) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(json);
    if (
      !isRecord(parsed) ||
      parsed.version !== 1 ||
      typeof parsed.asOfDate !== "string" ||
      typeof parsed.completedDays !== "number" ||
      !Array.isArray(parsed.signals) ||
      !parsed.signals.every(isSnapshotSignal)
    ) {
      return null;
    }
    return parsed as unknown as MidWeekLaggingSnapshot;
  } catch {
    return null;
  }
};

export interface MidWeekSnapshotComparison {
  key: string;
  before: MidWeekSnapshotSignal;
  /** `null` when the key is gone, for example a deleted RescueTime goal. */
  after: MidWeekSignal | null;
  /** `null` unless the current signal is known and fully covered. */
  recovered: boolean | null;
}

export const compareMidWeekSnapshot = (
  snapshot: MidWeekLaggingSnapshot,
  currentSummary: MidWeekReviewSummary,
): MidWeekSnapshotComparison[] => {
  const current = new Map(currentSummary.signals.map((signal) => [signal.key, signal]));
  return snapshot.signals.map((before) => {
    const after = current.get(before.key) ?? null;
    const verdict =
      after === null || after.status === "unknown" || !after.hasFullCoverage
        ? null
        : after.status === "on_pace" || after.status === "ahead";
    return { key: before.key, before, after, recovered: verdict };
  });
};
