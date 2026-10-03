import type { AppSettings } from "./types";
import { tList } from "../i18n";

export type SettingsUpdater = (current: AppSettings) => AppSettings;

export const defaultChildrenActivities = tList("childrenActivities", "relationship");
export const defaultSpouseActivities = tList("spouseActivities", "relationship");

export const DEFAULT_AI_MAX_TOKENS = 4_096;
/** Previous factory default, upgraded once at bootstrap when `aiMaxTokensUpgradeDoneAt` is empty. */
export const LEGACY_FACTORY_AI_MAX_TOKENS = 700;

export const applyLegacyAiMaxTokensUpgrade = (
  settings: AppSettings,
  nowIso: string,
): AppSettings | null => {
  if (settings.aiMaxTokensUpgradeDoneAt) {
    return null;
  }

  return {
    ...settings,
    aiMaxTokens:
      settings.aiMaxTokens === LEGACY_FACTORY_AI_MAX_TOKENS
        ? DEFAULT_AI_MAX_TOKENS
        : settings.aiMaxTokens,
    aiMaxTokensUpgradeDoneAt: nowIso,
  };
};

export const defaultAppSettings = (): AppSettings => ({
  language: "fr",
  storageMode: "sqlite",
  aiEnabled: false,
  aiApiKey: "",
  aiBaseUrl: "https://openrouter.ai/api/v1",
  aiModel: "moonshotai/kimi-k2.6",
  aiPayloadScope: "full",
  aiSurfaceModels: {},
  aiMaxTokens: DEFAULT_AI_MAX_TOKENS,
  aiTimeoutMs: 20_000,
  aiMemoryEnabled: true,
  aiPulseEnabled: true,
  aiPulseSlots: [5, 13, 20],
  aiPulseNotifyEnabled: true,
  aiPulseNotifyDays: [1, 2, 3, 4, 5],
  aiPulseMaxNotificationsPerDay: 2,
  aiPastorEnabled: false,
  aiPastorCustomVerses: [],
  aiCostPerMillionTokens: 1,
  aiPulseFirstOpenAt: {},
  rescuetimeApiKey: "",
  autoBackupEnabled: true,
  autoBackupIntervalHours: 24,
  backupDestinationDir: "",
  lastBackupAt: "",
  lastBackupPath: "",
  gtdImportDoneAt: "",
  gtdReferencesMigrationDoneAt: "",
  gtdScheduledNormalizationDoneAt: "",
  gtdRecurringCollapseDoneAt: "",
  dimancheNotesRelocatedAt: "",
  aiMaxTokensUpgradeDoneAt: "",
  relationshipDrawsEnabled: true,
  relationshipDrawChildrenActivities: [...defaultChildrenActivities],
  relationshipDrawSpouseActivities: [...defaultSpouseActivities],
  relationshipDrawChildrenProcessedDate: "",
  relationshipDrawSpouseProcessedDate: "",
  previousDayReviewDoneDate: "",
});

export const normalizeAppSettings = (
  settings: Partial<AppSettings>,
  defaults: AppSettings = defaultAppSettings(),
): AppSettings => ({
  ...defaults,
  ...settings,
  aiSurfaceModels:
    settings.aiSurfaceModels && typeof settings.aiSurfaceModels === "object"
      ? settings.aiSurfaceModels
      : defaults.aiSurfaceModels,
  aiMaxTokens:
    typeof settings.aiMaxTokens === "number" && settings.aiMaxTokens > 0
      ? settings.aiMaxTokens
      : defaults.aiMaxTokens,
  aiTimeoutMs:
    typeof settings.aiTimeoutMs === "number" && settings.aiTimeoutMs > 0
      ? settings.aiTimeoutMs
      : defaults.aiTimeoutMs,
  relationshipDrawChildrenActivities: Array.isArray(settings.relationshipDrawChildrenActivities)
    ? settings.relationshipDrawChildrenActivities
    : defaults.relationshipDrawChildrenActivities,
  relationshipDrawSpouseActivities: Array.isArray(settings.relationshipDrawSpouseActivities)
    ? settings.relationshipDrawSpouseActivities
    : defaults.relationshipDrawSpouseActivities,
  aiPastorCustomVerses: Array.isArray(settings.aiPastorCustomVerses)
    ? settings.aiPastorCustomVerses
    : defaults.aiPastorCustomVerses,
  aiPulseSlots:
    Array.isArray(settings.aiPulseSlots) && settings.aiPulseSlots.length > 0
      ? settings.aiPulseSlots
      : defaults.aiPulseSlots,
  aiPulseNotifyDays:
    Array.isArray(settings.aiPulseNotifyDays) && settings.aiPulseNotifyDays.length > 0
      ? settings.aiPulseNotifyDays
      : defaults.aiPulseNotifyDays,
  aiPulseMaxNotificationsPerDay:
    typeof settings.aiPulseMaxNotificationsPerDay === "number" &&
    settings.aiPulseMaxNotificationsPerDay >= 0
      ? settings.aiPulseMaxNotificationsPerDay
      : defaults.aiPulseMaxNotificationsPerDay,
  aiPulseFirstOpenAt:
    settings.aiPulseFirstOpenAt && typeof settings.aiPulseFirstOpenAt === "object"
      ? settings.aiPulseFirstOpenAt
      : defaults.aiPulseFirstOpenAt,
  aiCostPerMillionTokens:
    typeof settings.aiCostPerMillionTokens === "number" && settings.aiCostPerMillionTokens >= 0
      ? settings.aiCostPerMillionTokens
      : defaults.aiCostPerMillionTokens,
});

/** Only fields edited relative to the form's baseline are submitted. */
export const settingsDraftPatch = (
  draft: AppSettings,
  baseline: AppSettings,
  keys: readonly (keyof AppSettings)[],
): Partial<AppSettings> =>
  Object.fromEntries(
    keys
      .filter((key) => JSON.stringify(draft[key]) !== JSON.stringify(baseline[key]))
      .map((key) => [key, draft[key]]),
  );

/** Refresh runtime data without erasing an unsaved preference edit. */
export const rebaseSettingsDraft = (
  draft: AppSettings,
  baseline: AppSettings,
  current: AppSettings,
): AppSettings => ({
  ...current,
  ...settingsDraftPatch(draft, baseline, Object.keys(baseline) as (keyof AppSettings)[]),
});
