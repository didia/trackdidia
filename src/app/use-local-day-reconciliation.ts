import { useEffect, useRef, useState } from "react";
import { getTodayDate, msUntilNextLocalMidnight } from "../lib/date";
import { logDebug } from "../lib/debug";
import { evaluateFinanceAlertNotifications } from "../lib/finance/alert-notification-policy";
import { notifyPomodoroCompletion } from "../lib/pomodoro/sound";
import type { AppRepository } from "../lib/storage/repository";
import { t } from "../i18n";

/**
 * Tracks the current local calendar day and, when it changes, runs
 * `repository.reconcileDay` (due recurrences, Scheduled promotion, Sunday carryover, expired
 * Pomodoro completion). A timeout until the next local
 * midnight plus window focus and becoming visible all trigger the check so
 * already-mounted GTD/Pomodoro views can reload without navigation.
 *
 * When `financeEnabled`, the same reconciliation also snapshots today's
 * account balances (`snapshotFinanceAccountBalances`) so the net-worth
 * history has one point per day the app was open — see
 * specs/todo/finance.md "Bootstrap". A snapshot failure is logged (counts
 * only, never amounts) and never blocks recurrence/promotion.
 *
 * When `financeEnabled && financeNotifyRunout`, the same reconciliation also
 * computes the forecast and fires at most one desktop notification per alert
 * key per day (see `src/lib/finance/alert-notification-policy.ts`). Every
 * pass (startup, focus, visibility, midnight) re-forecasts and the per-day
 * ledger suppresses keys already delivered; overlapping passes are serialized
 * so none can read the ledger before another records into it. This runs
 * on first mount too (the app-wide "at startup after bootstrap" trigger), is
 * never on the critical path of the 8-second startup timeout, no network
 * call is involved, and every failure is swallowed and logged as counts only.
 */
export const useLocalDayReconciliation = (
  repository: AppRepository | null,
  financeEnabled = false,
  financeNotifyRunout = false,
): string => {
  const [calendarDay, setCalendarDay] = useState(getTodayDate);
  const calendarDayRef = useRef(calendarDay);
  const repositoryRef = useRef(repository);
  const financeEnabledRef = useRef(financeEnabled);
  const financeNotifyRunoutRef = useRef(financeNotifyRunout);
  const promotedForRef = useRef<{ day: string; repository: AppRepository } | null>(null);
  const alertsChainRef = useRef<Promise<void>>(Promise.resolve());

  calendarDayRef.current = calendarDay;
  repositoryRef.current = repository;
  financeEnabledRef.current = financeEnabled;
  financeNotifyRunoutRef.current = financeNotifyRunout;

  useEffect(() => {
    let cancelled = false;
    let timeoutId: number | undefined;

    const snapshotFinance = async (candidate: AppRepository | null, today: string) => {
      if (!candidate || !financeEnabledRef.current) {
        return;
      }
      try {
        const count = await candidate.snapshotFinanceAccountBalances(today);
        logDebug("info", "app.localDay", "Snapshot des soldes finance effectue", { count });
      } catch {
        // Never blocks the day-boundary reconciliation; log a fixed message only, never the
        // error (its message/stack could carry row data).
        logDebug("error", "app.localDay", "Echec du snapshot des soldes finance");
      }
    };

    const notifyFinanceAlerts = async (candidate: AppRepository, today: string) => {
      try {
        const { alerts } = await candidate.computeFinanceForecast(today);
        const alreadyNotifiedKeysToday = await candidate.listNotifiedFinanceAlertKeys(today);
        const decisions = evaluateFinanceAlertNotifications({
          settings: { financeNotifyRunout: financeNotifyRunoutRef.current },
          alerts,
          alreadyNotifiedKeysToday,
        });

        const categories = decisions.length > 0 ? await candidate.listFinanceCategories(true) : [];
        const categoryNameById = new Map(
          categories.map((category) => [category.id, category.name]),
        );
        let notifiedCount = 0;

        for (const { alert } of decisions) {
          const title =
            alert.kind === "cash_runout"
              ? t("financeCashRunoutTitle", { ns: "notifications" })
              : alert.kind === "envelope_exhausted"
                ? t("financeEnvelopeExhaustedTitle", { ns: "notifications" })
                : t("financeEnvelopeWillRunOutTitle", { ns: "notifications" });
          const body =
            alert.kind === "cash_runout"
              ? t("financeCashRunoutBody", { ns: "notifications", days: alert.daysUntilRunout })
              : t("financeEnvelopeBody", {
                  ns: "notifications",
                  category: categoryNameById.get(alert.categoryId ?? "") ?? "",
                });

          const notified = await notifyPomodoroCompletion(title, body);
          if (notified) {
            // Recorded right after delivery so a later failure cannot make a retry re-notify.
            await candidate.recordFinanceAlertNotifications(today, [alert.key]);
            notifiedCount += 1;
          }
        }

        logDebug("info", "app.localDay", "Verification alertes finance effectuee", {
          alertCount: alerts.length,
          notifiedCount,
        });
      } catch {
        // Never blocks the day-boundary reconciliation above; the error itself is not logged
        // (its message/stack could carry row data).
        logDebug("error", "app.localDay", "Echec de la verification des alertes finance");
      }
    };

    const reconcile = async () => {
      const today = getTodayDate();
      const candidate = repositoryRef.current;
      const alreadyPromoted =
        candidate !== null &&
        promotedForRef.current?.day === today &&
        promotedForRef.current.repository === candidate;

      if (candidate && !alreadyPromoted) {
        try {
          await candidate.reconcileDay(today);
          promotedForRef.current = { day: today, repository: candidate };
        } catch (error) {
          logDebug("error", "app.localDay", "Echec de la reconciliation du jour local", error);
          // Still attempt the finance snapshot below; the calendar day is not republished.
          await snapshotFinance(candidate, today);
          return;
        }
      }

      // The upsert is idempotent per (account, day), so every pass refreshes today's point
      // instead of freezing the first observation of the day.
      await snapshotFinance(candidate, today);

      if (candidate && financeEnabledRef.current && financeNotifyRunoutRef.current) {
        // Passes (startup, focus, visibility, midnight) are serialized so two overlapping ones
        // cannot both read an empty ledger and notify the same key; every pass re-forecasts and
        // the per-day ledger alone suppresses keys that were already delivered.
        const pass = alertsChainRef.current.then(() => notifyFinanceAlerts(candidate, today));
        alertsChainRef.current = pass;
        await pass;
      }

      if (!cancelled && today !== calendarDayRef.current) {
        calendarDayRef.current = today;
        setCalendarDay(today);
      }
    };

    const scheduleNextMidnight = () => {
      window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(() => {
        void reconcile().then(() => {
          if (!cancelled) {
            scheduleNextMidnight();
          }
        });
      }, msUntilNextLocalMidnight());
    };

    const onResume = () => {
      if (document.visibilityState === "hidden") {
        return;
      }

      void reconcile();
    };

    void reconcile();
    scheduleNextMidnight();
    window.addEventListener("focus", onResume);
    document.addEventListener("visibilitychange", onResume);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
      window.removeEventListener("focus", onResume);
      document.removeEventListener("visibilitychange", onResume);
    };
  }, [repository, financeEnabled]);

  return calendarDay;
};
