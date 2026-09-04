import type { AppOpenInterval } from "../../../domain/insights/movement";
import { computeWindowMovement } from "../../../domain/insights/movement";
import type { AiDeltaClass } from "../../../domain/types";
import { PULSE_UNKNOWN_CONTINUOUS_OPEN_MS } from "./constants";

export interface PulseWindowInput {
  sinceIso: string;
  nowIso: string;
  focusSessions: Parameters<typeof computeWindowMovement>[0]["focusSessions"];
  tasks: Parameters<typeof computeWindowMovement>[0]["tasks"];
  appOpenIntervals: AppOpenInterval[];
  /** Local day-of-week: 0 = Sunday (spec weekend downgrade). */
  dayOfWeek: number;
}

export interface PulseWindowResult {
  deltaClass: AiDeltaClass;
  movement: ReturnType<typeof computeWindowMovement>;
  maxContinuousOpenMs: number;
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

export const computeMaxContinuousOpenMs = (
  sinceIso: string,
  nowIso: string,
  appOpenIntervals: AppOpenInterval[],
): number => {
  const sinceMs = new Date(sinceIso).getTime();
  const nowMs = new Date(nowIso).getTime();

  const clamped = appOpenIntervals
    .map((interval): [number, number] => [
      Math.max(sinceMs, new Date(interval.startedAt).getTime()),
      Math.min(nowMs, new Date(interval.endedAt).getTime()),
    ])
    .filter(([start, end]) => end > start);

  return mergeIntervals(clamped).reduce((max, [start, end]) => Math.max(max, end - start), 0);
};

const isWeekend = (dayOfWeek: number): boolean => dayOfWeek === 0 || dayOfWeek === 6;

/**
 * Classify pulse window movement (spec §6.3).
 * Weekend no-movement downgrades to idle (open question #2 recommendation).
 */
export const classifyPulseWindow = (input: PulseWindowInput): PulseWindowResult => {
  const movement = computeWindowMovement({
    sinceIso: input.sinceIso,
    nowIso: input.nowIso,
    focusSessions: input.focusSessions,
    tasks: input.tasks,
    appOpenIntervals: input.appOpenIntervals,
  });

  const maxContinuousOpenMs = computeMaxContinuousOpenMs(
    input.sinceIso,
    input.nowIso,
    input.appOpenIntervals,
  );

  if (movement.moved) {
    return { deltaClass: "progress", movement, maxContinuousOpenMs };
  }

  if (isWeekend(input.dayOfWeek)) {
    return { deltaClass: "idle", movement, maxContinuousOpenMs };
  }

  if (maxContinuousOpenMs >= PULSE_UNKNOWN_CONTINUOUS_OPEN_MS) {
    return { deltaClass: "stall", movement, maxContinuousOpenMs };
  }

  if (maxContinuousOpenMs > 0) {
    return { deltaClass: "unknown", movement, maxContinuousOpenMs };
  }

  return { deltaClass: "idle", movement, maxContinuousOpenMs };
};
