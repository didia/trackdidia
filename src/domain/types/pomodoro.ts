export type PomodoroKind = "focus" | "short_break" | "long_break";
export type PomodoroStatus = "running" | "paused" | "completed" | "cancelled";

export interface PomodoroSession {
  id: string;
  kind: PomodoroKind;
  status: PomodoroStatus;
  startedAt: string;
  endsAt: string;
  pausedRemainingMs: number | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cycleIndex: number;
  date: string;
}

export interface PomodoroSegment {
  id: string;
  sessionId: string;
  taskId: string | null;
  title: string | null;
  startedAt: string;
  endedAt: string | null;
}

export interface PomodoroSessionDetails extends PomodoroSession {
  segments: PomodoroSegment[];
  activeTaskId: string | null;
  activeLabel: string | null;
  taskIds: string[];
}

export interface PomodoroState {
  activeSession: PomodoroSessionDetails | null;
  nextSessionKind: PomodoroKind;
  completedFocusCountInCycle: number;
  nextFocusCycleIndex: number;
  currentCycleIndex: number;
}

export interface PomodoroTaskSummary {
  taskId: string | null;
  taskTitle: string;
  projectId: string | null;
  totalSeconds: number;
  sessionCount: number;
}

export interface DailyPomodoroStats {
  date: string;
  completedFocusSessions: number;
}
