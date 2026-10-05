import type { PomodoroSegment } from "../../../../domain/types";

export interface PomodoroSegmentRow {
  id: string;
  session_id: string;
  task_id: string | null;
  title: string | null;
  started_at: string;
  ended_at: string | null;
}
export const COLUMNS = "id, session_id, task_id, title, started_at, ended_at";
export const fromRow = (row: PomodoroSegmentRow): PomodoroSegment => {
  return {
    id: row.id,
    sessionId: row.session_id,
    taskId: row.task_id,
    title: row.title,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
};
export const toParams = (entity: PomodoroSegment): unknown[] => [
  entity.id,
  entity.sessionId,
  entity.taskId,
  entity.title,
  entity.startedAt,
  entity.endedAt,
];
