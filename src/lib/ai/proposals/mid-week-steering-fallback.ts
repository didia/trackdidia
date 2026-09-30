import { rankMidWeekSignals } from "../../../domain/mid-week-review";
import type { MidWeekSteeringEffort, MidWeekSteeringResponse } from "../../../domain/types";
import { t } from "../../../i18n";
import type { MidWeekSnapshot } from "../context/mid-week-snapshot";

const MAX_LOCAL_ACTIONS = 3;

/** Deterministic steering built from the ranked lagging signals and their B1 recovery lines. */
export const buildLocalMidWeekSteering = (snapshot: MidWeekSnapshot): MidWeekSteeringResponse => {
  const actionable = new Set(snapshot.actionableKeys);
  const ranked = rankMidWeekSignals(
    snapshot.signals.filter((signal) => actionable.has(signal.key)),
  );
  const top = ranked.slice(0, MAX_LOCAL_ACTIONS);

  if (top.length === 0) {
    return {
      asOfDate: snapshot.asOfDate,
      headline: t("midWeekSteering.local.headlineClear", { ns: "coach" }),
      read: t("midWeekSteering.local.readClear", { ns: "coach" }),
      focusShift: t("midWeekSteering.local.focusClear", { ns: "coach" }),
      actions: [],
    };
  }

  return {
    asOfDate: snapshot.asOfDate,
    headline: t("midWeekSteering.local.headline", { ns: "coach", count: ranked.length }),
    read: top.map((signal) => `${signal.label} — ${signal.recovery}`).join("\n"),
    focusShift: t("midWeekSteering.local.focus", { ns: "coach", label: top[0].label }),
    actions: top.map((signal) => ({
      signalKey: signal.key,
      title: signal.label,
      why: signal.recovery,
      effort: (signal.status === "lagging" ? "high" : "medium") as MidWeekSteeringEffort,
    })),
  };
};
