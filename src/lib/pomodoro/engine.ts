import type {
  DailyPomodoroStats,
  PomodoroKind,
  PomodoroSegment,
  PomodoroSession,
  PomodoroSessionDetails,
  PomodoroState,
  PomodoroTaskSummary,
  Task,
} from "../../domain/types";
import { t } from "../../i18n";
import { createEntityId } from "../gtd/shared";
import { toLocalDateString } from "../date";

export const POMODORO_DURATIONS_MS: Record<PomodoroKind, number> = {
  focus: 25 * 60 * 1000,
  short_break: 5 * 60 * 1000,
  long_break: 25 * 60 * 1000,
};

export const isPomodoroTaskEligible = (task: Pick<Task, "status" | "bucket">): boolean =>
  task.status === "active" && task.bucket === "next_action";
const POMODORO_CYCLE_RESET_IDLE_MS = 25 * 60 * 1000;

export const clonePomodoroSession = (session: PomodoroSession): PomodoroSession => ({ ...session });

export const clonePomodoroSegment = (segment: PomodoroSegment): PomodoroSegment => ({ ...segment });

export const getPomodoroDurationMs = (kind: PomodoroKind): number => POMODORO_DURATIONS_MS[kind];

export interface PomodoroTiming {
  remainingMs: number;
  canCompleteNow: boolean;
  valid: boolean;
}

/**
 * Calculates display/action timing without mutating a session. Paused sessions deliberately
 * use their persisted remaining duration only, so opening a screen cannot advance a pause.
 */
export const getPomodoroTiming = (
  session: Pick<PomodoroSession, "kind" | "status" | "endsAt" | "pausedRemainingMs"> | null,
  nowMs: number,
): PomodoroTiming => {
  if (!session) {
    return { remainingMs: 0, canCompleteNow: false, valid: false };
  }

  const durationMs = getPomodoroDurationMs(session.kind);
  let remainingMs: number;

  if (session.status === "running") {
    const endsAtMs = new Date(session.endsAt).getTime();
    if (!Number.isFinite(endsAtMs) || !Number.isFinite(nowMs)) {
      return { remainingMs: 0, canCompleteNow: false, valid: false };
    }
    remainingMs = Math.max(0, Math.min(durationMs, endsAtMs - nowMs));
  } else if (session.status === "paused") {
    if (!Number.isFinite(session.pausedRemainingMs) || (session.pausedRemainingMs ?? -1) < 0) {
      return { remainingMs: 0, canCompleteNow: false, valid: false };
    }
    remainingMs = Math.min(durationMs, session.pausedRemainingMs as number);
  } else {
    return { remainingMs: 0, canCompleteNow: false, valid: false };
  }

  return {
    remainingMs,
    canCompleteNow: session.kind === "focus" && durationMs - remainingMs >= durationMs / 2,
    valid: true,
  };
};

export const createPomodoroSession = (
  kind: PomodoroKind,
  startedAt: string,
  cycleIndex: number,
): PomodoroSession => ({
  id: createEntityId("pomodoro-session"),
  kind,
  status: "running",
  startedAt,
  endsAt: new Date(new Date(startedAt).getTime() + getPomodoroDurationMs(kind)).toISOString(),
  pausedRemainingMs: null,
  completedAt: null,
  cancelledAt: null,
  cycleIndex,
  date: toLocalDateString(startedAt),
});

export const createPomodoroSegment = (
  sessionId: string,
  startedAt: string,
  taskId: string | null,
  title: string | null = null,
): PomodoroSegment => ({
  id: createEntityId("pomodoro-segment"),
  sessionId,
  taskId,
  title,
  startedAt,
  endedAt: null,
});

export interface PomodoroTransition {
  session: PomodoroSession;
  segmentsToUpsert: PomodoroSegment[];
}

export const requirePomodoroSession = (
  session: PomodoroSession | null | undefined,
  sessionId: string,
): PomodoroSession => {
  if (!session) {
    throw new Error(`Session Pomodoro ${sessionId} introuvable`);
  }
  return session;
};

