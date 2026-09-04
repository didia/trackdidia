import type { AiSurface } from "../../../domain/types";
import { t } from "../../../i18n";
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
    description: t("analytics.prompt.coach_pulse", { ns: "settings" }),
  },
  {
    surface: "weekly_synthesis",
    version: WEEKLY_SYNTHESIS_PROMPT_VERSION,
    description: t("analytics.prompt.weekly_synthesis", { ns: "settings" }),
  },
  {
    surface: "monthly_synthesis",
    version: MONTHLY_SYNTHESIS_PROMPT_VERSION,
    description: t("analytics.prompt.monthly_synthesis", { ns: "settings" }),
  },
  {
    surface: "goal_pacing",
    version: GOAL_PACING_PROMPT_VERSION,
    description: t("analytics.prompt.goal_pacing", { ns: "settings" }),
  },
];

export const promptVersionForSurface = (surface: AiSurface): string =>
  PROMPT_REGISTRY.find((entry) => entry.surface === surface)?.version ?? "unknown";
