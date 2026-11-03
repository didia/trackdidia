import { useEffect, useRef, useState } from "react";
import { defaultAppSettings } from "../domain/settings";
import type { AppSettings } from "../domain/types";
import { t } from "../i18n";
import { getDebugEnabled, logDebug } from "../lib/debug";
import { isSyncAutomationEnabled } from "../lib/sync/gate";
import { createRepository } from "../lib/storage/factory";
import { MemoryRepository } from "../lib/storage/memory-repository";
import type { AppRepository } from "../lib/storage/repository";
import { type StartupSync, startStartupSyncPull } from "../lib/sync/startup-sync";
import { bootstrapApplication } from "./bootstrap";
import { isVerifiedEmptyDatabase } from "../lib/sync/profile-data";
import { WORK_PROFILE_SELECTABLE, type DeviceProfile } from "../lib/sync/profile";

export const BOOTSTRAP_TIMEOUT_MS = 8_000;

export interface BootstrapState {
  repository: AppRepository | null;
  settings: AppSettings;
  /** Replaces the settings snapshot (used by the provider after a settings write). */
  setSettings: (settings: AppSettings) => void;
  loading: boolean;
  /** Set when the in-memory fallback is active; shown as a visible warning. */
  startupError: string | null;
  startupStage: string;
  /**
   * The sync engine and the pull started during bootstrap (see `lib/sync/startup-sync.ts`); `null`
   * when sync is off, the debug gate is closed, or the fallback is active. `useMultiDeviceSync`
   * adopts it.
   */
  startupSync: StartupSync | null;
  profileChoice: {
    choose: (profile: DeviceProfile) => Promise<boolean>;
    error: string | null;
    busy: boolean;
    workSelectable: boolean;
  } | null;
}

export interface UseBootstrapOptions {
  /** Runs work alone among backups and syncs; the startup pull and its background tail go through it. */
  runExclusive?: <T>(work: () => Promise<T>) => Promise<T>;
  /** Test seam; release callers always use the compile-time gate. */
  workProfileSelectable?: boolean;
  inspectFirstRun?: boolean;
}

/**
 * Runs `createRepository` + `bootstrapApplication` once. An exception or an eight-second
 * timeout activates a fresh `MemoryRepository` and exposes a warning message instead of
 * blocking the UI.
 */
