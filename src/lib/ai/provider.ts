import type { AiSurface, AppSettings, CoachPulseStance } from "../../domain/types";
import type { DailySnapshot } from "./context/daily-snapshot";
import type { GoalPacingSnapshot } from "./context/goal-pacing-snapshot";
import type { MonthlySnapshot } from "./context/monthly-snapshot";
import type { PastorSnapshot } from "./context/pastor-snapshot";
import type { WeeklySnapshot } from "./context/weekly-snapshot";

export interface AiUsage {
  tokensPrompt: number;
  tokensCompletion: number;
  latencyMs: number;
}

interface AiStructuredRequestBase {
  settings: AppSettings;
  repairHint?: string;
  memoryBlock?: string;
}

export interface CoachPulseStructuredRequest extends AiStructuredRequestBase {
  surface: "coach_pulse";
  stance: CoachPulseStance;
  snapshot: DailySnapshot;
  commitmentResolution?: {
    statement: string;
    progressLabel: string;
    met: boolean | null;
  } | null;
}

export interface WeeklySynthesisStructuredRequest extends AiStructuredRequestBase {
  surface: "weekly_synthesis";
  snapshot: WeeklySnapshot;
}

export interface MonthlySynthesisStructuredRequest extends AiStructuredRequestBase {
  surface: "monthly_synthesis";
  snapshot: MonthlySnapshot;
}

export interface GoalPacingStructuredRequest extends AiStructuredRequestBase {
  surface: "goal_pacing";
  snapshot: GoalPacingSnapshot;
}

export interface PastorVerseStructuredRequest extends AiStructuredRequestBase {
  surface: "pastor_verse";
  snapshot: PastorSnapshot;
}

export type AiStructuredRequest =
  | CoachPulseStructuredRequest
  | WeeklySynthesisStructuredRequest
  | MonthlySynthesisStructuredRequest
  | GoalPacingStructuredRequest
  | PastorVerseStructuredRequest;

export interface AiStructuredResult {
  text: string;
  usage: AiUsage;
  model: string;
}

export interface AiProvider {
  generateStructured(request: AiStructuredRequest): Promise<AiStructuredResult>;
}

export type { AiSurface };
