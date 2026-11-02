import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useAppContext } from "../../app/app-context";
import { formatDurationSince } from "../../lib/date";
import { isSyncPageEnabled } from "../../lib/sync/gate";

/**
 * The sync status chip in the sidebar: idle (up to date), syncing, error (a retry is scheduled),
 * backfill (change tracking is still being initialized) or paused (only the user can resume it).
 * It is a link to `/sync`. Rendered only with the debug gate open AND sync enabled on the desktop
 * storage; otherwise nothing is rendered at all.
 */
export const SyncStatusChip = () => {
  const { t } = useTranslation("sync");
  const { sync, settings, debugEnabled, browserPreview } = useAppContext();
  if (browserPreview || !sync.supported || !isSyncPageEnabled(debugEnabled, settings)) return null;

  const { state, lastOkAtMs, retryAtMs } = sync.chip;
  let text: string;
  if (state === "idle") {
    text =
      lastOkAtMs === null
        ? t("chip.idle")
        : t("chip.idleSince", { since: formatDurationSince(new Date(lastOkAtMs).toISOString()) });
  } else if (state === "error" && retryAtMs !== null) {
    text = t("chip.errorRetry", {
      time: new Date(retryAtMs).toLocaleTimeString("fr-FR", {
        hour: "2-digit",
        minute: "2-digit",
      }),
    });
  } else {
    text = t(`chip.${state}`);
  }

  return (
    <Link
      to="/sync"
      className={`sync-chip sync-chip--${state}`}
      data-state={state}
      aria-label={t("chip.linkLabel", { state: text })}
    >
      <span className="sync-chip__dot" aria-hidden="true" />
      <span className="sync-chip__text" role="status">
        {text}
      </span>
    </Link>
  );
};
