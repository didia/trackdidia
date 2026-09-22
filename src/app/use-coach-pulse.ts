import { useCallback, useEffect, useRef, useState } from "react";
import type { CoachPulseResult, CoachPulseStance, DailyEntry } from "../domain/types";
import { loadPassiveCoachPulse, refreshCoachPulse } from "../lib/ai/coach-pulse-loader";
import { logDebug } from "../lib/debug";
import { useAppContext } from "./app-context";
import { useLatestRequest } from "./use-latest-request";

export interface CoachPulseRefreshOptions {
  trigger: "auto" | "explicit";
  bypassCache?: boolean;
  skipRescueTimeFetch?: boolean;
  /** Open surface only: force a stance instead of the latest stored pulse's. */
  stance?: CoachPulseStance;
  slotHour?: number;
}

export interface UseCoachPulseInput {
  date: string | undefined;
  entry: DailyEntry | null | undefined;
  stance: "open" | "close";
  /** Bumped by the pulse engine when it persists a new pulse; triggers a passive reload. */
  pulseRevision?: number;
}

/**
 * Coach pulse state for a ritual page: passive load on open (store, then local, then AI;
 * see `loadPassiveCoachPulse`) plus explicit refresh. Stale responses are dropped, and a
 * passive load never overwrites an explicit refresh that is in flight.
 */
export const useCoachPulse = ({ date, entry, stance, pulseRevision }: UseCoachPulseInput) => {
  const { repository, settings, coachService } = useAppContext();
  const [result, setResult] = useState<CoachPulseResult | null>(null);
  const [loading, setLoading] = useState(true);
  const entryRef = useRef(entry);
  entryRef.current = entry;
  const passiveRequest = useLatestRequest();
  const explicitRequest = useLatestRequest();
  const explicitInFlightRef = useRef(false);

  const loadPassive = useCallback(async () => {
    const currentEntry = entryRef.current;
    if (!currentEntry || explicitInFlightRef.current) {
      return;
    }

    await passiveRequest.run(async (signal) => {
      const isCurrent = () => signal.isLatest() && !explicitInFlightRef.current;
      setLoading(true);
      try {
        await loadPassiveCoachPulse(
          { repository, coachService, settings },
          { entry: currentEntry, stance, publish: setResult, isCurrent },
        );
      } catch (error) {
        logDebug("error", "ai.coach", "Failed to load coach pulse", error);
      } finally {
        if (isCurrent()) {
          setLoading(false);
        }
      }
    });
  }, [coachService, passiveRequest, repository, settings, stance]);

  const refresh = useCallback(
    async (options: CoachPulseRefreshOptions) => {
      const currentEntry = entryRef.current;
      if (!currentEntry) {
        return;
      }

      await explicitRequest.run(async (signal) => {
        explicitInFlightRef.current = true;
        setLoading(true);
        try {
          const refreshed = await refreshCoachPulse(
            { repository, coachService, settings },
            {
              entry: currentEntry,
              stance,
              trigger: options.trigger,
              bypassCache: options.bypassCache,
              skipRescueTimeFetch: options.skipRescueTimeFetch,
              pulseStance: options.stance,
              slotHour: options.slotHour,
            },
          );
          if (signal.isLatest()) {
            setResult(refreshed);
          }
        } catch (error) {
          logDebug("error", "ai.coach", "Failed to refresh coach pulse", error);
        } finally {
          if (signal.isLatest()) {
            explicitInFlightRef.current = false;
            setLoading(false);
          }
        }
      });
    },
    [coachService, explicitRequest, repository, settings, stance],
  );

  useEffect(() => {
    if (!date || explicitInFlightRef.current) {
      return;
    }

    void loadPassive();
    // pulseRevision is a re-run trigger only.
  }, [date, loadPassive, pulseRevision]);

  return { result, loading, refresh, setResult };
};
