// @vitest-environment node
import { describe, expect, it } from "vitest";
import { applyChunked } from "./apply-chunked";
import { DEFAULT_APPLY_LIMITS, planChangeSet } from "./split-change-set";
import { project } from "./test-support/random-ops";
import {
  createSyncHarness,
  jsonRoundTrip,
  type SyncDevice,
} from "./test-support/two-device-harness";

/**
 * One huge project must not become one huge writer slot. A project of 5,000 tasks in the Planned
 * bucket, nearly all of them finished, is the review's worst case: completed tasks take no part in the
 * queue repair, so they are single pieces (400 per chunk); a project of 5,000 ACTIVE tasks is one
 * group, cut at `maxGroupEntities`. The statement count of a slot is exact and machine independent;
 * the bound is the documented worst case (`docs/storage-and-backups.md`, "Limits"): about 1.1
 * statements per task, so 1,500 tasks stay under 2,000 statements.
 */

const WORST_CASE_SLOT_STATEMENTS = 2_000;

const T0 = "2026-10-01T00:00:00.000Z";

const seedProject = async (
  device: SyncDevice,
  total: number,
  completed: number,
  externalIds = false,
) => {
  await device.repo.saveProject(project("big", "Big"));
  await device.db.execute("BEGIN");
  for (let start = 0; start < total; start += 100) {
    const rows = Array.from({ length: Math.min(100, total - start) }, (_, i) => start + i);
    await device.db.execute(
      `INSERT INTO gtd_tasks (id, title, notes, status, bucket, context_ids_json, source, project_id, planned_order, completed_at, created_at, updated_at, source_external_id) VALUES ${rows
        .map(
          (_, r) =>
            `($${r * 6 + 1}, $${r * 6 + 1}, '', $${r * 6 + 2}, 'planned', '[]', 'manual', 'big', $${r * 6 + 3}, $${r * 6 + 4}, $${r * 6 + 5}, $${r * 6 + 5}, $${r * 6 + 6})`,
        )
        .join(", ")}`,
      rows.flatMap((n) => [
        `t-${String(n).padStart(5, "0")}`,
        n < completed ? "completed" : "active",
        n < completed ? null : n - completed,
        n < completed ? T0 : null,
        T0,
        externalIds ? `ext-${n}` : null,
      ]),
    );
  }
  await device.db.execute("COMMIT");
  await device.stamp();
};

const countStatements = (device: SyncDevice) => {
  let statements = 0;
  for (const method of ["select", "execute"] as const) {
    const original = device.db[method].bind(device.db) as (...args: never[]) => Promise<unknown>;
    (device.db as unknown as Record<string, unknown>)[method] = (...args: never[]) => {
      statements += 1;
      return original(...args);
    };
  }
  return () => statements;
};

const applyAndMeasure = async (total: number, completed: number, externalIds = false) => {
  const sim = await createSyncHarness(["A", "B"]);
  const [a, b] = sim.devices as [SyncDevice, SyncDevice];
  await seedProject(a, total, completed, externalIds);
  const changeSet = jsonRoundTrip(await a.repo.listSyncChanges("gtd"));
  const plan = planChangeSet(changeSet, DEFAULT_APPLY_LIMITS);
  const statements = countStatements(b);
  let mark = statements();
  const perChunk: number[] = [];
  const result = await applyChunked(b.repo, "gtd", changeSet, {
    yieldBetweenChunks: async () => undefined,
    onProgress: () => {
      perChunk.push(statements() - mark);
      mark = statements();
    },
  });
  expect(result.nextChunk).toBeNull();
  const rows = await b.db.select<{ n: number }[]>(
    "SELECT COUNT(*) AS n FROM gtd_tasks WHERE project_id = 'big'",
  );
  expect(rows[0]?.n).toBe(total);
  return {
    plan,
    perChunk,
    entities: Math.max(...plan.chunks.map((chunk) => chunk.entities.length)),
  };
};

