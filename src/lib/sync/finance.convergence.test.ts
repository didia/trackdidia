// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { FinanceCategorySuggestion } from "../../domain/finance";
import type { AiMemory } from "../../domain/types";
import type { SyncChangeSet } from "./change-set";
import type { SyncDomain } from "./registry";
import {
  financeAccount,
  financeRule,
  importRequest,
  importRow,
  splitOf,
} from "./test-support/finance-fixtures";
import {
  createSyncHarness,
  HARNESS_START_MS,
  jsonRoundTrip,
  type SyncDevice,
  type SyncHarness,
} from "./test-support/two-device-harness";

/**
 * Convergence by randomized scenario for every table the finance slice merges. Three laptops make
 * random edits through the real repository and finance-store methods (imports, categorizations,
 * splits, rules, memory, budget, statements, suggestions, AI memories) and exchange at random
 * moments; then the final bundles of each domain are applied, in shuffled orders and with repeats,
 * to fresh replicas with foreign keys enforced. Every replica must hold identical rows, clocks and
 * snapshots of these tables. The operation generator is seeded, but a run is only deterministic in its
 * shape: entity ids are random UUIDs and finance timestamps use the real clock, so a failure may not
 * reproduce from its seed (rerun it, and look at the diff of the two states).
 *
 * Scenario rules (the documented limits of resurrection, as in `classes.convergence.test.ts`): a
 * delete never races an edit by ANOTHER laptop. Rules are created, edited and deleted only by their
 * author; the "doomed" import batch is undone only by laptop A, and only A re-runs the automatic
 * stages (which may rewrite non-user rows, the doomed one included), so nobody else touches its
 * rows. The pending suggestions live on rows of their own that no categorization, rule or memory
 * reaches, and each such row is owned by one laptop, which alone creates and decides its suggestion:
 * a pending-key collision that is resolved before one contender is decided or deleted elsewhere
 * converges by exchange, not in one pass (`finance-sync.scenarios.test.ts` covers the collision and
 * that race). Natural keys are never duplicated here (imports are unique per laptop, there is
 * one account): colliding natural keys are resolved by canonical identity and have their own
 * randomized suite (`canonical-identity.convergence.test.ts`).
 */

const prng = (seed: number) => {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
};
const pickOf = <T>(rand: () => number, items: readonly T[]): T =>
  items[Math.floor(rand() * items.length)] as T;
const shuffled = <T>(rand: () => number, items: readonly T[]): T[] => {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(rand() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap] as T, copy[index] as T];
  }
  return copy;
};

const CATEGORIES = [
  "fincat:alimentation.epicerie",
  "fincat:alimentation.restaurants",
  "fincat:logement",
  "fincat:transport",
];
const MERCHANTS = ["ALPHA", "BRAVO", "CHARLIE"];

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

