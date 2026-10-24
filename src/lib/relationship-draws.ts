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

/** The seed of a draw: the category and the local date it is drawn for. */
export const getRelationshipDrawSeed = (category: RelationshipDrawCategory, date: string): string =>
  `${category}:${date}`;

/**
 * FNV-1a over the UTF-16 code units of `text`: a 32-bit hash that is the same on every machine and
 * every JavaScript engine.
 */
const hashSeed = (text: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

/**
 * The first output of mulberry32 seeded with {@link hashSeed}, as a number in [0, 1). A pure function
 * of the seed text.
 */
export const seededUnit = (seed: string): number => {
  let t = (hashSeed(seed) + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

/**
 * The activity drawn for a category on a date. DETERMINISTIC on purpose: the same list, category and
 * date give the same activity on every laptop, so two personal laptops that draw the same day while
 * offline create the identical task (see `buildRelationshipDrawTaskId`) and merging them is a
 * no-op. The draw is a stable pseudo-random pick, `floor(seededUnit("<category>:<date>") * n)`, so
 * the choice still varies from day to day and between the two categories.
 */
export const pickRelationshipDrawActivity = (
  activities: string[],
  category: RelationshipDrawCategory,
  date: string,
): string | null => {
  if (activities.length === 0) {
    return null;
  }

  const index = Math.floor(seededUnit(getRelationshipDrawSeed(category, date)) * activities.length);
  return activities[index] ?? null;
};

/**
 * The task id of a draw, derived from its `source_external_id` so that two laptops mint the same id
 * (`task:relationship-draw:children:2026-10-03`). Draws made before this change keep their random
 * `task:<uuid>` ids; when such a draw meets a deterministic one for the same day, the two collide on
 * `source_external_id` and canonical identity merges them (`apply-aliases.ts`).
 */
export const buildRelationshipDrawTaskId = (
  category: RelationshipDrawCategory,
  date: string,
): string => `task:${getRelationshipDrawSourceExternalId(category, date)}`;

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
    const sourceExternalId = getRelationshipDrawSourceExternalId(definition.category, date);
    // A task for this very draw already exists (any status: a completed one too): the day was drawn
    // before, so it is marked processed without creating a second row under the same id.
    const alreadyDrawn = tasks.some(
      (task) =>
        task.sourceExternalId === sourceExternalId ||
        task.id === buildRelationshipDrawTaskId(definition.category, date),
    );
    if (!alreadyDrawn && !findActiveRelationshipDrawTask(tasks, definition.category)) {
      const activity = pickRelationshipDrawActivity(
        getRelationshipDrawActivities(nextSettings, definition),
        definition.category,
        date,
      );
      if (!activity) continue;
      taskInputs.push({
        id: buildRelationshipDrawTaskId(definition.category, date),
        title: buildRelationshipDrawTaskTitle(definition, activity),
        notes: definition.notes,
        bucket: "next_action",
        contextIds: [relationshipPersonalContextId],
        source: "manual",
        sourceExternalId,
        createdAt: `${date}T00:00:00.000Z`,
        updatedAt: `${date}T00:00:00.000Z`,
      });
    }
    nextSettings = setRelationshipDrawProcessedDate(nextSettings, definition, date);
  }
  return { taskInputs, settings: nextSettings };
};
