import { describe, expect, it } from "vitest";
import type { PublishReport, PullReport, SyncIssue } from "./engine-types";
import {
  backoffDelayMs,
  classifyIssues,
  classifyPublish,
  classifyPull,
  classifyThrown,
  deriveSyncChip,
  isBackoffActive,
  nextFirstPendingAt,
  pullChangedData,
  SYNC_BACKOFF_BASE_MS,
  SYNC_BACKOFF_CAP_MS,
  SYNC_HEARTBEAT_CHECK_MS,
  SYNC_PUBLISH_DEBOUNCE_MS,
  SYNC_RESUME_PULL_DEBOUNCE_MS,
  shouldHeartbeat,
  shouldPublish,
  shouldPull,
  worstClass,
} from "./lifecycle-policy";

const issue = (code: SyncIssue["code"], severity: SyncIssue["severity"]): SyncIssue => ({
  code,
  severity,
  message: code,
});

const pull = (over: Partial<PullReport> = {}): PullReport => ({
  startedAtMs: 0,
  finishedAtMs: 0,
  complete: true,
  remaining: [],
  transports: [{ id: "folder:gtd", domains: ["gtd"], reachable: true }],
  peers: [],
  issues: [],
  safetyBackup: { reasons: [], status: "not_needed" },
  totals: {
    bundlesApplied: 0,
    applied: 0,
    skipped: 0,
    tombstonesApplied: 0,
    conflictsLogged: 0,
    chunksApplied: 0,
    maxChunkMs: 0,
  },
  ...over,
});

const publish = (issues: SyncIssue[] = []): PublishReport => ({
  startedAtMs: 0,
  finishedAtMs: 0,
  pendingBefore: 0,
  domains: [],
  counterAdvanced: false,
  issues,
});

describe("backoff", () => {
  it("doubles from 30 s and stops at 15 minutes", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(backoffDelayMs)).toEqual([
      30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000, 900_000,
    ]);
    expect(backoffDelayMs(1)).toBe(SYNC_BACKOFF_BASE_MS);
    expect(backoffDelayMs(10_000)).toBe(SYNC_BACKOFF_CAP_MS);
  });

  it("treats fewer than one failure as the first and never overflows", () => {
    expect(backoffDelayMs(0)).toBe(SYNC_BACKOFF_BASE_MS);
    expect(backoffDelayMs(-4)).toBe(SYNC_BACKOFF_BASE_MS);
    expect(backoffDelayMs(Number.MAX_SAFE_INTEGER)).toBe(SYNC_BACKOFF_CAP_MS);
  });

  it("is active strictly before the deadline", () => {
    expect(isBackoffActive(null, 5)).toBe(false);
    expect(isBackoffActive(100, 99)).toBe(true);
    expect(isBackoffActive(100, 100)).toBe(false);
  });
});

describe("shouldPull", () => {
  const base = { nowMs: 1_000_000, lastPullStartedAtMs: null, backoffUntilMs: null };

  it("pulls on the first resume of a session, then at most once a minute", () => {
    expect(shouldPull({ ...base, trigger: "resume" })).toBe(true);
    const last = base.nowMs - (SYNC_RESUME_PULL_DEBOUNCE_MS - 1);
    expect(shouldPull({ ...base, trigger: "resume", lastPullStartedAtMs: last })).toBe(false);
    expect(
      shouldPull({
        ...base,
        trigger: "resume",
        lastPullStartedAtMs: base.nowMs - SYNC_RESUME_PULL_DEBOUNCE_MS,
      }),
    ).toBe(true);
  });

  it("the hourly pull is not debounced but respects the backoff", () => {
    expect(shouldPull({ ...base, trigger: "hourly", lastPullStartedAtMs: base.nowMs - 1 })).toBe(
      true,
    );
    expect(shouldPull({ ...base, trigger: "hourly", backoffUntilMs: base.nowMs + 1 })).toBe(false);
  });

  it("a manual pull ignores both the debounce and the backoff", () => {
    expect(
      shouldPull({
        trigger: "manual",
        nowMs: 5,
        lastPullStartedAtMs: 4,
        backoffUntilMs: 9_999,
      }),
    ).toBe(true);
  });
});