export const startSession = (
  state: PomodoroState,
  options: { kind?: PomodoroKind; taskId?: string | null; title?: string | null },
  at: string,
): PomodoroTransition => {
  const kind = options.kind ?? state.nextSessionKind;
  const cycleIndex =
    kind === "focus"
      ? state.nextFocusCycleIndex
      : Math.max(1, state.completedFocusCountInCycle || 1);
  const session = createPomodoroSession(kind, at, cycleIndex);
  const segmentsToUpsert =
    kind === "focus"
      ? [
          createPomodoroSegment(
            session.id,
            at,
            options.taskId ?? null,
            options.taskId ? null : (options.title ?? "").trim() || null,
          ),
        ]
      : [];
  return { session, segmentsToUpsert };
};

export const stopSession = (
  session: PomodoroSession,
  openSegments: PomodoroSegment[],
  status: "completed" | "cancelled",
  at: string,
): PomodoroTransition => {
  const closedAt =
    status === "completed" &&
    session.status === "running" &&
    new Date(at).getTime() >= new Date(session.endsAt).getTime()
      ? session.endsAt
      : at;
  return {
    session: {
      ...session,
      status,
      pausedRemainingMs: null,
      completedAt: status === "completed" ? closedAt : null,
      cancelledAt: status === "cancelled" ? closedAt : null,
    },
    segmentsToUpsert: openSegments.map((segment) => ({ ...segment, endedAt: closedAt })),
  };
};

export const pauseSession = (
  session: PomodoroSession,
  openSegments: PomodoroSegment[],
  at: string,
): PomodoroTransition => ({
  session: {
    ...session,
    status: "paused",
    pausedRemainingMs: Math.max(0, new Date(session.endsAt).getTime() - new Date(at).getTime()),
  },
  segmentsToUpsert: openSegments.map((segment) => ({ ...segment, endedAt: at })),
});

export const resumeSession = (
  session: PomodoroSession,
  latestSegment: PomodoroSegment | null | undefined,
  at: string,
): PomodoroTransition => {
  const remainingMs =
    session.pausedRemainingMs ??
    Math.max(0, new Date(session.endsAt).getTime() - new Date(at).getTime());
  return {
    session: {
      ...session,
      status: "running",
      endsAt: new Date(new Date(at).getTime() + remainingMs).toISOString(),
      pausedRemainingMs: null,
    },
    segmentsToUpsert:
      session.kind === "focus" && latestSegment
        ? [createPomodoroSegment(session.id, at, latestSegment.taskId, latestSegment.title)]
        : [],
  };
};

export const switchSessionTask = (
  session: PomodoroSession,
  openSegment: PomodoroSegment | null | undefined,
  taskId: string | null,
  title: string | null,
  at: string,
): PomodoroTransition | null => {
  const normalizedTitle = taskId ? null : (title ?? "").trim() || null;
  if (openSegment?.taskId === taskId && (openSegment.title ?? null) === normalizedTitle) {
    return null;
  }
  return {
    session,
    segmentsToUpsert: [
      ...(openSegment ? [{ ...openSegment, endedAt: at }] : []),
      createPomodoroSegment(session.id, at, taskId, normalizedTitle),
    ],
  };
};

const sortSessions = (sessions: PomodoroSession[]): PomodoroSession[] =>
  [...sessions].sort((left, right) => left.startedAt.localeCompare(right.startedAt));

const sortSegments = (segments: PomodoroSegment[]): PomodoroSegment[] =>
  [...segments].sort((left, right) => left.startedAt.localeCompare(right.startedAt));

export const buildPomodoroSessionDetails = (
  sessions: PomodoroSession[],
  segments: PomodoroSegment[],
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
      const activeSegment =
        session.status === "running"
          ? ([...sessionSegments].reverse().find((segment) => segment.endedAt === null) ?? null)
          : session.status === "paused"
            ? (sessionSegments.at(-1) ?? null)
            : null;
      const taskIds = [
        ...new Set(sessionSegments.map((segment) => segment.taskId).filter(Boolean)),
      ] as string[];

      return {
        ...clonePomodoroSession(session),
        segments: sessionSegments,
        activeTaskId: activeSegment?.taskId ?? null,
        activeLabel: activeSegment?.taskId ? null : (activeSegment?.title ?? null),
        taskIds,
      };
    })
    .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
};

