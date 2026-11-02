import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublishReport, PullReport, SyncIssue } from "./engine-types";
import { createSyncLifecycle, type LifecycleSnapshot, type SyncLifecycleDeps } from "./lifecycle";
import {
  SYNC_BACKOFF_BASE_MS,
  SYNC_HEARTBEAT_CHECK_MS,
  SYNC_HOURLY_PULL_MS,
  SYNC_PENDING_POLL_MS,
  SYNC_PUBLISH_DEBOUNCE_MS,
  SYNC_RESUME_PULL_DEBOUNCE_MS,
} from "./lifecycle-policy";

const totals = (applied = 0) => ({
  bundlesApplied: applied > 0 ? 1 : 0,
  applied,
  skipped: 0,
  tombstonesApplied: 0,
  conflictsLogged: 0,
  chunksApplied: 0,
  maxChunkMs: 0,
});

const pullReport = (over: Partial<PullReport> = {}): PullReport => ({
  startedAtMs: 0,
  finishedAtMs: 0,
  complete: true,
  remaining: [],
  transports: [{ id: "folder:gtd", domains: ["gtd"], reachable: true }],
  peers: [],
  issues: [],
  safetyBackup: { reasons: [], status: "not_needed" },
  totals: totals(),
  ...over,
});

const publishReport = (issues: SyncIssue[] = []): PublishReport => ({
  startedAtMs: 0,
  finishedAtMs: 0,
  pendingBefore: 1,
  domains: [],
  counterAdvanced: true,
  issues,
});

const unreachable: SyncIssue = {
  severity: "warning",
  code: "transport_unreachable",
  message: "folder gone",
};

interface Harness {
  calls: string[];
  pending: { value: number };
  manualBusy: { value: boolean };
  changed: number[];
  states: LifecycleSnapshot[];
  pullImpl: { current: () => Promise<PullReport> };
  publishImpl: { current: () => Promise<PublishReport> };
  lifecycle: ReturnType<typeof createSyncLifecycle>;
  runnerImpl: { current: () => Promise<unknown> };
}

const harness = (over: Partial<SyncLifecycleDeps> = {}): Harness => {
  const calls: string[] = [];
  const pending = { value: 0 };
  const manualBusy = { value: false };
  const changed: number[] = [];
  const states: LifecycleSnapshot[] = [];
  const pullImpl = { current: async () => pullReport() };
  const publishImpl = { current: async () => publishReport() };
  const runnerImpl: Harness["runnerImpl"] = { current: async () => undefined };
  const lifecycle = createSyncLifecycle({
    now: () => Date.now(),
    runner: async () => {
      await runnerImpl.current();
      return {
        pull: async () => {
          calls.push("pull");
          return pullImpl.current();
        },
        publish: async () => {
          calls.push("publish");
          return publishImpl.current();
        },
      };
    },
    pendingChanges: async () => pending.value,
    runExclusive: async (work) => {
      calls.push("lane");
      return work();
    },
    manualBusy: () => manualBusy.value,
    onDataChanged: () => changed.push(Date.now()),
    onChange: (state) => states.push(state),
    ...over,
  });
  return {
    calls,
    pending,
    manualBusy,
    changed,
    states,
    pullImpl,
    publishImpl,
    lifecycle,
    runnerImpl,
  };
};

const syncCalls = (h: Harness) => h.calls.filter((call) => call !== "lane");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-02T10:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a lifecycle that is not started", () => {
  it("has no timer, and no trigger does anything", async () => {
    const h = harness();
    h.pending.value = 5;
    expect(vi.getTimerCount()).toBe(0);
    await h.lifecycle.resume();
    await h.lifecycle.hidden();
    await h.lifecycle.quit();
    await h.lifecycle.tick();
    await vi.advanceTimersByTimeAsync(2 * SYNC_HOURLY_PULL_MS);
    expect(h.calls).toEqual([]);
    expect(h.states).toEqual([]);
  });

  it("start arms exactly two timers and stop clears them", () => {
    const h = harness();
    h.lifecycle.start();
    expect(vi.getTimerCount()).toBe(2);
    h.lifecycle.start();
    expect(vi.getTimerCount()).toBe(2);
    h.lifecycle.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(h.lifecycle.started).toBe(false);
  });
});

