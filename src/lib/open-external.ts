import { openUrl } from "@tauri-apps/plugin-opener";
import { isTauriRuntime } from "./storage/factory";

/** True for the only link schemes TrackDidia stores and opens: web URLs. */
export const isWebUrl = (value: string | null | undefined): value is string => {
  if (!value) {
    return false;
  }
  try {
    const { protocol } = new URL(value);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
};

/** Opens a web URL in the system browser (desktop) or a new tab (browser preview). */
export const openExternalUrl = async (url: string): Promise<void> => {
  if (!isWebUrl(url)) {
    return;
  }
  if (isTauriRuntime()) {
    await openUrl(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
};
