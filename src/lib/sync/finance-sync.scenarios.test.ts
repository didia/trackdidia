// @vitest-environment node
import { describe, expect, it } from "vitest";
import type {
  FinanceCategorySuggestion,
  FinanceMerchantMemoryEntry,
  FinancePerson,
  FinanceRecurringSeries,
} from "../../domain/finance";
import type { AiMemory } from "../../domain/types";
import { syncState } from "./capture-test-utils";
import type { SyncChangeSet } from "./change-set";
import {
  financeAccount,
  financeRule,
  importProfile,
  importRequest,
  importRow,
  splitOf,
  transactionByAmount,
  unitStateOf,
} from "./test-support/finance-fixtures";
import {
  createSyncHarness,
  jsonRoundTrip,
  readConflicts,
  type SyncDevice,
} from "./test-support/two-device-harness";

/**
 * The plain row-clock finance tables, the natural-key limits, import undo against an edit, category
 * suggestions and the statement snapshots, through the real repository methods of simulated laptops
 * with foreign keys on. (The categorization unit has its own file.)
 */

const person = (id: string, name: string): FinancePerson => ({
  id,
  displayName: name,
  color: null,
  archived: false,
  createdAt: "",
  updatedAt: "",
});

const memoryEntry = (
  overrides: Partial<FinanceMerchantMemoryEntry> = {},
): FinanceMerchantMemoryEntry => ({
  merchantKey: "IGA",
  accountId: "account-1",
  sign: -1,
  categoryId: "fincat:alimentation.epicerie",
  hitCount: 1,
  correctionCount: 0,
  confidence: 0.8,
  source: "user_correction",
  lastAppliedAt: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
  ...overrides,
});

const series = (
  id: string,
  overrides: Partial<FinanceRecurringSeries> = {},
): FinanceRecurringSeries => ({
  id,
  merchantKey: "NETFLIX",
  accountId: "account-1",
  categoryId: null,
  cadence: "monthly",
  expectedAmountMinor: -1699,
  amountToleranceMinor: 100,
  dayOfMonth: 5,
  lastSeenDate: "2026-09-05",
  nextExpectedDate: "2026-10-05",
  occurrenceCount: 3,
  status: "active",
  confirmedByUser: true,
  createdAt: "",
  updatedAt: "",
  ...overrides,
});

const aiMemory = (id: string, statement: string): AiMemory => ({
  id,
  kind: "preference",
  statement,
  detail: "",
  confidence: 0.9,
  source: "ai_extracted",
  status: "active",
  evidenceFrom: null,
  evidenceTo: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  lastConfirmedAt: "2026-04-01T00:00:00.000Z",
  expiresAt: null,
  pinned: false,
});

const suggestion = (
  id: string,
  transactionId: string,
  overrides: Partial<FinanceCategorySuggestion> = {},
): FinanceCategorySuggestion => ({
  id,
  transactionId,
  merchantKey: "ALPHA",
  suggestedCategoryId: "fincat:logement",
  confidence: 0.7,
  origin: "memory",
  rationale: null,
  model: null,
  promptVersion: null,
  status: "pending",
  decidedAt: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  ...overrides,
});

const twoLaptops = async () => {
  const sim = await createSyncHarness(["A", "B"]);
  return { sim, a: sim.device("A"), b: sim.device("B") };
};

const withTransactions = async () => {
  const world = await twoLaptops();
  await world.a.repo.saveFinanceAccount(financeAccount());
  await world.a.repo.importFinanceTransactions(
    importRequest([
      importRow({ amountMinor: -1000, descriptionRaw: "ALPHA 1", merchantKey: "ALPHA" }),
      importRow({ amountMinor: -2000, descriptionRaw: "BRAVO 2", merchantKey: "BRAVO" }),
    ]),
  );
  await world.sim.syncAll("finance");
  return {
    ...world,
    alpha: await transactionByAmount(world.a, -1000),
    bravo: await transactionByAmount(world.a, -2000),
  };
};

const overwrittenRows = async (device: SyncDevice, entityType: string) =>
  (await readConflicts(device)).filter(
    (row) => row.kind === "overwritten_edit" && row.entity_type === entityType,
  );

const mutated = (changeSet: SyncChangeSet, edit: (draft: SyncChangeSet) => void): SyncChangeSet => {
  const draft = jsonRoundTrip(changeSet);
  edit(draft);
  return draft;
};

