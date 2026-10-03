import { t } from "../i18n";
import { atLocalNoon } from "../lib/date";
import { addDays, getWeekStartSunday } from "../lib/date";
import { defaultChildrenActivities, defaultSpouseActivities } from "../lib/relationship-draws";
import { metricDefinitions, principleDefinitions } from "./definitions";
import type {
  AppSettings,
  DailyEntry,
  DailyMetrics,
  DailyPomodoroStats,
  DailyStatus,
  DailyTaskStats,
  MetricKey,
  PrincipleChecks,
  PrincipleKey,
} from "./types";

export const gtdMetricKeys = [
  "tachesDebut",
  "tachesFin",
  "tachesAjoutes",
  "tachesRealises",
] as const;
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
  tachesRealises: null,
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
  objectifsAtteints: null,
});

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

export const createEmptyDailyEntry = (date: string): DailyEntry => ({
  date,
  status: "not_started",
  metrics: emptyMetrics(),
  principleChecks: emptyPrinciples(),
  morningIntention: "",
  nightReflection: "",
  tomorrowFocus: "",
  updatedAt: new Date().toISOString(),
});

export const cloneEntry = (entry: DailyEntry): DailyEntry => ({
  ...entry,
  metrics: { ...entry.metrics },
  suggestedMetrics: entry.suggestedMetrics ? { ...entry.suggestedMetrics } : undefined,
  principleChecks: { ...entry.principleChecks },
});

export const updateMetric = (
  entry: DailyEntry,
  key: MetricKey,
  value: number | null,
): DailyEntry => ({
  ...cloneEntry(entry),
  metrics: {
    ...entry.metrics,
    [key]: value,
  },
  updatedAt: new Date().toISOString(),
});

export const updatePrinciple = (
  entry: DailyEntry,
  key: PrincipleKey,
  value: boolean | null,
): DailyEntry => ({
  ...cloneEntry(entry),
  principleChecks: {
    ...entry.principleChecks,
    [key]: value,
  },
  updatedAt: new Date().toISOString(),
});

export const updateNote = (
  entry: DailyEntry,
  key: "morningIntention" | "nightReflection" | "tomorrowFocus",
  value: string,
): DailyEntry => ({
  ...cloneEntry(entry),
  [key]: value,
  updatedAt: new Date().toISOString(),
});

/** Copies yesterday's tomorrow-focus into an empty morning intention. No-op otherwise. */
export const prefillMorningIntentionFromYesterday = (
  entry: DailyEntry,
  yesterday: DailyEntry | null,
): DailyEntry => {
  const carriedFocus = yesterday?.tomorrowFocus.trim() ?? "";
  if (entry.morningIntention.trim() || !carriedFocus) {
    return entry;
  }

  // In-memory only: keep the prior updatedAt until a real user mutation/save.
  return {
    ...cloneEntry(entry),
    morningIntention: carriedFocus,
  };
};

/**
 * Discipline score for one day, computed over only the principles that have actually been
 * answered (`true` or `false`) rather than over every principle (contrast with the
 * all-principles denominator `computeDisciplineScore` uses elsewhere, e.g. for the day's
 * completion percentage). An in-progress day — say, this morning, with only the
 * morning/anytime principles logged so far — otherwise looks identical to a day where every
 * still-unanswered principle was explicitly failed, and a partially-answered day is then
 * structurally guaranteed to look like a collapse next to a baseline of fully-answered days,
 * no matter how the "is this day far enough along" threshold is set. Scoring over the
 * answered subset means a perfect partial day still scores `1.00`, and a day with nothing
 * answered yet naturally drops out (`null`, filtered by callers) instead of scoring `0`.
 */
export const computeAnsweredDisciplineScore = (entry: DailyEntry): number | null => {
  const answered = principleDefinitions.filter(({ key }) => entry.principleChecks[key] !== null);
  if (answered.length === 0) {
    return null;
  }

  const trueCount = answered.filter(({ key }) => entry.principleChecks[key] === true).length;
  return trueCount / answered.length;
};

export const computeDisciplineScore = (entry: DailyEntry): number => {
  if (principleDefinitions.length === 0) {
    return 0;
  }

  const completed = principleDefinitions.filter(
    ({ key }) => entry.principleChecks[key] === true,
  ).length;
  return completed / principleDefinitions.length;
};

