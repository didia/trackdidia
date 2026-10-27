// @vitest-environment node
import { describe, expect, it } from "vitest";
// SAFETY: every repository built here is backed by an isolated `:memory:` SQLite database via
// `createNodeSqliteDatabase`. Never point `TauriSqliteRepository` at a real connection string or
// an app-data path from a test.
import { createNodeSqliteDatabase } from "../../../test/mocks/node-sqlite-database";
import { TauriSqliteRepository } from "../tauri-sqlite-repository";
import { migrations, resolveIdempotentMigrationSql } from "./index";

describe("migration 44 add_finance_account_payment_due", () => {
  const migration = migrations.find((item) => item.id === 44);

  it("is appended after 43 and only adds nullable columns", () => {
    expect(migration?.name).toBe("add_finance_account_payment_due");
    expect(migrations[migrations.indexOf(migration!) - 1]?.id).toBe(43);
    expect(migration?.sql).toContain(
      "ALTER TABLE finance_accounts ADD COLUMN payment_due_day INTEGER;",
    );
    expect(migration?.sql).toContain(
      "ALTER TABLE finance_accounts ADD COLUMN minimum_payment_minor INTEGER;",
    );
    expect(migration?.sql).not.toMatch(/NOT NULL|DEFAULT|UPDATE|DELETE|DROP/);
  });

  it("leaves existing accounts unset and skips both ALTERs once the columns exist", async () => {
    const database = await createNodeSqliteDatabase();
    const repository = new TauriSqliteRepository("sqlite::memory:", async () => database);
    await repository.initialize();

    const saved = await repository.saveFinanceAccount({
      id: "finance-account:1",
      name: "Visa",
      institution: null,
      type: "credit_card",
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
    expect(saved.paymentDueDay).toBeNull();
    expect(saved.minimumPaymentMinor).toBeNull();

    const sql = await resolveIdempotentMigrationSql(database, migration!);
    expect(sql).toBe("SELECT 1;");
  });

  it("preserves an existing account row and adds the columns as NULL", async () => {
    const database = await createNodeSqliteDatabase();
    await database.execute(migrations[0].sql);
    for (const item of migrations.slice(1).filter((candidate) => candidate.id < 44)) {
      await database.execute(await resolveIdempotentMigrationSql(database, item));
    }
    await database.execute(
      `INSERT INTO finance_accounts (
        id, name, type, currency, ownership, on_budget, closed, opening_balance_minor,
        sort_order, created_at, updated_at
      ) VALUES ('a1', 'Visa', 'credit_card', 'CAD', 'individual', 1, 0, -1234, 0, 'x', 'x')`,
    );

    await database.execute(await resolveIdempotentMigrationSql(database, migration!));

    expect(
      await database.select(
        "SELECT name, opening_balance_minor, payment_due_day, minimum_payment_minor FROM finance_accounts",
      ),
    ).toEqual([
      {
        name: "Visa",
        opening_balance_minor: -1234,
        payment_due_day: null,
        minimum_payment_minor: null,
      },
    ]);
  });
});
