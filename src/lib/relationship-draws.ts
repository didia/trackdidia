import type { AppSettings, Task } from "../domain/types";
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

export const relationshipPersonalContextName = "Personnel";
export const relationshipPersonalContextId = buildContextId(relationshipPersonalContextName);

export const defaultChildrenActivities = [
  "Lire une histoire ensemble",
  "Dessin libre sur une feuille blanche",
  "Danser sur une chanson",
  "Chasse au tresor dans la maison",
  "Faire un puzzle ensemble",
  "Construire une cabane avec coussins",
  "Promenade autour du quartier",
  "Jeu de memoire ou cartes",
  "Colorier ensemble",
  "Faire semblant (magasin, docteur, etc.)",
  "Ecouter de la musique et deviner le style",
  "Faire une mini seance de yoga",
  "Demander son moment prefere de la journee",
  "Faire des bulles",
  "Construire quelque chose avec LEGO",
  "Cuisiner quelque chose de simple",
  "Jeu qui suis-je",
  "Regarder un petit livre illustre ensemble",
  "Faire un parcours avec coussins et chaises",
  "Calins et discussion avant dodo"
] as const;

export const defaultSpouseActivities = [
  "Promenade ensemble apres le souper",
  "Massage de 5 minutes",
  "Danser dans le salon",
  "Discussion meilleur moment de la journee",
  "Regarder une video drole ensemble",
  "Boire un the ou un cafe ensemble",
  "Dire 3 choses que tu apprecies",
  "Preparer une collation ensemble",
  "Envoyer un message d'amour dans la journee",
  "Mini soiree cinema",
  "Ecouter une chanson souvenir",
  "Planifier un projet futur",
  "Apporter une surprise simple",
  "Cuisiner ensemble un petit plat",
  "Discussion sans telephone pendant 15 min",
  "Regarder un album photo",
  "Se faire un massage des mains",
  "Jeu rapide ensemble",
  "Rire ensemble d'un souvenir drole",
  "Dire je t'aime et faire un calin"
] as const;

export const relationshipDrawDefinitions: RelationshipDrawDefinition[] = [
  {
    category: "children",
    label: "Avec enfants",
    titlePrefix: "Avec enfants:",
    notes: "Tirage quotidien relationnel genere automatiquement pour passer un moment avec les enfants.",
    settingsKey: "relationshipDrawChildrenActivities",
    processedDateKey: "relationshipDrawChildrenProcessedDate"
  },
  {
    category: "spouse",
    label: "Avec mon epouse",
    titlePrefix: "Avec mon epouse:",
    notes: "Tirage quotidien relationnel genere automatiquement pour nourrir la relation avec ton epouse.",
    settingsKey: "relationshipDrawSpouseActivities",
    processedDateKey: "relationshipDrawSpouseProcessedDate"
  }
] as const;

export const mergeAppSettingsWithDefaults = (settings: Partial<AppSettings>, defaults: AppSettings): AppSettings => ({
  ...defaults,
  ...settings,
  relationshipDrawChildrenActivities:
    Array.isArray(settings.relationshipDrawChildrenActivities)
      ? settings.relationshipDrawChildrenActivities
      : defaults.relationshipDrawChildrenActivities,
  relationshipDrawSpouseActivities:
    Array.isArray(settings.relationshipDrawSpouseActivities)
      ? settings.relationshipDrawSpouseActivities
      : defaults.relationshipDrawSpouseActivities
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
