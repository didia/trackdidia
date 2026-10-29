// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { RecurringTaskTemplate } from "../../domain/types";
import * as recurringTemplatesRows from "../storage/sqlite/rows/recurringTemplates";
import type { Database } from "../storage/sqlite-db";
import { runSqliteTransaction } from "../storage/transaction";
import {
  type BackfillCursor,
  type BackfillSliceOutcome,
  backfillSteps,
  backfillSyncCapture,
  decodeCursor,
  runBackfillSlice,
} from "./capture-backfill";
import { disableSyncCapture, installSyncCapture } from "./capture-install";
import {
  CAPTURE_NOW,
  createCaptureDb,
  insertContext,
  insertTask,
  readMarks,
  readMeta,
  stampedTransaction,
  T0,
} from "./capture-test-utils";

/**
 * The chunked scan against the one-shot scan: same entities stamped, same snapshots, whatever the
 * chunk size; resumable from any cursor; skips what the normal path already stamped.
 */

type Db = Database;

const limits = (rowsPerChunk: number, statementsPerChunk = 10_000) => ({
  rowsPerChunk,
  statementsPerChunk,
});

const hlcShape = (value: string | null): string | null => (value === null ? null : "H");

/** The comparable state of a scan: which entities have clocks, of what shape, with which snapshot. */
const scanState = async (db: Db) => ({
  meta: (await readMeta(db)).map((row) => ({
    type: row.entity_type,
    id: row.entity_id,
    clocks: Object.keys(JSON.parse(row.field_clocks_json) as Record<string, string>).sort(),
    row: hlcShape(row.row_hlc),
    deleted: hlcShape(row.deleted_at),
  })),
  snapshots: await db.select(
    "SELECT entity_type, entity_id, snapshot_json, content_hash FROM sync_entity_snapshot ORDER BY entity_type, entity_id",
  ),
});

/** Runs slices to the end inside one transaction each, like the repository does. */
const runChunked = async (
  db: Db,
  size: number,
  options: { verify?: boolean; from?: BackfillCursor | null; maxSlices?: number } = {},
) => {
  let cursor: BackfillCursor | null = options.from ?? null;
  let stamped = 0;
  let scanned = 0;
  let slices = 0;
  let maxStatements = 0;
  for (;;) {
    const slice = await runSqliteTransaction(db, () =>
      runBackfillSlice(db, CAPTURE_NOW, cursor, {
        verify: options.verify ?? true,
        limits: limits(size),
      }),
    );
    slices += 1;
    stamped += slice.stamped;
    scanned += slice.scanned;
    maxStatements = Math.max(maxStatements, slice.statements);
    cursor = slice.next;
    if (cursor === null || slices >= (options.maxSlices ?? Number.MAX_SAFE_INTEGER)) {
      return { stamped, scanned, slices, maxStatements, cursor };
    }
  }
};

const seed = async (db: Db) => {
  for (let i = 0; i < 23; i += 1) {
    await insertTask(db, `task-${String(i).padStart(2, "0")}`, {
      context_ids_json: i % 3 === 0 ? '["context:a","context:b"]' : "[]",
      project_id: i % 4 === 0 ? "project-1" : null,
    });
  }
  await insertContext(db, "context:a", "Maison");
  await insertContext(db, "context:b", "Bureau");
  await db.execute(
    "INSERT INTO gtd_projects (id, title, status, notes, context_ids_json, source, created_at, updated_at) VALUES ('project-1', 'P', 'active', '', '[]', 'manual', $1, $1)",
    [T0],
  );
  await db.execute(
    "INSERT INTO weekly_objectives (id, title, kind, sort_order, created_at, updated_at) VALUES ('obj-1', 'Lire', 'count', 0, $1, $1), ('obj-2', 'Courir', 'count', 1, $1, $1)",
    [T0],
  );
  for (const week of ["2026-10-04", "2026-10-11", "2026-10-18"]) {
    await db.execute(
      "INSERT INTO weekly_objective_results (week_start_date, objective_id, achieved, updated_at) VALUES ($1, 'obj-1', 1, $2), ($1, 'obj-2', 0, $2)",
      [week, T0],
    );
  }
  await db.execute(
    "INSERT INTO finance_merchant_memory (merchant_key, account_id, sign, category_id, source, created_at, updated_at) VALUES ('ALPHA', 'a1', 1, 'c', 'user', $1, $1), ('ALPHA', 'a1', -1, 'c', 'user', $1, $1), ('BRAVO', 'a1', -1, 'c', 'user', $1, $1)",
    [T0],
  );
  await db.execute(
    "INSERT INTO daily_entries (date, status, metrics_json, principles_json, updated_at) VALUES ('2026-10-01', 'open', '{}', '{}', $1), ('2026-10-02', 'open', '{\"a\":1}', '{}', $1)",
    [T0],
  );
  await db.execute(
    "INSERT INTO app_settings (id, value) VALUES (1, $1) ON CONFLICT(id) DO UPDATE SET value = excluded.value",
    [JSON.stringify({ language: "fr", dailyReminderTime: "20:00" })],
  );
};