describe("publishing", () => {
  it("waits two minutes after the FIRST unpublished change, then publishes once", async () => {
    const h = harness();
    h.lifecycle.start();
    h.pending.value = 1;
    await vi.advanceTimersByTimeAsync(SYNC_PENDING_POLL_MS); // first sighting
    expect(syncCalls(h)).toEqual([]);
    h.pending.value = 4; // more edits do not push the deadline back
    await vi.advanceTimersByTimeAsync(SYNC_PUBLISH_DEBOUNCE_MS - 1_000);
    expect(syncCalls(h)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000); // 120 s after the first sighting
    expect(syncCalls(h)).toEqual(["publish"]);
    h.pending.value = 0;
    await vi.advanceTimersByTimeAsync(5 * SYNC_PENDING_POLL_MS);
    expect(syncCalls(h)).toEqual(["publish"]);
  });

  it("does not publish while nothing is pending, however long the app runs", async () => {
    const h = harness();
    h.lifecycle.start();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(syncCalls(h)).toEqual([]);
  });

  it("publishes pending changes at startup when asked, and not otherwise", async () => {
    const withStartup = harness();
    withStartup.pending.value = 2;
    withStartup.lifecycle.start({ publishNow: true });
    await vi.advanceTimersByTimeAsync(1);
    expect(syncCalls(withStartup)).toEqual(["publish"]);

    const without = harness();
    without.pending.value = 2;
    without.lifecycle.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(syncCalls(without)).toEqual([]);
  });

  it("publishes at once when the window loses focus, if something is pending", async () => {
    const h = harness();
    h.lifecycle.start();
    await h.lifecycle.hidden();
    expect(syncCalls(h)).toEqual([]);
    h.pending.value = 1;
    await h.lifecycle.hidden();
    expect(syncCalls(h)).toEqual(["publish"]);
  });

  it("a quit publishes what is pending and gives up after the cap", async () => {
    const h = harness();
    h.lifecycle.start();
    h.pending.value = 1;
    h.publishImpl.current = () => new Promise<PublishReport>(() => undefined);
    let finished = false;
    const quit = h.lifecycle.quit(3_000).then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await quit;
    expect(finished).toBe(true);
    expect(syncCalls(h)).toEqual(["publish"]);
  });

  it("a quit with nothing pending returns at once without touching the engine", async () => {
    const h = harness();
    h.lifecycle.start();
    await h.lifecycle.quit(3_000);
    expect(h.calls).toEqual([]);
  });

  it("a quit waits for the run in flight, then publishes what is still pending, all within the cap", async () => {
    const h = harness();
    h.lifecycle.start();
    h.pending.value = 1;
    let release: (report: PublishReport) => void = () => undefined;
    h.publishImpl.current = () =>
      new Promise<PublishReport>((resolve) => {
        release = resolve;
      });
    void h.lifecycle.hidden();
    await vi.advanceTimersByTimeAsync(1);
    const quit = h.lifecycle.quit(3_000);
    await vi.advanceTimersByTimeAsync(10);
    h.publishImpl.current = async () => publishReport();
    release(publishReport());
    await quit;
    // The in-flight publish, then one more for the changes made while it ran.
    expect(syncCalls(h)).toEqual(["publish", "publish"]);
  });

  it("a quit during a pull publishes after the pull, within the cap", async () => {
    const h = harness();
    h.lifecycle.start();
    h.pending.value = 2;
    let finish: (report: PullReport) => void = () => undefined;
    h.lifecycle.adoptPull({
      startedAtMs: Date.now(),
      result: new Promise<PullReport>((resolve) => {
        finish = resolve;
      }),
      announceData: false,
    });
    const quit = h.lifecycle.quit(3_000);
    await vi.advanceTimersByTimeAsync(100);
    expect(syncCalls(h)).toEqual([]);
    finish(pullReport());
    await quit;
    expect(syncCalls(h)).toEqual(["publish"]);
  });

  it("a quit gives up after the cap when the pull in flight never ends, publishing nothing", async () => {
    const h = harness();
    h.lifecycle.start();
    h.pending.value = 2;
    h.lifecycle.adoptPull({
      startedAtMs: Date.now(),
      result: new Promise<PullReport>(() => undefined),
      announceData: false,
    });
    let done = false;
    const quit = h.lifecycle.quit(3_000).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(3_000);
    await quit;
    expect(done).toBe(true);
    expect(syncCalls(h)).toEqual([]);
  });

  it("the startup publish waits for the adopted bootstrap pull instead of being dropped", async () => {
    const h = harness();
    h.pending.value = 3;
    let finish: (report: PullReport) => void = () => undefined;
    h.lifecycle.adoptPull({
      startedAtMs: Date.now() - 4_000,
      result: new Promise<PullReport>((resolve) => {
        finish = resolve;
      }),
      announceData: true,
    });
    h.lifecycle.start({ publishNow: true });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(syncCalls(h)).toEqual([]);
    finish(pullReport({ totals: totals(2) }));
    await vi.advanceTimersByTimeAsync(10);
    expect(syncCalls(h)).toEqual(["publish"]);
    expect(h.changed).toHaveLength(1);
  });
});

