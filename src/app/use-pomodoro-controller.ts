import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PomodoroSessionDetails, PomodoroState, PomodoroTaskSummary, Task } from "../domain/types";
import { getTodayDate } from "../lib/date";
import { logDebug } from "../lib/debug";
import { getPomodoroTiming, getPomodoroKindLabel } from "../lib/pomodoro/engine";
import {
  notifyPomodoroCompletion,
  playPomodoroChime,
  resolvePomodoroChimeVariant,
  unlockPomodoroSound
} from "../lib/pomodoro/sound";
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
  loading: boolean;
  reload: () => Promise<void>;
  startPomodoro: (options?: PomodoroStartOptions) => Promise<void>;
  pauseCurrent: () => Promise<void>;
  resumeCurrent: () => Promise<void>;
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

const isBreak = (kind: PomodoroSessionDetails["kind"]): boolean => kind === "short_break" || kind === "long_break";

const POMODORO_LIST_RETRY_DELAY_MS = 1_000;

const withTransientRetry = async <T,>(label: string, operation: () => Promise<T>): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    logDebug("error", "pomodoro", `Echec transitoire de ${label}`, error);
    return operation();
  }
};

const readTodayPomodoroLists = (candidate: AppRepository) => {
  const today = getTodayDate();
  return Promise.all([
    candidate.listPomodoroSessions(today),
    candidate.listPomodoroTaskSummaries(today)
  ]);
};