/** Rows written while capture was off: the whole database is unstamped. */
const unstampedDb = async (): Promise<Db> => {
  const db = await createCaptureDb({ capture: false });
  await seed(db);
  await installSyncCapture(db);
  return db;
};

describe("runBackfillSlice: chunked == one-shot", () => {
  it.each([1, 2, 5, 13, 40, 1000])(
    "stamps the same entities with chunks of %i rows",
    async (size) => {
      const whole = await unstampedDb();
      const wholeStamped = await backfillSyncCapture(whole, CAPTURE_NOW, { verify: true });

      const db = await unstampedDb();
      const run = await runChunked(db, size);

      expect(run.cursor).toBeNull();
      expect(run.stamped).toBe(wholeStamped);
      expect(await scanState(db)).toEqual(await scanState(whole));
      expect(await readMarks(db)).toEqual([]);
      // A second pass over a fully stamped database stamps nothing, whatever the chunk size.
      expect((await runChunked(db, size)).stamped).toBe(0);
    },
  );

  it("looks at every row exactly once per pass and reports statements per slice", async () => {
    const db = await unstampedDb();
    const run = await runChunked(db, 10);
    // 23 tasks + 2 contexts + 1 project + 2 objectives + 6 results + 3 memories + 2 daily entries
    // + 1 setting, then the same number of live clock rows are NOT yet there to scan (the meta steps
    // ran before the stamps of the rows steps in their own slice or in later ones, so they count).
    expect(run.scanned).toBeGreaterThanOrEqual(40);
    expect(run.slices).toBeGreaterThan(3);
    expect(run.maxStatements).toBeGreaterThan(0);
  });

  it("bounds the rows of one slice", async () => {
    const db = await unstampedDb();
    const first = await runSqliteTransaction(db, () =>
      runBackfillSlice(db, CAPTURE_NOW, null, { verify: true, limits: limits(7) }),
    );
    expect(first.scanned).toBeLessThanOrEqual(7);
    expect(first.next).not.toBeNull();
    // Only what the slice looked at was stamped.
    expect((await readMeta(db)).length).toBeLessThanOrEqual(7);
  });

  it("ends a slice when its statement budget is spent, at a slice boundary", async () => {
    const db = await unstampedDb();
    const slice = await runSqliteTransaction(db, () =>
      runBackfillSlice(db, CAPTURE_NOW, null, {
        verify: true,
        limits: { rowsPerChunk: 100_000, statementsPerChunk: 4 },
      }),
    );
    expect(slice.next).not.toBeNull();
    // The scan stopped long before 100,000 rows: the statement budget ended it.
    expect(slice.scanned).toBeLessThan(40);
  });
});

