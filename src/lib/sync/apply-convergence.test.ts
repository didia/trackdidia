// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createEmptyDailyEntry } from "../../domain/daily-entry";
import type { AnnualGoal } from "../../domain/types";
import type { SyncChangeSet } from "./change-set";
import type { SyncDomain } from "./registry";
import {
  createSyncHarness,
  HARNESS_START_MS,
  jsonRoundTrip,
  type SyncDevice,
} from "./test-support/two-device-harness";

/**
 * Convergence by randomized scenario. Three laptops make random edits (and exchange bundles at
 * random moments), then the three final bundles of each domain are applied, in shuffled orders and
 * with some repeats, to fresh replicas. Every replica must end in byte-identical state: rows, clock
 * metadata and snapshots. The generator is seeded, so a failure is reproducible from the seed.
 *
 * Scope: what this slice merges generically. Deletes are included but follow one rule of the
 * scenario, documented in `merge-entity.ts`: an entity that is deleted is edited by at most one
 * other device (a tombstone carries no field values, so a delete racing two different editors
 * cannot be made order independent).
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

const CONTEXTS = ["home", "work", "phone", "errand"];
const METRICS = ["course", "marche", "pushups", "qualiteSommeil"] as const;
const DATES = ["2026-10-04", "2026-10-05"];
const DOOMED = ["gdel-1", "gdel-2", "gdel-3"];

const goalTemplate = (id: string): AnnualGoal => ({
  id,
  title: `Goal ${id}`,
  dimension: "intellectuelle",
  description: "",
  targetValue: 10,
  unit: "u",
  sourceId: null,
  manualCurrentValue: null,
  evaluations: {},
  measurementType: "cumulative",
  status: "active",
  deadline: null,
  startingValue: null,
  direction: null,
  cadenceTarget: null,
  cadencePeriod: "week",
  principleKey: null,
  progressLog: {},
  milestones: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const runScenario = async (seed: number, steps: number) => {
  const rand = prng(seed);
  const sim = await createSyncHarness(["A", "B", "C"]);
  const [a, b] = sim.devices as [SyncDevice, SyncDevice, SyncDevice];
  let counter = 0;
  const next = (prefix: string) => `${prefix}${(counter += 1)}`;

  // Pre-existing shared data, including the goals some devices will delete or edit.
  for (const id of DOOMED) await a.repo.saveAnnualGoal(goalTemplate(id));
  await a.repo.createTask({
    id: "shared-task",
    title: "Shared",
    bucket: "inbox",
    contextIds: ["home"],
  });
  await sim.syncAll("gtd");
  await sim.syncAll("personal");

  const op = async (device: SyncDevice) => {
    device.clock.advance(1 + Math.floor(rand() * 90_000));
    const kind = Math.floor(rand() * 15);
    const tasks = await device.repo.listTasks({ includeCompleted: true });
    const goals = (await device.repo.listAnnualGoals()).filter((goal) => !DOOMED.includes(goal.id));
    switch (kind) {
      case 0:
        await device.repo.createTask({
          id: next(`task-${device.name}-`),
          title: `Task ${counter}`,
          bucket: "inbox",
          contextIds: [pickOf(rand, CONTEXTS)],
        });
        break;
      case 1:
      case 2: {
        const task = tasks.length ? pickOf(rand, tasks) : undefined;
        if (!task) break;
        const field = pickOf(rand, ["title", "notes", "bucket"] as const);
        await device.repo.saveTask({
          ...task,
          ...(field === "bucket"
            ? { bucket: task.bucket === "inbox" ? ("next_action" as const) : ("inbox" as const) }
            : { [field]: `${field} ${device.name}${(counter += 1)}` }),
        });
        break;
      }
      case 3: {
        const task = tasks.length ? pickOf(rand, tasks) : undefined;
        if (!task) break;
        const context = pickOf(rand, CONTEXTS);
        const contextIds = task.contextIds.includes(context)
          ? task.contextIds.filter((id) => id !== context)
          : [...task.contextIds, context];
        await device.repo.saveTask({ ...task, contextIds });
        break;
      }
      case 4: {
        const open = tasks.filter((task) => task.status === "active");
        if (open.length) await device.repo.completeTask(pickOf(rand, open).id);
        break;
      }
      case 5: {
        const id = pickOf(rand, ["p1", "p2"]);
        const existing = (await device.repo.listProjects({})).find((project) => project.id === id);
        await device.repo.saveProject({
          ...(existing ?? {
            id,
            status: "active",
            notes: "",
            contextIds: [],
            source: "manual",
            sourceExternalId: null,
            createdAt: "2026-10-01T00:00:00.000Z",
            statusChangedAt: null,
          }),
          title: `Project ${device.name}${(counter += 1)}`,
          updatedAt: new Date().toISOString(),
        } as never);
        break;
      }
      case 6:
      case 7: {
        const date = pickOf(rand, DATES);
        const entry = (await device.repo.getDailyEntry(date)) ?? createEmptyDailyEntry(date);
        await device.repo.saveDailyEntry(
          rand() < 0.3
            ? { ...entry, morningIntention: `intention ${device.name}${(counter += 1)}` }
            : {
                ...entry,
                metrics: { ...entry.metrics, [pickOf(rand, METRICS)]: Math.floor(rand() * 50) },
              },
        );
        break;
      }
      case 8: {
        const goal = goals.length ? pickOf(rand, goals) : goalTemplate("goal-shared");
        const edit = pickOf(rand, ["title", "progress", "milestone", "complete"] as const);
        const milestones = [...goal.milestones];
        if (edit === "milestone" || (edit === "complete" && !milestones.length)) {
          milestones.push({
            id: next(`m-${device.name}-`),
            title: "M",
            completedAt: null,
            sortOrder: milestones.length,
          });
        } else if (edit === "complete") {
          const m = pickOf(rand, milestones);
          milestones[milestones.indexOf(m)] = {
            ...m,
            completedAt: m.completedAt ? null : "2026-10-04",
          };
        }
        await device.repo.saveAnnualGoal({
          ...goal,
          title: edit === "title" ? `Goal ${device.name}${(counter += 1)}` : goal.title,
          progressLog:
            edit === "progress"
              ? {
                  ...goal.progressLog,
                  [`2026-0${1 + Math.floor(rand() * 9)}`]: Math.floor(rand() * 9),
                }
              : goal.progressLog,
          milestones,
        });
        break;
      }
      case 9:
        await device.repo.updateSettings((current) => ({
          ...current,
          aiModel: `vendor/${device.name}${(counter += 1)}`,
        }));
        break;
      case 10:
        await device.repo.updateSettings((current) => ({
          ...current,
          previousDayReviewDoneDate: `2026-10-${String(1 + Math.floor(rand() * 28)).padStart(2, "0")}`,
        }));
        break;
      case 11:
        await device.repo.updateSettings((current) => ({
          ...current,
          gtdImportDoneAt: `2026-10-${String(1 + Math.floor(rand() * 28)).padStart(2, "0")}T00:00:00.000Z`,
        }));
        break;
      case 12:
      case 13: {
        // The doomed goals: A may delete one, B (and only B) may edit one.
        const id = pickOf(rand, DOOMED);
        if (device === a) {
          if (rand() < 0.5) await a.repo.deleteAnnualGoal(id);
        } else if (device === b) {
          const current = (await b.repo.listAnnualGoals()).find((goal) => goal.id === id);
          if (current)
            await b.repo.saveAnnualGoal({ ...current, title: `Edited by B ${(counter += 1)}` });
        }
        break;
      }
      default: {
        // An exchange between two random devices in a random domain, mid-scenario.
        const from = pickOf(rand, sim.devices);
        const to = pickOf(
          rand,
          sim.devices.filter((candidate) => candidate !== from),
        );
        await sim.exchange(from, to, pickOf(rand, ["gtd", "personal"] as const));
      }
    }
  };

  for (let step = 0; step < steps; step += 1) {
    await op(pickOf(rand, sim.devices));
  }
  return { sim, rand };
};

const DOMAINS: SyncDomain[] = ["gtd", "personal"];

describe("applying the same bundles in any order converges", () => {
  for (const seed of Array.from({ length: 24 }, (_, index) => index + 1)) {
    it(`seed ${seed}: shuffled orders, with repeats, on fresh replicas`, async () => {
      const { sim, rand } = await runScenario(seed, 55);

      const bundles: { domain: SyncDomain; changeSet: SyncChangeSet }[] = [];
      for (const device of sim.devices) {
        for (const domain of DOMAINS) {
          bundles.push({
            domain,
            changeSet: jsonRoundTrip(await device.repo.listSyncChanges(domain)),
          });
        }
      }

      const replicas = await createSyncHarness(5, {
        deviceIndexOffset: 10,
        startMs: HARNESS_START_MS - 3_600_000,
      });
      const dumps: Record<string, string>[] = [];
      for (const replica of replicas.devices) {
        const order = shuffled(rand, bundles);
        // A few bundles arrive twice (a re-read of the same file, a late duplicate).
        const repeats = shuffled(rand, bundles).slice(0, 3);
        const sequence = shuffled(rand, [...order, ...repeats]);
        for (const { domain, changeSet } of sequence) {
          await replica.repo.applySyncBundle(domain, changeSet);
        }
        const dump: Record<string, string> = {};
        for (const domain of DOMAINS) {
          dump[domain] = JSON.stringify(
            await replicas.dump(replica, domain, { snapshots: true, exact: true }),
          );
        }
        dumps.push(dump);
      }
      for (const dump of dumps.slice(1)) {
        expect(dump.gtd).toBe(dumps[0]?.gtd);
        expect(dump.personal).toBe(dumps[0]?.personal);
      }

      // Idempotence: applying everything once more changes nothing.
      const first = replicas.devices[0] as SyncDevice;
      for (const { domain, changeSet } of bundles) {
        const result = await first.repo.applySyncBundle(domain, changeSet);
        expect(result).toMatchObject({ applied: 0, tombstonesApplied: 0, conflictsLogged: 0 });
      }
      for (const domain of DOMAINS) {
        expect(
          JSON.stringify(await replicas.dump(first, domain, { snapshots: true, exact: true })),
        ).toBe(dumps[0]?.[domain]);
      }

      // The laptops themselves converge to the same state once they have exchanged everything.
      for (const domain of DOMAINS) {
        await sim.syncAll(domain);
        await sim.expectConverged(domain, { snapshots: true });
        const reference = await sim.dump(sim.devices[0] as SyncDevice, domain, { snapshots: true });
        const replica = await replicas.dump(first, domain, { snapshots: true });
        expect(replica.tables).toEqual(reference.tables);
        expect(replica.meta).toEqual(reference.meta);
        expect(replica.snapshots).toEqual(reference.snapshots);
      }
    });
  }
});
