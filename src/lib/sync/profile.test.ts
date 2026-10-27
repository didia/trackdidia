import { describe, expect, it } from "vitest";
import {
  canPublishDomain,
  canReadDomain,
  DEVICE_PROFILES,
  type DeviceProfile,
  domainsPublishable,
  domainsReadable,
  isDeviceProfile,
} from "./profile";
import { SYNC_DOMAINS, WORK_PROFILE_DOMAINS } from "./registry";

describe("device profile domains", () => {
  it("a personal device reads and publishes every domain", () => {
    expect(domainsReadable("personal")).toEqual(SYNC_DOMAINS);
    expect(domainsPublishable("personal")).toEqual(SYNC_DOMAINS);
  });

  it("a work device reads and publishes the registry's work domains only", () => {
    expect(domainsReadable("work")).toEqual(WORK_PROFILE_DOMAINS);
    expect(domainsPublishable("work")).toEqual(WORK_PROFILE_DOMAINS);
    expect(domainsReadable("work")).toEqual(["gtd"]);
  });

  it("answers per domain", () => {
    expect(canReadDomain("work", "gtd")).toBe(true);
    expect(canPublishDomain("work", "gtd")).toBe(true);
    for (const domain of ["personal", "finance"] as const) {
      expect(canReadDomain("work", domain)).toBe(false);
      expect(canPublishDomain("work", domain)).toBe(false);
      expect(canReadDomain("personal", domain)).toBe(true);
      expect(canPublishDomain("personal", domain)).toBe(true);
    }
  });

  it("a profile outside the type gets no domain at all", () => {
    const bogus = "admin" as unknown as DeviceProfile;
    expect(domainsReadable(bogus)).toEqual([]);
    expect(domainsPublishable(bogus)).toEqual([]);
  });

  it("recognizes the profiles", () => {
    for (const profile of DEVICE_PROFILES) expect(isDeviceProfile(profile)).toBe(true);
    for (const value of ["", "Work", null, undefined, 3, {}])
      expect(isDeviceProfile(value)).toBe(false);
  });

  it("returns domains in registry order, without duplicates", () => {
    for (const profile of DEVICE_PROFILES) {
      const readable = domainsReadable(profile);
      expect(new Set(readable).size).toBe(readable.length);
      expect(readable).toEqual(SYNC_DOMAINS.filter((domain) => readable.includes(domain)));
    }
  });
});
