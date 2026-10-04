import { applyDailyPomodoroStats, applyDailyTaskStats, cloneEntry } from "../../domain/daily-entry";
import type { DailyEntry, PomodoroSession, Task, TaskEvent } from "../../domain/types";
import { buildDailyTaskStats } from "../gtd/engine";
import { computeDailyPomodoroStats } from "../pomodoro/engine";

export interface DailyEntryDecorationSource {
  tasks: Task[];
  events: TaskEvent[];
  sessions: PomodoroSession[];
}

/**
 * Pure, side-effect-free decoration shared by both repositories. Applies suggested GTD and
 * Pomodoro metrics derived from an already-loaded snapshot, so a list read loads the snapshot
 * once instead of per entry. Explicit metric values still win through `resolveMetricValue`.
 */
export const decorateDailyEntries = (
  entries: DailyEntry[],
  source: DailyEntryDecorationSource,
): DailyEntry[] =>
  entries.map((entry) =>
    applyDailyPomodoroStats(
      applyDailyTaskStats(
        cloneEntry(entry),
        buildDailyTaskStats(source.tasks, source.events, entry.date),
      ),
      computeDailyPomodoroStats(source.sessions, entry.date),
    ),
  );
