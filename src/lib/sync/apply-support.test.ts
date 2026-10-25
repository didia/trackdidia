// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createNodeSqliteDatabase } from "../../test/mocks/node-sqlite-database";
import { runMigrations } from "../storage/migrations";
import { toSqlApplyError } from "./apply-support";

/**
 * A unique violation that reaches SQL is translated into a typed error naming the table and index.
 * After canonical identity this only happens for a key the alias path could not resolve (a declared
 * key: `natural_key_collision`) or for a key the registry does not declare (`unique_violation`).
 */

const violation = async (sql: string, setup: string[] = []) => {
  const db = createNodeSqliteDatabase();
  await runMigrations(db);
  for (const statement of setup) await db.execute(statement);
  try {
    await db.execute(sql);
    throw new Error("expected a unique violation");
  } catch (error) {
    return { db, error };
  }
};

const insertTask = (id: string, key: string) =>
  `INSERT INTO gtd_tasks (id, title, notes, status, bucket, context_ids_json, source, source_external_id, created_at, updated_at)
   VALUES ('${id}', 't', '', 'active', 'inbox', '[]', 'manual', '${key}', 'x', 'x')`;

describe("toSqlApplyError", () => {
  it("names a declared inline UNIQUE key as a natural_key_collision, with table and index", async () => {
    const { db, error } = await violation(insertTask("t2", "k"), [insertTask("t1", "k")]);
    const translated = await toSqlApplyError(db, "gtd_tasks", "t2", error);
    expect(translated).toMatchObject({
      name: "SyncApplyError",
      code: "natural_key_collision",
      table: "gtd_tasks",
      entityId: "t2",
    });
    expect(translated.index).toMatch(/^sqlite_autoindex_gtd_tasks_\d+$/);
    expect(translated.message).toContain("gtd_tasks");
  });

  it("names a declared partial unique index (external_key) as a natural_key_collision", async () => {
    const account = (id: string) =>
      `INSERT INTO finance_accounts (id, name, type, currency, ownership, on_budget, closed, opening_balance_minor, external_key, sort_order, created_at, updated_at)
       VALUES ('${id}', 'n', 'checking', 'CAD', 'individual', 1, 0, 0, 'KEY', 0, 'x', 'x')`;
    const { db, error } = await violation(account("a2"), [account("a1")]);
    const translated = await toSqlApplyError(db, "finance_accounts", "a2", error);
    expect(translated).toMatchObject({ code: "natural_key_collision", table: "finance_accounts" });
    expect(translated.index).toBe("uniq_finance_account_external_key");
  });

  it("calls a key the registry does not declare a unique_violation and names its index", async () => {
    const { db, error } = await violation(insertTask("t2", "other"), [
      insertTask("t1", "other2"),
      "CREATE UNIQUE INDEX test_only_unique_title ON gtd_tasks (title)",
    ]);
    const translated = await toSqlApplyError(db, "gtd_tasks", "t2", error);
    expect(translated).toMatchObject({ code: "unique_violation", table: "gtd_tasks" });
    expect(translated.index).toBe("test_only_unique_title");
  });

  it("passes other SQL failures through as sql_error", async () => {
    const db = createNodeSqliteDatabase();
    await runMigrations(db);
    const error = await db
      .execute("INSERT INTO gtd_tasks (id) VALUES ('x')")
      .catch((e: unknown) => e);
    expect(await toSqlApplyError(db, "gtd_tasks", "x", error)).toMatchObject({ code: "sql_error" });
  });
});
