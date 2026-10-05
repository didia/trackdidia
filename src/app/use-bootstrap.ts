import { useEffect, useRef, useState } from "react";
import { defaultAppSettings } from "../domain/settings";
import type { AppSettings } from "../domain/types";
import { t } from "../i18n";
import { logDebug } from "../lib/debug";
import { createRepository } from "../lib/storage/factory";
import { MemoryRepository } from "../lib/storage/memory-repository";
import type { AppRepository } from "../lib/storage/repository";
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
}

/**
 * Runs `createRepository` + `bootstrapApplication` once. An exception or an eight-second
 * timeout activates a fresh `MemoryRepository` and exposes a warning message instead of
 * blocking the UI.
 */
export const useBootstrap = (): BootstrapState => {
  const [repository, setRepository] = useState<AppRepository | null>(null);
  const [settings, setSettings] = useState(defaultAppSettings);
  const [loading, setLoading] = useState(true);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [startupStage, setStartupStage] = useState(() => t("startup.bootstrap"));
  const startupStageRef = useRef(startupStage);

  useEffect(() => {
    let cancelled = false;
    let settled = false;

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
      const fallbackRepository = new MemoryRepository();
      await fallbackRepository.initialize();

      if (!cancelled) {
        setRepository(fallbackRepository);
        setSettings(defaultAppSettings());
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
        const nextSettings = await bootstrapApplication(nextRepository, { onStage: markStage });

        settled = true;
        if (!cancelled) {
          setRepository(nextRepository);
          setSettings(nextSettings);
          setStartupError(null);
          setLoading(false);
          logDebug("info", "app.bootstrap", "Bootstrap termine");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : t("startup.unknownError");
        await activateFallback(message, error);
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
      window.clearTimeout(timeoutId);
    };
  }, []);

  return { repository, settings, setSettings, loading, startupError, startupStage };
};
