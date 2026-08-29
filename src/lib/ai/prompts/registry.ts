import type { AiSurface } from "../../../domain/types";
import { COACH_PULSE_PROMPT_VERSION } from "../coach-pulse-service";
import { GOAL_PACING_PROMPT_VERSION } from "../goal-pacing-service";
import { MONTHLY_SYNTHESIS_PROMPT_VERSION } from "../monthly-synthesis-service";
import { WEEKLY_SYNTHESIS_PROMPT_VERSION } from "../weekly-synthesis-service";

export interface PromptRegistryEntry {
  surface: AiSurface;
  version: string;
  description: string;
}

export const PROMPT_REGISTRY: PromptRegistryEntry[] = [
  {
    surface: "coach_pulse",
    version: COACH_PULSE_PROMPT_VERSION,
    description: "Pulse quotidien (open, steer, wind_down, close) avec propositions acceptables."
  },
  {
    surface: "weekly_synthesis",
    version: WEEKLY_SYNTHESIS_PROMPT_VERSION,
    description: "Synthese hebdomadaire: sections, objectifs et actions GTD."
  },
  {
    surface: "monthly_synthesis",
    version: MONTHLY_SYNTHESIS_PROMPT_VERSION,
    description: "Synthese mensuelle: sections et evaluations d'objectifs annuels."
  },
  {
    surface: "goal_pacing",
    version: GOAL_PACING_PROMPT_VERSION,
    description: "Rythme annuel des objectifs (affichage seulement, sans propositions)."
  }
];

export const promptVersionForSurface = (surface: AiSurface): string =>
  PROMPT_REGISTRY.find((entry) => entry.surface === surface)?.version ?? "unknown";