describe("plain finance rows converge through the real methods", () => {
  it("publishes and merges every row-clock finance table and AI memories", async () => {
    const { sim, a, b } = await twoLaptops();
    await a.repo.saveFinancePerson(person("person-1", "Alex"));
    await a.repo.saveFinanceAccount(financeAccount({ ownerPersonId: "person-1" }));
    await a.repo.saveFinanceCategory({
      id: "fincat:custom",
      name: "Custom",
      parentId: null,
      kind: "expense",
      archived: false,
      isSystem: false,
      defersToNextMonth: false,
      sortOrder: 9,
      createdAt: "",
      updatedAt: "",
    });
    await a.repo.saveFinanceRule(financeRule("rule-1"));
    await a.repo.upsertFinanceMerchantMemory(memoryEntry());
    await a.repo.setFinanceBudgetAssignment("2026-10", "fincat:custom", 50_000);
    await a.repo.setFinanceBudgetMonthClosed("2026-09", true);
    await a.repo.saveFinanceRecurringSeries(series("series-1"));
    await a.repo.saveFinanceImportProfile(importProfile("profile-1", "sig-1"));
    await a.repo.importFinanceTransactions(
      importRequest(
        [importRow({ amountMinor: -500, descriptionRaw: "CAFE", merchantKey: "CAFE" })],
        {
          profileId: "profile-1",
        },
      ),
    );
    await a.repo.saveAiMemory(aiMemory("memory-1", "Likes quiet mornings"));

    await sim.syncAll("finance");
    await sim.syncAll("personal");

    for (const [table, count] of [
      ["finance_people", 1],
      ["finance_accounts", 1],
      ["finance_rules", 1],
      ["finance_merchant_memory", 1],
      ["finance_budget_entries", 1],
      ["finance_budget_months", 1],
      ["finance_recurring_series", 1],
      ["finance_import_profiles", 1],
      ["finance_import_batches", 1],
      ["finance_transactions", 1],
      ["ai_memories", 1],
    ] as const) {
      const rows = await b.db.select<{ n: number }[]>(`SELECT COUNT(*) AS n FROM ${table}`);
      expect(rows[0]?.n, table).toBe(count);
    }
    await sim.expectConverged("finance", { snapshots: true, exact: true });
    await sim.expectConverged("personal", { snapshots: true, exact: true });
    // A second full exchange changes nothing, and a verifying scan restamps nothing.
    for (const result of await sim.syncAll("finance")) {
      expect(result).toMatchObject({ applied: 0, tombstonesApplied: 0 });
    }
    expect(await b.repo.enableSyncCapture()).toMatchObject({
      installed: false,
      backfilled: 0,
      backfillComplete: true,
    });
  });

  it("whole-row last-writer-wins: the replica whose value was replaced logs it, the other does not", async () => {
    const { sim, a, b } = await twoLaptops();
    await a.repo.saveFinanceAccount(financeAccount());
    await sim.syncAll("finance");
    a.clock.advance(1_000);
    await a.repo.saveFinanceAccount(financeAccount({ name: "Renamed at A" }));
    b.clock.advance(60_000);
    await b.repo.saveFinanceAccount(financeAccount({ name: "Renamed at B", notes: "note at B" }));
    await sim.syncAll("finance");
    for (const device of [a, b]) {
      const account = (await device.repo.listFinanceAccounts()).find((a2) => a2.id === "account-1");
      expect(account).toMatchObject({ name: "Renamed at B", notes: "note at B" });
    }
    const lostAtA = await overwrittenRows(a, "finance_accounts");
    expect(lostAtA).toHaveLength(1);
    expect(JSON.parse(String(lostAtA[0]?.local_json))["(row)"].value.name).toBe("Renamed at A");
    expect(await overwrittenRows(b, "finance_accounts")).toEqual([]);
    await sim.expectConverged("finance", { snapshots: true, exact: true });
  });

  it("a peer-only edit is ordinary propagation: the receiver that never edited it logs nothing", async () => {
    const { sim, a, b } = await twoLaptops();
    await a.repo.saveFinanceAccount(financeAccount());
    await a.repo.saveFinanceRule(financeRule("rule-1"));
    await sim.syncAll("finance");
    a.clock.advance(60_000);
    await a.repo.saveFinanceAccount(financeAccount({ name: "Renamed at A" }));
    // Every classification that matches bumps the rule's applied_count: a whole-row write.
    await a.repo.importFinanceTransactions(
      importRequest([
        importRow({ amountMinor: -42, descriptionRaw: "IGA 42", merchantKey: "IGA" }),
      ]),
    );
    await sim.syncAll("finance");
    const [rule] = await b.repo.listFinanceRules();
    expect(rule?.appliedCount).toBe(1);
    expect((await b.repo.listFinanceAccounts())[0]?.name).toBe("Renamed at A");
    for (const device of [a, b]) {
      expect(
        (await readConflicts(device)).filter((row) => row.kind === "overwritten_edit"),
      ).toEqual([]);
    }
  });

  it("edit wins over delete only with a clock at least as late; a strictly later delete wins", async () => {
    const { sim, a, b } = await twoLaptops();
    await a.repo.saveFinanceRule(financeRule("rule-edit"));
    await a.repo.saveFinanceRule(financeRule("rule-gone"));
    await sim.syncAll("finance");

    a.clock.advance(1_000);
    await a.repo.deleteFinanceRule("rule-edit");
    await a.repo.deleteFinanceRule("rule-gone");
    b.clock.advance(60_000); // B's edit of rule-edit is later than A's delete
    await b.repo.saveFinanceRule(financeRule("rule-edit", { name: "Edited at B" }));
    // B's edit of rule-gone is EARLIER than A's delete: A deleted at +1s, B edits at -...
    await sim.syncAll("finance");
    const names = async (device: SyncDevice) =>
      (await device.repo.listFinanceRules()).map((rule) => `${rule.id}:${rule.name}`).sort();
    expect(await names(a)).toEqual(["rule-edit:Edited at B"]);
    expect(await names(b)).toEqual(["rule-edit:Edited at B"]);

    // A strictly later delete wins everywhere.
    a.clock.advance(600_000);
    await a.repo.deleteFinanceRule("rule-edit");
    await sim.syncAll("finance");
    expect(await names(a)).toEqual([]);
    expect(await names(b)).toEqual([]);
    await sim.expectConverged("finance", { snapshots: true, exact: true });
  });

  it("carries the ids a rule embeds verbatim when nothing is aliased", async () => {
    const { sim, a, b } = await twoLaptops();
    await a.repo.saveFinanceRule(
      financeRule("rule-1", {
        matcher: { accountIds: ["account-1", "account-2"], personId: "person-9" },
        actions: { categoryId: "fincat:alimentation.epicerie", personId: "person-9" },
      }),
    );
    await sim.syncAll("finance");
    const [stored] = await b.db.select<{ matcher_json: string; actions_json: string }[]>(
      "SELECT matcher_json, actions_json FROM finance_rules",
    );
    const [original] = await a.db.select<{ matcher_json: string; actions_json: string }[]>(
      "SELECT matcher_json, actions_json FROM finance_rules",
    );
    expect(stored).toEqual(original);
    expect(JSON.parse(stored?.matcher_json ?? "{}")).toMatchObject({
      accountIds: ["account-1", "account-2"],
      personId: "person-9",
    });
    // The references are declared in the registry, with machine-readable paths (the alias engine
    // rewrites exactly these).
    const { getTableRegistration } = await import("./registry");
    const columns = getTableRegistration("finance_rules")
      .references.filter((reference) => reference.kind === "json-payload")
      .map((reference) => `${reference.column}:${reference.path}`);
    expect(columns).toEqual([
      "matcher_json:$.accountIds[]",
      "matcher_json:$.personId",
      "actions_json:$.categoryId",
      "actions_json:$.personId",
    ]);
  });

  it("merges the default categories both laptops seeded without a spurious conflict", async () => {
    const { sim, a, b } = await twoLaptops();
    await a.repo.seedFinanceDefaultCategories();
    b.clock.advance(5_000);
    await b.repo.seedFinanceDefaultCategories();
    await sim.syncAll("finance");
    expect(await overwrittenRows(a, "finance_categories")).toEqual([]);
    expect(await overwrittenRows(b, "finance_categories")).toEqual([]);
    await sim.expectConverged("finance", { snapshots: true, exact: true });
  });
});

