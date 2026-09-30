// @vitest-environment node
import { describe, expect, it } from "vitest";
// SAFETY: every repository built here is backed by an isolated `:memory:` SQLite database via
// `createNodeSqliteDatabase`. Never point `TauriSqliteRepository` at a real connection string or
// an app-data path from a test.
import { createNodeSqliteDatabase } from "../../test/mocks/node-sqlite-database";
import { describeRepositoryContract } from "./repository.contract";
import { TauriSqliteRepository } from "./tauri-sqlite-repository";

describeRepositoryContract("TauriSqliteRepository (node:sqlite in-memory adapter)", async () => {
  const repository = new TauriSqliteRepository("sqlite::memory:", async () =>
    createNodeSqliteDatabase(),
  );
  await repository.initialize();
  return repository;
});

describe("TauriSqliteRepository mid-week decisions row mapping", () => {
  it("reads a corrupt snapshot JSON as laggingSnapshot null", async () => {
    let database: Awaited<ReturnType<typeof createNodeSqliteDatabase>> | null = null;
    const repository = new TauriSqliteRepository("sqlite::memory:", async () => {
      database = await createNodeSqliteDatabase();
      return database;
    });
    await repository.initialize();
    await database!.execute(
      `INSERT INTO mid_week_decisions
         (week_start_date, decisions, decided_on_date, lagging_snapshot_json, updated_at)
       VALUES ('2026-08-02', 'X', '2026-08-05', '{not json', '2026-08-05T10:00:00.000Z')`,
    );

    await expect(repository.getMidWeekDecisions("2026-08-02")).resolves.toMatchObject({
      decisions: "X",
      laggingSnapshot: null,
    });
  });
});
