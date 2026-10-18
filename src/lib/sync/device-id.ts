import { invoke } from "@tauri-apps/api/core";

/**
 * Returns this installation's device id (`dev:<uuid v4>`), stored by the native host in a file
 * beside the database. The host creates it on first call and never regenerates it; a corrupt
 * file rejects with an error string rather than silently minting a new identity.
 */
export const getDeviceId = async (): Promise<string> => {
  try {
    return await invoke<string>("sync_device_id");
  } catch (error) {
    throw new Error(
      typeof error === "string"
        ? error
        : error instanceof Error
          ? error.message
          : "sync_device_id_failed",
    );
  }
};
