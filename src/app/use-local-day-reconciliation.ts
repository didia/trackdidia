import { useEffect, useRef, useState } from "react";
import { getTodayDate, msUntilNextLocalMidnight } from "../lib/date";
import { logDebug } from "../lib/debug";
import type { AppRepository } from "../lib/storage/repository";

/**
 * Tracks the current local calendar day and, when it changes, regenerates due
 * recurrences and promotes due Scheduled tasks. A timeout until the next local
 * midnight plus window focus and becoming visible all trigger the check so
 * already-mounted GTD/Pomodoro views can reload without navigation.
 */
export const useLocalDayReconciliation = (repository: AppRepository | null): string => {
  const [calendarDay, setCalendarDay] = useState(getTodayDate);
  const calendarDayRef = useRef(calendarDay);
  const repositoryRef = useRef(repository);
  const promotedForRef = useRef<{ day: string; repository: AppRepository } | null>(null);

  calendarDayRef.current = calendarDay;
  repositoryRef.current = repository;

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
          await candidate.generateDueRecurringTasks(today);
          await candidate.promoteDueScheduledTasks(today);
          promotedForRef.current = { day: today, repository: candidate };
        } catch (error) {
          logDebug("error", "app.localDay", "Echec de la reconciliation du jour local", error);
          return;
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
