import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PomodoroSessionDetails, PomodoroState, PomodoroTaskSummary, Task } from "../domain/types";
import { getTodayDate } from "../lib/date";
import { logDebug } from "../lib/debug";
import { getPomodoroDurationMs, getPomodoroKindLabel } from "../lib/pomodoro/engine";
import { notifyPomodoroCompletion, playPomodoroChime, unlockPomodoroSound } from "../lib/pomodoro/sound";
import type { AppRepository, PomodoroStartOptions } from "../lib/storage/repository";

export interface PomodoroControllerValue {
  state: PomodoroState;
  sessions: PomodoroSessionDetails[];
  taskSummaries: PomodoroTaskSummary[];
  taskOptions: Task[];
  currentTask: Task | null;
  currentActivityLabel: string | null;
  preferredTask: Task | null;
  preferredActivityLabel: string | null;
  remainingMs: number;
  canCompleteNow: boolean;
  loading: boolean;
  reload: () => Promise<void>;
  startPomodoro: (options?: PomodoroStartOptions) => Promise<void>;
  skipBreak: () => Promise<void>;
  completeCurrentTask: () => Promise<void>;
  completeNow: () => Promise<void>;
  cancelCurrent: () => Promise<void>;
  switchTask: (taskId: string | null, title?: string | null) => Promise<void>;
}

const isPomodoroTaskEligible = (task: Task): boolean =>
  task.status === "active" && (task.bucket === "next_action" || task.bucket === "scheduled");

const buildIdleState = (): PomodoroState => ({
  activeSession: null,
  nextSessionKind: "focus",
  completedFocusCountInCycle: 0,
  nextFocusCycleIndex: 1,
  currentCycleIndex: 1
});

