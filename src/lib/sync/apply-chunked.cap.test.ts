// @vitest-environment node
import { describe, expect, it } from "vitest";
import { applyChunked } from "./apply-chunked";
import type { SyncChangeSet, SyncEntity } from "./change-set";
import { planChangeSet } from "./split-change-set";
import {
  type Bundle,
  expectChunkedEqualsWhole,
  expectEveryPrefixValid,
} from "./test-support/chunk-equivalence";
import { financeAccount, importRequest, importRow, splitOf } from "./test-support/finance-fixtures";
import { weeklyObjective } from "./test-support/personal-fixtures";
import {
  createSyncHarness,
  jsonRoundTrip,
  type SyncDevice,
} from "./test-support/two-device-harness";

/**
 * The group cap (`maxGroupEntities`) may only cut away tasks that are tied to their group by their
 * project's queue. Cutting a transaction from its splits, an objective from its results or a session
 * from its segments is not an optimisation, it is data loss or a rejected bundle: the children sort
 * BEFORE the parent id, an unknown parent skips them (`replaceChildren` then deletes the local
 * splits) and a segment of an unknown session fails the whole bundle with `row_filter_violation`.
 * These tests use a cap of 1, so any group of two or more is "oversized".
 */

const CAP_ONE = {
  maxEntities: 1,
  maxUnionRows: 1,
  maxAliases: 1,
  maxSidecarRows: 1,
  maxGroupEntities: 1,
};

const bundleOf = async (
  device: SyncDevice,
  domain: "gtd" | "personal" | "finance",
): Promise<Bundle> => ({
  domain,
  changeSet: jsonRoundTrip(await device.repo.listSyncChanges(domain)),
});

const chunkOf = (chunks: readonly SyncChangeSet[], table: string, id: string): number =>
  chunks.findIndex((chunk) =>
    chunk.entities.some((entity) => entity.table === table && entity.entityId === id),
  );

/** A fresh laptop that applies the bundle in chunks of the tiny cap, as the engine would. */
const applyToFresh = async (bundle: Bundle) => {
  const fresh = (await createSyncHarness(1, { deviceIndexOffset: 30 })).devices[0] as SyncDevice;
  await applyChunked(fresh.repo, bundle.domain, bundle.changeSet, {
    limits: CAP_ONE,
    yieldBetweenChunks: async () => undefined,
  });
  return fresh;
};

