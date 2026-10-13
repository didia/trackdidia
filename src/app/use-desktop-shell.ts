import { useEffect, useRef } from "react";
import { applyDesktopShellPrefs } from "../lib/desktop-shell";
import type { AppSettings } from "../domain/types";

/**
 * Re-applies the saved tray and launch-at-login preferences once startup has settled, because
 * the native host starts with the tray off. Later changes are applied (and their errors shown)
 * by the Settings section that saves them. Never runs in browser preview or the startup fallback.
 */
export const useDesktopShell = (options: {
  browserPreview: boolean;
  allowStart: boolean;
  settings: AppSettings;
}): void => {
  const { browserPreview, allowStart } = options;
  const settingsRef = useRef(options.settings);
  settingsRef.current = options.settings;

  useEffect(() => {
    if (browserPreview || !allowStart) {
      return;
    }
    const { runInTray, launchAtLogin } = settingsRef.current;
    void applyDesktopShellPrefs({ runInTray, launchAtLogin }, browserPreview);
  }, [browserPreview, allowStart]);
};
