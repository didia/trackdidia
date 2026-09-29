import type { Finding } from "../../../domain/insights/types";
import type { AnnualGoalMeasurementType, AnnualGoalSnapshot } from "../../../domain/types";

/** Anything identifiable by `id`/`title`, e.g. a `Project` or a `Task`. */
interface Titled {
  id: string;
  title: string;
}

/**
 * Builds an id -> title lookup for the given items. Used by the daily/weekly snapshots to
 * resolve project/task titles for GTD and focus samples, gated on `includeStructure` by each
 * caller.
 */
export const titleIndex = <T extends Titled>(items: T[]): Map<string, string> =>
  new Map(items.map((item) => [item.id, item.title]));

/**
 * Strips finding fields that are safe to *compute* but not safe to *expose* below
 * `metrics_and_structure` scope, mirroring the `projectsWithoutNextActionSample` id/title
 * gate used elsewhere. `findings` is a heterogeneous array of concrete finding subtypes spread
 * in verbatim; the declared `Finding` shape (`id, severity, evidenceWindow, sampleSize, value,
 * label`) plus module-specific scalars (e.g. `direction`, `principleKey`) are fixed,
 * predefined-enum values and carry no user data. `gtd-health.ts` and `focus.ts` findings are
 * the exception: they carry raw `taskIds`/`projectIds` arrays and a singular `projectId`
 * (the winning focus-concentration unit), which are real user-created identifiers and must
 * not survive at the restrictive `metrics` scope. Any future finding type that adds its own
 * identifier field must extend this function so `findings` stays leak-free by construction
 * rather than by every caller remembering to redact.
 */
export const sanitizeFindingForScope = (finding: Finding, includeStructure: boolean): Finding => {
  if (includeStructure) {
    return finding;
  }

  const {
    taskIds: _taskIds,
    projectIds: _projectIds,
    projectId: _projectId,
    ...rest
  } = finding as Finding & {
    taskIds?: string[];
    projectIds?: string[];
    projectId?: string | null;
  };

  return rest as Finding;
};

/** Extra fields a surface splices into `projectGoalBase`'s output, at the exact slot the field belongs in for that surface. */
export interface GoalBaseExtras {
  /** Spread immediately after `measurementType` (before `currentValue`). */
  afterMeasurementType?: Record<string, unknown>;
  /** Spread immediately after `progressRatio` (before `evaluationScore`/`evaluationTrend`). */
  beforeEvaluation?: Record<string, unknown>;
}

export interface GoalBaseFields {
  goalId: string;
  title?: string;
  dimension: string;
  measurementType: AnnualGoalMeasurementType;
  currentValue: number | null;
  targetValue: number | null;
  unit: string;
  progressRatio: number | null;
  evaluationScore: number | null;
  evaluationTrend: string | null;
}

/**
 * Shared goal projection used by the monthly and annual/goal-pacing snapshots: `goalId`, a
 * `title` present only when `includeStructure` (i.e. `metrics_and_structure`/`full` scope),
 * `dimension`, `measurementType`, `currentValue`, `targetValue`, `unit`, `progressRatio`, and
 * the evaluation fields for `evaluationMonthKey`. Each surface splices its own extra fields via
 * `extras.afterMeasurementType`/`extras.beforeEvaluation` into the exact slot the pre-refactor,
 * per-surface code had them in, so the resulting key order — and therefore `JSON.stringify`
 * output and `buildAiInputHash` — is unchanged for identical inputs.
 */
export const projectGoalBase = (
  snapshot: AnnualGoalSnapshot,
  evaluationMonthKey: string,
  includeStructure: boolean,
  extras: GoalBaseExtras = {},
): GoalBaseFields & Record<string, unknown> => {
  const evaluation = snapshot.goal.evaluations[evaluationMonthKey] ?? null;

  return {
    goalId: snapshot.goal.id,
    ...(includeStructure ? { title: snapshot.goal.title } : {}),
    dimension: snapshot.goal.dimension,
    measurementType: snapshot.measurement.measurementType,
    ...extras.afterMeasurementType,
    currentValue: snapshot.currentValue,
    targetValue: snapshot.goal.targetValue,
    unit: snapshot.goal.unit,
    progressRatio: snapshot.progressRatio,
    ...extras.beforeEvaluation,
    evaluationScore: evaluation?.score ?? null,
    evaluationTrend: evaluation?.trend ?? null,
  };
};
