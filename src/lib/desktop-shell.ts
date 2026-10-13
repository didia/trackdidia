import { invoke } from "@tauri-apps/api/core";
import { disable, enable } from "@tauri-apps/plugin-autostart";
import { isTauriRuntime } from "./storage/factory";

export interface DesktopShellPrefs {
  runInTray: boolean;
  launchAtLogin: boolean;
}

export interface DesktopShellResult {
  autostartError: string | null;
  trayError: string | null;
}

/**
 * Applies the tray and launch-at-login preferences to the native host. The two failures are
 * reported independently so one cannot hide the other; neither throws.
 */
export const applyDesktopShellPrefs = async (
  prefs: DesktopShellPrefs,
  browserPreview: boolean,
): Promise<DesktopShellResult> => {
  if (browserPreview || !isTauriRuntime()) {
    return { autostartError: null, trayError: null };
  }
  let trayError: string | null = null;
  try {
    await invoke("desktop_set_run_in_tray", { runInTray: prefs.runInTray });
  } catch (error) {
    trayError = error instanceof Error ? error.message : "tray_prefs_failed";
  }
  try {
    if (prefs.launchAtLogin) {
      await enable();
    } else {
      await disable();
    }
    return { autostartError: null, trayError };
  } catch (error) {
    return {
      autostartError: error instanceof Error ? error.message : "autostart_failed",
      trayError,
    };
  }
};
