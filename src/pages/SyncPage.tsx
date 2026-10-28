import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useAppContext } from "../app/app-context";
import { PageHeader } from "../components/PageHeader";
import { SectionCard } from "../components/SectionCard";
import {
  describeIssue,
  folderLabel,
  keyedIssues,
  persistentKindOf,
} from "../components/sync/describe-issue";
import { SyncErrorMessage } from "../components/sync/SyncErrorMessage";
import { formatDateTimeShort } from "../lib/date";
import type { PeerStatus, PullReport, SyncIssue } from "../lib/sync/engine-types";
import { isSyncPageEnabled } from "../lib/sync/gate";

const shortId = (deviceId: string): string => deviceId.replace(/^dev:/, "").slice(0, 8);

const timeOf = (ms: number): string => formatDateTimeShort(new Date(ms).toISOString());

const IssueItem = ({ issue }: { issue: SyncIssue }) => {
  const { t } = useTranslation("sync");
  const described = describeIssue(t, issue);
  return (
    <li className={`sync-issue sync-issue--${issue.severity}`}>
      <strong>{t(`page.issues.severity.${issue.severity}`)}</strong>
      {described.title ? <> — {described.title}. </> : " — "}
      {described.body}
      <details>
        <summary>{t("page.issues.technical")}</summary>
        <code>{issue.message}</code>
      </details>
    </li>
  );
};

const PeerRow = ({
  peer,
  onApprove,
  approving,
  onConfirm,
  onCancel,
  disabled,
  haltedForBackup,
}: {
  peer: PeerStatus;
  /** The last pull stopped this peer's merge because the required safety backup could not be made. */
  haltedForBackup: boolean;
  onApprove: () => void;
  approving: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  disabled: boolean;
}) => {
  const { t } = useTranslation("sync");
  const unknown = t("page.peers.unknownValue");
  return (
    <tr>
      <th scope="row">
        {peer.peerName || peer.peerId}
        <br />
        <small>{shortId(peer.peerId)}</small>
      </th>
      <td>{peer.lastSyncedAt ? formatDateTimeShort(peer.lastSyncedAt) : t("page.peers.never")}</td>
      <td>
        {peer.appVersion !== null && peer.schemaVersion !== null
          ? t("page.peers.versionValue", { app: peer.appVersion, schema: peer.schemaVersion })
          : unknown}
      </td>
      <td>{peer.profile ?? unknown}</td>
      <td>{t(`page.peerState.${peer.state}`)}</td>
      <td>
        {peer.state === "pending" ? (
          t("page.peers.pendingDetail")
        ) : peer.state === "error" && haltedForBackup ? (
          <>
            {t("page.peers.haltedBackup")}{" "}
            <Link to="/parametres">{t("page.gate.settingsLink")}</Link>
          </>
        ) : (
          peer.message
        )}
        {peer.state === "stale" ? (
          <div className="sync-stale">
            <p>{t("page.stale.warning", { name: peer.peerName || shortId(peer.peerId) })}</p>
            {approving ? (
              <div className="form-actions">
                <button
                  className="button button--primary"
                  type="button"
                  disabled={disabled}
                  onClick={onConfirm}
                >
                  {t("page.stale.confirm", { name: peer.peerName || shortId(peer.peerId) })}
                </button>
                <button className="button" type="button" onClick={onCancel}>
                  {t("page.stale.cancel")}
                </button>
              </div>
            ) : (
              <button className="button" type="button" disabled={disabled} onClick={onApprove}>
                {t("page.stale.approve", { name: peer.peerName || shortId(peer.peerId) })}
              </button>
            )}
          </div>
        ) : null}
      </td>
    </tr>
  );
};

