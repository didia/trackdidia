import type { AppSettings } from "../../domain/types";

/**
 * Multi-device sync is EXPERIMENTAL and must stay hard to enable by accident. It is reachable only
 * with the app's debug mode on (see `lib/debug.ts`), and its page and navigation entry also need the
 * device-local `multiDeviceSyncEnabled` setting. The final sync slice removes this file's debug
 * requirement; until then every UI gate goes through these two functions.
 */

/** The Settings card that enables sync. */
export const isSyncCardVisible = (debugEnabled: boolean): boolean => debugEnabled;

/** The `/sync` page content and its navigation entry. */
export const isSyncPageEnabled = (
  debugEnabled: boolean,
  settings: Pick<AppSettings, "multiDeviceSyncEnabled">,
): boolean => debugEnabled && settings.multiDeviceSyncEnabled === true;
