import { useEffect, useState } from "react";
import {
  clearDebugLogs,
  getDebugEntries,
  subscribeToDebugLogs,
  type DebugLogEntry
} from "../lib/debug";

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

  useEffect(() => subscribeToDebugLogs(setEntries), []);

  useEffect(() => {
    if (forced) {
      setOpen(true);
    }
  }, [forced]);

  if (!enabled && !forced) {
    return null;
  }

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