const findLatestCompletedSession = (sessions: PomodoroSession[]): PomodoroSession | null => {
  const completed = sortSessions(sessions).filter((session) => session.status === "completed");
  return completed.length > 0 ? completed[completed.length - 1] : null;
};

/** Sessions still marked running with a valid, past endsAt are treated as completed at endsAt so idle/reset logic applies. */
const normalizePomodoroSessionsForState = (
  sessions: PomodoroSession[],
  nowIso: string,
): PomodoroSession[] => {
  const nowMs = new Date(nowIso).getTime();
  return sessions.map((session) => {
    if (session.status !== "running") {
      return session;
    }
    const endsAtMs = new Date(session.endsAt).getTime();
    if (!Number.isFinite(endsAtMs) || !Number.isFinite(nowMs) || endsAtMs > nowMs) {
      return session;
    }
    return {
      ...session,
      status: "completed" as const,
      completedAt: session.endsAt,
      cancelledAt: null,
    };
  });
};

const terminalSessionEndIso = (session: PomodoroSession): string | null => {
  if (session.status === "running" || session.status === "paused") {
    return null;
  }
  return session.completedAt ?? session.cancelledAt ?? session.endsAt ?? session.startedAt;
};

const findLastSessionActivityAt = (sessions: PomodoroSession[]): string | null => {
  let maxMs = -Infinity;
  let maxIso: string | null = null;
  for (const session of sessions) {
    const endIso = terminalSessionEndIso(session);
    if (!endIso) {
      continue;
    }
    const endMs = new Date(endIso).getTime();
    if (Number.isFinite(endMs) && endMs >= maxMs) {
      maxMs = endMs;
      maxIso = endIso;
    }
  }
  return maxIso;
};

/**
 * Sessions still tied to the open cycle. More than 25 minutes between one session's end and the
 * next session's start closes the earlier cycle, and the same gap after the last ended session
 * closes the open cycle entirely. A cancelled session keeps the clock recent, but it does not
 * carry progress from the cycle before that gap.
 */
const sessionsAfterLastIdleGap = (
  sessions: PomodoroSession[],
  nowIso: string,
): PomodoroSession[] => {
  const sorted = sortSessions(sessions);
  let startIndex = 0;

  for (let index = 1; index < sorted.length; index += 1) {
    const previousEnd = terminalSessionEndIso(sorted[index - 1]);
    if (!previousEnd) {
      continue;
    }
    const previousEndMs = new Date(previousEnd).getTime();
    const nextStartMs = new Date(sorted[index].startedAt).getTime();
    if (
      Number.isFinite(previousEndMs) &&
      Number.isFinite(nextStartMs) &&
      nextStartMs - previousEndMs > POMODORO_CYCLE_RESET_IDLE_MS
    ) {
      startIndex = index;
    }
  }

  const openCycle = sorted.slice(startIndex);
  const last = openCycle.at(-1);
  if (!last) {
    return [];
  }

  const lastEnd = terminalSessionEndIso(last);
  if (!lastEnd) {
    return openCycle;
  }
  const lastEndMs = new Date(lastEnd).getTime();
  const nowMs = new Date(nowIso).getTime();
  if (
    Number.isFinite(lastEndMs) &&
    Number.isFinite(nowMs) &&
    nowMs - lastEndMs > POMODORO_CYCLE_RESET_IDLE_MS
  ) {
    return [];
  }
  return openCycle;
};

/**
 * True when the focus cycle should restart at 1/4: no live focus, and the open cycle has no
 * completed session. A cancel after an idle gap starts that open cycle over; it does not revive
 * the completed session from before the gap. A still-running break is ignored, matching the
 * auto-complete path.
 */