export const useBootstrap = (options: UseBootstrapOptions = {}): BootstrapState => {
  const [repository, setRepository] = useState<AppRepository | null>(null);
  const [settings, setSettings] = useState(defaultAppSettings);
  const [loading, setLoading] = useState(true);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [startupStage, setStartupStage] = useState(() => t("startup.bootstrap"));
  const startupStageRef = useRef(startupStage);
  const [startupSync, setStartupSync] = useState<StartupSync | null>(null);
  const [profileChoice, setProfileChoice] = useState<BootstrapState["profileChoice"]>(null);
  const runExclusiveRef = useRef(options.runExclusive);
  runExclusiveRef.current = options.runExclusive;

  useEffect(() => {
    let cancelled = false;
    let settled = false;
    let startupComplete = false;
    let knownProfile: AppSettings["syncProfile"] | undefined;
    // The 8-second rule and the moment bootstrap is over, for the sync pull that may outlive its wait.
    let deadlineAtMs = Date.now() + BOOTSTRAP_TIMEOUT_MS;
    let timeoutId: number;
    let releaseBootstrapSettled: () => void = () => undefined;
    const bootstrapSettled = new Promise<void>((resolve) => {
      releaseBootstrapSettled = resolve;
    });

    const markStage = (stage: string) => {
      startupStageRef.current = stage;
      setStartupStage(stage);
      logDebug("info", "app.bootstrap", stage);
    };

    const activateFallback = async (message: string, error?: unknown) => {
      if (settled || cancelled) {
        return;
      }

      settled = true;
      setProfileChoice(null);
      releaseBootstrapSettled();
      const fallbackRepository = new MemoryRepository();
      await fallbackRepository.initialize();
      const fallbackSettings = await fallbackRepository.updateSettings((current) => ({
        ...current,
        syncProfile: knownProfile ?? "work",
      }));

      if (!cancelled && !startupComplete) {
        setRepository(fallbackRepository);
        setSettings(fallbackSettings);
        setStartupError(message);
        setLoading(false);
        logDebug(
          "error",
          "app.bootstrap",
          "Bootstrap en echec, fallback memoire active",
          error ?? message,
        );
      }
    };

    const bootstrap = async () => {
      try {
        markStage(t("startup.createRepository"));
        const nextRepository = await createRepository();
        if (cancelled) return;
        let loaded = await nextRepository.getSettings();
        if (cancelled) return;
        // Old installations already carry startup markers, even if they have no user rows.
        const initialized =
          loaded.syncProfile === "work" ||
          loaded.profileDecisionMadeAt ||
          loaded.gtdReferencesMigrationDoneAt ||
          loaded.gtdScheduledNormalizationDoneAt ||
          loaded.aiMaxTokensUpgradeDoneAt ||
          loaded.dimancheNotesRelocatedAt ||
          loaded.multiDeviceSyncEnabled;
        if (
          initialized ||
          !(options.inspectFirstRun ?? !(nextRepository instanceof MemoryRepository))
        ) {
          knownProfile = loaded.syncProfile;
        }
        if (
          !initialized &&
          (options.inspectFirstRun ?? !(nextRepository instanceof MemoryRepository))
        ) {
          const inspection = await nextRepository.inspectSyncProfileData({ exact: false });
          if (cancelled) return;
          if (!isVerifiedEmptyDatabase(inspection)) knownProfile = loaded.syncProfile;
          if (isVerifiedEmptyDatabase(inspection)) {
            window.clearTimeout(timeoutId);
            loaded = await new Promise<AppSettings>((resolve) => {
              let busy = false;
              const choose = async (profile: DeviceProfile): Promise<boolean> => {
                if (
                  busy ||
                  cancelled ||
                  (profile === "work" &&
                    !(options.workProfileSelectable ?? WORK_PROFILE_SELECTABLE))
                )
                  return false;
                busy = true;
                deadlineAtMs = Date.now() + BOOTSTRAP_TIMEOUT_MS;
                timeoutId = window.setTimeout(onTimeout, BOOTSTRAP_TIMEOUT_MS);
                setProfileChoice({
                  choose,
                  error: null,
                  busy: true,
                  workSelectable: options.workProfileSelectable ?? WORK_PROFILE_SELECTABLE,
                });
                try {
                  const selected = await nextRepository.updateSettings((current) => ({
                    ...current,
                    syncProfile: profile,
                    profileDecisionMadeAt: new Date().toISOString(),
                  }));
                  if (cancelled) return false;
                  knownProfile = selected.syncProfile;
                  setProfileChoice(null);
                  resolve(selected);
                  return true;
                } catch (error) {
                  window.clearTimeout(timeoutId);
                  busy = false;
                  if (!cancelled)
                    setProfileChoice({
                      choose,
                      error: error instanceof Error ? error.message : t("startup.unknownError"),
                      busy: false,
                      workSelectable: options.workProfileSelectable ?? WORK_PROFILE_SELECTABLE,
                    });
                  return false;
                }
              };
              setProfileChoice({
                choose,
                error: null,
                busy: false,
                workSelectable: options.workProfileSelectable ?? WORK_PROFILE_SELECTABLE,
              });
            });
          }
        }
        if (cancelled) return;
        let started: StartupSync | null = null;
        const nextSettings = await bootstrapApplication(nextRepository, {
          onStage: markStage,
          onSettingsLoaded: (loaded) => {
            knownProfile = loaded.syncProfile;
          },
          // Sync off or the debug gate closed: the step does not exist (no stage, no call).
          isSyncPullEnabled: (current) => isSyncAutomationEnabled(getDebugEnabled(), current),
          pullBeforeGenerators: async (current) => {
            started = await startStartupSyncPull({
              repository: nextRepository,
              settings: current,
              debugEnabled: getDebugEnabled(),
              runExclusive: runExclusiveRef.current ?? ((work) => work()),
              bootstrapDeadlineAtMs: deadlineAtMs,
              bootstrapSettled,
            });
            return started?.finished?.ok === true;
          },
        });

        if (cancelled) return;
        startupComplete = true;
        settled = true;
        window.clearTimeout(timeoutId);
        if (!cancelled) {
          setStartupSync(started);
          setRepository(nextRepository);
          setSettings(nextSettings);
          setStartupError(null);
          setLoading(false);
          logDebug("info", "app.bootstrap", "Bootstrap termine");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : t("startup.unknownError");
        await activateFallback(message, error);
      } finally {
        // Whatever happened, a sync pull held back until now may go on.
        releaseBootstrapSettled();
      }
    };

    const onTimeout = () => {
      // A late repository may expose the chooser after the fallback already settled. If its
      // save stalls, leave the existing fallback accessible; a late success can still recover.
      if (settled && !startupComplete && !cancelled) {
        setProfileChoice(null);
        return;
      }
      activateFallback(t("startup.timeout", { stage: startupStageRef.current })).catch((error) => {
        logDebug("error", "app.bootstrap", "Echec inattendu du fallback (timeout)", error);
      });
    };
    timeoutId = window.setTimeout(onTimeout, BOOTSTRAP_TIMEOUT_MS);

    bootstrap().catch((error) => {
      logDebug("error", "app.bootstrap", "Echec inattendu du bootstrap (non intercepte)", error);
    });

    return () => {
      cancelled = true;
      releaseBootstrapSettled();
      window.clearTimeout(timeoutId);
    };
  }, []);

  return {
    repository,
    settings,
    setSettings,
    loading,
    startupError,
    startupStage,
    startupSync,
    profileChoice,
  };
};
