import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { t as translate } from "../i18n";
import {
  clearDebugLogs,
  type DebugLogEntry,
  getDebugEntries,
  logDebug,
  subscribeToDebugLogs,
} from "../lib/debug";
import {
  testPomodoroChime,
  testPomodoroCompletionAnnouncement,
  testPomodoroNotification,
} from "../lib/pomodoro/sound";

interface DebugPanelProps {
  enabled: boolean;
  forced?: boolean;
}

const renderLevel = (level: DebugLogEntry["level"]) =>
  translate(`debug.level.${level}`, { ns: "settings" });

export const DebugPanel = ({ enabled, forced = false }: DebugPanelProps) => {
  const { t } = useTranslation("settings");
  const { t: tCommon } = useTranslation("common");
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
    mode: "chime-session" | "chime-cycle" | "notification" | "completion",
  ) => {
    setTestingPomodoro(true);
    try {
      if (mode === "chime-session") {
        const played = await testPomodoroChime("session");
        logDebug(
          "info",
          "pomodoro.debug",
          played
            ? translate("debug.log.sessionChimeOk", { ns: "settings" })
            : translate("debug.log.sessionChimeFail", { ns: "settings" }),
        );
        return;
      }

      if (mode === "chime-cycle") {
        const played = await testPomodoroChime("cycle");
        logDebug(
          "info",
          "pomodoro.debug",
          played
            ? translate("debug.log.cycleChimeOk", { ns: "settings" })
            : translate("debug.log.cycleChimeFail", { ns: "settings" }),
        );
        return;
      }

      if (mode === "notification") {
        const notified = await testPomodoroNotification();
        logDebug(
          "info",
          "pomodoro.debug",
          notified
            ? translate("debug.log.notificationOk", { ns: "settings" })
            : translate("debug.log.notificationFail", { ns: "settings" }),
        );
        return;
      }

      const result = await testPomodoroCompletionAnnouncement("session");
      logDebug(
        "info",
        "pomodoro.debug",
        translate("debug.log.completion", { ns: "settings" }),
        result,
      );
    } catch (error) {
      logDebug(
        "error",
        "pomodoro.debug",
        translate("debug.log.pomodoroTestFail", { ns: "settings" }),
        error,
      );
    } finally {
      setTestingPomodoro(false);
    }
  };

  return (
    <div className="debug-panel">
      <div className="debug-panel__bar">
        <strong>{t("debug.title")}</strong>
        <div className="debug-panel__actions">
          <button
            className="button button--ghost"
            type="button"
            onClick={() => setOpen((current) => !current)}
          >
            {open ? tCommon("actions.hide") : tCommon("actions.show")}
          </button>
          <button className="button button--ghost" type="button" onClick={() => clearDebugLogs()}>
            {t("debug.clear")}
          </button>
        </div>
      </div>

      {open ? (
        <div className="debug-panel__body">
          <div className="debug-panel__tools">
            <strong>{t("debug.pomodoroTests")}</strong>
            <div className="debug-panel__actions">
              <button
                className="button button--ghost"
                type="button"
                disabled={testingPomodoro}
                onClick={() => void runPomodoroTest("chime-session")}
              >
                {t("debug.testSessionChime")}
              </button>
              <button
                className="button button--ghost"
                type="button"
                disabled={testingPomodoro}
                onClick={() => void runPomodoroTest("chime-cycle")}
              >
                {t("debug.testCycleChime")}
              </button>
              <button
                className="button button--ghost"
                type="button"
                disabled={testingPomodoro}
                onClick={() => void runPomodoroTest("notification")}
              >
                {t("debug.testNotification")}
              </button>
              <button
                className="button button--ghost"
                type="button"
                disabled={testingPomodoro}
                onClick={() => void runPomodoroTest("completion")}
              >
                {t("debug.testCompletion")}
              </button>
            </div>
          </div>
          <p className="debug-panel__hint">{t("debug.consoleHint")}</p>
          <div className="debug-log-list">
            {entries.length === 0 ? (
              <p className="empty-copy">{t("debug.emptyLogs")}</p>
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
