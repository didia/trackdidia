import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultEmailTriageGlobalSettings } from "../../domain/email-triage";
import { applyEmailTriageDesktopPrefs } from "./desktop-prefs";

const invokeMock = vi.fn();
const enableMock = vi.fn();
const disableMock = vi.fn();
const isTauriRuntimeMock = vi.fn(() => true);

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@tauri-apps/plugin-autostart", () => ({
  enable: (...args: unknown[]) => enableMock(...args),
  disable: (...args: unknown[]) => disableMock(...args),
}));

vi.mock("../storage/factory", () => ({
  isTauriRuntime: () => isTauriRuntimeMock(),
}));

describe("applyEmailTriageDesktopPrefs", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    enableMock.mockReset();
    disableMock.mockReset();
    isTauriRuntimeMock.mockReturnValue(true);
    enableMock.mockResolvedValue(undefined);
    disableMock.mockResolvedValue(undefined);
  });

  it("returns trayError without throwing when tray invoke fails", async () => {
    invokeMock.mockRejectedValue(new Error("tray_failed"));
    disableMock.mockResolvedValue(undefined);
    const result = await applyEmailTriageDesktopPrefs(defaultEmailTriageGlobalSettings(), false);
    expect(result.trayError).toBe("tray_failed");
    expect(result.autostartError).toBeNull();
  });

  it("returns autostartError when autostart fails after tray succeeds", async () => {
    invokeMock.mockResolvedValue(undefined);
    enableMock.mockRejectedValue(new Error("autostart_failed"));
    const result = await applyEmailTriageDesktopPrefs(
      { ...defaultEmailTriageGlobalSettings(), launchAtLogin: true },
      false,
    );
    expect(result.trayError).toBeNull();
    expect(result.autostartError).toBe("autostart_failed");
  });
});
