import { type MutableRefObject, useEffect, useRef, useState } from "react";
import { logDebug } from "../lib/debug";
import type { AppRepository } from "../lib/storage/repository";
import {
  createSyncLifecycle,
  type LifecycleRunner,
  type LifecycleSnapshot,
  type SyncLifecycle,
} from "../lib/sync/lifecycle";
import {
  type ExitBridge,
  type QuitWindow,
  registerExitPublish,
  registerQuitPublish,
} from "../lib/sync/quit-publish";
import type { StartupSync } from "../lib/sync/startup-sync";
import type { BuiltSyncEngine } from "../lib/sync/sync-service";
import type { AppSettings } from "../domain/types";

/**
 * Wires the automatic sync triggers (`lib/sync/lifecycle.ts`) to the browser: window focus and
 * visibility, blur, the close request and the tray's Quitter action (an exit that closes no window,
 * see `quit-publish.ts`). It exists only while `automationKey` is non-null, i.e.
 * the debug gate is open, sync is enabled and the storage is the desktop one; with it `null` this
 * hook registers no listener and arms no timer (tests pin that).
 *
 * `automationKey` is the engine key of the settings, so changing the folders, the device name or the
 * profile tears the lifecycle down and builds a fresh one (which also lifts a block caused by the old
 * settings).
 */

export interface SyncAutomationOptions {
  repository: AppRepository | null;
  /** `null`: no automation. Otherwise `syncEngineKeyOf(settings)`. */
  automationKey: string | null;
  startupSync: StartupSync | null;
  now: () => number;
  /** The shared engine (built once per key, adopted from the startup pull when it matches). */
  ensureEngine: () => Promise<BuiltSyncEngine>;
  /** Hands the engine built at startup to the hook (only when its key matches). */
  adoptEngine: (startup: StartupSync) => void;
  busy: MutableRefObject<boolean>;
  runExclusive: <T>(work: () => Promise<T>) => Promise<T>;
  getSettings: () => AppSettings;
  /** A pull applied data: reload open screens and the settings copy. */
  onDataChanged: () => void;
  /** Test seam for the close handler's window; defaults to the Tauri window. */
  quitWindow?: () => Promise<QuitWindow>;
  /** Test seam for the tray-quit handshake's event bus and commands; defaults to Tauri's. */
  exitBridge?: () => Promise<ExitBridge>;
}

export interface SyncAutomation {
  lifecycle: MutableRefObject<SyncLifecycle | null>;
  state: LifecycleSnapshot | null;
}

export const useSyncAutomation = (options: SyncAutomationOptions): SyncAutomation => {
  const { repository, automationKey, busy } = options;
  const latest = useRef(options);
  latest.current = options;
  const lifecycleRef = useRef<SyncLifecycle | null>(null);
  const adoptedStartup = useRef<StartupSync | null>(null);
  const [state, setState] = useState<LifecycleSnapshot | null>(null);

  useEffect(() => {
    if (automationKey === null || repository === null) {
      setState(null);
      return;
    }
    const startup = latest.current.startupSync;
    const usable = startup !== null && startup.key === automationKey ? startup : null;
    // A pull that is still running is adopted by every lifecycle built while it runs (React may
    // build, drop and rebuild one in development); one that finished is adopted once.
    const firstAdoption =
      usable !== null && (usable.finished === null || adoptedStartup.current !== usable);
    if (usable !== null) latest.current.adoptEngine(usable);

    const lifecycle = createSyncLifecycle({
      now: () => latest.current.now(),
      runner: async (): Promise<LifecycleRunner> => {
        const built = await latest.current.ensureEngine();
        return { pull: () => built.engine.pull(), publish: () => built.engine.publish() };
      },
      pendingChanges: async () => {
        const status = await repository.getSyncStatus();
        return status.supported ? status.pendingChanges : 0;
      },
      runExclusive: (work) => latest.current.runExclusive(work),
      manualBusy: () => busy.current,
      onDataChanged: () => latest.current.onDataChanged(),
      onChange: setState,
    });
    lifecycleRef.current = lifecycle;
    if (usable !== null && firstAdoption) {
      adoptedStartup.current = usable;
      if (usable.finished !== null) {
        // Done within the wait budget: its data was in place before any screen existed.
        lifecycle.adoptPull({
          startedAtMs: usable.startedAtMs,
          announceData: false,
          result: usable.finished.ok
            ? Promise.resolve(usable.finished.report)
            : Promise.reject(usable.finished.error),
        });
      } else {
        // Still running: the chip says "Synchronisation…" and the screens reload when it applies.
        lifecycle.adoptPull({
          startedAtMs: usable.startedAtMs,
          announceData: true,
          result: usable.settled.then((outcome) =>
            outcome.ok ? outcome.report : Promise.reject(outcome.error),
          ),
        });
      }
    }

    lifecycle.start({
      lastPullStartedAtMs: usable?.startedAtMs ?? null,
      // Publishing what bootstrap and the pull left pending is step 6 of the STARTUP flow; turning
      // sync on in a running session follows the ordinary 2-minute debounce instead.
      publishNow: usable !== null,
    });

    const onFocus = () => void lifecycle.resume();
    const onBlur = () => void lifecycle.hidden();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") void lifecycle.hidden();
      else void lifecycle.resume();
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibility);

    let removed = false;
    let removeQuit: () => void = () => undefined;
    void registerQuitPublish({
      quit: (capMs) => lifecycle.quit(capMs),
      isTrayMode: () => latest.current.getSettings().runInTray,
      ...(latest.current.quitWindow ? { loadWindow: latest.current.quitWindow } : {}),
    }).then((remove) => {
      if (removed) remove();
      else removeQuit = remove;
    });
    // The tray's Quitter exits the process without closing the window: publish before it does.
    let removeExit: () => void = () => undefined;
    void registerExitPublish({
      quit: (capMs) => lifecycle.quit(capMs),
      ...(latest.current.exitBridge ? { loadBridge: latest.current.exitBridge } : {}),
    }).then((remove) => {
      if (removed) remove();
      else removeExit = remove;
    });

    return () => {
      removed = true;
      removeQuit();
      removeExit();
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
      lifecycle.stop();
      if (lifecycleRef.current === lifecycle) lifecycleRef.current = null;
      logDebug("info", "sync.lifecycle", "Declencheurs automatiques arretes");
    };
  }, [repository, automationKey, busy]);

  return { lifecycle: lifecycleRef, state };
};
