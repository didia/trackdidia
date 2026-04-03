import type {
  DailyPomodoroStats,
  PomodoroKind,
  PomodoroSegment,
  PomodoroSession,
  PomodoroSessionDetails,
  PomodoroState,
  PomodoroTaskSummary,
  Task
} from "../../domain/types";
import { createEntityId, toLocalDateString } from "../gtd/shared";

export const POMODORO_DURATIONS_MS: Record<PomodoroKind, number> = {
  focus: 25 * 60 * 1000,
  short_break: 5 * 60 * 1000,
  long_break: 25 * 60 * 1000
};
const POMODORO_CYCLE_RESET_IDLE_MS = 25 * 60 * 1000;

export const clonePomodoroSession = (session: PomodoroSession): PomodoroSession => ({ ...session });

export const clonePomodoroSegment = (segment: PomodoroSegment): PomodoroSegment => ({ ...segment });

export const getPomodoroDurationMs = (kind: PomodoroKind): number => POMODORO_DURATIONS_MS[kind];

export const createPomodoroSession = (
  kind: PomodoroKind,
  startedAt: string,
  cycleIndex: number
): PomodoroSession => ({
  id: createEntityId("pomodoro-session"),
  kind,
  status: "running",
  startedAt,
  endsAt: new Date(new Date(startedAt).getTime() + getPomodoroDurationMs(kind)).toISOString(),
  completedAt: null,
  cancelledAt: null,
  cycleIndex,
  date: toLocalDateString(startedAt)
});

export const createPomodoroSegment = (
  sessionId: string,
  startedAt: string,
  taskId: string | null,
  title: string | null = null
): PomodoroSegment => ({
  id: createEntityId("pomodoro-segment"),
  sessionId,
  taskId,
  title,
  startedAt,
  endedAt: null
});

const sortSessions = (sessions: PomodoroSession[]): PomodoroSession[] =>
  [...sessions].sort((left, right) => left.startedAt.localeCompare(right.startedAt));

const sortSegments = (segments: PomodoroSegment[]): PomodoroSegment[] =>
  [...segments].sort((left, right) => left.startedAt.localeCompare(right.startedAt));

export const buildPomodoroSessionDetails = (
  sessions: PomodoroSession[],
  segments: PomodoroSegment[]
): PomodoroSessionDetails[] => {
  const segmentsBySession = new Map<string, PomodoroSegment[]>();

  for (const segment of sortSegments(segments)) {
    const current = segmentsBySession.get(segment.sessionId) ?? [];
    current.push(clonePomodoroSegment(segment));
    segmentsBySession.set(segment.sessionId, current);
  }

  return sortSessions(sessions)
    .map((session) => {
      const sessionSegments = segmentsBySession.get(session.id) ?? [];
      const activeSegment = [...sessionSegments].reverse().find((segment) => segment.endedAt === null) ?? null;
      const taskIds = [...new Set(sessionSegments.map((segment) => segment.taskId).filter(Boolean))] as string[];

      return {
        ...clonePomodoroSession(session),
        segments: sessionSegments,
        activeTaskId: activeSegment?.taskId ?? null,
        activeLabel: activeSegment?.taskId ? null : activeSegment?.title ?? null,
        taskIds
      };
    })
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
};

const findLatestCompletedSession = (sessions: PomodoroSession[]): PomodoroSession | null => {
  const completed = sortSessions(sessions).filter((session) => session.status === "completed");
  return completed.length > 0 ? completed[completed.length - 1] : null;
};

/** Sessions still marked running but past endsAt are treated as completed at endsAt so idle/reset logic applies. */
const normalizePomodoroSessionsForState = (sessions: PomodoroSession[], nowIso: string): PomodoroSession[] => {
  const nowMs = new Date(nowIso).getTime();
  return sessions.map((session) => {
    if (session.status !== "running") {
      return session;
    }
    if (new Date(session.endsAt).getTime() > nowMs) {
      return session;
    }
    return {
      ...session,
      status: "completed" as const,
      completedAt: session.endsAt,
      cancelledAt: null
    };
  });
};

