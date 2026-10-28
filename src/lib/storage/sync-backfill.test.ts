// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createEmptyDailyEntry } from "../../domain/daily-entry";
// SAFETY: every repository here is backed by an isolated `:memory:` SQLite database.
import { createNodeSqliteDatabase } from "../../test/mocks/node-sqlite-database";
import { runSyncCaptureBackfill } from "../sync/backfill-driver";
import { readMeta, readMetaOf } from "../sync/capture-test-utils";
import { SyncApplyError } from "../sync/errors";
import type { SyncChangeSet } from "../sync/change-set";
import type { Database } from "./sqlite-db";
import { TauriSqliteRepository } from "./tauri-sqlite-repository";

const DEVICE = "dev:0b9c7c1e-6a3f-4b8e-9d2a-1f2e3d4c5b6a";
const SMALL = { rowsPerChunk: 20, statementsPerChunk: 10_000 };

const openDatabase = (): Database => createNodeSqliteDatabase(":memory:", { foreignKeys: true });

const openRepository = async (database: Database) => {
  const repository = new TauriSqliteRepository("sqlite::memory:", async () => database);
  await repository.initialize();
  await repository.ensureSyncIdentity({ deviceId: DEVICE, deviceName: "Portable" });
  return repository;
};

/** A database with enough rows (about 70) that 20-row chunks take several slots. */
const seeded = async () => {
  const database = openDatabase();
  const repository = await openRepository(database);
  for (let i = 0; i < 60; i += 1) {
    await repository.createTask({
      id: `task-${String(i).padStart(3, "0")}`,
      title: `Tache ${i}`,
      bucket: "inbox",
    });
  }
  await repository.saveDailyEntry(createEmptyDailyEntry("2026-04-01"));
  return { database, repository };
};

const stateRow = async (database: Database) =>
  (await database.select<Record<string, unknown>[]>("SELECT * FROM sync_backfill_state"))[0];

