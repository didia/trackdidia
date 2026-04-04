export type DailyStatus = "not_started" | "morning_done" | "closed";

export type MetricKey =
  | "course"
  | "marche"
  | "depenseCalorique"
  | "pushups"
  | "qualiteSommeil"
  | "tempsEcranTelephone"
  | "pomodoris"
  | "tachesDebut"
  | "tachesFin"
  | "tachesAjoutes"
  | "tachesRealises";

export type PrincipleKey =
  | "priereDuMatin"
  | "oxytocineDuMatin"
  | "avoirLuMesPrincipes"
  | "ecriture"
  | "apprentissage"
  | "managedSolitude"
  | "respectDeVieCommeJesus"
  | "retroJournalier"
  | "tempsDeQualiteAvecEnfants"
  | "priereDuSoir"
  | "attentionAMonEpouse"
  | "respectTrc"
  | "respectReveil"
  | "objectifsAtteints";

export type DailyMetrics = Record<MetricKey, number | null>;
export type PrincipleChecks = Record<PrincipleKey, boolean | null>;
export type SuggestedMetrics = Partial<Record<MetricKey, number | null>>;

export interface DailyEntry {
  date: string;
  status: DailyStatus;
  metrics: DailyMetrics;
  suggestedMetrics?: SuggestedMetrics;
  principleChecks: PrincipleChecks;
  morningIntention: string;
  nightReflection: string;
  tomorrowFocus: string;
  updatedAt: string;
}

export type WeeklyReviewStatus = "draft" | "closed";

export type WeeklyRitualSectionKey =
  | "bilan"
  | "budget"
  | "tempsEtPlan"
  | "collecte"
  | "calendrier"
  | "gtd"
  | "alignement"
  | "dimanche";

export type WeeklyRitualChecklist = Record<WeeklyRitualSectionKey, boolean>;
export type WeeklyReviewNotes = Record<WeeklyRitualSectionKey, string>;

export interface WeeklyReview {
  weekStartDate: string;
  weekEndDate: string;
  status: WeeklyReviewStatus;
  notes: WeeklyReviewNotes;
  ritualChecklist: WeeklyRitualChecklist;
  updatedAt: string;
}

export interface WeeklyReviewDaySummary {
  date: string;
  status: DailyStatus;
  sleepQuality: number | null;
  trcRespected: boolean;
  screenTimeMinutes: number;
  pomodoris: number;
  disciplineScore: number;
  tasksAdded: number;
  tasksCompleted: number;
}

export interface WeeklyReviewSummary {
  weekStartDate: string;
  weekEndDate: string;
  sleepAverage: number;
  sleepQuality: number;
  trcDaysRespected: number;
  respectTrc: number;
  screenTimeTotalMinutes: number;
  phoneScreenTime: number;
  pomodorisTotal: number;
  pomodoris: number;
  disciplineAverage: number;
  discipline: number;
  tasksAddedTotal: number;
  tasksCompletedTotal: number;
  tasksCompletionRate: number;
  weeklyScore: number;
  days: WeeklyReviewDaySummary[];
}

export type MonthlyReviewStatus = "draft" | "closed";

export type MonthlyReviewSectionKey =
  | "bilan"
  | "journaux"
  | "finances"
  | "temps"
  | "progressionObjectifs"
  | "missionObjectifs"
  | "nettoyageListes"
  | "calendrier"
  | "grosProjets"
  | "developpement";

export type MonthlyReviewChecklist = Record<MonthlyReviewSectionKey, boolean>;
export type MonthlyReviewNotes = Record<MonthlyReviewSectionKey, string>;

export interface MonthlyReview {
  monthKey: string;
  monthStartDate: string;
  monthEndDate: string;
  status: MonthlyReviewStatus;
  notes: MonthlyReviewNotes;
  ritualChecklist: MonthlyReviewChecklist;
  updatedAt: string;
}

export interface MonthlyReviewWeekSummary {
  weekStartDate: string;
  weekEndDate: string;
  weeklyScore: number;
  reviewStatus: WeeklyReviewStatus | "missing";
  noteCount: number;
}

export interface MonthlyReviewSummary {
  monthKey: string;
  monthStartDate: string;
  monthEndDate: string;
  daysTracked: number;
  weeksCovered: number;
  weeklyReviewsCompleted: number;
  sleepAverage: number;
  trcRate: number;
  screenTimeTotalMinutes: number;
  pomodorisTotal: number;
  disciplineAverage: number;
  tasksCompletionRate: number;
  weeklyScoreAverage: number;
  weeks: MonthlyReviewWeekSummary[];
}