const findLastSessionActivityAt = (sessions: PomodoroSession[]): string | null => {
  const terminalSessions = sessions.filter((session) => session.status !== "running");
  if (terminalSessions.length === 0) {
    return null;
  }

  let maxMs = -Infinity;
  let maxIso: string | null = null;
  for (const session of terminalSessions) {
    const endIso = session.completedAt ?? session.cancelledAt ?? session.endsAt ?? session.startedAt;
    const endMs = new Date(endIso).getTime();
    if (Number.isFinite(endMs) && endMs >= maxMs) {
      maxMs = endMs;
      maxIso = endIso;
    }
  }
  return maxIso;
};

/**
 * True when the focus cycle should restart at 1/4: no live focus, and either no completed history
 * or more than 25 minutes since the last ended session if we ignore any still-running break.
 */
const shouldResetPomodoroCycleAfterIdle = (sessions: PomodoroSession[], nowIso: string): boolean => {
  const normalized = normalizePomodoroSessionsForState(sessions, nowIso);
  const nowMs = new Date(nowIso).getTime();

  const hasLiveFocus = normalized.some(
    (session) =>
      session.status === "running" &&
      session.kind === "focus" &&
      new Date(session.endsAt).getTime() > nowMs
  );
  if (hasLiveFocus) {
    return false;
  }

  const withoutLiveBreaks = normalized.filter(
    (session) =>
      !(
        session.status === "running" &&
        (session.kind === "short_break" || session.kind === "long_break") &&
        new Date(session.endsAt).getTime() > nowMs
      )
  );

  const latestCompleted = findLatestCompletedSession(withoutLiveBreaks);
  const lastSessionActivityAt = findLastSessionActivityAt(withoutLiveBreaks);
  const idleResets =
    lastSessionActivityAt !== null &&
    nowMs - new Date(lastSessionActivityAt).getTime() > POMODORO_CYCLE_RESET_IDLE_MS;

  return !latestCompleted || idleResets;
};

/** Running breaks to close in storage when {@link shouldResetPomodoroCycleAfterIdle} applies. */
export const getPomodoroRunningBreakSessionIdsToAutoCompleteWhenReset = (
  sessions: PomodoroSession[],
  nowIso = new Date().toISOString()
): string[] => {
  if (!shouldResetPomodoroCycleAfterIdle(sessions, nowIso)) {
    return [];
  }

  return sessions
    .filter(
      (session) =>
        session.status === "running" &&
        (session.kind === "short_break" || session.kind === "long_break")
    )
    .map((session) => session.id);
};

