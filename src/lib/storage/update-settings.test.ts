// @vitest-environment node
import { createNodeSqliteDatabase } from "../../test/mocks/node-sqlite-database";
import { MemoryRepository } from "./memory-repository";
import { TauriSqliteRepository } from "./tauri-sqlite-repository";

const factories = [
  { name: "memory", create: () => new MemoryRepository() },
  {
    name: "SQLite",
    create: () =>
      new TauriSqliteRepository("sqlite::memory:", async () => createNodeSqliteDatabase()),
  },
];

for (const factory of factories) {
  describe(`${factory.name} settings updater`, () => {
    it("merges simultaneous preferences, backup state and first-open metadata without erasing markers", async () => {
      const repository = factory.create();
      await repository.initialize();
      await repository.updateSettings((current) => ({
        ...current,
        gtdImportDoneAt: "imported",
        aiMaxTokensUpgradeDoneAt: "upgraded",
      }));
      await Promise.all([
        repository.updateSettings((current) => ({ ...current, aiEnabled: true })),
        repository.updateSettings((current) => ({ ...current, lastBackupAt: "backup" })),
        repository.updateSettings((current) => ({
          ...current,
          aiPulseFirstOpenAt: { ...current.aiPulseFirstOpenAt, "2026-10-03": "first" },
        })),
        repository.updateSettings((current) => ({
          ...current,
          aiPulseFirstOpenAt: { ...current.aiPulseFirstOpenAt, "2026-10-04": "second" },
        })),
      ]);
      expect(await repository.getSettings()).toMatchObject({
        aiEnabled: true,
        lastBackupAt: "backup",
        gtdImportDoneAt: "imported",
        aiMaxTokensUpgradeDoneAt: "upgraded",
        aiPulseFirstOpenAt: { "2026-10-03": "first", "2026-10-04": "second" },
      });
    });

    it("isolates returned snapshots and rolls back a mutating updater that throws", async () => {
      const repository = factory.create();
      await repository.initialize();
      const before = await repository.getSettings();
      await expect(
        repository.updateSettings((current) => {
          current.aiPulseFirstOpenAt.bad = "mutation";
          current.aiEnabled = true;
          throw new Error("updater failed");
        }),
      ).rejects.toThrow("updater failed");
      expect(await repository.getSettings()).toEqual(before);
      const returned = await repository.updateSettings((current) => ({
        ...current,
        aiEnabled: true,
      }));
      returned.aiPulseFirstOpenAt.bad = "mutation";
      expect((await repository.getSettings()).aiPulseFirstOpenAt).toEqual({});
      await repository.updateSettings((current) => ({ ...current, aiMaxTokens: 0 }));
      expect((await repository.getSettings()).aiMaxTokens).toBe(before.aiMaxTokens);
    });
  });
}

it("rolls back a failed SQLite settings write and permits retry", async () => {
  const db = createNodeSqliteDatabase();
  const repository = new TauriSqliteRepository("sqlite::memory:", async () => db);
  await repository.initialize();
  const before = await repository.getSettings();
  const execute = db.execute.bind(db);
  const spy = vi.spyOn(db, "execute").mockImplementation(async (sql, values) => {
    if (sql.startsWith("INSERT INTO app_settings")) throw new Error("write failed");
    return execute(sql, values);
  });
  await expect(
    repository.updateSettings((current) => ({ ...current, aiEnabled: true })),
  ).rejects.toThrow("write failed");
  spy.mockRestore();
  expect(await repository.getSettings()).toEqual(before);
  expect(
    await repository.updateSettings((current) => ({ ...current, aiEnabled: true })),
  ).toMatchObject({ aiEnabled: true });
});
