// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Database } from "../storage/sqlite-db";
import { financeAccount } from "./test-support/finance-fixtures";
import { createSyncHarness, jsonRoundTrip } from "./test-support/two-device-harness";

/**
 * The first merge of years of statements moves thousands of transactions. The number of SQL
 * statements the alias path issues is independent of machine load, so it is the regression guard:
 * it must grow linearly with the number of collisions (a handful of statements per collision at most,
 * and doubling the collisions must not much more than double the statements). The time bound is only
 * a very generous backstop.
 */

const COLUMNS =
  "id, account_id, posted_date, amount_minor, currency, description_raw, merchant_key, category_id, category_source, pending, is_transfer, excluded_from_budget, excluded_from_reports, has_splits, dedupe_hash, created_at, updated_at";

const seedTransactions = async (db: Database, prefix: string, count: number) => {
  await db.execute("BEGIN");
  for (let i = 0; i < count; i += 1) {
    await db.execute(
      `INSERT INTO finance_transactions (${COLUMNS}) VALUES ($1,'account-1','2026-04-01',$2,'CAD','LINE','LINE','fincat:non-categorise','default',0,0,0,0,0,$3,'x','x')`,
      [`${prefix}-${String(i).padStart(6, "0")}`, -i, `hash-${i}`],
    );
  }
  await db.execute("COMMIT");
};

const applyColliding = async (count: number) => {
  const sim = await createSyncHarness(["A", "B"]);
  const [a, b] = [sim.device("A"), sim.device("B")];
  await a.repo.saveFinanceAccount(financeAccount());
  await sim.syncAll("finance");
  await seedTransactions(a.db, "txn-a", count);
  await seedTransactions(b.db, "txn-b", count);
  await a.stamp();
  await b.stamp();
  const bundle = jsonRoundTrip(await a.repo.listSyncChanges("finance"));
  let statements = 0;
  for (const method of ["select", "execute"] as const) {
    const original = b.db[method].bind(b.db) as (...args: never[]) => Promise<unknown>;
    (b.db as unknown as Record<string, unknown>)[method] = (...args: never[]) => {
      statements += 1;
      return original(...args);
    };
  }
  const start = Date.now();
  await b.repo.applySyncBundle("finance", bundle);
  const elapsed = Date.now() - start;
  const rows = await b.db.select<{ n: number }[]>("SELECT COUNT(*) AS n FROM finance_transactions");
  return { statements, elapsed, transactions: rows[0]?.n };
};

describe("a first merge of many colliding transactions", () => {
  it("issues a bounded number of statements per collision and stays linear", async () => {
    const small = await applyColliding(1500);
    const large = await applyColliding(3000);
    expect(small.transactions).toBe(1500);
    expect(large.transactions).toBe(3000);
    expect(small.statements / 1500).toBeLessThan(4);
    expect(large.statements / 3000).toBeLessThan(4);
    expect(large.statements / small.statements).toBeLessThan(2.3);
    expect(large.elapsed).toBeLessThan(60_000);
  }, 180_000);
});
