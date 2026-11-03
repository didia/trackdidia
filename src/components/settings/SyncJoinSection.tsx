import { open } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useAppContext } from "../../app/app-context";
import { isSyncCardVisible } from "../../lib/sync/gate";
import {
  domainsReadable,
  WORK_PROFILE_SELECTABLE,
  type DeviceProfile,
} from "../../lib/sync/profile";
import { joinCompleted, type JoinPreview } from "../../lib/sync/join-service";
import { SectionCard } from "../SectionCard";
import { SyncErrorMessage } from "../sync/SyncErrorMessage";

/** A join is staged locally until the user chooses a peer and confirms. */
export const SyncJoinSection = ({
  workProfileSelectable = WORK_PROFILE_SELECTABLE,
}: {
  workProfileSelectable?: boolean;
}) => {
  const { t } = useTranslation("sync");
  const { settings, debugEnabled, browserPreview, sync } = useAppContext();
  const [profile, setProfile] = useState<DeviceProfile>(settings.syncProfile);
  const [gtd, setGtd] = useState(settings.syncGtdFolderDir);
  const [backup, setBackup] = useState(settings.backupDestinationDir);
  const [name, setName] = useState(settings.syncDeviceName);
  const [preview, setPreview] = useState<JoinPreview | null>(null);
  const [selected, setSelected] = useState("");
  const [message, setMessage] = useState("");
  const [choosing, setChoosing] = useState(false);
  if (!isSyncCardVisible(debugEnabled)) return null;
  const busy = sync.phase !== "idle" || choosing;
  const disabled = browserPreview || !sync.supported || settings.multiDeviceSyncEnabled || busy;
  const candidate = {
    ...settings,
    syncProfile: profile,
    syncGtdFolderDir: gtd,
    backupDestinationDir: backup,
    syncDeviceName: name,
  };
  const selectedPeer = preview?.peers.find((peer) => peer.id === selected);
  const peerIncomplete =
    selectedPeer !== undefined &&
    domainsReadable(profile).some((domain) => selectedPeer.counts[domain] === null);
  const choose = async (set: (value: string) => void) => {
    setChoosing(true);
    try {
      const value = await open({ directory: true, multiple: false });
      if (typeof value === "string") {
        set(value);
        setPreview(null);
        setSelected("");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setChoosing(false);
    }
  };
  const inspect = async () => {
    setMessage("");
    setPreview(null);
    setSelected("");
    setPreview(await sync.inspectJoin(candidate, profile));
  };
  const join = async () => {
    setMessage("");
    const report = await sync.join(candidate, profile, selected);
    if (report)
      setMessage(
        joinCompleted(report, profile, selected)
          ? t("join.done")
          : t("join.incomplete", {
              details: report.issues.map((issue) => issue.message).join("; "),
            }),
      );
  };
  return (
    <SectionCard title={t("join.title")} subtitle={t("join.subtitle")}>
      <p>{t("join.freshHelp")}</p>
      {settings.multiDeviceSyncEnabled && <p>{t("join.disableFirst")}</p>}
      {sync.setupError && (
        <div className="banner banner--danger" role="alert">
          <SyncErrorMessage error={sync.setupError} />
        </div>
      )}
      {message && <p role="status">{message}</p>}
      <div className="settings-form">
        <label>
          <span>{t("join.profile")}</span>
          <select
            disabled={disabled}
            value={profile}
            onChange={(event) => {
              const next = event.target.value as DeviceProfile;
              setProfile(next);
              if (next !== settings.syncProfile) setBackup("");
              setPreview(null);
              setSelected("");
            }}
          >
            <option value="personal">{t("join.personal")}</option>
            <option value="work" disabled={!workProfileSelectable}>
              {t("join.work")}
            </option>
          </select>
        </label>
        <label>
          <span>{t("card.deviceName")}</span>
          <input
            disabled={disabled}
            value={name}
            maxLength={100}
            onChange={(event) => {
              setName(event.target.value);
              setPreview(null);
            }}
          />
        </label>
        <label>
          <span>{t("card.gtdFolder")}</span>
          <input readOnly value={gtd} />
        </label>
        <button
          type="button"
          className="button"
          disabled={disabled}
          onClick={() => void choose(setGtd)}
        >
          {t("card.chooseGtdFolder")}
        </button>
        <label>
          <span>{t(profile === "work" ? "join.workBackup" : "card.personalFolder")}</span>
          <input readOnly value={backup} />
        </label>
        <button
          type="button"
          className="button"
          disabled={disabled}
          onClick={() => void choose(setBackup)}
        >
          {t("join.chooseBackup")}
        </button>
      </div>
      <button type="button" className="button" disabled={disabled} onClick={() => void inspect()}>
        {t("join.inspect")}
      </button>
      {preview && (
        <div>
          <p>{t("join.localCounts", preview.local)}</p>
          {preview.refused ? (
            <p role="alert">{t("join.refused")}</p>
          ) : (
            <>
              <p>{t(preview.requiresBackup ? "join.backupRequired" : "join.backupSkipped")}</p>
              {preview.requiresBackup && !backup.trim() && (
                <p role="alert">{t("join.chooseBackupRequired")}</p>
              )}
              {preview.peers.length === 0 ? (
                <p>{t("join.noPeers")}</p>
              ) : (
                <fieldset disabled={disabled}>
                  <legend>{t("join.selectPeer")}</legend>
                  {preview.peers.map((peer) => (
                    <label key={peer.id}>
                      <input
                        type="radio"
                        name="join-peer"
                        value={peer.id}
                        checked={selected === peer.id}
                        onChange={() => setSelected(peer.id)}
                      />{" "}
                      {peer.name} —{" "}
                      {t(
                        "join.remoteCounts",
                        Object.fromEntries(
                          Object.entries(peer.counts).map(([domain, count]) => [
                            domain,
                            count ?? t("join.pending"),
                          ]),
                        ),
                      )}
                    </label>
                  ))}
                </fieldset>
              )}
              {peerIncomplete && <p role="alert">{t("join.peerIncomplete")}</p>}
              <div className="form-actions">
                <button
                  type="button"
                  className="button button--primary"
                  disabled={
                    disabled ||
                    !selected ||
                    peerIncomplete ||
                    (preview.requiresBackup && !backup.trim())
                  }
                  onClick={() => void join()}
                >
                  {t("join.confirm")}
                </button>
                <button
                  type="button"
                  className="button"
                  disabled={busy}
                  onClick={() => {
                    setPreview(null);
                    setSelected("");
                  }}
                >
                  {t("join.cancel")}
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </SectionCard>
  );
};
