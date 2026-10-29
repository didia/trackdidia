// Test-only: nothing in the app imports this file.
//
// SAFETY: fixtures for the in-memory laptop simulation only.
import { createEmptyMonthlyReview } from "../../../domain/monthly-review";
import type {
  AiMemory,
  AiMessage,
  AnnualGoal,
  MonthlyReview,
  WeeklyObjective,
  WeeklyReview,
} from "../../../domain/types";
import { createEmptyWeeklyReview } from "../../../domain/weekly-review";

/** Builders for rows of the `personal` domain, with the text a test wants to follow around. */

export const annualGoal = (overrides: Partial<AnnualGoal> = {}): AnnualGoal => ({
  id: "goal-1",
  title: "Lire 24 livres",
  dimension: "intellectuelle",
  description: "",
  targetValue: 24,
  unit: "livres",
  sourceId: null,
  manualCurrentValue: null,
  evaluations: {},
  measurementType: "cumulative",
  status: "active",
  deadline: null,
  startingValue: null,
  direction: null,
  cadenceTarget: null,
  cadencePeriod: "week",
  principleKey: null,
  progressLog: {},
  milestones: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

export const weeklyObjective = (id: string, title: string): WeeklyObjective => ({
  id,
  title,
  kind: "manual",
  targetHours: null,
  rescuetimeKind: null,
  rescuetimeThing: null,
  sortOrder: 0,
  startsOnWeekStartDate: null,
  endsOnWeekStartDate: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
});

export const aiMessage = (id: string, bodyText = "body"): AiMessage => ({
  id,
  surface: "coach_pulse",
  scopeKey: "2026-10-04",
  stance: null,
  kind: "pulse",
  inputHash: `hash-${id}`,
  promptVersion: "v1",
  model: "vendor/model",
  status: "ok",
  bodyJson: null,
  bodyText,
  deltaClass: null,
  notified: false,
  tokensPrompt: null,
  tokensCompletion: null,
  latencyMs: null,
  createdAt: "2026-10-04T12:00:00.000Z",
});

export const aiMemory = (id: string, statement: string): AiMemory => ({
  id,
  kind: "preference",
  statement,
  detail: "",
  confidence: 0.9,
  source: "ai_extracted",
  status: "active",
  evidenceFrom: null,
  evidenceTo: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  lastConfirmedAt: "2026-04-01T00:00:00.000Z",
  expiresAt: null,
  pinned: false,
});

export const weeklyReview = (weekStartDate: string, dimanche: string): WeeklyReview => {
  const review = createEmptyWeeklyReview(weekStartDate);
  return { ...review, notes: { ...review.notes, dimanche }, updatedAt: "2026-10-04T12:00:00.000Z" };
};

export const monthlyReview = (monthKey: string, text: string): MonthlyReview => {
  const review = createEmptyMonthlyReview(monthKey);
  const firstKey = Object.keys(review.notes)[0] as keyof MonthlyReview["notes"];
  return {
    ...review,
    notes: { ...review.notes, [firstKey]: text },
    updatedAt: "2026-10-04T12:00:00.000Z",
  };
};
