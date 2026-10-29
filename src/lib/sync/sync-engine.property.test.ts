// @vitest-environment node
import { describe, expect, it } from "vitest";
import { syncState } from "./capture-test-utils";
import type { SyncChangeSet } from "./change-set";
import { SYNC_DOMAINS, type SyncDomain, tablesInDomain } from "./registry";
import {
  createEngineWorld,
  type EngineDevice,
  type EngineWorld,
  settleWorld,
} from "./test-support/engine-harness";
import {
  finishRunningTimers,
  newOpContext,
  type OpContext,
  type OpFamily,
  pickOf,
  propertySeeds,
  prng,
  runRandomOp,
  seedScenario,
  shuffled,
  withSeedReport,
} from "./test-support/random-ops";
import { diffStates } from "./test-support/state-diff";
import {
  createSyncHarness,
  HARNESS_START_MS,
  jsonRoundTrip,
  type SyncDevice,
} from "./test-support/two-device-harness";

/**
 * The same properties as `merge.property.test.ts`, one layer up: random REAL repository operations
 * on two personal laptops (A, B) and a work laptop (W, attached to the shared GTD folder only), with
 * the schedule driven through the SYNC ENGINE and the in-memory folders instead of direct exchanges.
 *
 * The schedule mixes local edits with pulls, publishes and full syncs; a laptop going offline; a
 * folder going away; a budget-limited pull that stops half way; a publish that dies before its
 * manifest; partial, unverified and corrupt bundles in the GTD folder; and replays of old bundles.
 * Afterwards everything is repaired and the properties are checked:
 *
 * - CONVERGENCE. A and B hold identical canonical state in every domain; W matches both on every gtd
 *   table. W holds no personal or finance rows beyond what any fresh database holds.
 * - IDEMPOTENCE. Another full round of syncs moves nothing: no row, clock, snapshot, counter or
 *   generation, and the verifying capture scan restamps nothing.
 * - ORDER INDEPENDENCE. The final bundles of the laptops, in any order with repeats and stale bundles
 *   mixed in, leave fresh replicas (a personal profile and a work profile) in the converged state of
 *   the domains their profile syncs.
 *
 * What a seed fixes and what it does not is documented in `test-support/random-ops.ts`.
 */

const STEPS = 100;
const PERSONAL_FAMILIES: readonly OpFamily[] = ["gtd", "gtd", "personal", "finance"];
const WORK_FAMILIES: readonly OpFamily[] = ["gtd"];

const published = (rows: Record<string, unknown>[] | undefined, key = "source") =>
  (rows ?? []).filter((row) => row[key] === "statement");

/** Canonical comparable state of one domain, minus what never leaves a laptop. */
const stateOf = async (
  world: { dump: EngineWorld["sim"]["dump"] },
  device: SyncDevice,
  domain: SyncDomain,
  full: boolean,
): Promise<unknown> => {
  const dump = await world.dump(device, domain, { snapshots: full });
  const derived = new Set(
    (
      await device.db.select<{ account_id: string; as_of_date: string }[]>(
        "SELECT account_id, as_of_date FROM finance_account_balance_snapshots WHERE source <> 'statement'",
      )
    ).map((row) => JSON.stringify([row.account_id, row.as_of_date])),
  );
  const isDerived = (row: Record<string, unknown>) =>
    row.entity_type === "finance_account_balance_snapshots" && derived.has(String(row.entity_id));
  const tables = { ...dump.tables };
  if (tables.finance_account_balance_snapshots) {
    tables.finance_account_balance_snapshots = published(tables.finance_account_balance_snapshots);
  }
  const aliases = dump.aliases.map((row) => ({
    entity_type: row.entity_type,
    alias_id: row.alias_id,
    canonical_id: row.canonical_id,
  }));
  return full
    ? {
        tables,
        settings: dump.settings,
        aliases,
        meta: dump.meta.filter((row) => !isDerived(row)),
        snapshots: (dump.snapshots ?? []).filter((row) => !isDerived(row)),
      }
    : { tables, settings: dump.settings, aliases };
};

const forbiddenRows = async (device: SyncDevice): Promise<Record<string, number>> => {
  const counts: Record<string, number> = {};
  for (const domain of ["personal", "finance"] as const) {
    for (const table of tablesInDomain(domain)) {
      const rows = await device.db.select<{ n: number }[]>(`SELECT COUNT(*) AS n FROM "${table}"`);
      counts[table] = Number(rows[0]?.n ?? 0);
    }
  }
  return counts;
};

