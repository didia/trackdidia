import type { PomodoroSession } from "../../../../domain/types";

export interface PomodoroSessionRow {
  id: string;
  kind: PomodoroSession["kind"];
  status: PomodoroSession["status"];
  started_at: string;
  ends_at: string;
  paused_remaining_ms: number | null;
  completed_at: string | null;
  cancelled_at: string | null;
  cycle_index: number;
  date: string;
}
export const COLUMNS =
  "id, kind, status, started_at, ends_at, paused_remaining_ms, completed_at, cancelled_at, cycle_index, date";
export const fromRow = (row: PomodoroSessionRow): PomodoroSession => {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    startedAt: row.started_at,
    endsAt: row.ends_at,
    pausedRemainingMs: row.paused_remaining_ms === null ? null : Number(row.paused_remaining_ms),
    completedAt: row.completed_at,
    cancelledAt: row.cancelled_at,
    cycleIndex: Number(row.cycle_index),
    date: row.date,
  };
};
export const toParams = (entity: PomodoroSession): unknown[] => [
  entity.id,
  entity.kind,
  entity.status,
  entity.startedAt,
  entity.endsAt,
  entity.pausedRemainingMs,
  entity.completedAt,
  entity.cancelledAt,
  entity.cycleIndex,
  entity.date,
];