describe("import undo against an edit on the other laptop", () => {
  const setup = async () => {
    const world = await twoLaptops();
    await world.a.repo.saveFinanceAccount(financeAccount());
    const summary = await world.a.repo.importFinanceTransactions(
      importRequest([
        importRow({ amountMinor: -1000, descriptionRaw: "ALPHA 1", merchantKey: "ALPHA" }),
        importRow({ amountMinor: -2000, descriptionRaw: "BRAVO 2", merchantKey: "BRAVO" }),
      ]),
    );
    await world.sim.syncAll("finance");
    return { ...world, batchId: summary.batchId };
  };

  const ids = async (device: SyncDevice) =>
    (await device.repo.listFinanceTransactions({})).map((txn) => txn.amountMinor).sort();

  it("a categorization LATER than the undo resurrects the transaction on both laptops", async () => {
    const { sim, a, b, batchId } = await setup();
    a.clock.advance(1_000);
    expect((await a.repo.undoFinanceImportBatch(batchId)).deleted).toBe(2);
    expect(await ids(a)).toEqual([]);

    b.clock.advance(120_000);
    const alpha = await transactionByAmount(b, -1000);
    await b.repo.setFinanceTransactionCategory({
      transactionId: alpha.id,
      categoryId: "fincat:logement",
      scope: "this",
    });
    await sim.syncAll("finance");

    // The edited transaction came back, the untouched one stays undone.
    for (const device of [a, b]) {
      expect(await ids(device)).toEqual([-1000]);
      expect(await unitStateOf(device, alpha.id)).toMatchObject({
        categoryId: "fincat:logement",
        source: "user",
      });
    }
    // The batch row itself is never changed by an undo (it is not marked undone), so it is simply
    // the same on both laptops and its counts stay as the import wrote them.
    for (const device of [a, b]) {
      const [batch] = await device.repo.listFinanceImportBatches();
      expect(batch).toMatchObject({ id: batchId, status: "completed", importedCount: 2 });
    }
    await sim.expectConverged("finance", { snapshots: true, exact: true });
  });

  it("a second undo cannot remove a row a manual categorization brought back, but can remove one any other edit brought back", async () => {
    const { sim, a, b, batchId } = await setup();
    a.clock.advance(1_000);
    expect((await a.repo.undoFinanceImportBatch(batchId)).deleted).toBe(2);

    // B brings both rows back, later than the undo: one by a manual categorization, one by a note.
    b.clock.advance(120_000);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const alpha = await transactionByAmount(b, -1000);
    await b.repo.setFinanceTransactionCategory({
      transactionId: alpha.id,
      categoryId: "fincat:logement",
      scope: "this",
    });
    const bravo = await transactionByAmount(b, -2000);
    await b.repo.saveFinanceTransaction({ ...bravo, notes: "touched at B" });
    await sim.syncAll("finance");
    for (const device of [a, b]) expect(await ids(device)).toEqual([-1000, -2000]);

    // Undoing the same batch again (the batch is still the latest one and still `completed`):
    // the user-categorized row is refused and stays; the note-edited row is removed again.
    a.clock.advance(600_000);
    const second = await a.repo.undoFinanceImportBatch(batchId);
    expect(second).toEqual({ deleted: 1, refusedUserCategorized: 1 });
    await sim.syncAll("finance");
    for (const device of [a, b]) {
      expect(await ids(device)).toEqual([-1000]);
      expect(await unitStateOf(device, alpha.id)).toMatchObject({ source: "user" });
    }
    // Nothing else deletes a transaction, so the manually categorized row stays in the ledger.
    expect((await a.repo.undoFinanceImportBatch(batchId)).deleted).toBe(0);
    await sim.expectConverged("finance", { snapshots: true, exact: true });
  });

  it("a categorization EARLIER than the undo loses: the delete is strictly later", async () => {
    const { sim, a, b, batchId } = await setup();
    b.clock.advance(1_000);
    const alpha = await transactionByAmount(b, -1000);
    await b.repo.setFinanceTransactionCategory({
      transactionId: alpha.id,
      categoryId: "fincat:logement",
      scope: "this",
    });
    a.clock.advance(120_000);
    await a.repo.undoFinanceImportBatch(batchId);
    await sim.syncAll("finance");
    // The user-categorized row is refused by the undo itself (never deleted on A) ...
    for (const device of [a, b]) {
      expect(await ids(device)).toEqual([]);
    }
  });

  it("converges after an undo of an untouched batch, with the splits and suggestions that went with it", async () => {
    const { sim, a, b, batchId } = await setup();
    const alpha = await transactionByAmount(a, -1000);
    await a.repo.saveFinanceTransactionSplits(alpha.id, [
      splitOf(alpha.id, -600, "fincat:alimentation.epicerie"),
      splitOf(alpha.id, -400, "fincat:alimentation.restaurants"),
    ]);
    await sim.syncAll("finance");
    // The split save made the parent a `user` row, which an undo refuses to delete: drop it first.
    await a.repo.saveFinanceTransactionSplits(alpha.id, []);
    await sim.syncAll("finance");
    a.clock.advance(60_000);
    expect((await a.repo.undoFinanceImportBatch(batchId)).deleted).toBe(2);
    await sim.syncAll("finance");
    for (const device of [a, b]) {
      expect(await ids(device)).toEqual([]);
      expect(await device.db.select("SELECT * FROM finance_transaction_splits")).toEqual([]);
    }
    await sim.expectConverged("finance", { snapshots: true, exact: true });
  });
});

