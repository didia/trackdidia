// @vitest-environment node
import { afterAll, describe, expect, it } from "vitest";
import type { SyncChangeSet } from "./change-set";
import type { SyncDomain } from "./registry";
import { financeAccount, importRequest, importRow, splitOf } from "./test-support/finance-fixtures";
import {
  createSyncHarness,
  HARNESS_START_MS,
  jsonRoundTrip,
  type SyncDevice,
  type SyncHarness,
} from "./test-support/two-device-harness";

/**
 * Convergence of canonical identity by randomized scenario. Three laptops mint DIFFERENT ids for the
 * SAME things: they import the same statement lines (one `(account_id, dedupe_hash)` per line, a
 * different transaction id on every laptop), bind the same import label to accounts of their own, and
 * create tasks and projects for the same `source_external_id`. They edit what they hold (categorize,
 * split, annotate, complete, retitle, subtask, focus) and exchange at random moments. Their final
 * bundles are then applied, shuffled and with repeats, to fresh replicas with foreign keys enforced.
 * Every replica must end byte for byte in the same state (rows, clocks, snapshots and the alias
 * classes), the state the laptops reach by exchanging everything; re-applying changes nothing and a
 * verifying scan stamps nothing. Seeded, so a failure reproduces from its seed.
 *
 * Scenario rules (the documented limits, as in the other convergence tests): nothing is deleted
 * (a tombstone carries no natural key, so it cannot name the other copy), and the scenario does not
 * race two pending suggestions (`finance-sync.scenarios.test.ts` covers that).
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
const LINES = ["ALPHA", "BRAVO", "CHARLIE", "DELTA", "ECHO"].map((merchant, index) => ({
  amountMinor: -(1000 + index),
  descriptionRaw: `${merchant} line`,
  merchantKey: merchant,
}));

// ---------------------------------------------------------------------------------------------
// Finance
// ---------------------------------------------------------------------------------------------

/** `sharedAccount`: one account everybody has; otherwise each laptop binds the same label to its own. */
const runFinance = async (seed: number, steps: number, sharedAccount: boolean) => {
  const rand = prng(seed);
  const sim = await createSyncHarness(["A", "B", "C"]);
  const accountOf = (device: SyncDevice): string =>
    sharedAccount ? "account-1" : `account-${device.name.toLowerCase()}`;

  if (sharedAccount) {
    await sim.device("A").repo.saveFinanceAccount(financeAccount());
    await sim.syncAll("finance");
  } else {
    for (const device of sim.devices) {
      device.clock.advance(1_000);
      await device.repo.saveFinanceAccount(
        financeAccount({ id: accountOf(device), externalKey: "VISA-1234" }),
      );
    }
  }

  let counter = 0;
  const op = async (device: SyncDevice) => {
    device.clock.advance(1 + Math.floor(rand() * 90_000));
    const txns = await device.repo.listFinanceTransactions({});
    switch (Math.floor(rand() * 10)) {
      case 0:
      case 1:
      case 2: {
        const line = pickOf(rand, LINES);
        await device.repo.importFinanceTransactions(
          importRequest([importRow({ ...line, accountId: accountOf(device) })], {
            accountId: accountOf(device),
            fileHash: `file-${(counter += 1)}`,
          }),
        );
        break;
      }
      case 3:
      case 4: {
        if (txns.length === 0) break;
        await device.repo.setFinanceTransactionCategory({
          transactionId: pickOf(rand, txns).id,
          categoryId: pickOf(rand, CATEGORIES),
          scope: "this",
        });
        break;
      }
      case 5: {
        if (txns.length === 0) break;
        const txn = pickOf(rand, txns);
        const first = Math.trunc(txn.amountMinor / 2);
        await device.repo.saveFinanceTransactionSplits(txn.id, [
          splitOf(txn.id, first, pickOf(rand, CATEGORIES), `sp-${device.name}-${(counter += 1)}`),
          splitOf(
            txn.id,
            txn.amountMinor - first,
            pickOf(rand, CATEGORIES),
            `sp-${device.name}-${(counter += 1)}`,
          ),
        ]);
        break;
      }
      case 6: {
        if (txns.length === 0) break;
        await device.repo.bulkUpdateFinanceTransactions([pickOf(rand, txns).id], {
          excludedFromBudget: rand() < 0.5,
        });
        break;
      }
      case 7: {
        if (txns.length === 0) break;
        await device.repo.saveFinanceTransaction({
          ...pickOf(rand, txns),
          notes: `note ${(counter += 1)}`,
        });
        break;
      }
      default: {
        const from = pickOf(rand, sim.devices);
        const to = pickOf(
          rand,
          sim.devices.filter((candidate) => candidate !== from),
        );
        await sim.exchange(from, to, "finance");
      }
    }
  };
  for (let step = 0; step < steps; step += 1) {
    await op(pickOf(rand, sim.devices));
  }
  return { sim, rand };
};

