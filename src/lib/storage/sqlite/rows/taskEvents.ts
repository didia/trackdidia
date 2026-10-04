import type { TaskEvent } from "../../../../domain/types";

export interface TaskEventRow {
  id: string;
  task_id: string;
  type: TaskEvent["type"];
  event_date: string;
  event_at: string;
  created_at: string;
  dedupe_key: string | null;
  metadata_json: string;
}
export const COLUMNS =
  "id, task_id, type, event_date, event_at, created_at, dedupe_key, metadata_json";
export const fromRow = (row: TaskEventRow): TaskEvent => {
  return {
    id: row.id,
    taskId: row.task_id,
    type: row.type,
    eventDate: row.event_date,
    eventAt: row.event_at,
    createdAt: row.created_at,
    dedupeKey: row.dedupe_key,
    metadata: JSON.parse(row.metadata_json),
  };
};
export const toParams = (entity: TaskEvent): unknown[] => [
  entity.id,
  entity.taskId,
  entity.type,
  entity.eventDate,
  entity.eventAt,
  entity.createdAt,
  entity.dedupeKey,
  JSON.stringify(entity.metadata),
];
