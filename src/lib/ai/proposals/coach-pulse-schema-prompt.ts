import type { CoachPulseStance } from "../../../domain/types";

const sharedFields = `Champs communs (toujours requis):
- stance: "open" | "steer" | "wind_down" | "close"
- headline: string (une ligne)
- read: string (lecture des signaux depuis la derniere pulsation)
- move: { what: string; why: string; horizon: "now" | "today" | "tomorrow" } | null`;

const openFields = `Champs stance "open":
- priorities?: Array<{ taskId: string | null; title: string; why: string }> (max 3)
- intentionDraft?: string
- commitmentCheck?: { commitment: string; progress: string; question: string } | null`;

const steerFields = `Champs stance "steer" ou "wind_down":
- commitmentCheck?: { commitment: string; progress: string; question: string } | null`;

const closeFields = `Champs stance "close":
- wins?: string[]
- frictionPoint?: { what: string; why: string; adjustment: string }
- principleToRecover?: string | null (cle de principe valide ou null)
- tomorrowFocusDraft: string (requis)
- commitment?: { statement: string; metricKey: string | null; target: number | null } | null
- memoryCandidates?: Array<{ kind: "pattern" | "preference" | "context" | "commitment" | "principle"; statement: string; confidence: number }>`;

const examples: Record<CoachPulseStance, string> = {
  open: `Exemple minimal open:
{"stance":"open","headline":"Cap clair","read":"...","move":{"what":"...","why":"...","horizon":"now"},"intentionDraft":"..."}`,
  steer: `Exemple minimal steer:
{"stance":"steer","headline":"Mi-journee","read":"...","move":{"what":"...","why":"...","horizon":"now"}}`,
  wind_down: `Exemple minimal wind_down:
{"stance":"wind_down","headline":"Fin active","read":"...","move":{"what":"...","why":"...","horizon":"today"}}`,
  close: `Exemple minimal close:
{"stance":"close","headline":"Bilan","read":"...","move":{"what":"...","why":"...","horizon":"tomorrow"},"tomorrowFocusDraft":"..."}`,
};

export const buildCoachPulseSchemaPrompt = (stance: CoachPulseStance): string => {
  const stanceFields =
    stance === "open" ? openFields : stance === "close" ? closeFields : steerFields;

  return [sharedFields, stanceFields, examples[stance]].join("\n\n");
};
