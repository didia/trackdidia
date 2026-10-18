// @vitest-environment node
import { createNodeSqliteDatabase } from "../../test/mocks/node-sqlite-database";
import { createEmptyWeeklyReview } from "../../domain/weekly-review";
import { TauriSqliteRepository } from "./tauri-sqlite-repository";
import { runSqliteTransaction, transactionDb, type TxContext } from "./transaction";

const createDatabase = async () => {
  const db = createNodeSqliteDatabase();
  await db.execute("CREATE TABLE test_values (value TEXT)");
  return db;
};

it("commits early returns and invalidates the callback context afterward", async () => {
  const db = await createDatabase();
  let captured!: TxContext;
  await expect(
    runSqliteTransaction(db, async (tx) => {
      captured = tx;
      await transactionDb(tx).execute("INSERT INTO test_values VALUES ('saved')");
      return 42;
    }),
  ).resolves.toBe(42);
  expect(await db.select("SELECT value FROM test_values")).toEqual([{ value: "saved" }]);
  expect(captured.active).toBe(false);
  expect(() => transactionDb(captured)).toThrow("no longer active");
});

it("rolls back failed work and permits a subsequent transaction", async () => {
  const db = await createDatabase();
  const failure = new Error("write failed");
  await expect(
    runSqliteTransaction(db, async (tx) => {
      await transactionDb(tx).execute("INSERT INTO test_values VALUES ('discard')");
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(await db.select("SELECT value FROM test_values")).toEqual([]);
  await runSqliteTransaction(db, async (tx) => {
    await transactionDb(tx).execute("INSERT INTO test_values VALUES ('retry')");
  });
  expect(await db.select("SELECT value FROM test_values")).toEqual([{ value: "retry" }]);
});

it("rolls back on a commit failure and keeps the original error", async () => {
  const db = await createDatabase();
  const originalExecute = db.execute.bind(db);
  const failure = new Error("commit failed");
  const execute = vi.spyOn(db, "execute").mockImplementation(async (sql, values) => {
    if (sql === "COMMIT") throw failure;
    return originalExecute(sql, values);
  });
  await expect(
    runSqliteTransaction(db, async (tx) => {
      await transactionDb(tx).execute("INSERT INTO test_values VALUES ('discard')");
    }),
  ).rejects.toBe(failure);
  expect(execute).toHaveBeenCalledWith("ROLLBACK");
  expect(await db.select("SELECT value FROM test_values")).toEqual([]);
  execute.mockRestore();
  await runSqliteTransaction(db, async () => undefined);
});

it("keeps the primary failure even when rollback and error reporting fail", async () => {
  const db = await createDatabase();
  const originalExecute = db.execute.bind(db);
  const primary = new Error("primary");
  const secondary = new Error("rollback failed");
  const reporter = vi.fn(() => {
    throw new Error("reporter failed");
  });
  vi.spyOn(db, "execute").mockImplementation(async (sql, values) => {
    const result = await originalExecute(sql, values);
    if (sql === "ROLLBACK") throw secondary;
    return result;
  });
  await expect(
    runSqliteTransaction(
      db,
      async () => {
        throw primary;
      },
      reporter,
    ),
  ).rejects.toBe(primary);
  expect(reporter).toHaveBeenCalledWith(secondary);
});

it("rejects direct nesting without rolling back or invalidating the outer context", async () => {
  const db = await createDatabase();
  await runSqliteTransaction(db, async (tx) => {
    await expect(runSqliteTransaction(db, async () => undefined)).rejects.toThrow(
      "Nested SQLite transaction",
    );
    await transactionDb(tx).execute("INSERT INTO test_values VALUES ('outer')");
  });
  expect(await db.select("SELECT value FROM test_values")).toEqual([{ value: "outer" }]);
});

it("clears context ownership after BEGIN fails", async () => {
  const db = await createDatabase();
  const failure = new Error("begin failed");
  const execute = vi.spyOn(db, "execute").mockRejectedValueOnce(failure);
  await expect(runSqliteTransaction(db, async () => undefined)).rejects.toBe(failure);
  expect(execute).toHaveBeenCalledTimes(1);
  await runSqliteTransaction(db, async () => undefined);
});

it("serializes concurrent repository transactions and commits no-op early returns", async () => {
  const db = createNodeSqliteDatabase();
  const repository = new TauriSqliteRepository("sqlite::memory:", async () => db);
  await repository.initialize();
  const originalExecute = db.execute.bind(db);
  const controls: string[] = [];
  let active = 0;
  let maxActive = 0;
  vi.spyOn(db, "execute").mockImplementation(async (sql, values) => {
    if (sql === "BEGIN IMMEDIATE") {
      active += 1;
      maxActive = Math.max(active, maxActive);
    }
    if (["BEGIN IMMEDIATE", "COMMIT", "ROLLBACK"].includes(sql)) controls.push(sql);
    await Promise.resolve();
    const result = await originalExecute(sql, values);
    if (sql === "COMMIT" || sql === "ROLLBACK") active -= 1;
    return result;
  });
  await Promise.all([
    repository.createTask({ title: "first", bucket: "inbox", contextIds: [] }),
    repository.saveWeeklyReview(createEmptyWeeklyReview("2026-08-02")),
    repository.promoteDueScheduledTasks("2026-08-02"),
  ]);
  expect(maxActive).toBe(1);
  expect(active).toBe(0);
  expect(controls).toEqual([
    "BEGIN IMMEDIATE",
    "COMMIT",
    "BEGIN IMMEDIATE",
    "COMMIT",
    "BEGIN IMMEDIATE",
    "COMMIT",
  ]);
});

describe("beforeCommit hook", () => {
  it("runs after the work and before COMMIT, on the same connection, inside the transaction", async () => {
    const db = await createDatabase();
    const order: string[] = [];
    const originalExecute = db.execute.bind(db);
    vi.spyOn(db, "execute").mockImplementation(async (sql, values) => {
      if (sql === "COMMIT" || sql === "BEGIN IMMEDIATE" || sql === "ROLLBACK") order.push(sql);
      return originalExecute(sql, values);
    });
    await runSqliteTransaction(
      db,
      async (tx) => {
        order.push("work");
        await transactionDb(tx).execute("INSERT INTO test_values VALUES ('a')");
      },
      undefined,
      async (hookDb) => {
        order.push("hook");
        expect(hookDb).toBe(db);
        await hookDb.execute("INSERT INTO test_values VALUES ('stamped')");
      },
    );
    expect(order).toEqual(["BEGIN IMMEDIATE", "work", "hook", "COMMIT"]);
    expect(await db.select("SELECT value FROM test_values ORDER BY rowid")).toEqual([
      { value: "a" },
      { value: "stamped" },
    ]);
  });

  it("rolls the work back together with the hook's writes when the hook throws", async () => {
    const db = await createDatabase();
    const failure = new Error("stamp failed");
    await expect(
      runSqliteTransaction(
        db,
        async (tx) => {
          await transactionDb(tx).execute("INSERT INTO test_values VALUES ('discard')");
        },
        undefined,
        async (hookDb) => {
          await hookDb.execute("INSERT INTO test_values VALUES ('also discard')");
          throw failure;
        },
      ),
    ).rejects.toBe(failure);
    expect(await db.select("SELECT value FROM test_values")).toEqual([]);
    // The connection is usable again.
    await runSqliteTransaction(db, async (tx) => {
      await transactionDb(tx).execute("INSERT INTO test_values VALUES ('retry')");
    });
    expect(await db.select("SELECT value FROM test_values")).toEqual([{ value: "retry" }]);
  });

  it("does not run when the work throws, and callers without a hook are unchanged", async () => {
    const db = await createDatabase();
    const hook = vi.fn(async () => undefined);
    await expect(
      runSqliteTransaction(
        db,
        async () => {
          throw new Error("nope");
        },
        undefined,
        hook,
      ),
    ).rejects.toThrow("nope");
    expect(hook).not.toHaveBeenCalled();
    const executed: string[] = [];
    const originalExecute = db.execute.bind(db);
    vi.spyOn(db, "execute").mockImplementation(async (sql, values) => {
      executed.push(sql);
      return originalExecute(sql, values);
    });
    await runSqliteTransaction(db, async () => 1);
    expect(executed).toEqual(["BEGIN IMMEDIATE", "COMMIT"]);
  });
});
