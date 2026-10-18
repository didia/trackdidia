// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecurringTaskTemplate } from "../../domain/types";
// SAFETY: isolated `:memory:` SQLite only (see tauri-sqlite-repository.test.ts).
import { createNodeSqliteDatabase } from "../../test/mocks/node-sqlite-database";
import { MemoryRepository } from "./memory-repository";
import type { AppRepository } from "./repository";
import { TauriSqliteRepository } from "./tauri-sqlite-repository";

// Multi-device sync (specs/todo/multi-laptop-sync.md, Phase 0): a generator that has nothing to
// do must not write a row or emit an event, otherwise it would dirty sync state on every launch.

const TODAY = "2026-04-01";

const template: RecurringTaskTemplate = {
  id: "recurring-template:idle",
  title: "Daily thing",
  notes: "",
  targetBucket: "next_action",
  contextIds: [],
  projectId: null,
  ruleType: "daily",
  dailyInterval: 1,
  weeklyInterval: 1,
  weeklyDays: [0],
  monthlyMode: "day_of_month",
  dayOfMonth: 1,
  nthWeek: 1,
  weekday: 6,
  scheduledTime: null,
  startDate: TODAY,
  status: "active",
  lastGeneratedForDate: null,
  pendingMissedOccurrences: 0,
  statusChangedAt: "2026-04-01T00:00:00.000Z",
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
};

const runGenerators = async (repository: AppRepository) => ({
  recurring: await repository.generateDueRecurringTasks(TODAY),
  scheduled: await repository.promoteDueScheduledTasks(TODAY),
  relationship: await repository.generateDailyRelationshipTasks(TODAY),
});

const snapshot = async (repository: AppRepository) =>
  JSON.stringify({
    tasks: await repository.listTasks({ includeCompleted: true }),
    events: await repository.listTaskEvents(),
    templates: await repository.listRecurringTaskTemplates(),
    settings: await repository.getSettings(),
    projects: await repository.listProjects(),
  });

const seedWork = async (repository: AppRepository) => {
  await repository.updateSettings((current) => ({ ...current, relationshipDrawsEnabled: true }));
  await repository.saveRecurringTaskTemplate(template);
  await repository.createTask({
    title: "Tomorrow",
    bucket: "scheduled",
    scheduledFor: "2026-04-02T09:00:00",
  });
  const first = await runGenerators(repository);
  expect(first.recurring).toBe(1);
  expect(first.relationship).toBeGreaterThan(0);
};

const WRITE_STATEMENT = /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i;

describe("idle generators write nothing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T15:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("MemoryRepository: empty store", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await repository.updateSettings((current) => ({ ...current, relationshipDrawsEnabled: false }));
    const before = await snapshot(repository);

    expect(await runGenerators(repository)).toEqual({
      recurring: 0,
      scheduled: 0,
      relationship: 0,
    });
    expect(await snapshot(repository)).toBe(before);
  });

  it("MemoryRepository: second pass after the work was done", async () => {
    const repository = new MemoryRepository();
    await repository.initialize();
    await seedWork(repository);
    const before = await snapshot(repository);

    expect(await runGenerators(repository)).toEqual({
      recurring: 0,
      scheduled: 0,
      relationship: 0,
    });
    expect(await snapshot(repository)).toBe(before);
  });

  const sqliteCase = async (seed: boolean) => {
    const db = createNodeSqliteDatabase();
    const repository = new TauriSqliteRepository("sqlite::memory:", async () => db);
    await repository.initialize();
    if (seed) {
      await seedWork(repository);
    } else {
      await repository.updateSettings((current) => ({
        ...current,
        relationshipDrawsEnabled: false,
      }));
    }
    const before = await snapshot(repository);
    const changesBefore = await db.select<{ n: number }[]>("SELECT total_changes() AS n");
    const execute = db.execute.bind(db);
    const writes: string[] = [];
    const spy = vi.spyOn(db, "execute").mockImplementation(async (sql, values) => {
      if (WRITE_STATEMENT.test(sql)) {
        writes.push(sql);
      }
      return execute(sql, values);
    });

    const result = await runGenerators(repository);
    spy.mockRestore();

    expect(result).toEqual({ recurring: 0, scheduled: 0, relationship: 0 });
    expect(writes).toEqual([]);
    const changesAfter = await db.select<{ n: number }[]>("SELECT total_changes() AS n");
    expect(changesAfter[0].n).toBe(changesBefore[0].n);
    expect(await snapshot(repository)).toBe(before);
  };

  it("TauriSqliteRepository: empty database", () => sqliteCase(false));
  it("TauriSqliteRepository: second pass after the work was done", () => sqliteCase(true));
});
