import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useAppContext } from "../app/app-context";
import { usePomodoroTiming } from "../app/use-pomodoro-timing";
import { t as translate } from "../i18n";
import { formatTimerRemaining } from "../lib/date";

const isBreakSession = (kind: "focus" | "short_break" | "long_break") =>
  kind === "short_break" || kind === "long_break";

export const FloatingPomodoroTimer = () => {
  const { t } = useTranslation("pomodoro");
  const { t: tCommon } = useTranslation("common");
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
    t("noTaskAssigned");
  const hasBreakSession = isBreakSession(activeSession.kind);
  const isPaused = activeSession.status === "paused";

  return (
    <aside
      className={`floating-pomodoro floating-pomodoro--${activeSession.kind}${debugEnabled ? " floating-pomodoro--with-debug" : ""}`}
      aria-label={t("activeLabel")}
    >
      <div className="floating-pomodoro__header">
        <span className="eyebrow">{t("activeLabel")}</span>
        <span className="floating-pomodoro__cycle">
          {t("sessionCycle", { n: pomodoro.state.currentCycleIndex })}
          {isPaused ? t("pausedSuffix") : ""}
        </span>
      </div>

      <div className="floating-pomodoro__body">
        <div className="floating-pomodoro__clock">
          <span className="floating-pomodoro__kind">
            {translate(`kind.${activeSession.kind}`, { ns: "pomodoro" })}
          </span>
          <strong>
            {timing.valid ? formatTimerRemaining(timing.remainingMs) : t("timerPlaceholder")}
          </strong>
        </div>

        <div className="floating-pomodoro__summary">
          <span>{t("activeTask")}</span>
          <strong>{activeLabel}</strong>
          <span>{t("nextStep")}</span>
          <strong>{translate(`kind.${pomodoro.state.nextSessionKind}`, { ns: "pomodoro" })}</strong>
        </div>
      </div>

      <div className="floating-pomodoro__actions">
        <Link className="button button--primary" to="/pomodoro">
          {tCommon("actions.open")}
        </Link>

        {isPaused ? (
          <button className="button" type="button" onClick={() => void pomodoro.resumeCurrent()}>
            {tCommon("actions.resume")}
          </button>
        ) : hasBreakSession ? (
          <button className="button" type="button" onClick={() => void pomodoro.skipBreak()}>
            {t("actions.skip")}
          </button>
        ) : timing.canCompleteNow ? (
          <button className="button" type="button" onClick={() => void pomodoro.completeNow()}>
            {t("actions.complete")}
          </button>
        ) : (
          <button className="button" type="button" onClick={() => void pomodoro.pauseCurrent()}>
            {tCommon("actions.pause")}
          </button>
        )}

        <button
          className="button button--ghost"
          type="button"
          onClick={() => void pomodoro.cancelCurrent()}
        >
          {tCommon("actions.cancel")}
        </button>
      </div>
    </aside>
  );
};