describe("groups whose children are not applicable on their own are never cut", () => {
  it("a transaction keeps its three splits", async () => {
    const sim = await createSyncHarness(["A"]);
    const a = sim.devices[0] as SyncDevice;
    await a.repo.seedFinanceDefaultCategories();
    await a.repo.saveFinanceAccount(financeAccount());
    await a.repo.importFinanceTransactions(
      importRequest(
        [importRow({ amountMinor: -3000, descriptionRaw: "BIG", merchantKey: "BIG" })],
        {
          fileHash: "cap",
        },
      ),
    );
    const id = (await a.repo.listFinanceTransactions({}))[0]?.id as string;
    await a.repo.saveFinanceTransactionSplits(id, [
      splitOf(id, -1000, "fincat:logement", "sp-1"),
      splitOf(id, -1000, "fincat:transport", "sp-2"),
      splitOf(id, -1000, "fincat:logement", "sp-3"),
    ]);
    const bundle = await bundleOf(a, "finance");
    const plan = planChangeSet(bundle.changeSet, CAP_ONE);
    const where = ["sp-1", "sp-2", "sp-3"].map((split) =>
      chunkOf(plan.chunks, "finance_transaction_splits", split),
    );
    expect(new Set([...where, chunkOf(plan.chunks, "finance_transactions", id)]).size).toBe(1);
    const fresh = await applyToFresh(bundle);
    expect(
      await fresh.db.select("SELECT id FROM finance_transaction_splits WHERE transaction_id = $1", [
        id,
      ]),
    ).toHaveLength(3);
    // And from a laptop that already holds the splits (the loss was permanent and republished).
    const sim2 = await createSyncHarness(["A2", "T"], { deviceIndexOffset: 40 });
    const t = sim2.devices[1] as SyncDevice;
    await expectChunkedEqualsWhole(t, [bundle], CAP_ONE, "transaction splits");
  });

  it("an objective keeps its three results on a fresh laptop", async () => {
    const sim = await createSyncHarness(["A"]);
    const a = sim.devices[0] as SyncDevice;
    await a.repo.saveWeeklyObjective(weeklyObjective("obj-cap", "Cap"));
    for (const week of ["2026-10-04", "2026-10-11", "2026-10-18"]) {
      await a.repo.saveWeeklyObjectiveResult({
        weekStartDate: week,
        objectiveId: "obj-cap",
        achieved: true,
        updatedAt: "",
      });
    }
    const bundle = await bundleOf(a, "personal");
    const plan = planChangeSet(bundle.changeSet, CAP_ONE);
    const results = bundle.changeSet.entities.filter(
      (entity) =>
        entity.table === "weekly_objective_results" && entity.entityId.includes("obj-cap"),
    );
    expect(results).toHaveLength(3);
    const parent = chunkOf(plan.chunks, "weekly_objectives", "obj-cap");
    for (const result of results) {
      expect(chunkOf(plan.chunks, result.table, result.entityId)).toBe(parent);
    }
    const fresh = await applyToFresh(bundle);
    expect(
      await fresh.db.select(
        "SELECT 1 FROM weekly_objective_results WHERE objective_id = 'obj-cap'",
      ),
    ).toHaveLength(3);
  });

  it("a session is not cut from its segments (that would reject the bundle)", async () => {
    const sim = await createSyncHarness(["A"]);
    const a = sim.devices[0] as SyncDevice;
    await a.repo.createTask({ id: "t1", title: "Plan", bucket: "next_action" });
    const started = await a.repo.startPomodoro({ kind: "focus", taskId: "t1" });
    const sessionId = started.activeSession?.id as string;
    for (let i = 0; i < 2; i += 1) {
      a.clock.advance(1_000);
      await a.repo.pausePomodoroSession(sessionId);
      a.clock.advance(1_000);
      await a.repo.resumePomodoroSession(sessionId);
    }
    a.clock.advance(1_000);
    await a.repo.stopPomodoroSession(sessionId, "completed");
    const bundle = await bundleOf(a, "gtd");
    const segments = bundle.changeSet.entities.filter(
      (entity) => entity.table === "pomodoro_segments",
    );
    expect(segments.length).toBeGreaterThanOrEqual(3);
    const plan = planChangeSet(bundle.changeSet, CAP_ONE);
    const session = chunkOf(plan.chunks, "pomodoro_sessions", sessionId);
    for (const segment of segments) {
      expect(chunkOf(plan.chunks, segment.table, segment.entityId)).toBe(session);
    }
    // Throws row_filter_violation if a segment is applied before its session.
    const fresh = await applyToFresh(bundle);
    expect(await fresh.db.select("SELECT 1 FROM pomodoro_segments")).toHaveLength(segments.length);
  });
});

const task = (id: string, row: Record<string, unknown>): SyncEntity => ({
  table: "gtd_tasks",
  entityId: id,
  row: {
    id,
    title: id,
    status: "active",
    bucket: "planned",
    project_id: "P",
    planned_order: 0,
    ...row,
  },
  fieldClocks: {},
  rowHlc: "0000000000001-0000-dev:00000000-0000-4000-8000-000000000001",
  deletedAt: null,
});

const template = (id: string): SyncEntity => ({
  table: "recurring_task_templates",
  entityId: id,
  row: { id, title: id },
  fieldClocks: {},
  rowHlc: "0000000000001-0000-dev:00000000-0000-4000-8000-000000000001",
  deletedAt: null,
});

const changeSetOf = (entities: SyncEntity[], occurrences = 0): SyncChangeSet => ({
  formatVersion: 1,
  deviceId: "dev:00000000-0000-4000-8000-000000000001",
  domain: "gtd",
  schemaVersion: 45,
  hlcHigh: "0000000000009-0000-dev:00000000-0000-4000-8000-000000000001",
  entities,
  unionRows: {},
  settings: [],
  recurrence: {
    occurrences: Array.from({ length: occurrences }, (_, index) => ({
      template_id: "tpl",
      due_date: `2026-10-${String(index + 1).padStart(2, "0")}`,
      outcome: "active" as const,
      outcome_hlc: "0000000000001-0000-dev:00000000-0000-4000-8000-000000000001",
      device_id: "dev:00000000-0000-4000-8000-000000000001",
    })),
    clears: [],
  },
  aliases: [],
});

