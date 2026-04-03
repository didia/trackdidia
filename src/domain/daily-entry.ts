import { metricDefinitions, principleDefinitions } from "./definitions";
import type {
  AppSettings,
  DailyPomodoroStats,
  DailyEntry,
  DailyTaskStats,
  DailyMetrics,
  DailyStatus,
  MetricKey,
  PrincipleChecks,
  PrincipleKey
} from "./types";
import { defaultChildrenActivities, defaultSpouseActivities } from "../lib/relationship-draws";

export const gtdMetricKeys = ["tachesDebut", "tachesFin", "tachesAjoutes", "tachesRealises"] as const;
export const autoSuggestedMetricKeys = [...gtdMetricKeys, "pomodoris"] as const;

const emptyMetrics = (): DailyMetrics => ({
  course: null,
  marche: null,
  depenseCalorique: null,
  pushups: null,
  qualiteSommeil: null,
  tempsEcranTelephone: null,
  pomodoris: null,
  tachesDebut: null,
  tachesFin: null,
  tachesAjoutes: null,
  tachesRealises: null
});

const emptyPrinciples = (): PrincipleChecks => ({
  priereDuMatin: null,
  oxytocineDuMatin: null,
  avoirLuMesPrincipes: null,
  ecriture: null,
  apprentissage: null,
  managedSolitude: null,
  respectDeVieCommeJesus: null,
  retroJournalier: null,
  tempsDeQualiteAvecEnfants: null,
  priereDuSoir: null,
  attentionAMonEpouse: null,
  respectTrc: null,
  respectReveil: null,
  objectifsAtteints: null
});

export const defaultAppSettings = (): AppSettings => ({
  language: "fr",
  storageMode: "sqlite",
  aiEnabled: false,
  aiApiKey: "",
  aiBaseUrl: "https://api.openai.com/v1",
  aiModel: "gpt-4.1-mini",
  autoBackupEnabled: true,
  autoBackupIntervalHours: 24,
  lastBackupAt: "",
  lastBackupPath: "",
  gtdImportDoneAt: "",
  gtdReferencesMigrationDoneAt: "",
  gtdScheduledNormalizationDoneAt: "",
  gtdRecurringCollapseDoneAt: "",
  relationshipDrawsEnabled: true,
  relationshipDrawChildrenActivities: [...defaultChildrenActivities],
  relationshipDrawSpouseActivities: [...defaultSpouseActivities],
  relationshipDrawChildrenProcessedDate: "",
  relationshipDrawSpouseProcessedDate: ""
});

export const createEmptyDailyEntry = (date: string): DailyEntry => ({
  date,
  status: "not_started",
  metrics: emptyMetrics(),
  principleChecks: emptyPrinciples(),
  morningIntention: "",
  nightReflection: "",
  tomorrowFocus: "",
  updatedAt: new Date().toISOString()
});

export const cloneEntry = (entry: DailyEntry): DailyEntry => ({
  ...entry,
  metrics: { ...entry.metrics },
  suggestedMetrics: entry.suggestedMetrics ? { ...entry.suggestedMetrics } : undefined,
  principleChecks: { ...entry.principleChecks }
});

export const updateMetric = (entry: DailyEntry, key: MetricKey, value: number | null): DailyEntry => ({
  ...cloneEntry(entry),
  metrics: {
    ...entry.metrics,
    [key]: value
  },
  updatedAt: new Date().toISOString()
});

export const updatePrinciple = (entry: DailyEntry, key: PrincipleKey, value: boolean | null): DailyEntry => ({
  ...cloneEntry(entry),
  principleChecks: {
    ...entry.principleChecks,
    [key]: value
  },
  updatedAt: new Date().toISOString()
});

export const updateNote = (
  entry: DailyEntry,
  key: "morningIntention" | "nightReflection" | "tomorrowFocus",
  value: string
): DailyEntry => ({
  ...cloneEntry(entry),
  [key]: value,
  updatedAt: new Date().toISOString()
});

export const computeDisciplineScore = (entry: DailyEntry): number => {
  if (principleDefinitions.length === 0) {
    return 0;
  }

  const completed = principleDefinitions.filter(({ key }) => entry.principleChecks[key] === true).length;
  return completed / principleDefinitions.length;
};

export const computeCompletionPercent = (entry: DailyEntry): number => {
  const metricCount = metricDefinitions.length;
  const principleCount = principleDefinitions.length;
  const noteCount = 3;

  const completedMetrics = metricDefinitions.filter(({ key }) => entry.metrics[key] !== null).length;
  const completedPrinciples = principleDefinitions.filter(({ key }) => entry.principleChecks[key] !== null).length;
  const completedNotes = [entry.morningIntention, entry.nightReflection, entry.tomorrowFocus].filter(
    (value) => value.trim().length > 0
  ).length;

  return (completedMetrics + completedPrinciples + completedNotes) / (metricCount + principleCount + noteCount);
};

export const computeTaskCompletionPercent = (entry: DailyEntry): number => {
  const tasksAdded = resolveMetricValue(entry, "tachesAjoutes") ?? 0;
  const tasksCompleted = resolveMetricValue(entry, "tachesRealises") ?? 0;

  if (tasksAdded <= 0) {
    return 0;
  }

  return tasksCompleted / tasksAdded;
};

export const deriveStatusLabel = (status: DailyStatus): string => {
  switch (status) {
    case "not_started":
      return "A demarrer";
    case "morning_done":
      return "Matin complete";
    case "closed":
      return "Journee cloturee";
  }
};

export const applyRoutineTransition = (
  entry: DailyEntry,
  action: "complete_morning" | "close_day" | "reopen_day"
): DailyEntry => {
  if (action === "complete_morning") {
    return {
      ...cloneEntry(entry),
      status: "morning_done",
      updatedAt: new Date().toISOString()
    };
  }

  if (action === "close_day") {
    return {
      ...cloneEntry(entry),
      status: "closed",
      updatedAt: new Date().toISOString()
    };
  }

  return {
    ...cloneEntry(entry),
    status: entry.morningIntention.trim() ? "morning_done" : "not_started",
    updatedAt: new Date().toISOString()
  };
};

export const buildEntrySummary = (entry: DailyEntry) => ({
  disciplineScore: computeDisciplineScore(entry),
  taskCompletionPercent: computeTaskCompletionPercent(entry)
});

export const applyDailyTaskStats = (entry: DailyEntry, stats: DailyTaskStats): DailyEntry => ({
  ...cloneEntry(entry),
  suggestedMetrics: {
    ...(entry.suggestedMetrics ?? {}),
    tachesDebut: stats.tasksAtStart,
    tachesAjoutes: stats.tasksAdded,
    tachesRealises: stats.tasksCompleted,
    tachesFin: stats.tasksRemaining
  }
});

export const applyDailyPomodoroStats = (entry: DailyEntry, stats: DailyPomodoroStats): DailyEntry => ({
  ...cloneEntry(entry),
  suggestedMetrics: {
    ...(entry.suggestedMetrics ?? {}),
    pomodoris: stats.completedFocusSessions
  }
});

export const resolveMetricValue = (entry: DailyEntry, key: MetricKey): number | null =>
  entry.metrics[key] ?? entry.suggestedMetrics?.[key] ?? null;
