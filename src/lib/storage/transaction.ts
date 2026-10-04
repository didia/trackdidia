import type { Database } from "./sqlite-db";

const transactionBrand: unique symbol = Symbol("sqlite transaction");
const activeConnections = new WeakSet<Database>();

export interface TxContext {
  readonly [transactionBrand]: true;
  readonly db: Database;
  readonly active: boolean;
}

/** Internal writers reject a context that escaped its transaction callback. */
export const transactionDb = (tx: TxContext): Database => {
  if (!tx?.[transactionBrand] || !tx.active) {
    throw new Error("SQLite transaction context is no longer active");
  }
  return tx.db;
};

/** Caller owns connection serialization; this owns commit/rollback and context lifetime. */
export const runSqliteTransaction = async <T>(
  db: Database,
  work: (tx: TxContext) => Promise<T>,
  onRollbackError?: (error: unknown) => void,
): Promise<T> => {
  if (activeConnections.has(db)) throw new Error("Nested SQLite transaction is not allowed");
  activeConnections.add(db);
  let active = false;
  const tx: TxContext = {
    [transactionBrand]: true,
    db,
    get active() {
      return active;
    },
  };
  try {
    await db.execute("BEGIN IMMEDIATE");
    active = true;
    try {
      const value = await work(tx);
      await db.execute("COMMIT");
      return value;
    } catch (error) {
      try {
        await db.execute("ROLLBACK");
      } catch (rollbackError) {
        try {
          onRollbackError?.(rollbackError);
        } catch {
          /* Keep the primary failure. */
        }
      }
      throw error;
    }
  } finally {
    active = false;
    activeConnections.delete(db);
  }
};
