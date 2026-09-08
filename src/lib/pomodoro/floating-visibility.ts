import type { PomodoroSession, PomodoroState } from "../../domain/types";
import { shouldShowFloatingPomodoro } from "./engine";

export const shouldRenderFloatingPomodoro = (
  state: PomodoroState,
  sessions: PomodoroSession[],
  pathname: string,
  nowIso = new Date().toISOString(),
): boolean => pathname !== "/pomodoro" && shouldShowFloatingPomodoro(state, sessions, nowIso);
