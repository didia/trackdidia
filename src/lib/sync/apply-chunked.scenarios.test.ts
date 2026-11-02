// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { AiProposal } from "../../domain/types";
import type { SyncChangeSet } from "./change-set";
import { SYNC_DOMAINS, type SyncDomain } from "./registry";
import { planChangeSet } from "./split-change-set";
import {
  type Bundle,
  expectChunkedEqualsWhole,
  expectEveryPrefixValid,
} from "./test-support/chunk-equivalence";
import { financeAccount, importRequest, importRow, splitOf } from "./test-support/finance-fixtures";
import { aiMessage, weeklyObjective } from "./test-support/personal-fixtures";
import { project, template as recurringTemplate } from "./test-support/random-ops";
import {
  createSyncHarness,
  jsonRoundTrip,
  type SyncDevice,
  type SyncHarness,
} from "./test-support/two-device-harness";

/**
 * The constructs whose merge looks at more than one entity of a bundle, each built deliberately and
 * applied whole and chunked (one entity per chunk) from clones of the same target. The randomized
 * test (`apply-chunked.equivalence.test.ts`) reaches most of them only rarely.
 */

const ONE = { maxEntities: 1, maxUnionRows: 1, maxAliases: 1, maxSidecarRows: 1 };

const bundleOf = async (
  device: SyncDevice,
  domains: readonly SyncDomain[] = SYNC_DOMAINS,
): Promise<Bundle[]> => {
  const bundles: Bundle[] = [];
  for (const domain of domains) {
    bundles.push({ domain, changeSet: jsonRoundTrip(await device.repo.listSyncChanges(domain)) });
  }
  return bundles;
};

const settle = async (sim: SyncHarness) => {
  for (const domain of SYNC_DOMAINS) await sim.syncAll(domain);
};

const chunkIndexOf = (chunks: readonly SyncChangeSet[], table: string, entityId: string): number =>
  chunks.findIndex((chunk) =>
    chunk.entities.some((entity) => entity.table === table && entity.entityId === entityId),
  );

const check = async (target: SyncDevice, bundles: Bundle[], label: string) => {
  const report = await expectChunkedEqualsWhole(target, bundles, ONE, label);
  await expectEveryPrefixValid(target, bundles, ONE, label);
  return report;
};

describe("cascade parents", () => {
  it("keeps a deleted objective with its results, and an orphaned edit from another laptop", async () => {
    const sim = await createSyncHarness(["A", "B", "T"]);
    const [a, b, t] = sim.devices as [SyncDevice, SyncDevice, SyncDevice];
    await a.repo.saveWeeklyObjective(weeklyObjective("obj-doomed", "Doomed"));
    for (const week of ["2026-10-04", "2026-10-11"]) {
      await a.repo.saveWeeklyObjectiveResult({
        weekStartDate: week,
        objectiveId: "obj-doomed",
        achieved: true,
        updatedAt: "",
      });
    }
    await settle(sim);
    // B edits a result AFTER A deletes the objective: the edit is the later event, the parent is gone.
    a.clock.advance(60_000);
    await a.repo.deleteWeeklyObjective("obj-doomed");
    b.clock.advance(120_000);
    await b.repo.saveWeeklyObjectiveResult({
      weekStartDate: "2026-10-04",
      objectiveId: "obj-doomed",
      achieved: false,
      updatedAt: "",
    });
    const bundles = [...(await bundleOf(a, ["personal"])), ...(await bundleOf(b, ["personal"]))];

    // The tombstone of the parent and its children are one group, hence one chunk.
    const plan = planChangeSet((bundles[0] as Bundle).changeSet, ONE);
    const parent = chunkIndexOf(plan.chunks, "weekly_objectives", "obj-doomed");
    expect(parent).toBeGreaterThanOrEqual(0);
    const children = (bundles[0] as Bundle).changeSet.entities
      .filter((entity) => entity.table === "weekly_objective_results")
      .filter((entity) => entity.entityId.includes("obj-doomed"));
    expect(children.length).toBeGreaterThan(0);
    for (const child of children) {
      expect(chunkIndexOf(plan.chunks, child.table, child.entityId)).toBe(parent);
    }
    const report = await check(t, bundles, "cascade");
    expect(report.tombstones).toBeGreaterThan(0);
  });
});