const shouldResetPomodoroCycleAfterIdle = (
  sessions: PomodoroSession[],
  nowIso: string,
): boolean => {
  if (sessions.some((session) => session.status === "paused")) {
    return false;
  }

  // A malformed running deadline must stay visible so the controller can offer recovery
  // actions. Treating it as an expired completion here would only change memory, leaving
  // the persisted row running.
  if (
    sessions.some(
      (session) =>
        session.status === "running" && !Number.isFinite(new Date(session.endsAt).getTime()),
    )
  ) {
    return false;
  }

  const normalized = normalizePomodoroSessionsForState(sessions, nowIso);
  const nowMs = new Date(nowIso).getTime();

  const hasLiveFocus = normalized.some(
    (session) =>
      session.status === "running" &&
      session.kind === "focus" &&
      new Date(session.endsAt).getTime() > nowMs,
  );
  if (hasLiveFocus) {
    return false;
  }

  const withoutLiveBreaks = sessionsAfterLastIdleGap(normalized, nowIso).filter(
    (session) =>
      !(
        session.status === "running" &&
        (session.kind === "short_break" || session.kind === "long_break") &&
        new Date(session.endsAt).getTime() > nowMs
      ),
  );

  const latestCompleted = findLatestCompletedSession(withoutLiveBreaks);
  const lastSessionActivityAt = findLastSessionActivityAt(withoutLiveBreaks);
  const idleResets =
    lastSessionActivityAt !== null &&
    nowMs - new Date(lastSessionActivityAt).getTime() > POMODORO_CYCLE_RESET_IDLE_MS;

  return !latestCompleted || idleResets;
};

/** True when the floating overlay should stay visible for the current cycle (live or recent idle). */
export const shouldShowFloatingPomodoro = (
  state: PomodoroState,
  sessions: PomodoroSession[],
  nowIso = new Date().toISOString(),
): boolean => Boolean(state.activeSession) || !shouldResetPomodoroCycleAfterIdle(sessions, nowIso);

/** Running breaks to close in storage when {@link shouldResetPomodoroCycleAfterIdle} applies. */
export const getPomodoroRunningBreakSessionIdsToAutoCompleteWhenReset = (
  sessions: PomodoroSession[],
  nowIso = new Date().toISOString(),
): string[] => {
  if (!shouldResetPomodoroCycleAfterIdle(sessions, nowIso)) {
    return [];
  }

  return sessions
    .filter(
      (session) =>
        session.status === "running" &&
        (session.kind === "short_break" || session.kind === "long_break"),
    )
    .map((session) => session.id);
};

export const buildPomodoroState = (
  sessions: PomodoroSession[],
  segments: PomodoroSegment[],
  now = new Date().toISOString(),
): PomodoroState => {
  const normalizedSessions = normalizePomodoroSessionsForState(sessions, now);

  if (shouldResetPomodoroCycleAfterIdle(sessions, now)) {
    return {
      activeSession: null,
      nextSessionKind: "focus",
      completedFocusCountInCycle: 0,
      nextFocusCycleIndex: 1,
      currentCycleIndex: 1,
    };
  }

  const details = buildPomodoroSessionDetails(normalizedSessions, segments);
  const activeSession =
    details.find((session) => session.status === "running" || session.status === "paused") ?? null;

  if (activeSession) {
    if (activeSession.kind === "focus") {
      return {
        activeSession,
        nextSessionKind: activeSession.cycleIndex >= 4 ? "long_break" : "short_break",
        completedFocusCountInCycle: Math.max(0, activeSession.cycleIndex - 1),
        nextFocusCycleIndex: Math.min(4, activeSession.cycleIndex + 1),
        currentCycleIndex: activeSession.cycleIndex,
      };
    }

    return {
      activeSession,
      nextSessionKind: "focus",
      completedFocusCountInCycle: activeSession.cycleIndex,
      nextFocusCycleIndex:
        activeSession.kind === "long_break" ? 1 : Math.min(4, activeSession.cycleIndex + 1),
      currentCycleIndex: activeSession.cycleIndex,
    };
  }

  const latestCompleted = findLatestCompletedSession(
    sessionsAfterLastIdleGap(normalizedSessions, now),
  );

  if (!latestCompleted) {
    return {
      activeSession: null,
      nextSessionKind: "focus",
      completedFocusCountInCycle: 0,
      nextFocusCycleIndex: 1,
      currentCycleIndex: 1,
    };
  }

  if (latestCompleted.kind === "focus") {
    const nextBreakKind = latestCompleted.cycleIndex >= 4 ? "long_break" : "short_break";
    return {
      activeSession: null,
      nextSessionKind: nextBreakKind,
      completedFocusCountInCycle: latestCompleted.cycleIndex,
      nextFocusCycleIndex: latestCompleted.cycleIndex >= 4 ? 1 : latestCompleted.cycleIndex + 1,
      currentCycleIndex: latestCompleted.cycleIndex,
    };
  }

  if (latestCompleted.kind === "long_break") {
    return {
      activeSession: null,
      nextSessionKind: "focus",
      completedFocusCountInCycle: 0,
      nextFocusCycleIndex: 1,
      currentCycleIndex: 1,
    };
  }

  return {
    activeSession: null,
    nextSessionKind: "focus",
    completedFocusCountInCycle: latestCompleted.cycleIndex,
    nextFocusCycleIndex: Math.min(4, latestCompleted.cycleIndex + 1),
    currentCycleIndex: Math.min(4, latestCompleted.cycleIndex + 1),
  };
};

