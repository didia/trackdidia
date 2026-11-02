// @vitest-environment node
import { describe, expect, it } from "vitest";
import { applyChunked } from "./apply-chunked";
import type { FinanceCategorySuggestion } from "../../domain/finance";
import type { AiProposal } from "../../domain/types";
import type { SyncChangeSet } from "./change-set";
import { planChangeSet } from "./split-change-set";
import {
  type Bundle,
  expectChunkedEqualsWhole,
  expectEveryPrefixValid,
  foreignKeyProblems,
} from "./test-support/chunk-equivalence";
import { financeAccount, importRequest, importRow } from "./test-support/finance-fixtures";
import { aiMessage } from "./test-support/personal-fixtures";
import { project } from "./test-support/random-ops";
import {
  createSyncHarness,
  dumpDomain,
  jsonRoundTrip,
  type SyncDevice,
} from "./test-support/two-device-harness";

/**
 * The two shapes the first review found where a chunk boundary changed the outcome: a task that
 * LEAVES a Planned queue (the queue is renumbered over the tasks of the call), and a pending
 * proposal or suggestion regenerated after the one it replaces was deleted (a tombstone carries no
 * message or transaction, so the splitter cannot group it; it keeps the apply order instead). Each
 * must fail on the splitter as it was (planned-only queue key, grouping by message).
 */

const ONE = { maxEntities: 1, maxUnionRows: 1, maxAliases: 1, maxSidecarRows: 1 };
const T0 = "2026-10-01T00:00:00.000Z";

const gtdBundle = async (device: SyncDevice): Promise<Bundle> => ({
  domain: "gtd",
  changeSet: jsonRoundTrip(await device.repo.listSyncChanges("gtd")),
});

const insertQueueTask = (device: SyncDevice, id: string, projectId: string, order: number) =>
  device.db.execute(
    "INSERT INTO gtd_tasks (id, title, notes, status, bucket, context_ids_json, source, project_id, planned_order, created_at, updated_at) VALUES ($1, $1, '', 'active', 'planned', '[]', 'manual', $2, $3, $4, $4)",
    [id, projectId, order, T0],
  );

const chunkIndexOf = (chunks: readonly SyncChangeSet[], table: string, id: string): number =>
  chunks.findIndex((chunk) =>
    chunk.entities.some((entity) => entity.table === table && entity.entityId === id),
  );

/** A holds c:0, m:1, z:2 in project P and every laptop has them. */
const queueWorld = async () => {
  const sim = await createSyncHarness(["A", "B", "T"]);
  const [a, b, t] = sim.devices as [SyncDevice, SyncDevice, SyncDevice];
  await a.repo.saveProject(project("P", "P"));
  await a.repo.saveProject(project("Q", "Q"));
  for (const [order, id] of ["c", "m", "z"].entries()) await insertQueueTask(a, id, "P", order);
  await a.stamp();
  await sim.syncAll("gtd");
  return { sim, a, b, t };
};

describe("a task that leaves the Planned queue (review repro A)", () => {
  it("is merged with the tasks that stay, so the renumbering matches the whole apply", async () => {
    const { b, t } = await queueWorld();
    // B moves m to Next Actions and the app renumbers z to 1.
    b.clock.advance(60_000);
    await b.repo.moveTask("m", "next_action", []);
    const rows = await b.db.select<{ id: string; planned_order: number | null }[]>(
      "SELECT id, planned_order FROM gtd_tasks WHERE id IN ('c','z') ORDER BY id",
    );
    expect(rows).toEqual([
      { id: "c", planned_order: 0 },
      { id: "z", planned_order: 1 },
    ]);
    const bundle = await gtdBundle(b);
    const plan = planChangeSet(bundle.changeSet, ONE);
    const where = ["c", "m", "z"].map((id) => chunkIndexOf(plan.chunks, "gtd_tasks", id));
    expect(new Set(where).size).toBe(1);
    await expectChunkedEqualsWhole(t, [bundle], ONE, "leaving the queue");
    await expectEveryPrefixValid(t, [bundle], ONE, "leaving the queue");
  });

  it("applies a completed or deleted task before the queue's remaining tasks", async () => {
    const { b, t } = await queueWorld();
    b.clock.advance(60_000);
    await b.repo.completeTask("m", "2026-10-02T12:00:00.000Z");
    await b.db.execute("UPDATE gtd_tasks SET planned_order = 1 WHERE id = 'z'");
    await b.stamp();
    const bundle = await gtdBundle(b);
    const plan = planChangeSet(bundle.changeSet, ONE);
    expect(chunkIndexOf(plan.chunks, "gtd_tasks", "m")).toBeLessThan(
      chunkIndexOf(plan.chunks, "gtd_tasks", "z"),
    );
    await expectChunkedEqualsWhole(t, [bundle], ONE, "completed leaver");
  });

  it("declares the residual: a move to ANOTHER project leaves a valid state that converges on exchange", async () => {
    const { sim, b, t } = await queueWorld();
    b.clock.advance(60_000);
    await b.db.execute(
      "UPDATE gtd_tasks SET bucket = 'next_action', planned_order = NULL, project_id = 'Q' WHERE id = 'm'",
    );
    await b.db.execute("UPDATE gtd_tasks SET planned_order = 1 WHERE id = 'z'");
    await b.stamp();
    const bundle = await gtdBundle(b);
    await applyChunked(t.repo, "gtd", bundle.changeSet, {
      limits: ONE,
      yieldBetweenChunks: async () => undefined,
    });
    // Valid whatever the order of the chunks was ...
    expect(await foreignKeyProblems(t)).toEqual([]);
    // ... and the laptops agree once they have exchanged.
    await sim.syncAll("gtd");
    await sim.expectConverged("gtd");
    const orders = await t.db.select<{ id: string; planned_order: number | null }[]>(
      "SELECT id, planned_order FROM gtd_tasks WHERE bucket = 'planned' ORDER BY planned_order",
    );
    expect(new Set(orders.map((row) => row.planned_order)).size).toBe(orders.length);
  });
});