describe("proposals and their messages", () => {
  it("lands a message (a union row) before its proposals, and keeps one pending per key", async () => {
    const sim = await createSyncHarness(["A", "B"]);
    const [a, b] = sim.devices as [SyncDevice, SyncDevice];
    // Two messages and one union row per chunk: the proposals' message is the LAST union row.
    for (const device of [a, b]) {
      await device.repo.saveAiMessage(aiMessage("msg-1"));
      await device.repo.saveAiMessage(aiMessage("msg-new"));
    }
    const proposal = (id: string): AiProposal => ({
      id,
      messageId: "msg-new",
      type: "commitment",
      payloadJson: "{}",
      status: "pending",
      appliedEntityId: null,
      decidedAt: null,
      createdAt: "2026-10-04T12:00:00.000Z",
    });
    await a.repo.saveAiProposal(proposal("p-a"));
    await b.repo.saveAiProposal(proposal("p-b"));
    const bundles = [...(await bundleOf(a, ["personal"])), ...(await bundleOf(b, ["personal"]))];
    // A fresh laptop knows neither the message nor the proposals: a proposal landing before its
    // message would be skipped as an orphan.
    const fresh = (await createSyncHarness(1, { deviceIndexOffset: 20 })).devices[0] as SyncDevice;
    const plan = planChangeSet((bundles[0] as Bundle).changeSet, ONE);
    const messageChunk = plan.chunks.findIndex((chunk) =>
      (chunk.unionRows.ai_messages ?? []).some((row) => row.id === "msg-new"),
    );
    const proposalChunk = chunkIndexOf(plan.chunks, "ai_proposals", "p-a");
    expect(messageChunk).toBeGreaterThanOrEqual(0);
    expect(proposalChunk).toBeGreaterThanOrEqual(messageChunk);
    await check(fresh, bundles, "proposals");
  });
});

describe("canonical identity", () => {
  it("applies aliases first, and merges colliding transactions across chunks", async () => {
    const sim = await createSyncHarness(["A", "B", "T"]);
    const [a, b, t] = sim.devices as [SyncDevice, SyncDevice, SyncDevice];
    for (const device of [a, b, t]) await device.repo.saveFinanceAccount(financeAccount());
    await settle(sim);
    const rows = Array.from({ length: 6 }, (_, index) =>
      importRow({
        amountMinor: -(500 + index),
        descriptionRaw: `SHARED ${index}`,
        merchantKey: "SHARED",
        postedDate: "2026-04-02",
      }),
    );
    // The same statement imported on every laptop: different ids, one natural key.
    for (const device of [a, b, t]) {
      device.clock.advance(1_000);
      await device.repo.importFinanceTransactions(importRequest(rows, { fileHash: "same-file" }));
    }
    // B learns A's copies as aliases, so its bundle carries aliases.
    await sim.exchange(a, b, "finance");
    await b.repo.importFinanceTransactions(
      importRequest([importRow({ descriptionRaw: "ONLY B", merchantKey: "B", amountMinor: -9 })], {
        fileHash: "b-only",
      }),
    );
    const bundles = [...(await bundleOf(a, ["finance"])), ...(await bundleOf(b, ["finance"]))];
    expect(bundles.some((bundle) => bundle.changeSet.aliases.length > 0)).toBe(true);

    const plan = planChangeSet((bundles[1] as Bundle).changeSet, ONE);
    const firstAliasChunk = plan.chunks.findIndex((chunk) => chunk.aliases.length > 0);
    const firstEntityChunk = plan.chunks.findIndex((chunk) => chunk.entities.length > 0);
    expect(firstAliasChunk).toBe(0);
    expect(firstEntityChunk).toBeGreaterThan(firstAliasChunk);
    const report = await check(t, bundles, "aliases");
    expect(report.aliases).toBeGreaterThan(0);
    expect(report.splitBundles).toBeGreaterThan(0);
  });

  it("keeps two rows that share a natural key in one chunk", async () => {
    const sim = await createSyncHarness(["A", "B"]);
    const [a, b] = sim.devices as [SyncDevice, SyncDevice];
    for (const device of [a, b]) await device.repo.saveFinanceAccount(financeAccount());
    await settle(sim);
    const row = importRow({ descriptionRaw: "TWIN", merchantKey: "TWIN", amountMinor: -77 });
    for (const device of [a, b]) {
      await device.repo.importFinanceTransactions(importRequest([row], { fileHash: "twin" }));
    }
    // Both copies in ONE bundle: B holds its own and A's through a raw merge of the rows.
    await sim.exchange(a, b, "finance");
    const bundle = (await bundleOf(b, ["finance"]))[0] as Bundle;
    const twins = bundle.changeSet.entities.filter(
      (entity) => entity.table === "finance_transactions" && entity.row?.merchant_key === "TWIN",
    );
    expect(twins.length).toBeGreaterThanOrEqual(1);
    const plan = planChangeSet(bundle.changeSet, ONE);
    const groups = new Set(
      twins.map((entity) => chunkIndexOf(plan.chunks, entity.table, entity.entityId)),
    );
    expect(groups.size).toBe(1);
  });
});

