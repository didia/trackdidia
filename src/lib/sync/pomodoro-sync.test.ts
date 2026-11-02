// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createEmptyDailyEntry } from "../../domain/daily-entry";
import type { SyncChangeSet } from "./change-set";
import { SyncApplyError } from "./errors";
import { compareHlc, encodeHlc } from "./hlc";
import { readMeta, readMetaOf, syncState } from "./capture-test-utils";
import {
  createSyncHarness,
  HARNESS_START_MS,
  jsonRoundTrip,
  readConflicts,
  type SyncDevice,
} from "./test-support/two-device-harness";

/**
 * Pomodoro through the real repository methods of simulated laptops (real SQLite, real capture
 * triggers): only terminal sessions and their segments are published, a running or paused timer
 * never leaves its laptop and is never touched by a pull.
 */

// biome-ignore lint/suspicious/noExplicitAny: fixtures edit untyped JSON change sets
type Draft = Record<string, any>;

const mutated = (changeSet: SyncChangeSet, mutate: (draft: Draft) => void): SyncChangeSet => {
  const draft = jsonRoundTrip(changeSet) as unknown as Draft;
  mutate(draft);
  return draft as unknown as SyncChangeSet;
};

const twoDevices = async () => {
  const sim = await createSyncHarness(["A", "B"]);
  return { sim, a: sim.device("A"), b: sim.device("B") };
};

const pomodoroEntities = (changeSet: SyncChangeSet) =>
  changeSet.entities.filter((entity) => entity.table.startsWith("pomodoro_"));

const sessionRow = (id: string, status: string, overrides: Record<string, unknown> = {}) => ({
  id,
  kind: "focus",
  status,
  started_at: "2026-10-01T13:00:00.000Z",
  ends_at: "2026-10-01T13:25:00.000Z",
  paused_remaining_ms: null,
  completed_at: status === "completed" ? "2026-10-01T13:25:00.000Z" : null,
  cancelled_at: status === "cancelled" ? "2026-10-01T13:10:00.000Z" : null,
  cycle_index: 1,
  date: "2026-10-01",
  ...overrides,
});

const segmentRow = (id: string, sessionId: string, overrides: Record<string, unknown> = {}) => ({
  id,
  session_id: sessionId,
  task_id: null,
  title: "Manual",
  started_at: "2026-10-01T13:00:00.000Z",
  ended_at: "2026-10-01T13:25:00.000Z",
  ...overrides,
});

const withEntities = (changeSet: SyncChangeSet, ...entities: Draft[]): SyncChangeSet =>
  mutated(changeSet, (draft) => {
    for (const entity of entities) {
      draft.entities.push({
        fieldClocks: {},
        rowHlc: draft.hlcHigh,
        deletedAt: null,
        ...entity,
      });
    }
  });

const entity = (table: string, id: string, row: Draft | null, extra: Draft = {}): Draft => ({
  table,
  entityId: id,
  row,
  ...(row === null ? {} : {}),
  ...extra,
});

const realMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const completeFocus = async (device: SyncDevice, taskId: string | null) => {
  const started = await device.repo.startPomodoro({ kind: "focus", taskId });
  const session = started.activeSession;
  if (!session) throw new Error("no session started");
  device.clock.advance(1_000);
  await device.repo.stopPomodoroSession(session.id, "completed");
  return session;
};

