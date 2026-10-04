import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RescueTimeGoalsSnapshot } from "../../domain/rescuetime-goals";
import type { WeeklyObjectivesSnapshot } from "../../domain/types";
import {
  RescueTimeGoalsService,
  type RescueTimeProductivityPulseSnapshot,
} from "../../lib/rescuetime/rescuetime-goals-service";
import { WeeklyObjectivesService } from "../../lib/rescuetime/weekly-objectives-service";
import { useAppContext } from "../app-context";
import { type LatestRequest, useLatestRequest } from "../use-latest-request";
import { isIsoDateString } from "./review-query-params";

/**
 * RescueTime goals, productivity pulse and standing weekly objectives for the week shown by
 * the weekly review. Each feed has its own latest-wins request so a slow response for a
 * previous week never overwrites the current one.
 *
 * `weekStart` is the week currently displayed. It is only used to reload everything when the
 * RescueTime API key changes; `load`/`refresh` take the week explicitly so the page can start
 * a load for a week it has not committed yet.
 */
export const useRescueTimeWeek = (weekStart: string) => {
  const { t } = useTranslation("reviews");
  const { repository, settings } = useAppContext();
  const goalsService = useMemo(() => new RescueTimeGoalsService(repository), [repository]);
  const objectivesService = useMemo(() => new WeeklyObjectivesService(repository), [repository]);

  const [goals, setGoals] = useState<RescueTimeGoalsSnapshot | null>(null);
  const [pulse, setPulse] = useState<RescueTimeProductivityPulseSnapshot | null>(null);
  const [standingObjectives, setStandingObjectives] = useState<WeeklyObjectivesSnapshot | null>(
    null,
  );
  const [goalsLoading, setGoalsLoading] = useState(true);
  const [pulseLoading, setPulseLoading] = useState(true);
  const [standingObjectivesLoading, setStandingObjectivesLoading] = useState(true);
  const [goalsRefreshing, setGoalsRefreshing] = useState(false);
  const [pulseRefreshing, setPulseRefreshing] = useState(false);
  const [message, setMessage] = useState("");

  const goalsRequest = useLatestRequest();
  const pulseRequest = useLatestRequest();
  const standingObjectivesRequest = useLatestRequest();
  const goalsRef = useRef(goals);
  const pulseRef = useRef(pulse);
  goalsRef.current = goals;
  pulseRef.current = pulse;

  const loadSnapshot = useCallback(
    async <T>(
      request: LatestRequest,
      config: {
        compute: (weekStartDate: string) => Promise<T>;
        apply: (snapshot: T) => void;
        setLoading: (value: boolean) => void;
        setRefreshing: (value: boolean) => void;
        refreshErrorKey: "weekly.rescueGoals.refreshError" | "weekly.rescueGoals.pulseRefreshError";
      },
      requestedWeekStart: string,
      options?: { refreshing?: boolean },
    ) => {
      await request.run(async (signal) => {
        const setBusy = options?.refreshing ? config.setRefreshing : config.setLoading;
        setBusy(true);
        setMessage("");
        try {
          const snapshot = await config.compute(requestedWeekStart);
          if (!signal.isLatest()) {
            return;
          }
          config.apply(snapshot);
        } catch (error) {
          if (!signal.isLatest()) {
            return;
          }
          if (options?.refreshing) {
            setMessage(error instanceof Error ? error.message : t(config.refreshErrorKey));
          }
        } finally {
          if (signal.isLatest()) {
            setBusy(false);
          }
        }
      });
    },
    [t],
  );

  const loadGoals = useCallback(
    (requestedWeekStart: string, options?: { refreshing?: boolean }) =>
      loadSnapshot(
        goalsRequest,
        {
          compute: (week) => goalsService.computeGoalsSnapshot(week),
          apply: setGoals,
          setLoading: setGoalsLoading,
          setRefreshing: setGoalsRefreshing,
          refreshErrorKey: "weekly.rescueGoals.refreshError",
        },
        requestedWeekStart,
        options,
      ),
    [goalsRequest, goalsService, loadSnapshot],
  );

  const loadPulse = useCallback(
    (requestedWeekStart: string, options?: { refreshing?: boolean }) =>
      loadSnapshot(
        pulseRequest,
        {
          compute: (week) => goalsService.computeProductivityPulse(week),
          apply: setPulse,
          setLoading: setPulseLoading,
          setRefreshing: setPulseRefreshing,
          refreshErrorKey: "weekly.rescueGoals.pulseRefreshError",
        },
        requestedWeekStart,
        options,
      ),
    [goalsService, loadSnapshot, pulseRequest],
  );

  const reloadStandingObjectives = useCallback(
    async (requestedWeekStart: string) => {
      await standingObjectivesRequest.run(async (signal) => {
        setStandingObjectivesLoading(true);
        try {
          const snapshot =
            await objectivesService.computeWeeklyObjectivesSnapshot(requestedWeekStart);
          if (!signal.isLatest()) {
            return;
          }
          setStandingObjectives(snapshot);
        } finally {
          if (signal.isLatest()) {
            setStandingObjectivesLoading(false);
          }
        }
      });
    },
    [objectivesService, standingObjectivesRequest],
  );

  /** Clears the previous week's snapshots and loads all three feeds for `requestedWeekStart`. */
  const load = useCallback(
    (requestedWeekStart: string) => {
      setGoals(null);
      setPulse(null);
      setStandingObjectives(null);
      setGoalsRefreshing(false);
      setPulseRefreshing(false);
      setMessage("");
      void loadGoals(requestedWeekStart);
      void loadPulse(requestedWeekStart);
      void reloadStandingObjectives(requestedWeekStart);
    },
    [loadGoals, loadPulse, reloadStandingObjectives],
  );

  /** Re-pulls goals and pulse, keeping the visible snapshots while the pull runs. */
  const refresh = useCallback(
    (requestedWeekStart: string) => {
      void loadGoals(requestedWeekStart, { refreshing: true });
      void loadPulse(requestedWeekStart, { refreshing: true });
    },
    [loadGoals, loadPulse],
  );

  const previousApiKeyRef = useRef(settings.rescuetimeApiKey);
  useEffect(() => {
    if (previousApiKeyRef.current === settings.rescuetimeApiKey) {
      return;
    }
    previousApiKeyRef.current = settings.rescuetimeApiKey;
    if (isIsoDateString(weekStart)) {
      load(weekStart);
    }
  }, [settings.rescuetimeApiKey, weekStart, load]);

  /** Latest snapshots without subscribing the caller to their changes. */
  const getSnapshots = useCallback(
    () => ({ goals: goalsRef.current, pulse: pulseRef.current }),
    [],
  );

  return {
    goals,
    pulse,
    standingObjectives,
    goalsLoading,
    pulseLoading,
    standingObjectivesLoading,
    goalsRefreshing,
    pulseRefreshing,
    message,
    load,
    refresh,
    reloadStandingObjectives,
    getSnapshots,
  };
};