describe("pulling", () => {
  it("pulls on resume at most once a minute", async () => {
    const h = harness();
    h.lifecycle.start();
    await h.lifecycle.resume();
    expect(syncCalls(h)).toEqual(["pull"]);
    await vi.advanceTimersByTimeAsync(SYNC_RESUME_PULL_DEBOUNCE_MS - 1);
    await h.lifecycle.resume();
    expect(syncCalls(h)).toEqual(["pull"]);
    await vi.advanceTimersByTimeAsync(1);
    await h.lifecycle.resume();
    expect(syncCalls(h)).toEqual(["pull", "pull"]);
  });

  it("counts the startup pull toward the resume debounce", async () => {
    const h = harness();
    h.lifecycle.start({ lastPullStartedAtMs: Date.now() - 10_000 });
    await h.lifecycle.resume();
    expect(syncCalls(h)).toEqual([]);
  });

  it("pulls every hour", async () => {
    const h = harness();
    h.lifecycle.start();
    await vi.advanceTimersByTimeAsync(SYNC_HOURLY_PULL_MS);
    // The first hourly tick also carries the day's manifest heartbeat check (a publish with
    // nothing pending); the next ones, an hour later, are pulls only.
    expect(syncCalls(h)).toEqual(["pull", "publish"]);
    await vi.advanceTimersByTimeAsync(SYNC_HOURLY_PULL_MS);
    expect(syncCalls(h)).toEqual(["pull", "publish", "pull"]);
  });

  it("tells the app to reload when a pull applied something, and only then", async () => {
    const h = harness();
    h.lifecycle.start();
    await h.lifecycle.resume();
    expect(h.changed).toEqual([]);
    h.pullImpl.current = async () => pullReport({ totals: totals(3) });
    await vi.advanceTimersByTimeAsync(SYNC_RESUME_PULL_DEBOUNCE_MS);
    await h.lifecycle.resume();
    expect(h.changed).toHaveLength(1);
  });

  it("drops a trigger that finds a run in flight instead of queueing it", async () => {
    const h = harness();
    h.lifecycle.start();
    let release: (report: PullReport) => void = () => undefined;
    h.pullImpl.current = () =>
      new Promise<PullReport>((resolve) => {
        release = resolve;
      });
    const first = h.lifecycle.resume();
    await vi.advanceTimersByTimeAsync(SYNC_RESUME_PULL_DEBOUNCE_MS);
    await h.lifecycle.resume();
    expect(syncCalls(h)).toEqual(["pull"]);
    release(pullReport());
    await first;
    expect(h.lifecycle.snapshot().running).toBeNull();
  });

  it("does nothing while a manual action holds the controller", async () => {
    const h = harness();
    h.lifecycle.start();
    h.manualBusy.value = true;
    await h.lifecycle.resume();
    expect(h.calls).toEqual([]);
    h.manualBusy.value = false;
    await h.lifecycle.resume();
    expect(syncCalls(h)).toEqual(["pull"]);
  });

  it("every run goes through the exclusive lane", async () => {
    const h = harness();
    h.lifecycle.start();
    h.pending.value = 1;
    await h.lifecycle.resume();
    await h.lifecycle.hidden();
    expect(h.calls).toEqual(["lane", "pull", "lane", "publish"]);
  });
});

