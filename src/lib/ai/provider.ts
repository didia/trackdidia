import type { AppSettings, CoachMessage, DailyEntry } from "../../domain/types";

export interface AiPromptContext {
  entry: DailyEntry;
  recentEntries: DailyEntry[];
  settings: AppSettings;
}

export interface AiProvider {
  generate(kind: CoachMessage["kind"], context: AiPromptContext): Promise<string>;
}

