import type { RecurringTaskTemplate } from "../../../../domain/types";

export interface RecurringTemplateRow {
  id: string;
  title: string;
  notes: string;
  target_bucket: "next_action" | "scheduled";
  context_ids_json: string;
  project_id: string | null;
  rule_type: "daily" | "weekly" | "monthly";
  daily_interval: number;
  weekly_interval: number;
  weekly_days_json: string;
  monthly_mode: "day_of_month" | "nth_weekday";
  day_of_month: number | null;
  nth_week: number | null;
  weekday: number | null;
  scheduled_time: string | null;
  start_date: string;
  status: "active" | "paused" | "cancelled";
  last_generated_for_date: string | null;
  pending_missed_occurrences: number;
  status_changed_at: string;
  created_at: string;
  updated_at: string;
}
export const COLUMNS =
  "id, title, notes, target_bucket, context_ids_json, project_id, rule_type, daily_interval, weekly_interval, weekly_days_json, monthly_mode, day_of_month, nth_week, weekday, scheduled_time, start_date, status, last_generated_for_date, pending_missed_occurrences, status_changed_at, created_at, updated_at";
export const fromRow = (row: RecurringTemplateRow): RecurringTaskTemplate => {
  return {
    id: row.id,
    title: row.title,
    notes: row.notes,
    targetBucket: row.target_bucket,
    contextIds: JSON.parse(row.context_ids_json),
    projectId: row.project_id,
    ruleType: row.rule_type,
    dailyInterval: Number(row.daily_interval),
    weeklyInterval: Number(row.weekly_interval),
    weeklyDays: JSON.parse(row.weekly_days_json),
    monthlyMode: row.monthly_mode,
    dayOfMonth: row.day_of_month === null ? null : Number(row.day_of_month),
    nthWeek: row.nth_week === null ? null : Number(row.nth_week),
    weekday: row.weekday === null ? null : Number(row.weekday),
    scheduledTime: row.scheduled_time,
    startDate: row.start_date,
    status: row.status,
    lastGeneratedForDate: row.last_generated_for_date,
    pendingMissedOccurrences: Number(row.pending_missed_occurrences ?? 0),
    statusChangedAt: row.status_changed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};
export const toParams = (entity: RecurringTaskTemplate): unknown[] => [
  entity.id,
  entity.title,
  entity.notes,
  entity.targetBucket,
  JSON.stringify(entity.contextIds),
  entity.projectId,
  entity.ruleType,
  entity.dailyInterval,
  entity.weeklyInterval,
  JSON.stringify(entity.weeklyDays),
  entity.monthlyMode,
  entity.dayOfMonth,
  entity.nthWeek,
  entity.weekday,
  entity.scheduledTime,
  entity.startDate,
  entity.status,
  entity.lastGeneratedForDate,
  entity.pendingMissedOccurrences,
  entity.statusChangedAt,
  entity.createdAt,
  entity.updatedAt,
];
