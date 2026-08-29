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
  calorieExpenditure: number;
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
  calorieAverage: number;
  physicalActivity: number;
  productivityPulse: number | null;
  rescueTimeGoalsScore: number | null;
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

export type WeeklyObjectiveKind = "time" | "manual";

export type RescueTimeTaxonomy = "overview" | "category" | "activity" | "productivity";

export interface WeeklyObjective {
  id: string;
  title: string;
  kind: WeeklyObjectiveKind;
  targetHours: number | null;
  rescuetimeKind: RescueTimeTaxonomy | null;
  rescuetimeThing: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface WeeklyObjectiveResult {
  weekStartDate: string;
  objectiveId: string;
  achieved: boolean;
  updatedAt: string;
}

export type WeeklyObjectiveItemSource = "rescuetime" | "manual" | "missing";

export interface WeeklyObjectiveItemSnapshot {
  objective: WeeklyObjective;
  actualHours: number | null;
  achievement: number;
  source: WeeklyObjectiveItemSource;
  error?: string;
}

export interface WeeklyObjectivesSnapshot {
  weekStartDate: string;
  weekEndDate: string;
  items: WeeklyObjectiveItemSnapshot[];
  totalAchievement: number;
  score: number | null;
  rescuetimeConfigured: boolean;
  fetchError?: string;
}

export interface RescueTimeTaxonomyEntry {
  name: string;
  seconds: number;
  hours: number;
}

export type AiPayloadScope = "metrics" | "metrics_and_structure" | "full";

export type AiSurface = "coach_pulse" | "weekly_synthesis" | "monthly_synthesis" | "goal_pacing";

export type CoachPulseStance = "open" | "steer" | "wind_down" | "close";

export type AiMessageStatus = "ok" | "fallback" | "error" | "skipped";

export type AiDeltaClass = "progress" | "stall" | "unknown" | "idle";

export type MemoryKind = "pattern" | "preference" | "context" | "commitment" | "principle";

export type AiProposalType =
  | "intention_draft"
  | "tomorrow_focus_draft"
  | "memory"
  | "commitment"
  | "review_section_draft"
  | "weekly_objective"
  | "gtd_action"
  | "goal_evaluation";

export type WeeklySynthesisGtdAction = "schedule" | "defer" | "delegate" | "drop";

export type AiMemoryStatus = "active" | "archived" | "contradicted";

export type AiMemorySource = "ai_extracted" | "user_pinned" | "derived";

export interface AiMemory {
  id: string;
  kind: MemoryKind;
  statement: string;
  detail: string;
  confidence: number;
  source: AiMemorySource;
  status: AiMemoryStatus;
  evidenceFrom: string | null;
  evidenceTo: string | null;
  createdAt: string;
  lastConfirmedAt: string;
  expiresAt: string | null;
  pinned: boolean;
}

export interface AiMemoryFilters {
  status?: AiMemoryStatus | AiMemoryStatus[];
  kind?: MemoryKind | MemoryKind[];
  pinned?: boolean;
  /** Include active commitments expiring on or after this local date. */
  activeOnDate?: string;
}

export type AiProposalStatus = "pending" | "accepted" | "dismissed" | "expired";

export interface CoachPulseMove {
  what: string;
  why: string;
  horizon: "now" | "today" | "tomorrow";
}

export interface CoachPulsePriority {
  taskId: string | null;
  title: string;
  why: string;
}

export interface CoachPulseCommitmentCheck {
  commitment: string;
  progress: string;
  question: string;
}

export interface CoachPulseFrictionPoint {
  what: string;
  why: string;
  adjustment: string;
}

export interface CoachPulseCommitment {
  statement: string;
  metricKey: MetricKey | null;
  target: number | null;
}

export interface CoachPulseMemoryCandidate {
  kind: MemoryKind;
  statement: string;
  confidence: number;
}

export interface CoachPulseResponse {
  stance: CoachPulseStance;
  headline: string;
  read: string;
  move: CoachPulseMove | null;
  priorities?: CoachPulsePriority[];
  intentionDraft?: string;
  commitmentCheck?: CoachPulseCommitmentCheck | null;
  wins?: string[];
  frictionPoint?: CoachPulseFrictionPoint;
  principleToRecover?: PrincipleKey | null;
  tomorrowFocusDraft?: string;
  commitment?: CoachPulseCommitment | null;
  memoryCandidates?: CoachPulseMemoryCandidate[];
}

export interface AiMessage {
  id: string;
  surface: AiSurface;
  scopeKey: string;
  stance: CoachPulseStance | null;
  kind: string;
  inputHash: string;
  promptVersion: string;
  model: string;
  status: AiMessageStatus;
  bodyJson: string | null;
  bodyText: string | null;
  deltaClass: AiDeltaClass | null;
  notified: boolean;
  tokensPrompt: number | null;
  tokensCompletion: number | null;
  latencyMs: number | null;
  createdAt: string;
}

export interface AiProposal {
  id: string;
  messageId: string;
  type: AiProposalType;
  payloadJson: string;
  status: AiProposalStatus;
  appliedEntityId: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export interface AiUsageSummary {
  monthKey: string;
  callCount: number;
  tokensPrompt: number;
  tokensCompletion: number;
  tokensTotal: number;
  /** Approximate USD; actual OpenRouter pricing varies by model. */
  estimatedCostUsd: number;
}

export interface CoachPulseResult {
  message: AiMessage;
  pulse: CoachPulseResponse;
  proposals: AiProposal[];
  source: "ai" | "local" | "fallback" | "cache";
  warning?: string;
}

export interface WeeklySynthesisObjectiveDraft {
  title: string;
  kind: WeeklyObjectiveKind;
  targetHours: number | null;
  rescuetimeKind: RescueTimeTaxonomy | null;
  rescuetimeThing: string | null;
}

export interface WeeklySynthesisGtdActionDraft {
  taskId: string;
  action: WeeklySynthesisGtdAction;
  reason: string;
}

export interface WeeklySynthesisResponse {
  headline: string;
  scoreExplanation: string;
  strongestAxis: string;
  weakestAxes: string[];
  sectionDrafts: Partial<Record<WeeklyRitualSectionKey, string>>;
  nextWeekObjectives: WeeklySynthesisObjectiveDraft[];
  gtdActions: WeeklySynthesisGtdActionDraft[];
}

export interface WeeklySynthesisResult {
  message: AiMessage;
  synthesis: WeeklySynthesisResponse;
  proposals: AiProposal[];
  source: "ai" | "local" | "fallback" | "cache";
  warning?: string;
}

export interface MonthlySynthesisGoalEvaluationDraft {
  goalId: string;
  score: number | null;
  trend: AnnualGoalTrend | null;
  notes: string;
  blockers: string;
}

export interface MonthlySynthesisResponse {
  headline: string;
  weekPattern: string;
  sectionDrafts: Partial<Record<MonthlyReviewSectionKey, string>>;
  goalEvaluationDrafts: MonthlySynthesisGoalEvaluationDraft[];
}

export interface MonthlySynthesisResult {
  message: AiMessage;
  synthesis: MonthlySynthesisResponse;
  proposals: AiProposal[];
  source: "ai" | "local" | "fallback" | "cache";
  warning?: string;
}

export type GoalPacingRiskLevel = "low" | "medium" | "high";

export interface GoalPacingItem {
  goalId: string;
  onPace: boolean;
  gap: string;
  requiredWeeklyBehaviour: string;
  riskLevel: GoalPacingRiskLevel;
  recommendation: string;
}

export interface GoalPacingResponse {
  goals: GoalPacingItem[];
}

export interface GoalPacingResult {
  message: AiMessage;
  pacing: GoalPacingResponse;
  source: "ai" | "local" | "fallback" | "cache";
  warning?: string;
}

export interface AppSettings {
  language: "fr";
  storageMode: "sqlite";
  aiEnabled: boolean;
  aiApiKey: string;
  aiBaseUrl: string;
  aiModel: string;
  aiPayloadScope: AiPayloadScope;
  aiSurfaceModels: Partial<Record<AiSurface, string>>;
  aiMaxTokens: number;
  aiTimeoutMs: number;
  aiMemoryEnabled: boolean;
  aiPulseEnabled: boolean;
  aiPulseSlots: number[];
  aiPulseNotifyEnabled: boolean;
  aiPulseNotifyDays: number[];
  aiPulseMaxNotificationsPerDay: number;
  /** Rough USD estimate per 1M tokens (prompt + completion combined). OpenRouter pricing varies by model. */
  aiCostPerMillionTokens: number;
  /** ISO timestamps keyed by local YYYY-MM-DD for first app open anchoring. */
  aiPulseFirstOpenAt: Record<string, string>;
  rescuetimeApiKey: string;
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
  previousDayReviewDoneDate: string;
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
export type PomodoroStatus = "running" | "paused" | "completed" | "cancelled";

export interface PomodoroSession {
  id: string;
  kind: PomodoroKind;
  status: PomodoroStatus;
  startedAt: string;
  endsAt: string;
  pausedRemainingMs: number | null;
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
