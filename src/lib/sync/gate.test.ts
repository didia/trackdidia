import { describe, expect, it } from "vitest";
import { isSyncCardVisible, isSyncPageEnabled } from "./gate";

describe("sync gates", () => {
  it("shows the Settings card only with debug mode on", () => {
    expect(isSyncCardVisible(true)).toBe(true);
    expect(isSyncCardVisible(false)).toBe(false);
  });

  it("opens the page and nav entry only with debug mode AND the setting on", () => {
    expect(isSyncPageEnabled(true, { multiDeviceSyncEnabled: true })).toBe(true);
    expect(isSyncPageEnabled(true, { multiDeviceSyncEnabled: false })).toBe(false);
    expect(isSyncPageEnabled(false, { multiDeviceSyncEnabled: true })).toBe(false);
    expect(isSyncPageEnabled(false, { multiDeviceSyncEnabled: false })).toBe(false);
  });
});
