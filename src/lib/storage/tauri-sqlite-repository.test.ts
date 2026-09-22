// @vitest-environment node
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