describe("the manifest heartbeat", () => {
  const HOUR = SYNC_HOURLY_PULL_MS;

  it("runs the publish path with nothing pending right after the startup publish step, once", async () => {
    const h = harness();
    h.lifecycle.start({ publishNow: true });
    await vi.advanceTimersByTimeAsync(1);
    expect(syncCalls(h)).toEqual(["publish"]);
    // Not again at the first hourly tick: it was just evaluated.
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(syncCalls(h)).toEqual(["publish", "pull"]);
  });

  it("a startup publish of pending changes already counts as the day's evaluation", async () => {
    const h = harness();
    h.pending.value = 2;
    h.lifecycle.start({ publishNow: true });
    await vi.advanceTimersByTimeAsync(1);
    expect(syncCalls(h)).toEqual(["publish"]);
  });

  it("without a startup step it runs at the first hourly tick, then at most once a day", async () => {
    const h = harness();
    h.lifecycle.start();
    await vi.advanceTimersByTimeAsync(HOUR - 1);
    expect(syncCalls(h)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(syncCalls(h)).toEqual(["pull", "publish"]);

    // 23 more hours of idle hourly ticks: pulls only.
    await vi.advanceTimersByTimeAsync(23 * HOUR);
    expect(syncCalls(h).filter((call) => call === "publish")).toHaveLength(1);
    // Past a day since the first evaluation: one more.
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(syncCalls(h).filter((call) => call === "publish")).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(SYNC_HEARTBEAT_CHECK_MS - 3 * HOUR);
    expect(syncCalls(h).filter((call) => call === "publish")).toHaveLength(2);
  });

  it("is not counted when it failed: the next hourly tick, past the backoff, tries again", async () => {
    const h = harness();
    h.publishImpl.current = async () => publishReport([unreachable]);
    h.lifecycle.start();
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(syncCalls(h)).toEqual(["pull", "publish"]);
    expect(h.lifecycle.snapshot().consecutiveFailures).toBe(1);
    h.publishImpl.current = async () => publishReport();
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(syncCalls(h)).toEqual(["pull", "publish", "pull", "publish"]);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(syncCalls(h)).toEqual(["pull", "publish", "pull", "publish", "pull"]);
  });

  it("waits out the backoff, the block, a manual action and an unfinished backfill", async () => {
    const h = harness();
    // The pull fails: backoff active at the heartbeat step of the same tick.
    h.pullImpl.current = async () => pullReport({ issues: [unreachable] });
    h.lifecycle.start();
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(syncCalls(h)).toEqual(["pull"]);

    const manual = harness();
    manual.manualBusy.value = true;
    manual.lifecycle.start();
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(manual.calls).toEqual([]);

    const blocked = harness();
    blocked.pullImpl.current = async () =>
      pullReport({
        issues: [{ severity: "error", code: "sync_not_ready", message: "no identity" }],
      });
    blocked.lifecycle.start();
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(syncCalls(blocked)).toEqual(["pull"]);

    const backfill = harness();
    backfill.pullImpl.current = async () =>
      pullReport({
        issues: [{ severity: "warning", code: "backfill_incomplete", message: "initializing" }],
      });
    backfill.lifecycle.start();
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(syncCalls(backfill)).toEqual(["pull"]);
  });

  it("goes through the exclusive lane and is dropped while a run is in flight", async () => {
    const h = harness();
    h.lifecycle.start({ publishNow: true });
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls).toEqual(["lane", "publish"]);

    const busy = harness();
    busy.pullImpl.current = () => new Promise<PullReport>(() => undefined);
    busy.lifecycle.start();
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(syncCalls(busy)).toEqual(["pull"]);
  });

  it("a stopped lifecycle forgets it: a new one evaluates again (restart)", async () => {
    const h = harness();
    h.lifecycle.start({ publishNow: true });
    await vi.advanceTimersByTimeAsync(1);
    h.lifecycle.stop();
    h.lifecycle.start({ publishNow: true });
    await vi.advanceTimersByTimeAsync(1);
    expect(syncCalls(h)).toEqual(["publish", "publish"]);
  });
});

