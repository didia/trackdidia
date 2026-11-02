import { logDebug } from "../debug";
import { SYNC_QUIT_PUBLISH_CAP_MS } from "./lifecycle-policy";

/**
 * Best-effort publish when the window is closed, capped at 3 seconds.
 *
 * Tauri 2: once ANY JavaScript listener for the close request exists, the native side stops closing
 * the window by itself and the JavaScript wrapper calls `destroy()` after the handler unless the
 * handler called `preventDefault()`. That is why `core:window:allow-destroy` is in
 * `src-tauri/capabilities/default.json`, and why the handler below can never leave the window open on
 * the normal path: it waits for the capped publish (errors included) and returns, and the wrapper
 * destroys the window.
 *
 * In tray mode the native close handler hides the window instead of closing it; the handler then
 * prevents the JavaScript wrapper's `destroy()` and publishes nothing (hiding blurs the window, which
 * already publishes).
 *
 * Registered only while the automatic triggers are on (debug gate open and sync enabled); with sync
 * off no listener exists, so the window closes exactly as before. NOT exercised in a real Tauri
 * window here (no desktop in the development environment): the logic is tested against a fake
 * window, and the manual check is listed in docs/multi-device-sync.md.
 */

export interface CloseRequestEvent {
  preventDefault(): void;
}

export interface QuitWindow {
  onCloseRequested(
    handler: (event: CloseRequestEvent) => Promise<void> | void,
  ): Promise<() => void>;
}

export const loadTauriWindow = async (): Promise<QuitWindow> => {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  return getCurrentWindow() as unknown as QuitWindow;
};

export interface QuitPublishOptions {
  /** The quit-time publish: `SyncLifecycle.quit`. */
  quit: (capMs: number) => Promise<void>;
  isTrayMode: () => boolean;
  loadWindow?: () => Promise<QuitWindow>;
  capMs?: number;
}

/** Registers the close handler; resolves to a function that removes it. Never rejects. */
export const registerQuitPublish = async (options: QuitPublishOptions): Promise<() => void> => {
  const capMs = options.capMs ?? SYNC_QUIT_PUBLISH_CAP_MS;
  try {
    const window = await (options.loadWindow ?? loadTauriWindow)();
    return await window.onCloseRequested(async (event) => {
      if (options.isTrayMode()) {
        event.preventDefault();
        return;
      }
      try {
        await options.quit(capMs);
      } catch (error) {
        // Whatever happened, the window must still close.
        logDebug("warn", "sync.lifecycle", "Publication a la fermeture en echec", error);
      }
    });
  } catch (error) {
    logDebug("info", "sync.lifecycle", "Publication a la fermeture indisponible", error);
    return () => undefined;
  }
};
