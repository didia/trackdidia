import type { Task } from "../../../../domain/types";

export interface TaskRow {
  id: string;
  title: string;
  notes: string;
  status: Task["status"];
  bucket: Task["bucket"];
  context_ids_json: string;
  project_id: string | null;
  parent_task_id: string | null;
  scheduled_for: string | null;
  deadline: string | null;
  recurring_template_id: string | null;
  recurrence_due_date: string | null;
  is_recurring_instance: number;
  completed_at: string | null;
  recurrence_group_id: string | null;
  pending_past_recurrences: number;
  planned_order: number | null;
  source: Task["source"];
  source_external_id: string | null;
  source_url: string | null;
  created_at: string;
  updated_at: string;
}
export const COLUMNS =
  "id, title, notes, status, bucket, context_ids_json, project_id, parent_task_id, scheduled_for, deadline, recurring_template_id, recurrence_due_date, is_recurring_instance, completed_at, recurrence_group_id, pending_past_recurrences, planned_order, source, source_external_id, source_url, created_at, updated_at";
export const fromRow = (row: TaskRow): Task => {
  return {
    id: row.id,
    title: row.title,
    notes: row.notes,
    status: row.status,
    bucket: row.bucket,
    contextIds: JSON.parse(row.context_ids_json),
    projectId: row.project_id,
    parentTaskId: row.parent_task_id,
    scheduledFor: row.scheduled_for,
    deadline: row.deadline,
    recurringTemplateId: row.recurring_template_id,
    recurrenceDueDate: row.recurrence_due_date,
    isRecurringInstance: Boolean(row.is_recurring_instance),
    completedAt: row.completed_at,
    recurrenceGroupId: row.recurrence_group_id,
    pendingPastRecurrences: Number(row.pending_past_recurrences ?? 0),
    plannedOrder:
      row.planned_order === null || row.planned_order === undefined
        ? null
        : Number(row.planned_order),
    source: row.source,
    sourceExternalId: row.source_external_id,
    sourceUrl: row.source_url ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};
export const toParams = (entity: Task): unknown[] => [
  entity.id,
  entity.title,
  entity.notes,
  entity.status,
  entity.bucket,
  JSON.stringify(entity.contextIds),
  entity.projectId,
  entity.parentTaskId,
  entity.scheduledFor,
  entity.deadline,
  entity.recurringTemplateId,
  entity.recurrenceDueDate,
  entity.isRecurringInstance ? 1 : 0,
  entity.completedAt,
  entity.recurrenceGroupId,
  entity.pendingPastRecurrences,
  entity.plannedOrder,
  entity.source,
  entity.sourceExternalId,
  entity.sourceUrl,
  entity.createdAt,
  entity.updatedAt,
];

const placeholders = COLUMNS.split(", ")
  .map((_, index) => `$${index + 1}`)
  .join(", ");

export const insertSql = (conflict: "update" | "ignore") =>
  `INSERT INTO gtd_tasks (${COLUMNS}) VALUES (${placeholders}) ON CONFLICT(id) ${
    conflict === "ignore"
      ? "DO NOTHING"
      : `DO UPDATE SET
        title = excluded.title,
        notes = excluded.notes,
        status = excluded.status,
        bucket = excluded.bucket,
        context_ids_json = excluded.context_ids_json,
        project_id = excluded.project_id,
        parent_task_id = excluded.parent_task_id,
        scheduled_for = excluded.scheduled_for,
        deadline = excluded.deadline,
        recurring_template_id = excluded.recurring_template_id,
        recurrence_due_date = excluded.recurrence_due_date,
        is_recurring_instance = excluded.is_recurring_instance,
        completed_at = excluded.completed_at,
        recurrence_group_id = excluded.recurrence_group_id,
        pending_past_recurrences = excluded.pending_past_recurrences,
        planned_order = excluded.planned_order,
        source = excluded.source,
        source_external_id = excluded.source_external_id,
        source_url = excluded.source_url,
        updated_at = excluded.updated_at`
  }`;
