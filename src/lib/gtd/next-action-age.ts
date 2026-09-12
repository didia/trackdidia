import type { Task, TaskEvent } from "../../domain/types";
import { toLocalDateString } from "./shared";

const MS_PER_LOCAL_DAY = 86_400_000;

export const daysBetweenLocalDates = (fromDate: string, toDate: string): number => {
  const from = new Date(`${fromDate}T12:00:00`).getTime();
  const to = new Date(`${toDate}T12:00:00`).getTime();
  return Math.max(0, Math.round((to - from) / MS_PER_LOCAL_DAY));
};

export const latestNextActionEnteredAt = (events: TaskEvent[], taskId: string): string | null => {
  const matches = events.filter(
    (event) => event.taskId === taskId && event.type === "task_moved_to_next_action",
  );
  if (matches.length === 0) {
    return null;
  }

  return matches.reduce((latest, event) => (event.eventAt > latest.eventAt ? event : latest))
    .eventAt;
};

export const nextActionAgeDays = (
  task: Pick<Task, "id" | "createdAt">,
  events: TaskEvent[],
  today: string,
): number => {
  const enteredAt = latestNextActionEnteredAt(events, task.id) ?? task.createdAt;
  return daysBetweenLocalDates(toLocalDateString(enteredAt), today);
};
