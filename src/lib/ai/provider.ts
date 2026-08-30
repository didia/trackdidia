import type { AppSettings, AiSurface, CoachMessage, CoachPulseStance, DailyEntry } from "../../domain/types";
import type { DailySnapshot } from "./context/daily-snapshot";
import type { WeeklySnapshot } from "./context/weekly-snapshot";

export interface AiPromptContext {
  entry: DailyEntry;
  recentEntries: DailyEntry[];
  settings: AppSettings;
  timeZone: string;
  partOfDay: "morning" | "afternoon" | "evening";
  currentPartOfDay: "morning" | "afternoon" | "evening";
  inputContent: string;
}

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

export type AiStructuredRequest = CoachPulseStructuredRequest | WeeklySynthesisStructuredRequest;

export interface AiStructuredResult {
  text: string;
  usage: AiUsage;
  model: string;
}

export interface AiProvider {
  generateStructured(request: AiStructuredRequest): Promise<AiStructuredResult>;
  /** @deprecated Legacy morning/evening coach transport. */
  generate?(kind: CoachMessage["kind"], context: AiPromptContext): Promise<string>;
}

export type { AiSurface };
