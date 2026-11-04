import { describe, expect, it } from "vitest";
import { defaultAppSettings } from "../../domain/settings";
import {
  isSyncAutomationEnabled,
  isSyncCardVisible,
  isSyncPageEnabled,
  syncAutomationKeyFor,
} from "./gate";
import { syncEngineKeyOf } from "./sync-service";

describe("sync gates", () => {
  it("shows the Settings card without debug mode", () => {
    expect(isSyncCardVisible(true)).toBe(true);
    expect(isSyncCardVisible(false)).toBe(true);
  });

  it("opens the page and nav entry only with the setting on", () => {
    expect(isSyncPageEnabled(true, { multiDeviceSyncEnabled: true })).toBe(true);
    expect(isSyncPageEnabled(true, { multiDeviceSyncEnabled: false })).toBe(false);
    expect(isSyncPageEnabled(false, { multiDeviceSyncEnabled: true })).toBe(true);
    expect(isSyncPageEnabled(false, { multiDeviceSyncEnabled: false })).toBe(false);
  });

  it("runs anything automatic only under the same two conditions as the page", () => {
    for (const debug of [true, false]) {
      for (const enabled of [true, false]) {
        expect(isSyncAutomationEnabled(debug, { multiDeviceSyncEnabled: enabled })).toBe(
          isSyncPageEnabled(debug, { multiDeviceSyncEnabled: enabled }),
        );
      }
    }
    expect(isSyncAutomationEnabled(true, { multiDeviceSyncEnabled: true })).toBe(true);
    expect(isSyncAutomationEnabled(false, { multiDeviceSyncEnabled: true })).toBe(true);
    expect(isSyncAutomationEnabled(true, { multiDeviceSyncEnabled: false })).toBe(false);
  });

  it("builds the automation key only on the desktop storage with the gate open", () => {
    const settings = { ...defaultAppSettings(), multiDeviceSyncEnabled: true };
    const open = { browserPreview: false, startupError: null, debugEnabled: true, settings };
    expect(syncAutomationKeyFor(open)).toBe(syncEngineKeyOf(settings));
    expect(syncAutomationKeyFor({ ...open, browserPreview: true })).toBeNull();
    expect(syncAutomationKeyFor({ ...open, startupError: "sqlite exploded" })).toBeNull();
    expect(syncAutomationKeyFor({ ...open, debugEnabled: false })).toBe(syncEngineKeyOf(settings));
    expect(
      syncAutomationKeyFor({
        ...open,
        settings: { ...settings, multiDeviceSyncEnabled: false },
      }),
    ).toBeNull();
  });

  it("changes the key when a folder, the device name or the profile changes", () => {
    const settings = { ...defaultAppSettings(), multiDeviceSyncEnabled: true };
    const base = { browserPreview: false, startupError: null, debugEnabled: true, settings };
    const key = syncAutomationKeyFor(base);
    for (const change of [
      { syncGtdFolderDir: "/other" },
      { backupDestinationDir: "/elsewhere" },
      { syncDeviceName: "Renamed" },
    ]) {
      expect(syncAutomationKeyFor({ ...base, settings: { ...settings, ...change } })).not.toBe(key);
    }
  });
});
