import type { DeviceProfile } from "./profile";
import {
  FOREIGN_TO_WORK_DOMAINS,
  foreignToWorkCounts,
  hasForeignToWorkData,
  isVerifiedEmptyDatabase,
  type ProfileDataCounts,
  type ProfileDataInspection,
} from "./profile-data";

/**
 * The rules for changing or choosing a device profile, as pure functions of the current profile and
 * an inspection of the database (spec "Work profile" and "Joining the second laptop"). Nothing here
 * touches storage and nothing offers a screen: `sync-service.ts` calls them and throws a typed error,
 * and a later slice renders the decision.
 *
 * - `work` -> `personal` is allowed: the user is asked for the personal folder and then the other
 *   domains are imported.
 * - `personal` -> `work` on a database holding personal or finance rows is refused, with the counts
 *   per domain. The user starts the work laptop from a fresh database instead; there is deliberately
 *   no "keep them local" option, because hidden rows and the backups holding them would still be
 *   readable on the work laptop.
 * - The same profile again is a no-op.
 */

/** What a person has to do next after an allowed change. */
export type ProfileChangeStep =
  /** `work` -> `personal`: pick the personal folder (the backup folder) before importing. */
  | "choose_personal_folder"
  /** `work` -> `personal`: pull personal and finance data from the other laptops. */
  | "import_other_domains"
  /** `personal` -> `work`: only the shared GTD folder is used from now on. */
  | "use_gtd_folder_only";

export type ProfileChangeDecision =
  | { kind: "noop"; profile: DeviceProfile }
  | {
      kind: "allowed";
      from: DeviceProfile;
      to: DeviceProfile;
      steps: ProfileChangeStep[];
    }
  | {
      kind: "refused";
      from: DeviceProfile;
      to: DeviceProfile;
      reason: "work_profile_needs_fresh_database";
      /** Personal and finance rows that block the change (seed rows excluded). */
      counts: { personal: number; finance: number };
    };

/**
 * Decides a profile change. `inspection` must cover at least the personal and finance domains; it is
 * only consulted for a change TO `work`.
 */
export const decideProfileChange = (input: {
  from: DeviceProfile;
  to: DeviceProfile;
  inspection: Pick<ProfileDataInspection, "counts">;
}): ProfileChangeDecision => {
  const { from, to } = input;
  if (from === to) return { kind: "noop", profile: to };
  if (to === "personal") {
    return {
      kind: "allowed",
      from,
      to,
      steps: ["choose_personal_folder", "import_other_domains"],
    };
  }
  if (hasForeignToWorkData(input.inspection)) {
    return {
      kind: "refused",
      from,
      to,
      reason: "work_profile_needs_fresh_database",
      counts: foreignToWorkCounts(input.inspection),
    };
  }
  return { kind: "allowed", from, to, steps: ["use_gtd_folder_only"] };
};

export type JoinDecision =
  | {
      kind: "allowed";
      profile: DeviceProfile;
      /** Nothing but seed rows: the safety backup is skipped (and the skip recorded). */
      verifiedEmpty: boolean;
      /** The database holds data: a backup destination is required and the backup is taken first. */
      requiresBackup: boolean;
      /** What each side holds, for the "counts per domain" the join screen shows. */
      counts: ProfileDataCounts;
    }
  | {
      kind: "refused";
      profile: "work";
      reason: "work_profile_needs_fresh_database";
      counts: { personal: number; finance: number };
    };

/**
 * Decides whether this database may JOIN an existing sync as `profile`. A `personal` join is always
 * allowed (a database that holds data is merged after a backup). A `work` join is allowed only when no
 * personal or finance row exists: GTD and Pomodoro rows alone are fine (then backup-then-merge).
 * `inspection` must cover all three domains.
 */
export const decideJoin = (input: {
  profile: DeviceProfile;
  inspection: Pick<ProfileDataInspection, "counts">;
}): JoinDecision => {
  const { profile, inspection } = input;
  if (profile === "work" && hasForeignToWorkData(inspection)) {
    return {
      kind: "refused",
      profile: "work",
      reason: "work_profile_needs_fresh_database",
      counts: foreignToWorkCounts(inspection),
    };
  }
  const verifiedEmpty = isVerifiedEmptyDatabase(inspection);
  return {
    kind: "allowed",
    profile,
    verifiedEmpty,
    requiresBackup: !verifiedEmpty,
    counts: { ...inspection.counts },
  };
};

/** One line per non-empty blocking domain, "personal: 3, finance: 12". Empty when nothing blocks. */
export const describeForeignCounts = (counts: { personal: number; finance: number }): string =>
  FOREIGN_TO_WORK_DOMAINS.filter((domain) => counts[domain] > 0)
    .map((domain) => `${domain}: ${counts[domain]}`)
    .join(", ");
