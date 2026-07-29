import { useEffect, useState } from "react";
import {
  clearDebugLogs,
  getDebugEntries,
  logDebug,
  subscribeToDebugLogs,
  type DebugLogEntry
} from "../lib/debug";
import {
  testPomodoroChime,
  testPomodoroCompletionAnnouncement,
  testPomodoroNotification
} from "../lib/pomodoro/sound";

interface DebugPanelProps {
  enabled: boolean;
  forced?: boolean;
}

const renderLevel = (level: DebugLogEntry["level"]) => {
  if (level === "error") {
    return "Erreur";
  }

  if (level === "warn") {
    return "Alerte";
  }

  return "Info";
};

export const DebugPanel = ({ enabled, forced = false }: DebugPanelProps) => {
  const [entries, setEntries] = useState(getDebugEntries());
  const [open, setOpen] = useState(forced);
  const [testingPomodoro, setTestingPomodoro] = useState(false);

  useEffect(() => subscribeToDebugLogs(setEntries), []);

  useEffect(() => {
    if (forced) {
      setOpen(true);
    }
  }, [forced]);

  if (!enabled && !forced) {
    return null;
  }

  const runPomodoroTest = async (
    mode: "chime-session" | "chime-cycle" | "notification" | "completion"
  ) => {
    setTestingPomodoro(true);
    try {
      if (mode === "chime-session") {
        const played = await testPomodoroChime("session");
        logDebug("info", "pomodoro.debug", played ? "Test son session (3s) reussi" : "Test son session echoue");
        return;
      }

      if (mode === "chime-cycle") {
        const played = await testPomodoroChime("cycle");
        logDebug("info", "pomodoro.debug", played ? "Test son cycle (5s) reussi" : "Test son cycle echoue");
        return;
      }

      if (mode === "notification") {
        const notified = await testPomodoroNotification();
        logDebug("info", "pomodoro.debug", notified ? "Test notification reussi" : "Test notification echoue");
        return;
      }

      const result = await testPomodoroCompletionAnnouncement("session");
      logDebug("info", "pomodoro.debug", "Test completion Pomodoro", result);
    } catch (error) {
      logDebug("error", "pomodoro.debug", "Echec du test Pomodoro", error);
    } finally {
      setTestingPomodoro(false);
    }
  };

  return (
    <div className="debug-panel">
      <div className="debug-panel__bar">
        <strong>Debug Trackdidia</strong>
        <div className="debug-panel__actions">
          <button className="button button--ghost" type="button" onClick={() => setOpen((current) => !current)}>
            {open ? "Masquer" : "Afficher"}
          </button>
          <button className="button button--ghost" type="button" onClick={() => clearDebugLogs()}>
            Vider
          </button>
        </div>
      </div>

      {open ? (
        <div className="debug-panel__body">
          <div className="debug-panel__tools">
            <strong>Tests Pomodoro</strong>
            <div className="debug-panel__actions">
              <button
                className="button button--ghost"
                type="button"
                disabled={testingPomodoro}
                onClick={() => void runPomodoroTest("chime-session")}
              >
                Son session 3s
              </button>
              <button
                className="button button--ghost"
                type="button"
                disabled={testingPomodoro}
                onClick={() => void runPomodoroTest("chime-cycle")}
              >
                Son cycle 5s
              </button>
              <button
                className="button button--ghost"
                type="button"
                disabled={testingPomodoro}
                onClick={() => void runPomodoroTest("notification")}
              >
                Test notification
              </button>
              <button
                className="button button--ghost"
                type="button"
                disabled={testingPomodoro}
                onClick={() => void runPomodoroTest("completion")}
              >
                Test completion
              </button>
            </div>
          </div>
          <p className="debug-panel__hint">
            Les erreurs sont aussi envoyees a `console.info` et `console.error`.
          </p>
          <div className="debug-log-list">
            {entries.length === 0 ? (
              <p className="empty-copy">Aucun log pour le moment.</p>
            ) : (
              entries
                .slice()
                .reverse()
                .map((entry) => (
                  <article key={entry.id} className={`debug-log debug-log--${entry.level}`}>
                    <div className="debug-log__head">
                      <strong>{renderLevel(entry.level)}</strong>
                      <span>{entry.scope}</span>
                      <time>{entry.timestamp}</time>
                    </div>
                    <p>{entry.message}</p>
                    {entry.details ? <pre>{entry.details}</pre> : null}
                  </article>
                ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
};
