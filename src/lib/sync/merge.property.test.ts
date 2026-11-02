// @vitest-environment node
import { describe, expect, it } from "vitest";
import { syncState } from "./capture-test-utils";
import type { SyncChangeSet } from "./change-set";
import { SYNC_DOMAINS, type SyncDomain } from "./registry";
import { diffDomainStates } from "./test-support/state-diff";
import {
  finishRunningTimers,
  newOpContext,
  type OpContext,
  pickOf,
  propertySeeds,
  prng,
  runRandomOp,
  seedScenario,
  shuffled,
  withSeedReport,
} from "./test-support/random-ops";
import {
  createSyncHarness,
  type DomainDump,
  HARNESS_START_MS,
  jsonRoundTrip,
  type SyncDevice,
  type SyncHarness,
} from "./test-support/two-device-harness";

/**
 * The merge layer's two defining properties, over random REAL repository operations on three
 * laptops (gtd, personal and finance data at once) with random exchange schedules:
 *
 * - CONVERGENCE / ORDER INDEPENDENCE. The final bundles of the three laptops, applied in any order,
 *   with repeats and with stale bundles from earlier in the run mixed in, to fresh replicas (foreign
 *   keys enforced), leave every replica in the identical canonical state; and that state is the one
 *   the three laptops reach once they exchange everything.
 * - IDEMPOTENCE. Applying a bundle that was already applied changes nothing and does not re-dirty:
 *   no row, clock or snapshot moves, `change_counter` is stable and the verifying capture scan
 *   restamps nothing.
 *
 * The schedule mixes local edits with partial exchanges (one direction, one domain), repeated
 * exchanges and replays of old bundles. What a seed does and does not fix is documented in
 * `test-support/random-ops.ts`: the operation sequence is a pure function of the seed, but ids the
 * repository mints itself and real-clock stamps are not, so a failure reproduces in shape. The failure
 * message carries the seed and the tail of the operation log. `SYNC_PROPERTY_SEEDS=300` runs more.
 */

const STEPS = 60;

const DOMAINS: readonly SyncDomain[] = SYNC_DOMAINS;

/** The published part of a dump: finance balance snapshots derived on a laptop never leave it. */
const published = async (device: SyncDevice, dump: DomainDump): Promise<DomainDump> => {
  const derived = new Set(
    (
      await device.db.select<{ account_id: string; as_of_date: string }[]>(
        "SELECT account_id, as_of_date FROM finance_account_balance_snapshots WHERE source <> 'statement'",
      )
    ).map((row) => JSON.stringify([row.account_id, row.as_of_date])),
  );
  if (derived.size === 0) return dump;
  const isDerived = (row: Record<string, unknown>): boolean =>
    row.entity_type === "finance_account_balance_snapshots" && derived.has(String(row.entity_id));
  return {
    ...dump,
    tables: {
      ...dump.tables,
      finance_account_balance_snapshots: (
        dump.tables.finance_account_balance_snapshots ?? []
      ).filter((row) => row.source === "statement"),
    },
    meta: dump.meta.filter((row) => !isDerived(row)),
    ...(dump.snapshots ? { snapshots: dump.snapshots.filter((row) => !isDerived(row)) } : {}),
  };
};

const stateOf = async (
  sim: SyncHarness,
  device: SyncDevice,
  options: { rows: "tables" | "all" },
): Promise<Record<SyncDomain, unknown>> => {
  const result = {} as Record<SyncDomain, unknown>;
  for (const domain of DOMAINS) {
    const dump = await published(device, await sim.dump(device, domain, { snapshots: true }));
    // Alias clocks (`recorded_hlc`) may differ between replicas until they exchange (harmless max
    // join): compare the alias relation itself.
    const aliases = dump.aliases.map((row) => ({
      entity_type: row.entity_type,
      alias_id: row.alias_id,
      canonical_id: row.canonical_id,
    }));
    result[domain] =
      options.rows === "tables"
        ? { tables: dump.tables, settings: dump.settings, aliases }
        : { ...dump, aliases };
  }
  return result;
};