describe("category suggestions: terminal beats pending, one pending per transaction", () => {
  const pendingCount = async (device: SyncDevice, transactionId: string) =>
    (
      await device.db.select<{ n: number }[]>(
        "SELECT COUNT(*) AS n FROM finance_category_suggestions WHERE transaction_id = $1 AND status = 'pending'",
        [transactionId],
      )
    )[0]?.n;

  const statusOf = async (device: SyncDevice, id: string) =>
    (
      await device.db.select<{ status: string }[]>(
        "SELECT status FROM finance_category_suggestions WHERE id = $1",
        [id],
      )
    )[0]?.status;

  it("a decision beats a LATER pending edit on both laptops", async () => {
    const { sim, a, b, alpha } = await withTransactions();
    await a.repo.saveFinanceCategorySuggestions([suggestion("s1", alpha.id)]);
    await sim.syncAll("finance");
    b.clock.advance(1_000);
    await b.repo.decideFinanceCategorySuggestion("s1", { status: "dismissed" });
    a.clock.advance(600_000); // A's pending edit is stamped much later than B's decision
    await a.repo.saveFinanceCategorySuggestions([
      suggestion("s1", alpha.id, { suggestedCategoryId: "fincat:transport" }),
    ]);
    await sim.syncAll("finance");
    for (const device of [a, b]) {
      expect(await statusOf(device, "s1")).toBe("dismissed");
    }
    expect((await readConflicts(a)).filter((c) => c.kind === "terminal_divergence")).toEqual([]);
    await sim.expectConverged("finance", { snapshots: true, exact: true });
  });

  it("two different decisions keep the smaller status and raise one unresolved divergence", async () => {
    const { sim, a, b, alpha } = await withTransactions();
    await a.repo.saveFinanceCategorySuggestions([suggestion("s1", alpha.id)]);
    await sim.syncAll("finance");
    a.clock.advance(1_000);
    await a.repo.decideFinanceCategorySuggestion("s1", { status: "dismissed" });
    b.clock.advance(60_000);
    await b.repo.decideFinanceCategorySuggestion("s1", {
      status: "accepted",
      categoryId: "fincat:logement",
    });
    await sim.syncAll("finance");
    for (const device of [a, b]) {
      expect(await statusOf(device, "s1")).toBe("accepted");
    }
    const divergences = [...(await readConflicts(a)), ...(await readConflicts(b))].filter(
      (row) => row.kind === "terminal_divergence",
    );
    expect(divergences.length).toBeGreaterThan(0);
    expect(new Set(divergences.map((row) => row.id)).size).toBe(1);
    expect(divergences[0]).toMatchObject({
      entity_type: "finance_category_suggestions",
      entity_id: "s1",
      resolved_at: null,
    });
  });

  it("two pending suggestions for one transaction: the later clock stays pending, the other is stored expired", async () => {
    const { sim, a, b, alpha } = await withTransactions();
    a.clock.advance(1_000);
    await a.repo.saveFinanceCategorySuggestions([suggestion("s-a", alpha.id)]);
    b.clock.advance(60_000);
    await b.repo.saveFinanceCategorySuggestions([
      suggestion("s-b", alpha.id, { suggestedCategoryId: "fincat:transport" }),
    ]);
    // Neither bundle aborts, in either direction, and the partial unique index holds.
    await sim.syncAll("finance");
    for (const device of [a, b]) {
      expect(await pendingCount(device, alpha.id)).toBe(1);
      expect(await statusOf(device, "s-b")).toBe("pending");
      expect(await statusOf(device, "s-a")).toBe("expired");
    }
    // The replica that meets both rows logs it (here B, which received A's earlier suggestion
    // first); the other learns of the expiry as an ordinary terminal status.
    const collisions = [...(await readConflicts(a)), ...(await readConflicts(b))].filter(
      (row) => row.kind === "pending_collision",
    );
    expect(collisions).toHaveLength(1);
    expect(JSON.parse(String(collisions[0]?.local_json))).toEqual({ expired: "s-a", kept: "s-b" });
    expect(JSON.parse(String(collisions[0]?.remote_json))).toMatchObject({
      transactionId: alpha.id,
    });
    await sim.expectConverged("finance", { snapshots: true, exact: true });
  });

  it("a collision resolved before one contender is decided converges by exchange, not in one pass (documented limit)", async () => {
    const { sim, a, b, alpha } = await withTransactions();
    a.clock.advance(1_000);
    await a.repo.saveFinanceCategorySuggestions([suggestion("s-a", alpha.id)]);
    b.clock.advance(60_000);
    await b.repo.saveFinanceCategorySuggestions([
      suggestion("s-b", alpha.id, { suggestedCategoryId: "fincat:transport" }),
    ]);
    const fromA = jsonRoundTrip(await a.repo.listSyncChanges("finance"));
    const earlyB = jsonRoundTrip(await b.repo.listSyncChanges("finance"));
    b.clock.advance(60_000);
    await b.repo.decideFinanceCategorySuggestion("s-b", { status: "dismissed" });
    const lateB = jsonRoundTrip(await b.repo.listSyncChanges("finance"));

    // Two replicas that hear of the same writes in a different order differ for one pass ...
    const replicas = await createSyncHarness(["X", "Y"], { deviceIndexOffset: 20 });
    const [x, y] = replicas.devices as [SyncDevice, SyncDevice];
    for (const bundle of [fromA, earlyB, lateB]) await x.repo.applySyncBundle("finance", bundle);
    for (const bundle of [lateB, fromA]) await y.repo.applySyncBundle("finance", bundle);
    expect(await statusOf(x, "s-b")).toBe("dismissed");
    expect(await statusOf(y, "s-b")).toBe("dismissed");
    expect(await statusOf(x, "s-a")).toBe("expired"); // lost the slot while s-b was still pending
    expect(await statusOf(y, "s-a")).toBe("pending"); // s-b was already decided: no collision
    expect(await pendingCount(x, alpha.id)).toBe(0);
    expect(await pendingCount(y, alpha.id)).toBe(1);
    // ... and agree as soon as they exchange: a terminal status wins, so the expiry spreads.
    await replicas.syncAll("finance");
    for (const device of [x, y]) {
      expect(await statusOf(device, "s-a")).toBe("expired");
      expect(await statusOf(device, "s-b")).toBe("dismissed");
    }
    await replicas.expectConverged("finance", { snapshots: true, exact: true });
    void sim;
  });

  it("stores a suggestion whose transaction has not arrived yet, and the transaction fills in later", async () => {
    const { sim, a, b, alpha } = await withTransactions();
    await a.repo.saveFinanceCategorySuggestions([suggestion("s1", alpha.id)]);
    const full = await a.repo.listSyncChanges("finance");
    const partial = mutated(full, (draft) => {
      draft.entities = draft.entities.filter(
        (entity) => entity.entityId !== alpha.id && entity.table !== "finance_transactions",
      );
    });
    const fresh = (await createSyncHarness(["X"], { deviceIndexOffset: 20 })).device("X");
    const result = await fresh.repo.applySyncBundle("finance", partial);
    expect(result.applied).toBeGreaterThan(0);
    expect(await statusOf(fresh, "s1")).toBe("pending");
    expect(await fresh.db.select("SELECT * FROM finance_transactions")).toEqual([]);
    await fresh.repo.applySyncBundle("finance", jsonRoundTrip(full));
    expect((await fresh.repo.listFinanceTransactions({})).length).toBe(2);
    expect(await statusOf(fresh, "s1")).toBe("pending");
    void sim;
    void b;
  });

  it("a decided suggestion survives the delete that raced it (the app only deletes pending ones)", async () => {
    const { sim, a, b, alpha } = await withTransactions();
    await a.repo.saveFinanceCategorySuggestions([suggestion("s1", alpha.id)]);
    await sim.syncAll("finance");
    a.clock.advance(1_000);
    await a.repo.decideFinanceCategorySuggestion("s1", { status: "dismissed" });
    // B categorizes the transaction, which deletes the pending suggestion it still holds, LATER.
    b.clock.advance(600_000);
    await b.repo.setFinanceTransactionCategory({
      transactionId: alpha.id,
      categoryId: "fincat:logement",
      scope: "this",
    });
    await sim.syncAll("finance");
    for (const device of [a, b]) {
      expect(await statusOf(device, "s1")).toBe("dismissed");
    }
    await sim.expectConverged("finance", { snapshots: true, exact: true });
  });
});

