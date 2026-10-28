// Test-only: nothing in the app imports this file.
//
// SAFETY: in-memory databases and in-memory folders only (see the two-device harness).
import { createSyncEngine, type SyncEngine, type SyncEngineOptions } from "../sync-engine";
import type { SyncEngineRepository } from "../engine-support";
import type { DeviceProfile } from "../profile";
import type { SyncDomain } from "../registry";
import type { SyncTransport } from "../transport";
import { createMemoryFolders, type FolderRole, type MemoryFolders } from "./memory-transport";
import {
  createSyncHarness,
  type HarnessOptions,
  type SyncDevice,
  type SyncHarness,
} from "./two-device-harness";

/**
 * N simulated laptops, each with a sync engine, wired to shared in-memory folders:
 *
 * ```ts
 * const world = await createEngineWorld([
 *   { name: "A" },                                  // personal, both folders
 *   { name: "W", profile: "work", roles: ["gtd"] }, // work, shared GTD folder only
 * ]);
 * await world.device("A").engine.syncNow();
 * ```
 *
 * Each engine's clock is its device's fake clock, so "later" is explicit. The repository handed to
 * the engine is a recording wrapper: `device.calls` lists every `listSyncChanges` and
 * `applySyncBundle` the engine made, in order.
 */

export interface EngineDeviceSpec {
  name: string;
  /** Default `personal`. */
  profile?: DeviceProfile;
  /** Folder roles the device can reach. Default: both for a personal device, `gtd` for a work one. */
  roles?: readonly FolderRole[];
  engine?: Partial<
    Omit<SyncEngineOptions, "repo" | "transports" | "profile" | "now" | "localSchemaVersion">
  > & { localSchemaVersion?: number };
}

export interface RepoCall {
  method: "listSyncChanges" | "applySyncBundle" | "markSyncPublished" | "recordSyncPeerApplied";
  domain?: SyncDomain;
}

export interface EngineDevice extends SyncDevice {
  profile: DeviceProfile;
  engine: SyncEngine;
  transports: SyncTransport[];
  /** What the engine asked the repository to do, in order. */
  calls: RepoCall[];
}

export interface EngineWorld {
  sim: SyncHarness;
  folders: MemoryFolders;
  devices: EngineDevice[];
  device(name: string): EngineDevice;
}

const recordingRepo = (device: SyncDevice, calls: RepoCall[]): SyncEngineRepository => ({
  getSyncStatus: () => device.repo.getSyncStatus(),
  listSyncChanges: (domain) => {
    calls.push({ method: "listSyncChanges", domain });
    return device.repo.listSyncChanges(domain);
  },
  applySyncBundle: (domain, changeSet, options) => {
    calls.push({ method: "applySyncBundle", domain });
    return device.repo.applySyncBundle(domain, changeSet, options);
  },
  recordSyncPeerApplied: (input) => {
    calls.push({ method: "recordSyncPeerApplied" });
    return device.repo.recordSyncPeerApplied(input);
  },
  queueSyncRepublish: () => device.repo.queueSyncRepublish(),
  markSyncPublished: (counter) => {
    calls.push({ method: "markSyncPublished" });
    return device.repo.markSyncPublished(counter);
  },
});

export const createEngineWorld = async (
  specs: readonly EngineDeviceSpec[],
  harnessOptions: HarnessOptions = {},
): Promise<EngineWorld> => {
  const sim = await createSyncHarness(
    specs.map((spec) => spec.name),
    harnessOptions,
  );
  const folders = createMemoryFolders();
  const devices: EngineDevice[] = specs.map((spec, index) => {
    const base = sim.devices[index] as SyncDevice;
    const profile = spec.profile ?? "personal";
    const roles =
      spec.roles ?? (profile === "work" ? (["gtd"] as const) : (["gtd", "personal"] as const));
    const transports = roles.map((role) => folders.attach(base.deviceId, role));
    const calls: RepoCall[] = [];
    const { localSchemaVersion, ...rest } = spec.engine ?? {};
    const engine = createSyncEngine({
      repo: recordingRepo(base, calls),
      transports,
      profile,
      now: base.clock.read,
      ...(localSchemaVersion === undefined ? {} : { localSchemaVersion }),
      // The same backup destination story for every simulated device unless a test says otherwise.
      beforeFirstMerge: async () => ({ path: `memory://backup/${base.name}` }),
      ...rest,
    });
    return Object.assign(base, { profile, engine, transports, calls }) as EngineDevice;
  });
  return {
    sim,
    folders,
    devices,
    device(name) {
      const found = devices.find((device) => device.name === name);
      if (!found) throw new Error(`No simulated device named "${name}"`);
      return found;
    },
  };
};

/**
 * Every device syncs (pull, then publish) in turn, a few rounds: the "everyone is online" state in
 * which all folders and databases have caught up with each other.
 */
export const settleWorld = async (world: EngineWorld, rounds = 3): Promise<void> => {
  for (let round = 0; round < rounds; round += 1) {
    for (const device of world.devices) await device.engine.syncNow();
  }
};
