// Test-only: nothing in the app imports this file.
//
// SAFETY: in-memory simulated laptops only.
import { expect } from "vitest";
import { applyChunked } from "../apply-chunked";
import type { SyncChangeSet } from "../change-set";
import { SYNC_DOMAINS, type SyncDomain } from "../registry";
import { type ApplyLimits, planChangeSet } from "../split-change-set";
import { groupKeysOf, QUEUE_KEY_PREFIX } from "../split-groups";
import { cloneDevice } from "./device-clone";
import { diffDomainStates } from "./state-diff";
import { dumpDomain, readConflicts, type SyncDevice } from "./two-device-harness";

/**
 * Whole apply against chunked apply, from byte-for-byte clones of one target laptop.
 *
 * The declared tolerance: a clock that the APPLYING laptop invents for a cascade or orphan tombstone
 * (`ReferenceGuard.freshClock`) is a fresh counter of its own clock, issued in the order the work
 * happens, so its value differs between strategies. Clocks of the target's own device that neither the
 * target held before nor any bundle carries are normalised to `FRESH`; everything else (rows, every
 * other clock, snapshots, aliases, settings, conflicts) must be identical.
 */

export interface Bundle {
  domain: SyncDomain;
  changeSet: SyncChangeSet;
}

const CLOCK = /\d{13}-[0-9a-f]{4,}-dev:[0-9a-f-]+/g;

export const clocksIn = (value: unknown): Set<string> =>
  new Set(JSON.stringify(value).match(CLOCK) ?? []);

const normalizeFresh = (value: unknown, node: string, known: ReadonlySet<string>): unknown =>
  JSON.parse(
    JSON.stringify(value).replace(CLOCK, (clock) =>
      clock.endsWith(node) && !known.has(clock) ? "FRESH" : clock,
    ),
  );

/** Every clock the target held before the apply or any bundle carries. */
export const knownClocks = async (
  target: SyncDevice,
  bundles: readonly Bundle[],
): Promise<Set<string>> => {
  const known = clocksIn(bundles);
  for (const table of [
    "sync_entity_meta",
    "sync_entity_snapshot",
    "sync_id_aliases",
    "sync_recurrence_occurrences",
    "sync_conflicts",
  ]) {
    for (const clock of clocksIn(await target.db.select(`SELECT * FROM ${table}`))) {
      known.add(clock);
    }
  }
  for (const domain of SYNC_DOMAINS) {
    for (const clock of clocksIn(await dumpDomain(target, domain))) known.add(clock);
  }
  return known;
};

export const fullState = async (
  device: SyncDevice,
  known: ReadonlySet<string>,
): Promise<Record<string, unknown>> => {
  const state: Record<string, unknown> = {};
  for (const domain of SYNC_DOMAINS) {
    const dump = await dumpDomain(device, domain, { snapshots: true });
    state[domain] = normalizeFresh(
      {
        tables: dump.tables,
        meta: dump.meta,
        snapshots: dump.snapshots,
        settings: dump.settings,
        aliases: dump.aliases.map((row) => ({
          entity_type: row.entity_type,
          alias_id: row.alias_id,
          canonical_id: row.canonical_id,
        })),
      },
      device.deviceId,
      known,
    );
  }
  state.conflicts = normalizeFresh(
    (await readConflicts(device)).map((row) => ({
      id: row.id,
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      kind: row.kind,
    })),
    device.deviceId,
    known,
  );
  return state;
};

/** The state with every `planned_order` value masked (rows and snapshots): the one column the queue repair rewrites without a clock. */
const maskPlannedOrder = (state: Record<string, unknown>): string =>
  JSON.stringify(state).replace(/(\\?"planned_order\\?":)(null|-?\d+(\.\d+)?)/g, "$1MASKED");

export const foreignKeyProblems = (device: SyncDevice) =>
  device.db.select("PRAGMA foreign_key_check");

export interface EquivalenceReport {
  /** Chunks the bundles were split into, in total. */
  chunks: number;
  /** Bundles that were actually split (more than one chunk). */
  splitBundles: number;
  /** Sum of `applied` / `tombstonesApplied` / `conflictsLogged` of the whole apply. */
  applied: number;
  tombstones: number;
  conflicts: number;
  aliases: number;
}

/**
 * Applies `bundles` in order to two clones of `target`, one whole and one chunked with `limits` (a
 * function of the bundle index, so a test can vary them), and expects identical states and a
 * foreign-key-clean database.
 */
export const expectChunkedEqualsWhole = async (
  target: SyncDevice,
  bundles: readonly Bundle[],
  limits: Partial<ApplyLimits> | ((index: number) => Partial<ApplyLimits>),
  label = "chunked vs whole",
): Promise<EquivalenceReport> => {
  const known = await knownClocks(target, bundles);
  const whole = await cloneDevice(target, "W");
  const chunked = await cloneDevice(target, "C");
  const report: EquivalenceReport = {
    chunks: 0,
    splitBundles: 0,
    applied: 0,
    tombstones: 0,
    conflicts: 0,
    aliases: 0,
  };
  for (const [index, { domain, changeSet }] of bundles.entries()) {
    const bundleLimits = typeof limits === "function" ? limits(index) : limits;
    const result = await whole.repo.applySyncBundle(domain, changeSet);
    report.applied += result.applied;
    report.tombstones += result.tombstonesApplied;
    report.conflicts += result.conflictsLogged;
    report.aliases += changeSet.aliases.length;
    const plan = planChangeSet(changeSet, bundleLimits);
    report.chunks += plan.chunks.length;
    if (plan.chunks.length > 1) report.splitBundles += 1;
    const run = await applyChunked(chunked.repo, domain, changeSet, {
      limits: bundleLimits,
      yieldBetweenChunks: async () => undefined,
    });
    expect(run.chunks, `${label}: chunks`).toBe(plan.chunks.length);
  }
  expect(await foreignKeyProblems(chunked), `${label}: foreign keys`).toEqual([]);
  const expected = await fullState(whole, known);
  const actual = await fullState(chunked, known);
  expect(
    diffDomainStates(actual as never, expected as never).slice(0, 12),
    `${label}: difference`,
  ).toEqual([]);
  expect(actual, label).toEqual(expected);
  return report;
};