describe("split children whose transaction has not arrived", () => {
  it("skips them with an informational conflict and never aborts the bundle", async () => {
    const { sim, a, alpha } = await withTransactions();
    await a.repo.saveFinanceTransactionSplits(alpha.id, [
      splitOf(alpha.id, -600, "fincat:alimentation.epicerie", "s-1"),
      splitOf(alpha.id, -400, "fincat:alimentation.restaurants", "s-2"),
    ]);
    const full = await a.repo.listSyncChanges("finance");
    const orphaned = mutated(full, (draft) => {
      draft.entities = draft.entities.filter(
        (entity) => !(entity.table === "finance_transactions" && entity.entityId === alpha.id),
      );
    });
    const fresh = (await createSyncHarness(["X"], { deviceIndexOffset: 20 })).device("X");
    await fresh.repo.applySyncBundle("finance", orphaned);
    expect(await fresh.db.select("SELECT * FROM finance_transaction_splits")).toEqual([]);
    const conflicts = (await readConflicts(fresh)).filter((row) => row.kind === "orphaned_child");
    expect(conflicts.map((row) => row.entity_type)).toEqual([
      "finance_transaction_splits",
      "finance_transaction_splits",
    ]);
    // The bundle that brings the transaction brings its children.
    await fresh.repo.applySyncBundle("finance", jsonRoundTrip(full));
    expect(
      (
        await fresh.db.select<{ id: string }[]>(
          "SELECT id FROM finance_transaction_splits ORDER BY id",
        )
      ).map((row) => row.id),
    ).toEqual(["s-1", "s-2"]);
    void sim;
  });
});

