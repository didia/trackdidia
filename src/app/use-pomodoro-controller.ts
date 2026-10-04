import { createSerialQueue } from "../lib/serial-queue";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  PomodoroSessionDetails,
  PomodoroState,
  PomodoroTaskSummary,
  Task,
} from "../domain/types";
import { t } from "../i18n";
import { getTodayDate } from "../lib/date";
import { logDebug } from "../lib/debug";
import {
  getPomodoroKindLabel,
  getPomodoroTiming,
  isPomodoroTaskEligible,
} from "../lib/pomodoro/engine";
import {
  notifyPomodoroCompletion,
  playPomodoroChime,
  resolvePomodoroChimeVariant,
  unlockPomodoroSound,
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
  reloadError: string | null;
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

const buildIdleState = (): PomodoroState => ({
  activeSession: null,
  nextSessionKind: "focus",
  completedFocusCountInCycle: 0,
  nextFocusCycleIndex: 1,
  currentCycleIndex: 1,
});

const isBreak = (kind: PomodoroSessionDetails["kind"]): boolean =>
  kind === "short_break" || kind === "long_break";

const POMODORO_LIST_RETRY_DELAY_MS = 1_000;

const withTransientRetry = async <T>(label: string, operation: () => Promise<T>): Promise<T> => {
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
    candidate.listPomodoroTaskSummaries(today),
  ]);
};

interface SessionAction {
  label: string;
  guard?: (session: PomodoroSessionDetails, state: PomodoroState) => boolean;
  perform: (repository: AppRepository, session: PomodoroSessionDetails) => Promise<PomodoroState>;
  announce?: boolean;
  refresh?: "pomodoro" | "everything";
}

