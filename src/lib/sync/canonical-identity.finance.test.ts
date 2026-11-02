// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { FinanceCategorySuggestion } from "../../domain/finance";
import { dedupeHash } from "../finance/import-profile";
import { syncState } from "./capture-test-utils";
import {
  financeAccount,
  financeRule,
  financeTransaction,
  importProfile,
  importRequest,
  importRow,
  splitOf,
  transactionByAmount,
  transactionsOf,
} from "./test-support/finance-fixtures";
import {
  createSyncHarness,
  jsonRoundTrip,
  readConflicts,
  type SyncDevice,
  type SyncHarness,
} from "./test-support/two-device-harness";

/**
 * Canonical identity for finance, through the real repository methods of simulated laptops with
 * foreign keys on: the same statement imported independently on two laptops (the spec's headline
 * example), the same account import label, the same CSV layout, three-way collisions, late rows that
 * still carry an alias id, and the privacy of aliases.
 */

const rows = () => [
  importRow({ amountMinor: -1000, descriptionRaw: "ALPHA 1", merchantKey: "ALPHA" }),
  importRow({ amountMinor: -2000, descriptionRaw: "BRAVO 2", merchantKey: "BRAVO" }),
  importRow({ amountMinor: -3000, descriptionRaw: "CHARLIE 3", merchantKey: "CHARLIE" }),
];