describe("statement balance snapshots", () => {
  const statement = (accountId: string, statementDate: string, balanceMinor: number) => ({
    accountId,
    statementDate,
    balanceMinor,
  });

  const snapshotsOf = async (device: SyncDevice) =>
    device.db.select<{ as_of_date: string; source: string; balance_minor: number }[]>(
      "SELECT as_of_date, source, balance_minor FROM finance_account_balance_snapshots ORDER BY as_of_date, source",
    );

  it("publishes only statement snapshots; derived ones and their meta stay on the laptop", async () => {
    const { sim, a, b, alpha } = await withTransactions();
    await a.repo.applyFinanceStatementBalance(statement("account-1", "2026-09-30", 500_000));
    await a.repo.snapshotFinanceAccountBalances("2026-10-05");
    expect((await snapshotsOf(a)).map((row) => row.source)).toEqual(["statement", "derived"]);

    const published = await a.repo.listSyncChanges("finance");
    const snapshotEntities = published.entities.filter(
      (entity) => entity.table === "finance_account_balance_snapshots",
    );
    expect(snapshotEntities.map((entity) => entity.row?.source)).toEqual(["statement"]);
    expect(JSON.stringify(published)).not.toContain("2026-10-05");

    await sim.syncAll("finance");
    expect(await snapshotsOf(b)).toEqual([
      { as_of_date: "2026-09-30", source: "statement", balance_minor: 500_000 },
    ]);
    // The account row carries the re-based opening balance; B's meta for the snapshot is the same.
    const opening = (account: SyncDevice) =>
      account.db.select<{ opening_balance_minor: number }[]>(
        "SELECT opening_balance_minor FROM finance_accounts",
      );
    expect(await opening(b)).toEqual(await opening(a));
    expect(
      await b.db.select(
        "SELECT * FROM sync_entity_meta WHERE entity_type = 'finance_account_balance_snapshots'",
      ),
    ).toHaveLength(1);
    void alpha;
  });

  it("replaces the standing anchor on the other laptops without a tombstone, and a stale laptop cannot bring it back", async () => {
    const sim = await createSyncHarness(["A", "B", "C"]);
    const [a, b, c] = sim.devices as [SyncDevice, SyncDevice, SyncDevice];
    await a.repo.saveFinanceAccount(financeAccount());
    await a.repo.importFinanceTransactions(
      importRequest([
        importRow({ amountMinor: -1000, descriptionRaw: "ALPHA 1", merchantKey: "ALPHA" }),
      ]),
    );
    await a.repo.applyFinanceStatementBalance(statement("account-1", "2026-08-31", 400_000));
    await sim.syncAll("finance");
    for (const device of [b, c]) {
      expect((await snapshotsOf(device)).map((row) => row.as_of_date)).toEqual(["2026-08-31"]);
    }

    a.clock.advance(60_000);
    await a.repo.applyFinanceStatementBalance(statement("account-1", "2026-09-30", 450_000));
    expect((await snapshotsOf(a)).map((row) => row.as_of_date)).toEqual(["2026-09-30"]);
    await sim.exchange(a, b, "finance");
    expect((await snapshotsOf(b)).map((row) => row.as_of_date)).toEqual(["2026-09-30"]);

    // C still holds the old anchor and publishes it: neither A nor B takes it back ...
    await sim.exchange(c, a, "finance");
    await sim.exchange(c, b, "finance");
    for (const device of [a, b]) {
      expect((await snapshotsOf(device)).map((row) => row.as_of_date)).toEqual(["2026-09-30"]);
    }
    // ... and C replaces its own when it hears of the new one.
    await sim.syncAll("finance");
    for (const device of [a, b, c]) {
      expect((await snapshotsOf(device)).map((row) => row.as_of_date)).toEqual(["2026-09-30"]);
      // No meta, no snapshot and no tombstone is left for the replaced anchor.
      const metas = await device.db.select<{ entity_id: string; deleted_at: string | null }[]>(
        "SELECT entity_id, deleted_at FROM sync_entity_meta WHERE entity_type = 'finance_account_balance_snapshots'",
      );
      expect(metas).toHaveLength(1);
      expect(metas[0]?.deleted_at).toBeNull();
    }
    await sim.expectConverged("finance", { snapshots: true, exact: true });
    for (const result of await sim.syncAll("finance")) {
      expect(result).toMatchObject({ applied: 0, tombstonesApplied: 0 });
    }
  });

  it("keeps the later anchor of two concurrent statement imports on both laptops", async () => {
    const { sim, a, b } = await withTransactions();
    a.clock.advance(1_000);
    await a.repo.applyFinanceStatementBalance(statement("account-1", "2026-09-30", 450_000));
    b.clock.advance(60_000);
    await b.repo.applyFinanceStatementBalance(statement("account-1", "2026-10-31", 470_000));
    await sim.syncAll("finance");
    for (const device of [a, b]) {
      expect(await snapshotsOf(device)).toEqual([
        { as_of_date: "2026-10-31", source: "statement", balance_minor: 470_000 },
      ]);
    }
    await sim.expectConverged("finance", { snapshots: true, exact: true });
    for (const result of await sim.syncAll("finance")) {
      expect(result).toMatchObject({ applied: 0 });
    }
  });

  it("a statement beats a derived snapshot at the same key, whatever the clocks", async () => {
    const { sim, a, b } = await withTransactions();
    a.clock.advance(1_000);
    await a.repo.applyFinanceStatementBalance(statement("account-1", "2026-10-05", 450_000));
    b.clock.advance(3_600_000); // B's daily job runs later than A's statement import
    await b.repo.snapshotFinanceAccountBalances("2026-10-05");
    expect((await snapshotsOf(b)).map((row) => row.source)).toEqual(["derived"]);
    await sim.syncAll("finance");
    for (const device of [a, b]) {
      expect(await snapshotsOf(device)).toEqual([
        { as_of_date: "2026-10-05", source: "statement", balance_minor: 450_000 },
      ]);
    }
  });

  it("refuses a bundle row that is not a statement snapshot, rolling everything back", async () => {
    const { a, b } = await twoLaptops();
    await a.repo.saveFinanceAccount(financeAccount());
    await a.repo.applyFinanceStatementBalance(statement("account-1", "2026-09-30", 450_000));
    const good = await a.repo.listSyncChanges("finance");
    const bad = mutated(good, (draft) => {
      const entity = draft.entities.find(
        (candidate) => candidate.table === "finance_account_balance_snapshots",
      );
      if (entity?.row) entity.row.source = "derived";
    });
    const before = await syncState(b.db);
    const failure = await b.repo.applySyncBundle("finance", bad).catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: "SyncApplyError", code: "row_filter_violation" });
    expect(await syncState(b.db)).toEqual(before);
    expect(await b.db.select("SELECT * FROM finance_accounts")).toEqual([]);
  });

  it("re-bases the opening balance on the laptop that imported; the other keeps the row it received until its next write", async () => {
    const { sim, a, b } = await withTransactions();
    // A: the statement says the balance on 2026-09-30 is 500000, with 3000 of transactions before it.
    await a.repo.applyFinanceStatementBalance(statement("account-1", "2026-09-30", 500_000));
    const openingA = (await a.repo.listFinanceAccounts())[0]?.openingBalanceMinor;
    expect(openingA).toBe(500_000 + 3_000);
    // B imports a late in-period transaction before it hears of the statement.
    b.clock.advance(5_000);
    await b.repo.importFinanceTransactions(
      importRequest(
        [importRow({ amountMinor: -700, descriptionRaw: "LATE 3", merchantKey: "LATE" })],
        {
          fileHash: "hash-late",
        },
      ),
    );
    await sim.syncAll("finance");
    // Both laptops hold the same transactions and the same account row now ...
    const totals = async (device: SyncDevice) =>
      (await device.repo.listFinanceTransactions({})).reduce(
        (sum, txn) => sum + txn.amountMinor,
        0,
      );
    expect(await totals(a)).toBe(-3_700);
    expect(await totals(b)).toBe(-3_700);
    const openings = [a, b].map(
      async (d) => (await d.repo.listFinanceAccounts())[0]?.openingBalanceMinor,
    );
    expect(await Promise.all(openings)).toEqual([await openings[0], await openings[0]]);
    // ... and the next write on either one re-anchors with the merged set (the merge itself does not).
    a.clock.advance(5_000);
    const late = await transactionByAmount(a, -700);
    await a.repo.saveFinanceTransaction({ ...late, notes: "touched" });
    expect((await a.repo.listFinanceAccounts())[0]?.openingBalanceMinor).toBe(500_000 + 3_700);
    await sim.syncAll("finance");
    expect((await b.repo.listFinanceAccounts())[0]?.openingBalanceMinor).toBe(500_000 + 3_700);
    await sim.expectConverged("finance", { snapshots: true, exact: true });
  });
});

