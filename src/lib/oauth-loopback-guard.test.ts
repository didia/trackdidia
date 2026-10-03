import { beforeEach, describe, expect, it } from "vitest";
import { __oauthLoopbackGuardForTests, acquireOAuthLoopbackLease } from "./oauth-loopback-guard";

describe("acquireOAuthLoopbackLease", () => {
  beforeEach(() => {
    __oauthLoopbackGuardForTests.reset();
  });

  it("grants the lease when no flow is in progress", () => {
    const result = acquireOAuthLoopbackLease("calendar_sync");
    expect(result.ok).toBe(true);
    expect(__oauthLoopbackGuardForTests.current()).toBe("calendar_sync");
  });

  it("refuses a second flow while one is active, reporting the current owner", () => {
    const first = acquireOAuthLoopbackLease("email_triage");
    expect(first.ok).toBe(true);
    const second = acquireOAuthLoopbackLease("calendar_sync");
    expect(second).toEqual({ ok: false, activeOwner: "email_triage" });
  });

  it("releases the lease so a later flow can acquire it", () => {
    const first = acquireOAuthLoopbackLease("calendar_sync");
    expect(first.ok).toBe(true);
    if (first.ok) {
      first.lease.release();
    }
    expect(__oauthLoopbackGuardForTests.current()).toBeNull();
    const second = acquireOAuthLoopbackLease("email_triage");
    expect(second.ok).toBe(true);
  });

  it("release is idempotent and only clears its own owner", () => {
    const first = acquireOAuthLoopbackLease("calendar_sync");
    expect(first.ok).toBe(true);
    if (first.ok) {
      first.lease.release();
      first.lease.release();
    }
    expect(__oauthLoopbackGuardForTests.current()).toBeNull();
  });

  it("a stale lease cannot clear a newer owner's active flow", () => {
    const first = acquireOAuthLoopbackLease("calendar_sync");
    expect(first.ok).toBe(true);
    if (first.ok) {
      first.lease.release();
    }
    const second = acquireOAuthLoopbackLease("email_triage");
    expect(second.ok).toBe(true);
    if (first.ok) {
      first.lease.release();
    }
    expect(__oauthLoopbackGuardForTests.current()).toBe("email_triage");
  });
});