export type AnnualGoalDimension = "physique" | "spirituelle" | "sociale" | "intellectuelle" | "global";
export type AnnualGoalTrend = "up" | "steady" | "down";
export type AnnualGoalSourceType = "weekly_summary" | "daily_metric" | "daily_principle" | "manual";

export type AnnualGoalSourceId =
  | "weekly_sleep_average"
  | "weekly_respect_trc"
  | "weekly_weekly_score"
  | "weekly_discipline"
  | "weekly_tasks_completion_rate"
  | "daily_depense_calorique_avg"
  | "daily_qualite_sommeil_avg"
  | "daily_temps_ecran_avg"
  | "daily_pomodoris_sum"
  | "daily_pomodoris_avg"
  | "daily_respect_trc_rate"
  | "daily_respect_reveil_rate"
  | "daily_priere_du_matin_rate"
  | "daily_priere_du_soir_rate"
  | "daily_objectifs_atteints_rate";

export interface AnnualGoalEvaluation {
  monthKey: string;
  score: number | null;
  trend: AnnualGoalTrend | null;
  notes: string;
  blockers: string;
}

export type AnnualGoalEvaluations = Record<string, AnnualGoalEvaluation>;

export interface AnnualGoal {
  id: string;
  title: string;
  dimension: AnnualGoalDimension;
  description: string;
  targetValue: number | null;
  unit: string;
  sourceId: AnnualGoalSourceId | null;
  manualCurrentValue: number | null;
  evaluations: AnnualGoalEvaluations;
  createdAt: string;
  updatedAt: string;
}

export interface AnnualGoalProgressPoint {
  monthKey: string;
  value: number | null;
}

export interface AnnualGoalSnapshot {
  goal: AnnualGoal;
  sourceType: AnnualGoalSourceType;
  sourceLabel: string | null;
  currentValue: number | null;
  progressRatio: number | null;
  monthlyProgress: AnnualGoalProgressPoint[];
  linkedWeeklyMetricLabels: string[];
  linkedDailyHabitLabels: string[];
}

export interface AppSettings {
  language: "fr";
  storageMode: "sqlite";
  aiEnabled: boolean;
  aiApiKey: string;
  aiBaseUrl: string;
  aiModel: string;
  autoBackupEnabled: boolean;
  autoBackupIntervalHours: number;
  lastBackupAt: string;
  lastBackupPath: string;
  gtdImportDoneAt: string;
  gtdReferencesMigrationDoneAt: string;
  gtdScheduledNormalizationDoneAt: string;
  gtdRecurringCollapseDoneAt: string;
  relationshipDrawsEnabled: boolean;
  relationshipDrawChildrenActivities: string[];
  relationshipDrawSpouseActivities: string[];
  relationshipDrawChildrenProcessedDate: string;
  relationshipDrawSpouseProcessedDate: string;
}

export interface CoachMessage {
  kind: "morning" | "evening";
  title: string;
  body: string;
  source: "local" | "ai" | "fallback";
  warning?: string;
}

export type TaskStatus = "active" | "completed" | "cancelled";
export type TaskBucket = "inbox" | "next_action" | "scheduled" | "waiting_for" | "someday_maybe" | "reference";
export type ProjectStatus = "active" | "on_hold" | "completed" | "cancelled";
export type RecurringTargetBucket = Extract<TaskBucket, "next_action" | "scheduled">;
export type RecurringRuleType = "daily" | "weekly" | "monthly";
export type RecurringMonthlyMode = "day_of_month" | "nth_weekday";
export type RecurringTemplateStatus = "active" | "paused" | "cancelled";
export type RecurringEditScope = "occurrence" | "series";
export type TaskEventType =
  | "task_created"
  | "task_moved_to_next_action"
  | "task_scheduled_for_day"
  | "task_completed"
  | "weekly_carryover";