describe("what a laptop publishes", () => {
  it("never publishes a running or paused timer, its segments, or their sync metadata", async () => {
    const { a } = await twoDevices();
    await a.repo.createTask({ id: "t1", title: "Plan", bucket: "next_action" });
    const started = await a.repo.startPomodoro({ kind: "focus", taskId: "t1" });
    const sessionId = started.activeSession?.id as string;
    const segmentId = started.activeSession?.segments[0]?.id as string;

    // The timer and its segment are stamped locally ...
    expect((await readMeta(a.db, "pomodoro_sessions")).map((m) => m.entity_id)).toEqual([
      sessionId,
    ]);
    expect((await readMeta(a.db, "pomodoro_segments")).map((m) => m.entity_id)).toEqual([
      segmentId,
    ]);

    // ... and nothing about them is in the change set: not a row, not a clock, not an id.
    const running = await a.repo.listSyncChanges("gtd");
    expect(pomodoroEntities(running)).toEqual([]);
    expect(JSON.stringify(running)).not.toContain(sessionId);
    expect(JSON.stringify(running)).not.toContain(segmentId);

    await a.repo.pausePomodoroSession(sessionId);
    const paused = await a.repo.listSyncChanges("gtd");
    expect(pomodoroEntities(paused)).toEqual([]);
    expect(JSON.stringify(paused)).not.toContain(sessionId);
  });

  it("publishes the session and ALL its segments on the first publish after completion, though their clocks are older", async () => {
    const { a } = await twoDevices();
    await a.repo.createTask({ id: "t1", title: "Plan", bucket: "next_action" });
    const started = await a.repo.startPomodoro({ kind: "focus", taskId: "t1" });
    const sessionId = started.activeSession?.id as string;
    a.clock.advance(1_000);
    await realMs(5); // the app stamps real timestamps: a zero-length segment would be reused
    await a.repo.pausePomodoroSession(sessionId); // closes the first segment (stamped now)
    a.clock.advance(1_000);
    await realMs(5);
    await a.repo.resumePomodoroSession(sessionId); // opens a second one
    expect(pomodoroEntities(await a.repo.listSyncChanges("gtd"))).toEqual([]);

    a.clock.advance(600_000);
    await a.repo.stopPomodoroSession(sessionId, "completed");
    const done = pomodoroEntities(await a.repo.listSyncChanges("gtd"));
    const sessions = done.filter((e) => e.table === "pomodoro_sessions");
    const segments = done.filter((e) => e.table === "pomodoro_segments");
    expect(sessions.map((e) => e.entityId)).toEqual([sessionId]);
    expect(segments).toHaveLength(2);
    // The segment closed at the pause was not touched by the completion: its clock predates it.
    const oldest = [...segments].sort((x, y) => compareHlc(x.rowHlc, y.rowHlc))[0];
    expect(compareHlc(oldest?.rowHlc as string, sessions[0]?.rowHlc as string)).toBeLessThan(0);
  });

  it("publishes a cancelled session too", async () => {
    const { a } = await twoDevices();
    const started = await a.repo.startPomodoro({ kind: "focus", title: "Reading" });
    await a.repo.stopPomodoroSession(started.activeSession?.id as string, "cancelled");
    const changeSet = await a.repo.listSyncChanges("gtd");
    expect(pomodoroEntities(changeSet).map((e) => e.table)).toEqual([
      "pomodoro_sessions",
      "pomodoro_segments",
    ]);
  });

  it("does not publish tombstones of Pomodoro rows: a tombstone cannot prove its row was ever terminal", async () => {
    const { a } = await twoDevices();
    await a.repo.createTask({ id: "t1", title: "Plan", bucket: "next_action" });
    const started = await a.repo.startPomodoro({ kind: "focus", taskId: "t1" });
    const sessionId = started.activeSession?.id as string;
    a.clock.advance(1_000);
    await a.repo.pausePomodoroSession(sessionId);
    a.clock.advance(1_000);
    await a.repo.resumePomodoroSession(sessionId);
    // A segment of the still-running session is deleted (a placeholder, in the app).
    await a.db.execute(
      "DELETE FROM pomodoro_segments WHERE id = (SELECT id FROM pomodoro_segments ORDER BY started_at LIMIT 1)",
    );
    await a.stamp();
    const tombstones = await a.db.select(
      "SELECT 1 FROM sync_entity_meta WHERE entity_type = 'pomodoro_segments' AND deleted_at IS NOT NULL",
    );
    expect(tombstones).toHaveLength(1); // locally there is a tombstone ...
    a.clock.advance(1_000);
    await a.repo.stopPomodoroSession(sessionId, "completed");
    const published = pomodoroEntities(await a.repo.listSyncChanges("gtd"));
    expect(published.length).toBeGreaterThan(0);
    expect(published.every((e) => e.deletedAt === null)).toBe(true); // ... none is published
  });
});

