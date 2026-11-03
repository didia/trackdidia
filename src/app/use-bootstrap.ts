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
}

export interface UseBootstrapOptions {
  /** Runs work alone among backups and syncs; the startup pull and its background tail go through it. */
  runExclusive?: <T>(work: () => Promise<T>) => Promise<T>;
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
  const runExclusiveRef = useRef(options.runExclusive);
  runExclusiveRef.current = options.runExclusive;

  useEffect(() => {
    let cancelled = false;
    let settled = false;
    let bootstrapSucceeded = false;
    let knownProfile: AppSettings["syncProfile"] | undefined;
    // The 8-second rule and the moment bootstrap is over, for the sync pull that may outlive its wait.
    const deadlineAtMs = Date.now() + BOOTSTRAP_TIMEOUT_MS;
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
      releaseBootstrapSettled();
      const fallbackRepository = new MemoryRepository();
      await fallbackRepository.initialize();
      const fallbackSettings = await fallbackRepository.updateSettings((current) => ({
        ...current,
        syncProfile: knownProfile ?? "work",
      }));

      if (!cancelled && !bootstrapSucceeded) {
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
        bootstrapSucceeded = true;
        settled = true;
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

    const timeoutId = window.setTimeout(() => {
      activateFallback(t("startup.timeout", { stage: startupStageRef.current })).catch((error) => {
        logDebug("error", "app.bootstrap", "Echec inattendu du fallback (timeout)", error);
      });
    }, BOOTSTRAP_TIMEOUT_MS);

    bootstrap().catch((error) => {
      logDebug("error", "app.bootstrap", "Echec inattendu du bootstrap (non intercepte)", error);
    });

    return () => {
      cancelled = true;
      releaseBootstrapSettled();
      window.clearTimeout(timeoutId);
    };
  }, []);

  return { repository, settings, setSettings, loading, startupError, startupStage, startupSync };
};
