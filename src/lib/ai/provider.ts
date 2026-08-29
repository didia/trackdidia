import type { AppSettings, AiSurface, CoachMessage, CoachPulseStance, DailyEntry } from "../../domain/types";
import type { DailySnapshot } from "./context/daily-snapshot";

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

export interface AiStructuredRequest {
  surface: AiSurface;
  stance: CoachPulseStance;
  settings: AppSettings;
  snapshot: DailySnapshot;
  repairHint?: string;
}

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