describe("finance units", () => {
  it("keeps a transaction with its splits and applies a categorize-versus-split race identically", async () => {
    const sim = await createSyncHarness(["A", "B", "T"]);
    const [a, b, t] = sim.devices as [SyncDevice, SyncDevice, SyncDevice];
    await a.repo.seedFinanceDefaultCategories();
    await a.repo.saveFinanceAccount(financeAccount());
    await a.repo.importFinanceTransactions(
      importRequest(
        [1, 2, 3].map((n) =>
          importRow({
            amountMinor: -(1000 * n),
            descriptionRaw: `LINE ${n}`,
            merchantKey: `L${n}`,
          }),
        ),
        { fileHash: "units" },
      ),
    );
    await settle(sim);
    const transactions = (await a.repo.listFinanceTransactions({})).sort((x, y) =>
      x.id < y.id ? -1 : 1,
    );
    const ids = transactions.map((txn) => txn.id);
    const amountOf = (index: number) => transactions[index]?.amountMinor as number;
    a.clock.advance(10_000);
    await a.repo.saveFinanceTransactionSplits(ids[0] as string, [
      splitOf(
        ids[0] as string,
        amountOf(0) - Math.trunc(amountOf(0) / 2),
        "fincat:logement",
        "split-a1",
      ),
      splitOf(ids[0] as string, Math.trunc(amountOf(0) / 2), "fincat:transport", "split-a2"),
    ]);
    b.clock.advance(20_000);
    await b.repo.saveFinanceTransactionSplits(ids[0] as string, [
      splitOf(ids[0] as string, amountOf(0), "fincat:transport", "split-b1"),
    ]);
    await b.repo.saveFinanceTransactionSplits(ids[1] as string, [
      splitOf(
        ids[1] as string,
        amountOf(1) - Math.trunc(amountOf(1) / 4),
        "fincat:logement",
        "split-b2",
      ),
      splitOf(ids[1] as string, Math.trunc(amountOf(1) / 4), "fincat:transport", "split-b3"),
    ]);
    const bundles = [...(await bundleOf(a, ["finance"])), ...(await bundleOf(b, ["finance"]))];
    const plan = planChangeSet((bundles[0] as Bundle).changeSet, ONE);
    const tx = chunkIndexOf(plan.chunks, "finance_transactions", ids[0] as string);
    expect(chunkIndexOf(plan.chunks, "finance_transaction_splits", "split-a1")).toBe(tx);
    expect(chunkIndexOf(plan.chunks, "finance_transaction_splits", "split-a2")).toBe(tx);
    await check(t, bundles, "units");
  });
});

