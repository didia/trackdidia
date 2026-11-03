import { applyLegacyAiMaxTokensUpgrade } from "../domain/settings";
import type { AppSettings } from "../domain/types";
import { t } from "../i18n";
import { getTodayDate } from "../lib/date";
import { logDebug } from "../lib/debug";
import { buildContextId } from "../lib/gtd/shared";
import type { AppRepository } from "../lib/storage/repository";

/** Settings fields that record "this one-time startup step already ran". */
export type SettingsMarkerKey =
  | "aiMaxTokensUpgradeDoneAt"
  | "gtdReferencesMigrationDoneAt"
  | "gtdScheduledNormalizationDoneAt"
  | "financeCategoriesSeededAt";

export interface MarkerRunResult<T> {
  /** Settings as persisted after the step (unchanged object when the step was skipped). */
  settings: AppSettings;
  /** True when `work` ran during this call; false when the marker was already set. */
  ran: boolean;
  /** The value returned by `work`; `undefined` when skipped. */
  result: T | undefined;
}

/**
 * Runs `work` at most once per database: skipped when `settings[markerKey]` is already
 * set, otherwise the work runs first and the marker is stamped afterwards so a failed step
 * is retried on the next boot. An existing marker value is never overwritten, which keeps
 * the step idempotent even when `work` already stamped the marker itself.
 */
export const runOnceWithSettingsMarker = async <T>(
  repository: AppRepository,
  settings: AppSettings,
  markerKey: SettingsMarkerKey,
  work: () => Promise<T>,
): Promise<MarkerRunResult<T>> => {
  if (settings[markerKey]) {
    return { settings, ran: false, result: undefined };
  }

  const result = await work();
  const nextSettings = await repository.updateSettings((current) => ({
    ...current,
    [markerKey]: current[markerKey] || new Date().toISOString(),
  }));
  return { settings: nextSettings, ran: true, result };
};

export interface BootstrapOptions {
  /** Called with a user-facing label each time a startup step begins. */
  onStage?: (stage: string) => void;
  onSettingsLoaded?: (settings: AppSettings) => void;
  /**
   * Multi-device sync's startup pull, run before the one-time normalizations and every generator
   * (recurrences, Scheduled promotion, relationship draws) so they see the other laptop's work.
   * It must never throw (a failing folder is its problem to log); it resolves `true` when it ran,
   * and the settings are then read again because a merge can change shared settings. Absent, or
   * resolving `false` (sync off, debug gate closed), bootstrap is exactly what it was without sync.
   * See `docs/multi-device-sync.md` ("Automatic triggers").
   */
  pullBeforeGenerators?: (settings: AppSettings) => Promise<boolean>;
  /**
   * Asked with the loaded settings before anything about the pull is shown or run: when it returns
   * false the step does not exist (no stage label, no call), so a device with sync off or the debug
   * gate closed shows exactly the stages it always did. Absent, the pull runs whenever
   * `pullBeforeGenerators` is given.
   */
  isSyncPullEnabled?: (settings: AppSettings) => boolean;
}

/**
 * Startup data sequence for an already created and initialized repository:
 * settings upgrade -> optional multi-device sync pull -> one-time normalizations -> `reconcileDay` (recurrences, Scheduled
 * promotion, Sunday carryover, expired Pomodoros) -> relationship draws -> optional finance
 * seed. Resolves with the final settings; any thrown error propagates so the caller
 * (`useBootstrap`) can activate the in-memory fallback.
 */
export const bootstrapApplication = async (
  repository: AppRepository,
  { onStage, onSettingsLoaded, pullBeforeGenerators, isSyncPullEnabled }: BootstrapOptions = {},
): Promise<AppSettings> => {
  onStage?.(t("startup.loadSettings"));
  let settings = await repository.getSettings();
  onSettingsLoaded?.(settings);

  if (settings.syncProfile === "personal") {
    const aiUpgrade = await runOnceWithSettingsMarker(
      repository,
      settings,
      "aiMaxTokensUpgradeDoneAt",
      async () => {
        // The upgrade stamps its own marker together with the token value.
        const upgraded = await repository.updateSettings(
          (current) => applyLegacyAiMaxTokensUpgrade(current, new Date().toISOString()) ?? current,
        );
        logDebug("info", "app.bootstrap", "Migration aiMaxTokens terminee", {
          aiMaxTokens: upgraded.aiMaxTokens,
        });
      },
    );
    settings = aiUpgrade.settings;
  }

  if (pullBeforeGenerators && (isSyncPullEnabled?.(settings) ?? true)) {
    onStage?.(t("startup.syncPull"));
    try {
      if (await pullBeforeGenerators(settings)) {
        settings = await repository.getSettings();
      }
    } catch (error) {
      // Defensive: the callback is documented not to throw. A sync problem never blocks startup.
      logDebug("warn", "app.bootstrap", "Pull de synchronisation au demarrage en echec", error);
    }
  }

  const gtdOverview = await repository.getGtdOverview();
  logDebug("info", "app.bootstrap", "Etat GTD au demarrage", {
    gtdImportDoneAt: settings.gtdImportDoneAt,
    gtdOverview,
  });

  const referencesMigration = await runOnceWithSettingsMarker(
    repository,
    settings,
    "gtdReferencesMigrationDoneAt",
    async () => {
      onStage?.(t("startup.migrateReferences"));
      const movedCount = await repository.moveTasksWithContextToBucket(
        buildContextId("Reading"),
        "reference",
      );
      logDebug("info", "app.bootstrap", "Migration Reading -> References terminee", {
        movedCount,
      });
    },
  );
  settings = referencesMigration.settings;

  const scheduledNormalization = await runOnceWithSettingsMarker(
    repository,
    settings,
    "gtdScheduledNormalizationDoneAt",
    async () => {
      onStage?.(t("startup.normalizeScheduled"));
      const movedCount = await repository.moveTasksWithScheduledDatesToBucket("scheduled");
      logDebug("info", "app.bootstrap", "Migration vers Scheduled terminee", { movedCount });
    },
  );
  settings = scheduledNormalization.settings;

  onStage?.(t("startup.generateRecurrences"));
  const today = getTodayDate();
  const reconciliation = await repository.reconcileDay(today);
  logDebug("info", "app.bootstrap", "Generation des recurrences terminee", {
    generatedRecurrences: reconciliation.generatedRecurrences,
    promotedScheduled: reconciliation.promotedScheduled,
    carryoverEvents: reconciliation.carryoverEvents,
  });

  if (settings.syncProfile === "personal") {
    onStage?.(t("startup.generateRelationship"));
    const generatedRelationshipCount = await repository.generateDailyRelationshipTasks(today);
    settings = await repository.getSettings();
    logDebug("info", "app.bootstrap", "Generation des activites relationnelles terminee", {
      generatedRelationshipCount,
    });

    // Idempotent one-time seed, gated on the feature flag and a settings marker — never on
    // the network, and swallowed on failure so it cannot add a new way to miss the 8-second
    // timeout. See docs/finance.md "Settings".
    if (settings.financeEnabled) {
      try {
        const financeSeed = await runOnceWithSettingsMarker(
          repository,
          settings,
          "financeCategoriesSeededAt",
          async () => {
            const seededCount = await repository.seedFinanceDefaultCategories();
            logDebug("info", "app.bootstrap", "Seed des categories de finance terminee", {
              seededCount,
            });
          },
        );
        settings = financeSeed.settings;
      } catch (error) {
        logDebug("error", "app.bootstrap", "Echec du seed des categories de finance", error);
      }
    }
  }
  onStage?.(t("startup.finalize"));
  return settings;
};