const runScenario = async (seed: number, steps: number) => {
  const rand = prng(seed);
  const sim = await createSyncHarness(["A", "B", "C"]);
  const [a] = sim.devices as [SyncDevice, SyncDevice, SyncDevice];
  let counter = 0;
  const next = (prefix: string) => `${prefix}${(counter += 1)}`;

  await a.repo.seedFinanceDefaultCategories();
  await a.repo.saveFinanceAccount(financeAccount());
  await a.repo.importFinanceTransactions(
    importRequest(
      MERCHANTS.map((merchant, index) =>
        importRow({
          amountMinor: -(1000 + index),
          descriptionRaw: `${merchant} seed`,
          merchantKey: merchant,
        }),
      ),
      { fileHash: "seed" },
    ),
  );
  // The batch laptop A will undo later: only A ever touches these rows.
  await a.repo.importFinanceTransactions(
    importRequest(
      [importRow({ amountMinor: -9001, descriptionRaw: "DOOMED 1", merchantKey: "DOOMED" })],
      { fileHash: "doomed" },
    ),
  );
  const doomedBatch = (await a.repo.listFinanceImportBatches())[0]?.id as string;
  // The rows pending suggestions are created for: no rule, memory or categorization ever reaches them.
  await a.repo.importFinanceTransactions(
    importRequest(
      [1, 2, 3].map((index) =>
        importRow({
          amountMinor: -(7000 + index),
          descriptionRaw: `SUGGONLY ${index}`,
          merchantKey: "SUGGONLY",
        }),
      ),
      { fileHash: "suggestions" },
    ),
  );
  await sim.syncAll("finance");

  const sharedTransactions = async (device: SyncDevice) =>
    (await device.repo.listFinanceTransactions({}))
      .filter((txn) => !/^(DOOMED|SUGGONLY)/.test(txn.descriptionRaw))
      .map((txn) => txn.id);
  const suggestionTargets = async (device: SyncDevice) =>
    (await device.repo.listFinanceTransactions({}))
      .filter((txn) => txn.descriptionRaw === `SUGGONLY ${sim.devices.indexOf(device) + 1}`)
      .map((txn) => txn.id);

  const op = async (device: SyncDevice) => {
    device.clock.advance(1 + Math.floor(rand() * 90_000));
    const own = (suffix: string) => `${device.name}-${suffix}`;
    switch (Math.floor(rand() * 22)) {
      case 0:
      case 1: {
        await device.repo.importFinanceTransactions(
          importRequest(
            [
              importRow({
                amountMinor: -(100 + Math.floor(rand() * 5000)),
                descriptionRaw: `${pickOf(rand, MERCHANTS)} ${next(`${device.name}#`)}`,
                merchantKey: pickOf(rand, MERCHANTS),
              }),
            ],
            { fileHash: next(`file-${device.name}-`) },
          ),
        );
        break;
      }
      case 2:
      case 3: {
        const ids = await sharedTransactions(device);
        if (ids.length === 0) break;
        await device.repo.setFinanceTransactionCategory({
          transactionId: pickOf(rand, ids),
          categoryId: pickOf(rand, CATEGORIES),
          scope: "this",
        });
        break;
      }
      case 4: {
        const ids = await sharedTransactions(device);
        if (ids.length === 0) break;
        const id = pickOf(rand, ids);
        const amount = (await device.repo.getFinanceTransaction(id))?.amountMinor ?? 0;
        const first = Math.trunc(amount / 2);
        await device.repo.saveFinanceTransactionSplits(id, [
          splitOf(id, first, pickOf(rand, CATEGORIES), next(`sp-${device.name}-`)),
          splitOf(id, amount - first, pickOf(rand, CATEGORIES), next(`sp-${device.name}-`)),
        ]);
        break;
      }
      case 5: {
        // Remove the last split: the parent resets, the children go.
        const ids = await sharedTransactions(device);
        const withSplits = [];
        for (const id of ids) {
          if ((await device.repo.getFinanceTransaction(id))?.hasSplits) withSplits.push(id);
        }
        if (withSplits.length > 0) {
          await device.repo.saveFinanceTransactionSplits(pickOf(rand, withSplits), []);
        }
        break;
      }
      case 6: {
        const ids = await sharedTransactions(device);
        if (ids.length > 0) {
          await device.repo.bulkUpdateFinanceTransactions([pickOf(rand, ids)], {
            excludedFromBudget: rand() < 0.5,
          });
        }
        break;
      }
      case 7: {
        const ids = await sharedTransactions(device);
        if (ids.length === 0) break;
        const current = await device.repo.getFinanceTransaction(pickOf(rand, ids));
        if (current) await device.repo.saveFinanceTransaction({ ...current, notes: next("note ") });
        break;
      }
      case 8: {
        await device.repo.saveFinanceRule(
          financeRule(own("rule"), {
            name: next("rule name "),
            matcher: { descriptionContains: pickOf(rand, MERCHANTS) },
            actions: { categoryId: pickOf(rand, CATEGORIES) },
          }),
        );
        break;
      }
      case 9: {
        if (rand() < 0.5) await device.repo.deleteFinanceRule(own("rule")).catch(() => undefined);
        break;
      }
      case 10: {
        // The automatic stages may rewrite non-user rows (the doomed batch's too): only on A.
        if (device === a) await device.repo.reclassifyFinancePending();
        break;
      }
      case 11: {
        await device.repo.upsertFinanceMerchantMemory({
          merchantKey: pickOf(rand, MERCHANTS),
          accountId: "account-1",
          sign: -1,
          categoryId: pickOf(rand, CATEGORIES),
          hitCount: Math.floor(rand() * 5),
          correctionCount: 0,
          confidence: 0.8,
          source: "user_correction",
          lastAppliedAt: null,
          createdAt: "2026-04-01T00:00:00.000Z",
          updatedAt: "2026-04-01T00:00:00.000Z",
        });
        break;
      }
      case 12: {
        await device.repo.setFinanceBudgetAssignment(
          pickOf(rand, ["2026-09", "2026-10"]),
          pickOf(rand, CATEGORIES),
          Math.floor(rand() * 100_000),
        );
        break;
      }
      case 13: {
        await device.repo.saveFinancePerson({
          id: pickOf(rand, ["person-1", "person-2"]),
          displayName: next("person "),
          color: null,
          archived: false,
          createdAt: "",
          updatedAt: "",
        });
        break;
      }
      case 14: {
        await device.repo.saveAiMemory(
          aiMemory(pickOf(rand, ["memory-1", "memory-2"]), next("statement ")),
        );
        break;
      }
      case 15: {
        const ids = await suggestionTargets(device);
        if (ids.length === 0) break;
        const suggestion: FinanceCategorySuggestion = {
          id: next(`sug-${device.name}-`),
          transactionId: pickOf(rand, ids),
          merchantKey: "SUGGONLY",
          suggestedCategoryId: pickOf(rand, CATEGORIES),
          confidence: 0.6,
          origin: "ai",
          rationale: null,
          model: null,
          promptVersion: null,
          status: "pending",
          decidedAt: null,
          createdAt: "2026-10-01T00:00:00.000Z",
        };
        // The app never stores two pending suggestions for one transaction itself.
        await device.repo.saveFinanceCategorySuggestions([suggestion]).catch(() => undefined);
        break;
      }
      case 16: {
        const mine = new Set(await suggestionTargets(device));
        const pending = (await device.repo.listFinanceCategorySuggestions("pending")).filter(
          (suggestion) => mine.has(suggestion.transactionId),
        );
        if (pending.length === 0) break;
        const target = pickOf(rand, pending);
        // Accepting categorizes the transaction (and deletes its other pending suggestions).
        await device.repo.decideFinanceCategorySuggestion(target.id, { status: "dismissed" });
        break;
      }
      case 17: {
        await device.repo.applyFinanceStatementBalance({
          accountId: "account-1",
          statementDate: pickOf(rand, ["2026-08-31", "2026-09-30", "2026-10-31"]),
          balanceMinor: Math.floor(rand() * 1_000_000),
        });
        break;
      }
      case 18: {
        // Derived snapshots stay on the laptop.
        await device.repo.snapshotFinanceAccountBalances(
          pickOf(rand, ["2026-10-05", "2026-10-06"]),
        );
        break;
      }
      case 19: {
        if (device === a && rand() < 0.15) {
          await a.repo.undoFinanceImportBatch(doomedBatch).catch(() => undefined);
        }
        break;
      }
      default: {
        const from = pickOf(rand, sim.devices);
        const to = pickOf(
          rand,
          sim.devices.filter((candidate) => candidate !== from),
        );
        await sim.exchange(from, to, pickOf(rand, ["finance", "personal"] as const));
      }
    }
  };

  for (let step = 0; step < steps; step += 1) {
    await op(pickOf(rand, sim.devices));
  }
  return { sim, rand };
};