const runSeed = async (seed: number, holder: { ctx: OpContext | null }) => {
  const rand = prng(seed);
  const sim = await createSyncHarness(["A", "B", "C"]);
  const [a] = sim.devices as [SyncDevice, SyncDevice, SyncDevice];
  await seedScenario(a);
  for (const domain of DOMAINS) await sim.syncAll(domain);
  const contexts = (await a.repo.listContexts()).map((context) => context.id);
  const ctx = newOpContext(rand, contexts);
  holder.ctx = ctx;

  // Old bundles to replay later (stale, repeated).
  const history: { domain: SyncDomain; changeSet: SyncChangeSet }[] = [];
  const remember = async (device: SyncDevice, domain: SyncDomain) => {
    history.push({ domain, changeSet: jsonRoundTrip(await device.repo.listSyncChanges(domain)) });
  };

  for (let step = 0; step < STEPS; step += 1) {
    const device = pickOf(rand, sim.devices);
    const roll = rand();
    if (roll < 0.22) {
      // A partial exchange: one direction, one domain.
      const to = pickOf(
        rand,
        sim.devices.filter((candidate) => candidate !== device),
      );
      const domain = pickOf(rand, DOMAINS);
      await sim.exchange(device, to, domain);
      ctx.log.push(`exchange ${device.name} -> ${to.name} ${domain}`);
    } else if (roll < 0.27) {
      const domain = pickOf(rand, DOMAINS);
      await remember(device, domain);
      ctx.log.push(`remember ${device.name} ${domain}`);
    } else if (roll < 0.32 && history.length > 0) {
      const old = pickOf(rand, history);
      await device.repo.applySyncBundle(old.domain, old.changeSet);
      ctx.log.push(`replay old ${old.domain} bundle on ${device.name}`);
    } else {
      await runRandomOp(device, ctx, ["gtd", "gtd", "personal", "finance"]);
    }
  }

  await finishRunningTimers(sim.devices);

  // The final bundles of every laptop, as files would deliver them.
  const finals: { domain: SyncDomain; changeSet: SyncChangeSet }[] = [];
  for (const device of sim.devices) {
    for (const domain of DOMAINS) {
      finals.push({ domain, changeSet: jsonRoundTrip(await device.repo.listSyncChanges(domain)) });
    }
  }

  // Order independence: fresh replicas, every order, with repeats and stale bundles.
  const replicas = await createSyncHarness(3, {
    deviceIndexOffset: 10,
    startMs: HARNESS_START_MS - 3_600_000,
  });
  const states: unknown[] = [];
  for (const replica of replicas.devices) {
    const sequence = shuffled(rand, [
      ...finals,
      ...shuffled(rand, finals).slice(0, 3),
      ...shuffled(rand, history).slice(0, 3),
    ]);
    // Domains are independent stores, but a stale bundle must never be applied after the final
    // ones changes the outcome: shuffling covers exactly that.
    for (const { domain, changeSet } of sequence) {
      await replica.repo.applySyncBundle(domain, changeSet);
    }
    expect(await replica.db.select("PRAGMA foreign_key_check")).toEqual([]);
    states.push(await stateOf(replicas, replica, { rows: "all" }));
  }
  for (const state of states.slice(1)) {
    expect(diffDomainStates(state as never, states[0] as never), "replicas").toEqual([]);
  }

  // Idempotence on a replica: applying everything again moves nothing at all.
  const first = replicas.devices[0] as SyncDevice;
  const before = await syncState(first.db);
  for (const { domain, changeSet } of finals) {
    const beforeDump = await stateOf(replicas, first, { rows: "all" });
    const result = await first.repo.applySyncBundle(domain, changeSet);
    if (result.applied !== 0 || result.tombstonesApplied !== 0 || result.conflictsLogged !== 0) {
      const afterDump = await stateOf(replicas, first, { rows: "all" });
      expect(
        { result, changed: diffDomainStates(afterDump, beforeDump) },
        `re-applying the ${domain} bundle of ${changeSet.deviceId}`,
      ).toEqual({ result: expect.objectContaining({ applied: 0 }), changed: [] });
    }
  }
  expect(await syncState(first.db)).toEqual(before);
  expect(await first.repo.enableSyncCapture()).toMatchObject({
    installed: false,
    backfilled: 0,
    backfillComplete: true,
  });

  // The laptops converge to the same state once they exchange everything ...
  for (let round = 0; round < 2; round += 1) {
    for (const domain of DOMAINS) await sim.syncAll(domain);
  }
  const reference = await stateOf(sim, sim.devices[0] as SyncDevice, { rows: "tables" });
  for (const device of sim.devices.slice(1)) {
    expect(
      diffDomainStates(await stateOf(sim, device, { rows: "tables" }), reference),
      `${device.name} vs A`,
    ).toEqual([]);
  }
  // ... and it is the state the fresh replicas reached from the bundles alone.
  expect(
    diffDomainStates(await stateOf(replicas, first, { rows: "tables" }), reference),
    "replica vs laptops",
  ).toEqual([]);

  // A converged laptop is quiescent: nothing to apply, nothing to stamp, nothing to re-dirty.
  for (const device of sim.devices) {
    const settled = await syncState(device.db);
    for (const other of sim.devices) {
      if (other === device) continue;
      for (const domain of DOMAINS) {
        expect(await sim.exchange(other, device, domain)).toMatchObject({
          applied: 0,
          tombstonesApplied: 0,
        });
      }
    }
    expect(await syncState(device.db)).toEqual(settled);
    expect(await device.repo.enableSyncCapture()).toMatchObject({
      installed: false,
      backfilled: 0,
      backfillComplete: true,
    });
  }
};

