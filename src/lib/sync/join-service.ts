import type { AppSettings } from "../../domain/types";
import type { AppRepository } from "../storage/repository";
import { isBackupDestinationConfigured } from "../backup";
import { folderOverlap } from "./folder-paths";
import { domainsReadable, type DeviceProfile } from "./profile";
import { decideJoin } from "./profile-rules";
import { SYNC_DOMAINS, type SyncDomain } from "./registry";
import { createFolderTransport } from "./transport-folder";
import {
  assertSyncSupported,
  buildSyncEngine,
  changeSyncProfile,
  createSafetyBackup,
  defaultSyncServiceDeps,
  enableSync,
  prepareFolders,
  SyncSetupError,
  type SyncServiceDeps,
} from "./sync-service";
import type { PullReport } from "./engine-types";

export interface JoinPeer {
  id: string;
  name: string;
  /** Null means that domain has not arrived, not that it has zero rows. */
  counts: Record<SyncDomain, number | null>;
}

export interface JoinPreview {
  local: Record<SyncDomain, number>;
  peers: JoinPeer[];
  refused: boolean;
  requiresBackup: boolean;
}

export interface JoinInput {
  repository: AppRepository;
  settings: AppSettings;
  profile: DeviceProfile;
  deps?: SyncServiceDeps;
}

/** Read counts and list peers without persisting the selected profile or folder settings. */
export const inspectJoin = async (input: JoinInput): Promise<JoinPreview> => {
  const deps = input.deps ?? defaultSyncServiceDeps;
  const settings = { ...input.settings, syncProfile: input.profile };
  const environment = await assertSyncSupported(input.repository, settings, deps);
  const inspection = await input.repository.inspectSyncProfileData();
  const decision = decideJoin({ profile: input.profile, inspection });
  if (decision.kind === "refused") {
    return { local: inspection.counts, peers: [], refused: true, requiresBackup: true };
  }
  const folders = await prepareFolders(deps, settings, environment);
  const deviceId = await deps.getDeviceId();
  const transports = [
    createFolderTransport({
      role: "gtd",
      folderDir: folders.gtd,
      environment,
      deviceId,
      api: deps.api,
    }),
  ];
  if (folders.personal)
    transports.push(
      createFolderTransport({
        role: "personal",
        folderDir: folders.personal,
        environment,
        deviceId,
        api: deps.api,
      }),
    );
  const peers = new Map<string, JoinPeer>();
  for (const transport of transports) {
    for (const manifest of await transport.listPeers()) {
      if (
        typeof manifest.deviceId !== "string" ||
        manifest.deviceId === deviceId ||
        typeof manifest.deviceName !== "string"
      )
        continue;
      const peer = peers.get(manifest.deviceId) ?? {
        id: manifest.deviceId,
        name: manifest.deviceName,
        counts: { gtd: null, personal: null, finance: null },
      };
      for (const domain of SYNC_DOMAINS) {
        if (!transport.domains.includes(domain) || !domainsReadable(input.profile).includes(domain))
          continue;
        const rows = manifest.domains?.[domain]?.rows;
        if (typeof rows === "number" && Number.isSafeInteger(rows) && rows >= 0)
          peer.counts[domain] = rows;
      }
      peers.set(peer.id, peer);
    }
  }
  return {
    local: inspection.counts,
    peers: [...peers.values()],
    refused: false,
    requiresBackup: decision.requiresBackup,
  };
};

export interface ConfirmJoinInput extends JoinInput {
  peerId: string;
  updateSettings: (updater: (current: AppSettings) => AppSettings) => Promise<AppSettings>;
  getSettings: () => AppSettings;
}

