// @vitest-environment node
import { describe, expect, it } from "vitest";
// SAFETY: every repository built here is backed by an isolated `:memory:` SQLite database via
// `createNodeSqliteDatabase`. Never point `TauriSqliteRepository` at a real connection string or
// an app-data path from a test.
import { createNodeSqliteDatabase } from "../../../test/mocks/node-sqlite-database";
import { TauriSqliteRepository } from "../tauri-sqlite-repository";
import { migrations, resolveIdempotentMigrationSql } from "./index";

describe("migration 41 add_finance_account_update_cadence", () => {
  const migration = migrations.find((item) => item.id === 41);

  it("is appended after 40 and only adds a nullable column", () => {
    expect(migration?.name).toBe("add_finance_account_update_cadence");
    expect(migration?.sql).toContain(
      "ALTER TABLE finance_accounts ADD COLUMN update_cadence_days INTEGER;",
    );
    expect(migration?.sql).not.toMatch(/NOT NULL|DEFAULT/);
  });

  it("leaves existing accounts on the default cadence and skips the ALTER when the column exists", async () => {
    const database = await createNodeSqliteDatabase();
    const repository = new TauriSqliteRepository("sqlite::memory:", async () => database);
    await repository.initialize();

    const saved = await repository.saveFinanceAccount({
      id: "finance-account:1",
      name: "Chèques",
      institution: null,
      type: "checking",
      currency: "CAD",
      ownerPersonId: null,
      ownership: "individual",
      onBudget: true,
      closed: false,
      openingBalanceMinor: 0,
      currentBalanceMinor: null,
      balanceAsOf: null,
      externalKey: null,
      notes: null,
      sortOrder: 0,
      createdAt: "2026-10-12T00:00:00.000Z",
      updatedAt: "2026-10-12T00:00:00.000Z",
    });
    expect(saved.updateCadenceDays).toBeNull();

    // The column already exists after initialize(); re-running the migration must be a no-op.
    const sql = await resolveIdempotentMigrationSql(database, migration!);
    expect(sql).toBe("SELECT 1;");
  });
});
