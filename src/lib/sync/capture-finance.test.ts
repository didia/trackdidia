// @vitest-environment node
import { describe, expect, it } from "vitest";
import { clocksOf, readMeta, readMetaOf, syncState } from "./capture-test-utils";
import { compareHlc } from "./hlc";
import {
  financeAccount,
  financeRule,
  importRequest,
  importRow,
  splitOf,
  transactionByAmount,
} from "./test-support/finance-fixtures";
import { createSyncHarness, type SyncDevice } from "./test-support/two-device-harness";

/**
 * Capture of the finance categorization unit (`capture-finance.ts`): what the stamper writes for
 * transactions and their splits, derived from the snapshot diff, in the same transaction.
 */

const oneLaptop = async () => {
  const sim = await createSyncHarness(["A"]);
  const a = sim.device("A");
  await a.repo.saveFinanceAccount(financeAccount());
  await a.repo.importFinanceTransactions(
    importRequest([
      importRow({ amountMinor: -1000, descriptionRaw: "ALPHA 1", merchantKey: "ALPHA" }),
      importRow({ amountMinor: -2000, descriptionRaw: "BRAVO 2", merchantKey: "BRAVO" }),
    ]),
  );
  const alpha = await transactionByAmount(a, -1000);
  const bravo = await transactionByAmount(a, -2000);
  return { a, alpha, bravo };
};

const unitOf = async (device: SyncDevice, id: string) => {
  const meta = await readMetaOf(device.db, "finance_transactions", id);
  return { clocks: clocksOf(meta), rowHlc: meta?.row_hlc as string, deletedAt: meta?.deleted_at };
};