export const computeCompletionPercent = (entry: DailyEntry): number => {
  const metricCount = metricDefinitions.length;
  const principleCount = principleDefinitions.length;
  const noteCount = 3;

  const completedMetrics = metricDefinitions.filter(
    ({ key }) => entry.metrics[key] !== null,
  ).length;
  const completedPrinciples = principleDefinitions.filter(
    ({ key }) => entry.principleChecks[key] !== null,
  ).length;
  const completedNotes = [
    entry.morningIntention,
    entry.nightReflection,
    entry.tomorrowFocus,
  ].filter((value) => value.trim().length > 0).length;

  return (
    (completedMetrics + completedPrinciples + completedNotes) /
    (metricCount + principleCount + noteCount)
  );
};

const daysRemainingInWeekInclusive = (date: string): number => {
  const weekStart = getWeekStartSunday(date);
  const weekEnd = addDays(weekStart, 6);
  const startMs = atLocalNoon(date).getTime();
  const endMs = atLocalNoon(weekEnd).getTime();
  return Math.round((endMs - startMs) / 86400000) + 1;
};

export const computeTaskCompletionPercent = (entry: DailyEntry): number => {
  const tasksAtStart = resolveMetricValue(entry, "tachesDebut") ?? 0;
  const tasksAdded = resolveMetricValue(entry, "tachesAjoutes") ?? 0;
  const tasksCompleted = resolveMetricValue(entry, "tachesRealises") ?? 0;

  const totalAtRisk = tasksAtStart + tasksAdded;
  if (totalAtRisk <= 0) {
    return 0;
  }

  const daysRemaining = daysRemainingInWeekInclusive(entry.date);
  const expectedPerDay = totalAtRisk / Math.max(1, daysRemaining);

  return tasksCompleted / expectedPerDay;
};

export const deriveStatusLabel = (status: DailyStatus): string => {
  switch (status) {
    case "not_started":
      return t("status.notStarted", { ns: "common" });
    case "morning_done":
      return t("status.morningDone", { ns: "common" });
    case "closed":
      return t("status.closed", { ns: "common" });
  }
};

export const applyRoutineTransition = (
  entry: DailyEntry,
  action: "complete_morning" | "close_day" | "reopen_day",
): DailyEntry => {
  if (action === "complete_morning") {
    return {
      ...cloneEntry(entry),
      status: "morning_done",
      updatedAt: new Date().toISOString(),
    };
  }

  if (action === "close_day") {
    return {
      ...cloneEntry(entry),
      status: "closed",
      updatedAt: new Date().toISOString(),
    };
  }

  return {
    ...cloneEntry(entry),
    status: entry.morningIntention.trim() ? "morning_done" : "not_started",
    updatedAt: new Date().toISOString(),
  };
};

export const buildEntrySummary = (entry: DailyEntry) => ({
  disciplineScore: computeDisciplineScore(entry),
  taskCompletionPercent: computeTaskCompletionPercent(entry),
});

export const applyDailyTaskStats = (entry: DailyEntry, stats: DailyTaskStats): DailyEntry => ({
  ...cloneEntry(entry),
  suggestedMetrics: {
    ...(entry.suggestedMetrics ?? {}),
    tachesDebut: stats.tasksAtStart,
    tachesAjoutes: stats.tasksAdded,
    tachesRealises: stats.tasksCompleted,
    tachesFin: stats.tasksRemaining,
  },
});

export const applyDailyPomodoroStats = (
  entry: DailyEntry,
  stats: DailyPomodoroStats,
): DailyEntry => ({
  ...cloneEntry(entry),
  suggestedMetrics: {
    ...(entry.suggestedMetrics ?? {}),
    pomodoris: stats.completedFocusSessions,
  },
});

export const resolveMetricValue = (entry: DailyEntry, key: MetricKey): number | null =>
  entry.metrics[key] ?? entry.suggestedMetrics?.[key] ?? null;

export const findMissingMetricKeys = (entry: DailyEntry): MetricKey[] =>
  metricDefinitions
    .filter(({ key }) => resolveMetricValue(entry, key) === null)
    .map(({ key }) => key);

export const findUnansweredPrincipleKeys = (entry: DailyEntry): PrincipleKey[] =>
  principleDefinitions
    .filter(({ key }) => entry.principleChecks[key] === null)
    .map(({ key }) => key);