describe("finance settings and the work profile", () => {
  it("a finance setting converges between two personal laptops and never appears in a gtd bundle", async () => {
    const { sim, a, b } = await twoLaptops();
    await a.repo.updateSettings((current) => ({
      ...current,
      financeBaseCurrency: "EUR",
      financeSafetyBufferMinor: 123_400,
      financeAlertsOnToday: false,
    }));
    await a.repo.updateSettings((current) => ({ ...current, language: "fr" }));
    await sim.syncAll("finance");
    await sim.syncAll("gtd");
    const settings = await b.repo.getSettings();
    expect(settings.financeBaseCurrency).toBe("EUR");
    expect(settings.financeSafetyBufferMinor).toBe(123_400);
    expect(settings.financeAlertsOnToday).toBe(false);
    const gtd = await a.repo.listSyncChanges("gtd");
    expect(
      gtd.settings.map((entry) => entry.key).filter((key) => key.startsWith("finance")),
    ).toEqual([]);
    expect(JSON.stringify(gtd)).not.toContain("123400");
    const finance = await a.repo.listSyncChanges("finance");
    expect(finance.settings.map((entry) => entry.key).sort()).toEqual([
      "financeAlertsOnToday",
      "financeBaseCurrency",
      "financeSafetyBufferMinor",
    ]);
    // A later change on B wins by its clock and flows back.
    b.clock.advance(60_000);
    await b.repo.updateSettings((current) => ({ ...current, financeBaseCurrency: "USD" }));
    await sim.syncAll("finance");
    expect((await a.repo.getSettings()).financeBaseCurrency).toBe("USD");
  });
});

