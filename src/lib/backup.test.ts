import { buildBackupFileName, isAutoBackupDue } from "./backup";

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
});
