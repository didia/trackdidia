import { useEffect, useMemo, useState } from "react";
import type { PomodoroSessionDetails } from "../domain/types";
import { getPomodoroTiming, type PomodoroTiming } from "../lib/pomodoro/engine";

/** Local display clock for the two Pomodoro views; it never updates AppProvider state. */
export const usePomodoroTiming = (session: PomodoroSessionDetails | null): PomodoroTiming => {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const timing = useMemo(() => getPomodoroTiming(session, nowMs), [nowMs, session]);

  useEffect(() => {
    setNowMs(Date.now());

    if (!session || session.status !== "running" || !getPomodoroTiming(session, Date.now()).valid) {
      return;
    }

    const intervalId = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(intervalId);
  }, [session?.endsAt, session?.id, session?.pausedRemainingMs, session?.status]);

  return timing;
};
