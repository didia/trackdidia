// Test-only: nothing in the app imports this file.
//
// SAFETY: every database here is an in-memory SQLite (see the two-device harness).
import { createNodeSqliteDatabase } from "../../../test/mocks/node-sqlite-database";
import { runMigrations } from "../../storage/migrations";
import { TauriSqliteRepository } from "../../storage/tauri-sqlite-repository";
import { createFakeClock, type SyncDevice } from "./two-device-harness";

/**
 * A byte-for-byte copy of a simulated laptop's database (every table, ledger and sync bookkeeping
 * included) opened as a second laptop with the SAME device id and clock state, foreign keys enforced.
 * Two clones of one laptop receive different strategies of the same bundles in the equivalence tests,
 * so any difference afterwards comes from the strategy alone. Capture is re-installed by the
 * repository's own startup check (the triggers are not copied).
 */
export const cloneDevice = async (source: SyncDevice, name = source.name): Promise<SyncDevice> => {
  const db = createNodeSqliteDatabase(":memory:", { foreignKeys: true });
  await runMigrations(db);
  await db.execute("PRAGMA foreign_keys = OFF");
  const tables = await source.db.select<{ name: string }[]>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY rowid",
  );
  for (const { name: table } of tables) {
    await db.execute(`DELETE FROM "${table}"`);
    const rows = await source.db.select<Record<string, unknown>[]>(`SELECT * FROM "${table}"`);
    const columns = Object.keys(rows[0] ?? {});
    for (let start = 0; start < rows.length; start += 50) {
      const batch = rows.slice(start, start + 50);
      const values = batch
        .map(
          (_, row) =>
            `(${columns.map((__, col) => `$${row * columns.length + col + 1}`).join(", ")})`,
        )
        .join(", ");
      await db.execute(
        `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(", ")}) VALUES ${values}`,
        batch.flatMap((row) => columns.map((column) => row[column])),
      );
    }
  }
  await db.execute("PRAGMA foreign_keys = ON");
  const clock = createFakeClock(source.clock.now);
  const repo = new TauriSqliteRepository("sqlite::memory:", async () => db, clock.read);
  await repo.initialize();
  return {
    name,
    deviceId: source.deviceId,
    db,
    repo,
    clock,
    stamp: async () => {
      await repo.enableSyncCapture();
    },
  };
};
