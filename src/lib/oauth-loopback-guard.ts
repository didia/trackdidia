/**
 * Shared "OAuth in progress" guard. `oauth_loopback.rs` holds exactly one global loopback
 * session (`src-tauri/src/oauth_loopback.rs`): starting a new session silently cancels any
 * pending one. Calendar sync (`src/lib/calendar/connect.ts`) drives that loopback, so a second
 * connect started while one is pending would otherwise cancel it. This in-memory flag is the
 * TypeScript-side mutex: the first flow holds the lease until it releases it (success,
 * failure or timeout), and a second is rejected up front with a clear reason rather than
 * silently losing its callback. See "Loopback collision" in `specs/done/calendar-sync.md`.
 */

export type OAuthLoopbackOwner = "calendar_sync";

export interface OAuthLoopbackLease {
  release: () => void;
}

export type AcquireOAuthLoopbackResult =
  | { ok: true; lease: OAuthLoopbackLease }
  | { ok: false; activeOwner: OAuthLoopbackOwner };

let activeOwner: OAuthLoopbackOwner | null = null;

export const acquireOAuthLoopbackLease = (
  owner: OAuthLoopbackOwner,
): AcquireOAuthLoopbackResult => {
  if (activeOwner !== null) {
    return { ok: false, activeOwner };
  }
  activeOwner = owner;
  let released = false;
  return {
    ok: true,
    lease: {
      release: () => {
        if (released) {
          return;
        }
        released = true;
        if (activeOwner === owner) {
          activeOwner = null;
        }
      },
    },
  };
};

/** Test-only visibility into, and reset of, the shared in-memory guard. */
export const __oauthLoopbackGuardForTests = {
  reset: (): void => {
    activeOwner = null;
  },
  current: (): OAuthLoopbackOwner | null => activeOwner,
};
