import { useEffect, useMemo, useRef, useState } from "react";
import { useAppContext } from "../app/app-context";
import { SectionCard } from "../components/SectionCard";
import { formatDateLong, formatDateTimeShort, formatSecondsCompact, formatTimerRemaining, getTodayDate } from "../lib/date";
import { getPomodoroKindLabel } from "../lib/pomodoro/engine";

export const PomodoroPage = () => {
  const { pomodoro } = useAppContext();
  const [selectedTaskId, setSelectedTaskId] = useState<string>("");
  const [manualTitle, setManualTitle] = useState<string>("");
  const lastSyncedSourceRef = useRef<string>("");

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
    pomodoro.taskOptions
  ]);

  const activeSession = pomodoro.state.activeSession;
  const hasLiveSession = Boolean(activeSession && pomodoro.remainingMs > 0);
  const hasLiveFocusSession = Boolean(hasLiveSession && activeSession?.kind === "focus");
  const nextSessionIsBreak = pomodoro.state.nextSessionKind === "short_break" || pomodoro.state.nextSessionKind === "long_break";
  const hasLiveBreakSession = Boolean(hasLiveSession && activeSession && (activeSession.kind === "short_break" || activeSession.kind === "long_break"));
  const canSkipBreak = hasLiveBreakSession || (!hasLiveSession && nextSessionIsBreak);
  const canEditManualTitle = !selectedTaskId && (!hasLiveSession || activeSession?.kind === "focus");
  const canStartNextSession = !hasLiveSession;
  const nextActionLabel = pomodoro.state.nextSessionKind === "focus" ? "Demarrer un focus" : "Demarrer la pause";
  const sessionLabel = hasLiveSession && activeSession ? getPomodoroKindLabel(activeSession.kind) : getPomodoroKindLabel(pomodoro.state.nextSessionKind);
  const taskLookup = useMemo(
    () => new Map(pomodoro.taskOptions.map((task) => [task.id, task.title] as const)),
    [pomodoro.taskOptions]
  );
  const resolveSegmentLabel = (taskId: string | null, title: string | null) =>
    taskId ? taskLookup.get(taskId) ?? "Tache inconnue" : title?.trim() || "Sans titre";

  return (
    <div className="page">
      <header className="hero">
        <div>
          <p className="eyebrow">Pomodoro</p>
          <h2>{formatDateLong(getTodayDate())}</h2>
          <p className="hero__copy">
            Un cycle de focus integre a Trackdidia, lie a tes taches GTD et a ta metrique quotidienne.
          </p>
        </div>
      </header>

      <SectionCard title="Timer principal" subtitle="25 min de focus, 5 min de pause, puis 25 min de grande pause apres 4 sessions.">
        <div className="pomodoro-panel">
          <div className={`pomodoro-clock${activeSession ? ` pomodoro-clock--${activeSession.kind}` : ""}`}>
            <span className="pomodoro-clock__label">{sessionLabel}</span>
            <strong>{hasLiveSession && activeSession ? formatTimerRemaining(pomodoro.remainingMs) : "00:00"}</strong>
            <span className="pomodoro-clock__cycle">Session {pomodoro.state.currentCycleIndex}/4</span>
          </div>

          <div className="pomodoro-panel__controls">
            <div className="status-grid">
              <article className="status-card">
                <span>Tache active</span>
                <strong>
                  {pomodoro.currentTask?.title ??
                    pomodoro.currentActivityLabel ??
                    pomodoro.preferredTask?.title ??
                    pomodoro.preferredActivityLabel ??
                    "Sans tache assignee"}
                </strong>
              </article>
              <article className="status-card">
                <span>Prochaine etape</span>
                <strong>{getPomodoroKindLabel(pomodoro.state.nextSessionKind)}</strong>
              </article>
              <article className="status-card">
                <span>Focus completes dans le cycle</span>
                <strong>{pomodoro.state.completedFocusCountInCycle}</strong>
              </article>
            </div>

            <label className="stacked-field">
              <span>Tache liee au focus</span>
              <select
                value={selectedTaskId}
                disabled={Boolean(hasLiveSession && activeSession?.kind !== "focus")}
                onChange={async (event) => {
                  const nextTaskId = event.target.value;
                  setSelectedTaskId(nextTaskId);
                  if (nextTaskId) {
                    setManualTitle("");
                  }

                  if (hasLiveSession && activeSession?.kind === "focus") {
                    await pomodoro.switchTask(nextTaskId || null, nextTaskId ? null : (manualTitle.trim() || null));
                  }
                }}
              >
                <option value="">Sans tache assignee</option>
                {pomodoro.taskOptions.map((task) => (
                  <option key={task.id} value={task.id}>
                    {task.title}
                  </option>
                ))}
              </select>
            </label>

            {!selectedTaskId ? (
              <label className="stacked-field">
                <span>Titre libre si aucune tache n'est liee</span>
                <div className="inline-field">
                  <input
                    type="text"
                    value={manualTitle}
                    disabled={!canEditManualTitle}
                    placeholder="Ex.: Inbox zero, lecture strategique, admin..."
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
                    Appliquer
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
                      taskId: pomodoro.state.nextSessionKind === "focus" ? selectedTaskId || null : null,
                      title:
                        pomodoro.state.nextSessionKind === "focus" && !selectedTaskId
                          ? manualTitle.trim() || null
                          : null
                    })
                  }
                >
                  {nextActionLabel}
                </button>
              ) : null}

              {canSkipBreak ? (
                <button className="button" type="button" onClick={() => void pomodoro.skipBreak()}>
                  Skipper la pause
                </button>
              ) : null}

              {hasLiveFocusSession && pomodoro.currentTask ? (
                <button className="button" type="button" onClick={() => void pomodoro.completeCurrentTask()}>
                  Terminer la tache
                </button>
              ) : null}

              {hasLiveFocusSession && pomodoro.canCompleteNow ? (
                <>
                  <button className="button" type="button" onClick={() => void pomodoro.completeNow()}>
                    Terminer maintenant
                  </button>
                  <button className="button button--ghost" type="button" onClick={() => void pomodoro.cancelCurrent()}>
                    Annuler la session
                  </button>
                </>
              ) : null}

              {hasLiveFocusSession && !pomodoro.canCompleteNow ? (
                <button className="button button--ghost" type="button" onClick={() => void pomodoro.cancelCurrent()}>
                  Annuler la session
                </button>
              ) : null}

              {hasLiveBreakSession ? (
                <button className="button button--ghost" type="button" onClick={() => void pomodoro.cancelCurrent()}>
                  Annuler la session
                </button>
              ) : null}
            </div>

            {hasLiveSession ? (
              <p className="field-card__helper">
                {hasLiveFocusSession
                  ? pomodoro.canCompleteNow
                    ? "Terminer maintenant cloture cette session comme completee et fait avancer le cycle. Annuler la session l'arrete sans la compter comme accomplie."
                    : "Pendant la premiere moitie du focus, tu peux seulement annuler la session. Terminer maintenant apparait apres la moitie du pomodoro."
                  : "Skipper la pause cloture la pause tout de suite et relance le cycle. Annuler la session l'arrete sans la compter."}
              </p>
            ) : null}
          </div>
        </div>
      </SectionCard>

      <SectionCard title="Historique du jour" subtitle="Chaque session garde la trace des taches touchees, meme si tu en changes en cours de focus.">
        {pomodoro.sessions.length === 0 ? (
          <p className="empty-copy">Aucune session Pomodoro enregistree aujourd'hui.</p>
        ) : (
          <div className="pomodoro-history">
            {pomodoro.sessions.map((session) => (
              <article key={session.id} className="pomodoro-history__item">
                <div className="pomodoro-history__header">
                  <strong>{getPomodoroKindLabel(session.kind)}</strong>
                  <span>
                    {formatDateTimeShort(session.startedAt)} → {formatDateTimeShort(session.endsAt)}
                  </span>
                </div>
                <span className={`pomodoro-history__status pomodoro-history__status--${session.status}`}>
                  {session.status === "running" ? "En cours" : session.status === "completed" ? "Completee" : "Annulee"}
                </span>
                <div className="pomodoro-history__segments">
                  {session.segments.length === 0 ? (
                    <span>Aucune tache associee</span>
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

      <SectionCard title="Temps passe par tache" subtitle="Temps reel cumule par tache, independamment du nombre de pomodoros.">
        {pomodoro.taskSummaries.length === 0 ? (
          <p className="empty-copy">Aucun temps de focus enregistre sur une tache aujourd'hui.</p>
        ) : (
          <div className="pomodoro-summary-list">
            {pomodoro.taskSummaries.map((summary) => (
              <article key={`${summary.taskId ?? "none"}-${summary.taskTitle}`} className="status-card">
                <span>{summary.taskTitle}</span>
                <strong>{formatSecondsCompact(summary.totalSeconds)}</strong>
                <small>{summary.sessionCount} session(s) impliquee(s)</small>
              </article>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
};