export interface TaskContext {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  title: string;
  status: ProjectStatus;
  statusChangedAt: string;
  notes: string;
  contextIds: string[];
  source: "manual" | "google_import";
  sourceExternalId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  title: string;
  notes: string;
  status: TaskStatus;
  bucket: TaskBucket;
  contextIds: string[];
  projectId: string | null;
  parentTaskId: string | null;
  scheduledFor: string | null;
  deadline: string | null;
  recurringTemplateId: string | null;
  recurrenceDueDate: string | null;
  isRecurringInstance: boolean;
  completedAt: string | null;
  recurrenceGroupId: string | null;
  pendingPastRecurrences: number;
  source: "manual" | "google_import";
  sourceExternalId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskEvent {
  id: string;
  taskId: string;
  type: TaskEventType;
  eventDate: string;
  eventAt: string;
  createdAt: string;
  dedupeKey: string | null;
  metadata: Record<string, string>;
}

export interface DailyTaskStats {
  date: string;
  tasksAtStart: number;
  tasksAdded: number;
  tasksCompleted: number;
  tasksRemaining: number;
}

export interface RecurringTaskTemplate {
  id: string;
  title: string;
  notes: string;
  targetBucket: RecurringTargetBucket;
  contextIds: string[];
  projectId: string | null;
  ruleType: RecurringRuleType;
  dailyInterval: number;
  weeklyInterval: number;
  weeklyDays: number[];
  monthlyMode: RecurringMonthlyMode;
  dayOfMonth: number | null;
  nthWeek: number | null;
  weekday: number | null;
  scheduledTime: string | null;
  startDate: string;
  status: RecurringTemplateStatus;
  lastGeneratedForDate: string | null;
  pendingMissedOccurrences: number;
  statusChangedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface RecurringPreviewOccurrence {
  id: string;
  templateId: string;
  title: string;
  notes: string;
  targetBucket: RecurringTargetBucket;
  contextIds: string[];
  projectId: string | null;
  dueDate: string;
  scheduledFor: string | null;
  scheduledTime: string | null;
  status: "future" | "overdue_preview";
}

export type PomodoroKind = "focus" | "short_break" | "long_break";
export type PomodoroStatus = "running" | "completed" | "cancelled";

export interface PomodoroSession {
  id: string;
  kind: PomodoroKind;
  status: PomodoroStatus;
  startedAt: string;
  endsAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
  cycleIndex: number;
  date: string;
}

export interface PomodoroSegment {
  id: string;
  sessionId: string;
  taskId: string | null;
  title: string | null;
  startedAt: string;
  endedAt: string | null;
}

export interface PomodoroSessionDetails extends PomodoroSession {
  segments: PomodoroSegment[];
  activeTaskId: string | null;
  activeLabel: string | null;
  taskIds: string[];
}

export interface PomodoroState {
  activeSession: PomodoroSessionDetails | null;
  nextSessionKind: PomodoroKind;
  completedFocusCountInCycle: number;
  nextFocusCycleIndex: number;
  currentCycleIndex: number;
}

export interface PomodoroTaskSummary {
  taskId: string | null;
  taskTitle: string;
  totalSeconds: number;
  sessionCount: number;
}

export interface DailyPomodoroStats {
  date: string;
  completedFocusSessions: number;
}

export interface TaskFilters {
  bucket?: TaskBucket | TaskBucket[];
  status?: TaskStatus;
  includeCompleted?: boolean;
  scheduledForDate?: string;
  contextId?: string;
  projectId?: string;
  search?: string;
}

export interface ProjectFilters {
  status?: ProjectStatus;
}

export interface RecurringTemplateFilters {
  status?: RecurringTemplateStatus;
  targetBucket?: RecurringTargetBucket;
  contextId?: string;
  projectId?: string;
  ruleType?: RecurringRuleType;
  search?: string;
}

export interface CreateTaskInput {
  title: string;
  notes?: string;
  bucket?: TaskBucket;
  contextIds?: string[];
  projectId?: string | null;
  parentTaskId?: string | null;
  scheduledFor?: string | null;
  deadline?: string | null;
  recurringTemplateId?: string | null;
  recurrenceDueDate?: string | null;
  isRecurringInstance?: boolean;
  source?: "manual" | "google_import";
  sourceExternalId?: string | null;
  createdAt?: string;
  updatedAt?: string;
  id?: string;
}

export interface RecurringTaskChanges {
  title?: string;
  notes?: string;
  bucket?: RecurringTargetBucket;
  contextIds?: string[];
  projectId?: string | null;
  scheduledFor?: string | null;
  deadline?: string | null;
}

export interface GtdImportSummary {
  importedTasks: number;
  importedProjects: number;
  importedContexts: number;
  skippedCompletedTasks: number;
}
