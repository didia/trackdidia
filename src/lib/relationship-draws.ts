import { LEGACY_FACTORY_AI_MAX_TOKENS } from "../domain/daily-entry";
import type { AppSettings, Task } from "../domain/types";
import { t, tList } from "../i18n";
import { buildContextId, toLocalDateString } from "./gtd/shared";

export type RelationshipDrawCategory = "children" | "spouse";

export interface RelationshipDrawDefinition {
  category: RelationshipDrawCategory;
  label: string;
  titlePrefix: string;
  notes: string;
  settingsKey: "relationshipDrawChildrenActivities" | "relationshipDrawSpouseActivities";
  processedDateKey: "relationshipDrawChildrenProcessedDate" | "relationshipDrawSpouseProcessedDate";
}

export const relationshipPersonalContextName = t("contextPersonal", { ns: "relationship" });
export const relationshipPersonalContextId = buildContextId(relationshipPersonalContextName);

export const defaultChildrenActivities = tList("childrenActivities", "relationship");

export const defaultSpouseActivities = tList("spouseActivities", "relationship");

export const relationshipDrawDefinitions: RelationshipDrawDefinition[] = [
  {
    category: "children",
    label: t("children.label", { ns: "relationship" }),
    titlePrefix: t("children.titlePrefix", { ns: "relationship" }),
    notes: t("children.notes", { ns: "relationship" }),
    settingsKey: "relationshipDrawChildrenActivities",
    processedDateKey: "relationshipDrawChildrenProcessedDate"
  },
  {
    category: "spouse",
    label: t("spouse.label", { ns: "relationship" }),
    titlePrefix: t("spouse.titlePrefix", { ns: "relationship" }),
    notes: t("spouse.notes", { ns: "relationship" }),
    settingsKey: "relationshipDrawSpouseActivities",
    processedDateKey: "relationshipDrawSpouseProcessedDate"
  }
];

export const mergeAppSettingsWithDefaults = (settings: Partial<AppSettings>, defaults: AppSettings): AppSettings => ({
  ...defaults,
  ...settings,
  aiSurfaceModels:
    settings.aiSurfaceModels && typeof settings.aiSurfaceModels === "object"
      ? settings.aiSurfaceModels
      : defaults.aiSurfaceModels,
  aiMaxTokens:
    typeof settings.aiMaxTokens === "number" &&
    settings.aiMaxTokens > 0 &&
    settings.aiMaxTokens !== LEGACY_FACTORY_AI_MAX_TOKENS
      ? settings.aiMaxTokens
      : defaults.aiMaxTokens,
  aiTimeoutMs:
    typeof settings.aiTimeoutMs === "number" && settings.aiTimeoutMs > 0
      ? settings.aiTimeoutMs
      : defaults.aiTimeoutMs,
  relationshipDrawChildrenActivities:
    Array.isArray(settings.relationshipDrawChildrenActivities)
      ? settings.relationshipDrawChildrenActivities
      : defaults.relationshipDrawChildrenActivities,
  relationshipDrawSpouseActivities:
    Array.isArray(settings.relationshipDrawSpouseActivities)
      ? settings.relationshipDrawSpouseActivities
      : defaults.relationshipDrawSpouseActivities,
  aiPulseSlots:
    Array.isArray(settings.aiPulseSlots) && settings.aiPulseSlots.length > 0
      ? settings.aiPulseSlots
      : defaults.aiPulseSlots,
  aiPulseNotifyDays:
    Array.isArray(settings.aiPulseNotifyDays) && settings.aiPulseNotifyDays.length > 0
      ? settings.aiPulseNotifyDays
      : defaults.aiPulseNotifyDays,
  aiPulseMaxNotificationsPerDay:
    typeof settings.aiPulseMaxNotificationsPerDay === "number" && settings.aiPulseMaxNotificationsPerDay >= 0
      ? settings.aiPulseMaxNotificationsPerDay
      : defaults.aiPulseMaxNotificationsPerDay,
  aiPulseFirstOpenAt:
    settings.aiPulseFirstOpenAt && typeof settings.aiPulseFirstOpenAt === "object"
      ? settings.aiPulseFirstOpenAt
      : defaults.aiPulseFirstOpenAt,
  aiCostPerMillionTokens:
    typeof settings.aiCostPerMillionTokens === "number" && settings.aiCostPerMillionTokens >= 0
      ? settings.aiCostPerMillionTokens
      : defaults.aiCostPerMillionTokens
});

export const getRelationshipDrawActivities = (
  settings: AppSettings,
  definition: RelationshipDrawDefinition
): string[] => settings[definition.settingsKey].map((activity) => activity.trim()).filter(Boolean);

export const getRelationshipDrawProcessedDate = (
  settings: AppSettings,
  definition: RelationshipDrawDefinition
): string => settings[definition.processedDateKey];

export const setRelationshipDrawProcessedDate = (
  settings: AppSettings,
  definition: RelationshipDrawDefinition,
  date: string
): AppSettings => ({
  ...settings,
  [definition.processedDateKey]: date
});

export const getRelationshipDrawSourcePrefix = (category: RelationshipDrawCategory): string =>
  `relationship-draw:${category}:`;

export const getRelationshipDrawSourceExternalId = (category: RelationshipDrawCategory, date: string): string =>
  `${getRelationshipDrawSourcePrefix(category)}${date}`;

export const findActiveRelationshipDrawTask = (tasks: Task[], category: RelationshipDrawCategory): Task | null =>
  tasks.find(
    (task) =>
      task.status === "active" &&
      task.sourceExternalId?.startsWith(getRelationshipDrawSourcePrefix(category))
  ) ?? null;

export const pickRelationshipDrawActivity = (activities: string[]): string | null => {
  if (activities.length === 0) {
    return null;
  }

  const index = Math.floor(Math.random() * activities.length);
  return activities[index] ?? null;
};

export const buildRelationshipDrawTaskTitle = (definition: RelationshipDrawDefinition, activity: string): string =>
  `${definition.titlePrefix} ${activity}`.trim();

export const isTaskFromRelationshipDrawDate = (task: Task, date: string): boolean =>
  task.sourceExternalId?.endsWith(date) ?? false;

export const getRelationshipDrawTaskDate = (task: Task): string => toLocalDateString(task.createdAt);
