// @vitest-environment node
import type { Task } from "../../domain/types";
import { createNodeSqliteDatabase } from "../../test/mocks/node-sqlite-database";
import { MemoryRepository } from "./memory-repository";
import { TauriSqliteRepository } from "./tauri-sqlite-repository";

it("rolls back SQLite relationship tasks, events and markers if the settings write fails, then retries", async () => {
  const db = createNodeSqliteDatabase();
  const repository = new TauriSqliteRepository("sqlite::memory:", async () => db);
  await repository.initialize();
  const beforeSettings = await repository.getSettings();
  const beforeContexts = await repository.listContexts();
  const execute = db.execute.bind(db);
  const spy = vi.spyOn(db, "execute").mockImplementation(async (sql, values) => {
    if (sql.startsWith("INSERT INTO app_settings")) throw new Error("settings write failed");
    return execute(sql, values);
  });

  await expect(repository.generateDailyRelationshipTasks("2026-10-03")).rejects.toThrow(
    "settings write failed",
  );
  spy.mockRestore();
  expect(await repository.getSettings()).toEqual(beforeSettings);
  expect(await repository.listContexts()).toEqual(beforeContexts);
  expect(await repository.listTasks({ includeCompleted: true })).toEqual([]);
  expect(await repository.listTaskEvents()).toEqual([]);
  expect(await repository.generateDailyRelationshipTasks("2026-10-03")).toBe(2);
  expect((await repository.getSettings()).relationshipDrawSpouseProcessedDate).toBe("2026-10-03");
});

it("rolls back memory relationship tasks, events and markers if a later task insertion fails, then retries", async () => {
  const repository = new MemoryRepository();
  await repository.initialize();
  const beforeSettings = await repository.getSettings();
  const beforeContexts = await repository.listContexts();
  const tasks = (repository as unknown as { tasks: Map<string, Task> }).tasks;
  const insert = tasks.set.bind(tasks);
  const spy = vi
    .spyOn(tasks, "set")
    .mockImplementationOnce(insert)
    .mockImplementationOnce(() => {
      throw new Error("task insert failed");
    });

  await expect(repository.generateDailyRelationshipTasks("2026-10-03")).rejects.toThrow(
    "task insert failed",
  );
  spy.mockRestore();
  expect(await repository.getSettings()).toEqual(beforeSettings);
  expect(await repository.listContexts()).toEqual(beforeContexts);
  expect(await repository.listTasks({ includeCompleted: true })).toEqual([]);
  expect(await repository.listTaskEvents()).toEqual([]);
  expect(await repository.generateDailyRelationshipTasks("2026-10-03")).toBe(2);
  expect((await repository.getSettings()).relationshipDrawSpouseProcessedDate).toBe("2026-10-03");
});