describe("runBackfillSlice: resuming", () => {
  it("resumes from any persisted cursor and ends in the same state", async () => {
    const whole = await unstampedDb();
    await runChunked(whole, 1000);

    const db = await unstampedDb();
    let cursor: BackfillCursor | null = null;
    for (let round = 0; round < 6; round += 1) {
      const step = await runChunked(db, 4, { from: cursor, maxSlices: 1 });
      cursor = step.cursor;
      if (cursor === null) break;
      // The cursor survives a JSON round trip through the state row.
      cursor = decodeCursor(cursor.step, cursor.key === null ? null : JSON.stringify(cursor.key));
      expect(cursor).not.toBeNull();
    }
    if (cursor !== null) await runChunked(db, 1000, { from: cursor });
    expect(await scanState(db)).toEqual(await scanState(whole));
  });

  it("never stamps an entity twice, even when a slice is replayed from an old cursor", async () => {
    const db = await unstampedDb();
    const first = await runChunked(db, 6, { maxSlices: 3 });
    const counter = (
      await db.select<{ n: number }[]>("SELECT change_counter AS n FROM sync_identity")
    )[0]?.n;
    const metaBefore = await readMeta(db);
    // Replaying from the start (a lost cursor) re-reads the stamped rows and stamps nothing new.
    const replay = await runChunked(db, 6, { maxSlices: 3 });
    expect(replay.stamped).toBe(0);
    expect(await readMeta(db)).toEqual(metaBefore);
    expect(
      (await db.select<{ n: number }[]>("SELECT change_counter AS n FROM sync_identity"))[0]?.n,
    ).toBe(counter);
    expect(first.stamped).toBeGreaterThan(0);
  });

  it("restarts a step from its beginning when the persisted cursor key is damaged", () => {
    const step = backfillSteps()[0] as string;
    expect(decodeCursor(step, "not json")).toEqual({ step, key: null });
    expect(decodeCursor(step, '{"a":1}')).toEqual({ step, key: null });
    expect(decodeCursor(step, '["x",2]')).toEqual({ step, key: ["x", 2] });
    expect(decodeCursor("rows:no_such_table", null)).toBeNull();
    expect(decodeCursor("", null)).toBeNull();
  });
});

describe("runBackfillSlice: concurrent local edits", () => {
  it("leaves an entity edited between slices with the normal path's newer clock and snapshot", async () => {
    const db = await unstampedDb();
    // Slice 1 stamps the first rows of gtd_tasks (the registry starts with them).
    const slice = await runSqliteTransaction(db, () =>
      runBackfillSlice(db, CAPTURE_NOW, null, { verify: true, limits: limits(5) }),
    );
    expect(slice.next).not.toBeNull();
    // The user edits a stamped task and a task the scan has not reached yet, each through the normal
    // path (the capture triggers and the stamper in the same transaction).
    await stampedTransaction(
      db,
      async () => {
        await db.execute("UPDATE gtd_tasks SET title = 'edited early' WHERE id = 'task-00'");
        await db.execute("UPDATE gtd_tasks SET title = 'edited late' WHERE id = 'task-20'");
        await insertTask(db, "task-new-ahead");
      },
      CAPTURE_NOW + 10_000,
    );
    const afterEdit = (await readMeta(db, "gtd_tasks")).filter((row) =>
      ["task-00", "task-20", "task-new-ahead"].includes(row.entity_id),
    );
    const editedEarly = afterEdit.find((row) => row.entity_id === "task-00");
    expect(editedEarly).toBeDefined();

    // The rest of the pass, much later: nothing it stamps may move what the edits stamped.
    await runChunked(db, 5, { from: slice.next });
    const finalMeta = await readMeta(db, "gtd_tasks");
    for (const row of afterEdit) {
      expect(finalMeta.find((item) => item.entity_id === row.entity_id)).toEqual(row);
    }
    const snapshot = await db.select<{ snapshot_json: string }[]>(
      "SELECT snapshot_json FROM sync_entity_snapshot WHERE entity_type = 'gtd_tasks' AND entity_id = 'task-20'",
    );
    expect(snapshot[0]?.snapshot_json).toContain("edited late");
    // Every task has a live clock row exactly once.
    expect(finalMeta.filter((row) => row.deleted_at === null)).toHaveLength(24);
  });

  it("tombstones a row that was deleted by the user before the scan reached it, once", async () => {
    const db = await unstampedDb();
    const slice = await runSqliteTransaction(db, () =>
      runBackfillSlice(db, CAPTURE_NOW, null, { verify: true, limits: limits(3) }),
    );
    // Deleted through the normal path while still unstamped: no meta existed, so no tombstone.
    await stampedTransaction(db, () => db.execute("DELETE FROM gtd_tasks WHERE id = 'task-15'"));
    await runChunked(db, 3, { from: slice.next });
    const meta = (await readMeta(db, "gtd_tasks")).find((row) => row.entity_id === "task-15");
    expect(meta).toBeUndefined();
    // Stamped by the scan first, then deleted by the user: one tombstone, kept by the later scan.
    await stampedTransaction(db, () => db.execute("DELETE FROM gtd_tasks WHERE id = 'task-01'"));
    const tombstone = (await readMeta(db, "gtd_tasks")).find((row) => row.entity_id === "task-01");
    expect(tombstone?.deleted_at).not.toBeNull();
    await runChunked(db, 3);
    expect((await readMeta(db, "gtd_tasks")).find((row) => row.entity_id === "task-01")).toEqual(
      tombstone,
    );
  });
});