// ---------------------------------------------------------------------------------------------
// GTD
// ---------------------------------------------------------------------------------------------

const SOURCES = ["draw:1", "draw:2", "draw:3"];
const PROJECT_SOURCES = ["legacy:1", "legacy:2"];

const runGtd = async (seed: number, steps: number) => {
  const rand = prng(seed);
  const sim = await createSyncHarness(["A", "B", "C"]);
  let counter = 0;
  const id = (device: SyncDevice, prefix: string) => `${prefix}-${device.name}-${(counter += 1)}`;

  const op = async (device: SyncDevice) => {
    device.clock.advance(1 + Math.floor(rand() * 90_000));
    const tasks = await device.repo.listTasks({ includeCompleted: true });
    const projects = await device.repo.listProjects();
    switch (Math.floor(rand() * 13)) {
      case 0:
      case 1: {
        const source = pickOf(rand, SOURCES);
        if (tasks.some((task) => task.sourceExternalId === source)) break;
        await device.repo.createTask({
          id: id(device, "task"),
          title: `Draw ${source} (${device.name})`,
          bucket: "next_action",
          sourceExternalId: source,
        });
        break;
      }
      case 2: {
        const source = pickOf(rand, PROJECT_SOURCES);
        if (projects.some((project) => project.sourceExternalId === source)) break;
        await device.repo.saveProject({
          id: id(device, "proj"),
          title: `Project ${source} (${device.name})`,
          status: "active",
          statusChangedAt: "2026-10-01T00:00:00.000Z",
          notes: "",
          contextIds: [],
          source: "manual",
          sourceExternalId: source,
          createdAt: "2026-10-01T00:00:00.000Z",
          updatedAt: "2026-10-01T00:00:00.000Z",
        });
        break;
      }
      case 3: {
        const open = tasks.filter((task) => task.status === "active");
        if (open.length > 0) await device.repo.completeTask(pickOf(rand, open).id);
        break;
      }
      case 4: {
        if (tasks.length === 0) break;
        const task = pickOf(rand, tasks);
        await device.repo.saveTask({ ...task, title: `${task.title}.` });
        break;
      }
      case 5: {
        if (tasks.length === 0) break;
        await device.repo.createTask({
          id: id(device, "child"),
          title: "Subtask",
          bucket: "inbox",
          parentTaskId: pickOf(rand, tasks).id,
          projectId: projects.length > 0 && rand() < 0.5 ? pickOf(rand, projects).id : null,
        });
        break;
      }
      case 6: {
        const open = tasks.filter((task) => task.status === "active");
        if (open.length > 0) {
          await device.repo.moveTask(
            pickOf(rand, open).id,
            pickOf(rand, ["waiting_for", "next_action"]),
            [],
          );
        }
        break;
      }
      case 7: {
        const running = tasks.length > 0 ? pickOf(rand, tasks) : null;
        if (running === null) break;
        const started = await device.repo.startPomodoro({ kind: "focus", taskId: running.id });
        device.clock.advance(1_000);
        if (started.activeSession) {
          await device.repo.stopPomodoroSession(started.activeSession.id, "completed");
        }
        break;
      }
      default: {
        const from = pickOf(rand, sim.devices);
        const to = pickOf(
          rand,
          sim.devices.filter((candidate) => candidate !== from),
        );
        await sim.exchange(from, to, "gtd");
      }
    }
  };
  // Before anybody exchanges, most laptops mint their own task and project for each source.
  for (const device of sim.devices) {
    for (const source of SOURCES) {
      if (rand() < 0.75) {
        device.clock.advance(1_000);
        await device.repo.createTask({
          id: id(device, "task"),
          title: `Draw ${source} (${device.name})`,
          bucket: "next_action",
          sourceExternalId: source,
        });
      }
    }
    for (const source of PROJECT_SOURCES) {
      if (rand() < 0.75) {
        await device.repo.saveProject({
          id: id(device, "proj"),
          title: `Project ${source} (${device.name})`,
          status: "active",
          statusChangedAt: "2026-10-01T00:00:00.000Z",
          notes: "",
          contextIds: [],
          source: "manual",
          sourceExternalId: source,
          createdAt: "2026-10-01T00:00:00.000Z",
          updatedAt: "2026-10-01T00:00:00.000Z",
        });
      }
    }
  }
  for (let step = 0; step < steps; step += 1) {
    await op(pickOf(rand, sim.devices));
  }
  return { sim, rand };
};