describe("shouldPublish", () => {
  const base = {
    nowMs: 1_000_000,
    pendingChanges: 3,
    firstPendingAtMs: null,
    backoffUntilMs: null,
  };

  it("never publishes with nothing pending, whatever the trigger (manual excepted)", () => {
    for (const trigger of ["startup", "debounce", "blur", "quit"] as const) {
      expect(shouldPublish({ ...base, trigger, pendingChanges: 0 })).toBe(false);
    }
    expect(shouldPublish({ ...base, trigger: "manual", pendingChanges: 0 })).toBe(true);
  });

  it("the heartbeat is decided by shouldHeartbeat, never here, pending changes or not", () => {
    expect(shouldPublish({ ...base, trigger: "heartbeat", pendingChanges: 0 })).toBe(false);
    expect(shouldPublish({ ...base, trigger: "heartbeat" })).toBe(false);
  });

  it("debounces: 2 minutes after the FIRST unpublished change", () => {
    const first = base.nowMs - (SYNC_PUBLISH_DEBOUNCE_MS - 1);
    expect(shouldPublish({ ...base, trigger: "debounce", firstPendingAtMs: first })).toBe(false);
    expect(
      shouldPublish({
        ...base,
        trigger: "debounce",
        firstPendingAtMs: base.nowMs - SYNC_PUBLISH_DEBOUNCE_MS,
      }),
    ).toBe(true);
    expect(shouldPublish({ ...base, trigger: "debounce", firstPendingAtMs: null })).toBe(false);
  });

  it("startup, blur and quit publish at once; the backoff holds all but manual", () => {
    for (const trigger of ["startup", "blur", "quit"] as const) {
      expect(shouldPublish({ ...base, trigger })).toBe(true);
      expect(shouldPublish({ ...base, trigger, backoffUntilMs: base.nowMs + 5 })).toBe(false);
    }
    expect(shouldPublish({ ...base, trigger: "manual", backoffUntilMs: base.nowMs + 5 })).toBe(
      true,
    );
  });
});

describe("shouldHeartbeat", () => {
  const input = {
    nowMs: 10 * SYNC_HEARTBEAT_CHECK_MS,
    lastHeartbeatAtMs: null,
    backoffUntilMs: null,
  };

  it("is due at the first look of a session, whatever the process uptime, with nothing pending", () => {
    expect(shouldHeartbeat(input)).toBe(true);
  });

  it("is then due at most once per day", () => {
    const last = input.nowMs;
    expect(shouldHeartbeat({ ...input, lastHeartbeatAtMs: last, nowMs: last + 1 })).toBe(false);
    expect(
      shouldHeartbeat({
        ...input,
        lastHeartbeatAtMs: last,
        nowMs: last + SYNC_HEARTBEAT_CHECK_MS - 1,
      }),
    ).toBe(false);
    expect(
      shouldHeartbeat({ ...input, lastHeartbeatAtMs: last, nowMs: last + SYNC_HEARTBEAT_CHECK_MS }),
    ).toBe(true);
  });

  it("the backoff holds it back", () => {
    expect(shouldHeartbeat({ ...input, backoffUntilMs: input.nowMs + 1 })).toBe(false);
    expect(shouldHeartbeat({ ...input, backoffUntilMs: input.nowMs })).toBe(true);
  });
});

describe("nextFirstPendingAt", () => {
  it("is null while nothing is pending, keeps the first sighting, and restarts after a clean state", () => {
    expect(nextFirstPendingAt(null, 0, 10)).toBeNull();
    expect(nextFirstPendingAt(5, 0, 10)).toBeNull();
    expect(nextFirstPendingAt(null, 2, 10)).toBe(10);
    expect(nextFirstPendingAt(10, 7, 99)).toBe(10);
  });
});