describe("the merge layer converges and is idempotent on random operations", () => {
  for (const seed of propertySeeds(20)) {
    it(`seed ${seed}`, async () => {
      const holder: { ctx: OpContext | null } = { ctx: null };
      await withSeedReport(
        seed,
        () => holder.ctx,
        () => runSeed(seed, holder),
      );
    }, 120_000);
  }
});

const permutations = <T>(items: T[]): T[][] =>
  items.length <= 1
    ? [items]
    : items.flatMap((item, index) =>
        permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
          item,
          ...rest,
        ]),
      );

describe("known limit: a delete that races edits from two other laptops", () => {
  /**
   * Found by this property test and deliberately kept OUT of the random generator (see "the delete
   * envelope" in `test-support/random-ops.ts`). A tombstone carries no field values (`merge-entity.ts`,
   * "Known limit"), so when laptop A deletes a task while C completes it and B edits it, none of the
   * three has seen the others and the outcome depends on the order the bundles reach a fourth laptop:
   * C's completion (older than A's delete) is swallowed by the tombstone unless B's resurrecting edit
   * has already been applied when C's bundle arrives.
   * The merge is a join everywhere else. Proper fix (open item, not part of the sync engine): tombstones
   * carry the last field values so dead fields take part in the LWW join. When that lands, the two
   * orders below converge on "completed" and this test flips.
   */
  it("makes the result depend on the order of arrival (open item)", async () => {
    const sim = await createSyncHarness(["A", "B", "C"]);
    const [a, b, c] = sim.devices as [SyncDevice, SyncDevice, SyncDevice];
    await a.repo.createTask({ id: "shared", title: "Shared", bucket: "next_action" });
    await sim.syncAll("gtd");
    c.clock.advance(10_000);
    await c.repo.completeTask("shared", new Date(c.clock.now).toISOString());
    a.clock.advance(20_000);
    await a.db.execute("DELETE FROM gtd_tasks WHERE id = 'shared'");
    await a.stamp();
    b.clock.advance(30_000);
    const task = (await b.repo.listTasks({})).find((candidate) => candidate.id === "shared");
    if (!task) throw new Error("B lost the task");
    await b.repo.saveTask({ ...task, notes: "edited on B" });

    const bundles = await Promise.all(
      [a, b, c].map(async (device) => jsonRoundTrip(await device.repo.listSyncChanges("gtd"))),
    );
    const outcomes = new Map<string, string>();
    for (const order of permutations([0, 1, 2])) {
      const replica = (
        await createSyncHarness(1, {
          deviceIndexOffset: 10,
          startMs: HARNESS_START_MS - 3_600_000,
        })
      ).devices[0] as SyncDevice;
      for (const index of order) {
        await replica.repo.applySyncBundle("gtd", bundles[index] as SyncChangeSet);
      }
      const row = (await replica.repo.listTasks({ includeCompleted: true })).find(
        (candidate) => candidate.id === "shared",
      );
      outcomes.set(order.map((index) => "ABC"[index]).join(""), `${row?.status}/${row?.notes}`);
    }
    // The edit always resurrects the row; the completion is lost exactly when C's bundle reaches
    // the replica before B's (the tombstone swallows it, and B's row knows nothing of it).
    expect(Object.fromEntries(outcomes)).toEqual({
      ABC: "completed/edited on B",
      ACB: "active/edited on B",
      BAC: "completed/edited on B",
      BCA: "completed/edited on B",
      CAB: "active/edited on B",
      CBA: "completed/edited on B",
    });
  });
});
