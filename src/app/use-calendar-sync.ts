import { useEffect } from "react";
import { logDebug } from "../lib/debug";
import { reconcile } from "../lib/calendar/reconciler";
import type { AppRepository } from "../lib/storage/repository";

/** A missed mutation nudge is picked up by the next focus or backstop pass. */
const CALENDAR_SYNC_BACKSTOP_INTERVAL_MS = 15 * 60_000;
const CALENDAR_SYNC_DEBOUNCE_MS = 2_000;

let requestFn: (() => void) | null = null;

/**
 * Requests a debounced reconcile from any GTD-mutation call site. A no-op when no
 * `useCalendarSync` hook is mounted (browser preview, startup fallback, or before the
 * provider settles), so trigger sites never need to check whether sync is enabled.
 */
export const requestCalendarSync = (): void => {
  requestFn?.();
};

/**
 * Mounts only when a repository exists, this is not
 * the browser preview, and startup has settled (`allowStart`). Never mounted under the
 * startup fallback: zero API calls and zero vault access in that state. Runs one reconcile
 * on mount, a 15-minute backstop timer, a window `focus` listener, and registers the
 * debounced `requestCalendarSync` entry point used by GTD-mutation call sites.
 */
export const useCalendarSync = (
  repository: AppRepository | null,
  options: {
    browserPreview: boolean;
    allowStart: boolean;
    checkPeers?: () => Promise<string | null>;
    onBlocked?: (warning: string | null) => void;
    syncEnabled?: boolean;
  },
): void => {
  const { browserPreview, allowStart, checkPeers, onBlocked, syncEnabled } = options;

  useEffect(() => {
    if (!repository || browserPreview || !allowStart) {
      requestFn = null;
      return;
    }

    let cancelled = false;
    let debounceTimer: number | undefined;

    const runReconcile = () => {
      if (cancelled) {
        return;
      }
      void (async () => {
        const enabled = (await repository.getCalendarSyncSettings()).enabled;
        const warning = enabled && checkPeers ? await checkPeers() : null;
        if (cancelled) return;
        onBlocked?.(warning);
        if (warning) return;
        await reconcile(repository, "automatic");
      })().catch(() => {
        logDebug("error", "calendar.sync", "Echec de la reconciliation du calendrier", {
          code: "calendar_sync_reconcile_failed",
        });
      });
    };

    requestFn = () => {
      if (cancelled) {
        return;
      }
      window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(runReconcile, CALENDAR_SYNC_DEBOUNCE_MS);
    };

    runReconcile();
    const intervalId = window.setInterval(runReconcile, CALENDAR_SYNC_BACKSTOP_INTERVAL_MS);
    const onFocus = () => runReconcile();
    window.addEventListener("focus", onFocus);

    return () => {
      cancelled = true;
      window.clearTimeout(debounceTimer);
      window.clearInterval(intervalId);
      window.removeEventListener("focus", onFocus);
      if (requestFn) {
        requestFn = null;
      }
    };
  }, [repository, browserPreview, allowStart, checkPeers, onBlocked, syncEnabled]);
};