const TABLES = [
  "finance_people",
  "finance_accounts",
  "finance_categories",
  "finance_transactions",
  "finance_transaction_splits",
  "finance_category_suggestions",
  "finance_rules",
  "finance_merchant_memory",
  "finance_budget_entries",
  "finance_budget_months",
  "finance_recurring_series",
  "finance_import_profiles",
  "finance_import_batches",
  "finance_account_balance_snapshots",
  "ai_memories",
];

/** Rows, clocks and snapshots of the published part of these tables (derived snapshots excluded). */
const stateOf = async (sim: SyncHarness, device: SyncDevice): Promise<string> => {
  const derived = new Set(
    (
      await device.db.select<{ account_id: string; as_of_date: string }[]>(
        "SELECT account_id, as_of_date FROM finance_account_balance_snapshots WHERE source <> 'statement'",
      )
    ).map((row) => JSON.stringify([row.account_id, row.as_of_date])),
  );
  const published = (row: Record<string, unknown>): boolean =>
    row.entity_type === "finance_account_balance_snapshots"
      ? !derived.has(String(row.entity_id))
      : true;
  const parts: Record<string, unknown> = {};
  for (const domain of ["finance", "personal"] as SyncDomain[]) {
    const dump = await sim.dump(device, domain, { snapshots: true, exact: true });
    for (const table of TABLES) {
      const rows = dump.tables[table];
      if (!rows) continue;
      parts[table] =
        table === "finance_account_balance_snapshots"
          ? rows.filter((row) => row.source === "statement")
          : rows;
    }
    parts[`${domain}-meta`] = dump.meta.filter(
      (row) => TABLES.includes(String(row.entity_type)) && published(row),
    );
    parts[`${domain}-snapshots`] = (dump.snapshots ?? []).filter(
      (row) => TABLES.includes(String(row.entity_type)) && published(row),
    );
  }
  return JSON.stringify(parts);
};