const suggestion = (
  id: string,
  transactionId: string,
  overrides: Partial<FinanceCategorySuggestion> = {},
): FinanceCategorySuggestion => ({
  id,
  transactionId,
  merchantKey: "CHARLIE",
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

/** Everything a scan could restamp: a verifying scan changes nothing and stamps nothing. */
const expectNothingToStamp = async (device: SyncDevice): Promise<void> => {
  const before = await syncState(device.db);
  expect(await device.repo.enableSyncCapture()).toMatchObject({
    installed: false,
    backfilled: 0,
    backfillComplete: true,
  });
  expect(await syncState(device.db)).toEqual(before);
};

const aliasRows = (device: SyncDevice) =>
  device.db.select<{ entity_type: string; alias_id: string; canonical_id: string }[]>(
    "SELECT entity_type, alias_id, canonical_id FROM sync_id_aliases ORDER BY entity_type, alias_id",
  );

/** Two laptops that share an account and then import the same statement on their own. */
const bothImported = async (names: string[] = ["A", "B"]) => {
  const sim = await createSyncHarness(names);
  const [a, b] = [sim.device("A"), sim.device("B")];
  await a.repo.saveFinanceAccount(financeAccount());
  await sim.syncAll("finance");
  for (const device of sim.devices) {
    device.clock.advance(5_000);
    await device.repo.importFinanceTransactions(importRequest(rows()));
  }
  return { sim, a, b };
};

const exchangeInOrder = async (sim: SyncHarness, order: string[]) => {
  for (const step of order) {
    const [from, to] = step.split(">");
    await sim.exchange(sim.device(from as string), sim.device(to as string), "finance");
  }
};

describe("the same statement imported independently on two laptops", () => {
  it("resolves to one canonical transaction per line, with children remapped and nothing rolled back", async () => {
    const { sim, a, b } = await bothImported();
    const idsA = new Map((await transactionsOf(a)).map((txn) => [txn.amountMinor, txn.id]));
    const idsB = new Map((await transactionsOf(b)).map((txn) => [txn.amountMinor, txn.id]));
    for (const amount of [-1000, -2000, -3000]) {
      expect(idsA.get(amount)).not.toBe(idsB.get(amount));
    }
    const canonical = (amount: number) => [idsA.get(amount), idsB.get(amount)].sort()[0] as string;

    a.clock.advance(1_000);
    await a.repo.saveFinanceTransactionSplits(idsA.get(-1000) as string, [
      splitOf(idsA.get(-1000) as string, -600, "fincat:alimentation.epicerie"),
      splitOf(idsA.get(-1000) as string, -400, "fincat:alimentation.restaurants"),
    ]);
    b.clock.advance(2_000);
    await b.repo.setFinanceTransactionCategory({
      transactionId: idsB.get(-2000) as string,
      categoryId: "fincat:logement",
      scope: "this",
    });
    await a.repo.saveFinanceCategorySuggestions([suggestion("s-a", idsA.get(-3000) as string)]);
    b.clock.advance(60_000);
    await b.repo.saveFinanceCategorySuggestions([
      suggestion("s-b", idsB.get(-3000) as string, { suggestedCategoryId: "fincat:transport" }),
    ]);

    await exchangeInOrder(sim, ["A>B", "B>A"]);
    await sim.syncAll("finance");

    for (const device of [a, b]) {
      const txns = await transactionsOf(device);
      expect(txns).toHaveLength(3);
      expect(txns.map((txn) => txn.id).sort()).toEqual([-1000, -2000, -3000].map(canonical).sort());
      const alpha = await transactionByAmount(device, -1000);
      expect(alpha.id).toBe(canonical(-1000));
      expect(alpha).toMatchObject({ categorySource: "user", hasSplits: true });
      expect((await device.repo.listFinanceTransactionSplits(alpha.id)).length).toBe(2);
      expect(await transactionByAmount(device, -2000)).toMatchObject({
        categoryId: "fincat:logement",
        categorySource: "user",
      });
      // Every split and suggestion points at a live transaction: nothing dangles.
      const dangling = await device.db.select(
        `SELECT id FROM finance_transaction_splits WHERE transaction_id NOT IN (SELECT id FROM finance_transactions)
         UNION SELECT id FROM finance_category_suggestions WHERE transaction_id NOT IN (SELECT id FROM finance_transactions)`,
      );
      expect(dangling).toEqual([]);
      // One pending suggestion for the line both laptops suggested for: the later one stays.
      const pending = await device.db.select<{ id: string; transaction_id: string }[]>(
        "SELECT id, transaction_id FROM finance_category_suggestions WHERE status = 'pending'",
      );
      expect(pending).toEqual([{ id: "s-b", transaction_id: canonical(-3000) }]);
      expect(await aliasRows(device)).toEqual(
        [-1000, -2000, -3000]
          .map((amount) => ({
            entity_type: "finance_transactions",
            alias_id: idsA.get(amount) === canonical(amount) ? idsB.get(amount) : idsA.get(amount),
            canonical_id: canonical(amount),
          }))
          .sort((x, y) => ((x.alias_id as string) < (y.alias_id as string) ? -1 : 1)),
      );
      await expectNothingToStamp(device);
    }
    await sim.expectConverged("finance", { snapshots: true, exact: true });
    // Applying the same bundles again issues and changes nothing.
    for (const result of await sim.syncAll("finance")) {
      expect(result).toMatchObject({ applied: 0, tombstonesApplied: 0, conflictsLogged: 0 });
    }
  });

  it.each([
    ["A>B", "B>A"],
    ["B>A", "A>B"],
    ["A>B", "A>B", "B>A"],
  ])("converges the same way in the order %s", async (...order) => {
    const { sim, a, b } = await bothImported();
    a.clock.advance(1_000);
    const alpha = await transactionByAmount(a, -1000);
    await a.repo.saveFinanceTransactionSplits(alpha.id, [
      splitOf(alpha.id, -1000, "fincat:alimentation.epicerie"),
    ]);
    b.clock.advance(1_000);
    await b.repo.bulkUpdateFinanceTransactions([(await transactionByAmount(b, -2000)).id], {
      excludedFromReports: true,
    });
    await exchangeInOrder(sim, order);
    await sim.syncAll("finance");
    await sim.expectConverged("finance", { snapshots: true, exact: true });
    expect(await transactionsOf(a)).toHaveLength(3);
    expect(await transactionsOf(b)).toHaveLength(3);
  });

  it("never touches the other domains: a finance alias stays in the finance bundle", async () => {
    const { sim, a, b } = await bothImported();
    await sim.syncAll("finance");
    expect((await aliasRows(a)).length).toBe(3);
    const finance = await a.repo.listSyncChanges("finance");
    expect(finance.aliases).toHaveLength(3);
    for (const domain of ["gtd", "personal"] as const) {
      const bundle = JSON.stringify(await a.repo.listSyncChanges(domain));
      expect((await a.repo.listSyncChanges(domain)).aliases).toEqual([]);
      expect((await b.repo.listSyncChanges(domain)).aliases).toEqual([]);
      expect(bundle).not.toContain("finance");
      expect(bundle).not.toContain("sync_id_aliases");
    }
  });

  it("a gtd-only replica (the work profile) ends with no finance or personal row, alias or conflict", async () => {
    const { sim, a, b } = await bothImported();
    await a.repo.createTask({
      id: "task-a",
      title: "Work item",
      bucket: "next_action",
      sourceExternalId: "s",
    });
    b.clock.advance(1_000);
    await b.repo.createTask({
      id: "task-b",
      title: "Work item",
      bucket: "next_action",
      sourceExternalId: "s",
    });
    await sim.syncAll("finance");
    await sim.syncAll("gtd");
    expect((await aliasRows(a)).map((row) => row.entity_type)).toEqual([
      "finance_transactions",
      "finance_transactions",
      "finance_transactions",
      "gtd_tasks",
    ]);

    const work = (await createSyncHarness(1, { deviceIndexOffset: 20 })).device("A");
    // (The three system categories every database is migrated with exist before any bundle.)
    const metaBefore = await work.db.select(
      "SELECT entity_type, entity_id FROM sync_entity_meta WHERE entity_type LIKE 'finance%' OR entity_type IN ('ai_proposals', 'daily_entries') ORDER BY 1, 2",
    );
    for (const device of [a, b]) {
      await work.repo.applySyncBundle(
        "gtd",
        jsonRoundTrip(await device.repo.listSyncChanges("gtd")),
      );
    }
    expect((await aliasRows(work)).map((row) => [row.entity_type, row.alias_id])).toEqual([
      ["gtd_tasks", "task-b"],
    ]);
    for (const table of [
      "finance_accounts",
      "finance_transactions",
      "finance_transaction_splits",
      "finance_category_suggestions",
      "finance_import_batches",
      "ai_proposals",
    ]) {
      expect(await work.db.select(`SELECT * FROM ${table}`), table).toEqual([]);
    }
    expect(
      await work.db.select(
        "SELECT entity_type, entity_id FROM sync_entity_meta WHERE entity_type LIKE 'finance%' OR entity_type IN ('ai_proposals', 'daily_entries') ORDER BY 1, 2",
      ),
    ).toEqual(metaBefore);
    // And a finance bundle is refused by a gtd apply: aliases or not.
    const finance = await a.repo.listSyncChanges("finance");
    await expect(work.repo.applySyncBundle("gtd", jsonRoundTrip(finance))).rejects.toMatchObject({
      code: "domain_mismatch",
    });
  });

  it("refuses a gtd bundle that carries a finance alias, whatever it is labelled", async () => {
    const { sim, a } = await bothImported();
    await sim.syncAll("finance");
    const poisoned = jsonRoundTrip(await a.repo.listSyncChanges("gtd"));
    poisoned.aliases = (await a.repo.listSyncChanges("finance")).aliases;
    const before = await syncState(a.db);
    await expect(a.repo.applySyncBundle("gtd", poisoned)).rejects.toMatchObject({
      name: "SyncChangeSetError",
      code: "table_not_in_domain",
    });
    expect(await syncState(a.db)).toEqual(before);
  });
});

const memoryEntry = (accountId: string, categoryId: string, updatedAt: string) => ({
  merchantKey: "IGA",
  accountId,
  sign: -1 as const,
  categoryId,
  hitCount: 1,
  correctionCount: 0,
  confidence: 0.8,
  source: "user_correction" as const,
  lastAppliedAt: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt,
});

describe("the same import label bound to an account on both laptops", () => {
  const setup = async () => {
    const sim = await createSyncHarness(["A", "B"]);
    const [a, b] = [sim.device("A"), sim.device("B")];
    await a.repo.saveFinanceAccount(financeAccount({ id: "account-a", externalKey: "VISA-1234" }));
    b.clock.advance(5_000);
    await b.repo.saveFinanceAccount(financeAccount({ id: "account-b", externalKey: "VISA-1234" }));
    for (const [device, id] of [
      [a, "account-a"],
      [b, "account-b"],
    ] as const) {
      device.clock.advance(1_000);
      await device.repo.importFinanceTransactions(
        importRequest(
          rows().map((row) => ({ ...row, accountId: id })),
          { accountId: id },
        ),
      );
    }
    return { sim, a, b };
  };

  it("rewrites the transactions and every account reference of both laptops onto the smaller id", async () => {
    const { sim, a, b } = await setup();
    await a.repo.saveFinanceRule(
      financeRule("rule-a", {
        matcher: { descriptionContains: "ALPHA", accountIds: ["account-a"] },
        actions: { categoryId: "fincat:transport" },
      }),
    );
    await b.repo.saveFinanceRule(
      financeRule("rule-b", {
        matcher: { descriptionContains: "BRAVO", accountIds: ["account-b", "account-other"] },
        actions: { categoryId: "fincat:logement" },
      }),
    );
    await a.repo.upsertFinanceMerchantMemory(
      memoryEntry("account-a", "fincat:transport", "2026-04-02T00:00:00.000Z"),
    );
    b.clock.advance(60_000);
    await b.repo.upsertFinanceMerchantMemory(
      memoryEntry("account-b", "fincat:logement", "2026-04-03T00:00:00.000Z"),
    );
    await a.repo.saveFinanceImportProfile(
      importProfile("profile-a", "sig-a", { defaultAccountId: "account-a" }),
    );
    await b.repo.saveFinanceImportProfile(
      importProfile("profile-b", "sig-b", { defaultAccountId: "account-b" }),
    );
    await b.repo.saveFinanceRecurringSeries({
      id: "series-b",
      merchantKey: "NETFLIX",
      accountId: "account-b",
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
    });

    await sim.syncAll("finance");

    for (const device of [a, b]) {
      expect((await device.repo.listFinanceAccounts()).map((account) => account.id)).toEqual([
        "account-a",
      ]);
      const txns = await transactionsOf(device);
      expect(txns).toHaveLength(3);
      expect(new Set(txns.map((txn) => txn.accountId))).toEqual(new Set(["account-a"]));
      const rules = await device.repo.listFinanceRules();
      expect(rules.find((rule) => rule.id === "rule-b")?.matcher.accountIds).toEqual([
        "account-a",
        "account-other",
      ]);
      expect(rules.find((rule) => rule.id === "rule-a")?.matcher.accountIds).toEqual(["account-a"]);
      const memory = await device.db.select<{ account_id: string; category_id: string }[]>(
        "SELECT account_id, category_id FROM finance_merchant_memory",
      );
      // Two memories of one merchant, one per account, are one memory of the account now: the later wins.
      expect(memory).toEqual([{ account_id: "account-a", category_id: "fincat:logement" }]);
      expect(
        (
          await device.db.select<{ default_account_id: string }[]>(
            "SELECT default_account_id FROM finance_import_profiles ORDER BY id",
          )
        ).map((row) => row.default_account_id),
      ).toEqual(["account-a", "account-a"]);
      expect(
        (
          await device.db.select<{ account_id: string }[]>(
            "SELECT account_id FROM finance_recurring_series",
          )
        ).map((row) => row.account_id),
      ).toEqual(["account-a"]);
      expect(
        (
          await device.db.select<{ account_id: string }[]>(
            "SELECT DISTINCT account_id FROM finance_import_batches",
          )
        ).map((row) => row.account_id),
      ).toEqual(["account-a"]);
      // The two statements are one: one transaction per line, with the hash an import into
      // account-a would give, so a re-import of the same file adds nothing.
      const before = (await transactionsOf(device)).length;
      await device.repo.importFinanceTransactions(
        importRequest(
          rows().map((row) => ({ ...row, accountId: "account-a" })),
          { accountId: "account-a", fileHash: "hash-again" },
        ),
      );
      expect((await transactionsOf(device)).length).toBe(before);
      expect(await aliasRows(device)).toEqual(
        expect.arrayContaining([
          { entity_type: "finance_accounts", alias_id: "account-b", canonical_id: "account-a" },
        ]),
      );
    }
    await sim.syncAll("finance");
    for (const device of [a, b]) await expectNothingToStamp(device);
    await sim.expectConverged("finance", { snapshots: true, exact: true });
  });
});

describe("three laptops import the same statement", () => {
  const orders = [
    ["A>B", "B>C", "C>A", "A>B", "B>C"],
    ["C>B", "B>A", "A>C", "C>B", "B>A"],
    ["A>C", "C>B", "B>A", "A>C", "C>B"],
    ["B>A", "B>C", "A>C", "C>A", "A>B"],
    ["C>A", "A>B", "B>C", "C>A", "A>B"],
    ["B>C", "C>A", "A>B", "B>C", "C>A"],
  ];

  it.each(orders)(
    "converges to one transaction per line in the order %s %s %s %s %s",
    async (...order) => {
      const { sim } = await bothImported(["A", "B", "C"]);
      const [a, b, c] = sim.devices as [SyncDevice, SyncDevice, SyncDevice];
      // Each laptop has its own edit of the same line, so all three copies carry something.
      const edits: [SyncDevice, string][] = [
        [a, "fincat:logement"],
        [b, "fincat:transport"],
        [c, "fincat:alimentation.epicerie"],
      ];
      for (const [device, category] of edits) {
        device.clock.advance(10_000);
        await device.repo.setFinanceTransactionCategory({
          transactionId: (await transactionByAmount(device, -1000)).id,
          categoryId: category,
          scope: "this",
        });
      }
      await exchangeInOrder(sim, order);
      await sim.syncAll("finance");

      for (const device of sim.devices) {
        expect(await transactionsOf(device)).toHaveLength(3);
        // The latest of the three concurrent user decisions wins, everywhere.
        expect(await transactionByAmount(device, -1000)).toMatchObject({
          categoryId: "fincat:alimentation.epicerie",
          categorySource: "user",
        });
        const aliases = await aliasRows(device);
        expect(aliases).toHaveLength(6);
        expect(new Set(aliases.map((row) => row.canonical_id)).size).toBe(3);
        await expectNothingToStamp(device);
      }
      await sim.expectConverged("finance", { snapshots: true, exact: true });
    },
  );
});

describe("references of a transaction that becomes an alias", () => {
  it("rewrites transfer groups, suggestions and the splits of the losing unit", async () => {
    const { sim, a, b } = await bothImported();
    const idsA = new Map((await transactionsOf(a)).map((txn) => [txn.amountMinor, txn.id]));
    const idsB = new Map((await transactionsOf(b)).map((txn) => [txn.amountMinor, txn.id]));
    // A pairs two of its transactions as a transfer; B suggests a category for one of them.
    await a.repo.setFinanceTransfer({
      transactionIdA: idsA.get(-1000) as string,
      transactionIdB: idsA.get(-2000) as string,
    });
    const groupBefore = (await transactionByAmount(a, -1000)).transferGroupId;
    expect(groupBefore).toBe(`transfer:${[idsA.get(-1000), idsA.get(-2000)].sort().join(":")}`);
    await b.repo.saveFinanceCategorySuggestions([suggestion("s-b", idsB.get(-1000) as string)]);

    await sim.syncAll("finance");

    const canonical = (amount: number) => [idsA.get(amount), idsB.get(amount)].sort()[0] as string;
    for (const device of [a, b]) {
      const alpha = await transactionByAmount(device, -1000);
      const bravo = await transactionByAmount(device, -2000);
      expect(alpha.transferGroupId).toBe(
        `transfer:${[canonical(-1000), canonical(-2000)].sort().join(":")}`,
      );
      expect(bravo.transferGroupId).toBe(alpha.transferGroupId);
      expect(alpha.isTransfer).toBe(true);
      expect(
        await device.db.select<{ transaction_id: string }[]>(
          "SELECT transaction_id FROM finance_category_suggestions WHERE id = 's-b'",
        ),
      ).toEqual([{ transaction_id: canonical(-1000) }]);
      await expectNothingToStamp(device);
    }
    await sim.expectConverged("finance", { snapshots: true, exact: true });
  });

  it("composes with the pending-suggestion rule: two pending suggestions for one line keep the later one", async () => {
    const { sim, a, b } = await bothImported();
    const idsA = await transactionByAmount(a, -3000);
    const idsB = await transactionByAmount(b, -3000);
    await a.repo.saveFinanceCategorySuggestions([suggestion("s-a", idsA.id)]);
    b.clock.advance(60_000);
    await b.repo.saveFinanceCategorySuggestions([
      suggestion("s-b", idsB.id, { suggestedCategoryId: "fincat:transport" }),
    ]);

    await sim.exchange(a, b, "finance");
    await sim.exchange(b, a, "finance");
    await sim.syncAll("finance");

    for (const device of [a, b]) {
      const rows = await device.db.select<{ id: string; status: string; transaction_id: string }[]>(
        "SELECT id, status, transaction_id FROM finance_category_suggestions ORDER BY id",
      );
      const canonical = [idsA.id, idsB.id].sort()[0];
      expect(rows).toEqual([
        { id: "s-a", status: "expired", transaction_id: canonical },
        { id: "s-b", status: "pending", transaction_id: canonical },
      ]);
      await expectNothingToStamp(device);
    }
    expect((await readConflicts(b)).filter((row) => row.kind === "pending_collision")).toHaveLength(
      1,
    );
    await sim.expectConverged("finance", { snapshots: true, exact: true });
  });

  it("the unit of the winning copy brings its splits; the losing copy's splits are removed with their meta", async () => {
    const { sim, a, b } = await bothImported();
    const alphaA = await transactionByAmount(a, -1000);
    const alphaB = await transactionByAmount(b, -1000);
    a.clock.advance(1_000);
    await a.repo.saveFinanceTransactionSplits(alphaA.id, [
      splitOf(alphaA.id, -300, "fincat:alimentation.epicerie", "split-a-1"),
      splitOf(alphaA.id, -700, "fincat:logement", "split-a-2"),
    ]);
    b.clock.advance(600_000);
    await b.repo.saveFinanceTransactionSplits(alphaB.id, [
      splitOf(alphaB.id, -500, "fincat:transport", "split-b-1"),
      splitOf(alphaB.id, -500, "fincat:logement", "split-b-2"),
    ]);

    await sim.syncAll("finance");

    for (const device of [a, b]) {
      const splits = await device.db.select<{ id: string; transaction_id: string }[]>(
        "SELECT id, transaction_id FROM finance_transaction_splits ORDER BY id",
      );
      const canonical = [alphaA.id, alphaB.id].sort()[0];
      // Both users decided; the later (B's) unit wins as a set and A's two splits are gone.
      expect(splits).toEqual([
        { id: "split-b-1", transaction_id: canonical },
        { id: "split-b-2", transaction_id: canonical },
      ]);
      expect(
        await device.db.select(
          "SELECT entity_id FROM sync_entity_meta WHERE entity_type = 'finance_transaction_splits' AND entity_id LIKE 'split-a-%'",
        ),
      ).toEqual([]);
      expect(
        await device.db.select(
          "SELECT entity_id FROM sync_entity_snapshot WHERE entity_type = 'finance_transaction_splits' AND entity_id LIKE 'split-a-%'",
        ),
      ).toEqual([]);
      await expectNothingToStamp(device);
    }
    await sim.expectConverged("finance", { snapshots: true, exact: true });
  });
});

describe("which copy's splits survive", () => {
  // "txn-a" is canonical (the smaller id). Whichever laptop holds the winning unit, exactly its
  // splits remain, under "txn-a"; the other copy's splits leave no row, meta or snapshot behind.
  it.each([
    ["the canonical copy's unit is later", "A", "B"],
    ["the alias copy's unit is later", "B", "A"],
  ])("%s", async (_name, later, earlier) => {
    const sim = await createSyncHarness(["A", "B"]);
    const [a, b] = [sim.device("A"), sim.device("B")];
    await a.repo.saveFinanceAccount(financeAccount());
    await sim.syncAll("finance");
    await a.repo.saveFinanceTransaction(financeTransaction("txn-a"));
    await b.repo.saveFinanceTransaction(financeTransaction("txn-z"));
    const holder = (name: string) =>
      name === "A" ? { device: a, id: "txn-a" } : { device: b, id: "txn-z" };
    for (const [name, delay] of [
      [earlier, 1_000],
      [later, 600_000],
    ] as const) {
      const { device, id } = holder(name);
      device.clock.advance(delay);
      await device.repo.saveFinanceTransactionSplits(id, [
        splitOf(id, -400, "fincat:transport", `split-${name}-1`),
        splitOf(id, -600, "fincat:logement", `split-${name}-2`),
      ]);
    }

    await sim.syncAll("finance");

    for (const device of [a, b]) {
      expect(
        await device.db.select(
          "SELECT id, transaction_id FROM finance_transaction_splits ORDER BY id",
        ),
      ).toEqual([
        { id: `split-${later}-1`, transaction_id: "txn-a" },
        { id: `split-${later}-2`, transaction_id: "txn-a" },
      ]);
      for (const table of ["sync_entity_meta", "sync_entity_snapshot"]) {
        expect(
          await device.db.select(
            `SELECT entity_id FROM ${table} WHERE entity_type = 'finance_transaction_splits' AND entity_id LIKE 'split-${earlier}-%'`,
          ),
          table,
        ).toEqual([]);
        expect(
          await device.db.select(
            `SELECT entity_id FROM ${table} WHERE entity_type = 'finance_transactions' AND entity_id = 'txn-z'`,
          ),
          table,
        ).toEqual([]);
      }
      expect(await transactionsOf(device)).toHaveLength(1);
      await expectNothingToStamp(device);
    }
    await sim.expectConverged("finance", { snapshots: true, exact: true });
  });
});

describe("an alias learned for two rows the laptop already holds", () => {
  // Two copies that differ in their natural key here (so they never collided) are declared one by an
  // incoming alias row: the engine merges the two LOCAL rows by the normal rules.
  it.each([
    ["the canonical copy's unit is later", "txn-a", "txn-z"],
    ["the alias copy's unit is later", "txn-z", "txn-a"],
  ])("%s", async (_name, later, earlier) => {
    const sim = await createSyncHarness(["A", "B"]);
    const [a, b] = [sim.device("A"), sim.device("B")];
    await a.repo.saveFinanceAccount(financeAccount());
    await a.repo.saveFinanceTransaction(financeTransaction("txn-a", { dedupeHash: "line-1" }));
    await a.repo.saveFinanceTransaction(
      financeTransaction("txn-z", { dedupeHash: "line-2", notes: "note on the alias copy" }),
    );
    await a.repo.saveFinanceCategorySuggestions([suggestion("s-on-alias", "txn-z")]);
    a.clock.advance(5_000);
    await a.repo.saveFinanceCategorySuggestions([
      suggestion("s-on-canonical", "txn-a", { suggestedCategoryId: "fincat:transport" }),
    ]);
    for (const [id, delay] of [
      [earlier, 1_000],
      [later, 600_000],
    ] as const) {
      a.clock.advance(delay);
      await a.repo.saveFinanceTransactionSplits(id, [
        splitOf(id, -400, "fincat:transport", `split-${id}-1`),
        splitOf(id, -600, "fincat:logement", `split-${id}-2`),
      ]);
    }
    const declared = jsonRoundTrip(await b.repo.listSyncChanges("finance"));
    declared.aliases = [
      {
        entity_type: "finance_transactions",
        alias_id: "txn-z",
        canonical_id: "txn-a",
        recorded_hlc: declared.hlcHigh,
      },
    ];

    await a.repo.applySyncBundle("finance", declared);

    expect((await transactionsOf(a)).map((txn) => txn.id)).toEqual(["txn-a"]);
    // The row follows the row clock (whole-row last writer wins): the copy whose splits were saved
    // later is the later write, so its note (or lack of one) stands.
    expect(await transactionByAmount(a, -1000)).toMatchObject({
      id: "txn-a",
      notes: later === "txn-z" ? "note on the alias copy" : null,
      categorySource: "user",
    });
    expect(
      await a.db.select("SELECT id, transaction_id FROM finance_transaction_splits ORDER BY id"),
    ).toEqual([
      { id: `split-${later}-1`, transaction_id: "txn-a" },
      { id: `split-${later}-2`, transaction_id: "txn-a" },
    ]);
    // Two pending suggestions for one transaction now: the later row clock stays pending.
    expect(
      await a.db.select(
        "SELECT id, status, transaction_id FROM finance_category_suggestions ORDER BY id",
      ),
    ).toEqual([
      { id: "s-on-alias", status: "expired", transaction_id: "txn-a" },
      { id: "s-on-canonical", status: "pending", transaction_id: "txn-a" },
    ]);
    expect((await readConflicts(a)).filter((row) => row.kind === "pending_collision")).toHaveLength(
      1,
    );
    for (const table of ["sync_entity_meta", "sync_entity_snapshot"]) {
      expect(
        await a.db.select(
          `SELECT entity_id FROM ${table} WHERE entity_id = 'txn-z' OR entity_id LIKE 'split-${earlier}-%'`,
        ),
        table,
      ).toEqual([]);
    }
    await expectNothingToStamp(a);
    // Re-applying the same declaration changes nothing.
    expect(await a.repo.applySyncBundle("finance", declared)).toMatchObject({ applied: 0 });
  });
});

describe("one bundle that holds an alias row next to its canonical row", () => {
  // A sender that wrote a row under an alias id after it learned the alias holds both. Rewriting
  // makes them one id: they are applied one after the other in the order of their clocks, each with
  // only the splits that named it.
  it.each([false, true])(
    "applies each version with its own splits (entities reversed: %s)",
    async (reversed) => {
      const sim = await createSyncHarness(["A", "B"]);
      const [a, b] = [sim.device("A"), sim.device("B")];
      await a.repo.saveFinanceAccount(financeAccount());
      await sim.syncAll("finance");
      await a.repo.saveFinanceTransaction(financeTransaction("txn-a", { dedupeHash: "line-1" }));
      await b.repo.saveFinanceTransaction(financeTransaction("txn-z", { dedupeHash: "line-2" }));
      a.clock.advance(1_000);
      await a.repo.saveFinanceTransactionSplits("txn-a", [
        splitOf("txn-a", -500, "fincat:transport", "split-a-1"),
        splitOf("txn-a", -500, "fincat:logement", "split-a-2"),
      ]);
      b.clock.advance(600_000);
      await b.repo.saveFinanceTransactionSplits("txn-z", [
        splitOf("txn-z", -1000, "fincat:transport", "split-z-1"),
      ]);

      const fromA = jsonRoundTrip(await a.repo.listSyncChanges("finance"));
      const fromB = jsonRoundTrip(await b.repo.listSyncChanges("finance"));
      const pick = (set: typeof fromA, ids: string[]) =>
        set.entities.filter(
          (entity) =>
            ids.includes(entity.entityId) ||
            (entity.table === "finance_transaction_splits" &&
              ids.includes(String(entity.row?.transaction_id))),
        );
      const entities = [...pick(fromA, ["txn-a"]), ...pick(fromB, ["txn-z"])];
      const hybrid = {
        ...fromA,
        entities: reversed ? entities.reverse() : entities,
        aliases: [
          {
            entity_type: "finance_transactions",
            alias_id: "txn-z",
            canonical_id: "txn-a",
            recorded_hlc: fromB.hlcHigh,
          },
        ],
        hlcHigh: [fromA.hlcHigh, fromB.hlcHigh].sort().at(-1) as string,
      };

      const replica = (await createSyncHarness(1, { deviceIndexOffset: 30 })).device("A");
      await replica.repo.saveFinanceAccount(financeAccount());
      await replica.repo.applySyncBundle("finance", hybrid);

      expect((await transactionsOf(replica)).map((txn) => txn.id)).toEqual(["txn-a"]);
      // B's unit is the later write and brings its one split; A's two are not mixed in.
      expect(
        await replica.db.select(
          "SELECT id, transaction_id FROM finance_transaction_splits ORDER BY id",
        ),
      ).toEqual([{ id: "split-z-1", transaction_id: "txn-a" }]);
      await expectNothingToStamp(replica);
    },
  );
});

describe("an account alias that makes two local transactions one", () => {
  // The laptop holds two accounts that nothing said were one, each with the same statement line
  // (different account id, so different hash). Learning that the accounts are one moves the
  // transactions of the alias account to the canonical one, re-derives their hash and makes them
  // collide with the canonical account's transactions: the pair becomes a transaction alias, whichever
  // of the two ids is the smaller.
  it.each([
    ["the transaction that has to move is canonical", "txn-1", "txn-9"],
    ["the transaction that has to move is the alias", "txn-9", "txn-1"],
  ])("%s", async (_name, idOfAliasAccountLine, idOfCanonicalAccountLine) => {
    const sim = await createSyncHarness(["A", "B"]);
    const [a, b] = [sim.device("A"), sim.device("B")];
    await a.repo.saveFinanceAccount(financeAccount({ id: "account-a" }));
    await a.repo.saveFinanceAccount(financeAccount({ id: "account-b" }));
    const line = {
      postedDate: "2026-04-01",
      amountMinor: -1000,
      currency: "CAD",
      descriptionRaw: "ALPHA 1",
    };
    await a.repo.saveFinanceTransaction(
      financeTransaction(idOfCanonicalAccountLine, {
        accountId: "account-a",
        dedupeHash: dedupeHash({ ...line, accountId: "account-a", occurrenceIndex: 0 }),
      }),
    );
    a.clock.advance(1_000);
    await a.repo.saveFinanceTransaction(
      financeTransaction(idOfAliasAccountLine, {
        accountId: "account-b",
        dedupeHash: dedupeHash({ ...line, accountId: "account-b", occurrenceIndex: 0 }),
        notes: "kept from the other account",
      }),
    );
    a.clock.advance(1_000);
    await a.repo.saveFinanceTransactionSplits(idOfAliasAccountLine, [
      splitOf(idOfAliasAccountLine, -1000, "fincat:transport", "split-moved"),
    ]);
    const declared = jsonRoundTrip(await b.repo.listSyncChanges("finance"));
    declared.aliases = [
      {
        entity_type: "finance_accounts",
        alias_id: "account-b",
        canonical_id: "account-a",
        recorded_hlc: declared.hlcHigh,
      },
    ];

    await a.repo.applySyncBundle("finance", declared);

    const canonical = ["txn-1", "txn-9"].sort()[0];
    expect(
      await a.db.select("SELECT id, account_id, dedupe_hash, notes FROM finance_transactions"),
    ).toEqual([
      {
        id: canonical,
        account_id: "account-a",
        dedupe_hash: dedupeHash({ ...line, accountId: "account-a", occurrenceIndex: 0 }),
        notes: "kept from the other account",
      },
    ]);
    expect(await a.db.select("SELECT id, transaction_id FROM finance_transaction_splits")).toEqual([
      { id: "split-moved", transaction_id: canonical },
    ]);
    expect((await a.repo.listFinanceAccounts()).map((account) => account.id)).toEqual([
      "account-a",
    ]);
    expect(
      (await aliasRows(a)).map((row) => [row.entity_type, row.alias_id, row.canonical_id]),
    ).toEqual([
      ["finance_accounts", "account-b", "account-a"],
      [
        "finance_transactions",
        idOfCanonicalAccountLine === canonical ? idOfAliasAccountLine : idOfCanonicalAccountLine,
        canonical,
      ],
    ]);
    await expectNothingToStamp(a);
    expect(await a.repo.applySyncBundle("finance", declared)).toMatchObject({ applied: 0 });
  });
});

describe("import profiles with one signature", () => {
  it("merges them and re-points the batches that used either", async () => {
    const sim = await createSyncHarness(["A", "B"]);
    const [a, b] = [sim.device("A"), sim.device("B")];
    await a.repo.saveFinanceAccount(financeAccount());
    await sim.syncAll("finance");
    await a.repo.saveFinanceImportProfile(importProfile("profile-z", "same-layout"));
    b.clock.advance(5_000);
    await b.repo.saveFinanceImportProfile(importProfile("profile-b", "same-layout"));
    await a.repo.importFinanceTransactions(importRequest(rows(), { profileId: "profile-z" }));
    await b.repo.importFinanceTransactions(
      importRequest(rows().slice(0, 1), { profileId: "profile-b", fileHash: "hash-b" }),
    );

    await sim.syncAll("finance");

    for (const device of [a, b]) {
      expect((await device.repo.listFinanceImportProfiles()).map((profile) => profile.id)).toEqual([
        "profile-b",
      ]);
      expect(
        await device.db.select("SELECT DISTINCT profile_id FROM finance_import_batches"),
      ).toEqual([{ profile_id: "profile-b" }]);
      expect(await aliasRows(device)).toEqual(
        expect.arrayContaining([
          {
            entity_type: "finance_import_profiles",
            alias_id: "profile-z",
            canonical_id: "profile-b",
          },
        ]),
      );
      await expectNothingToStamp(device);
    }
    await sim.expectConverged("finance", { snapshots: true, exact: true });
  });
});

describe("rows that still carry an alias id", () => {
  it("a peer that never learned the alias keeps publishing it: its rows merge into the canonical ones", async () => {
    const { sim, a, b } = await bothImported();
    await sim.syncAll("finance");
    const canonicalAlpha = (await transactionByAmount(a, -1000)).id;
    // D shares nothing with A and B: it holds its own copy of the same statement.
    const stale = await createSyncHarness(["D"], { deviceIndexOffset: 5 });
    const d = stale.device("D");
    await d.repo.saveFinanceAccount(financeAccount());
    await d.repo.importFinanceTransactions(importRequest(rows()));
    d.clock.advance(3_600_000);
    const alphaD = await transactionByAmount(d, -1000);
    await d.repo.saveFinanceTransaction({ ...alphaD, notes: "annotated at D" });

    await a.repo.applySyncBundle("finance", jsonRoundTrip(await d.repo.listSyncChanges("finance")));

    const txns = await transactionsOf(a);
    expect(txns).toHaveLength(3);
    // A third id joins the class: the smallest of the three is canonical.
    expect(await transactionByAmount(a, -1000)).toMatchObject({
      id: [canonicalAlpha, alphaD.id].sort()[0],
      notes: "annotated at D",
    });
    await expectNothingToStamp(a);
    await sim.syncAll("finance");
    expect(await transactionsOf(b)).toHaveLength(3);
  });

  it("a write that used the alias id after the alias was learned is healed on the next apply", async () => {
    const { sim, a, b } = await bothImported();
    await sim.syncAll("finance");
    const canonicalAlpha = (await transactionByAmount(a, -1000)).id;
    const aliasAlpha = (await aliasRows(a)).find((row) => row.canonical_id === canonicalAlpha)
      ?.alias_id as string;
    expect(aliasAlpha).toBeDefined();
    // A suggestion and a split are saved against the alias id (a screen that still held it).
    a.clock.advance(1_000);
    await a.repo.saveFinanceCategorySuggestions([suggestion("s-late", aliasAlpha)]);
    expect(
      await a.db.select(
        "SELECT transaction_id FROM finance_category_suggestions WHERE id = 's-late'",
      ),
    ).toEqual([{ transaction_id: aliasAlpha }]);

    // Any later apply puts the reference right, without a clock.
    await a.repo.applySyncBundle("finance", jsonRoundTrip(await b.repo.listSyncChanges("finance")));
    expect(
      await a.db.select(
        "SELECT transaction_id FROM finance_category_suggestions WHERE id = 's-late'",
      ),
    ).toEqual([{ transaction_id: canonicalAlpha }]);
    await expectNothingToStamp(a);
  });
});

describe("statement balance anchors of two accounts that become one", () => {
  it("keeps one standing anchor under the canonical account", async () => {
    const sim = await createSyncHarness(["A", "B"]);
    const [a, b] = [sim.device("A"), sim.device("B")];
    await a.repo.saveFinanceAccount(financeAccount({ id: "account-a", externalKey: "VISA" }));
    b.clock.advance(5_000);
    await b.repo.saveFinanceAccount(financeAccount({ id: "account-b", externalKey: "VISA" }));
    await a.repo.applyFinanceStatementBalance({
      accountId: "account-a",
      statementDate: "2026-09-30",
      balanceMinor: 100_000,
    });
    b.clock.advance(60_000);
    await b.repo.applyFinanceStatementBalance({
      accountId: "account-b",
      statementDate: "2026-10-31",
      balanceMinor: 120_000,
    });

    await sim.syncAll("finance");

    for (const device of [a, b]) {
      expect(
        await device.db.select(
          "SELECT account_id, as_of_date FROM finance_account_balance_snapshots WHERE source = 'statement'",
        ),
      ).toEqual([{ account_id: "account-a", as_of_date: "2026-10-31" }]);
      await expectNothingToStamp(device);
    }
    await sim.expectConverged("finance", { snapshots: true, exact: true });
  });
});

describe("a delete of one copy of an aliased transaction", () => {
  it("is edit-wins against a later edit of the other copy, delete-wins against an earlier one", async () => {
    for (const editLater of [true, false]) {
      const { sim, a, b } = await bothImported();
      await sim.exchange(b, a, "finance"); // A learns the alias, B has not heard of it
      const batchB = (await b.repo.listFinanceImportBatches())[0]?.id as string;
      b.clock.advance(1_000);
      await b.repo.undoFinanceImportBatch(batchB); // B deletes ITS copies (alias ids)
      a.clock.advance(editLater ? 600_000 : -3_000);
      await a.repo.bulkUpdateFinanceTransactions([(await transactionByAmount(a, -2000)).id], {
        excludedFromReports: true,
      });
      await sim.syncAll("finance");
      for (const device of [a, b]) {
        const amounts = (await transactionsOf(device)).map((txn) => txn.amountMinor).sort();
        // The edited line survives (edit wins) only when the edit is not older than the delete.
        expect(amounts, `editLater=${editLater} on ${device.name}`).toEqual(
          editLater ? [-2000] : [],
        );
        await expectNothingToStamp(device);
      }
      await sim.expectConverged("finance", { snapshots: true, exact: true });
    }
  });
});
