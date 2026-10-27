import { SYNC_DOMAINS, type SyncDomain, WORK_PROFILE_DOMAINS } from "./registry";

/**
 * The device profile decides which domains a device may read from peers, apply, and publish (spec:
 * "Work profile"). `personal` handles every domain; `work` handles `WORK_PROFILE_DOMAINS` only (the
 * GTD list and Pomodoro history, nothing else).
 *
 * Pure and storage-free. The `work` profile is NOT user-selectable yet (a later slice ships the work
 * shell, join flow and startup re-check together), but the sync engine already enforces it on both
 * sides so the isolation can be tested now.
 */

export const DEVICE_PROFILES = ["personal", "work"] as const;
export type DeviceProfile = (typeof DEVICE_PROFILES)[number];

export const isDeviceProfile = (value: unknown): value is DeviceProfile =>
  typeof value === "string" && (DEVICE_PROFILES as readonly string[]).includes(value);

const domainsOf = (profile: DeviceProfile): readonly SyncDomain[] => {
  switch (profile) {
    case "personal":
      return SYNC_DOMAINS;
    case "work":
      return WORK_PROFILE_DOMAINS;
    default:
      // A value outside the type (a manifest or setting read from disk) gets nothing at all.
      return [];
  }
};

/** Domains a device of this profile may apply from a peer. Registry order. */
export const domainsReadable = (profile: DeviceProfile): readonly SyncDomain[] =>
  domainsOf(profile);

/** Domains a device of this profile may publish. Registry order. */
export const domainsPublishable = (profile: DeviceProfile): readonly SyncDomain[] =>
  domainsOf(profile);

export const canReadDomain = (profile: DeviceProfile, domain: SyncDomain): boolean =>
  domainsReadable(profile).includes(domain);

export const canPublishDomain = (profile: DeviceProfile, domain: SyncDomain): boolean =>
  domainsPublishable(profile).includes(domain);
