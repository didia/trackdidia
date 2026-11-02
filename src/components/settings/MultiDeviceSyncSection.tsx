import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useAppContext } from "../../app/app-context";
import { isBackupDestinationConfigured } from "../../lib/backup";
import { isSyncCardVisible } from "../../lib/sync/gate";
import { gtdFolderProblem } from "../../lib/sync/sync-service";
import { SectionCard } from "../SectionCard";
import { SyncErrorMessage } from "../sync/SyncErrorMessage";

/**
 * The Settings card of the EXPERIMENTAL multi-device sync. Rendered only with debug mode on. It
 * chooses the shared GTD folder (refusing the backup folder, or one inside or around it, before the
 * native host is even asked), names this laptop, and enables or disables sync. The personal folder
 * is the existing backup destination.
 */
export const MultiDeviceSyncSection = () => {
  const { t } = useTranslation("sync");
  const { settings, updateSettings, debugEnabled, browserPreview, sync } = useAppContext();
  const [nameDraft, setNameDraft] = useState(settings.syncDeviceName);
  const [message, setMessage] = useState("");
  const [choosing, setChoosing] = useState(false);

  const visible = isSyncCardVisible(debugEnabled);
  const reachable = visible && !browserPreview && sync.supported;
  const enabled = settings.multiDeviceSyncEnabled;
  const { refresh } = sync;
  // Sync not turned on yet: an enable that was interrupted by a restart left a stored backfill, and
  // the card offers to resume it. (With sync on, the /sync page reads the status.)
  useEffect(() => {
    if (reachable && !enabled) void refresh();
  }, [reachable, enabled, refresh]);

  if (!visible) return null;

  const unavailable = browserPreview || !sync.supported;
  const busy = sync.phase !== "idle";
  const personalDir = settings.backupDestinationDir;
  const gtdDir = settings.syncGtdFolderDir;

  const chooseGtdFolder = async () => {
    setChoosing(true);
    setMessage("");
    try {
      const selected = await open({ directory: true, multiple: false });
      if (!selected || Array.isArray(selected)) return;
      const problem = gtdFolderProblem(selected, personalDir);
      if (problem !== null) {
        setMessage(
          t(
            {
              same: "card.gtdFolderSame",
              inside: "card.gtdFolderInside",
              contains: "card.gtdFolderContains",
            }[problem] as "card.gtdFolderSame",
          ),
        );
        return;
      }
      await updateSettings((current) => ({ ...current, syncGtdFolderDir: selected }));
      setMessage(t("card.gtdFolderSaved"));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("card.gtdFolderError"));
    } finally {
      setChoosing(false);
    }
  };

  const saveName = async () => {
    setMessage("");
    try {
      await updateSettings((current) => ({ ...current, syncDeviceName: nameDraft }));
      setMessage(t("card.nameSaved"));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("card.nameError"));
    }
  };

  // Enabling uses the name currently typed: it is saved first so the engine reads it.
  const enable = async () => {
    setMessage("");
    if (nameDraft !== settings.syncDeviceName) {
      try {
        await updateSettings((current) => ({ ...current, syncDeviceName: nameDraft }));
      } catch (error) {
        setMessage(error instanceof Error ? error.message : t("card.nameError"));
        return;
      }
    }
    await sync.enable();
  };

  const pending = sync.status?.pendingChanges;

  return (
    <SectionCard title={t("card.title")} subtitle={t("card.subtitle")}>
      {unavailable ? (
        <div className="banner" role="status">
          {t("card.browserPreview")}
        </div>
      ) : null}
      <div className="banner banner--danger" role="note">
        {t("card.experimental")}
      </div>
      <p>{t("card.scope")}</p>
      <p>{t("card.manualOnly")}</p>
      <p>{t("card.enableWarning")}</p>

      {message ? (
        <div className="banner" role="status">
          {message}
        </div>
      ) : null}
      {sync.setupError ? (
        <div className="banner banner--danger" role="alert">
          <SyncErrorMessage error={sync.setupError} />
        </div>
      ) : null}

      <div className="settings-form">
        <label>
          <span>{t("card.deviceName")}</span>
          <input
            type="text"
            maxLength={100}
            value={nameDraft}
            disabled={unavailable || busy}
            onChange={(event) => setNameDraft(event.target.value)}
            aria-describedby="sync-device-name-help"
          />
        </label>
        <p id="sync-device-name-help" className="muted-copy">
          {t("card.deviceNameHelp")}
        </p>

        <label>
          <span>{t("card.personalFolder")}</span>
          <input
            type="text"
            readOnly
            value={isBackupDestinationConfigured(personalDir) ? personalDir : ""}
            placeholder={t("card.personalFolderUnset")}
          />
        </label>

        <label>
          <span>{t("card.gtdFolder")}</span>
          <input type="text" readOnly value={gtdDir} placeholder={t("card.gtdFolderUnset")} />
        </label>
      </div>

      <div className="form-actions">
        <button
          className="button"
          type="button"
          disabled={unavailable || choosing || busy}
          onClick={() => void chooseGtdFolder()}
        >
          {choosing ? t("card.choosingGtdFolder") : t("card.chooseGtdFolder")}
        </button>
        <button
          className="button"
          type="button"
          disabled={unavailable || busy || nameDraft.trim() === settings.syncDeviceName}
          onClick={() => void saveName()}
        >
          {t("card.saveName")}
        </button>
        {enabled ? (
          <>
            <button
              className="button"
              type="button"
              disabled={unavailable || busy}
              onClick={() => void sync.recheckFolders()}
            >
              {sync.phase === "checking" ? t("card.rechecking") : t("card.recheck")}
            </button>
            <button
              className="button"
              type="button"
              disabled={unavailable || busy}
              onClick={() => void sync.disable()}
            >
              {sync.phase === "disabling" ? t("card.disabling") : t("card.disable")}
            </button>
          </>
        ) : sync.backfill && !busy ? null : (
          <button
            className="button button--primary"
            type="button"
            disabled={unavailable || busy}
            onClick={() => void enable()}
          >
            {sync.phase === "enabling" ? t("card.enabling") : t("card.enable")}
          </button>
        )}
      </div>

      <p role="status">
        {enabled ? t("card.status.on") : t("card.status.off")}{" "}
        {enabled
          ? pending === undefined
            ? t("card.status.unknownPending")
            : t("card.status.pending", { count: pending })
          : null}
      </p>
      {sync.phase === "enabling" && sync.enableStep ? (
        <p role="status" aria-live="polite">
          {t(`card.step.${sync.enableStep}`)}
        </p>
      ) : null}
      {sync.backfill ? (
        <div>
          <progress
            max={100}
            value={sync.backfill.percent}
            aria-label={t("card.backfill.progressLabel")}
          />
          <p role="status" aria-live="polite">
            {busy
              ? t("card.backfill.progress", {
                  percent: sync.backfill.percent,
                  scanned: sync.backfill.scannedRows,
                  total: sync.backfill.totalRows,
                })
              : t("card.backfill.interrupted", { percent: sync.backfill.percent })}
          </p>
          {busy ? null : (
            <div className="form-actions">
              <button
                className="button button--primary"
                type="button"
                disabled={unavailable}
                onClick={() => void sync.resumeBackfill()}
              >
                {t("card.backfill.resume")}
              </button>
            </div>
          )}
        </div>
      ) : null}
      {sync.enableResult ? (
        <>
          <p role="status">
            {t("card.enabled", {
              count: sync.enableResult.capture.backfilled,
              seconds: (sync.enableResult.capture.durationMs / 1000).toFixed(1),
            })}
          </p>
          {sync.enableResult.identity.repaired ? (
            <p role="alert">{t("card.identityRepaired")}</p>
          ) : null}
        </>
      ) : null}
      {enabled ? (
        <>
          <p className="muted-copy">{t("card.disableHelp")}</p>
          <p>
            <Link to="/sync">{t("card.openPage")}</Link>
          </p>
        </>
      ) : null}
    </SectionCard>
  );
};
