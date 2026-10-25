// @vitest-environment node
import { describe, expect, it } from "vitest";
import { clocksOf, readMetaOf } from "./capture-test-utils";
import {
  financeAccount,
  financeRule,
  importRequest,
  importRow,
  splitOf,
  transactionByAmount,
  unitStateOf,
} from "./test-support/finance-fixtures";
import {
  createSyncHarness,
  readConflicts,
  type SyncDevice,
} from "./test-support/two-device-harness";

/**
 * The finance categorization unit through the real repository and finance-store methods of
 * simulated laptops (foreign keys on): the examples of the spec's "Finance categorization unit",
 * split children replaced as a set, and the independence of the unit from the other columns.
 */

const START = "fincat:non-categorise";

const twoLaptops = async () => {
  const sim = await createSyncHarness(["A", "B"]);
  const a = sim.device("A");
  const b = sim.device("B");
  await a.repo.saveFinanceAccount(financeAccount());
  await a.repo.importFinanceTransactions(
    importRequest([
      importRow({ amountMinor: -1000, descriptionRaw: "ALPHA 1", merchantKey: "ALPHA" }),
      importRow({ amountMinor: -2000, descriptionRaw: "BRAVO 2", merchantKey: "BRAVO" }),
    ]),
  );
  await sim.syncAll("finance");
  const alpha = await transactionByAmount(a, -1000);
  const bravo = await transactionByAmount(a, -2000);
  return { sim, a, b, alpha, bravo };
};

const categoryEvents = async (device: SyncDevice) =>
  (await readConflicts(device)).filter(
    (row) => row.kind === "overwritten_edit" && String(row.local_json).includes('"categorization"'),
  );

describe("finance categorization unit: causal order", () => {
  it("B categorizes with splits, A removes the final split: A's reset wins and B's old children are not restored", async () => {
    const { sim, a, b, alpha } = await twoLaptops();
    b.clock.advance(1_000);
    await b.repo.saveFinanceTransactionSplits(alpha.id, [
      splitOf(alpha.id, -600, "fincat:alimentation.epicerie"),
      splitOf(alpha.id, -400, "fincat:alimentation.restaurants"),
    ]);
    await sim.exchange(b, a, "finance");
    expect((await unitStateOf(a, alpha.id)).splitIds).toHaveLength(2);

    a.clock.advance(60_000);
    await a.repo.saveFinanceTransactionSplits(alpha.id, []);
    const afterReset = await unitStateOf(a, alpha.id);
    expect(afterReset).toMatchObject({ categoryId: START, source: "default", hasSplits: false });
    expect(afterReset.splitIds).toEqual([]);

    // B republishes an unrelated edit (still holding its old unit and its two children).
    b.clock.advance(120_000);
    await b.repo.bulkUpdateFinanceTransactions([alpha.id], { excludedFromReports: true });
    await sim.syncAll("finance");

    for (const device of [a, b]) {
      expect(await unitStateOf(device, alpha.id)).toEqual({
        categoryId: START,
        source: "default",
        hasSplits: false,
        splitIds: [],
      });
      // The unrelated edit still merged by the row clock.
      expect((await device.repo.getFinanceTransaction(alpha.id))?.excludedFromReports).toBe(true);
      expect(await device.db.select("SELECT * FROM finance_transaction_splits")).toEqual([]);
      expect(await categoryEvents(device)).toEqual([]);
    }
    await sim.expectConverged("finance", { snapshots: true, exact: true });
  });

  it("a peer republishing an unchanged row loses to any later write", async () => {
    const { sim, a, b, alpha } = await twoLaptops();
    a.clock.advance(1_000);
    await a.repo.setFinanceTransactionCategory({
      transactionId: alpha.id,
      categoryId: "fincat:logement",
      scope: "this",
    });
    await sim.exchange(a, b, "finance");
    // A re-categorizes again; B, which has not heard of it, then edits an unrelated flag LATER
    // and republishes the row with the old categorization it received.
    a.clock.advance(300_000);
    await a.repo.setFinanceTransactionCategory({
      transactionId: alpha.id,
      categoryId: "fincat:transport",
      scope: "this",
    });
    b.clock.advance(900_000);
    await b.repo.bulkUpdateFinanceTransactions([alpha.id], { excludedFromBudget: true });
    await sim.syncAll("finance");
    for (const device of [a, b]) {
      // B's row is the later write (its flag wins), but its old unit loses to A's newer one.
      expect((await unitStateOf(device, alpha.id)).categoryId).toBe("fincat:transport");
      expect((await device.repo.getFinanceTransaction(alpha.id))?.excludedFromBudget).toBe(true);
    }
    await sim.expectConverged("finance", { snapshots: true, exact: true });
  });
});

