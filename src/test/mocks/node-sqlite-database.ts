import { createRequire } from "node:module";
import type { SQLInputValue } from "node:sqlite";
import type { Database as SqliteDatabase } from "../../lib/storage/sqlite-db";

// `node:sqlite` is a recently-added experimental builtin: Node's `module.isBuiltin` recognizes
// it, but Vite's static `builtinModules` externalization list (as of the pinned Vite version)
// does not, so a plain `import "node:sqlite"` gets mis-resolved as a bare specifier under
// Vite/Vitest's transform pipeline. Loading it via `createRequire` sidesteps Vite's import
// analysis entirely.
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");

export interface NodeSqliteDatabaseOptions {
  /**
   * Enforce declared foreign keys (`PRAGMA foreign_keys = ON`). Production enforces them (sqlx's
   * `SqliteConnectOptions` turns them on by default and `src-tauri/src/db.rs` keeps that default),
   * so tests whose behavior depends on `ON DELETE CASCADE` must pass `true`. The default stays
   * `false` so the large existing suite, which was written against the lenient adapter, is
   * unchanged.
   */
  foreignKeys?: boolean;
}

/**
 * Node-side `SqliteDatabase` adapter backed by `node:sqlite`'s in-process engine, used to run
 * `TauriSqliteRepository` against a real SQLite engine in tests instead of the Tauri
 * `db_connect`/`db_execute`/`db_select` commands.
 *
 * Safety: only ever open `:memory:` or an explicit temp-file path — never an app-data path.
 * `createNodeSqliteDatabase` defaults to `:memory:` and callers in this repo never pass
 * anything else.
 *
 * Placeholder style: `TauriSqliteRepository` binds queries with `$1`, `$2`, ... placeholders,
 * reused positionally in the order they were collected into `bindValues`. `node:sqlite` treats
 * `$N` as a named parameter, so bind values are passed as an object keyed by `$1`, `$2`, etc.
 * rather than positionally — this also correctly handles a placeholder repeated within the same
 * query (unlike plain positional binding).
 */
export const createNodeSqliteDatabase = (
  path = ":memory:",
  options: NodeSqliteDatabaseOptions = {},
): SqliteDatabase => {
  // `node:sqlite` enables `PRAGMA foreign_keys` by default. Production enforces foreign keys too
  // (see `foreignKeys` above), but most tests here predate that finding and insert rows without
  // their parents, so enforcement is opt-in per database.
  const db = new DatabaseSync(path, {
    enableForeignKeyConstraints: options.foreignKeys === true,
  });

  const toNamedParams = (bindValues: unknown[]): Record<string, SQLInputValue> => {
    const params: Record<string, SQLInputValue> = {};
    bindValues.forEach((value, index) => {
      // `TauriSqliteRepository` only ever binds JSON-serializable primitives (string, number,
      // or null); `SQLInputValue` covers those plus a few binary/bigint types it never sends.
      params[`$${index + 1}`] = value as SQLInputValue;
    });
    return params;
  };

  return {
    async execute(query, bindValues = []) {
      if (bindValues.length === 0) {
        // Statements with no bind values may be multi-statement DDL (migrations) or simple
        // control statements (`BEGIN IMMEDIATE`, `COMMIT`, `PRAGMA ...`); `exec` supports both.
        db.exec(query);
        return { rowsAffected: 0 };
      }

      const statement = db.prepare(query);
      const result = statement.run(toNamedParams(bindValues));
      return {
        rowsAffected: Number(result.changes),
        lastInsertId: Number(result.lastInsertRowid),
      };
    },

    async select<T>(query: string, bindValues: unknown[] = []): Promise<T> {
      const statement = db.prepare(query);
      const rows =
        bindValues.length === 0 ? statement.all() : statement.all(toNamedParams(bindValues));
      return rows as T;
    },
  };
};
