import type { AppSettings, CoachMessage, DailyEntry } from "../../domain/types";

export interface AiPromptContext {
  entry: DailyEntry;
  recentEntries: DailyEntry[];
  settings: AppSettings;
  timeZone: string;
  partOfDay: "morning" | "afternoon" | "evening";
  currentPartOfDay: "morning" | "afternoon" | "evening";
  inputContent: string;
}

export interface AiProvider {
  generate(kind: CoachMessage["kind"], context: AiPromptContext): Promise<string>;
}