describe("finance categorization unit: concurrent writes", () => {
  it("a user choice beats a LATER concurrent automatic stage, on both laptops", async () => {
    const { sim, a, b, alpha } = await twoLaptops();
    a.clock.advance(1_000);
    await a.repo.setFinanceTransactionCategory({
      transactionId: alpha.id,
      categoryId: "fincat:logement",
      scope: "this",
    });
    // B, meanwhile and later, gets a rule and re-runs the automatic stages.
    b.clock.advance(600_000);
    await b.repo.saveFinanceRule(
      financeRule("rule-1", {
        matcher: { descriptionContains: "ALPHA" },
        actions: { categoryId: "fincat:transport" },
      }),
    );
    await b.repo.reclassifyFinancePending();
    expect((await unitStateOf(b, alpha.id)).source).toBe("rule");

    await sim.syncAll("finance");
    for (const device of [a, b]) {
      expect(await unitStateOf(device, alpha.id)).toMatchObject({
        categoryId: "fincat:logement",
        source: "user",
      });
    }
    await sim.expectConverged("finance", { snapshots: true, exact: true });
  });

  it("two concurrent user choices: the later HLC wins and the replica that lost logs it", async () => {
    const { sim, a, b, alpha } = await twoLaptops();
    a.clock.advance(1_000);
    await a.repo.setFinanceTransactionCategory({
      transactionId: alpha.id,
      categoryId: "fincat:logement",
      scope: "this",
    });
    b.clock.advance(60_000);
    await b.repo.setFinanceTransactionCategory({
      transactionId: alpha.id,
      categoryId: "fincat:transport",
      scope: "this",
    });
    await sim.syncAll("finance");
    for (const device of [a, b]) {
      expect(await unitStateOf(device, alpha.id)).toMatchObject({
        categoryId: "fincat:transport",
        source: "user",
      });
    }
    // Only A lost a value, so only A logged it.
    expect(await categoryEvents(b)).toEqual([]);
    const logged = await categoryEvents(a);
    expect(logged).toHaveLength(1);
    expect(JSON.parse(String(logged[0]?.local_json)).categorization.value.category_id).toBe(
      "fincat:logement",
    );
    expect(logged[0]?.entity_type).toBe("finance_transactions");
    await sim.expectConverged("finance", { snapshots: true, exact: true });
  });

  it("a user choice after the other laptop's choice (it had synced) is an ordinary edit, not a conflict", async () => {
    const { sim, a, b, alpha } = await twoLaptops();
    a.clock.advance(1_000);
    await a.repo.setFinanceTransactionCategory({
      transactionId: alpha.id,
      categoryId: "fincat:logement",
      scope: "this",
    });
    await sim.exchange(a, b, "finance");
    b.clock.advance(60_000);
    await b.repo.setFinanceTransactionCategory({
      transactionId: alpha.id,
      categoryId: "fincat:transport",
      scope: "this",
    });
    await sim.syncAll("finance");
    expect(await categoryEvents(a)).toEqual([]);
    expect((await unitStateOf(a, alpha.id)).categoryId).toBe("fincat:transport");
  });

  it("replaces the split children as a set with the winning categorization, never mixing two sets", async () => {
    const { sim, a, b, alpha } = await twoLaptops();
    a.clock.advance(1_000);
    await a.repo.saveFinanceTransactionSplits(alpha.id, [
      splitOf(alpha.id, -600, "fincat:alimentation.epicerie", "a-1"),
      splitOf(alpha.id, -400, "fincat:alimentation.restaurants", "a-2"),
    ]);
    b.clock.advance(60_000);
    await b.repo.saveFinanceTransactionSplits(alpha.id, [
      splitOf(alpha.id, -1000, "fincat:transport", "b-1"),
    ]);
    await sim.syncAll("finance");
    for (const device of [a, b]) {
      const state = await unitStateOf(device, alpha.id);
      expect(state.splitIds).toEqual(["b-1"]);
      expect(state.hasSplits).toBe(true);
      const rows = await device.db.select<{ id: string }[]>(
        "SELECT id FROM finance_transaction_splits ORDER BY id",
      );
      expect(rows.map((row) => row.id)).toEqual(["b-1"]);
      // Every surviving child has meta; the replaced ones left nothing behind (no tombstone).
      const metas = await device.db.select<{ entity_id: string }[]>(
        "SELECT entity_id FROM sync_entity_meta WHERE entity_type = 'finance_transaction_splits' ORDER BY entity_id",
      );
      expect(metas.map((row) => row.entity_id)).toEqual(["b-1"]);
    }
    await sim.expectConverged("finance", { snapshots: true, exact: true });
  });

  it("merges the other columns by the row clock independently of the unit", async () => {
    const { sim, a, b, alpha } = await twoLaptops();
    a.clock.advance(1_000);
    await a.repo.setFinanceTransactionCategory({
      transactionId: alpha.id,
      categoryId: "fincat:logement",
      scope: "this",
    });
    // B edits a note AFTER (row clock later than A's whole write) without categorizing.
    b.clock.advance(300_000);
    const current = (await b.repo.getFinanceTransaction(alpha.id)) as NonNullable<
      Awaited<ReturnType<typeof b.repo.getFinanceTransaction>>
    >;
    await b.repo.saveFinanceTransaction({ ...current, notes: "noted at B" });
    await sim.syncAll("finance");
    for (const device of [a, b]) {
      const txn = await device.repo.getFinanceTransaction(alpha.id);
      expect(txn?.notes).toBe("noted at B"); // the row winner is B
      expect(txn?.categoryId).toBe("fincat:logement"); // the unit winner is A
      expect(txn?.categorySource).toBe("user");
    }
    await sim.expectConverged("finance", { snapshots: true, exact: true });
  });

  it("a delete that wins takes the transaction's split children with it", async () => {
    const { sim, a, b, alpha } = await twoLaptops();
    await a.repo.saveFinanceTransactionSplits(alpha.id, [
      splitOf(alpha.id, -600, "fincat:alimentation.epicerie", "s-1"),
      splitOf(alpha.id, -400, "fincat:alimentation.restaurants", "s-2"),
    ]);
    await sim.syncAll("finance");
    expect((await unitStateOf(b, alpha.id)).splitIds).toEqual(["s-1", "s-2"]);

    // A removes the transaction and its splits outside the app's own paths; the scan stamps it.
    a.clock.advance(600_000);
    await a.db.execute("DELETE FROM finance_transaction_splits WHERE transaction_id = $1", [
      alpha.id,
    ]);
    await a.db.execute("DELETE FROM finance_transactions WHERE id = $1", [alpha.id]);
    await a.stamp();
    await sim.syncAll("finance");

    for (const device of [a, b]) {
      expect(await device.repo.getFinanceTransaction(alpha.id)).toBeNull();
      // No orphaned child is left behind, with or without meta.
      expect(await device.db.select("SELECT * FROM finance_transaction_splits")).toEqual([]);
      expect(
        await device.db.select(
          "SELECT * FROM sync_entity_meta WHERE entity_type = 'finance_transaction_splits'",
        ),
      ).toEqual([]);
    }
    await sim.expectConverged("finance", { snapshots: true, exact: true });
  });

  it("a concurrent note edit on the other laptop survives a reclassify that changes nothing", async () => {
    const { sim, a, b, alpha } = await twoLaptops();
    await a.repo.saveFinanceRule(
      financeRule("rule-1", {
        matcher: { descriptionContains: "ALPHA" },
        actions: { categoryId: "fincat:transport" },
      }),
    );
    expect((await a.repo.reclassifyFinancePending()).reclassified).toBe(1);
    await sim.syncAll("finance");
    expect((await unitStateOf(b, alpha.id)).source).toBe("rule");

    // B edits the note; A, which has not heard of it, re-runs the rules and finds nothing to change.
    b.clock.advance(60_000);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const current = (await b.repo.getFinanceTransaction(alpha.id)) as NonNullable<
      Awaited<ReturnType<typeof b.repo.getFinanceTransaction>>
    >;
    await b.repo.saveFinanceTransaction({ ...current, notes: "noted at B" });
    a.clock.advance(120_000);
    expect((await a.repo.reclassifyFinancePending()).reclassified).toBe(0);
    await sim.syncAll("finance");
    for (const device of [a, b]) {
      expect((await device.repo.getFinanceTransaction(alpha.id))?.notes).toBe("noted at B");
    }
    await sim.expectConverged("finance", { snapshots: true, exact: true });
  });

  it("opening the split editor and saving the same splits does not replace the other laptop's amounts or note", async () => {
    const { sim, a, b, alpha } = await twoLaptops();
    const splits = (first: number, second: number) => [
      splitOf(alpha.id, first, "fincat:alimentation.epicerie", "s-1"),
      splitOf(alpha.id, second, "fincat:alimentation.restaurants", "s-2"),
    ];
    await a.repo.saveFinanceTransactionSplits(alpha.id, splits(-600, -400));
    await sim.syncAll("finance");

    // B changes an amount and then edits the note; A, which has not heard of either, saves the
    // very same splits again (the editor deletes and re-inserts every child).
    b.clock.advance(60_000);
    await b.repo.saveFinanceTransactionSplits(alpha.id, splits(-700, -300));
    b.clock.advance(1_000);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const current = (await b.repo.getFinanceTransaction(alpha.id)) as NonNullable<
      Awaited<ReturnType<typeof b.repo.getFinanceTransaction>>
    >;
    await b.repo.saveFinanceTransaction({ ...current, notes: "noted at B" });
    a.clock.advance(600_000);
    await a.repo.saveFinanceTransactionSplits(alpha.id, splits(-600, -400));
    await sim.syncAll("finance");

    for (const device of [a, b]) {
      const amounts = await device.db.select<{ id: string; amount_minor: number }[]>(
        "SELECT id, amount_minor FROM finance_transaction_splits ORDER BY id",
      );
      expect(amounts).toEqual([
        { id: "s-1", amount_minor: -700 },
        { id: "s-2", amount_minor: -300 },
      ]);
      expect((await device.repo.getFinanceTransaction(alpha.id))?.notes).toBe("noted at B");
    }
    await sim.expectConverged("finance", { snapshots: true, exact: true });
  });

  it("a note edit on a laptop whose row predates the unit clocks does not replace the other laptop's categorization", async () => {
    const { sim, a, b, alpha } = await twoLaptops();
    b.clock.advance(1_000);
    await b.repo.saveFinanceTransactionSplits(alpha.id, [
      splitOf(alpha.id, -600, "fincat:alimentation.epicerie", "s-1"),
      splitOf(alpha.id, -400, "fincat:alimentation.restaurants", "s-2"),
    ]);
    await sim.exchange(b, a, "finance");
    // A's copy was stamped by an earlier capture build: no unit clocks, a bare content hash.
    await a.db.execute(
      "UPDATE sync_entity_meta SET field_clocks_json = '{}' WHERE entity_type = 'finance_transactions' AND entity_id = $1",
      [alpha.id],
    );
    await a.db.execute(
      "UPDATE sync_entity_snapshot SET snapshot_json = NULL WHERE entity_type = 'finance_transactions' AND entity_id = $1",
      [alpha.id],
    );
    // B re-splits (a newer decision); A, which has not heard of it, edits only the note, later.
    b.clock.advance(60_000);
    await b.repo.saveFinanceTransactionSplits(alpha.id, [
      splitOf(alpha.id, -900, "fincat:transport", "s-3"),
      splitOf(alpha.id, -100, "fincat:logement", "s-4"),
    ]);
    a.clock.advance(600_000);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const current = (await a.repo.getFinanceTransaction(alpha.id)) as NonNullable<
      Awaited<ReturnType<typeof a.repo.getFinanceTransaction>>
    >;
    await a.repo.saveFinanceTransaction({ ...current, notes: "noted at A" });
    await sim.syncAll("finance");

    for (const device of [a, b]) {
      expect((await unitStateOf(device, alpha.id)).splitIds).toEqual(["s-3", "s-4"]);
      expect((await device.repo.getFinanceTransaction(alpha.id))?.notes).toBe("noted at A");
    }
    await sim.expectConverged("finance", { snapshots: true, exact: true });
  });

  it("archiving a category that exists only on a split of a pre-unit transaction reaches the other laptop", async () => {
    const { sim, a, b, alpha } = await twoLaptops();
    await a.repo.saveFinanceCategory({
      id: "fincat:temp",
      name: "Temp",
      parentId: null,
      kind: "expense",
      archived: false,
      isSystem: false,
      defersToNextMonth: false,
      sortOrder: 1,
      createdAt: "",
      updatedAt: "",
    });
    await a.repo.saveFinanceTransactionSplits(alpha.id, [
      splitOf(alpha.id, -600, "fincat:temp", "s-1"),
      splitOf(alpha.id, -400, "fincat:alimentation.restaurants", "s-2"),
    ]);
    await sim.syncAll("finance");
    // Both copies were stamped by an earlier capture build: same row clock, no unit clocks.
    for (const device of [a, b]) {
      await device.db.execute(
        "UPDATE sync_entity_meta SET field_clocks_json = '{}' WHERE entity_type = 'finance_transactions' AND entity_id = $1",
        [alpha.id],
      );
      await device.db.execute(
        "UPDATE sync_entity_snapshot SET snapshot_json = NULL WHERE entity_type = 'finance_transactions' AND entity_id = $1",
        [alpha.id],
      );
    }
    const splitCategories = async (device: SyncDevice) =>
      (
        await device.db.select<{ id: string; category_id: string }[]>(
          "SELECT id, category_id FROM finance_transaction_splits ORDER BY id",
        )
      ).map((row) => `${row.id}:${row.category_id}`);

    a.clock.advance(60_000);
    await a.repo.archiveFinanceCategory("fincat:temp", "fincat:alimentation.epicerie");
    await sim.syncAll("finance");
    for (const device of [a, b]) {
      expect(await splitCategories(device)).toEqual([
        "s-1:fincat:alimentation.epicerie",
        "s-2:fincat:alimentation.restaurants",
      ]);
    }

    // B's later edits of other columns do not put the old categories back, and a repeat exchange
    // changes nothing.
    b.clock.advance(60_000);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const current = (await b.repo.getFinanceTransaction(alpha.id)) as NonNullable<
      Awaited<ReturnType<typeof b.repo.getFinanceTransaction>>
    >;
    await b.repo.saveFinanceTransaction({ ...current, notes: "noted at B" });
    await sim.syncAll("finance");
    for (const device of [a, b]) {
      expect(await splitCategories(device)).toEqual([
        "s-1:fincat:alimentation.epicerie",
        "s-2:fincat:alimentation.restaurants",
      ]);
      expect((await device.repo.getFinanceTransaction(alpha.id))?.notes).toBe("noted at B");
    }
    for (const result of await sim.syncAll("finance")) {
      expect(result).toMatchObject({ applied: 0, tombstonesApplied: 0 });
    }
    await sim.expectConverged("finance", { snapshots: true, exact: true });
  });

  // The parent's updated_at has moved on after the split save (a note edit), so the row carries no
  // trace that its splits were written with it: only the changed child tells the stamper that the
  // archive is a unit write.
  it.each([
    ["A's bundle first", "a-first"],
    ["B's bundle first", "b-first"],
  ] as const)(
    "archiving a split-only category reaches the other laptop when the parent was edited after the split save (%s)",
    async (_label, order) => {
      const { sim, a, b, alpha } = await twoLaptops();
      await a.repo.saveFinanceCategory({
        id: "fincat:temp",
        name: "Temp",
        parentId: null,
        kind: "expense",
        archived: false,
        isSystem: false,
        defersToNextMonth: false,
        sortOrder: 1,
        createdAt: "",
        updatedAt: "",
      });
      await a.repo.saveFinanceTransactionSplits(alpha.id, [
        splitOf(alpha.id, -600, "fincat:temp", "s-1"),
        splitOf(alpha.id, -400, "fincat:alimentation.restaurants", "s-2"),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 5));
      a.clock.advance(1_000);
      const current = (await a.repo.getFinanceTransaction(alpha.id)) as NonNullable<
        Awaited<ReturnType<typeof a.repo.getFinanceTransaction>>
      >;
      await a.repo.saveFinanceTransaction({ ...current, notes: "noted after the splits" });
      await sim.syncAll("finance");
      for (const device of [a, b]) {
        await device.db.execute(
          "UPDATE sync_entity_meta SET field_clocks_json = '{}' WHERE entity_type = 'finance_transactions' AND entity_id = $1",
          [alpha.id],
        );
        await device.db.execute(
          "UPDATE sync_entity_snapshot SET snapshot_json = NULL WHERE entity_type = 'finance_transactions' AND entity_id = $1",
          [alpha.id],
        );
      }
      const splitCategories = async (device: SyncDevice) =>
        (
          await device.db.select<{ id: string; category_id: string }[]>(
            "SELECT id, category_id FROM finance_transaction_splits ORDER BY id",
          )
        ).map((row) => `${row.id}:${row.category_id}`);

      a.clock.advance(60_000);
      await a.repo.archiveFinanceCategory("fincat:temp", "fincat:alimentation.epicerie");
      if (order === "a-first") {
        await sim.exchange(a, b, "finance");
        await sim.exchange(b, a, "finance");
      } else {
        await sim.exchange(b, a, "finance");
        await sim.exchange(a, b, "finance");
      }
      await sim.syncAll("finance");
      for (const device of [a, b]) {
        expect(await splitCategories(device)).toEqual([
          "s-1:fincat:alimentation.epicerie",
          "s-2:fincat:alimentation.restaurants",
        ]);
        expect((await device.repo.getFinanceTransaction(alpha.id))?.notes).toBe(
          "noted after the splits",
        );
      }
      await sim.expectConverged("finance", { snapshots: true, exact: true });
    },
  );

  it("keeps the unit clocks in the transaction's meta: write, base and protection", async () => {
    const { sim, a, b, alpha } = await twoLaptops();
    const created = clocksOf(await readMetaOf(a.db, "finance_transactions", alpha.id));
    expect(Object.keys(created).sort()).toEqual(["categorization"]);
    a.clock.advance(1_000);
    await a.repo.setFinanceTransactionCategory({
      transactionId: alpha.id,
      categoryId: "fincat:logement",
      scope: "this",
    });
    await sim.exchange(a, b, "finance");
    for (const device of [a, b]) {
      const clocks = clocksOf(await readMetaOf(device.db, "finance_transactions", alpha.id));
      expect(clocks.categorization_base).toBe(created.categorization);
      expect(clocks.categorization_user).toBe(clocks.categorization);
    }
  });
});
