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

const seedProject = async (device: SyncDevice, total: number, completed: number) => {
  await device.repo.saveProject(project("big", "Big"));
  await device.db.execute("BEGIN");
  for (let start = 0; start < total; start += 100) {
    const rows = Array.from({ length: Math.min(100, total - start) }, (_, i) => start + i);
    await device.db.execute(
      `INSERT INTO gtd_tasks (id, title, notes, status, bucket, context_ids_json, source, project_id, planned_order, completed_at, created_at, updated_at) VALUES ${rows
        .map(
          (_, r) =>
            `($${r * 5 + 1}, $${r * 5 + 1}, '', $${r * 5 + 2}, 'planned', '[]', 'manual', 'big', $${r * 5 + 3}, $${r * 5 + 4}, $${r * 5 + 5}, $${r * 5 + 5})`,
        )
        .join(", ")}`,
      rows.flatMap((n) => [
        `t-${String(n).padStart(5, "0")}`,
        n < completed ? "completed" : "active",
        n < completed ? null : n - completed,
        n < completed ? T0 : null,
        T0,
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

const applyAndMeasure = async (total: number, completed: number) => {
  const sim = await createSyncHarness(["A", "B"]);
  const [a, b] = sim.devices as [SyncDevice, SyncDevice];
  await seedProject(a, total, completed);
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
});
