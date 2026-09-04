import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppContext } from "../app/app-context";
import { usePomodoroTiming } from "../app/use-pomodoro-timing";
import { SectionCard } from "../components/SectionCard";
import type { PomodoroKind } from "../domain/types";
import {
  formatDateLong,
  formatDateTimeShort,
  formatSecondsCompact,
  formatTimerRemaining,
  getTodayDate,
} from "../lib/date";

export const PomodoroPage = () => {
  const { t } = useTranslation("pomodoro");
  const { pomodoro } = useAppContext();
  const [selectedTaskId, setSelectedTaskId] = useState<string>("");
  const [manualTitle, setManualTitle] = useState<string>("");
  const lastSyncedSourceRef = useRef<string>("");

  useEffect(() => {
    if (pomodoro.loading) {
      return;
    }
    void pomodoro.reload();
    // Intentionally omit `pomodoro.loading`: a cold start on this route already
    // runs `refreshEverything` in the controller boot effect.
  }, [pomodoro.reload, pomodoro.loading]);

  useEffect(() => {
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
      setManualTitle("");
      return;
    }

    if (preferredTaskId && pomodoro.taskOptions.some((task) => task.id === preferredTaskId)) {
      setSelectedTaskId(preferredTaskId);
      setManualTitle("");
      return;
    }

    setSelectedTaskId("");
    setManualTitle(nextManualTitle);
  }, [
    pomodoro.currentActivityLabel,
    pomodoro.currentTask?.id,
    pomodoro.preferredActivityLabel,
    pomodoro.preferredTask?.id,
    pomodoro.taskOptions,
  ]);

  const activeSession = pomodoro.state.activeSession;
  const timing = usePomodoroTiming(activeSession);
  const hasActiveSession = Boolean(activeSession);
  const hasRunningSession = Boolean(hasActiveSession && activeSession?.status === "running");
  const hasPausedSession = Boolean(hasActiveSession && activeSession?.status === "paused");
  const hasLiveFocusSession = Boolean(hasRunningSession && activeSession?.kind === "focus");
  const hasPausedFocusSession = Boolean(hasPausedSession && activeSession?.kind === "focus");
  const nextSessionIsBreak =
    pomodoro.state.nextSessionKind === "short_break" ||
    pomodoro.state.nextSessionKind === "long_break";
  const hasLiveBreakSession = Boolean(
    hasRunningSession &&
      activeSession &&
      (activeSession.kind === "short_break" || activeSession.kind === "long_break"),
  );
  const hasPausedBreakSession = Boolean(
    hasPausedSession &&
      activeSession &&
      (activeSession.kind === "short_break" || activeSession.kind === "long_break"),
  );
  const canSkipBreak =
    hasLiveBreakSession || hasPausedBreakSession || (!hasActiveSession && nextSessionIsBreak);
  const canEditManualTitle =
    !selectedTaskId &&
    (!hasActiveSession || (activeSession?.kind === "focus" && activeSession.status === "running"));
  const canStartNextSession = !hasActiveSession;
  const nextActionLabel =
    pomodoro.state.nextSessionKind === "focus" ? t("actions.startFocus") : t("actions.startBreak");
  const kindLabel = (kind: PomodoroKind) => t(`kind.${kind}`);
  const sessionLabel =
    hasActiveSession && activeSession
      ? kindLabel(activeSession.kind)
      : kindLabel(pomodoro.state.nextSessionKind);
  const taskLookup = useMemo(
    () => new Map(pomodoro.taskOptions.map((task) => [task.id, task.title] as const)),
    [pomodoro.taskOptions],
  );
  const resolveSegmentLabel = (taskId: string | null, title: string | null) =>
    taskId ? (taskLookup.get(taskId) ?? t("unknownTask")) : title?.trim() || t("untitled");

  return (
    <div className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">{t("hero.eyebrow")}</p>
          <h2>{formatDateLong(getTodayDate())}</h2>
          <p className="hero__copy">{t("hero.copy")}</p>
        </div>
      </header>

      <SectionCard
        title={t("timer.title")}
        subtitle={t("timer.subtitle")}
        aside={
          <button
            className="button"
            type="button"
            disabled={pomodoro.loading}
            onClick={() => void pomodoro.reload()}
          >
            {t("timer.refresh")}
          </button>
        }
      >
        {pomodoro.reloadError ? <p className="empty-copy">{pomodoro.reloadError}</p> : null}
        <div className="pomodoro-panel">
          <div
            className={`pomodoro-clock${activeSession ? ` pomodoro-clock--${activeSession.kind}` : ""}`}
          >
            <span className="pomodoro-clock__label">{sessionLabel}</span>
            <strong>
              {hasActiveSession && activeSession
                ? timing.valid
                  ? formatTimerRemaining(timing.remainingMs)
                  : t("timerPlaceholder")
                : t("idleTimer")}
            </strong>
            <span className="pomodoro-clock__cycle">
              {t("sessionCycle", { n: pomodoro.state.currentCycleIndex })}
              {hasPausedSession ? t("pausedSuffix") : ""}
            </span>
          </div>

          <div className="pomodoro-panel__controls">
            <div className="status-grid">
              <article className="status-card">
                <span>{t("activeTask")}</span>
                <strong>
                  {pomodoro.currentTask?.title ??
                    pomodoro.currentActivityLabel ??
                    pomodoro.preferredTask?.title ??
                    pomodoro.preferredActivityLabel ??
                    t("noTaskAssigned")}
                </strong>
              </article>
              <article className="status-card">
                <span>{t("nextStep")}</span>
                <strong>{kindLabel(pomodoro.state.nextSessionKind)}</strong>
              </article>
              <article className="status-card">
                <span>{t("timer.focusCompleted")}</span>
                <strong>{pomodoro.state.completedFocusCountInCycle}</strong>
              </article>
            </div>

            <label className="stacked-field">
              <span>{t("timer.linkedTask")}</span>
              <select
                value={selectedTaskId}
                disabled={Boolean(
                  hasActiveSession &&
                    (activeSession?.kind !== "focus" || activeSession.status !== "running"),
                )}
                onChange={async (event) => {
                  const nextTaskId = event.target.value;
                  setSelectedTaskId(nextTaskId);
                  if (nextTaskId) {
                    setManualTitle("");
                  }

                  if (hasRunningSession && activeSession?.kind === "focus") {
                    await pomodoro.switchTask(
                      nextTaskId || null,
                      nextTaskId ? null : manualTitle.trim() || null,
                    );
                  }
                }}
              >
                <option value="">{t("timer.noTaskOption")}</option>
                {pomodoro.taskOptions.map((task) => (
                  <option key={task.id} value={task.id}>
                    {task.title}
                  </option>
                ))}
              </select>
            </label>

            {!selectedTaskId ? (
              <label className="stacked-field">
                <span>{t("timer.manualTitle")}</span>
                <div className="inline-field">
                  <input
                    type="text"
                    value={manualTitle}
                    disabled={!canEditManualTitle}
                    placeholder={t("timer.manualPlaceholder")}
                    onChange={(event) => setManualTitle(event.target.value)}
                  />
                  <button
                    className="button"
                    type="button"
                    disabled={!canEditManualTitle || !hasLiveFocusSession}
                    onClick={() => {
                      if (hasLiveFocusSession) {
                        void pomodoro.switchTask(null, manualTitle.trim() || null);
                      }
                    }}
                  >
                    {t("timer.apply")}
                  </button>
                </div>
              </label>
            ) : null}

            <div className="form-actions">
              {canStartNextSession ? (
                <button
                  className="button button--primary"
                  type="button"
                  onClick={() =>
                    void pomodoro.startPomodoro({
                      taskId:
                        pomodoro.state.nextSessionKind === "focus" ? selectedTaskId || null : null,
                      title:
                        pomodoro.state.nextSessionKind === "focus" && !selectedTaskId
                          ? manualTitle.trim() || null
                          : null,
                    })
                  }
                >
                  {nextActionLabel}
                </button>
              ) : null}

              {hasRunningSession ? (
                <button
                  className="button"
                  type="button"
                  onClick={() => void pomodoro.pauseCurrent()}
                >
                  {t("actions.pause")}
                </button>
              ) : null}

              {hasPausedSession ? (
                <button
                  className="button button--primary"
                  type="button"
                  onClick={() => void pomodoro.resumeCurrent()}
                >
                  {t("actions.resume")}
                </button>
              ) : null}

              {canSkipBreak ? (
                <button className="button" type="button" onClick={() => void pomodoro.skipBreak()}>
                  {t("actions.skipBreak")}
                </button>
              ) : null}

              {hasLiveFocusSession && pomodoro.currentTask ? (
                <button
                  className="button"
                  type="button"
                  onClick={() => void pomodoro.completeCurrentTask()}
                >
                  {t("actions.completeTask")}
                </button>
              ) : null}

              {hasLiveFocusSession || hasPausedFocusSession ? (
                <>
                  <button
                    className="button"
                    type="button"
                    disabled={!timing.canCompleteNow}
                    onClick={() => void pomodoro.completeNow()}
                  >
                    {t("actions.completeNow")}
                  </button>
                  <button
                    className="button button--ghost"
                    type="button"
                    onClick={() => void pomodoro.cancelCurrent()}
                  >
                    {t("actions.cancel")}
                  </button>
                </>
              ) : null}

              {hasLiveBreakSession || hasPausedBreakSession ? (
                <button
                  className="button button--ghost"
                  type="button"
                  onClick={() => void pomodoro.cancelCurrent()}
                >
                  {t("actions.cancel")}
                </button>
              ) : null}
            </div>

            {hasActiveSession ? (
              <p className="field-card__helper">
                {hasPausedSession
                  ? t("helper.paused")
                  : hasLiveFocusSession
                    ? timing.canCompleteNow
                      ? t("helper.focusCompletable")
                      : t("helper.focusEarly")
                    : t("helper.break")}
              </p>
            ) : null}
          </div>
        </div>
      </SectionCard>

      <SectionCard title={t("history.title")} subtitle={t("history.subtitle")}>
        {pomodoro.sessions.length === 0 ? (
          <p className="empty-copy">{t("history.empty")}</p>
        ) : (
          <div className="pomodoro-history">
            {pomodoro.sessions.map((session) => (
              <article key={session.id} className="pomodoro-history__item">
                <div className="pomodoro-history__header">
                  <strong>{kindLabel(session.kind)}</strong>
                  <span>
                    {formatDateTimeShort(session.startedAt)} → {formatDateTimeShort(session.endsAt)}
                  </span>
                </div>
                <span
                  className={`pomodoro-history__status pomodoro-history__status--${session.status}`}
                >
                  {t(`history.${session.status}`)}
                </span>
                <div className="pomodoro-history__segments">
                  {session.segments.length === 0 ? (
                    <span>{t("history.noSegments")}</span>
                  ) : (
                    session.segments.map((segment) => (
                      <span key={segment.id} className="tag-chip">
                        {resolveSegmentLabel(segment.taskId, segment.title)}
                      </span>
                    ))
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </SectionCard>

      <SectionCard title={t("summary.title")} subtitle={t("summary.subtitle")}>
        {pomodoro.taskSummaries.length === 0 ? (
          <p className="empty-copy">{t("summary.empty")}</p>
        ) : (
          <div className="pomodoro-summary-list">
            {pomodoro.taskSummaries.map((summary) => (
              <article
                key={`${summary.taskId ?? "none"}-${summary.taskTitle}`}
                className="status-card"
              >
                <span>{summary.taskTitle}</span>
                <strong>{formatSecondsCompact(summary.totalSeconds)}</strong>
                <small>{t("summary.sessionCount", { count: summary.sessionCount })}</small>
              </article>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
};
