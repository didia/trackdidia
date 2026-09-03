import { defaultAppSettings } from "../domain/daily-entry";
import { mergeAppSettingsWithDefaults } from "./relationship-draws";
import {
  BACKUP_FILE_NAME_PATTERN,
  BACKUP_RETENTION_COUNT,
  buildBackupFileName,
  isAutoBackupDue,
  isBackupDestinationConfigured,
  resolveBackupDir,
  selectBackupsToPrune
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

  it("resolves production and development backup subfolders", () => {
    expect(resolveBackupDir("/Users/didia/Drive/TrackDidia", "production")).toBe(
      "/Users/didia/Drive/TrackDidia/backups"
    );
    expect(resolveBackupDir("/Users/didia/Drive/TrackDidia", "development")).toBe(
      "/Users/didia/Drive/TrackDidia/backups-dev"
    );
  });

  it("matches only TrackDidia backup filenames", () => {
    expect(BACKUP_FILE_NAME_PATTERN.test("trackdidia-manual-backup-2026-03-31T10-15-22-456Z.db")).toBe(true);
    expect(BACKUP_FILE_NAME_PATTERN.test("trackdidia-auto-backup-2026-03-31T10-15-22-456Z.db")).toBe(true);
    expect(BACKUP_FILE_NAME_PATTERN.test("notes.txt")).toBe(false);
    expect(BACKUP_FILE_NAME_PATTERN.test("trackdidia.db")).toBe(false);
  });

  it("prunes older backups beyond the retention cap and ignores unrelated files", () => {
    const backups = Array.from({ length: 32 }, (_, index) => {
      const kind = index % 2 === 0 ? "manual" : "auto";
      const day = String(index + 1).padStart(2, "0");
      return `trackdidia-${kind}-backup-2026-03-${day}T10-15-22-456Z.db`;
    });
    const names = [...backups, "notes.txt", "random.db", ".DS_Store"];

    expect(selectBackupsToPrune(names)).toEqual([
      "trackdidia-manual-backup-2026-03-01T10-15-22-456Z.db",
      "trackdidia-auto-backup-2026-03-02T10-15-22-456Z.db"
    ]);
  });

  it("does not prune when there are 30 or fewer matching backups", () => {
    const names = Array.from({ length: 30 }, (_, index) => {
      const day = String(index + 1).padStart(2, "0");
      return `trackdidia-auto-backup-2026-04-${day}T08-00-00-000Z.db`;
    });

    expect(selectBackupsToPrune(names)).toEqual([]);
  });

  it("defaults backupDestinationDir to empty on existing settings", () => {
    const merged = mergeAppSettingsWithDefaults({}, defaultAppSettings());
    expect(merged.backupDestinationDir).toBe("");
  });
});