describe("classifying runs", () => {
  it("a clean report is ok; info and ordinary warnings are not failures", () => {
    expect(classifyPull(pull())).toBe("ok");
    expect(
      classifyIssues([issue("clock_skew", "warning"), issue("bundle_not_ready", "info")]),
    ).toBe("ok");
    expect(classifyPublish(publish([issue("pending_unpublished_domain", "info")]))).toBe("ok");
  });

  it("an unreachable folder, a timeout, or any error is worth a retry with backoff", () => {
    expect(classifyIssues([issue("transport_unreachable", "warning")])).toBe("retry");
    expect(classifyIssues([issue("transport_timeout", "warning")])).toBe("retry");
    expect(classifyIssues([issue("bundle_invalid", "error")])).toBe("retry");
    expect(classifyIssues([issue("bundle_partially_merged", "error")])).toBe("retry");
    expect(
      classifyPull(
        pull({ transports: [{ id: "folder:gtd", domains: ["gtd"], reachable: false }] }),
      ),
    ).toBe("retry");
  });

  it("what only the user can fix blocks; an unfinished backfill is neither", () => {
    expect(classifyIssues([issue("sync_not_ready", "warning")])).toBe("blocked");
    expect(classifyIssues([issue("safety_backup_required", "error")])).toBe("blocked");
    expect(classifyIssues([issue("backfill_incomplete", "warning")])).toBe("backfill");
    // Blocked outranks a retryable failure in the same report.
    expect(
      classifyIssues([
        issue("transport_unreachable", "warning"),
        issue("sync_not_ready", "warning"),
      ]),
    ).toBe("blocked");
  });

  it("classifies a thrown setup error by its code", () => {
    expect(classifyThrown("no_backup_destination")).toBe("blocked");
    expect(classifyThrown("folder_rejected")).toBe("blocked");
    expect(classifyThrown("unsupported_profile")).toBe("blocked");
    expect(classifyThrown("folder_unavailable")).toBe("retry");
    expect(classifyThrown("unexpected")).toBe("retry");
  });

  it("orders classes for a pull-then-publish", () => {
    expect(worstClass("ok", "retry")).toBe("retry");
    expect(worstClass("retry", "backfill")).toBe("retry");
    expect(worstClass("blocked", "retry")).toBe("blocked");
    expect(worstClass("ok", "ok")).toBe("ok");
  });

  it("knows whether a pull changed the data", () => {
    expect(pullChangedData(pull())).toBe(false);
    expect(pullChangedData(pull({ totals: { ...pull().totals, applied: 1 } }))).toBe(true);
    expect(pullChangedData(pull({ totals: { ...pull().totals, tombstonesApplied: 2 } }))).toBe(
      true,
    );
    expect(pullChangedData(pull({ totals: { ...pull().totals, skipped: 9 } }))).toBe(false);
  });
});

describe("deriveSyncChip", () => {
  const idle = {
    running: false,
    lastClass: null,
    failures: 0,
    backoffUntilMs: null,
    lastOkAtMs: null,
    backfillIncomplete: false,
  } as const;

  it("is idle by default and carries the last success time", () => {
    expect(deriveSyncChip(idle)).toEqual({ state: "idle", lastOkAtMs: null, retryAtMs: null });
    expect(deriveSyncChip({ ...idle, lastClass: "ok", lastOkAtMs: 77 })).toEqual({
      state: "idle",
      lastOkAtMs: 77,
      retryAtMs: null,
    });
  });

  it("syncing wins over everything", () => {
    expect(
      deriveSyncChip({ ...idle, running: true, lastClass: "blocked", backfillIncomplete: true })
        .state,
    ).toBe("syncing");
  });

  it("error carries the retry time; paused and backfill have their own states", () => {
    expect(
      deriveSyncChip({ ...idle, lastClass: "retry", failures: 2, backoffUntilMs: 900 }),
    ).toEqual({
      state: "error",
      lastOkAtMs: null,
      retryAtMs: 900,
    });
    expect(deriveSyncChip({ ...idle, lastClass: "blocked" }).state).toBe("paused");
    expect(deriveSyncChip({ ...idle, lastClass: "backfill" }).state).toBe("backfill");
    expect(deriveSyncChip({ ...idle, backfillIncomplete: true }).state).toBe("backfill");
    expect(deriveSyncChip({ ...idle, failures: 1 }).state).toBe("error");
  });
});
