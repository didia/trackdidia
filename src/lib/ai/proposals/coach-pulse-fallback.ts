import { MIN_SAMPLE_DAYS } from "../../../domain/insights/constants";
import type { Finding } from "../../../domain/insights/types";
import type { AiDeltaClass, CoachPulseResponse, CoachPulseStance } from "../../../domain/types";
import { t } from "../../../i18n";

const severityRank: Record<Finding["severity"], number> = {
  watch: 3,
  info: 2,
  positive: 1,
};

export const hasMeaningfulEvidence = (finding: Finding): boolean =>
  finding.sampleSize >= MIN_SAMPLE_DAYS;

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
  headline: t("pulse.unknown.headline", { ns: "coach" }),
  read: t("pulse.unknown.read", { ns: "coach" }),
  move: null,
});

export const buildLocalCoachPulse = (
  stance: CoachPulseStance,
  findings: Finding[],
  deltaClass?: AiDeltaClass,
): CoachPulseResponse => {
  const topFinding = pickTopFinding(findings);

  if (stance === "open") {
    return {
      stance: "open",
      headline: topFinding
        ? t("pulse.open.headlineWithFinding", { ns: "coach" })
        : t("pulse.open.headline", { ns: "coach" }),
      read: topFinding?.label ?? t("pulse.open.readFallback", { ns: "coach" }),
      move: {
        what: t("pulse.open.moveWhat", { ns: "coach" }),
        why: t("pulse.open.moveWhy", { ns: "coach" }),
        horizon: "now",
      },
      intentionDraft: topFinding
        ? t("pulse.open.intentionDraft", { ns: "coach", label: topFinding.label })
        : undefined,
    };
  }

  if (stance === "steer") {
    return {
      stance: "steer",
      headline: topFinding
        ? t("pulse.steer.headlineWithFinding", { ns: "coach" })
        : t("pulse.steer.headline", { ns: "coach" }),
      read:
        topFinding?.label ??
        (deltaClass === "stall"
          ? t("pulse.steer.readStall", { ns: "coach" })
          : t("pulse.steer.readFallback", { ns: "coach" })),
      move: {
        what: t("pulse.steer.moveWhat", { ns: "coach" }),
        why: t("pulse.steer.moveWhy", { ns: "coach" }),
        horizon: "now",
      },
    };
  }

  if (stance === "wind_down") {
    return {
      stance: "wind_down",
      headline: topFinding
        ? t("pulse.windDown.headlineWithFinding", { ns: "coach" })
        : t("pulse.windDown.headline", { ns: "coach" }),
      read: topFinding?.label ?? t("pulse.windDown.readFallback", { ns: "coach" }),
      move: {
        what: t("pulse.windDown.moveWhat", { ns: "coach" }),
        why: t("pulse.windDown.moveWhy", { ns: "coach" }),
        horizon: "today",
      },
    };
  }

  return {
    stance: "close",
    headline: topFinding
      ? t("pulse.close.headlineWithFinding", { ns: "coach" })
      : t("pulse.close.headline", { ns: "coach" }),
    read: topFinding?.label ?? t("pulse.close.readFallback", { ns: "coach" }),
    move: {
      what: t("pulse.close.moveWhat", { ns: "coach" }),
      why: t("pulse.close.moveWhy", { ns: "coach" }),
      horizon: "tomorrow",
    },
    tomorrowFocusDraft: topFinding
      ? t("pulse.close.tomorrowFocusDraft", { ns: "coach", label: topFinding.label })
      : undefined,
  };
};
