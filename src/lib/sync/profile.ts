import { SYNC_DOMAINS, type SyncDomain, WORK_PROFILE_DOMAINS } from "./registry";

/**
 * The device profile decides which domains a device may read from peers, apply, and publish (spec:
 * "Work profile"). `personal` handles every domain; `work` handles `WORK_PROFILE_DOMAINS` only (the
 * GTD list and Pomodoro history, nothing else).
 *
 * Pure and storage-free. The `work` profile is NOT user-selectable yet ({@link WORK_PROFILE_SELECTABLE};
 * a later slice ships the work shell and the join flow), but the sync engine, the repository
 * (`profile-guard.ts`) and the startup re-check (`engine-profile.ts`) already enforce it, so the
 * isolation can be tested now.
 */

/**
 * Whether the release lets a user CHOOSE the `work` profile. It does not, until the work shell, the
 * join flow and the three-device isolation test have shipped (spec "Phases"). The data-layer guards
 * (`profile-guard.ts`, `profile-data.ts`, `profile-rules.ts`, the engine's re-check) and the service
 * path exist and are tested through the seam `SyncServiceDeps.workProfileSelectable`, which
 * defaults to this constant. Nothing in the UI reads it: flipping it is a deliberate, reviewed change.
 */
export const WORK_PROFILE_SELECTABLE = false;

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