/** Shared timer state and serialized persistence orchestration for the application shell. */
export const usePomodoroController = (repository: AppRepository | null): PomodoroControllerValue => {
  const [state, setState] = useState<PomodoroState>(buildIdleState());
  const [sessions, setSessions] = useState<PomodoroSessionDetails[]>([]);
  const [taskSummaries, setTaskSummaries] = useState<PomodoroTaskSummary[]>([]);
  const [allTasks, setAllTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const stateRef = useRef<PomodoroState>(buildIdleState());
  const repositoryRef = useRef<AppRepository | null>(repository);
  const mountedRef = useRef(false);
  const queueRef = useRef<Promise<void>>(Promise.resolve());
  const snapshotTokenRef = useRef(0);
  const announcedCompletionIdsRef = useRef(new Set<string>());
  const invalidDeadlineKeysRef = useRef(new Set<string>());
  const listRetryTimeoutRef = useRef<number | undefined>(undefined);
  const refreshPomodoroRef = useRef<(
    candidate: AppRepository,
    nextState?: PomodoroState,
    options?: { scheduleRetry?: boolean }
  ) => Promise<void>>(async () => undefined);
  const refreshEverythingRef = useRef<(
    candidate: AppRepository,
    showLoading: boolean,
    options?: { scheduleRetry?: boolean }
  ) => Promise<void>>(async () => undefined);

  repositoryRef.current = repository;

  const clearListRetryTimeout = useCallback(() => {
    if (listRetryTimeoutRef.current !== undefined) {
      window.clearTimeout(listRetryTimeoutRef.current);
      listRetryTimeoutRef.current = undefined;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      snapshotTokenRef.current += 1;
      clearListRetryTimeout();
    };
  }, [clearListRetryTimeout]);

  useEffect(() => {
    snapshotTokenRef.current += 1;
    announcedCompletionIdsRef.current = new Set();
    invalidDeadlineKeysRef.current = new Set();
    clearListRetryTimeout();
  }, [clearListRetryTimeout, repository]);

  const isCurrentRepository = useCallback((candidate: AppRepository) =>
    mountedRef.current && repositoryRef.current === candidate, []);

  const announceCompletion = useCallback(async (session: Pick<PomodoroSessionDetails, "kind" | "cycleIndex">) => {
    const variant = resolvePomodoroChimeVariant(session.kind, session.cycleIndex);
    await playPomodoroChime(variant);
    await notifyPomodoroCompletion(
      "Session Pomodoro terminee",
      `${getPomodoroKindLabel(session.kind)} terminee.`
    );
  }, []);

  const enqueue = useCallback(<T,>(operation: () => Promise<T>): Promise<T> => {
    const run = queueRef.current.then(operation);
    // Keep later work runnable even if a caller observes (or ignores) a rejected action.
    queueRef.current = run.then(() => undefined, () => undefined);
    return run;
  }, []);

  const runQueued = useCallback(async (label: string, operation: () => Promise<void>) => {
    try {
      await enqueue(operation);
    } catch (error) {
      logDebug("error", "pomodoro", `Echec de ${label}`, error);
    }
  }, [enqueue]);

  const applyState = useCallback((candidate: AppRepository, nextState: PomodoroState) => {
    if (!isCurrentRepository(candidate)) {
      return;
    }
    stateRef.current = nextState;
    setState(nextState);
  }, [isCurrentRepository]);

  const scheduleSnapshotRetry = useCallback((
    candidate: AppRepository,
    token: number,
    retry: (candidate: AppRepository) => Promise<void>
  ) => {
    if (!isCurrentRepository(candidate) || token !== snapshotTokenRef.current) {
      return;
    }
    clearListRetryTimeout();
    listRetryTimeoutRef.current = window.setTimeout(() => {
      listRetryTimeoutRef.current = undefined;
      void runQueued("rafraichissement des listes Pomodoro", async () => {
        await retry(candidate);
      });
    }, POMODORO_LIST_RETRY_DELAY_MS);
  }, [clearListRetryTimeout, isCurrentRepository, runQueued]);

  const refreshPomodoro = useCallback(async (
    candidate: AppRepository,
    nextState?: PomodoroState,
    options?: { scheduleRetry?: boolean }
  ) => {
    const token = ++snapshotTokenRef.current;
    clearListRetryTimeout();
    if (nextState) {
      applyState(candidate, nextState);
    }

    let nextSessions: PomodoroSessionDetails[];
    let nextSummaries: PomodoroTaskSummary[];
    try {
      [nextSessions, nextSummaries] = await withTransientRetry(
        "rafraichissement des listes Pomodoro",
        () => readTodayPomodoroLists(candidate)
      );
    } catch (error) {
      if (options?.scheduleRetry ?? true) {
        scheduleSnapshotRetry(candidate, token, (nextCandidate) =>
          refreshPomodoroRef.current(nextCandidate, undefined, { scheduleRetry: false })
        );
      }
      throw error;
    }

    if (!isCurrentRepository(candidate) || token !== snapshotTokenRef.current) {
      return;
    }
    setSessions(nextSessions);
    setTaskSummaries(nextSummaries);
    setLoading(false);
  }, [applyState, clearListRetryTimeout, isCurrentRepository, scheduleSnapshotRetry]);

  const refreshEverything = useCallback(async (
    candidate: AppRepository,
    showLoading: boolean,
    options?: { scheduleRetry?: boolean }
  ) => {
    const token = ++snapshotTokenRef.current;
    clearListRetryTimeout();
    if (showLoading && isCurrentRepository(candidate)) {
      setLoading(true);
    }

    const today = getTodayDate();
    await candidate.generateDueRecurringTasks(today);
    const nextState = await candidate.completeExpiredPomodoroSessions();
    applyState(candidate, nextState);
    let nextSessions: PomodoroSessionDetails[];
    let nextSummaries: PomodoroTaskSummary[];
    let nextTasks: Task[];
    try {
      [nextSessions, nextSummaries, nextTasks] = await withTransientRetry(
        "rafraichissement Pomodoro",
        () => Promise.all([
          candidate.listPomodoroSessions(today),
          candidate.listPomodoroTaskSummaries(today),
          candidate.listTasks({ includeCompleted: true })
        ])
      );
    } catch (error) {
      if (options?.scheduleRetry ?? true) {
        scheduleSnapshotRetry(candidate, token, (nextCandidate) =>
          refreshEverythingRef.current(nextCandidate, false, { scheduleRetry: false })
        );
      }
      throw error;
    }

    if (!isCurrentRepository(candidate) || token !== snapshotTokenRef.current) {
      return;
    }
    setSessions(nextSessions);
    setTaskSummaries(nextSummaries);
    setAllTasks(nextTasks);
    setLoading(false);
  }, [applyState, clearListRetryTimeout, isCurrentRepository, scheduleSnapshotRetry]);

  refreshPomodoroRef.current = refreshPomodoro;
  refreshEverythingRef.current = refreshEverything;

  useEffect(() => {
    if (!repository) {
      setLoading(false);
      return;
    }
    void runQueued("chargement Pomodoro", async () => refreshEverything(repository, true));
  }, [refreshEverything, repository, runQueued]);

  const completeExpiredSessionIfCurrent = useCallback(async (
    candidate: AppRepository,
    captured: PomodoroSessionDetails
  ): Promise<boolean> => {
    if (!isCurrentRepository(candidate)) {
      return false;
    }
    const activeSession = stateRef.current.activeSession;
    if (
      !activeSession ||
      activeSession.id !== captured.id ||
      activeSession.status !== "running" ||
      activeSession.endsAt !== captured.endsAt
    ) {
      return false;
    }
    const timing = getPomodoroTiming(activeSession, Date.now());
    if (!timing.valid || timing.remainingMs > 0) {
      return false;
    }

    const nextState = await candidate.completeExpiredPomodoroSessions();
    // Verify the exact persisted local-date record before publishing a null state. If this
    // read fails, stateRef remains running and the next reconciliation can safely retry.
    const persistedSessions = await candidate.listPomodoroSessions(captured.date);
    const persisted = persistedSessions.find((session) => session.id === captured.id);
    if (persisted?.status !== "completed") {
      logDebug("error", "pomodoro", "Session expiree non verifiee apres persistance", {
        sessionId: captured.id,
        date: captured.date
      });
      return true;
    }

    applyState(candidate, nextState);
    if (!announcedCompletionIdsRef.current.has(captured.id)) {
      announcedCompletionIdsRef.current.add(captured.id);
      await announceCompletion(captured);
    }
    await refreshPomodoro(candidate);
    return true;
  }, [announceCompletion, applyState, isCurrentRepository, refreshPomodoro]);

  const reconcileExpiredActiveSession = useCallback(async (candidate: AppRepository): Promise<boolean> => {
    const activeSession = stateRef.current.activeSession;
    return activeSession?.status === "running"
      ? completeExpiredSessionIfCurrent(candidate, activeSession)
      : false;
  }, [completeExpiredSessionIfCurrent]);

  const processExpiry = useCallback((candidate: AppRepository, captured: PomodoroSessionDetails) =>
    runQueued("completion automatique d'une session", async () => {
      await completeExpiredSessionIfCurrent(candidate, captured);
    }),
  [completeExpiredSessionIfCurrent, runQueued]);

  useEffect(() => {
    const activeSession = state.activeSession;
    if (!repository || !activeSession || activeSession.status !== "running") {
      return;
    }

    const timing = getPomodoroTiming(activeSession, Date.now());
    if (!timing.valid) {
      const key = `${activeSession.id}:${activeSession.endsAt}`;
      if (!invalidDeadlineKeysRef.current.has(key)) {
        invalidDeadlineKeysRef.current.add(key);
        logDebug("error", "pomodoro", "Deadline Pomodoro invalide; aucun planificateur active", {
          sessionId: activeSession.id,
          endsAt: activeSession.endsAt
        });
      }
      return;
    }

    let timeoutId: number | undefined;
    const reconcile = () => {
      const current = stateRef.current.activeSession;
      if (!current || current.id !== activeSession.id || current.status !== "running") {
        return;
      }
      const currentTiming = getPomodoroTiming(current, Date.now());
      if (!currentTiming.valid) {
        return;
      }
      const deadlineRemainingMs = new Date(current.endsAt).getTime() - Date.now();
      if (deadlineRemainingMs <= 0) {
        void processExpiry(repository, current);
        return;
      }
      window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(reconcile, Math.min(deadlineRemainingMs, 2_147_483_647));
    };
    const reconcileWhenVisible = () => {
      if (document.visibilityState === "visible") {
        reconcile();
      }
    };

    reconcile();
    const intervalId = window.setInterval(reconcile, 30_000);
    window.addEventListener("focus", reconcile);
    document.addEventListener("visibilitychange", reconcileWhenVisible);
    return () => {
      window.clearTimeout(timeoutId);
      window.clearInterval(intervalId);
      window.removeEventListener("focus", reconcile);
      document.removeEventListener("visibilitychange", reconcileWhenVisible);
    };
  }, [
    processExpiry,
    repository,
    state.activeSession?.endsAt,
    state.activeSession?.id,
    state.activeSession?.status
  ]);

  const startPomodoro = useCallback(async (options: PomodoroStartOptions = {}) => {
    if (!repository) {
      return;
    }
    await unlockPomodoroSound();
    await runQueued("demarrage Pomodoro", async () => {
      if (await reconcileExpiredActiveSession(repository)) {
        return;
      }
      if (!isCurrentRepository(repository) || stateRef.current.activeSession) {
        return;
      }
      const nextState = await repository.startPomodoro(options);
      await refreshPomodoro(repository, nextState);
    });
  }, [isCurrentRepository, reconcileExpiredActiveSession, refreshPomodoro, repository, runQueued]);

  const pauseCurrent = useCallback(async () => {
    if (!repository) {
      return;
    }
    await runQueued("mise en pause Pomodoro", async () => {
      if (await reconcileExpiredActiveSession(repository)) {
        return;
      }
      const activeSession = stateRef.current.activeSession;
      if (!isCurrentRepository(repository) || !activeSession || activeSession.status !== "running") {
        return;
      }
      const nextState = await repository.pausePomodoroSession(activeSession.id);
      await refreshPomodoro(repository, nextState);
    });
  }, [isCurrentRepository, reconcileExpiredActiveSession, refreshPomodoro, repository, runQueued]);

  const resumeCurrent = useCallback(async () => {
    if (!repository) {
      return;
    }
    await unlockPomodoroSound();
    await runQueued("reprise Pomodoro", async () => {
      const activeSession = stateRef.current.activeSession;
      if (!isCurrentRepository(repository) || !activeSession || activeSession.status !== "paused") {
        return;
      }
      const nextState = await repository.resumePomodoroSession(activeSession.id);
      await refreshPomodoro(repository, nextState);
    });
  }, [isCurrentRepository, refreshPomodoro, repository, runQueued]);

  const completeNow = useCallback(async () => {
    if (!repository) {
      return;
    }
    await runQueued("completion manuelle Pomodoro", async () => {
      if (await reconcileExpiredActiveSession(repository)) {
        return;
      }
      const activeSession = stateRef.current.activeSession;
      if (!isCurrentRepository(repository) || !activeSession || !getPomodoroTiming(activeSession, Date.now()).canCompleteNow) {
        return;
      }
      const nextState = await repository.stopPomodoroSession(activeSession.id, "completed");
      applyState(repository, nextState);
      await announceCompletion(activeSession);
      await refreshPomodoro(repository, nextState);
    });
  }, [announceCompletion, applyState, isCurrentRepository, reconcileExpiredActiveSession, refreshPomodoro, repository, runQueued]);

  const completeCurrentTask = useCallback(async () => {
    if (!repository) {
      return;
    }
    await runQueued("completion de la tache Pomodoro", async () => {
      if (await reconcileExpiredActiveSession(repository)) {
        return;
      }
      const activeSession = stateRef.current.activeSession;
      const currentTaskId = activeSession?.activeTaskId;
      if (!isCurrentRepository(repository) || !activeSession || activeSession.status !== "running" || activeSession.kind !== "focus" || !currentTaskId) {
        return;
      }
      await repository.completeTask(currentTaskId);
      const nextState = await repository.switchPomodoroTask(activeSession.id, null, null);
      applyState(repository, nextState);
      await refreshEverything(repository, false);
    });
  }, [applyState, isCurrentRepository, reconcileExpiredActiveSession, refreshEverything, repository, runQueued]);

  const skipBreak = useCallback(async () => {
    if (!repository) {
      return;
    }
    await runQueued("saut de pause Pomodoro", async () => {
      if (!isCurrentRepository(repository)) {
        return;
      }
      if (await reconcileExpiredActiveSession(repository)) {
        return;
      }
      const activeSession = stateRef.current.activeSession;
      if (activeSession && isBreak(activeSession.kind)) {
        const nextState = await repository.stopPomodoroSession(activeSession.id, "completed");
        applyState(repository, nextState);
        await announceCompletion(activeSession);
        await refreshPomodoro(repository, nextState);
        return;
      }
      if (activeSession || !isBreak(stateRef.current.nextSessionKind)) {
        return;
      }
      const startedState = await repository.startPomodoro({ kind: stateRef.current.nextSessionKind });
      applyState(repository, startedState);
      const startedBreak = startedState.activeSession;
      if (!startedBreak) {
        await refreshPomodoro(repository, startedState);
        return;
      }
      const nextState = await repository.stopPomodoroSession(startedBreak.id, "completed");
      applyState(repository, nextState);
      await announceCompletion(startedBreak);
      await refreshPomodoro(repository, nextState);
    });
  }, [announceCompletion, applyState, isCurrentRepository, reconcileExpiredActiveSession, refreshPomodoro, repository, runQueued]);

  const cancelCurrent = useCallback(async () => {
    if (!repository) {
      return;
    }
    await runQueued("annulation Pomodoro", async () => {
      if (await reconcileExpiredActiveSession(repository)) {
        return;
      }
      const activeSession = stateRef.current.activeSession;
      if (!isCurrentRepository(repository) || !activeSession) {
        return;
      }
      const nextState = await repository.stopPomodoroSession(activeSession.id, "cancelled");
      await refreshPomodoro(repository, nextState);
    });
  }, [isCurrentRepository, reconcileExpiredActiveSession, refreshPomodoro, repository, runQueued]);

  const switchTask = useCallback(async (taskId: string | null, title: string | null = null) => {
    if (!repository) {
      return;
    }
    await runQueued("changement de tache Pomodoro", async () => {
      if (await reconcileExpiredActiveSession(repository)) {
        return;
      }
      const activeSession = stateRef.current.activeSession;
      if (!isCurrentRepository(repository) || !activeSession) {
        return;
      }
      const nextState = await repository.switchPomodoroTask(activeSession.id, taskId, title);
      await refreshPomodoro(repository, nextState);
    });
  }, [isCurrentRepository, reconcileExpiredActiveSession, refreshPomodoro, repository, runQueued]);

  const reload = useCallback(async () => {
    if (!repository) {
      return;
    }
    await runQueued("rechargement Pomodoro", async () => refreshEverything(repository, false));
  }, [refreshEverything, repository, runQueued]);

  const currentActivityLabel = state.activeSession?.activeTaskId ? null : state.activeSession?.activeLabel ?? null;
  const currentTask = useMemo(() => {
    const taskId = state.activeSession?.activeTaskId;
    return taskId ? allTasks.find((task) => task.id === taskId) ?? null : null;
  }, [allTasks, state.activeSession?.activeTaskId]);
  const latestFocusSession = useMemo(() => sessions.find((session) => session.kind === "focus"), [sessions]);
  const preferredSelection = useMemo(() => {
    if (currentTask || currentActivityLabel) {
      return { task: currentTask, label: currentActivityLabel };
    }
    const latestSegment = latestFocusSession?.segments.at(-1) ?? null;
    if (!latestSegment) {
      return { task: null, label: null };
    }
    if (latestSegment.taskId) {
      return {
        task: allTasks.find((task) => task.id === latestSegment.taskId && isPomodoroTaskEligible(task)) ?? null,
        label: null
      };
    }
    return { task: null, label: latestSegment.title ?? null };
  }, [allTasks, currentActivityLabel, currentTask, latestFocusSession]);
  const taskOptions = useMemo(() => allTasks.filter(isPomodoroTaskEligible), [allTasks]);

  return useMemo(() => ({
    state,
    sessions,
    taskSummaries,
    taskOptions,
    currentTask,
    currentActivityLabel,
    preferredTask: preferredSelection.task,
    preferredActivityLabel: preferredSelection.label,
    loading,
    reload,
    startPomodoro,
    pauseCurrent,
    resumeCurrent,
    skipBreak,
    completeCurrentTask,
    completeNow,
    cancelCurrent,
    switchTask
  }), [
    cancelCurrent,
    completeCurrentTask,
    completeNow,
    currentActivityLabel,
    currentTask,
    loading,
    pauseCurrent,
    preferredSelection,
    reload,
    resumeCurrent,
    sessions,
    skipBreak,
    startPomodoro,
    state,
    switchTask,
    taskOptions,
    taskSummaries
  ]);
};