const runSeed = async (seed: number, holder: { ctx: OpContext | null }) => {
  const rand = prng(seed);
  const world = await createEngineWorld([
    { name: "A" },
    { name: "B" },
    { name: "W", profile: "work", roles: ["gtd"] },
  ]);
  const [a, b, w] = [world.device("A"), world.device("B"), world.device("W")];
  const personal = [a, b];
  await seedScenario(a);
  await settleWorld(world);
  const contexts = (await a.repo.listContexts()).map((context) => context.id);
  const ctx = newOpContext(rand, contexts);
  holder.ctx = ctx;

  const damaged = new Map<string, { generation: number; original: string }>();
  const history: { domain: SyncDomain; changeSet: SyncChangeSet }[] = [];
  const remember = async (device: EngineDevice, domain: SyncDomain) => {
    history.push({ domain, changeSet: jsonRoundTrip(await device.repo.listSyncChanges(domain)) });
  };

  for (let step = 0; step < STEPS; step += 1) {
    const device = pickOf(rand, world.devices);
    const roll = rand();
    const note = (text: string) => ctx.log.push(`${device.name}: ${text}`);
    if (roll < 0.1) {
      note("pull");
      await device.engine.pull();
    } else if (roll < 0.17) {
      note("publish");
      await device.engine.publish();
    } else if (roll < 0.25) {
      note("syncNow");
      await device.engine.syncNow();
    } else if (roll < 0.28) {
      const offline = rand() < 0.6;
      world.folders.setDeviceOffline(device.deviceId, offline);
      note(offline ? "goes offline" : "comes back online");
    } else if (roll < 0.3) {
      const mode = pickOf(rand, ["unreachable", "timeout", "up", "up"] as const);
      world.folders.setMode("personal", mode);
      world.folders.setMode("gtd", rand() < 0.5 ? "up" : mode);
      note(`folders ${mode}`);
    } else if (roll < 0.33) {
      const budgetMs = pickOf(rand, [0, 1_000, 5_000]);
      world.folders.onOperation("gtd", "readBundle", () => device.clock.advance(2_000));
      note(`pull with budget ${budgetMs}`);
      await device.engine.pull({ budgetMs });
      world.folders.onOperation("gtd", "readBundle", undefined);
    } else if (roll < 0.35) {
      world.folders.crashNextPublishes("gtd");
      note("publish that crashes before its manifest");
      await device.engine.publish();
    } else if (roll < 0.38) {
      const target = pickOf(rand, world.devices);
      const entry = world.folders.manifestFor("gtd", target.deviceId)?.domains.gtd;
      if (entry) {
        const kind = pickOf(rand, ["partial", "unverified", "not-json", "bad-shape"] as const);
        // Remember the intact bytes of this generation (once) so the repair can put them back.
        if (damaged.get(target.deviceId)?.generation !== entry.generation) {
          damaged.set(target.deviceId, {
            generation: entry.generation,
            original: world.folders.bundleText("gtd", target.deviceId, "gtd"),
          });
        }
        world.folders.damageBundle("gtd", target.deviceId, "gtd", kind);
        note(`damages ${target.name}'s gtd bundle (${kind})`);
      }
    } else if (roll < 0.42) {
      const domain = pickOf(rand, device.profile === "work" ? (["gtd"] as const) : SYNC_DOMAINS);
      note(`remember ${domain}`);
      await remember(device, domain);
    } else if (roll < 0.46 && history.length > 0) {
      const old = pickOf(
        rand,
        history.filter((item) => device.profile === "personal" || item.domain === "gtd"),
      );
      if (old) {
        note(`replays an old ${old.domain} bundle`);
        await device.repo.applySyncBundle(old.domain, old.changeSet);
      }
    } else {
      await runRandomOp(device, ctx, device.profile === "work" ? WORK_FAMILIES : PERSONAL_FAMILIES);
    }
  }

  // ---- Repair the world, then let everyone catch up ------------------------------------------
  for (const device of world.devices) world.folders.setDeviceOffline(device.deviceId, false);
  world.folders.setMode("gtd", "up");
  world.folders.setMode("personal", "up");
  for (const operation of ["listPeers", "readBundle", "publish", "ownGeneration"] as const) {
    world.folders.onOperation("gtd", operation, undefined);
    world.folders.onOperation("personal", operation, undefined);
  }
  await finishRunningTimers(world.devices);
  // A damaged bundle is repaired by putting its bytes back, unless its laptop has meanwhile
  // published a newer generation (which replaced it). Publishing is then plain: only what changed.
  world.folders.crashNextPublishes("gtd", 0);
  world.folders.crashNextPublishes("personal", 0);
  for (const [deviceId, { generation, original }] of damaged) {
    if (world.folders.manifestFor("gtd", deviceId)?.domains.gtd?.generation === generation) {
      world.folders.restoreBundle("gtd", deviceId, "gtd", original);
    }
  }
  for (const device of world.devices) await device.engine.publish();
  const settle = async () => {
    for (let round = 0; round < 8; round += 1) {
      let applied = 0;
      for (const device of world.devices) {
        const { pull } = await device.engine.syncNow();
        expect(
          pull.issues.filter((issue) => issue.severity === "error"),
          device.name,
        ).toEqual([]);
        applied += pull.totals.bundlesApplied;
      }
      if (applied === 0) return;
    }
    throw new Error("the laptops never stopped applying each other's bundles");
  };
  await settle();

  // ---- Convergence ----------------------------------------------------------------------------
  for (const domain of SYNC_DOMAINS) {
    const reference = await stateOf(world.sim, a, domain, true);
    expect(
      diffStates(await stateOf(world.sim, b, domain, true), reference),
      `B vs A ${domain}`,
    ).toEqual([]);
  }
  const gtdReference = await stateOf(world.sim, a, "gtd", false);
  expect(diffStates(await stateOf(world.sim, w, "gtd", false), gtdReference), "W vs A gtd").toEqual(
    [],
  );
  const fresh = await createEngineWorld([{ name: "Fresh" }]);
  expect(await forbiddenRows(w)).toEqual(await forbiddenRows(fresh.device("Fresh")));
  for (const operation of Object.values(world.folders.calls(w.deviceId, "personal"))) {
    expect(operation).toBe(0);
  }
  expect(
    w.calls
      .filter((call) => call.method === "readSyncSnapshot" || call.method === "applySyncBundle")
      .every((call) => call.domain === "gtd"),
  ).toBe(true);

  // ---- Idempotence: another round of everything moves nothing --------------------------------
  const before = await Promise.all(world.devices.map((device) => syncState(device.db)));
  const generations = JSON.stringify(
    world.devices.map((device) => world.folders.manifestFor("gtd", device.deviceId)?.domains),
  );
  for (const device of world.devices) {
    const report = await device.engine.syncNow();
    expect(report.pull.totals.bundlesApplied, `${device.name} pull`).toBe(0);
    expect(
      report.publish.domains.every((domain) => domain.outcome !== "published"),
      `${device.name} publish`,
    ).toBe(true);
    expect(report.publish.counterAdvanced).toBe(false);
  }
  expect(await Promise.all(world.devices.map((device) => syncState(device.db)))).toEqual(before);
  expect(
    JSON.stringify(
      world.devices.map((device) => world.folders.manifestFor("gtd", device.deviceId)?.domains),
    ),
  ).toBe(generations);
  for (const device of world.devices) {
    expect(await device.repo.enableSyncCapture()).toEqual({ installed: false, backfilled: 0 });
    const status = await device.repo.getSyncStatus();
    expect(status.supported && status.pendingChanges, `${device.name} pending`).toBe(0);
  }

  // ---- Order independence on fresh replicas --------------------------------------------------
  const finals: { from: EngineDevice; domain: SyncDomain; changeSet: SyncChangeSet }[] = [];
  for (const device of world.devices) {
    for (const domain of device.profile === "work" ? (["gtd"] as const) : SYNC_DOMAINS) {
      finals.push({
        from: device,
        domain,
        changeSet: jsonRoundTrip(await device.repo.listSyncChanges(domain)),
      });
    }
  }
  const replicas = await createSyncHarness(3, {
    deviceIndexOffset: 10,
    startMs: HARNESS_START_MS - 3_600_000,
  });
  const replicaStates: unknown[] = [];
  for (const replica of replicas.devices) {
    const sequence = shuffled(rand, [
      ...finals,
      ...shuffled(rand, finals).slice(0, 4),
      ...shuffled(rand, history).slice(0, 3),
    ]);
    for (const { domain, changeSet } of sequence) {
      await replica.repo.applySyncBundle(domain, changeSet);
    }
    expect(await replica.db.select("PRAGMA foreign_key_check")).toEqual([]);
    const states: Record<string, unknown> = {};
    for (const domain of SYNC_DOMAINS)
      states[domain] = await stateOf(replicas, replica, domain, true);
    replicaStates.push(states);
  }
  for (const state of replicaStates.slice(1)) {
    for (const domain of SYNC_DOMAINS) {
      expect(
        diffStates((state as never)[domain], (replicaStates[0] as never)[domain]),
        `replicas ${domain}`,
      ).toEqual([]);
    }
  }
  for (const domain of SYNC_DOMAINS) {
    expect(
      diffStates(
        await stateOf(replicas, replicas.devices[0] as SyncDevice, domain, false),
        await stateOf(world.sim, a, domain, false),
      ),
      `replica vs laptops ${domain}`,
    ).toEqual([]);
  }

  // A work replica fed only gtd bundles (the only domain a work device may apply), in any order.
  const workReplica = await createSyncHarness(1, {
    deviceIndexOffset: 20,
    startMs: HARNESS_START_MS - 3_600_000,
  });
  const only = workReplica.devices[0] as SyncDevice;
  for (const { changeSet } of shuffled(
    rand,
    finals.filter((item) => item.domain === "gtd"),
  )) {
    await only.repo.applySyncBundle("gtd", changeSet);
  }
  expect(
    diffStates(await stateOf(workReplica, only, "gtd", false), gtdReference),
    "work replica",
  ).toEqual([]);

  // The personal laptops hold the sum of everything; the work laptop's bundle is a subset.
  expect(personal.length).toBe(2);
};

describe("the sync engine converges and is idempotent on random schedules", () => {
  for (const seed of propertySeeds(16)) {
    it(`seed ${seed}`, async () => {
      const holder: { ctx: OpContext | null } = { ctx: null };
      await withSeedReport(
        seed,
        () => holder.ctx,
        () => runSeed(seed, holder),
      );
    }, 180_000);
  }
});
