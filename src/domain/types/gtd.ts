export type TaskStatus = "active" | "completed" | "cancelled";
export type TaskBucket =
  | "inbox"
  | "next_action"
  | "scheduled"
  | "waiting_for"
  | "someday_maybe"
  | "reference"
  | "planned";
export type ProjectStatus = "active" | "on_hold" | "completed" | "cancelled";
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
  plannedOrder: number | null;
  source: "manual" | "google_import" | "email_triage";
  sourceExternalId: string | null;
  sourceUrl: string | null;
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

export interface TaskFilters {
  bucket?: TaskBucket | TaskBucket[];
  status?: TaskStatus;
  includeCompleted?: boolean;
  scheduledForDate?: string;
  contextId?: string;
  projectId?: string;
  search?: string;
}

export interface TaskEventFilters {
  types?: TaskEventType[];
}

export interface ProjectFilters {
  status?: ProjectStatus;
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
  source?: "manual" | "google_import" | "email_triage";
  sourceExternalId?: string | null;
  sourceUrl?: string | null;
  createdAt?: string;
  updatedAt?: string;
  id?: string;
}

export interface GtdImportSummary {
  importedTasks: number;
  importedProjects: number;
  importedContexts: number;
  skippedCompletedTasks: number;
}