export const buildPomodoroTaskSummaries = (
  sessions: PomodoroSession[],
  segments: PomodoroSegment[],
  tasks: Task[],
  date: string,
  now = new Date().toISOString(),
): PomodoroTaskSummary[] => {
  const taskTitles = new Map(tasks.map((task) => [task.id, task.title] as const));
  const taskProjectIds = new Map(tasks.map((task) => [task.id, task.projectId] as const));
  const sessionDateSet = new Set(
    sessions.filter((session) => session.date === date).map((session) => session.id),
  );
  const totals = new Map<
    string,
    { totalSeconds: number; sessionIds: Set<string>; label: string | null }
  >();
  const untitledKey = "manual:__untitled__";
  const nowMs = new Date(now).getTime();

  for (const segment of segments) {
    if (!sessionDateSet.has(segment.sessionId)) {
      continue;
    }

    const startMs = new Date(segment.startedAt).getTime();
    const rawEndMs = new Date(segment.endedAt ?? now).getTime();
    const endMs = segment.endedAt ? rawEndMs : Math.min(rawEndMs, nowMs);

    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      continue;
    }

    const key =
      segment.taskId ?? `manual:${(segment.title ?? "").trim().toLowerCase() || "__untitled__"}`;
    const current = totals.get(key) ?? {
      totalSeconds: 0,
      sessionIds: new Set<string>(),
      label: segment.taskId ? null : (segment.title ?? "").trim() || null,
    };
    current.totalSeconds += Math.max(0, endMs - startMs) / 1000;
    current.sessionIds.add(segment.sessionId);
    totals.set(key, current);
  }

  return [...totals.entries()]
    .map(([key, value]) => ({
      taskId: key.startsWith("manual:") ? null : key,
      taskTitle: key.startsWith("manual:")
        ? key === untitledKey
          ? t("untitled", { ns: "pomodoro" })
          : (value.label ?? t("untitled", { ns: "pomodoro" }))
        : (taskTitles.get(key) ?? t("unknownTask", { ns: "pomodoro" })),
      projectId: key.startsWith("manual:") ? null : (taskProjectIds.get(key) ?? null),
      totalSeconds: Math.round(value.totalSeconds),
      sessionCount: value.sessionIds.size,
    }))
    .sort(
      (left, right) =>
        right.totalSeconds - left.totalSeconds || left.taskTitle.localeCompare(right.taskTitle),
    );
};

export const computeDailyPomodoroStats = (
  sessions: PomodoroSession[],
  date: string,
): DailyPomodoroStats => ({
  date,
  completedFocusSessions: sessions.filter(
    (session) =>
      session.date === date && session.kind === "focus" && session.status === "completed",
  ).length,
});

export const getPomodoroKindLabel = (kind: PomodoroKind): string =>
  t(`kind.${kind}`, { ns: "pomodoro" });
