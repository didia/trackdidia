import type { Finding } from "../../../domain/insights/types";
import { MIN_SAMPLE_DAYS } from "../../../domain/insights/constants";
import type { AiDeltaClass, CoachPulseResponse, CoachPulseStance } from "../../../domain/types";

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

export const buildLocalUnknownPulse = (stance: CoachPulseStance): CoachPulseResponse => ({
  stance,
  headline: "Signal insuffisant",
  read: "Je n'ai pas assez de signal depuis la derniere pulsation. As-tu avance hors application, ou la journee est-elle encore ouverte?",
  move: null
});

export const buildLocalCoachPulse = (
  stance: CoachPulseStance,
  findings: Finding[],
  deltaClass?: AiDeltaClass
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

  if (stance === "steer") {
    return {
      stance: "steer",
      headline: topFinding ? "Mi-journee — corrige le cap" : "Mi-journee — un geste concret",
      read:
        topFinding?.label ??
        (deltaClass === "stall"
          ? "Aucun focus ni tache completee depuis la derniere pulsation. L'apres-midi est encore disponible."
          : "Repere un bloc concret pour relancer l'apres-midi."),
      move: {
        what: "Choisis une seule action de 25 minutes",
        why: "Un geste concret vaut mieux qu'une liste",
        horizon: "now"
      }
    };
  }

  if (stance === "wind_down") {
    return {
      stance: "wind_down",
      headline: topFinding ? "Fin de journee — ce qui reste" : "Fin de journee — referme le realisable",
      read:
        topFinding?.label ??
        "Note ce qui peut encore tenir aujourd'hui et ce qu'il faut laisser tomber sans culpabilite.",
      move: {
        what: "Liste deux choses realistes ou une seule a abandonner",
        why: "Refermer sans surcharger le soir",
        horizon: "today"
      }
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