const proposal = (id: string, status: AiProposal["status"], type = "commitment"): AiProposal => ({
  id,
  messageId: "msg-1",
  type: type as AiProposal["type"],
  payloadJson: "{}",
  status,
  appliedEntityId: null,
  decidedAt: status === "pending" ? null : "2026-10-04T13:00:00.000Z",
  createdAt: "2026-10-04T12:00:00.000Z",
});

describe("a pending proposal regenerated after the one it replaces was deleted (review repro B)", () => {
  it("keeps the apply order across chunks: decided rows, deletes, then pending rows", async () => {
    const sim = await createSyncHarness(["A", "T"]);
    const [a, t] = sim.devices as [SyncDevice, SyncDevice];
    await a.repo.saveAiMessage(aiMessage("msg-1"));
    await a.repo.saveAiProposal(proposal("pm", "pending"));
    await a.repo.saveAiProposal(proposal("pa", "dismissed"));
    await sim.syncAll("personal");
    // A clears the pending proposal and regenerates one of the same type.
    a.clock.advance(60_000);
    await a.db.execute("DELETE FROM ai_proposals WHERE id = 'pm'");
    await a.stamp();
    await a.repo.saveAiProposal(proposal("pb", "pending"));
    const bundle: Bundle = {
      domain: "personal",
      changeSet: jsonRoundTrip(await a.repo.listSyncChanges("personal")),
    };
    const ids = bundle.changeSet.entities.filter((e) => e.table === "ai_proposals");
    expect(ids.map((e) => [e.entityId, e.row === null])).toEqual(
      expect.arrayContaining([["pm", true]]),
    );
    const plan = planChangeSet(bundle.changeSet, ONE);
    const at = (id: string) => chunkIndexOf(plan.chunks, "ai_proposals", id);
    expect(at("pa")).toBeLessThan(at("pm"));
    expect(at("pm")).toBeLessThan(at("pb"));
    await expectChunkedEqualsWhole(t, [bundle], ONE, "regenerated proposal");
    await expectEveryPrefixValid(t, [bundle], ONE, "regenerated proposal");
    // The outcome both ways: pm is gone, pb is the pending one, and no collision was logged.
    await t.repo.applySyncBundle("personal", bundle.changeSet);
    const dump = await dumpDomain(t, "personal");
    expect(dump.tables.ai_proposals?.map((row) => [row.id, row.status])).toEqual([
      ["pa", "dismissed"],
      ["pb", "pending"],
    ]);
    expect(
      await t.db.select("SELECT id FROM sync_conflicts WHERE kind = 'pending_collision'"),
    ).toEqual([]);
  });

  it("does the same for category suggestions (one pending per transaction)", async () => {
    const sim = await createSyncHarness(["A", "T"]);
    const [a, t] = sim.devices as [SyncDevice, SyncDevice];
    await a.repo.seedFinanceDefaultCategories();
    await a.repo.saveFinanceAccount(financeAccount());
    await a.repo.importFinanceTransactions(
      importRequest([importRow({ descriptionRaw: "ONE", merchantKey: "ONE", amountMinor: -10 })], {
        fileHash: "s",
      }),
    );
    const txId = (await a.repo.listFinanceTransactions({}))[0]?.id as string;
    const suggestion = (id: string, status: FinanceCategorySuggestion["status"]) =>
      ({
        id,
        transactionId: txId,
        merchantKey: "ONE",
        suggestedCategoryId: "fincat:transport",
        confidence: 0.6,
        origin: "ai",
        rationale: null,
        model: null,
        promptVersion: null,
        status,
        decidedAt: status === "pending" ? null : "2026-10-04T13:00:00.000Z",
        createdAt: T0,
      }) as FinanceCategorySuggestion;
    await a.repo.saveFinanceCategorySuggestions([suggestion("sm", "pending")]);
    await sim.syncAll("finance");
    a.clock.advance(60_000);
    await a.db.execute("DELETE FROM finance_category_suggestions WHERE id = 'sm'");
    await a.stamp();
    await a.repo.saveFinanceCategorySuggestions([suggestion("sa", "pending")]);
    const bundle: Bundle = {
      domain: "finance",
      changeSet: jsonRoundTrip(await a.repo.listSyncChanges("finance")),
    };
    const plan = planChangeSet(bundle.changeSet, ONE);
    const at = (id: string) => chunkIndexOf(plan.chunks, "finance_category_suggestions", id);
    expect(at("sm")).toBeGreaterThanOrEqual(0);
    expect(at("sm")).toBeLessThan(at("sa"));
    await expectChunkedEqualsWhole(t, [bundle], ONE, "regenerated suggestion");
  });
});