const DOMAINS: SyncDomain[] = ["finance", "personal"];

describe("finance tables converge in any application order", () => {
  for (const seed of Array.from({ length: 16 }, (_, index) => index + 1)) {
    it(`seed ${seed}: shuffled orders, with repeats, on fresh replicas with foreign keys on`, async () => {
      const { sim, rand } = await runScenario(seed, 110);
      const bundles: { domain: SyncDomain; changeSet: SyncChangeSet }[] = [];
      for (const device of sim.devices) {
        for (const domain of DOMAINS) {
          bundles.push({
            domain,
            changeSet: jsonRoundTrip(await device.repo.listSyncChanges(domain)),
          });
        }
      }
      // Derived snapshots and the notification table never leave a laptop.
      for (const { changeSet } of bundles) {
        expect(JSON.stringify(changeSet)).not.toContain('"source":"derived"');
        expect(
          changeSet.entities.some((entity) => entity.table === "finance_alert_notifications"),
        ).toBe(false);
      }

      const replicas = await createSyncHarness(4, {
        deviceIndexOffset: 10,
        startMs: HARNESS_START_MS - 3_600_000,
      });
      const states: string[] = [];
      for (const replica of replicas.devices) {
        const order = shuffled(rand, bundles);
        const repeats = shuffled(rand, bundles).slice(0, 3);
        for (const { domain, changeSet } of shuffled(rand, [...order, ...repeats])) {
          await replica.repo.applySyncBundle(domain, changeSet);
        }
        expect(await replica.db.select("PRAGMA foreign_key_check")).toEqual([]);
        // At most one pending suggestion per transaction, one statement anchor per account.
        expect(
          await replica.db.select(
            "SELECT transaction_id FROM finance_category_suggestions WHERE status = 'pending' GROUP BY transaction_id HAVING COUNT(*) > 1",
          ),
        ).toEqual([]);
        expect(
          await replica.db.select(
            "SELECT account_id FROM finance_account_balance_snapshots WHERE source = 'statement' GROUP BY account_id HAVING COUNT(*) > 1",
          ),
        ).toEqual([]);
        states.push(await stateOf(replicas, replica));
      }
      for (const state of states.slice(1)) expect(state).toBe(states[0]);

      // Idempotence and a clean verifying scan.
      const first = replicas.devices[0] as SyncDevice;
      for (const { domain, changeSet } of bundles) {
        expect(await first.repo.applySyncBundle(domain, changeSet)).toMatchObject({
          applied: 0,
          tombstonesApplied: 0,
        });
      }
      expect(await first.repo.enableSyncCapture()).toMatchObject({
        installed: false,
        backfilled: 0,
        backfillComplete: true,
      });

      // The laptops converge to the same state once they exchange everything.
      for (const domain of DOMAINS) {
        await sim.syncAll(domain);
      }
      for (const device of sim.devices) {
        expect(await stateOf(sim, device)).toBe(states[0]);
      }
    }, 120_000);
  }
});