describe("a failing folder", () => {
  it("backs off exponentially, skips automatic triggers meanwhile, and recovers on success", async () => {
    const h = harness();
    h.lifecycle.start();
    h.pullImpl.current = async () => pullReport({ issues: [unreachable] });
    await h.lifecycle.resume();
    expect(h.lifecycle.snapshot()).toMatchObject({
      consecutiveFailures: 1,
      lastClass: "retry",
      blocked: false,
    });
    expect(h.lifecycle.snapshot().backoffUntilMs).toBe(Date.now() + SYNC_BACKOFF_BASE_MS);

    // Inside the backoff every automatic trigger is skipped.
    h.pending.value = 3;
    await vi.advanceTimersByTimeAsync(SYNC_BACKOFF_BASE_MS - 1_000);
    await h.lifecycle.resume();
    await h.lifecycle.hidden();
    await h.lifecycle.quit();
    await h.lifecycle.tick();
    expect(syncCalls(h)).toEqual(["pull"]);

    // After it, the next attempt fails again with twice the delay.
    h.pending.value = 0;
    await vi.advanceTimersByTimeAsync(SYNC_RESUME_PULL_DEBOUNCE_MS);
    await h.lifecycle.resume();
    expect(syncCalls(h)).toEqual(["pull", "pull"]);
    expect(h.lifecycle.snapshot().consecutiveFailures).toBe(2);
    expect(h.lifecycle.snapshot().backoffUntilMs).toBe(Date.now() + 2 * SYNC_BACKOFF_BASE_MS);

    // The folder is back.
    h.pullImpl.current = async () => pullReport();
    await vi.advanceTimersByTimeAsync(2 * SYNC_BACKOFF_BASE_MS);
    await h.lifecycle.resume();
    expect(h.lifecycle.snapshot()).toMatchObject({
      consecutiveFailures: 0,
      backoffUntilMs: null,
      lastClass: "ok",
      lastError: null,
    });
    expect(h.lifecycle.snapshot().lastOkAtMs).toBe(Date.now());
  });

  it("a failing folder never throws into the caller", async () => {
    const h = harness();
    h.lifecycle.start();
    h.pullImpl.current = async () => {
      throw Object.assign(new Error("the folder exploded"), { code: "folder_unavailable" });
    };
    await expect(h.lifecycle.resume()).resolves.toBeUndefined();
    expect(h.lifecycle.snapshot()).toMatchObject({
      consecutiveFailures: 1,
      lastClass: "retry",
      lastError: { code: "folder_unavailable", message: "the folder exploded" },
    });
  });

  it("a run that cannot even build its engine is a failure too, not a crash", async () => {
    const h = harness();
    h.lifecycle.start();
    h.runnerImpl.current = async () => {
      throw Object.assign(new Error("Drive is not mounted"), { code: "folder_unavailable" });
    };
    await h.lifecycle.resume();
    expect(h.lifecycle.snapshot().lastClass).toBe("retry");
    expect(h.calls).toEqual(["lane"]);
  });

  it("Sync now always runs and resets the backoff", async () => {
    const h = harness();
    h.lifecycle.start();
    h.pullImpl.current = async () => pullReport({ issues: [unreachable] });
    await h.lifecycle.resume();
    expect(h.lifecycle.snapshot().backoffUntilMs).not.toBeNull();
    h.lifecycle.manualStarted();
    expect(h.lifecycle.snapshot()).toMatchObject({ consecutiveFailures: 0, backoffUntilMs: null });
    h.lifecycle.manualFinished("ok");
    expect(h.lifecycle.snapshot()).toMatchObject({ lastClass: "ok", lastOkAtMs: Date.now() });
    // And the automatic triggers are free again straight away.
    h.pullImpl.current = async () => pullReport();
    await vi.advanceTimersByTimeAsync(SYNC_RESUME_PULL_DEBOUNCE_MS);
    await h.lifecycle.resume();
    expect(syncCalls(h)).toEqual(["pull", "pull"]);
  });

  it("a manual failure starts a fresh backoff from the first failure", async () => {
    const h = harness();
    h.lifecycle.start();
    h.lifecycle.manualStarted();
    h.lifecycle.manualFinished("retry", { code: "transport_unreachable", message: "gone" });
    expect(h.lifecycle.snapshot()).toMatchObject({ consecutiveFailures: 1, lastClass: "retry" });
    expect(h.lifecycle.snapshot().backoffUntilMs).toBe(Date.now() + SYNC_BACKOFF_BASE_MS);
  });
});