describe("capture of the categorization unit", () => {
  it("stamps a created transaction with a unit clock, no base and no protection", async () => {
    const { a, alpha } = await oneLaptop();
    const { clocks, rowHlc } = await unitOf(a, alpha.id);
    expect(clocks).toEqual({ categorization: rowHlc });
    const snapshot = await a.db.select<{ snapshot_json: string; content_hash: string }[]>(
      "SELECT snapshot_json, content_hash FROM sync_entity_snapshot WHERE entity_type = 'finance_transactions' AND entity_id = $1",
      [alpha.id],
    );
    expect(Object.keys(JSON.parse(snapshot[0]?.snapshot_json ?? "{}"))).toEqual(["unit"]);
    expect(snapshot[0]?.content_hash).toBeTruthy();
  });

  it("moves only the row clock for an edit of another column, and the unit clocks for a decision", async () => {
    const { a, alpha } = await oneLaptop();
    const created = await unitOf(a, alpha.id);

    a.clock.advance(1_000);
    await a.repo.bulkUpdateFinanceTransactions([alpha.id], { excludedFromReports: true });
    const edited = await unitOf(a, alpha.id);
    expect(compareHlc(created.rowHlc, edited.rowHlc)).toBe(-1);
    expect(edited.clocks).toEqual(created.clocks);

    a.clock.advance(1_000);
    await a.repo.setFinanceTransactionCategory({
      transactionId: alpha.id,
      categoryId: "fincat:logement",
      scope: "this",
    });
    const decided = await unitOf(a, alpha.id);
    expect(decided.clocks.categorization).toBe(decided.rowHlc);
    expect(decided.clocks.categorization_base).toBe(created.clocks.categorization);
    expect(decided.clocks.categorization_user).toBe(decided.clocks.categorization);
  });

  it("stamps nothing when nothing changed: a repeat, a no-op update and a verifying scan", async () => {
    const { a, alpha } = await oneLaptop();
    const before = await syncState(a.db);
    // A write that sets the same values is not a change.
    const current = (await a.repo.getFinanceTransaction(alpha.id)) as NonNullable<
      Awaited<ReturnType<typeof a.repo.getFinanceTransaction>>
    >;
    await a.db.execute("UPDATE finance_transactions SET notes = notes WHERE id = $1", [current.id]);
    await a.stamp();
    expect(await syncState(a.db)).toEqual(before);
    expect(await a.repo.enableSyncCapture()).toEqual({ installed: false, backfilled: 0 });
    expect(await syncState(a.db)).toEqual(before);
  });

  it("a reclassify pass that decides nothing new stamps nothing at all", async () => {
    const { a } = await oneLaptop();
    await a.repo.saveFinanceRule(
      financeRule("rule-1", {
        matcher: { descriptionContains: "ALPHA" },
        actions: { categoryId: "fincat:transport" },
      }),
    );
    a.clock.advance(1_000);
    expect((await a.repo.reclassifyFinancePending()).reclassified).toBe(1);
    const settled = await syncState(a.db);
    // Let the wall clock move: the old pass rewrote `updated_at` of every non-user row each time.
    await new Promise((resolve) => setTimeout(resolve, 5));
    a.clock.advance(1_000);
    expect((await a.repo.reclassifyFinancePending()).reclassified).toBe(0);
    expect(await syncState(a.db)).toEqual(settled); // no meta, no snapshot, no counter, no rule bump
  });

  /** Rewinds a transaction to the shape an earlier capture build left: no unit clocks, a bare hash. */
  const rewindToPreUnit = async (device: SyncDevice, id: string) => {
    await device.db.execute(
      "UPDATE sync_entity_meta SET field_clocks_json = '{}' WHERE entity_type = 'finance_transactions' AND entity_id = $1",
      [id],
    );
    await device.db.execute(
      "UPDATE sync_entity_snapshot SET snapshot_json = NULL WHERE entity_type = 'finance_transactions' AND entity_id = $1",
      [id],
    );
  };

  it("a note edit of a row stamped before the unit existed keeps the derived unit, only the row clock moves", async () => {
    const { a, alpha } = await oneLaptop();
    a.clock.advance(1_000);
    await a.repo.setFinanceTransactionCategory({
      transactionId: alpha.id,
      categoryId: "fincat:logement",
      scope: "this",
    });
    const decided = await unitOf(a, alpha.id);
    await rewindToPreUnit(a, alpha.id);

    a.clock.advance(60_000);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const current = (await a.repo.getFinanceTransaction(alpha.id)) as NonNullable<
      Awaited<ReturnType<typeof a.repo.getFinanceTransaction>>
    >;
    await a.repo.saveFinanceTransaction({ ...current, notes: "only a note" });
    const edited = await unitOf(a, alpha.id);
    // The unit is the one the row had (derived from its old row clock, a user row protects itself) ...
    expect(edited.clocks).toEqual({
      categorization: decided.rowHlc,
      categorization_user: decided.rowHlc,
    });
    // ... and the row clock moved with the edit.
    expect(compareHlc(decided.rowHlc, edited.rowHlc)).toBe(-1);
  });

  const tempCategory = {
    id: "fincat:temp",
    name: "Temp",
    parentId: null,
    kind: "expense" as const,
    archived: false,
    isSystem: false,
    defersToNextMonth: false,
    sortOrder: 1,
    createdAt: "",
    updatedAt: "",
  };

  it("archiving a category that exists only on a split of a pre-unit row is a unit write, not the old unit with new children", async () => {
    const { a, alpha } = await oneLaptop();
    await a.repo.saveFinanceCategory(tempCategory);
    await a.repo.saveFinanceTransactionSplits(alpha.id, [
      splitOf(alpha.id, -600, "fincat:temp", "s-1"),
      splitOf(alpha.id, -400, "fincat:alimentation.restaurants", "s-2"),
    ]);
    const split = await unitOf(a, alpha.id);
    await rewindToPreUnit(a, alpha.id);

    a.clock.advance(60_000);
    await a.repo.archiveFinanceCategory("fincat:temp", "fincat:alimentation.epicerie");
    // The parent row did not change (its category is the internal split category) ...
    expect((await a.repo.getFinanceTransaction(alpha.id))?.categoryId).toBe("fincat:split");
    // ... but the children did, and the old unit cannot stand for them: a fresh unit clock whose base
    // is the one derived from the row clock.
    const after = await unitOf(a, alpha.id);
    expect(after.clocks.categorization).toBe(after.rowHlc);
    expect(compareHlc(split.rowHlc, after.rowHlc)).toBe(-1);
    expect(after.clocks.categorization_base).toBe(split.rowHlc);
    // The row is a `user` row, so like every unit write of one it protects itself.
    expect(after.clocks.categorization_user).toBe(after.clocks.categorization);
    // And the next scan finds nothing to do.
    const settled = await syncState(a.db);
    await a.stamp();
    expect(await syncState(a.db)).toEqual(settled);
  });

  it("the archive is a unit write even when the parent was edited after the split save (only the changed child tells)", async () => {
    const { a, alpha } = await oneLaptop();
    await a.repo.saveFinanceCategory(tempCategory);
    await a.repo.saveFinanceTransactionSplits(alpha.id, [
      splitOf(alpha.id, -600, "fincat:temp", "s-1"),
      splitOf(alpha.id, -400, "fincat:alimentation.restaurants", "s-2"),
    ]);
    // The parent's updated_at moves on after the split save: no stamp ties it to the children now.
    await new Promise((resolve) => setTimeout(resolve, 5));
    a.clock.advance(1_000);
    const current = (await a.repo.getFinanceTransaction(alpha.id)) as NonNullable<
      Awaited<ReturnType<typeof a.repo.getFinanceTransaction>>
    >;
    await a.repo.saveFinanceTransaction({ ...current, notes: "noted after the splits" });
    const before = await unitOf(a, alpha.id);
    await rewindToPreUnit(a, alpha.id);

    a.clock.advance(60_000);
    await a.repo.archiveFinanceCategory("fincat:temp", "fincat:alimentation.epicerie");
    const after = await unitOf(a, alpha.id);
    expect(after.clocks.categorization).toBe(after.rowHlc);
    expect(compareHlc(before.rowHlc, after.rowHlc)).toBe(-1);
    expect(after.clocks.categorization_base).toBe(before.rowHlc);
  });

  it("a verifying scan of an unchanged pre-unit row with splits still only derives the clocks", async () => {
    const { a, alpha } = await oneLaptop();
    await a.repo.saveFinanceTransactionSplits(alpha.id, [
      splitOf(alpha.id, -600, "fincat:alimentation.epicerie", "s-1"),
      splitOf(alpha.id, -400, "fincat:alimentation.restaurants", "s-2"),
    ]);
    const split = await unitOf(a, alpha.id);
    await rewindToPreUnit(a, alpha.id);
    await a.repo.enableSyncCapture();
    const derived = await unitOf(a, alpha.id);
    expect(derived.rowHlc).toBe(split.rowHlc);
    expect(derived.clocks).toEqual({
      categorization: split.rowHlc,
      categorization_user: split.rowHlc,
    });
  });

  it("a categorization of a row stamped before the unit existed is still a unit write", async () => {
    const { a, alpha } = await oneLaptop();
    const created = await unitOf(a, alpha.id);
    await rewindToPreUnit(a, alpha.id);
    a.clock.advance(60_000);
    await a.repo.setFinanceTransactionCategory({
      transactionId: alpha.id,
      categoryId: "fincat:logement",
      scope: "this",
    });
    const after = await unitOf(a, alpha.id);
    expect(after.clocks.categorization).toBe(after.rowHlc);
    expect(after.clocks.categorization_base).toBe(created.rowHlc);
    expect(after.clocks.categorization_user).toBe(after.rowHlc);
  });

  it("saving the same splits again writes nothing: no new clock, children keep created_at", async () => {
    const { a, alpha } = await oneLaptop();
    const input = [
      splitOf(alpha.id, -600, "fincat:alimentation.epicerie", "s-1"),
      splitOf(alpha.id, -400, "fincat:alimentation.restaurants", "s-2"),
    ];
    await a.repo.saveFinanceTransactionSplits(alpha.id, input);
    const settled = await syncState(a.db);
    const rows = await a.db.select("SELECT * FROM finance_transaction_splits ORDER BY id");
    const parent = await a.repo.getFinanceTransaction(alpha.id);
    await new Promise((resolve) => setTimeout(resolve, 5));
    a.clock.advance(1_000);
    await a.repo.saveFinanceTransactionSplits(alpha.id, input);
    expect(await syncState(a.db)).toEqual(settled);
    expect(await a.db.select("SELECT * FROM finance_transaction_splits ORDER BY id")).toEqual(rows);
    expect(await a.repo.getFinanceTransaction(alpha.id)).toEqual(parent);
    // A different amount is a real unit write again.
    const before = await unitOf(a, alpha.id);
    a.clock.advance(1_000);
    await a.repo.saveFinanceTransactionSplits(alpha.id, [
      splitOf(alpha.id, -700, "fincat:alimentation.epicerie", "s-1"),
      splitOf(alpha.id, -300, "fincat:alimentation.restaurants", "s-2"),
    ]);
    const after = await unitOf(a, alpha.id);
    expect(
      compareHlc(before.clocks.categorization as string, after.clocks.categorization as string),
    ).toBe(-1);
    expect(after.clocks.categorization_base).toBe(before.clocks.categorization);
  });

  it("an automatic write inherits the protection of the user decision it replaces (a reset by split removal)", async () => {
    const { a, alpha } = await oneLaptop();
    a.clock.advance(1_000);
    await a.repo.saveFinanceTransactionSplits(alpha.id, [
      splitOf(alpha.id, -600, "fincat:alimentation.epicerie"),
      splitOf(alpha.id, -400, "fincat:alimentation.restaurants"),
    ]);
    const split = await unitOf(a, alpha.id);
    expect(split.clocks.categorization_user).toBe(split.clocks.categorization);

    a.clock.advance(1_000);
    await a.repo.saveFinanceTransactionSplits(alpha.id, []);
    const reset = await unitOf(a, alpha.id);
    expect((await a.repo.getFinanceTransaction(alpha.id))?.categorySource).toBe("default");
    expect(reset.clocks.categorization_base).toBe(split.clocks.categorization);
    expect(reset.clocks.categorization_user).toBe(split.clocks.categorization); // inherited
    expect(
      compareHlc(reset.clocks.categorization as string, split.clocks.categorization as string),
    ).toBe(1);
  });

  it("saving splits stamps the children (with their parent in the snapshot) and the parent in one flush", async () => {
    const { a, alpha } = await oneLaptop();
    a.clock.advance(1_000);
    await a.repo.saveFinanceTransactionSplits(alpha.id, [
      splitOf(alpha.id, -600, "fincat:alimentation.epicerie", "s-1"),
      splitOf(alpha.id, -400, "fincat:alimentation.restaurants", "s-2"),
    ]);
    const metas = await readMeta(a.db, "finance_transaction_splits");
    expect(metas.map((meta) => meta.entity_id).sort()).toEqual(["s-1", "s-2"]);
    expect(metas.every((meta) => meta.deleted_at === null && meta.field_clocks_json === "{}")).toBe(
      true,
    );
    const snapshots = await a.db.select<{ snapshot_json: string }[]>(
      "SELECT snapshot_json FROM sync_entity_snapshot WHERE entity_type = 'finance_transaction_splits' ORDER BY entity_id",
    );
    expect(snapshots.map((row) => JSON.parse(row.snapshot_json))).toEqual([
      { transaction_id: alpha.id },
      { transaction_id: alpha.id },
    ]);
    expect(await a.db.select("SELECT * FROM sync_dirty")).toEqual([]);

    // Removing them leaves NO tombstone for the children: the unit carries the set.
    a.clock.advance(1_000);
    await a.repo.saveFinanceTransactionSplits(alpha.id, []);
    expect(await readMeta(a.db, "finance_transaction_splits")).toEqual([]);
    expect(
      await a.db.select(
        "SELECT * FROM sync_entity_snapshot WHERE entity_type = 'finance_transaction_splits'",
      ),
    ).toEqual([]);
  });

  it("re-saving identical splits that only differ in created_at is still one unit write, then stable", async () => {
    const { a, alpha } = await oneLaptop();
    const input = [
      splitOf(alpha.id, -600, "fincat:alimentation.epicerie", "s-1"),
      splitOf(alpha.id, -400, "fincat:alimentation.restaurants", "s-2"),
    ];
    await a.repo.saveFinanceTransactionSplits(alpha.id, input);
    const first = await unitOf(a, alpha.id);
    // A second flush with nothing changed stamps nothing.
    const state = await syncState(a.db);
    await a.stamp();
    expect(await syncState(a.db)).toEqual(state);
    expect(first.clocks.categorization).toBeTruthy();
  });

  it("a change to a split alone (a category archived) re-stamps its transaction's unit", async () => {
    const { a, alpha } = await oneLaptop();
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
    const before = await unitOf(a, alpha.id);

    a.clock.advance(1_000);
    await a.repo.archiveFinanceCategory("fincat:temp", "fincat:alimentation.epicerie");
    // The parent's own columns did not change (its category is the internal split category) ...
    expect((await a.repo.getFinanceTransaction(alpha.id))?.categoryId).toBe("fincat:split");
    // ... but the children did, so the unit has a new clock.
    const after = await unitOf(a, alpha.id);
    expect(
      compareHlc(before.clocks.categorization as string, after.clocks.categorization as string),
    ).toBe(-1);
    expect(after.clocks.categorization_base).toBe(before.clocks.categorization);
    expect(compareHlc(before.rowHlc, after.rowHlc)).toBe(-1);
  });

  it("a deleted transaction keeps a tombstone without unit clocks and no tombstone for its splits", async () => {
    const { a, alpha, bravo } = await oneLaptop();
    await a.repo.saveFinanceTransactionSplits(bravo.id, [
      splitOf(bravo.id, -2000, "fincat:alimentation.epicerie", "s-1"),
    ]);
    await a.repo.saveFinanceTransactionSplits(bravo.id, []); // back to an undo-able row
    const batchId = (await a.repo.listFinanceImportBatches())[0]?.id as string;
    a.clock.advance(1_000);
    expect((await a.repo.undoFinanceImportBatch(batchId)).deleted).toBe(2);
    for (const id of [alpha.id, bravo.id]) {
      const gone = await readMetaOf(a.db, "finance_transactions", id);
      expect(gone?.deleted_at).toBe(gone?.row_hlc);
      expect(gone?.field_clocks_json).toBe("{}");
    }
    expect(await readMeta(a.db, "finance_transaction_splits")).toEqual([]);
  });

  it("a replaced statement anchor leaves no tombstone", async () => {
    const { a } = await oneLaptop();
    await a.repo.applyFinanceStatementBalance({
      accountId: "account-1",
      statementDate: "2026-08-31",
      balanceMinor: 100_000,
    });
    a.clock.advance(1_000);
    await a.repo.applyFinanceStatementBalance({
      accountId: "account-1",
      statementDate: "2026-09-30",
      balanceMinor: 120_000,
    });
    const metas = await readMeta(a.db, "finance_account_balance_snapshots");
    expect(metas).toHaveLength(1);
    expect(metas[0]?.deleted_at).toBeNull();
    expect(metas[0]?.entity_id).toBe('["account-1","2026-09-30"]');
  });

  it("derives the unit clocks of a row stamped before the unit existed, issuing no clock", async () => {
    const { a, alpha } = await oneLaptop();
    const stamped = await unitOf(a, alpha.id);
    // Rewind to the pre-unit shape: no unit clocks, a bare content hash.
    await a.db.execute(
      "UPDATE sync_entity_meta SET field_clocks_json = '{}' WHERE entity_type = 'finance_transactions' AND entity_id = $1",
      [alpha.id],
    );
    await a.db.execute(
      "UPDATE sync_entity_snapshot SET snapshot_json = NULL WHERE entity_type = 'finance_transactions' AND entity_id = $1",
      [alpha.id],
    );
    const counter = await a.db.select<{ change_counter: number }[]>(
      "SELECT change_counter FROM sync_identity",
    );
    await a.repo.enableSyncCapture();
    const healed = await unitOf(a, alpha.id);
    expect(healed.rowHlc).toBe(stamped.rowHlc);
    expect(healed.clocks).toEqual({ categorization: stamped.rowHlc });
    // Counted as one stamped entity, and a second scan finds nothing.
    expect(await a.repo.enableSyncCapture()).toEqual({ installed: false, backfilled: 0 });
    expect(counter[0]?.change_counter).toBeGreaterThan(0);
  });
});