describe("a large import through capture, publish and apply", () => {
  it("stamps, publishes and applies a 1000-row import in reasonable time, then re-applies it for free", async () => {
    const { sim, a, b } = await twoLaptops();
    await a.repo.saveFinanceAccount(financeAccount());
    await sim.syncAll("finance");
    const rows = Array.from({ length: 1000 }, (_, index) =>
      importRow({
        postedDate: `2026-03-${String((index % 28) + 1).padStart(2, "0")}`,
        amountMinor: -(100 + index),
        descriptionRaw: `MERCHANT ${index}`,
        merchantKey: `MERCHANT ${index}`,
      }),
    );
    await a.repo.importFinanceTransactions(importRequest(rows, { fileHash: "big" }));

    const published = performance.now();
    const changeSet = jsonRoundTrip(await a.repo.listSyncChanges("finance"));
    const publishMs = performance.now() - published;
    const applied = performance.now();
    const result = await b.repo.applySyncBundle("finance", changeSet);
    const applyMs = performance.now() - applied;
    console.info(
      `[finance sync perf] 1000-row import: publish ${publishMs.toFixed(0)} ms, apply ${applyMs.toFixed(0)} ms`,
    );
    expect(result.applied).toBeGreaterThanOrEqual(1000);
    expect(publishMs).toBeLessThan(10_000);
    expect(applyMs).toBeLessThan(15_000);
    expect(await b.repo.countFinanceTransactions({})).toBe(1000);
    expect(await b.repo.applySyncBundle("finance", changeSet)).toMatchObject({
      applied: 0,
      tombstonesApplied: 0,
    });
    // The verifying scan over 1000+ rows (one big chunk here) restamps nothing.
    expect(
      await b.repo.enableSyncCapture({
        limits: { rowsPerChunk: 100_000, statementsPerChunk: 1_000_000 },
      }),
    ).toMatchObject({ installed: false, backfilled: 0, backfillComplete: true });
    await sim.expectConverged("finance", { snapshots: true, exact: true });
  }, 60_000);
});

describe("recurring series detected independently on two laptops", () => {
  const netflix = (postedDate: string) =>
    importRow({
      postedDate,
      amountMinor: -1699,
      descriptionRaw: "NETFLIX.COM",
      merchantKey: "NETFLIX",
    });

  it("keeps both rows after a merge (no natural key); the next detection removes the unconfirmed duplicate", async () => {
    const { sim, a, b } = await twoLaptops();
    await a.repo.saveFinanceAccount(financeAccount());
    await a.repo.importFinanceTransactions(
      importRequest(
        ["2026-06-05", "2026-07-05", "2026-08-05", "2026-09-05", "2026-10-05"].map(netflix),
      ),
    );
    await sim.syncAll("finance");
    const [detected] = await a.repo.listFinanceRecurringSeries();
    expect(detected).toBeDefined();
    // The other laptop holds a series of its own for the same merchant (an independent detection
    // under another id), unconfirmed.
    b.clock.advance(5_000);
    await b.repo.saveFinanceRecurringSeries({
      ...(detected as NonNullable<typeof detected>),
      id: "series-b",
      confirmedByUser: false,
    });
    await a.repo.saveFinanceRecurringSeries({
      ...(detected as NonNullable<typeof detected>),
      confirmedByUser: false,
    });
    await sim.syncAll("finance");
    expect(await a.repo.listFinanceRecurringSeries()).toHaveLength(2);
    a.clock.advance(60_000);
    await a.repo.detectFinanceRecurringSeries();
    await sim.syncAll("finance");
    for (const device of [a, b]) {
      expect(await device.repo.listFinanceRecurringSeries()).toHaveLength(1);
    }
    await sim.expectConverged("finance", { snapshots: true, exact: true });
  });
});