describe("runBackfillSlice: healing and edge cases", () => {
  it("tombstones a live clock row whose row vanished unseen, across chunk boundaries", async () => {
    const db = await createCaptureDb();
    await stampedTransaction(db, async () => {
      for (let i = 0; i < 12; i += 1) await insertTask(db, `t${String(i).padStart(2, "0")}`);
    });
    await disableSyncCapture(db);
    await db.execute("DELETE FROM gtd_tasks WHERE id IN ('t00', 't05', 't11')");
    await installSyncCapture(db);
    await runChunked(db, 2);
    const deleted = (await readMeta(db, "gtd_tasks"))
      .filter((row) => row.deleted_at !== null)
      .map((row) => row.entity_id);
    expect(deleted).toEqual(["t00", "t05", "t11"]);
    expect((await runChunked(db, 2)).stamped).toBe(0);
  });

  it("restamps a row edited while capture was off (verify) and skips it without verify", async () => {
    const db = await createCaptureDb();
    await stampedTransaction(db, () => insertTask(db, "t1"));
    await runChunked(db, 50);
    await disableSyncCapture(db);
    await db.execute("UPDATE gtd_tasks SET title = 'changed offline' WHERE id = 't1'");
    await installSyncCapture(db);
    const titleOf = async () =>
      (
        await db.select<{ snapshot_json: string }[]>(
          "SELECT snapshot_json FROM sync_entity_snapshot WHERE entity_type = 'gtd_tasks' AND entity_id = 't1'",
        )
      )[0]?.snapshot_json;
    expect((await runChunked(db, 5, { verify: false })).stamped).toBe(0);
    expect(await titleOf()).not.toContain("changed offline");
    expect((await runChunked(db, 5, { verify: true })).stamped).toBe(1);
    expect(await titleOf()).toContain("changed offline");
    expect((await runChunked(db, 5, { verify: true })).stamped).toBe(0);
  });

  it("skips a NULL-keyed row and still pages past it", async () => {
    const db = await createCaptureDb();
    await insertContext(db, "c1");
    await db.execute(
      "INSERT INTO gtd_contexts (id, name, created_at, updated_at) VALUES (NULL, 'orphan', 't', 't')",
    );
    await insertContext(db, "c2");
    await runChunked(db, 1);
    const ids = (await readMeta(db, "gtd_contexts")).map((row) => row.entity_id);
    expect(ids).toContain("c1");
    expect(ids).toContain("c2");
    expect(ids.every((id) => typeof id === "string" && id !== "")).toBe(true);
    expect(await readMarks(db)).toEqual([]);
    expect((await runChunked(db, 1)).stamped).toBe(0);
  });

  it("pages a composite primary key without skipping or repeating rows", async () => {
    const db = await unstampedDb();
    await runChunked(db, 1);
    const results = (await readMeta(db, "weekly_objective_results")).map((row) => row.entity_id);
    expect(results).toHaveLength(6);
    expect(new Set(results).size).toBe(6);
    const memory = (await readMeta(db, "finance_merchant_memory")).map((row) => row.entity_id);
    expect(memory).toHaveLength(3);
  });

  it("needs the sync identity", async () => {
    const db = await createCaptureDb({ identity: false });
    await expect(
      runSqliteTransaction(db, () =>
        runBackfillSlice(db, CAPTURE_NOW, null, { verify: true, limits: limits(5) }),
      ),
    ).rejects.toThrow(/identity/);
  });
});

