/**
 * Shared "OAuth in progress" guard. `oauth_loopback.rs` holds exactly one global loopback
 * session (`src-tauri/src/oauth_loopback.rs`): starting a new session silently cancels any
 * pending one. Email triage (`src/lib/email-triage/runtime.ts`, Gmail and Microsoft) and
 * calendar sync (`src/lib/calendar/connect.ts`) both drive that loopback, so a flow started
 * by one would otherwise cancel a pending flow from the other. This in-memory flag is the
 * TypeScript-side mutex: whichever flow starts first holds the lease until it releases it
 * (success, failure or timeout), and the other is rejected up front with a clear reason
 * rather than silently losing its callback. See "Loopback collision" in
 * `specs/todo/calendar-sync.md`.
 */

export type OAuthLoopbackOwner = "email_triage" | "calendar_sync";

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
