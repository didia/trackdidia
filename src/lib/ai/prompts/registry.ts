import type { AiSurface } from "../../../domain/types";
import { t } from "../../../i18n";
import { COACH_PULSE_PROMPT_VERSION } from "../coach-pulse-service";
import { FINANCE_CATEGORIZATION_PROMPT_VERSION } from "../finance-categorization-service";
import { GOAL_PACING_PROMPT_VERSION } from "../goal-pacing-service";
import { MID_WEEK_STEERING_PROMPT_VERSION } from "../mid-week-steering-service";
import { MONTHLY_SYNTHESIS_PROMPT_VERSION } from "../monthly-synthesis-service";
import { PASTOR_VERSE_PROMPT_VERSION } from "../pastor-verse-service";
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
  {
    surface: "mid_week_steering",
    version: MID_WEEK_STEERING_PROMPT_VERSION,
    description: t("analytics.prompt.mid_week_steering", { ns: "settings" }),
  },
  {
    surface: "pastor_verse",
    version: PASTOR_VERSE_PROMPT_VERSION,
    description: t("analytics.prompt.pastor_verse", { ns: "settings" }),
  },
  {
    surface: "finance_categorization",
    version: FINANCE_CATEGORIZATION_PROMPT_VERSION,
    description: t("analytics.prompt.finance_categorization", { ns: "settings" }),
  },
];

export const promptVersionForSurface = (surface: AiSurface): string =>
  PROMPT_REGISTRY.find((entry) => entry.surface === surface)?.version ?? "unknown";
