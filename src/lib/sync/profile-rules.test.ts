import { describe, expect, it } from "vitest";
import { emptyProfileDataCounts, type ProfileDataCounts } from "./profile-data";
import { decideJoin, decideProfileChange, describeForeignCounts } from "./profile-rules";

const counts = (overrides: Partial<ProfileDataCounts> = {}) => ({
  counts: { ...emptyProfileDataCounts(), ...overrides },
});

describe("decideProfileChange", () => {
  it("the same profile is a no-op, whatever the database holds", () => {
    expect(
      decideProfileChange({ from: "personal", to: "personal", inspection: counts({ finance: 9 }) }),
    ).toEqual({ kind: "noop", profile: "personal" });
    expect(
      decideProfileChange({ from: "work", to: "work", inspection: counts({ personal: 9 }) }),
    ).toEqual({ kind: "noop", profile: "work" });
  });

  it("work -> personal is allowed: ask for the personal folder, then import the other domains", () => {
    expect(
      decideProfileChange({ from: "work", to: "personal", inspection: counts({ personal: 3 }) }),
    ).toEqual({
      kind: "allowed",
      from: "work",
      to: "personal",
      steps: ["choose_personal_folder", "import_other_domains"],
    });
  });

  it("personal -> work is refused with the counts per domain when personal or finance rows exist", () => {
    for (const held of [{ personal: 1 }, { finance: 1 }, { personal: 4, finance: 12 }]) {
      const decision = decideProfileChange({
        from: "personal",
        to: "work",
        inspection: counts({ gtd: 50, ...held }),
      });
      expect(decision).toEqual({
        kind: "refused",
        from: "personal",
        to: "work",
        reason: "work_profile_needs_fresh_database",
        counts: { personal: held.personal ?? 0, finance: held.finance ?? 0 },
      });
    }
  });

  it("personal -> work is allowed when only GTD rows exist (they are what a work laptop holds)", () => {
    expect(
      decideProfileChange({ from: "personal", to: "work", inspection: counts({ gtd: 200 }) }),
    ).toEqual({ kind: "allowed", from: "personal", to: "work", steps: ["use_gtd_folder_only"] });
  });
});

describe("decideJoin", () => {
  it("a work join on a database with any personal or finance row is refused", () => {
    expect(decideJoin({ profile: "work", inspection: counts({ personal: 2 }) })).toEqual({
      kind: "refused",
      profile: "work",
      reason: "work_profile_needs_fresh_database",
      counts: { personal: 2, finance: 0 },
    });
    expect(decideJoin({ profile: "work", inspection: counts({ finance: 1, gtd: 3 }) }).kind).toBe(
      "refused",
    );
  });

  it("a work join on an empty database skips the backup (verified empty joiner)", () => {
    expect(decideJoin({ profile: "work", inspection: counts() })).toEqual({
      kind: "allowed",
      profile: "work",
      verifiedEmpty: true,
      requiresBackup: false,
      counts: emptyProfileDataCounts(),
    });
  });

  it("a work join on a database holding GTD rows only is allowed, after a backup", () => {
    expect(decideJoin({ profile: "work", inspection: counts({ gtd: 7 }) })).toMatchObject({
      kind: "allowed",
      verifiedEmpty: false,
      requiresBackup: true,
      counts: { gtd: 7, personal: 0, finance: 0 },
    });
  });

  it("a personal join is always allowed; data means a backup first, with the counts of each side", () => {
    expect(
      decideJoin({ profile: "personal", inspection: counts({ personal: 5, finance: 2, gtd: 1 }) }),
    ).toMatchObject({
      kind: "allowed",
      requiresBackup: true,
      verifiedEmpty: false,
      counts: { gtd: 1, personal: 5, finance: 2 },
    });
    expect(decideJoin({ profile: "personal", inspection: counts() })).toMatchObject({
      kind: "allowed",
      requiresBackup: false,
      verifiedEmpty: true,
    });
  });
});

describe("describeForeignCounts", () => {
  it("names only the blocking domains", () => {
    expect(describeForeignCounts({ personal: 3, finance: 0 })).toBe("personal: 3");
    expect(describeForeignCounts({ personal: 3, finance: 12 })).toBe("personal: 3, finance: 12");
    expect(describeForeignCounts({ personal: 0, finance: 0 })).toBe("");
  });
});