/**
 * Applies the chunks of every bundle one by one to a clone and checks the database is valid after
 * EACH chunk, then applies them all again and expects nothing to change.
 */
export const expectEveryPrefixValid = async (
  target: SyncDevice,
  bundles: readonly Bundle[],
  limits: Partial<ApplyLimits>,
  label = "prefixes",
): Promise<void> => {
  const known = await knownClocks(target, bundles);
  const stepwise = await cloneDevice(target, "P");
  const plans = bundles.map(({ domain, changeSet }) => ({
    domain,
    chunks: planChangeSet(changeSet, limits).chunks,
  }));
  for (const { domain, chunks } of plans) {
    for (const [index, chunk] of chunks.entries()) {
      await stepwise.repo.applySyncBundle(domain, chunk);
      expect(
        await foreignKeyProblems(stepwise),
        `${label} ${domain} ${index}: foreign keys`,
      ).toEqual([]);
      expect(await stepwise.db.select("SELECT applying FROM sync_identity")).toEqual([
        { applying: 0 },
      ]);
      expect(await stepwise.db.select("SELECT * FROM sync_dirty")).toEqual([]);
    }
  }
  // Applying every chunk again changes nothing, with ONE declared exception: the Planned queue repair
  // renumbers without a clock and is not a join, so re-applying a gtd bundle that carries a queue with
  // a duplicate order may renumber `planned_order` again (the whole apply does exactly the same; see
  // the docs). So: no tombstone is ever applied again, every other domain applies nothing, and the
  // state after the re-apply equals the state of the first pass except for `planned_order`.
  const settled = maskPlannedOrder(await fullState(stepwise, known));
  for (const { domain, chunks } of plans) {
    for (const chunk of chunks) {
      const again = await stepwise.repo.applySyncBundle(domain, chunk);
      expect(again.tombstonesApplied, `${label} ${domain}: tombstones re-applied`).toBe(0);
      if (domain !== "gtd") {
        expect(again, `${label} ${domain}: re-applying a chunk`).toMatchObject({ applied: 0 });
      }
    }
  }
  expect(await foreignKeyProblems(stepwise), `${label}: foreign keys after re-applying`).toEqual(
    [],
  );
  expect(
    maskPlannedOrder(await fullState(stepwise, known)),
    `${label}: state after the first re-apply`,
  ).toEqual(settled);
  // Beyond the first re-apply only the queue order may still move (it can renumber again, in one call
  // or in chunks): everything else must be exactly where the first pass left it.
  const afterOnePass = maskPlannedOrder(await fullState(stepwise, known));
  for (const { domain, chunks } of plans) {
    for (const chunk of chunks) await stepwise.repo.applySyncBundle(domain, chunk);
  }
  expect(await foreignKeyProblems(stepwise), `${label}: foreign keys after re-applying`).toEqual(
    [],
  );
  expect(
    maskPlannedOrder(await fullState(stepwise, known)),
    `${label}: settled after re-applying`,
  ).toEqual(afterOnePass);
};

/**
 * The property behind the group cap: whatever the limits, entities that share a group key other than
 * a project's queue (a transaction and its splits, an objective and its results, a session and its
 * segments, a template and its instance, rows of one natural key, the snapshots of an account) land in
 * ONE chunk. Only queue members may be cut away, because their rules do not depend on each other's
 * presence in the call.
 */
export const expectGroupsIntact = (
  bundles: readonly Bundle[],
  limits: Partial<ApplyLimits>,
  label = "groups",
): number => {
  let checked = 0;
  for (const { domain, changeSet } of bundles) {
    const chunks = planChangeSet(changeSet, limits).chunks;
    const chunkOf = new Map<string, number>();
    chunks.forEach((chunk, index) => {
      for (const entity of chunk.entities)
        chunkOf.set(`${entity.table}\u0000${entity.entityId}`, index);
    });
    const byKey = new Map<string, Set<number>>();
    for (const entity of changeSet.entities) {
      const at = chunkOf.get(`${entity.table}\u0000${entity.entityId}`);
      expect(
        at,
        `${label} ${domain}: ${entity.table} ${entity.entityId} is in a chunk`,
      ).toBeDefined();
      for (const key of groupKeysOf(entity)) {
        if (key.startsWith(QUEUE_KEY_PREFIX)) continue;
        const where = byKey.get(key) ?? new Set<number>();
        where.add(at as number);
        byKey.set(key, where);
      }
    }
    for (const [key, where] of byKey) {
      expect([...where], `${label} ${domain}: group ${key} is cut`).toHaveLength(1);
      checked += 1;
    }
  }
  return checked;
};
