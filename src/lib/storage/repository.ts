import type {
  AppSettings,
  CreateTaskInput,
  DailyEntry,
  DailyTaskStats,
  GtdImportSummary,
  Project,
  ProjectFilters,
  Task,
  TaskContext,
  TaskFilters
} from "../../domain/types";

export interface StorageInfo {
  databasePath: string;
  backupDir: string;
}

export interface BackupResult {
  backupPath: string;
  createdAt: string;
}

export interface DailyTaskBreakdown {
  date: string;
  addedTasks: Task[];
  completedTasks: Task[];
}

export interface AppRepository {
  initialize(): Promise<void>;
  getDailyEntry(date: string): Promise<DailyEntry | null>;
  saveDailyEntry(entry: DailyEntry): Promise<void>;
  listDailyEntries(limit?: number): Promise<DailyEntry[]>;
  getSettings(): Promise<AppSettings>;
  saveSettings(settings: AppSettings): Promise<void>;
  getStorageInfo(): Promise<StorageInfo | null>;
  createBackup(kind?: "manual" | "auto"): Promise<BackupResult>;
  importGoogleTasksExport(rawJson: unknown): Promise<GtdImportSummary>;
  getGtdOverview(): Promise<{ taskCount: number; projectCount: number; contextCount: number }>;
  moveTasksWithContextToBucket(contextId: string, bucket: Task["bucket"]): Promise<number>;
  moveTasksWithScheduledDatesToBucket(bucket: Task["bucket"]): Promise<number>;
  collapseGoogleRecurringTasks(rawJson: unknown): Promise<number>;
  listContexts(): Promise<TaskContext[]>;
  listProjects(filters?: ProjectFilters): Promise<Project[]>;
  saveProject(project: Project): Promise<Project>;
  listTasks(filters?: TaskFilters): Promise<Task[]>;
  createTask(input: CreateTaskInput): Promise<Task>;
  saveTask(task: Task): Promise<Task>;
  moveTask(taskId: string, bucket: Task["bucket"], contextIds: string[], projectId?: string | null): Promise<Task>;
  scheduleTask(taskId: string, scheduledFor: string | null): Promise<Task>;
  completeTask(taskId: string, completedAt?: string): Promise<Task>;
  cancelTask(taskId: string): Promise<Task>;
  clearPastRecurrences(taskId: string): Promise<Task>;
  computeDailyTaskStats(date: string): Promise<DailyTaskStats>;
  getDailyTaskBreakdown(date: string): Promise<DailyTaskBreakdown>;
  applyWeeklyCarryover(weekStartDate: string): Promise<number>;
}
