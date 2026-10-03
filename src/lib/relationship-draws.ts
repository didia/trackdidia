import type { AppSettings, Task } from "../domain/types";
import { t } from "../i18n";
import { buildContextId } from "./gtd/shared";
import { toLocalDateString } from "./date";

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

export { defaultChildrenActivities, defaultSpouseActivities } from "../domain/settings";

export const relationshipDrawDefinitions: RelationshipDrawDefinition[] = [
  {
    category: "children",
    label: t("children.label", { ns: "relationship" }),
    titlePrefix: t("children.titlePrefix", { ns: "relationship" }),
    notes: t("children.notes", { ns: "relationship" }),
    settingsKey: "relationshipDrawChildrenActivities",
    processedDateKey: "relationshipDrawChildrenProcessedDate",
  },
  {
    category: "spouse",
    label: t("spouse.label", { ns: "relationship" }),
    titlePrefix: t("spouse.titlePrefix", { ns: "relationship" }),
    notes: t("spouse.notes", { ns: "relationship" }),
    settingsKey: "relationshipDrawSpouseActivities",
    processedDateKey: "relationshipDrawSpouseProcessedDate",
  },
];

export { normalizeAppSettings as mergeAppSettingsWithDefaults } from "../domain/settings";

export const getRelationshipDrawActivities = (
  settings: AppSettings,
  definition: RelationshipDrawDefinition,
): string[] => settings[definition.settingsKey].map((activity) => activity.trim()).filter(Boolean);

export const getRelationshipDrawProcessedDate = (
  settings: AppSettings,
  definition: RelationshipDrawDefinition,
): string => settings[definition.processedDateKey];

export const setRelationshipDrawProcessedDate = (
  settings: AppSettings,
  definition: RelationshipDrawDefinition,
  date: string,
): AppSettings => ({
  ...settings,
  [definition.processedDateKey]: date,
});

export const getRelationshipDrawSourcePrefix = (category: RelationshipDrawCategory): string =>
  `relationship-draw:${category}:`;

export const getRelationshipDrawSourceExternalId = (
  category: RelationshipDrawCategory,
  date: string,
): string => `${getRelationshipDrawSourcePrefix(category)}${date}`;

export const findActiveRelationshipDrawTask = (
  tasks: Task[],
  category: RelationshipDrawCategory,
): Task | null =>
  tasks.find(
    (task) =>
      task.status === "active" &&
      task.sourceExternalId?.startsWith(getRelationshipDrawSourcePrefix(category)),
  ) ?? null;

export const pickRelationshipDrawActivity = (activities: string[]): string | null => {
  if (activities.length === 0) {
    return null;
  }

  const index = Math.floor(Math.random() * activities.length);
  return activities[index] ?? null;
};

export const buildRelationshipDrawTaskTitle = (
  definition: RelationshipDrawDefinition,
  activity: string,
): string => `${definition.titlePrefix} ${activity}`.trim();

export const isTaskFromRelationshipDrawDate = (task: Task, date: string): boolean =>
  task.sourceExternalId?.endsWith(date) ?? false;

export const getRelationshipDrawTaskDate = (task: Task): string =>
  toLocalDateString(task.createdAt);