export const usePomodoroController = (repository: AppRepository | null): PomodoroControllerValue => {
  const [state, setState] = useState<PomodoroState>(buildIdleState());
  const [sessions, setSessions] = useState<PomodoroSessionDetails[]>([]);
  const [taskSummaries, setTaskSummaries] = useState<PomodoroTaskSummary[]>([]);
  const [allTasks, setAllTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [nowMs, setNowMs] = useState(Date.now());
  const stateRef = useRef<PomodoroState>(buildIdleState());
  const refreshRunningRef = useRef(false);

  const announceCompletion = useCallback(async (kind: PomodoroSessionDetails["kind"]) => {
    const played = await playPomodoroChime();
    if (!played) {
      notifyPomodoroCompletion("Session Pomodoro terminee", `${getPomodoroKindLabel(kind)} terminee.`);
      return;
    }

    notifyPomodoroCompletion("Session Pomodoro terminee", `${getPomodoroKindLabel(kind)} terminee.`);
  }, []);

  const load = useCallback(
    async (options?: { preserveVisibleState?: boolean }) => {
      if (!repository) {
        setLoading(false);
        return;
      }

      if (!options?.preserveVisibleState) {
        setLoading(true);
      }

      const today = getTodayDate();
      await repository.generateDueRecurringTasks(today);
      const nextState = await repository.completeExpiredPomodoroSessions();
      const [nextSessions, nextSummaries, nextTasks] = await Promise.all([
        repository.listPomodoroSessions(today),
        repository.listPomodoroTaskSummaries(today),
        repository.listTasks({ includeCompleted: true })
      ]);

      stateRef.current = nextState;
      setState(nextState);
      setSessions(nextSessions);
      setTaskSummaries(nextSummaries);
      setAllTasks(nextTasks);
      setLoading(false);
      setNowMs(Date.now());
    },
    [repository]
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    if (!repository || !state.activeSession || state.activeSession.status !== "running") {
      return;
    }

    const expiringSession = state.activeSession;

    if (Date.now() < new Date(expiringSession.endsAt).getTime() || refreshRunningRef.current) {
      return;
    }

    refreshRunningRef.current = true;

    const complete = async () => {
      try {
        await repository.completeExpiredPomodoroSessions();
        await announceCompletion(expiringSession.kind);
        await load({ preserveVisibleState: true });
      } catch (error) {
        logDebug("error", "pomodoro", "Echec de completion automatique d'une session", error);
      } finally {
        refreshRunningRef.current = false;
      }
    };

    void complete();
  }, [announceCompletion, load, repository, state]);

  const startPomodoro = useCallback(
    async (options: PomodoroStartOptions = {}) => {
      if (!repository) {
        return;
      }

      await unlockPomodoroSound();
      await repository.startPomodoro(options);
      await load({ preserveVisibleState: true });
    },
    [load, repository]
  );

  const completeNow = useCallback(async () => {
    const activeSession = stateRef.current.activeSession;
    if (!repository || !activeSession) {
      return;
    }

    const elapsedMs = Date.now() - new Date(activeSession.startedAt).getTime();
    if (activeSession.kind === "focus" && elapsedMs < getPomodoroDurationMs("focus") / 2) {
      return;
    }

    await repository.stopPomodoroSession(activeSession.id, "completed");
    await announceCompletion(activeSession.kind);
    await load({ preserveVisibleState: true });
  }, [announceCompletion, load, repository]);

  const completeCurrentTask = useCallback(async () => {
    const activeSession = stateRef.current.activeSession;
    const currentTaskId = activeSession?.activeTaskId;

    if (!repository || !activeSession || activeSession.kind !== "focus" || !currentTaskId) {
      return;
    }

    await repository.completeTask(currentTaskId);
    await repository.switchPomodoroTask(activeSession.id, null, null);
    await load({ preserveVisibleState: true });
  }, [load, repository]);

  const skipBreak = useCallback(async () => {
    if (!repository) {
      return;
    }

    const activeSession = stateRef.current.activeSession;

    if (activeSession?.kind === "short_break" || activeSession?.kind === "long_break") {
      await repository.stopPomodoroSession(activeSession.id, "completed");
      await load({ preserveVisibleState: true });
      return;
    }

    if (stateRef.current.nextSessionKind === "short_break" || stateRef.current.nextSessionKind === "long_break") {
      const startedState = await repository.startPomodoro({
        kind: stateRef.current.nextSessionKind
      });
      const startedBreak = startedState.activeSession;

      if (startedBreak) {
        await repository.stopPomodoroSession(startedBreak.id, "completed");
      }

      await load({ preserveVisibleState: true });
    }
  }, [load, repository]);

  const cancelCurrent = useCallback(async () => {
    const activeSession = stateRef.current.activeSession;
    if (!repository || !activeSession) {
      return;
    }

    await repository.stopPomodoroSession(activeSession.id, "cancelled");
    await load({ preserveVisibleState: true });
  }, [load, repository]);

  const switchTask = useCallback(
    async (taskId: string | null, title: string | null = null) => {
      const activeSession = stateRef.current.activeSession;
      if (!repository || !activeSession) {
        return;
      }

      await repository.switchPomodoroTask(activeSession.id, taskId, title);
      await load({ preserveVisibleState: true });
    },
    [load, repository]
  );

  const currentActivityLabel = state.activeSession?.activeTaskId ? null : state.activeSession?.activeLabel ?? null;

  const currentTask = useMemo(() => {
    const taskId = state.activeSession?.activeTaskId;
    if (!taskId) {
      return null;
    }

    return allTasks.find((task) => task.id === taskId) ?? null;
  }, [allTasks, state.activeSession?.activeTaskId]);

  const latestFocusSession = useMemo(
    () => sessions.find((session) => session.kind === "focus"),
    [sessions]
  );

  const preferredSelection = useMemo(() => {
    if (currentTask || currentActivityLabel) {
      return { task: currentTask, label: currentActivityLabel };
    }

    const latestSegment = latestFocusSession?.segments.at(-1) ?? null;
    if (!latestSegment) {
      return { task: null, label: null };
    }

    if (latestSegment.taskId) {
      const preferredTask = allTasks.find(
        (task) => task.id === latestSegment.taskId && isPomodoroTaskEligible(task)
      ) ?? null;
      return { task: preferredTask, label: null };
    }

    return { task: null, label: latestSegment.title ?? null };
  }, [allTasks, currentActivityLabel, currentTask, latestFocusSession]);

  const canCompleteNow = useMemo(() => {
    if (!state.activeSession || state.activeSession.kind !== "focus") {
      return false;
    }

    const elapsedMs = nowMs - new Date(state.activeSession.startedAt).getTime();
    return elapsedMs >= getPomodoroDurationMs("focus") / 2;
  }, [nowMs, state.activeSession]);

  const taskOptions = useMemo(() => allTasks.filter(isPomodoroTaskEligible), [allTasks]);

  return {
    state,
    sessions,
    taskSummaries,
    taskOptions,
    currentTask,
    currentActivityLabel,
    preferredTask: preferredSelection.task,
    preferredActivityLabel: preferredSelection.label,
    remainingMs: state.activeSession ? Math.max(0, new Date(state.activeSession.endsAt).getTime() - nowMs) : 0,
    canCompleteNow,
    loading,
    reload: async () => load({ preserveVisibleState: true }),
    startPomodoro,
    skipBreak,
    completeCurrentTask,
    completeNow,
    cancelCurrent,
    switchTask
  };
};
