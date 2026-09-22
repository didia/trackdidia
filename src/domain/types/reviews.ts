import type { DailyStatus } from "./daily";

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
  /**
   * Sunday the objective first counts. Null means a pre-existing row that
   * applies to every week.
   */
  startsOnWeekStartDate: string | null;
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
