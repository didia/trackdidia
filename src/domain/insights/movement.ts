import type { PomodoroSessionDetails, Task } from "../types";

export interface AppOpenInterval {
  startedAt: string;
  endedAt: string;
}

export interface WindowMovementInput {
  /** Start of the window, exclusive — usually the previous pulse's timestamp. */
  sinceIso: string;
  /** End of the window, inclusive — usually "now". */
  nowIso: string;
  focusSessions: PomodoroSessionDetails[];
  tasks: Task[];
  /** Periods the app was open/foregrounded, in any order and possibly overlapping. */
  appOpenIntervals: AppOpenInterval[];
}

export interface WindowMovement {
  sinceIso: string;
  nowIso: string;
  windowMs: number;
  completedFocusSessionCount: number;
  completedTaskCount: number;
  appOpenMs: number;
  /** Share of the window the app was open, clamped to [0, 1]. */
  appOpenRatio: number;
  /** Binary movement per spec `ai-integration-v2.md` §6.3: at least one focus session or one completed task. */
  moved: boolean;
}

const mergeIntervals = (intervals: Array<[number, number]>): Array<[number, number]> => {
  const sorted = [...intervals].sort((left, right) => left[0] - right[0]);
  const merged: Array<[number, number]> = [];

  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }

  return merged;
};

/**
 * Window movement (spec `ai-integration-v2.md` §3, §6.3): completed focus sessions and
 * completed tasks since a reference time, plus how much of the window the app was open.
 * Pure and deterministic — feeds the phase-2 pulse delta gate, but nothing calls it yet.
 */
export const computeWindowMovement = (input: WindowMovementInput): WindowMovement => {
  const sinceMs = new Date(input.sinceIso).getTime();
  const nowMs = new Date(input.nowIso).getTime();
  const windowMs = Math.max(0, nowMs - sinceMs);

  const isWithinWindow = (iso: string | null): boolean => {
    if (!iso) {
      return false;
    }
    const ms = new Date(iso).getTime();
    return ms > sinceMs && ms <= nowMs;
  };

  const completedFocusSessionCount = input.focusSessions.filter(
    (session) =>
      session.kind === "focus" &&
      session.status === "completed" &&
      isWithinWindow(session.completedAt),
  ).length;

  const completedTaskCount = input.tasks.filter(
    (task) => task.status === "completed" && isWithinWindow(task.completedAt),
  ).length;

  const clampedIntervals = input.appOpenIntervals
    .map((interval): [number, number] => [
      Math.max(sinceMs, new Date(interval.startedAt).getTime()),
      Math.min(nowMs, new Date(interval.endedAt).getTime()),
    ])
    .filter(([start, end]) => end > start);

  const appOpenMs = mergeIntervals(clampedIntervals).reduce(
    (sum, [start, end]) => sum + (end - start),
    0,
  );
  const appOpenRatio = windowMs > 0 ? Math.min(1, appOpenMs / windowMs) : 0;

  return {
    sinceIso: input.sinceIso,
    nowIso: input.nowIso,
    windowMs,
    completedFocusSessionCount,
    completedTaskCount,
    appOpenMs,
    appOpenRatio,
    moved: completedFocusSessionCount > 0 || completedTaskCount > 0,
  };
};
