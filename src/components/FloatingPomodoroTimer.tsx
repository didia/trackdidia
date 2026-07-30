import { Link } from "react-router-dom";
import { useAppContext } from "../app/app-context";
import { usePomodoroTiming } from "../app/use-pomodoro-timing";
import { formatTimerRemaining } from "../lib/date";
import { getPomodoroKindLabel } from "../lib/pomodoro/engine";

const isBreakSession = (kind: "focus" | "short_break" | "long_break") =>
  kind === "short_break" || kind === "long_break";

export const FloatingPomodoroTimer = () => {
  const { pomodoro, debugEnabled } = useAppContext();
  const activeSession = pomodoro.state.activeSession;
  const timing = usePomodoroTiming(activeSession);
  const hasActiveSession = Boolean(activeSession);

  if (!hasActiveSession || !activeSession) {
    return null;
  }

  const activeLabel =
    pomodoro.currentTask?.title ??
    pomodoro.currentActivityLabel ??
    pomodoro.preferredTask?.title ??
    pomodoro.preferredActivityLabel ??
    "Sans tache assignee";
  const hasBreakSession = isBreakSession(activeSession.kind);
  const isPaused = activeSession.status === "paused";

  return (
    <aside
      className={`floating-pomodoro floating-pomodoro--${activeSession.kind}${debugEnabled ? " floating-pomodoro--with-debug" : ""}`}
      aria-label="Pomodoro actif"
    >
      <div className="floating-pomodoro__header">
        <span className="eyebrow">Pomodoro actif</span>
        <span className="floating-pomodoro__cycle">
          Session {pomodoro.state.currentCycleIndex}/4{isPaused ? " • En pause" : ""}
        </span>
      </div>

      <div className="floating-pomodoro__body">
        <div className="floating-pomodoro__clock">
          <span className="floating-pomodoro__kind">{getPomodoroKindLabel(activeSession.kind)}</span>
          <strong>{timing.valid ? formatTimerRemaining(timing.remainingMs) : "--:--"}</strong>
        </div>

        <div className="floating-pomodoro__summary">
          <span>Tache active</span>
          <strong>{activeLabel}</strong>
          <span>Prochaine etape</span>
          <strong>{getPomodoroKindLabel(pomodoro.state.nextSessionKind)}</strong>
        </div>
      </div>

      <div className="floating-pomodoro__actions">
        <Link className="button button--primary" to="/pomodoro">
          Ouvrir
        </Link>

        {isPaused ? (
          <button className="button" type="button" onClick={() => void pomodoro.resumeCurrent()}>
            Reprendre
          </button>
        ) : hasBreakSession ? (
          <button className="button" type="button" onClick={() => void pomodoro.skipBreak()}>
            Skipper
          </button>
        ) : timing.canCompleteNow ? (
          <button className="button" type="button" onClick={() => void pomodoro.completeNow()}>
            Terminer
          </button>
        ) : (
          <button className="button" type="button" onClick={() => void pomodoro.pauseCurrent()}>
            Pause
          </button>
        )}

        <button className="button button--ghost" type="button" onClick={() => void pomodoro.cancelCurrent()}>
          Annuler
        </button>
      </div>
    </aside>
  );
};
