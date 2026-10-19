import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyDesktopShellPrefs } from "./desktop-shell";

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

vi.mock("./storage/factory", () => ({
  isTauriRuntime: () => isTauriRuntimeMock(),
}));

const prefs = { runInTray: false, launchAtLogin: false };

describe("applyDesktopShellPrefs", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    enableMock.mockReset();
    disableMock.mockReset();
    isTauriRuntimeMock.mockReturnValue(true);
    enableMock.mockResolvedValue(undefined);
    disableMock.mockResolvedValue(undefined);
  });

  it("does nothing in browser preview", async () => {
    const result = await applyDesktopShellPrefs({ runInTray: true, launchAtLogin: true }, true);
    expect(result).toEqual({ autostartError: null, trayError: null });
    expect(invokeMock).not.toHaveBeenCalled();
    expect(enableMock).not.toHaveBeenCalled();
  });

  it("sends the tray preference to the host and enables or disables autostart", async () => {
    invokeMock.mockResolvedValue(undefined);
    await applyDesktopShellPrefs({ runInTray: true, launchAtLogin: true }, false);
    expect(invokeMock).toHaveBeenCalledWith("desktop_set_run_in_tray", { runInTray: true });
    expect(enableMock).toHaveBeenCalledTimes(1);
    await applyDesktopShellPrefs(prefs, false);
    expect(disableMock).toHaveBeenCalledTimes(1);
  });

  it("returns trayError without throwing when tray invoke fails", async () => {
    invokeMock.mockRejectedValue(new Error("tray_failed"));
    const result = await applyDesktopShellPrefs(prefs, false);
    expect(result.trayError).toBe("tray_failed");
    expect(result.autostartError).toBeNull();
  });

  it("returns autostartError when autostart fails after tray succeeds", async () => {
    invokeMock.mockResolvedValue(undefined);
    enableMock.mockRejectedValue(new Error("autostart_failed"));
    const result = await applyDesktopShellPrefs({ ...prefs, launchAtLogin: true }, false);
    expect(result.trayError).toBeNull();
    expect(result.autostartError).toBe("autostart_failed");
  });
});
