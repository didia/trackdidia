import type { AppSettings } from "../../domain/types";
import { syncEngineKeyOf } from "./sync-service";

/** The Settings card is available without debug mode. */
export const isSyncCardVisible = (_debugEnabled: boolean): boolean => true;

/** Sync and its automation remain opt-in on each device. */
export const isSyncPageEnabled = (
  _debugEnabled: boolean,
  settings: Pick<AppSettings, "multiDeviceSyncEnabled">,
): boolean => settings.multiDeviceSyncEnabled === true;

export const isSyncAutomationEnabled = isSyncPageEnabled;

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