describe("recurring templates and the Planned queue", () => {
  it("keeps a template with its instance and occurrences, and a project's planned tasks together", async () => {
    const sim = await createSyncHarness(["A", "B", "T"]);
    const [a, b, t] = sim.devices as [SyncDevice, SyncDevice, SyncDevice];
    await a.repo.saveProject(project("p1", "P1"));
    await a.repo.saveRecurringTaskTemplate(recurringTemplate("recurring-template:daily", {}));
    await a.repo.generateDueRecurringTasks("2026-10-05");
    for (const id of ["q1", "q2", "q3"]) {
      await a.repo.createTask({ id, title: id, bucket: "planned", projectId: "p1" });
    }
    await settle(sim);
    // Diverge: both laptops add to the queue and act on the instance.
    a.clock.advance(60_000);
    b.clock.advance(60_000);
    await a.repo.createTask({ id: "q4a", title: "q4a", bucket: "planned", projectId: "p1" });
    await b.repo.createTask({ id: "q4b", title: "q4b", bucket: "planned", projectId: "p1" });
    const instance = (await b.repo.listTasks({})).find((task) => task.isRecurringInstance);
    expect(instance).toBeDefined();
    await b.repo.completeTask(
      (instance as NonNullable<typeof instance>).id,
      `${(instance as NonNullable<typeof instance>).recurrenceDueDate ?? "2026-10-05"}T12:00:00.000Z`,
    );
    await a.repo.generateDueRecurringTasks("2026-10-07");
    const bundles = [...(await bundleOf(a, ["gtd"])), ...(await bundleOf(b, ["gtd"]))];

    const plan = planChangeSet((bundles[1] as Bundle).changeSet, ONE);
    const template = chunkIndexOf(
      plan.chunks,
      "recurring_task_templates",
      "recurring-template:daily",
    );
    const instanceChunk = chunkIndexOf(
      plan.chunks,
      "gtd_tasks",
      "recurring-task:recurring-template:daily",
    );
    expect(template).toBeGreaterThanOrEqual(0);
    expect(instanceChunk).toBe(template);
    expect(
      plan.chunks[template]?.recurrence.occurrences.some(
        (occurrence) => occurrence.template_id === "recurring-template:daily",
      ),
    ).toBe(true);
    // The planned tasks of one project share a chunk.
    const planned = (bundles[1] as Bundle).changeSet.entities.filter(
      (entity) =>
        entity.table === "gtd_tasks" &&
        entity.row?.bucket === "planned" &&
        entity.row?.project_id === "p1",
    );
    expect(planned.length).toBeGreaterThanOrEqual(3);
    const queue = new Set(
      planned.map((entity) => chunkIndexOf(plan.chunks, entity.table, entity.entityId)),
    );
    expect(queue.size).toBe(1);
    await check(t, bundles, "gtd group");
  });
});

describe("Pomodoro", () => {
  it("keeps a terminal session with its segments", async () => {
    const sim = await createSyncHarness(["A", "B", "T"]);
    const [a, b, t] = sim.devices as [SyncDevice, SyncDevice, SyncDevice];
    await a.repo.createTask({ id: "t1", title: "Plan", bucket: "next_action" });
    await settle(sim);
    for (const device of [a, b]) {
      const started = await device.repo.startPomodoro({ kind: "focus", taskId: "t1" });
      device.clock.advance(1_000);
      await device.repo.stopPomodoroSession(started.activeSession?.id as string, "completed");
    }
    const bundles = [...(await bundleOf(a, ["gtd"])), ...(await bundleOf(b, ["gtd"]))];
    const session = (bundles[0] as Bundle).changeSet.entities.find(
      (entity) => entity.table === "pomodoro_sessions",
    );
    expect(session).toBeDefined();
    const plan = planChangeSet((bundles[0] as Bundle).changeSet, ONE);
    const sessionChunk = chunkIndexOf(
      plan.chunks,
      "pomodoro_sessions",
      session?.entityId as string,
    );
    const segments = (bundles[0] as Bundle).changeSet.entities.filter(
      (entity) => entity.table === "pomodoro_segments",
    );
    expect(segments.length).toBeGreaterThan(0);
    for (const segment of segments) {
      expect(chunkIndexOf(plan.chunks, segment.table, segment.entityId)).toBe(sessionChunk);
    }
    await check(t, bundles, "pomodoro");
  });
});