describe("what the cap does cut", () => {
  it("cuts a project's queue into slices, and keeps a template, its instance and its sidecars in the LAST slice", () => {
    const queue = ["q1", "q2", "q3", "q4", "q5"].map((id, order) =>
      task(id, { planned_order: order }),
    );
    // The instance sits in the same project's queue AND belongs to the template: tied, not detachable.
    const instance = task("recurring-task:tpl", {
      is_recurring_instance: 1,
      recurring_template_id: "tpl",
      planned_order: 9,
    });
    const set = changeSetOf([...queue, instance, template("tpl")], 3);
    const plan = planChangeSet(set, { maxEntities: 2, maxGroupEntities: 2, maxSidecarRows: 10 });
    expect(plan.cutGroups).toBe(1);
    const last = plan.chunks.length - 1;
    // Tasks of the queue come first, in slices of at most two; the core is last, with its sidecars.
    for (const id of ["q1", "q2", "q3", "q4", "q5"]) {
      expect(chunkOf(plan.chunks, "gtd_tasks", id)).toBeLessThan(last);
    }
    expect(chunkOf(plan.chunks, "gtd_tasks", "recurring-task:tpl")).toBe(last);
    expect(chunkOf(plan.chunks, "recurring_task_templates", "tpl")).toBe(last);
    expect(plan.chunks[last]?.recurrence.occurrences).toHaveLength(3);
    for (const chunk of plan.chunks.slice(0, last)) {
      expect(chunk.recurrence.occurrences).toHaveLength(0);
      expect(chunk.entities.length).toBeLessThanOrEqual(2);
    }
  });

  it("never cuts entities of a group with no detachable member, whatever the cap", () => {
    const tied = [
      task("a", {
        source_external_id: "ext",
        planned_order: 0,
        bucket: "next_action",
        project_id: null,
      }),
      task("b", {
        source_external_id: "ext",
        planned_order: 1,
        bucket: "next_action",
        project_id: null,
      }),
      task("c", {
        source_external_id: "ext",
        planned_order: 2,
        bucket: "next_action",
        project_id: null,
      }),
    ];
    const plan = planChangeSet(changeSetOf(tied), { maxEntities: 1, maxGroupEntities: 1 });
    expect(plan.cutGroups).toBe(0);
    expect(new Set(["a", "b", "c"].map((id) => chunkOf(plan.chunks, "gtd_tasks", id))).size).toBe(
      1,
    );
  });
});

describe("leavers go first, including those in natural-key and template groups", () => {
  it("applies a completed instance of a template before the queue's remaining tasks", () => {
    const set = changeSetOf([
      task("c", { planned_order: 0 }),
      task("z", { planned_order: 1 }),
      task("recurring-task:tpl", {
        status: "completed",
        is_recurring_instance: 1,
        recurring_template_id: "tpl",
      }),
      template("tpl"),
    ]);
    const plan = planChangeSet(set, { maxEntities: 1, maxGroupEntities: 1500 });
    expect(chunkOf(plan.chunks, "gtd_tasks", "recurring-task:tpl")).toBeLessThan(
      chunkOf(plan.chunks, "gtd_tasks", "z"),
    );
  });

  it("applies a completed task with an external id before the queue, and matches the whole apply", async () => {
    const sim = await createSyncHarness(["A", "B", "T"]);
    const [a, b, t] = sim.devices as [SyncDevice, SyncDevice, SyncDevice];
    await a.repo.saveProject({
      id: "P",
      title: "P",
      status: "active",
      statusChangedAt: "2026-10-01T00:00:00.000Z",
      notes: "",
      contextIds: [],
      source: "manual",
      sourceExternalId: null,
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    });
    for (const [order, id] of ["c", "z", "zm"].entries()) {
      await a.db.execute(
        "INSERT INTO gtd_tasks (id, title, notes, status, bucket, context_ids_json, source, source_external_id, project_id, planned_order, created_at, updated_at) VALUES ($1, $1, '', 'active', 'planned', '[]', 'manual', $2, 'P', $3, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')",
        [id, id === "zm" ? "ext-1" : null, order],
      );
    }
    await a.stamp();
    await sim.syncAll("gtd");
    // B completes zm (it leaves the queue) and the queue is renumbered: z moves to 2.
    b.clock.advance(60_000);
    await b.repo.completeTask("zm", "2026-10-02T12:00:00.000Z");
    await b.db.execute("UPDATE gtd_tasks SET planned_order = 2 WHERE id = 'z'");
    await b.stamp();
    const bundle = await bundleOf(b, "gtd");
    const plan = planChangeSet(bundle.changeSet, CAP_ONE);
    expect(chunkOf(plan.chunks, "gtd_tasks", "zm")).toBeLessThan(
      chunkOf(plan.chunks, "gtd_tasks", "z"),
    );
    await expectChunkedEqualsWhole(t, [bundle], CAP_ONE, "external id leaver");
    await expectEveryPrefixValid(t, [bundle], CAP_ONE, "external id leaver");
  });
});
