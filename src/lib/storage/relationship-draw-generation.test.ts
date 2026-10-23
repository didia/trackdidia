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

const withActivities = async (repository: MemoryRepository | TauriSqliteRepository) => {
  await repository.updateSettings((current) => ({
    ...current,
    relationshipDrawsEnabled: true,
    relationshipDrawChildrenActivities: ["jouer", "lire", "dessiner", "cuisiner", "marcher"],
    relationshipDrawSpouseActivities: ["diner", "cinema", "promenade"],
  }));
};

const drawnRows = async (repository: MemoryRepository | TauriSqliteRepository) =>
  (await repository.listTasks({ includeCompleted: true }))
    .map((task) => ({
      id: task.id,
      title: task.title,
      sourceExternalId: task.sourceExternalId,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

it("draws the same rows on independent repositories (deterministic ids and activities)", async () => {
  const draws: Awaited<ReturnType<typeof drawnRows>>[] = [];
  for (let index = 0; index < 3; index += 1) {
    const repository =
      index === 0
        ? new MemoryRepository()
        : new TauriSqliteRepository("sqlite::memory:", async () => createNodeSqliteDatabase());
    await repository.initialize();
    await withActivities(repository);
    expect(await repository.generateDailyRelationshipTasks("2026-10-03")).toBe(2);
    draws.push(await drawnRows(repository));
  }
  expect(draws[1]).toEqual(draws[0]);
  expect(draws[2]).toEqual(draws[0]);
  expect(draws[0]?.map((row) => row.id)).toEqual([
    "task:relationship-draw:children:2026-10-03",
    "task:relationship-draw:spouse:2026-10-03",
  ]);
});

it("does not fail or duplicate when a day that already has its row is drawn again", async () => {
  for (const repository of [
    new MemoryRepository(),
    new TauriSqliteRepository("sqlite::memory:", async () => createNodeSqliteDatabase()),
  ]) {
    await repository.initialize();
    await withActivities(repository);
    await repository.generateDailyRelationshipTasks("2026-10-03");
    await repository.completeTask(
      "task:relationship-draw:children:2026-10-03",
      "2026-10-03T20:00:00.000Z",
    );
    // The processed markers are back to a past value (a restore, a synced older marker).
    await repository.updateSettings((current) => ({
      ...current,
      relationshipDrawChildrenProcessedDate: "",
      relationshipDrawSpouseProcessedDate: "",
    }));
    expect(await repository.generateDailyRelationshipTasks("2026-10-03")).toBe(0);
    const rows = await repository.listTasks({ includeCompleted: true });
    expect(rows).toHaveLength(2);
    expect(rows.find((task) => task.id.endsWith("children:2026-10-03"))?.status).toBe("completed");
  }
});
