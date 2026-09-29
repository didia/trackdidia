import type { TaskBucket } from "./gtd";

export type RecurringTargetBucket = Extract<TaskBucket, "next_action" | "scheduled">;
export type RecurringRuleType = "daily" | "weekly" | "monthly";
export type RecurringMonthlyMode = "day_of_month" | "nth_weekday";
export type RecurringTemplateStatus = "active" | "paused" | "cancelled";
export type RecurringEditScope = "occurrence" | "series";

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

export interface RecurringTemplateFilters {
  status?: RecurringTemplateStatus;
  targetBucket?: RecurringTargetBucket;
  contextId?: string;
  projectId?: string;
  ruleType?: RecurringRuleType;
  search?: string;
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
