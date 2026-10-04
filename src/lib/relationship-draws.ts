import type { AppSettings, CreateTaskInput, Task } from "../domain/types";
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

/** Plan from the settings/tasks read inside the caller's protected write operation. */
export const buildDailyRelationshipDrawPlan = (
  date: string,
  settings: AppSettings,
  tasks: Task[],
): { taskInputs: CreateTaskInput[]; settings: AppSettings } => {
  let nextSettings = settings;
  const taskInputs: CreateTaskInput[] = [];
  if (!settings.relationshipDrawsEnabled) return { taskInputs, settings };

  for (const definition of relationshipDrawDefinitions) {
    // Local YYYY-MM-DD keys sort chronologically; stale calls must not reopen an older day.
    if (getRelationshipDrawProcessedDate(nextSettings, definition) >= date) continue;
    if (!findActiveRelationshipDrawTask(tasks, definition.category)) {
      const activity = pickRelationshipDrawActivity(
        getRelationshipDrawActivities(nextSettings, definition),
      );
      if (!activity) continue;
      taskInputs.push({
        title: buildRelationshipDrawTaskTitle(definition, activity),
        notes: definition.notes,
        bucket: "next_action",
        contextIds: [relationshipPersonalContextId],
        source: "manual",
        sourceExternalId: getRelationshipDrawSourceExternalId(definition.category, date),
        createdAt: `${date}T00:00:00.000Z`,
        updatedAt: `${date}T00:00:00.000Z`,
      });
    }
    nextSettings = setRelationshipDrawProcessedDate(nextSettings, definition, date);
  }
  return { taskInputs, settings: nextSettings };
};