describe("what a pull does", () => {
  it("brings the other laptop's completed sessions into the day's counts and leaves the local running timer alone", async () => {
    const { sim, a, b } = await twoDevices();
    await a.repo.createTask({ id: "t1", title: "Plan", bucket: "next_action" });
    await b.repo.createTask({ id: "t2", title: "Write", bucket: "next_action" });
    const completed = await completeFocus(a, "t1");
    const date = completed.date;

    // B starts its own timer and keeps it running while it pulls.
    const own = await b.repo.startPomodoro({ kind: "focus", taskId: "t2" });
    const ownBefore = JSON.stringify(own.activeSession);
    expect((await b.repo.computeDailyPomodoroStats(date)).completedFocusSessions).toBe(0);

    await sim.exchange(a, b, "gtd");

    const state = await b.repo.getPomodoroState();
    expect(JSON.stringify(state.activeSession)).toBe(ownBefore);
    expect(state.activeSession?.status).toBe("running");
    // A's finished focus counts toward the day on B, as a suggested metric and in the stats.
    expect((await b.repo.computeDailyPomodoroStats(date)).completedFocusSessions).toBe(1);
    await b.repo.saveDailyEntry(createEmptyDailyEntry(date));
    expect((await b.repo.getDailyEntry(date))?.suggestedMetrics?.pomodoris).toBe(1);
    expect((await b.repo.listPomodoroSessions(date)).map((s) => s.id)).toContain(completed.id);
    // B's timer was not published back either.
    const back = await b.repo.listSyncChanges("gtd");
    expect(JSON.stringify(back)).not.toContain(own.activeSession?.id as string);
    await sim.exchange(b, a, "gtd");
    expect(
      await a.db.select("SELECT 1 FROM pomodoro_sessions WHERE id = $1", [own.activeSession?.id]),
    ).toEqual([]);
  });

  it("converges both laptops once each has finished a session, with a verifying scan that restamps nothing", async () => {
    const { sim, a, b } = await twoDevices();
    await completeFocus(a, null);
    await completeFocus(b, null);
    await sim.syncAll("gtd");
    await sim.expectConverged("gtd", { snapshots: true });
    expect(await a.db.select("SELECT 1 FROM pomodoro_sessions")).toHaveLength(2);
    expect(await b.repo.enableSyncCapture()).toMatchObject({
      installed: false,
      backfilled: 0,
      backfillComplete: true,
    });
    const again = await sim.exchange(a, b, "gtd");
    expect(again).toMatchObject({ applied: 0, tombstonesApplied: 0, conflictsLogged: 0 });
  });
});

describe("refusing what an honest peer cannot send", () => {
  it.each([
    ["a running session", "running"],
    ["a paused session", "paused"],
  ])(
    "refuses a bundle carrying %s, naming the table, and applies nothing",
    async (_label, status) => {
      const { a, b } = await twoDevices();
      await b.repo.createTask({ id: "t1", title: "Would have applied", bucket: "inbox" });
      const bad = withEntities(
        await b.repo.listSyncChanges("gtd"),
        entity("pomodoro_sessions", "s-live", sessionRow("s-live", status)),
      );
      const before = await syncState(a.db);
      const failure = await a.repo.applySyncBundle("gtd", bad).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(SyncApplyError);
      expect(failure).toMatchObject({ code: "row_filter_violation", table: "pomodoro_sessions" });
      expect(await syncState(a.db)).toEqual(before);
      expect(await a.db.select("SELECT * FROM gtd_tasks")).toEqual([]);
    },
  );

  it("refuses a segment of a session the bundle carries as running", async () => {
    const { a, b } = await twoDevices();
    const bad = withEntities(
      await b.repo.listSyncChanges("gtd"),
      entity("pomodoro_sessions", "s1", sessionRow("s1", "paused")),
      entity("pomodoro_segments", "g1", segmentRow("g1", "s1")),
    );
    await expect(a.repo.applySyncBundle("gtd", bad)).rejects.toMatchObject({
      code: "row_filter_violation",
    });
  });

  it("refuses a segment whose session is neither in the bundle nor a terminal session here", async () => {
    const { a, b } = await twoDevices();
    const bad = withEntities(
      await b.repo.listSyncChanges("gtd"),
      entity("pomodoro_segments", "g1", segmentRow("g1", "nowhere")),
    );
    const before = await syncState(a.db);
    await expect(a.repo.applySyncBundle("gtd", bad)).rejects.toMatchObject({
      code: "row_filter_violation",
      table: "pomodoro_segments",
    });
    expect(await syncState(a.db)).toEqual(before);
  });

  it("applies a segment of a terminal session received earlier (the bundle need not repeat the session)", async () => {
    const { sim, a, b } = await twoDevices();
    const session = await completeFocus(b, null);
    await sim.exchange(b, a, "gtd");
    const segmentId = (await a.db.select<{ id: string }[]>("SELECT id FROM pomodoro_segments"))[0]
      ?.id;
    expect(segmentId).toBeDefined();
    const bundle = withEntities(
      await a.repo.listSyncChanges("gtd"),
      entity("pomodoro_segments", "g-late", segmentRow("g-late", session.id)),
    );
    const onlySegment = mutated(bundle, (draft) => {
      draft.entities = draft.entities.filter((e: Draft) => e.entityId === "g-late");
    });
    await a.repo.applySyncBundle("gtd", onlySegment);
    expect(await a.db.select("SELECT 1 FROM pomodoro_segments WHERE id = 'g-late'")).toHaveLength(
      1,
    );
  });

  it("aborts rather than corrupt a LOCAL running timer: same id, its segment, or a delete", async () => {
    const { a, b } = await twoDevices();
    const started = await a.repo.startPomodoro({ kind: "focus", title: "Mine" });
    const live = started.activeSession;
    const sessionId = live?.id as string;
    const segmentId = live?.segments[0]?.id as string;
    const before = await syncState(a.db);
    const stateBefore = JSON.stringify(await a.repo.getPomodoroState());
    const base = await b.repo.listSyncChanges("gtd");

    const cases: [string, SyncChangeSet][] = [
      [
        "a terminal session with the id of the running one",
        withEntities(
          base,
          entity("pomodoro_sessions", sessionId, sessionRow(sessionId, "completed")),
        ),
      ],
      [
        "a terminal session tombstone for the running one",
        withEntities(base, {
          ...entity("pomodoro_sessions", sessionId, null),
          deletedAt: base.hlcHigh,
        }),
      ],
      [
        "a segment of the running session (session unknown to the bundle)",
        withEntities(base, entity("pomodoro_segments", "g-x", segmentRow("g-x", sessionId))),
      ],
      [
        "a delete of the running session's own segment",
        withEntities(base, {
          ...entity("pomodoro_segments", segmentId, null),
          deletedAt: base.hlcHigh,
        }),
      ],
    ];
    for (const [label, bundle] of cases) {
      const failure = await a.repo.applySyncBundle("gtd", bundle).catch((error: unknown) => error);
      expect(failure, label).toBeInstanceOf(SyncApplyError);
      expect(failure, label).toMatchObject({ code: "local_timer_conflict" });
      expect(await syncState(a.db), label).toEqual(before);
      expect(JSON.stringify(await a.repo.getPomodoroState()), label).toBe(stateBefore);
    }
  });
});

