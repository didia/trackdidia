import { invoke } from "@tauri-apps/api/core";
import { disable, enable } from "@tauri-apps/plugin-autostart";
import type { EmailTriageGlobalSettings } from "../../domain/email-triage";
import { isTauriRuntime } from "../storage/factory";

export const applyEmailTriageDesktopPrefs = async (
  settings: EmailTriageGlobalSettings,
  browserPreview: boolean,
): Promise<{ autostartError: string | null }> => {
  if (browserPreview || !isTauriRuntime()) {
    return { autostartError: null };
  }
  await invoke("email_triage_set_desktop_prefs", {
    runInTray: settings.runInTray,
  });
  try {
    if (settings.launchAtLogin) {
      await enable();
    } else {
      await disable();
    }
    return { autostartError: null };
  } catch (error) {
    return {
      autostartError: error instanceof Error ? error.message : "autostart_failed",
    };
  }
};