export const buildPomodoroState = (
  sessions: PomodoroSession[],
  segments: PomodoroSegment[],
  now = new Date().toISOString()
): PomodoroState => {
  const normalizedSessions = normalizePomodoroSessionsForState(sessions, now);

  if (shouldResetPomodoroCycleAfterIdle(sessions, now)) {
    return {
      activeSession: null,
      nextSessionKind: "focus",
      completedFocusCountInCycle: 0,
      nextFocusCycleIndex: 1,
      currentCycleIndex: 1
    };
  }

  const details = buildPomodoroSessionDetails(normalizedSessions, segments);
  const activeSession = details.find((session) => session.status === "running") ?? null;

  if (activeSession) {
    if (activeSession.kind === "focus") {
      return {
        activeSession,
        nextSessionKind: activeSession.cycleIndex >= 4 ? "long_break" : "short_break",
        completedFocusCountInCycle: Math.max(0, activeSession.cycleIndex - 1),
        nextFocusCycleIndex: Math.min(4, activeSession.cycleIndex + 1),
        currentCycleIndex: activeSession.cycleIndex
      };
    }

    return {
      activeSession,
      nextSessionKind: "focus",
      completedFocusCountInCycle: activeSession.cycleIndex,
      nextFocusCycleIndex: activeSession.kind === "long_break" ? 1 : Math.min(4, activeSession.cycleIndex + 1),
      currentCycleIndex: activeSession.cycleIndex
    };
  }

  const latestCompleted = findLatestCompletedSession(normalizedSessions);

  if (!latestCompleted) {
    return {
      activeSession: null,
      nextSessionKind: "focus",
      completedFocusCountInCycle: 0,
      nextFocusCycleIndex: 1,
      currentCycleIndex: 1
    };
  }

  if (latestCompleted.kind === "focus") {
    const nextBreakKind = latestCompleted.cycleIndex >= 4 ? "long_break" : "short_break";
    return {
      activeSession: null,
      nextSessionKind: nextBreakKind,
      completedFocusCountInCycle: latestCompleted.cycleIndex,
      nextFocusCycleIndex: latestCompleted.cycleIndex >= 4 ? 1 : latestCompleted.cycleIndex + 1,
      currentCycleIndex: latestCompleted.cycleIndex
    };
  }

  if (latestCompleted.kind === "long_break") {
    return {
      activeSession: null,
      nextSessionKind: "focus",
      completedFocusCountInCycle: 0,
      nextFocusCycleIndex: 1,
      currentCycleIndex: 1
    };
  }

  return {
    activeSession: null,
    nextSessionKind: "focus",
    completedFocusCountInCycle: latestCompleted.cycleIndex,
    nextFocusCycleIndex: Math.min(4, latestCompleted.cycleIndex + 1),
    currentCycleIndex: Math.min(4, latestCompleted.cycleIndex + 1)
  };
};

export const buildPomodoroTaskSummaries = (
  sessions: PomodoroSession[],
  segments: PomodoroSegment[],
  tasks: Task[],
  date: string,
  now = new Date().toISOString()
): PomodoroTaskSummary[] => {
  const taskTitles = new Map(tasks.map((task) => [task.id, task.title] as const));
  const sessionDateSet = new Set(
    sessions.filter((session) => session.date === date).map((session) => session.id)
  );
  const totals = new Map<string, { totalSeconds: number; sessionIds: Set<string>; label: string | null }>();
  const untitledKey = "manual:__untitled__";
  const nowMs = new Date(now).getTime();

  for (const segment of segments) {
    if (!sessionDateSet.has(segment.sessionId)) {
      continue;
    }

    const startMs = new Date(segment.startedAt).getTime();
    const endMs = new Date(segment.endedAt ?? now).getTime();

    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      continue;
    }

    const key = segment.taskId ?? `manual:${(segment.title ?? "").trim().toLowerCase() || "__untitled__"}`;
    const current = totals.get(key) ?? {
      totalSeconds: 0,
      sessionIds: new Set<string>(),
      label: segment.taskId ? null : (segment.title ?? "").trim() || null
    };
    current.totalSeconds += Math.max(0, Math.min(endMs, nowMs) - startMs) / 1000;
    current.sessionIds.add(segment.sessionId);
    totals.set(key, current);
  }

  return [...totals.entries()]
    .map(([key, value]) => ({
      taskId: key.startsWith("manual:") ? null : key,
      taskTitle: key.startsWith("manual:")
        ? key === untitledKey
          ? "Sans titre"
          : value.label ?? "Sans titre"
        : taskTitles.get(key) ?? "Tache inconnue",
      totalSeconds: Math.round(value.totalSeconds),
      sessionCount: value.sessionIds.size
    }))
    .sort((left, right) => right.totalSeconds - left.totalSeconds || left.taskTitle.localeCompare(right.taskTitle));
};

export const computeDailyPomodoroStats = (sessions: PomodoroSession[], date: string): DailyPomodoroStats => ({
  date,
  completedFocusSessions: sessions.filter(
    (session) => session.date === date && session.kind === "focus" && session.status === "completed"
  ).length
});

export const getPomodoroKindLabel = (kind: PomodoroKind): string => {
  switch (kind) {
    case "focus":
      return "Focus";
    case "short_break":
      return "Pause courte";
    case "long_break":
      return "Grande pause";
  }
};