// ---------------------------------------------------------------------------------------------
// Shared checks
// ---------------------------------------------------------------------------------------------

/**
 * The comparable state. The class clock of an alias (`recorded_hlc`) is informational and joins by
 * maximum, so replicas that learned the same classes through different histories agree on it only
 * once they have exchanged; the replicas of this test never do, so it is left out here and compared
 * where laptops have exchanged (`expectConverged`).
 */
const stateOf = async (
  sim: SyncHarness,
  device: SyncDevice,
  domain: SyncDomain,
): Promise<string> => {
  const dump = await sim.dump(device, domain, { snapshots: true, exact: true });
  return JSON.stringify({
    ...dump,
    aliases: dump.aliases.map(({ recorded_hlc: _clock, ...alias }) => alias),
  });
};

/** How many alias rows the scenarios produced, so the test cannot pass without exercising aliasing. */
const produced = { finance: 0, gtd: 0 };

const checkConvergence = async (
  sim: SyncHarness,
  rand: () => number,
  domain: SyncDomain,
): Promise<void> => {
  const bundles: SyncChangeSet[] = [];
  for (const device of sim.devices) {
    bundles.push(jsonRoundTrip(await device.repo.listSyncChanges(domain)));
  }
  produced[domain === "gtd" ? "gtd" : "finance"] += bundles.reduce(
    (total, bundle) => total + bundle.aliases.length,
    0,
  );
  const replicas = await createSyncHarness(4, {
    deviceIndexOffset: 10,
    startMs: HARNESS_START_MS - 3_600_000,
  });
  const states: string[] = [];
  for (const replica of replicas.devices) {
    const order = shuffled(rand, bundles);
    const repeats = shuffled(rand, bundles).slice(0, 3);
    for (const changeSet of shuffled(rand, [...order, ...repeats])) {
      await replica.repo.applySyncBundle(domain, changeSet);
    }
    expect(await replica.db.select("PRAGMA foreign_key_check")).toEqual([]);
    states.push(await stateOf(replicas, replica, domain));
  }
  for (const state of states.slice(1))
    expect(JSON.parse(state)).toEqual(JSON.parse(states[0] as string));

  // Idempotence and a clean verifying scan.
  const first = replicas.devices[0] as SyncDevice;
  for (const changeSet of bundles) {
    expect(await first.repo.applySyncBundle(domain, changeSet)).toMatchObject({
      applied: 0,
      tombstonesApplied: 0,
    });
  }
  expect(await first.repo.enableSyncCapture()).toEqual({ installed: false, backfilled: 0 });

  // The laptops converge to the same state once they exchange everything.
  await sim.syncAll(domain);
  await sim.expectConverged(domain, { snapshots: true, exact: true });
  for (const device of sim.devices) {
    expect(JSON.parse(await stateOf(sim, device, domain))).toEqual(JSON.parse(states[0] as string));
    expect(await device.repo.enableSyncCapture()).toEqual({ installed: false, backfilled: 0 });
  }
};

const SEEDS = Array.from({ length: 12 }, (_, index) => index + 1);

describe("canonical identity converges in any application order", () => {
  afterAll(() => {
    // Every kind of scenario really minted colliding ids.
    expect(produced.finance).toBeGreaterThan(50);
    expect(produced.gtd).toBeGreaterThan(100);
  });

  for (const seed of SEEDS) {
    it(`finance, one shared account, seed ${seed}`, async () => {
      const { sim, rand } = await runFinance(seed, 90, true);
      await checkConvergence(sim, rand, "finance");
    }, 120_000);

    it(`finance, accounts bound by import label, seed ${seed}`, async () => {
      const { sim, rand } = await runFinance(seed + 100, 90, false);
      await checkConvergence(sim, rand, "finance");
    }, 120_000);

    it(`gtd, seed ${seed}`, async () => {
      const { sim, rand } = await runGtd(seed + 200, 100);
      await checkConvergence(sim, rand, "gtd");
    }, 120_000);
  }
});