describe("the chunked capture backfill through the repository", () => {
  it("installs in a short first slot, runs only the first chunk and reports what is left", async () => {
    const { database, repository } = await seeded();
    const first = await repository.enableSyncCapture({ limits: SMALL });
    expect(first.installed).toBe(true);
    expect(first.backfillComplete).toBe(false);
    expect(first.remaining).toBeGreaterThan(0);
    expect(first.backfilled).toBeGreaterThan(0);
    expect(first.backfilled).toBeLessThanOrEqual(20);

    const status = await repository.getSyncStatus();
    expect(status).toMatchObject({
      supported: true,
      captureEnabled: true,
      backfillComplete: false,
    });
    if (!status.supported) throw new Error("unreachable");
    expect(status.backfillProgress).toMatchObject({ pass: 1, stamped: first.backfilled });
    expect(status.backfillProgress?.totalRows).toBeGreaterThan(60);
    expect(status.backfillProgress?.scannedRows).toBeLessThanOrEqual(20);
    expect((await stateRow(database))?.status).toBe("running");
  });

  it("finishes with continueSyncCaptureBackfill, one writer slot per chunk", async () => {
    const { repository } = await seeded();
    await repository.enableSyncCapture({ limits: SMALL });
    const outcome = await repository.continueSyncCaptureBackfill({ limits: SMALL, maxChunks: 1 });
    expect(outcome).toMatchObject({ chunks: 1, complete: false });

    const rest = await repository.continueSyncCaptureBackfill({ limits: SMALL, maxChunks: 1000 });
    expect(rest.complete).toBe(true);
    expect(rest.chunks).toBeGreaterThan(1);
    expect(rest.remaining).toBe(0);
    const status = await repository.getSyncStatus();
    expect(status).toMatchObject({ backfillComplete: true });
    // Once complete it is a no-op.
    expect(await repository.continueSyncCaptureBackfill({ limits: SMALL })).toMatchObject({
      complete: true,
      chunks: 0,
      stamped: 0,
    });
  });

  it("honours deadlineMs between chunks (never mid-chunk)", async () => {
    const { repository } = await seeded();
    await repository.enableSyncCapture({ limits: SMALL });
    const outcome = await repository.continueSyncCaptureBackfill({
      limits: { rowsPerChunk: 5, statementsPerChunk: 10_000 },
      maxChunks: 1000,
      deadlineMs: 0,
    });
    expect(outcome.chunks).toBe(1);
    expect(outcome.complete).toBe(false);
  });

  it("ends in the same state whatever the chunk size", async () => {
    const stateOf = async (limits: { rowsPerChunk: number; statementsPerChunk: number }) => {
      const { database, repository } = await seeded();
      await repository.enableSyncCapture({ limits });
      await runSyncCaptureBackfill(repository, {
        limits,
        yieldBetweenChunks: async () => undefined,
      });
      return (await readMeta(database)).map(
        (row) => `${row.entity_type}/${row.entity_id}/${row.deleted_at === null ? "live" : "gone"}`,
      );
    };
    const whole = await stateOf({ rowsPerChunk: 1_000_000, statementsPerChunk: 1_000_000 });
    expect(await stateOf({ rowsPerChunk: 7, statementsPerChunk: 1_000_000 })).toEqual(whole);
    expect(await stateOf({ rowsPerChunk: 1, statementsPerChunk: 1_000_000 })).toEqual(whole);
    expect(whole.length).toBeGreaterThan(60);
  });

  it("resumes after a restart instead of starting over, and never double-stamps", async () => {
    const { database, repository } = await seeded();
    await repository.enableSyncCapture({ limits: SMALL });
    const before = await stateRow(database);
    expect(before?.status).toBe("running");
    const metaAfterFirst = await readMeta(database);

    // The app quits: a new repository over the same database. Startup repairs triggers only.
    const restarted = new TauriSqliteRepository("sqlite::memory:", async () => database);
    await restarted.initialize();
    expect(await stateRow(database)).toEqual(before);
    expect(await readMeta(database)).toEqual(metaAfterFirst);
    const status = await restarted.getSyncStatus();
    expect(status).toMatchObject({ captureEnabled: true, backfillComplete: false });

    // Enabling again resumes the same pass (same pass number, same progress), it does not restart.
    const resumed = await restarted.enableSyncCapture({ limits: SMALL });
    expect(resumed.installed).toBe(false);
    const row = await stateRow(database);
    expect(row?.pass).toBe(1);
    expect(Number(row?.scanned_rows)).toBeGreaterThan(Number(before?.scanned_rows));

    await runSyncCaptureBackfill(restarted, {
      limits: SMALL,
      yieldBetweenChunks: async () => undefined,
    });
    const finalState = await stateRow(database);
    expect(finalState?.status).toBe("complete");
    // Every stamp was counted once: the counter equals the stamped entities of the pass.
    const identity = await database.select<{ change_counter: number }[]>(
      "SELECT change_counter FROM sync_identity",
    );
    expect(identity[0]?.change_counter).toBe(Number(finalState?.stamped));
    expect((await readMeta(database)).length).toBeGreaterThanOrEqual(61);
  });

  it("starts a new verifying pass when enabled again after a complete one", async () => {
    const { database, repository } = await seeded();
    await repository.enableSyncCapture();
    expect((await stateRow(database))?.pass).toBe(1);
    // An edit that bypassed the triggers (capture was effectively off for it) is found by the pass.
    await database.execute("UPDATE gtd_tasks SET title = 'raw' WHERE id = 'task-001'");
    const again = await repository.enableSyncCapture();
    expect(again).toMatchObject({ installed: false, backfilled: 1, backfillComplete: true });
    expect((await stateRow(database))?.pass).toBe(2);
  });

  it("keeps a database that enabled capture before the progress table complete", async () => {
    const { database, repository } = await seeded();
    await repository.enableSyncCapture();
    await database.execute("DELETE FROM sync_backfill_state");
    const restarted = new TauriSqliteRepository("sqlite::memory:", async () => database);
    await restarted.initialize();
    expect(await restarted.getSyncStatus()).toMatchObject({
      captureEnabled: true,
      backfillComplete: true,
      backfillProgress: null,
    });
    expect(await restarted.continueSyncCaptureBackfill()).toMatchObject({
      complete: true,
      chunks: 0,
    });
  });

  it("finishes even with a one-statement budget per chunk (a chunk always makes progress)", async () => {
    const { database, repository } = await seeded();
    const limits = { rowsPerChunk: 1_000, statementsPerChunk: 1 };
    await repository.enableSyncCapture({ limits });
    const outcome = await runSyncCaptureBackfill(repository, {
      limits,
      yieldBetweenChunks: async () => undefined,
    });
    expect(outcome.complete).toBe(true);
    expect((await stateRow(database))?.status).toBe("complete");
  });

  it("makes the driver give up on a cursor that does not move instead of looping forever", async () => {
    const { repository } = await seeded();
    await repository.enableSyncCapture({ limits: SMALL });
    const stuck = async () => ({
      complete: false,
      chunks: 1,
      stamped: 0,
      scanned: 0,
      maxChunkStatements: 3,
      remaining: 10,
      cursor: "rows:gtd_tasks\u0000null",
      progress: null,
    });
    await expect(
      runSyncCaptureBackfill(
        { continueSyncCaptureBackfill: stuck },
        { yieldBetweenChunks: async () => undefined },
      ),
    ).rejects.toThrow(/not making progress/);
  });

  it("rejects continuing before capture is enabled, and bad limits", async () => {
    const database = openDatabase();
    const repository = await openRepository(database);
    await expect(repository.continueSyncCaptureBackfill()).rejects.toThrow(/not enabled/);
    await expect(repository.enableSyncCapture({ limits: { rowsPerChunk: 0 } })).rejects.toThrow(
      /Invalid backfill limits/,
    );
    await repository.enableSyncCapture();
    await expect(repository.continueSyncCaptureBackfill({ maxChunks: 0 })).rejects.toThrow(
      /maxChunks/,
    );
  });
});

