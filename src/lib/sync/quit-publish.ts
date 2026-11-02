import { logDebug } from "../debug";
import { SYNC_QUIT_PUBLISH_CAP_MS } from "./lifecycle-policy";

/**
 * Best-effort publish when the window is closed or the application quits, capped at 3 seconds.
 *
 * Two exits exist and BOTH publish. Closing the window: {@link registerQuitPublish}, below. The
 * tray's Quitter action (`desktop_shell.rs`), which exits the process without any window close:
 * {@link registerExitPublish}, at the end of this file; the host emits `desktop-quit-requested`, the
 * webview runs the same capped publish and answers with the `desktop_exit` command, and the host
 * exits by itself after 4 s if no answer comes. Neither exists while sync automation is off.
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

/**
 * The host side of the tray's Quitter action (`src-tauri/src/desktop_shell.rs`): the event the host
 * emits when a quit is requested while the handshake is on, the command that turns the handshake on
 * and off, and the command that finally exits. Kept as one seam so tests drive the real exit path with
 * a fake event bus and a fake invoke.
 */
export const QUIT_REQUESTED_EVENT = "desktop-quit-requested";

export interface ExitBridge {
  /** Listens to {@link QUIT_REQUESTED_EVENT}; resolves to the function that stops listening. */
  onQuitRequested(handler: () => void): Promise<() => void>;
  /** Tells the host whether this webview answers a quit request (`desktop_set_exit_handshake`). */
  setHandshake(enabled: boolean): Promise<void>;
  /** Exits the process (`desktop_exit`). */
  exit(): Promise<void>;
}

export const loadTauriExitBridge = async (): Promise<ExitBridge> => {
  const [{ listen }, { invoke }] = await Promise.all([
    import("@tauri-apps/api/event"),
    import("@tauri-apps/api/core"),
  ]);
  return {
    onQuitRequested: (handler) => listen(QUIT_REQUESTED_EVENT, () => handler()),
    setHandshake: (enabled) => invoke("desktop_set_exit_handshake", { enabled }),
    exit: () => invoke("desktop_exit"),
  };
};

export interface ExitPublishOptions {
  /** The quit-time publish: `SyncLifecycle.quit`. */
  quit: (capMs: number) => Promise<void>;
  loadBridge?: () => Promise<ExitBridge>;
  capMs?: number;
}

// Registrations alive in this webview and the handshake calls sent for them. Tauri does not
// guarantee that two in-flight invokes reach the host in call order, so they are sent one after
// another; the host is told "off" only when the last registration goes away, so a registration that
// is torn down late (a lifecycle rebuilt for new settings) cannot switch off the handshake of its
// successor.
let activeExitRegistrations = 0;
let handshakeCalls: Promise<unknown> = Promise.resolve();
const sendHandshake = (bridge: ExitBridge, enabled: boolean): Promise<void> => {
  const call = handshakeCalls.then(
    () => bridge.setHandshake(enabled),
    () => bridge.setHandshake(enabled),
  );
  handshakeCalls = call.catch(() => undefined);
  return call;
};

/** One registration's liveness; its event callback checks it, `release` clears it, synchronously. */
interface Registration {
  live: boolean;
}

/**
 * The remover of one registration (idempotent); `counted` says whether it holds a count. The very
 * first thing it does is make the registration's event callback inert: the listener itself stays
 * attached until the host has been told to stop waiting (an asynchronous command), and in that window
 * a Quitter must neither publish nor exit on behalf of a registration that no longer exists (its
 * lifecycle is stopped, so its publish would return at once and its exit would cut off the successor's
 * publish).
 */
const release = (
  registration: Registration,
  bridge: ExitBridge | null,
  stopListening: (() => void) | null,
  counted: boolean,
): (() => void) => {
  return () => {
    if (!registration.live) return;
    registration.live = false;
    if (counted) activeExitRegistrations -= 1;
    if (counted && activeExitRegistrations === 0 && bridge !== null) {
      // The host stops waiting first; only then does the listener go (the other order would leave a
      // window in which the host waits for a listener that is gone).
      sendHandshake(bridge, false)
        .catch((error) => {
          logDebug("info", "sync.lifecycle", "Arret de l'attente de sortie impossible", error);
        })
        .finally(() => stopListening?.());
      return;
    }
    stopListening?.();
  };
};

/**
 * Makes the tray's Quitter publish first. Registered only while the automatic triggers are on, and
 * only then does the host wait for the webview: with sync off no listener exists and the host is never
 * told to wait, so Quitter exits at once exactly as before.
 *
 * On the event: run the capped publish (a failure is logged and ignored), then call `desktop_exit`
 * whatever happened. The cap here is a second line of defence in case `quit` ignores its own cap; the
 * host's 4 s timer is the third. Resolves to a function that switches the handshake off and stops
 * listening, in that order (the other order would leave the host waiting for a listener that is gone).
 * A released registration is inert at once (see {@link release}); only a live one publishes and exits,
 * and if none is live the host's own timer (or its already-off handshake) ends the quit.
 * Never rejects: when the event bus or the handshake command is unavailable the registration is undone
 * and the tray keeps exiting at once.
 */
export const registerExitPublish = async (options: ExitPublishOptions): Promise<() => void> => {
  const capMs = options.capMs ?? SYNC_QUIT_PUBLISH_CAP_MS;
  let stopListening: (() => void) | null = null;
  let bridge: ExitBridge | null = null;
  let counted = false;
  const registration: Registration = { live: true };
  try {
    bridge = await (options.loadBridge ?? loadTauriExitBridge)();
    const live = bridge;
    let handling = false;
    stopListening = await live.onQuitRequested(() => {
      if (!registration.live || handling) return;
      handling = true;
      void (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const cap = new Promise<void>((resolve) => {
            timer = setTimeout(resolve, capMs);
          });
          await Promise.race([options.quit(capMs), cap]);
        } catch (error) {
          logDebug("warn", "sync.lifecycle", "Publication a la sortie en echec", error);
        } finally {
          clearTimeout(timer);
        }
        try {
          await live.exit();
        } catch (error) {
          // The host's own timer still exits the process.
          logDebug("warn", "sync.lifecycle", "Sortie de l'application en echec", error);
        }
      })();
    });
    activeExitRegistrations += 1;
    counted = true;
    await sendHandshake(live, true);
  } catch (error) {
    logDebug("info", "sync.lifecycle", "Publication a la sortie indisponible", error);
    // Undo whatever was done, in the safe order (handshake off, then stop listening).
    release(registration, bridge, stopListening, counted)();
    return () => undefined;
  }
  return release(registration, bridge, stopListening, counted);
};
