import { useEffect, useRef, useState } from "react";
import type { SettingsUpdater } from "../domain/settings";
import type { AppSettings } from "../domain/types";
import type { AppOpenInterval } from "../domain/insights/movement";
import type { CoachPulseService } from "../lib/ai/coach-pulse-service";
import { PULSE_CHECK_INTERVAL_MS } from "../lib/ai/pulse/constants";
import { runPulseEngine } from "../lib/ai/pulse/pulse-engine";
import { logDebug } from "../lib/debug";
import type { AppRepository } from "../lib/storage/repository";

export interface PulseSchedulerOptions {
  getSettings: () => AppSettings;
  updateSettings: (updater: SettingsUpdater) => Promise<AppSettings>;
  /** Serializes the startup evaluation with other startup work. */
  enqueueStartupWork: (work: () => Promise<void>) => Promise<void>;
}

/**
 * Evaluates the coach pulse once at startup and then every `PULSE_CHECK_INTERVAL_MS`, and
 * tracks the intervals during which the app window was visible. Changing values (settings,
 * Pomodoro session, `updateSettings`) are read through refs so the effect only restarts when
 * the repository or coach service changes. Returns a revision counter that increments
 * whenever a new pulse message or missed-slot record was persisted.
 */
export const usePulseScheduler = (
  repository: AppRepository | null,
  coachService: CoachPulseService,
  getFocusSessionActive: () => boolean,
  options: PulseSchedulerOptions,
): number => {
  const [pulseRevision, setPulseRevision] = useState(0);
  const pulseRunningRef = useRef(false);
  const appOpenStartedAtRef = useRef<string | null>(null);
  const appOpenIntervalsRef = useRef<AppOpenInterval[]>([]);

  const getFocusSessionActiveRef = useRef(getFocusSessionActive);
  getFocusSessionActiveRef.current = getFocusSessionActive;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    if (!repository) {
      return;
    }

    let cancelled = false;

    const closeOpenInterval = () => {
      const startedAt = appOpenStartedAtRef.current;
      if (!startedAt) {
        return;
      }

      appOpenIntervalsRef.current.push({
        startedAt,
        endedAt: new Date().toISOString(),
      });
      appOpenStartedAtRef.current = null;
    };

    const markAppOpen = () => {
      if (document.visibilityState !== "visible" || appOpenStartedAtRef.current) {
        return;
      }

      appOpenStartedAtRef.current = new Date().toISOString();
    };

    const runPulseEvaluation = async (trigger: "startup" | "interval") => {
      if (pulseRunningRef.current || cancelled) {
        return;
      }

      pulseRunningRef.current = true;
      logDebug("info", "ai.pulse", "Evaluation pulse", { trigger });

      try {
        const openIntervals = [...appOpenIntervalsRef.current];
        if (appOpenStartedAtRef.current) {
          openIntervals.push({
            startedAt: appOpenStartedAtRef.current,
            endedAt: new Date().toISOString(),
          });
        }

        const { getSettings, updateSettings } = optionsRef.current;
        const result = await runPulseEngine({
          repository,
          coachService,
          settings: getSettings(),
          updateSettings,
          appOpenIntervals: openIntervals,
          focusSessionActive: getFocusSessionActiveRef.current(),
        });

        // Publish even if this effect was cleaned up mid-flight. Today otherwise keeps
        // the local brief after the first-open settings write.
        if (result.result || result.recordedMissed > 0) {
          setPulseRevision((current) => current + 1);
        }

        logDebug("info", "ai.pulse", "Evaluation pulse terminee", {
          ranSlot: result.ranSlot?.scopeKey ?? null,
          recordedMissed: result.recordedMissed,
        });
      } catch (error) {
        logDebug("error", "ai.pulse", "Echec evaluation pulse", error);
      } finally {
        pulseRunningRef.current = false;
      }
    };

    markAppOpen();
    void optionsRef.current
      .enqueueStartupWork(() => runPulseEvaluation("startup"))
      .catch((error) => {
        logDebug("error", "app.bootstrap", "Echec tache de demarrage en file", error);
      });

    const intervalId = window.setInterval(() => {
      runPulseEvaluation("interval").catch((error) => {
        logDebug("error", "ai.pulse", "Echec inattendu evaluation pulse (interval)", error);
      });
    }, PULSE_CHECK_INTERVAL_MS);

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        closeOpenInterval();
        return;
      }

      markAppOpen();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      closeOpenInterval();
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [repository, coachService]);

  return pulseRevision;
};
