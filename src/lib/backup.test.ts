import { defaultAppSettings } from "../domain/daily-entry";
import { mergeAppSettingsWithDefaults } from "./relationship-draws";
import {
  BACKUP_RETENTION_COUNT,
  buildBackupFileName,
  isAutoBackupDue,
  isBackupDestinationConfigured,
  isBackupDestinationMissing,
  resolveBackupDir
} from "./backup";

describe("backup helpers", () => {
  it("marks auto backup as due when no previous backup exists", () => {
    expect(isAutoBackupDue("", 24, Date.parse("2026-03-31T12:00:00.000Z"))).toBe(true);
  });

  it("marks auto backup as due after the configured interval", () => {
    expect(
      isAutoBackupDue(
        "2026-03-30T10:00:00.000Z",
        24,
        Date.parse("2026-03-31T10:00:01.000Z")
      )
    ).toBe(true);
  });

  it("builds a stable backup filename", () => {
    expect(buildBackupFileName("2026-03-31T10:15:22.456Z", "manual")).toBe(
      "trackdidia-manual-backup-2026-03-31T10-15-22-456Z.db"
    );
  });

  it("keeps a 30-file retention cap", () => {
    expect(BACKUP_RETENTION_COUNT).toBe(30);
  });

  it("treats an empty destination as unconfigured", () => {
    expect(isBackupDestinationConfigured("")).toBe(false);
    expect(isBackupDestinationConfigured("   ")).toBe(false);
    expect(isBackupDestinationConfigured("/Users/didia/Google Drive/TrackDidia")).toBe(true);
  });

  it("flags a missing destination only when auto-backup is enabled", () => {
    expect(
      isBackupDestinationMissing({ autoBackupEnabled: true, backupDestinationDir: "" })
    ).toBe(true);
    expect(
      isBackupDestinationMissing({
        autoBackupEnabled: true,
        backupDestinationDir: "/Users/didia/Drive/TrackDidia"
      })
    ).toBe(false);
    expect(
      isBackupDestinationMissing({ autoBackupEnabled: false, backupDestinationDir: "" })
    ).toBe(false);
  });

  it("resolves production and development backup subfolders", () => {
    expect(resolveBackupDir("/Users/didia/Drive/TrackDidia", "production")).toBe(
      "/Users/didia/Drive/TrackDidia/backups"
    );
    expect(resolveBackupDir("/Users/didia/Drive/TrackDidia", "development")).toBe(
      "/Users/didia/Drive/TrackDidia/backups-dev"
    );
  });

  it("defaults backupDestinationDir to empty on existing settings", () => {
    const merged = mergeAppSettingsWithDefaults({}, defaultAppSettings());
    expect(merged.backupDestinationDir).toBe("");
  });

  it("preserves a stored aiMaxTokens of 700 instead of rewriting it", () => {
    const merged = mergeAppSettingsWithDefaults({ aiMaxTokens: 700 }, defaultAppSettings());
    expect(merged.aiMaxTokens).toBe(700);
  });

  it("preserves a custom aiMaxTokens value", () => {
    const merged = mergeAppSettingsWithDefaults({ aiMaxTokens: 8000 }, defaultAppSettings());
    expect(merged.aiMaxTokens).toBe(8000);
  });
});
