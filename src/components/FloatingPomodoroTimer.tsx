import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router-dom";
import { useAppContext } from "../app/app-context";
import { usePomodoroTiming } from "../app/use-pomodoro-timing";
import { t as translate } from "../i18n";
import { formatTimerRemaining } from "../lib/date";
import { shouldRenderFloatingPomodoro } from "../lib/pomodoro/floating-visibility";

const isBreakSession = (kind: "focus" | "short_break" | "long_break") =>
  kind === "short_break" || kind === "long_break";

export const FloatingPomodoroTimer = () => {
  const { t } = useTranslation("pomodoro");
  const { t: tCommon } = useTranslation("common");
  const { pomodoro, debugEnabled } = useAppContext();
  const { pathname } = useLocation();
  const activeSession = pomodoro.state.activeSession;
  const timing = usePomodoroTiming(activeSession);
  const hasActiveSession = Boolean(activeSession);
  const [selectedTaskId, setSelectedTaskId] = useState<string>("");
  const lastSyncedSourceRef = useRef<string>("");

  const visible = shouldRenderFloatingPomodoro(pomodoro.state, pomodoro.sessions, pathname);

  useEffect(() => {
    if (hasActiveSession) {
      return;
    }

    const currentTaskId = pomodoro.currentTask?.id;
    const preferredTaskId = pomodoro.preferredTask?.id;
    const nextManualTitle = pomodoro.currentActivityLabel ?? pomodoro.preferredActivityLabel ?? "";
    const syncSource = [currentTaskId ?? "", preferredTaskId ?? "", nextManualTitle].join("|");

    if (lastSyncedSourceRef.current === syncSource) {
      return;
    }

    lastSyncedSourceRef.current = syncSource;

    if (currentTaskId && pomodoro.taskOptions.some((task) => task.id === currentTaskId)) {
      setSelectedTaskId(currentTaskId);
      return;
    }

    if (preferredTaskId && pomodoro.taskOptions.some((task) => task.id === preferredTaskId)) {
      setSelectedTaskId(preferredTaskId);
      return;
    }

    setSelectedTaskId("");
  }, [
    hasActiveSession,
    pomodoro.currentActivityLabel,
    pomodoro.currentTask?.id,
    pomodoro.preferredActivityLabel,
    pomodoro.preferredTask?.id,
    pomodoro.taskOptions,
  ]);

  if (!visible) {
    return null;
  }

  const nextSessionIsBreak =
    pomodoro.state.nextSessionKind === "short_break" ||
    pomodoro.state.nextSessionKind === "long_break";
  const preferredLabel = pomodoro.preferredActivityLabel?.trim() || null;

  const handleStartFocus = () => {
    const taskId = selectedTaskId || null;
    const title = taskId ? null : preferredLabel;
    if (nextSessionIsBreak) {
      void pomodoro.startPomodoro({ kind: "focus", taskId, title });
      return;
    }
    void pomodoro.startPomodoro({ taskId, title });
  };

  const handleStartBreak = () => {
    void pomodoro.startPomodoro();
  };

  if (!hasActiveSession || !activeSession) {
    const idleKindClass = nextSessionIsBreak ? pomodoro.state.nextSessionKind : "focus";

    return (
      <aside
        className={`floating-pomodoro floating-pomodoro--idle floating-pomodoro--${idleKindClass}${debugEnabled ? " floating-pomodoro--with-debug" : ""}`}
        aria-label={t("idleLabel")}
      >
        <div className="floating-pomodoro__header">
          <span className="eyebrow">{t("idleLabel")}</span>
          <span className="floating-pomodoro__cycle">
            {t("sessionCycle", { n: pomodoro.state.currentCycleIndex })}
          </span>
        </div>

        <div className="floating-pomodoro__body">
          <p className="floating-pomodoro__idle-summary">
            <span>{t("nextStep")}</span>
            <strong>
              {translate(`kind.${pomodoro.state.nextSessionKind}`, { ns: "pomodoro" })}
            </strong>
            <span aria-hidden="true">·</span>
            <span>{t("sessionCycle", { n: pomodoro.state.currentCycleIndex })}</span>
          </p>

          <label className="floating-pomodoro__task-select">
            <span>{t("timer.linkedTask")}</span>
            <select
              value={selectedTaskId}
              onChange={(event) => setSelectedTaskId(event.target.value)}
            >
              <option value="">{t("timer.noTaskOption")}</option>
              {pomodoro.taskOptions.map((task) => (
                <option key={task.id} value={task.id}>
                  {task.title}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="floating-pomodoro__actions">
          <Link className="button button--ghost" to="/pomodoro">
            {tCommon("actions.open")}
          </Link>

          {nextSessionIsBreak ? (
            <button className="button" type="button" onClick={handleStartBreak}>
              {t("actions.startBreak")}
            </button>
          ) : null}

          <button className="button button--primary" type="button" onClick={handleStartFocus}>
            {t("actions.startFocus")}
          </button>
        </div>
      </aside>
    );
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
