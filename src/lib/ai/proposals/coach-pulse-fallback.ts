import type { Finding } from "../../../domain/insights/types";
import { MIN_SAMPLE_DAYS } from "../../../domain/insights/constants";
import type { CoachPulseResponse, CoachPulseStance } from "../../../domain/types";

const severityRank: Record<Finding["severity"], number> = {
  watch: 3,
  info: 2,
  positive: 1
};

export const hasMeaningfulEvidence = (finding: Finding): boolean => finding.sampleSize >= MIN_SAMPLE_DAYS;

export const pickTopFinding = (findings: Finding[]): Finding | null => {
  const eligible = findings.filter(hasMeaningfulEvidence);
  if (eligible.length === 0) {
    return null;
  }

  return [...eligible].sort((left, right) => {
    const severityDelta = severityRank[right.severity] - severityRank[left.severity];
    if (severityDelta !== 0) {
      return severityDelta;
    }

    return Math.abs(right.value) - Math.abs(left.value);
  })[0];
};

export const buildLocalCoachPulse = (
  stance: CoachPulseStance,
  findings: Finding[]
): CoachPulseResponse => {
  const topFinding = pickTopFinding(findings);

  if (stance === "open") {
    return {
      stance: "open",
      headline: topFinding ? "Lecture du terrain" : "Ouvre simplement",
      read: topFinding?.label ?? "Pas assez de signal pour une lecture fine. Commence par une intention courte et un premier bloc protege.",
      move: {
        what: "Ecris une intention en une phrase",
        why: "Donner un cap clair avant d'entrer dans le flux",
        horizon: "now"
      },
      intentionDraft: topFinding ? `Tenir le cap sur: ${topFinding.label}` : undefined
    };
  }

  return {
    stance: "close",
    headline: topFinding ? "Bilan du jour" : "Referme proprement",
    read: topFinding?.label ?? "La journee merite une lecture honnete, meme imparfaite. Note ce qui a tenu et ce qui a deraille.",
    move: {
      what: "Choisis une seule priorite pour demain",
      why: "Refermer avec un prochain geste concret",
      horizon: "tomorrow"
    },
    tomorrowFocusDraft: topFinding ? `Reprendre la ou ${topFinding.label.toLowerCase()}` : undefined
  };
};