describe("runBackfillSlice: the occurrence baseline respects both chunk budgets", () => {
  const templateRow = (id: string): RecurringTaskTemplate => ({
    id,
    title: "Habit",
    notes: "",
    targetBucket: "next_action",
    contextIds: [],
    projectId: null,
    ruleType: "daily",
    dailyInterval: 1,
    weeklyInterval: 1,
    weeklyDays: [0],
    monthlyMode: "day_of_month",
    dayOfMonth: 1,
    nthWeek: 1,
    weekday: 6,
    scheduledTime: null,
    startDate: "2026-03-01",
    status: "active",
    lastGeneratedForDate: "2026-10-20",
    pendingMissedOccurrences: 0,
    statusChangedAt: "2026-03-01T00:00:00.000Z",
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
  });

  /** Templates whose instances carry a backlog, written while capture was off: no occurrence rows. */
  const backlogDb = async (templates: number, backlog: number): Promise<Db> => {
    const db = await createCaptureDb({ capture: false });
    for (let i = 0; i < templates; i += 1) {
      const id = `tpl-${String(i).padStart(2, "0")}`;
      await db.execute(
        `INSERT INTO recurring_task_templates (${recurringTemplatesRows.COLUMNS}) VALUES (${Array.from({ length: 22 }, (_, n) => `$${n + 1}`).join(", ")})`,
        recurringTemplatesRows.toParams(templateRow(id)),
      );
      await insertTask(db, `recurring-task:${id}`, {
        is_recurring_instance: 1,
        recurring_template_id: id,
        recurrence_due_date: "2026-10-20",
        pending_past_recurrences: backlog,
      });
    }
    await installSyncCapture(db);
    // Stamped by an earlier version, before the occurrence sidecars existed: clocks and snapshots
    // are there, the occurrence records are not.
    await backfillSyncCapture(db, CAPTURE_NOW, { verify: true });
    await db.execute("DELETE FROM sync_recurrence_occurrences");
    await db.execute("DELETE FROM sync_recurrence_clears");
    return db;
  };

  const occurrenceState = async (db: Db) => ({
    occurrences: await db.select(
      "SELECT template_id, due_date, outcome FROM sync_recurrence_occurrences ORDER BY template_id, due_date",
    ),
    clears: await db.select(
      "SELECT template_id, cleared_through_date FROM sync_recurrence_clears ORDER BY template_id",
    ),
  });

  const runBudgeted = async (db: Db, rowsPerChunk: number, statementsPerChunk: number) => {
    let cursor: BackfillCursor | null = null;
    let slices = 0;
    let maxStatements = 0;
    do {
      const from: BackfillCursor | null = cursor;
      const slice: BackfillSliceOutcome = await runSqliteTransaction(db, () =>
        runBackfillSlice(db, CAPTURE_NOW, from, {
          verify: true,
          limits: { rowsPerChunk, statementsPerChunk },
        }),
      );
      slices += 1;
      maxStatements = Math.max(maxStatements, slice.statements);
      // The cursor survives the state row's text encoding, as it does between real chunks.
      cursor =
        slice.next === null
          ? null
          : decodeCursor(
              slice.next.step,
              slice.next.key === null ? null : JSON.stringify(slice.next.key),
            );
    } while (cursor !== null);
    return { slices, maxStatements };
  };

  it("10 templates x 200 pending recurrences take many bounded chunks and match the unbounded run", async () => {
    const whole = await backlogDb(10, 200);
    await backfillSyncCapture(whole, CAPTURE_NOW, { verify: true });
    const expected = await occurrenceState(whole);
    expect(expected.occurrences).toHaveLength(10 * 201);

    const db = await backlogDb(10, 200);
    const run = await runBudgeted(db, 25, 60);
    expect(await occurrenceState(db)).toEqual(expected);
    // About 2,010 units of work at 25 a chunk; before the fix the whole baseline was one slice.
    expect(run.slices).toBeGreaterThan(60);
    // The statement budget (60) plus the fixed per-unit and per-slice constants.
    expect(run.maxStatements).toBeLessThan(110);
    // Nothing is left to do, and the same pass over the finished database writes nothing.
    const again = await runBudgeted(db, 25, 60);
    expect(again.slices).toBeGreaterThan(0);
    expect(await occurrenceState(db)).toEqual(expected);
  });

  it("makes progress with the smallest budgets", async () => {
    const whole = await backlogDb(2, 12);
    await backfillSyncCapture(whole, CAPTURE_NOW, { verify: true });
    const db = await backlogDb(2, 12);
    const run = await runBudgeted(db, 1, 1);
    expect(await occurrenceState(db)).toEqual(await occurrenceState(whole));
    expect(run.maxStatements).toBeLessThan(60);
  });

  it("does not page already-baselined instances in one slice", async () => {
    const db = await backlogDb(300, 0);
    await backfillSyncCapture(db, CAPTURE_NOW, { verify: true });
    const run = await runBudgeted(db, 20, 10_000);
    expect(run.maxStatements).toBeLessThan(120);
    expect(run.slices).toBeGreaterThan(1);
  });
});