describe("a run only the user can fix", () => {
  it("blocks the automatic triggers until a manual run or a reset", async () => {
    const h = harness();
    h.lifecycle.start();
    h.pullImpl.current = async () =>
      pullReport({ issues: [{ severity: "warning", code: "sync_not_ready", message: "no id" }] });
    await h.lifecycle.resume();
    expect(h.lifecycle.snapshot()).toMatchObject({
      blocked: true,
      lastClass: "blocked",
      consecutiveFailures: 0,
    });
    await vi.advanceTimersByTimeAsync(SYNC_HOURLY_PULL_MS * 2);
    expect(syncCalls(h)).toEqual(["pull"]);

    h.lifecycle.reset();
    expect(h.lifecycle.snapshot().blocked).toBe(false);
    h.pullImpl.current = async () => pullReport();
    await h.lifecycle.resume();
    expect(syncCalls(h)).toEqual(["pull", "pull"]);
  });

  it("a backfill in progress is reported without counting as a failure", async () => {
    const h = harness();
    h.lifecycle.start();
    h.pullImpl.current = async () =>
      pullReport({
        issues: [{ severity: "warning", code: "backfill_incomplete", message: "initializing" }],
      });
    await h.lifecycle.resume();
    expect(h.lifecycle.snapshot()).toMatchObject({
      lastClass: "backfill",
      backfillIncomplete: true,
      consecutiveFailures: 0,
      backoffUntilMs: null,
    });
  });
});

describe("the pull bootstrap started", () => {
  it("shows as running, then records its outcome, and reloads when it applied data", async () => {
    const h = harness();
    h.lifecycle.start();
    let finish: (report: PullReport) => void = () => undefined;
    const result = new Promise<PullReport>((resolve) => {
      finish = resolve;
    });
    h.lifecycle.adoptPull({ startedAtMs: Date.now() - 4_000, result, announceData: true });
    expect(h.lifecycle.snapshot().running).toBe("pull");
    // While it runs, a focus event does not start a second pull.
    await h.lifecycle.resume();
    expect(syncCalls(h)).toEqual([]);
    finish(pullReport({ totals: totals(2) }));
    await h.lifecycle.whenIdle();
    expect(h.lifecycle.snapshot()).toMatchObject({ running: null, lastClass: "ok" });
    expect(h.changed).toHaveLength(1);
  });

  it("does not announce data that was in place before any screen existed", async () => {
    const h = harness();
    h.lifecycle.start();
    h.lifecycle.adoptPull({
      startedAtMs: Date.now(),
      result: Promise.resolve(pullReport({ totals: totals(2) })),
      announceData: false,
    });
    await h.lifecycle.whenIdle();
    expect(h.changed).toEqual([]);
  });

  it("a startup pull that failed backs the triggers off without throwing", async () => {
    const h = harness();
    h.lifecycle.start();
    h.lifecycle.adoptPull({
      startedAtMs: Date.now(),
      result: Promise.reject(Object.assign(new Error("gone"), { code: "folder_unavailable" })),
      announceData: false,
    });
    await h.lifecycle.whenIdle();
    expect(h.lifecycle.snapshot()).toMatchObject({ lastClass: "retry", consecutiveFailures: 1 });
  });

  it("does not reload screens once the lifecycle was stopped", async () => {
    const h = harness();
    h.lifecycle.start();
    let finish: (report: PullReport) => void = () => undefined;
    h.lifecycle.adoptPull({
      startedAtMs: Date.now(),
      result: new Promise<PullReport>((resolve) => {
        finish = resolve;
      }),
      announceData: true,
    });
    h.lifecycle.stop();
    finish(pullReport({ totals: totals(2) }));
    await h.lifecycle.whenIdle();
    expect(h.changed).toEqual([]);
  });
});

describe("reporting", () => {
  it("emits a snapshot when a run starts and when it ends", async () => {
    const h = harness();
    h.lifecycle.start();
    h.states.length = 0;
    await h.lifecycle.resume();
    expect(h.states.map((state) => state.running)).toEqual(["pull", null]);
  });

  it("a throwing observer never breaks a run", async () => {
    const h = harness({
      onChange: () => {
        throw new Error("render exploded");
      },
    });
    h.lifecycle.start();
    await expect(h.lifecycle.resume()).resolves.toBeUndefined();
    expect(h.calls).toContain("pull");
  });
});