/** Shared timer state and serialized persistence orchestration for the application shell. */
export const usePomodoroController = (
  repository: AppRepository | null,
  calendarDay?: string,
): PomodoroControllerValue => {
  const [state, setState] = useState<PomodoroState>(buildIdleState());
  const [sessions, setSessions] = useState<PomodoroSessionDetails[]>([]);
  const [taskSummaries, setTaskSummaries] = useState<PomodoroTaskSummary[]>([]);
  const [allTasks, setAllTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [reloadError, setReloadError] = useState<string | null>(null);
  const stateRef = useRef<PomodoroState>(buildIdleState());
  const repositoryRef = useRef<AppRepository | null>(repository);
  const mountedRef = useRef(false);
  const [queue] = useState(createSerialQueue);
  const snapshotTokenRef = useRef(0);
  const announcedCompletionIdsRef = useRef(new Set<string>());
  const invalidDeadlineKeysRef = useRef(new Set<string>());
  const listRetryTimeoutRef = useRef<number | undefined>(undefined);
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

  const isCurrentRepository = useCallback(
    (candidate: AppRepository) => mountedRef.current && repositoryRef.current === candidate,
    [],
  );

  const announceCompletion = useCallback(
    async (session: Pick<PomodoroSessionDetails, "kind" | "cycleIndex">) => {
      const variant = resolvePomodoroChimeVariant(session.kind, session.cycleIndex);
      await playPomodoroChime(variant);
      await notifyPomodoroCompletion(
        t("pomodoroCompletedTitle", { ns: "notifications" }),
        t("pomodoroCompletedBody", {
          ns: "notifications",
          kind: getPomodoroKindLabel(session.kind),
        }),
      );
    },
    [],
  );

  const runQueued = useCallback(
    async (label: string, operation: () => Promise<void>) => {
      try {
        await queue.run(operation);
      } catch (error) {
        logDebug("error", "pomodoro", `Echec de ${label}`, error);
      }
    },
    [queue],
  );

  const applyState = useCallback(
    (candidate: AppRepository, nextState: PomodoroState) => {
      if (!isCurrentRepository(candidate)) {
        return;
      }
      stateRef.current = nextState;
      setState(nextState);
    },
    [isCurrentRepository],
  );

  const scheduleSnapshotRetry = useCallback(
    (
      candidate: AppRepository,
      token: number,
      retry: (candidate: AppRepository) => Promise<void>,
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
    },
    [clearListRetryTimeout, isCurrentRepository, runQueued],
  );

  const refreshPomodoro = useCallback(
    async (
      candidate: AppRepository,
      nextState?: PomodoroState,
      options?: { scheduleRetry?: boolean },
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
          () => readTodayPomodoroLists(candidate),
        );
      } catch (error) {
        if (options?.scheduleRetry ?? true) {
          scheduleSnapshotRetry(candidate, token, (nextCandidate) =>
            refreshPomodoro(nextCandidate, undefined, { scheduleRetry: false }),
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
    },
    [applyState, clearListRetryTimeout, isCurrentRepository, scheduleSnapshotRetry],
  );

  const refreshEverything = useCallback(
    async (
      candidate: AppRepository,
      showLoading: boolean,
      options?: { scheduleRetry?: boolean },
    ) => {
      const token = ++snapshotTokenRef.current;
      clearListRetryTimeout();
      if (showLoading && isCurrentRepository(candidate)) {
        setLoading(true);
      }

      const today = getTodayDate();
      await candidate.generateDueRecurringTasks(today);
      await candidate.promoteDueScheduledTasks(today);
      const nextState = await candidate.completeExpiredPomodoroSessions();
      applyState(candidate, nextState);
      let nextSessions: PomodoroSessionDetails[];
      let nextSummaries: PomodoroTaskSummary[];
      let nextTasks: Task[];
      try {
        [nextSessions, nextSummaries, nextTasks] = await withTransientRetry(
          "rafraichissement Pomodoro",
          () =>
            Promise.all([
              candidate.listPomodoroSessions(today),
              candidate.listPomodoroTaskSummaries(today),
              candidate.listTasks({ includeCompleted: true }),
            ]),
        );
      } catch (error) {
        if (options?.scheduleRetry ?? true) {
          scheduleSnapshotRetry(candidate, token, (nextCandidate) =>
            refreshEverything(nextCandidate, false, { scheduleRetry: false }),
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
    },
    [applyState, clearListRetryTimeout, isCurrentRepository, scheduleSnapshotRetry],
  );

  useEffect(() => {
    if (!repository) {
      setLoading(false);
      return;
    }
    void runQueued("chargement Pomodoro", async () => refreshEverything(repository, true));
  }, [calendarDay, refreshEverything, repository, runQueued]);

  const completeExpiredSessionIfCurrent = useCallback(
    async (candidate: AppRepository, captured: PomodoroSessionDetails): Promise<boolean> => {
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
          date: captured.date,
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
    },
    [announceCompletion, applyState, isCurrentRepository, refreshPomodoro],
  );

  const reconcileExpiredActiveSession = useCallback(
    async (candidate: AppRepository): Promise<boolean> => {
      const activeSession = stateRef.current.activeSession;
      return activeSession?.status === "running"
        ? completeExpiredSessionIfCurrent(candidate, activeSession)
        : false;
    },
    [completeExpiredSessionIfCurrent],
  );

  const processExpiry = useCallback(
    (candidate: AppRepository, captured: PomodoroSessionDetails) =>
      runQueued("completion automatique d'une session", async () => {
        await completeExpiredSessionIfCurrent(candidate, captured);
      }),
    [completeExpiredSessionIfCurrent, runQueued],
  );

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
          endsAt: activeSession.endsAt,
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
    state.activeSession?.status,
  ]);

  const runSessionAction = useCallback(
    async ({ label, guard, perform, announce = false, refresh = "pomodoro" }: SessionAction) => {
      if (!repository) {
        return;
      }
      await runQueued(label, async () => {
        if (await reconcileExpiredActiveSession(repository)) {
          return;
        }
        const currentState = stateRef.current;
        const activeSession = currentState.activeSession;
        if (
          !isCurrentRepository(repository) ||
          !activeSession ||
          (guard && !guard(activeSession, currentState))
        ) {
          return;
        }
        const nextState = await perform(repository, activeSession);
        applyState(repository, nextState);
        if (announce) {
          await announceCompletion(activeSession);
        }
        if (refresh === "everything") {
          await refreshEverything(repository, false);
        } else {
          await refreshPomodoro(repository, nextState);
        }
      });
    },
    [
      announceCompletion,
      applyState,
      isCurrentRepository,
      reconcileExpiredActiveSession,
      refreshEverything,
      refreshPomodoro,
      repository,
      runQueued,
    ],
  );

  const startPomodoro = useCallback(
    async (options: PomodoroStartOptions = {}) => {
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
    },
    [isCurrentRepository, reconcileExpiredActiveSession, refreshPomodoro, repository, runQueued],
  );

  const pauseCurrent = useCallback(
    () =>
      runSessionAction({
        label: "mise en pause Pomodoro",
        guard: (session) => session.status === "running",
        perform: (candidate, session) => candidate.pausePomodoroSession(session.id),
      }),
    [runSessionAction],
  );

  const resumeCurrent = useCallback(async () => {
    if (!repository) {
      return;
    }
    await unlockPomodoroSound();
    await runSessionAction({
      label: "reprise Pomodoro",
      guard: (session) => session.status === "paused",
      perform: (candidate, session) => candidate.resumePomodoroSession(session.id),
    });
  }, [repository, runSessionAction]);

  const completeNow = useCallback(
    () =>
      runSessionAction({
        label: "completion manuelle Pomodoro",
        guard: (session) => getPomodoroTiming(session, Date.now()).canCompleteNow,
        perform: (candidate, session) => candidate.stopPomodoroSession(session.id, "completed"),
        announce: true,
      }),
    [runSessionAction],
  );

  const completeCurrentTask = useCallback(
    () =>
      runSessionAction({
        label: "completion de la tache Pomodoro",
        guard: (session) =>
          session.status === "running" && session.kind === "focus" && !!session.activeTaskId,
        perform: async (candidate, session) => {
          await candidate.completeTask(session.activeTaskId!);
          return candidate.switchPomodoroTask(session.id, null, null);
        },
        refresh: "everything",
      }),
    [runSessionAction],
  );

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
      const startedState = await repository.startPomodoro({
        kind: stateRef.current.nextSessionKind,
      });
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
  }, [
    announceCompletion,
    applyState,
    isCurrentRepository,
    reconcileExpiredActiveSession,
    refreshPomodoro,
    repository,
    runQueued,
  ]);

  const cancelCurrent = useCallback(
    () =>
      runSessionAction({
        label: "annulation Pomodoro",
        perform: (candidate, session) => candidate.stopPomodoroSession(session.id, "cancelled"),
      }),
    [runSessionAction],
  );

  const switchTask = useCallback(
    (taskId: string | null, title: string | null = null) =>
      runSessionAction({
        label: "changement de tache Pomodoro",
        perform: (candidate, session) => candidate.switchPomodoroTask(session.id, taskId, title),
      }),
    [runSessionAction],
  );

  const reload = useCallback(async () => {
    if (!repository) {
      return;
    }
    await runQueued("rechargement Pomodoro", async () => {
      if (isCurrentRepository(repository)) {
        setReloadError(null);
        setLoading(true);
      }
      try {
        await refreshEverything(repository, false);
      } catch (error) {
        if (isCurrentRepository(repository)) {
          setReloadError("Impossible de rafraichir les taches.");
        }
        throw error;
      } finally {
        if (isCurrentRepository(repository)) {
          setLoading(false);
        }
      }
    });
  }, [isCurrentRepository, refreshEverything, repository, runQueued]);

  const currentActivityLabel = state.activeSession?.activeTaskId
    ? null
    : (state.activeSession?.activeLabel ?? null);
  const currentTask = useMemo(() => {
    const taskId = state.activeSession?.activeTaskId;
    return taskId ? (allTasks.find((task) => task.id === taskId) ?? null) : null;
  }, [allTasks, state.activeSession?.activeTaskId]);
  const latestFocusSession = useMemo(
    () => sessions.find((session) => session.kind === "focus"),
    [sessions],
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
      return {
        task:
          allTasks.find(
            (task) => task.id === latestSegment.taskId && isPomodoroTaskEligible(task),
          ) ?? null,
        label: null,
      };
    }
    return { task: null, label: latestSegment.title ?? null };
  }, [allTasks, currentActivityLabel, currentTask, latestFocusSession]);
  const taskOptions = useMemo(() => allTasks.filter(isPomodoroTaskEligible), [allTasks]);

  return useMemo(
    () => ({
      state,
      sessions,
      taskSummaries,
      taskOptions,
      currentTask,
      currentActivityLabel,
      preferredTask: preferredSelection.task,
      preferredActivityLabel: preferredSelection.label,
      loading,
      reloadError,
      reload,
      startPomodoro,
      pauseCurrent,
      resumeCurrent,
      skipBreak,
      completeCurrentTask,
      completeNow,
      cancelCurrent,
      switchTask,
    }),
    [
      cancelCurrent,
      completeCurrentTask,
      completeNow,
      currentActivityLabel,
      currentTask,
      loading,
      pauseCurrent,
      reloadError,
      preferredSelection,
      reload,
      resumeCurrent,
      sessions,
      skipBreak,
      startPomodoro,
      state,
      switchTask,
      taskOptions,
      taskSummaries,
    ],
  );
};