describe("while the backfill is incomplete", () => {
  /** A valid bundle from another laptop. */
  const peerBundle = async (): Promise<SyncChangeSet> => {
    const database = openDatabase();
    const peer = new TauriSqliteRepository("sqlite::memory:", async () => database);
    await peer.initialize();
    await peer.ensureSyncIdentity({
      deviceId: "dev:7d1e2c3b-4a5f-4e6d-8c7b-9a0b1c2d3e4f",
      deviceName: "Maison",
    });
    await peer.enableSyncCapture();
    await peer.createTask({ id: "from-peer", title: "Du pair", bucket: "inbox" });
    return peer.listSyncChanges("gtd");
  };

  it("refuses to publish and to apply with typed errors, and allows both once complete", async () => {
    const { database, repository } = await seeded();
    const incoming = await peerBundle();
    await repository.enableSyncCapture({ limits: SMALL });
    await expect(repository.listSyncChanges("gtd")).rejects.toMatchObject({
      name: "SyncApplyError",
      code: "backfill_incomplete",
    });
    const applying = repository.applySyncBundle("gtd", incoming);
    await expect(applying).rejects.toBeInstanceOf(SyncApplyError);
    await expect(applying).rejects.toMatchObject({ code: "backfill_incomplete" });
    // Nothing was merged, and the guard left no flag raised.
    expect(await database.select("SELECT id FROM gtd_tasks WHERE id = 'from-peer'")).toEqual([]);
    expect(await database.select("SELECT applying FROM sync_identity")).toEqual([{ applying: 0 }]);

    await runSyncCaptureBackfill(repository, {
      limits: SMALL,
      yieldBetweenChunks: async () => undefined,
    });
    await expect(repository.listSyncChanges("gtd")).resolves.toMatchObject({ domain: "gtd" });
    await expect(repository.applySyncBundle("gtd", incoming)).resolves.toMatchObject({
      applied: expect.any(Number),
    });
    expect(await database.select("SELECT id FROM gtd_tasks WHERE id = 'from-peer'")).toHaveLength(
      1,
    );
  });

  it("captures local edits as usual, before and behind the cursor", async () => {
    const { database, repository } = await seeded();
    await repository.enableSyncCapture({ limits: SMALL });
    await repository.createTask({ id: "created-during", title: "Pendant", bucket: "inbox" });
    for (const [id, title] of [
      ["task-000", "Modifiee pendant"],
      ["task-059", "Modifiee pendant aussi"],
    ] as const) {
      const current = (await repository.listTasks({})).find((item) => item.id === id);
      if (current === undefined) throw new Error(`missing ${id}`);
      await repository.saveTask({ ...current, title });
    }
    for (const id of ["created-during", "task-000", "task-059"]) {
      expect((await readMetaOf(database, "gtd_tasks", id))?.deleted_at).toBeNull();
    }
    const middle = await repository.getSyncStatus();
    expect(middle.supported && middle.pendingChanges).toBeGreaterThan(0);

    await runSyncCaptureBackfill(repository, {
      limits: SMALL,
      yieldBetweenChunks: async () => undefined,
    });
    const edited = await database.select<{ snapshot_json: string }[]>(
      "SELECT snapshot_json FROM sync_entity_snapshot WHERE entity_type = 'gtd_tasks' AND entity_id = 'task-059'",
    );
    expect(edited[0]?.snapshot_json).toContain("Modifiee pendant aussi");
    const marks = await database.select("SELECT * FROM sync_dirty");
    expect(marks).toEqual([]);
  });

  it("serves a write queued during the backfill before the next chunk, never later than one chunk", async () => {
    const { repository } = await seeded();
    await repository.enableSyncCapture({ limits: SMALL });
    const events: string[] = [];
    const writes: Promise<unknown>[] = [];
    let chunk = 0;
    await runSyncCaptureBackfill(repository, {
      limits: SMALL,
      // No yield at all: the FIFO queue alone must interleave.
      yieldBetweenChunks: async () => undefined,
      onProgress: () => {
        chunk += 1;
        events.push(`chunk ${chunk}`);
        const n = chunk;
        writes.push(
          repository
            .createTask({ id: `interleaved-${n}`, title: `W${n}`, bucket: "inbox" })
            .then(() => events.push(`write ${n}`)),
        );
      },
    });
    await Promise.all(writes);
    expect(chunk).toBeGreaterThan(2);
    // Each write queued after chunk n ran before chunk n+1 finished (it was ahead of it in the queue).
    for (let n = 1; n < chunk; n += 1) {
      expect(events.indexOf(`write ${n}`)).toBeGreaterThan(-1);
      expect(events.indexOf(`write ${n}`)).toBeLessThan(events.indexOf(`chunk ${n + 1}`));
    }
  });

  it("does not run a chunk at startup (8-second bootstrap rule)", async () => {
    const { database, repository } = await seeded();
    await repository.enableSyncCapture({ limits: SMALL });
    const before = await stateRow(database);
    const statements: string[] = [];
    const execute = database.execute.bind(database);
    const select = database.select.bind(database);
    database.execute = ((query: string, values?: unknown[]) => {
      statements.push(query);
      return execute(query, values);
    }) as Database["execute"];
    database.select = ((query: string, values?: unknown[]) => {
      statements.push(query);
      return select(query, values);
    }) as Database["select"];
    const restarted = new TauriSqliteRepository("sqlite::memory:", async () => database);
    await restarted.initialize();
    expect(await stateRow(database)).toEqual(before);
    expect(statements.some((query) => /INSERT OR REPLACE INTO sync_dirty/.test(query))).toBe(false);
    expect(statements.some((query) => /UPDATE sync_backfill_state/.test(query))).toBe(false);
  });
});
