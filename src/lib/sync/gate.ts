import type { AppSettings } from "../../domain/types";
import { syncEngineKeyOf } from "./sync-service";

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

/**
 * Whether anything AUTOMATIC may run: the startup pull, the focus and hourly pulls, the debounced,
 * blur and quit publishes, the status chip. The same two conditions as the `/sync` page: the
 * debug mode and the device-local `multiDeviceSyncEnabled` setting. With either off nothing is
 * scheduled, listened to or pulled, and the app behaves exactly as it did before sync existed.
 */
export const isSyncAutomationEnabled = (
  debugEnabled: boolean,
  settings: Pick<AppSettings, "multiDeviceSyncEnabled">,
): boolean => debugEnabled && settings.multiDeviceSyncEnabled === true;

/**
 * The key the automatic triggers are built for, or `null` when none may exist: browser preview and
 * the startup fallback have nothing to sync, and the gate above decides the rest. A change of key
 * (folders, device name, profile) rebuilds the triggers.
 */
export const syncAutomationKeyFor = (input: {
  browserPreview: boolean;
  startupError: string | null;
  debugEnabled: boolean;
  settings: AppSettings;
}): string | null =>
  !input.browserPreview &&
  input.startupError === null &&
  isSyncAutomationEnabled(input.debugEnabled, input.settings)
    ? syncEngineKeyOf(input.settings)
    : null;
