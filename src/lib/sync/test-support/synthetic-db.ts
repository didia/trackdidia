// Test-only: nothing in the app imports this file.
//
// SAFETY: operates on a database handed in by a test (an in-memory SQLite).
import type { Database } from "../../storage/sqlite-db";

/**
 * A large synthetic database for the scale measurements: raw SQL rows in the tables that dominate a
 * real one (tasks and their events, finance transactions with splits, daily entries), written with
 * capture OFF, as a database that has been used for years before sync is enabled.
 *
 * The default size is the one `docs/multi-device-sync.md` measured the single-transaction backfill
 * on: 5,000 tasks, 3,000 events, 50,000 transactions with 15,000 splits (7,500 two-way splits) and
 * 1,100 daily entries, 71,100 entities plus the migration seeds.
 */

export interface SyntheticSize {
  tasks: number;
  events: number;
  transactions: number;
  /** Rounded down to an even number: each split transaction has two splits. */
  splits: number;
  dailyEntries: number;
}

export const SIZE_1X: SyntheticSize = {
  tasks: 5_000,
  events: 3_000,
  transactions: 50_000,
  splits: 15_000,
  dailyEntries: 1_100,
};

export const SIZE_2X: SyntheticSize = {
  tasks: 10_000,
  events: 6_000,
  transactions: 100_000,
  splits: 30_000,
  dailyEntries: 2_200,
};

const BATCH = 100;

const insertBatches = async (
  db: Database,
  table: string,
  columns: readonly string[],
  rows: Iterable<readonly unknown[]>,
): Promise<void> => {
  let batch: (readonly unknown[])[] = [];
  const flush = async () => {
    if (batch.length === 0) return;
    const values = batch
      .map(
        (_, row) =>
          `(${columns.map((__, col) => `$${row * columns.length + col + 1}`).join(", ")})`,
      )
      .join(", ");
    await db.execute(
      `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${values}`,
      batch.flat() as unknown[],
    );
    batch = [];
  };
  for (const row of rows) {
    batch.push(row);
    if (batch.length === BATCH) await flush();
  }
  await flush();
};

const TRANSACTION_COLUMNS = [
  "id",
  "account_id",
  "posted_date",
  "amount_minor",
  "currency",
  "description_raw",
  "merchant_key",
  "category_id",
  "category_source",
  "pending",
  "is_transfer",
  "excluded_from_budget",
  "excluded_from_reports",
  "has_splits",
  "dedupe_hash",
  "created_at",
  "updated_at",
] as const;

const pad = (n: number, width = 6): string => String(n).padStart(width, "0");

/** One account row, with the id the transactions below refer to. */
export const insertSyntheticAccount = async (db: Database, id = "account-1"): Promise<void> => {
  await db.execute(
    `INSERT OR IGNORE INTO finance_accounts (id, name, type, currency, created_at, updated_at)
     VALUES ($1, 'Compte', 'checking', 'CAD', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    [id],
  );
};

/**
 * Transactions `prefix-000000 ..`, hash `hash-<i>` (so two prefixes over the same range collide on the
 * natural key `(account_id, dedupe_hash)`); `splitEvery` makes every n-th one a two-way split.
 */
export const insertSyntheticTransactions = async (
  db: Database,
  options: {
    prefix: string;
    count: number;
    hashFrom?: number;
    splitEvery?: number;
    account?: string;
  },
): Promise<number> => {
  const account = options.account ?? "account-1";
  const hashFrom = options.hashFrom ?? 0;
  const splitEvery = options.splitEvery ?? 0;
  const splitRows: unknown[][] = [];
  const rows: unknown[][] = [];
  for (let i = 0; i < options.count; i += 1) {
    const id = `${options.prefix}-${pad(i)}`;
    const amount = -(1000 + (i % 977));
    const split = splitEvery > 0 && i % splitEvery === 0;
    rows.push([
      id,
      account,
      `2026-0${1 + (i % 9)}-${pad(1 + (i % 28), 2)}`,
      amount,
      "CAD",
      `LINE ${i}`,
      `MERCHANT ${i % 400}`,
      split ? "fincat:split" : "fincat:non-categorise",
      "default",
      0,
      0,
      0,
      0,
      split ? 1 : 0,
      `hash-${hashFrom + i}`,
      "2026-04-01T00:00:00.000Z",
      "2026-04-01T00:00:00.000Z",
    ]);
    if (split) {
      const first = Math.trunc(amount / 2);
      splitRows.push(
        [
          `${id}-s1`,
          id,
          amount - first,
          "fincat:non-categorise",
          null,
          0,
          "2026-04-01T00:00:00.000Z",
        ],
        [`${id}-s2`, id, first, "fincat:non-categorise", null, 1, "2026-04-01T00:00:00.000Z"],
      );
    }
  }
  await insertBatches(db, "finance_transactions", TRANSACTION_COLUMNS, rows);
  await insertBatches(
    db,
    "finance_transaction_splits",
    ["id", "transaction_id", "amount_minor", "category_id", "notes", "sort_order", "created_at"],
    splitRows,
  );
  return splitRows.length;
};

/** Seeds `size` into `db` with capture off. Returns the number of entities (rows of captured tables). */
export const seedSyntheticDatabase = async (
  db: Database,
  size: SyntheticSize = SIZE_1X,
): Promise<{ entities: number }> => {
  await db.execute("BEGIN");
  try {
    await insertBatches(
      db,
      "gtd_tasks",
      [
        "id",
        "title",
        "notes",
        "status",
        "bucket",
        "context_ids_json",
        "source",
        "created_at",
        "updated_at",
      ],
      (function* () {
        for (let i = 0; i < size.tasks; i += 1) {
          yield [
            `task-${pad(i)}`,
            `Task ${i}`,
            "",
            i % 5 === 0 ? "completed" : "active",
            "next_action",
            "[]",
            "manual",
            "2026-01-01T00:00:00.000Z",
            "2026-01-01T00:00:00.000Z",
          ];
        }
      })(),
    );
    await insertBatches(
      db,
      "gtd_task_events",
      [
        "id",
        "task_id",
        "type",
        "event_date",
        "event_at",
        "created_at",
        "dedupe_key",
        "metadata_json",
      ],
      (function* () {
        for (let i = 0; i < size.events; i += 1) {
          yield [
            `event-${pad(i)}`,
            `task-${pad(i % Math.max(1, size.tasks))}`,
            "task_created",
            "2026-01-01",
            "2026-01-01T00:00:00.000Z",
            "2026-01-01T00:00:00.000Z",
            `dk-${i}`,
            "{}",
          ];
        }
      })(),
    );
    await insertSyntheticAccount(db);
    const splitRows = await insertSyntheticTransactions(db, {
      prefix: "txn",
      count: size.transactions,
      splitEvery: Math.max(1, Math.round(size.transactions / Math.max(1, size.splits / 2))),
    });
    await insertBatches(
      db,
      "daily_entries",
      ["date", "status", "metrics_json", "principles_json", "updated_at"],
      (function* () {
        for (let i = 0; i < size.dailyEntries; i += 1) {
          const day = new Date(Date.UTC(2022, 0, 1 + i)).toISOString().slice(0, 10);
          yield [day, "open", '{"a":1}', "{}", "2026-01-01T00:00:00.000Z"];
        }
      })(),
    );
    await db.execute("COMMIT");
    return {
      entities: size.tasks + size.transactions + splitRows + size.dailyEntries + 1,
    };
  } catch (error) {
    await db.execute("ROLLBACK");
    throw error;
  }
};
