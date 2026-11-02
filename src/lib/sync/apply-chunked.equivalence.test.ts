// @vitest-environment node
import { describe, expect, it } from "vitest";
import { SYNC_DOMAINS } from "./registry";
import type { ApplyLimits } from "./split-change-set";
import {
  type Bundle,
  expectChunkedEqualsWhole,
  expectEveryPrefixValid,
  expectGroupsIntact,
} from "./test-support/chunk-equivalence";
import {
  finishRunningTimers,
  newOpContext,
  type OpContext,
  pickOf,
  propertySeeds,
  prng,
  runRandomOp,
  runShapeOp,
  seedShapes,
  seedScenario,
  shuffled,
  withSeedReport,
} from "./test-support/random-ops";
import {
  createSyncHarness,
  jsonRoundTrip,
  type SyncDevice,
} from "./test-support/two-device-harness";

/**
 * The chunked apply against the whole apply, over random REAL repository operations.
 *
 * Four laptops: A, B and C are the senders; T is the target and has local edits of its own, so the
 * incoming bundles collide with real local state (natural-key collisions, tombstones, resurrections,
 * cascades, recurring instances, finance units with splits, Pomodoro sessions, settings). After the
 * run, the final bundles of A, B and C go to byte-for-byte clones of T, whole on one and as chunks of
 * 1-3 entities on the other, in the same order and in a shuffled order; the two must end identical
 * (`test-support/chunk-equivalence.ts` states the one declared tolerance). A third clone applies the
 * chunks one by one and must be a valid database after EACH chunk; applying them all again changes
 * nothing.
 *
 * `SYNC_PROPERTY_SEEDS=60` runs more seeds, `SYNC_EQUIV_STEPS=300` longer runs; a failure message
 * carries the seed.
 */

const STEPS = Number(process.env.SYNC_EQUIV_STEPS) || 140;
const TINY: Partial<ApplyLimits> = {
  maxEntities: 2,
  maxUnionRows: 3,
  maxAliases: 2,
  maxSidecarRows: 3,
};
const ONE: Partial<ApplyLimits> = {
  maxEntities: 1,
  maxUnionRows: 1,
  maxAliases: 1,
  maxSidecarRows: 1,
};

const runSeed = async (seed: number, holder: { ctx: OpContext | null }) => {
  const rand = prng(seed);
  const sim = await createSyncHarness(["A", "B", "C", "T"]);
  const [a, b, c, t] = sim.devices as [SyncDevice, SyncDevice, SyncDevice, SyncDevice];
  await seedScenario(a);
  for (const domain of SYNC_DOMAINS) await sim.syncAll(domain);
  const ctx = newOpContext(
    rand,
    (await a.repo.listContexts()).map((context) => context.id),
  );
  holder.ctx = ctx;
  // Each sender owns a small queue, a pending proposal and a pending suggestion that the target
  // receives in the baseline; later the senders leave the queue and regenerate the pending rows while
  // the target stays behind (odd seeds: it receives nothing more until the end).
  for (const sender of [a, b, c]) await seedShapes(sender, ctx);
  for (const domain of SYNC_DOMAINS) await sim.syncAll(domain);
  const staleTarget = seed % 2 === 1;

  for (let step = 0; step < STEPS; step += 1) {
    const device = pickOf(rand, sim.devices);
    if (rand() < 0.2) {
      // Exchanges among the senders; only now and then into the target.
      const to = pickOf(
        rand,
        sim.devices.filter((candidate) => candidate !== device),
      );
      if (to === t && (staleTarget || rand() < 0.4)) continue;
      const domain = pickOf(rand, SYNC_DOMAINS);
      await sim.exchange(device, to, domain);
      ctx.log.push(`exchange ${device.name} -> ${to.name} ${domain}`);
    } else if (rand() < 0.5) {
      // The shapes a chunk boundary can change: leaving a Planned queue, regenerated pending rows.
      await runShapeOp(device, ctx);
    } else {
      await runRandomOp(device, ctx, ["gtd", "gtd", "personal", "finance"]);
    }
  }
  await finishRunningTimers(sim.devices);

  const bundles: Bundle[] = [];
  for (const sender of [a, b, c]) {
    for (const domain of SYNC_DOMAINS) {
      bundles.push({
        domain,
        changeSet: jsonRoundTrip(await sender.repo.listSyncChanges(domain)),
      });
    }
  }

  let splitBundles = 0;
  for (const [name, list] of [
    ["natural", bundles],
    ["shuffled", shuffled(rand, bundles)],
  ] as const) {
    const limitsOf = (index: number) => (index % 2 === 0 ? TINY : ONE);
    const report = await expectChunkedEqualsWhole(t, list, limitsOf, `${name} order`);
    splitBundles += report.splitBundles;
  }
  expect(splitBundles, "the run exercised splits").toBeGreaterThan(0);
  await expectEveryPrefixValid(t, bundles, ONE);
  // However small the group cap, no group whose members are applied together is cut.
  expect(expectGroupsIntact(bundles, { ...ONE, maxGroupEntities: 1 })).toBeGreaterThan(0);
  expectGroupsIntact(bundles, { ...TINY, maxGroupEntities: 2 });
};

describe("the chunked apply is equivalent to the whole apply (randomized)", () => {
  for (const seed of propertySeeds(6)) {
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