const PullSummary = ({ pull }: { pull: PullReport }) => {
  const { t } = useTranslation("sync");
  const skipped = pull.peers.filter((peer) => peer.status !== "ok");
  const skewed = pull.peers.filter((peer) => peer.clockSkewMs !== undefined);
  return (
    <div>
      <h4>{t("page.last.pull")}</h4>
      {pull.totals.bundlesApplied === 0 ? (
        <p>{t("page.last.noBundles")}</p>
      ) : (
        <p>
          {t("page.last.totals", {
            bundles: pull.totals.bundlesApplied,
            applied: pull.totals.applied,
            skipped: pull.totals.skipped,
            tombstones: pull.totals.tombstonesApplied,
            conflicts: pull.totals.conflictsLogged,
          })}
        </p>
      )}
      {pull.complete ? null : <p>{t("page.last.incomplete", { count: pull.remaining.length })}</p>}
      <p>
        <strong>{t("page.last.backup.title")} : </strong>
        {pull.safetyBackup.status === "taken" && pull.safetyBackup.path
          ? t("page.last.backup.taken", { path: pull.safetyBackup.path })
          : pull.safetyBackup.status === "taken"
            ? t("page.last.backup.takenNoPath")
            : t(`page.last.backup.${pull.safetyBackup.status}`)}
      </p>
      {skipped.length > 0 ? (
        <>
          <h5>{t("page.last.skippedPeers")}</h5>
          <ul>
            {skipped.map((peer) => (
              <li key={`${peer.transport}:${peer.peerId || peer.peerName}`}>
                {t(`page.last.skipped.${peer.status as "update_required"}`, {
                  name: peer.peerName || shortId(peer.peerId),
                })}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {skewed.length > 0 ? (
        <ul>
          {skewed.map((peer) => (
            <li key={`skew:${peer.transport}:${peer.peerId}`}>
              {t("page.last.skew", { name: peer.peerName || shortId(peer.peerId) })}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
};

export const SyncPage = () => {
  const { t } = useTranslation("sync");
  const { sync, settings, debugEnabled, browserPreview } = useAppContext();
  const [approving, setApproving] = useState<string | null>(null);
  const open = isSyncPageEnabled(debugEnabled, settings) && sync.supported && !browserPreview;
  const busy = sync.phase !== "idle";

  const { refresh } = sync;
  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const header = (actions?: React.ReactNode) => (
    <PageHeader
      eyebrow={t("page.eyebrow")}
      title={t("page.title")}
      copy={t("page.copy")}
      actions={actions}
    />
  );

  if (browserPreview || !sync.supported) {
    return (
      <div className="page">
        {header()}
        <div className="banner" role="status">
          {t("page.gate.preview")}
        </div>
      </div>
    );
  }
  if (!debugEnabled) {
    return (
      <div className="page">
        {header()}
        <div className="banner" role="status">
          {t("page.gate.debug")}
        </div>
      </div>
    );
  }
  if (!settings.multiDeviceSyncEnabled) {
    return (
      <div className="page">
        {header()}
        <div className="banner" role="status">
          {t("page.gate.disabled")} <Link to="/parametres">{t("page.gate.settingsLink")}</Link>
        </div>
      </div>
    );
  }

  const status = sync.status;
  const allIssues = status?.issues ?? [];
  const persistent = allIssues.filter((issue) => persistentKindOf(issue) !== null);
  const ordinary = allIssues.filter((issue) => persistentKindOf(issue) === null);
  // Issues of the last run the engine status does not carry (it leaves out notes): the pull's and the
  // publish's, including informational ones such as a publish replaced by a newer one.
  const runIssues = [
    ...(sync.run?.report?.pull.issues ?? []),
    ...(sync.run?.report?.publish.issues ?? []),
  ].filter((issue) => !allIssues.includes(issue));
  const syncingNow = sync.phase === "syncing";
  // Peers whose merge the last pull never started because the safety backup could not be made.
  const haltedPeerIds = new Set(
    (status?.lastPull?.peers ?? [])
      .filter((peer) => peer.domains.some((domain) => domain.outcome === "halted"))
      .map((peer) => peer.peerId),
  );

  return (
    <div className="page">
      {header(
        <>
          <button
            className="button button--primary"
            type="button"
            disabled={busy || sync.setupError?.code === "unsupported_profile"}
            onClick={() => void sync.syncNow()}
          >
            {syncingNow ? t("page.syncing") : t("page.syncNow")}
          </button>
          <button
            className="button"
            type="button"
            disabled={busy}
            onClick={() => void sync.refresh()}
          >
            {t("page.refresh")}
          </button>
        </>,
      )}

      <div className="banner" role="note">
        {t("page.manualNote")}
      </div>

      {sync.setupError ? (
        <div className="banner banner--danger" role="alert">
          <SyncErrorMessage error={sync.setupError} />
        </div>
      ) : null}

      {persistent.length > 0 ? (
        <div className="banner banner--danger" role="alert">
          <ul>
            {keyedIssues(persistent).map(({ key, issue }) => (
              <IssueItem key={key} issue={issue} />
            ))}
          </ul>
        </div>
      ) : null}

      {status === null && sync.phase === "checking" ? (
        <p role="status">{t("page.loading")}</p>
      ) : null}

      {status !== null && !status.ready ? (
        <div className="banner" role="status">
          {t("page.notReady")}
        </div>
      ) : null}

      {status !== null ? (
        <>
          <SectionCard title={t("page.summary.title")}>
            <p role="status">
              {status.pendingChanges > 0
                ? t("page.summary.pending", { count: status.pendingChanges })
                : t("page.summary.pendingNone")}
            </p>
          </SectionCard>

          <SectionCard title={t("page.peers.title")}>
            {status.peers.length === 0 ? (
              <p className="muted-copy">{t("page.peers.empty")}</p>
            ) : (
              <table className="analytics-table">
                <caption className="visually-hidden">{t("page.peers.caption")}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t("page.peers.name")}</th>
                    <th scope="col">{t("page.peers.lastSync")}</th>
                    <th scope="col">{t("page.peers.version")}</th>
                    <th scope="col">{t("page.peers.profile")}</th>
                    <th scope="col">{t("page.peers.state")}</th>
                    <th scope="col">{t("page.peers.detail")}</th>
                  </tr>
                </thead>
                <tbody>
                  {status.peers.map((peer) => (
                    <PeerRow
                      key={peer.peerId}
                      peer={peer}
                      approving={approving === peer.peerId}
                      disabled={busy}
                      haltedForBackup={haltedPeerIds.has(peer.peerId)}
                      onApprove={() => setApproving(peer.peerId)}
                      onCancel={() => setApproving(null)}
                      onConfirm={() => {
                        setApproving(null);
                        void sync.syncNow({ approveStalePeers: [peer.peerId] });
                      }}
                    />
                  ))}
                </tbody>
              </table>
            )}
            {sync.ignored.map((folder) => (
              <details key={folder.transport}>
                <summary>
                  {folderLabel(t, folder.transport)} — {folder.entries.length}
                </summary>
                <ul>
                  {folder.entries.map((entry) => (
                    <li key={entry.path}>
                      <code>{entry.path}</code> — {entry.reason}
                    </li>
                  ))}
                </ul>
              </details>
            ))}
          </SectionCard>
        </>
      ) : null}

      <SectionCard title={t("page.last.title")}>
        {sync.run === null ? (
          <p className="muted-copy">{t("page.last.none")}</p>
        ) : (
          <div role="status">
            <p>{t("page.last.finishedAt", { time: timeOf(sync.run.finishedAtMs) })}</p>
            {sync.run.error ? (
              <p role="alert">
                {t("page.last.failed")} <SyncErrorMessage error={sync.run.error} />
              </p>
            ) : null}
            {sync.run.report ? (
              <>
                <PullSummary pull={sync.run.report.pull} />
                <h4>{t("page.last.publish")}</h4>
                <ul>
                  {sync.run.report.publish.domains.map((result) => (
                    <li key={result.domain}>
                      {t(`page.last.published.${result.outcome}`, {
                        domain: t(`page.domain.${result.domain}`),
                        generation: result.generation ?? "",
                      })}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </div>
        )}
      </SectionCard>

      {ordinary.length + runIssues.length > 0 ? (
        <SectionCard title={t("page.issues.title")}>
          <ul>
            {keyedIssues([...ordinary, ...runIssues]).map(({ key, issue }) => (
              <IssueItem key={key} issue={issue} />
            ))}
          </ul>
        </SectionCard>
      ) : status !== null ? (
        <p className="muted-copy">{t("page.issues.none")}</p>
      ) : null}
    </div>
  );
};