describe("two versions of one terminal session or segment", () => {
  const diverged = async () => {
    const { sim, a, b } = await twoDevices();
    const session = await completeFocus(a, null);
    await sim.syncAll("gtd");
    return { sim, a, b, session };
  };

  it("keeps the later write of a session on both laptops, logs the overwritten one, and converges", async () => {
    const { sim, a, b, session } = await diverged();
    a.clock.advance(1_000);
    await a.db.execute("UPDATE pomodoro_sessions SET cycle_index = 3");
    await a.stamp();
    b.clock.advance(60_000);
    await b.db.execute("UPDATE pomodoro_sessions SET cycle_index = 4");
    await b.stamp();
    await sim.syncAll("gtd");
    for (const device of [a, b]) {
      expect(
        (
          await device.db.select<{ cycle_index: number }[]>(
            "SELECT cycle_index FROM pomodoro_sessions WHERE id = $1",
            [session.id],
          )
        )[0]?.cycle_index,
      ).toBe(4);
    }
    await sim.expectConverged("gtd", { snapshots: true });
    const logged = (await readConflicts(a)).filter((row) => row.kind === "overwritten_edit");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ entity_type: "pomodoro_sessions", entity_id: session.id });
  });

  it("edit wins over delete when the edit is later; a delete is not published, so the later delete stays local", async () => {
    const { sim, a, b, session } = await diverged();
    // A deletes the session; B edits it later. A's tombstone is not published, B's edit is.
    a.clock.advance(1_000);
    await a.db.execute("DELETE FROM pomodoro_sessions");
    await a.stamp();
    b.clock.advance(60_000);
    await b.db.execute("UPDATE pomodoro_sessions SET cycle_index = 2");
    await b.stamp();
    await sim.syncAll("gtd");
    expect(
      await a.db.select("SELECT 1 FROM pomodoro_sessions WHERE id = $1", [session.id]),
    ).toHaveLength(1);
    await sim.expectConverged("gtd", { snapshots: true });

    // The other way round: A's delete is the later write. B's edit is older than the tombstone, so A
    // keeps it deleted; B never hears of the delete (documented known limit).
    a.clock.advance(120_000);
    await a.db.execute("DELETE FROM pomodoro_sessions");
    await a.stamp();
    await sim.syncAll("gtd"); // B's bundle still carries the session and its segment: no abort
    expect(await a.db.select("SELECT 1 FROM pomodoro_sessions")).toEqual([]);
    expect(await b.db.select("SELECT 1 FROM pomodoro_sessions")).toHaveLength(1);
    // The segment B sends for the session A deleted is skipped, with an informational conflict.
    const skipped = (await readConflicts(a)).filter((row) => row.kind === "orphaned_child");
    expect(skipped.length).toBeGreaterThan(0);
  });

  it("applies a hand-built tombstone: a later delete removes the session, an earlier one changes nothing", async () => {
    const { a, b, session } = await diverged();
    const base = await b.repo.listSyncChanges("gtd");
    const tombstone = (offsetMs: number) => {
      const clock = encodeHlc(HARNESS_START_MS + offsetMs, 0, b.deviceId);
      return mutated(base, (draft) => {
        draft.hlcHigh = clock;
        draft.entities = [
          {
            table: "pomodoro_sessions",
            entityId: session.id,
            row: null,
            fieldClocks: {},
            rowHlc: clock,
            deletedAt: clock,
          },
        ];
      });
    };
    const storedClock = (await readMetaOf(a.db, "pomodoro_sessions", session.id))
      ?.row_hlc as string;
    // Earlier than the stored version: the session stays.
    await a.repo.applySyncBundle("gtd", tombstone(0));
    expect(
      await a.db.select("SELECT 1 FROM pomodoro_sessions WHERE id = $1", [session.id]),
    ).toHaveLength(1);
    expect((await readMetaOf(a.db, "pomodoro_sessions", session.id))?.row_hlc).toBe(storedClock);
    // Later: it goes, and the meta becomes a tombstone with no snapshot left behind.
    const result = await a.repo.applySyncBundle("gtd", tombstone(10_000_000));
    expect(result.tombstonesApplied).toBe(1);
    expect(
      await a.db.select("SELECT 1 FROM pomodoro_sessions WHERE id = $1", [session.id]),
    ).toEqual([]);
    const meta = await readMetaOf(a.db, "pomodoro_sessions", session.id);
    expect(meta?.deleted_at).not.toBeNull();
    expect(
      await a.db.select(
        "SELECT 1 FROM sync_entity_snapshot WHERE entity_type = 'pomodoro_sessions'",
      ),
    ).toEqual([]);
    expect(await a.repo.enableSyncCapture()).toMatchObject({
      installed: false,
      backfilled: 0,
      backfillComplete: true,
    });
  });

  it("joins a segment's ended_at: non-null beats null and the later of two ends wins, in either order", async () => {
    const { a, b, session } = await diverged();
    const segmentId = (await a.db.select<{ id: string }[]>("SELECT id FROM pomodoro_segments"))[0]
      ?.id as string;
    const base = await b.repo.listSyncChanges("gtd");
    const clock = (offsetMs: number) => encodeHlc(HARNESS_START_MS + offsetMs, 0, b.deviceId);
    const version = (endedAt: string | null, rowHlc: string, title: string) =>
      mutated(base, (draft) => {
        draft.hlcHigh = rowHlc;
        draft.entities = [
          {
            table: "pomodoro_segments",
            entityId: segmentId,
            row: segmentRow(segmentId, session.id, { ended_at: endedAt, title }),
            fieldClocks: {},
            rowHlc,
            deletedAt: null,
          },
        ];
      });
    const stored = async () =>
      (
        await a.db.select<{ ended_at: string | null; title: string }[]>(
          "SELECT ended_at, title FROM pomodoro_segments WHERE id = $1",
          [segmentId],
        )
      )[0];

    const closedAt = (await stored())?.ended_at as string;
    expect(closedAt).toEqual(expect.any(String));
    // A newer version that says "still open" does not reopen the closed segment, but its other
    // columns (the newer clock) win.
    await a.repo.applySyncBundle("gtd", version(null, clock(120_000), "newer-open"));
    expect(await stored()).toMatchObject({ title: "newer-open", ended_at: closedAt });
    // Two different ends: the later timestamp, whichever version is newer.
    await a.repo.applySyncBundle(
      "gtd",
      version("2999-01-01T00:00:00.000Z", clock(60_000), "older-later-end"),
    );
    expect(await stored()).toMatchObject({
      title: "newer-open",
      ended_at: "2999-01-01T00:00:00.000Z",
    });
    await a.repo.applySyncBundle(
      "gtd",
      version("2998-01-01T00:00:00.000Z", clock(240_000), "newest-earlier-end"),
    );
    expect(await stored()).toMatchObject({
      title: "newest-earlier-end",
      ended_at: "2999-01-01T00:00:00.000Z",
    });
    expect(await a.repo.enableSyncCapture()).toMatchObject({
      installed: false,
      backfilled: 0,
      backfillComplete: true,
    });
  });
});