/** A warning such as a stale or newer-schema peer may leave one transport unmerged. */
export const joinCompleted = (
  report: PullReport,
  profile: DeviceProfile,
  peerId: string,
): boolean =>
  report.complete &&
  report.transports.every((transport) => transport.reachable) &&
  report.peers.length > 0 &&
  report.peers.every((peer) => peer.peerId === peerId) &&
  report.peers.every(
    (peer) =>
      peer.status === "ok" &&
      peer.domains.every(
        (domain) => domain.outcome === "applied" || domain.outcome === "unchanged",
      ),
  ) &&
  domainsReadable(profile).every((domain) =>
    report.peers.some((peer) =>
      peer.domains.some(
        (result) =>
          result.domain === domain &&
          (result.outcome === "applied" || result.outcome === "unchanged"),
      ),
    ),
  ) &&
  !report.issues.some((issue) => issue.severity === "error");

/** Caller serializes this entire operation with sync and backup actions. */
export const confirmJoin = async (input: ConfirmJoinInput): Promise<PullReport> => {
  const deps = input.deps ?? defaultSyncServiceDeps;
  if (input.getSettings().multiDeviceSyncEnabled)
    throw new Error("Disable sync before joining another laptop");
  if (
    input.getSettings().syncProfile === "work" &&
    input.profile === "personal" &&
    (!isBackupDestinationConfigured(input.settings.backupDestinationDir) ||
      folderOverlap(
        input.settings.backupDestinationDir,
        input.getSettings().backupDestinationDir,
      ) !== null)
  ) {
    throw new SyncSetupError(
      "no_backup_destination",
      "Choose the personal folder before importing personal data",
    );
  }
  const preview = await inspectJoin(input);
  if (preview.refused)
    throw new SyncSetupError(
      "work_profile_data_present",
      "Personal or finance data is present; move the database and its backups manually before starting with a fresh database",
      { counts: preview.local },
    );
  const peer = preview.peers.find((peer) => peer.id === input.peerId);
  if (!peer) throw new Error("The selected laptop is no longer available");
  if (domainsReadable(input.profile).some((domain) => peer.counts[domain] === null))
    throw new SyncSetupError(
      "peer_incomplete",
      "Some selected laptop data has not arrived in the shared folders yet; wait for synchronization and retry",
    );
  if (preview.requiresBackup && !isBackupDestinationConfigured(input.settings.backupDestinationDir))
    throw new SyncSetupError(
      "no_backup_destination",
      "Choose a backup folder before merging this database",
    );
  const saveSetup = (current: AppSettings): AppSettings => ({
    ...current,
    syncProfile: input.profile,
    syncGtdFolderDir: input.settings.syncGtdFolderDir,
    backupDestinationDir: input.settings.backupDestinationDir,
    syncDeviceName: input.settings.syncDeviceName,
    profileDecisionMadeAt: current.profileDecisionMadeAt || new Date().toISOString(),
  });
  const changed = await changeSyncProfile({
    repository: input.repository,
    settings: input.getSettings(),
    to: input.profile,
    updateSettings: (updater) => input.updateSettings((current) => saveSetup(updater(current))),
    deps,
  });
  if (changed.outcome === "noop") await input.updateSettings(saveSetup);
  const current = input.getSettings();
  await enableSync({
    repository: input.repository,
    settings: current,
    updateSettings: input.updateSettings,
    deps,
    deferActivation: true,
  });
  const deviceId = await deps.getDeviceId();
  const backup = preview.requiresBackup
    ? await createSafetyBackup(input.repository, deviceId, input.getSettings)(["first_merge"])
    : undefined;
  const built = await buildSyncEngine({
    repository: input.repository,
    settings: input.getSettings(),
    getSettings: input.getSettings,
    deps,
    ...(backup ? { beforeFirstMerge: async () => backup } : {}),
  });
  const report = await built.engine.pull({
    peerId: input.peerId,
    verifiedEmptyJoiner: !preview.requiresBackup,
  });
  if (joinCompleted(report, input.profile, input.peerId)) {
    await input.updateSettings((stored) => ({ ...stored, multiDeviceSyncEnabled: true }));
  }
  return report;
};