describe("one very large project", () => {
  it("5,000 planned tasks, 4,980 of them completed, never makes a slot above the documented bound", async () => {
    const { plan, perChunk, entities } = await applyAndMeasure(5_000, 4_980);
    // Completed tasks are single pieces; only the 20 active ones form the project's group.
    expect(plan.largestGroup).toBeLessThanOrEqual(20);
    expect(plan.cutGroups).toBe(0);
    expect(entities).toBeLessThanOrEqual(DEFAULT_APPLY_LIMITS.maxEntities + 20);
    expect(Math.max(...perChunk)).toBeLessThanOrEqual(WORST_CASE_SLOT_STATEMENTS);
  }, 120_000);

  it("5,000 ACTIVE planned tasks: the group is cut at maxGroupEntities and stays under the bound", async () => {
    const { plan, perChunk, entities } = await applyAndMeasure(5_000, 0);
    expect(plan.largestGroup).toBe(5_000);
    expect(plan.cutGroups).toBe(1);
    expect(entities).toBeLessThanOrEqual(DEFAULT_APPLY_LIMITS.maxGroupEntities);
    expect(Math.max(...perChunk)).toBeLessThanOrEqual(WORST_CASE_SLOT_STATEMENTS);
    console.info(
      `[scale] 5000 active: ${plan.chunks.length} chunks, max ${Math.max(...perChunk)} statements`,
    );
  }, 120_000);

  it("5,000 active planned tasks that each carry their own external id are cut like any other project", async () => {
    // Imported tasks: every one has a unique natural key that no other task shares. That key ties
    // nothing, so it must not make a task inseparable from its project's queue.
    const { plan, perChunk, entities } = await applyAndMeasure(5_000, 0, true);
    expect(plan.largestGroup).toBe(5_000);
    expect(plan.cutGroups).toBe(1);
    expect(entities).toBeLessThanOrEqual(DEFAULT_APPLY_LIMITS.maxGroupEntities);
    expect(Math.max(...perChunk)).toBeLessThanOrEqual(WORST_CASE_SLOT_STATEMENTS);
  }, 120_000);
});

describe("a populated target", () => {
  it("renumbering a 5,000-task local queue for one incoming task stays under the slot bound and matches the whole apply", async () => {
    const sim = await createSyncHarness(["A", "B", "C"]);
    const [a, b, c] = sim.devices as [SyncDevice, SyncDevice, SyncDevice];
    // Two receivers with the same big local queue (orders 0..4999), one sender with one new task that
    // sorts ahead of all of them at order 0.
    await seedProject(b, 5_000, 0);
    await seedProject(c, 5_000, 0);
    await a.repo.saveProject(project("big", "Big"));
    await a.db.execute(
      "INSERT INTO gtd_tasks (id, title, notes, status, bucket, context_ids_json, source, project_id, planned_order, created_at, updated_at) VALUES ('t-new', 't-new', '', 'active', 'planned', '[]', 'manual', 'big', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
    );
    await a.stamp();
    const changeSet = jsonRoundTrip(await a.repo.listSyncChanges("gtd"));

    const statements = countStatements(b);
    let mark = statements();
    const perChunk: number[] = [];
    const result = await applyChunked(b.repo, "gtd", changeSet, {
      yieldBetweenChunks: async () => undefined,
      onProgress: () => {
        perChunk.push(statements() - mark);
        mark = statements();
      },
    });
    expect(result.nextChunk).toBeNull();
    // The new task shifts every local member by one; the writes are batched, not one per member.
    // (measured: 100 statements; 5,080 when each member was rewritten on its own).
    expect(Math.max(...perChunk)).toBeLessThanOrEqual(400);

    const queueOf = async (device: SyncDevice) =>
      (
        await device.db.select<{ id: string; planned_order: number }[]>(
          "SELECT id, planned_order FROM gtd_tasks WHERE project_id = 'big' AND bucket = 'planned' ORDER BY planned_order, id",
        )
      ).map((row) => [row.id, row.planned_order]);
    const queue = await queueOf(b);
    expect(queue).toHaveLength(5_001);
    expect(queue[0]).toEqual(["t-new", 0]);
    expect(queue.map(([, order]) => order)).toEqual(Array.from({ length: 5_001 }, (_, i) => i));

    // The unchunked apply ends in the same queue.
    await c.repo.applySyncBundle("gtd", changeSet);
    expect(await queueOf(c)).toEqual(queue);
  }, 180_000);
});
