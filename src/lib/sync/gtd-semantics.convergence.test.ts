// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Project, RecurringTaskTemplate } from "../../domain/types";
import type { SyncChangeSet } from "./change-set";
import {
  createSyncHarness,
  HARNESS_START_MS,
  jsonRoundTrip,
  type SyncDevice,
} from "./test-support/two-device-harness";

/**
 * Convergence of the GTD task rules by randomized scenario: three laptops make random task,
 * Planned-queue and recurring-occurrence edits (completing, cancelling, moving, generating further
 * days, clearing the backlog) and exchange bundles at random moments. Their final gtd bundles are
 * then applied, shuffled and with repeats, to fresh replicas, which must all end byte for byte in
 * the same state (rows, clocks, snapshots and the occurrence sidecars), and re-applying changes
 * nothing. Seeded, so a failure reproduces from its seed.
 *
 * Scope note: renumbering a Planned queue with duplicate orders writes orders without a clock and
 * is not a join (see `apply-gtd.ts`). The scenario therefore creates every planned task before the
 * laptops diverge and only reorders by swapping, which keeps the queue free of duplicates.
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

const TEMPLATE_ID = "recurring-template:conv";
const INSTANCE_ID = `recurring-task:${TEMPLATE_ID}`;
const BUCKETS = ["inbox", "next_action", "waiting_for", "someday_maybe"] as const;

const template: RecurringTaskTemplate = {
  id: TEMPLATE_ID,
  title: "Convergence habit",
  notes: "",
  targetBucket: "next_action",
  contextIds: [],
  projectId: null,
  ruleType: "daily",
  dailyInterval: 1,
  weeklyInterval: 1,
  weeklyDays: [0],
  monthlyMode: "day_of_month",
  dayOfMonth: 1,
  nthWeek: 1,
  weekday: 6,
  scheduledTime: null,
  startDate: "2026-03-01",
  status: "active",
  lastGeneratedForDate: null,
  pendingMissedOccurrences: 0,
  statusChangedAt: "2026-03-01T00:00:00.000Z",
  createdAt: "2026-03-01T00:00:00.000Z",
  updatedAt: "2026-03-01T00:00:00.000Z",
};

const project: Project = {
  id: "p1",
  title: "Project",
  status: "active",
  statusChangedAt: "2026-03-01T00:00:00.000Z",
  notes: "",
  contextIds: [],
  source: "manual",
  sourceExternalId: null,
  createdAt: "2026-03-01T00:00:00.000Z",
  updatedAt: "2026-03-01T00:00:00.000Z",
};

const day = (n: number): string => `2026-03-${String(n).padStart(2, "0")}`;

const runScenario = async (seed: number, steps: number) => {
  const rand = prng(seed);
  const sim = await createSyncHarness(["A", "B", "C"]);
  const [a] = sim.devices as [SyncDevice, SyncDevice, SyncDevice];
  let counter = 0;

  await a.repo.saveProject(project);
  await a.repo.createTask({ id: "keep", title: "Keeper", bucket: "next_action", projectId: "p1" });
  for (const id of ["q1", "q2", "q3"]) {
    await a.repo.createTask({ id, title: id, bucket: "planned", projectId: "p1" });
  }
  for (const id of ["t1", "t2", "t3"]) {
    await a.repo.createTask({ id, title: id, bucket: "next_action" });
  }
  await a.repo.saveRecurringTaskTemplate(template);
  await a.repo.generateDueRecurringTasks(day(5));
  await sim.syncAll("gtd");

  const gen: Record<string, number> = { A: 5, B: 5, C: 5 };
  const op = async (device: SyncDevice) => {
    device.clock.advance(1 + Math.floor(rand() * 90_000));
    const tasks = (await device.repo.listTasks({ includeCompleted: true })).filter(
      (task) => !task.isRecurringInstance,
    );
    const open = tasks.filter((task) => task.status === "active");
    switch (Math.floor(rand() * 12)) {
      case 0:
        if (open.length) await device.repo.completeTask(pickOf(rand, open).id);
        break;
      case 1:
        if (open.length) await device.repo.cancelTask(pickOf(rand, open).id);
        break;
      case 2:
      case 3: {
        const movable = open.filter((task) => task.bucket !== "planned");
        if (movable.length) {
          await device.repo.moveTask(pickOf(rand, movable).id, pickOf(rand, BUCKETS), []);
        }
        break;
      }
      case 4: {
        const task = open.length ? pickOf(rand, open) : undefined;
        if (task) {
          await device.repo.saveTask({ ...task, title: `title ${device.name}${(counter += 1)}` });
        }
        break;
      }
      case 5: {
        const id = pickOf(rand, ["q1", "q2", "q3"]);
        const queued = (await device.repo.listTasks({ bucket: "planned" })).some(
          (task) => task.id === id,
        );
        if (queued) await device.repo.movePlannedTask(id, rand() < 0.5 ? "up" : "down");
        break;
      }
      case 6:
        gen[device.name] = (gen[device.name] as number) + 1 + Math.floor(rand() * 3);
        await device.repo.generateDueRecurringTasks(day(Math.min(28, gen[device.name] as number)));
        break;
      case 7: {
        const instance = (await device.repo.listTasks({ includeCompleted: true })).find(
          (task) => task.id === INSTANCE_ID,
        );
        if (instance?.status === "active") {
          await device.repo.completeTask(
            INSTANCE_ID,
            `${instance.recurrenceDueDate}T12:00:00.000Z`,
          );
        }
        break;
      }
      case 8: {
        const instance = (await device.repo.listTasks({ includeCompleted: true })).find(
          (task) => task.id === INSTANCE_ID,
        );
        if (instance?.status === "active" && rand() < 0.5) {
          await device.repo.cancelTask(INSTANCE_ID);
        } else if (instance?.status === "active") {
          await device.repo.clearPastRecurrences(INSTANCE_ID);
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

  for (let step = 0; step < steps; step += 1) {
    await op(pickOf(rand, sim.devices));
  }
  return { sim, rand };
};

describe("GTD task rules converge in any application order", () => {
  for (const seed of Array.from({ length: 20 }, (_, index) => index + 1)) {
    it(`seed ${seed}`, async () => {
      const { sim, rand } = await runScenario(seed, 50);
      const bundles: SyncChangeSet[] = [];
      for (const device of sim.devices) {
        bundles.push(jsonRoundTrip(await device.repo.listSyncChanges("gtd")));
      }

      const replicas = await createSyncHarness(4, {
        deviceIndexOffset: 10,
        startMs: HARNESS_START_MS - 3_600_000,
      });
      const dumps: string[] = [];
      for (const replica of replicas.devices) {
        const sequence = shuffled(rand, [...shuffled(rand, bundles), ...bundles.slice(0, 2)]);
        for (const changeSet of sequence) {
          await replica.repo.applySyncBundle("gtd", changeSet);
        }
        dumps.push(
          JSON.stringify(await replicas.dump(replica, "gtd", { snapshots: true, exact: true })),
        );
      }
      for (const dump of dumps.slice(1)) expect(dump).toBe(dumps[0]);

      const first = replicas.devices[0] as SyncDevice;
      for (const changeSet of bundles) {
        expect(await first.repo.applySyncBundle("gtd", changeSet)).toMatchObject({
          applied: 0,
          tombstonesApplied: 0,
          conflictsLogged: 0,
        });
      }

      await sim.syncAll("gtd");
      await sim.syncAll("gtd");
      await sim.expectConverged("gtd", { snapshots: true });
      const reference = await sim.dump(sim.devices[0] as SyncDevice, "gtd", { snapshots: true });
      const replica = await replicas.dump(first, "gtd", { snapshots: true });
      expect(replica.tables).toEqual(reference.tables);
    });
  }
});
