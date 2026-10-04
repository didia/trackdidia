import { useEffect, useRef, useState } from "react";
import { getTodayDate, msUntilNextLocalMidnight } from "../lib/date";
import { logDebug } from "../lib/debug";
import type { AppRepository } from "../lib/storage/repository";

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
 */
export const useLocalDayReconciliation = (
  repository: AppRepository | null,
  financeEnabled = false,
): string => {
  const [calendarDay, setCalendarDay] = useState(getTodayDate);
  const calendarDayRef = useRef(calendarDay);
  const repositoryRef = useRef(repository);
  const financeEnabledRef = useRef(financeEnabled);
  const promotedForRef = useRef<{ day: string; repository: AppRepository } | null>(null);
  const snapshottedForRef = useRef<{ day: string; repository: AppRepository } | null>(null);

  calendarDayRef.current = calendarDay;
  repositoryRef.current = repository;
  financeEnabledRef.current = financeEnabled;

  useEffect(() => {
    let cancelled = false;
    let timeoutId: number | undefined;

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
          return;
        }
      }

      const alreadySnapshotted =
        candidate !== null &&
        snapshottedForRef.current?.day === today &&
        snapshottedForRef.current.repository === candidate;

      if (candidate && financeEnabledRef.current && !alreadySnapshotted) {
        try {
          const count = await candidate.snapshotFinanceAccountBalances(today);
          snapshottedForRef.current = { day: today, repository: candidate };
          logDebug("info", "app.localDay", "Snapshot des soldes finance effectue", { count });
        } catch (error) {
          // Never blocks the day-boundary reconciliation above; counts/durations only.
          logDebug("error", "app.localDay", "Echec du snapshot des soldes finance", error);
        }
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
  }, [repository]);

  return calendarDay;
};
