// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { AiMessage, AiProposal, WeeklyObjective } from "../../domain/types";
import type { SyncChangeSet } from "./change-set";
import type { SyncDomain } from "./registry";
import {
  createSyncHarness,
  HARNESS_START_MS,
  jsonRoundTrip,
  type SyncDevice,
  type SyncHarness,
} from "./test-support/two-device-harness";

/**
 * Convergence by randomized scenario for the classes added with Pomodoro, AI proposals and the
 * objective/result foreign-key pair. Three laptops make random edits (and exchange at random
 * moments), then the final bundles of each domain are applied, in shuffled orders and with repeats,
 * to fresh replicas with foreign keys enforced. Every replica must hold identical rows, clocks and
 * snapshots of these tables. The generator is seeded: a failure reproduces from its seed.
 *
 * Scenario rule (as in `apply-convergence.test.ts`): a deleted parent follows the documented
 * limit of references.convergence.test.ts. The "doomed" objective is deleted by A and its results
 * are edited only by B; nobody edits the doomed objective itself, so it is never resurrected inside
 * a window where a result edit is applied (that combination converges by exchange, not in one pass).
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

const WEEKS = ["2026-10-04", "2026-10-11", "2026-10-18"];
const MESSAGES = ["m1", "m2"];
const TYPES = ["intention_draft", "tomorrow_focus_draft", "commitment", "gtd_action"] as const;

const objective = (id: string, title: string): WeeklyObjective => ({
  id,
  title,
  kind: "manual",
  targetHours: null,
  rescuetimeKind: null,
  rescuetimeThing: null,
  sortOrder: 0,
  startsOnWeekStartDate: null,
  endsOnWeekStartDate: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
});

const message = (id: string): AiMessage => ({
  id,
  surface: "coach_pulse",
  scopeKey: "2026-10-04",
  stance: null,
  kind: "pulse",
  inputHash: `hash-${id}`,
  promptVersion: "v1",
  model: "vendor/model",
  status: "ok",
  bodyJson: null,
  bodyText: "body",
  deltaClass: null,
  notified: false,
  tokensPrompt: null,
  tokensCompletion: null,
  latencyMs: null,
  createdAt: "2026-10-04T12:00:00.000Z",
});

const runScenario = async (seed: number, steps: number) => {
  const rand = prng(seed);
  const sim = await createSyncHarness(["A", "B", "C"]);
  const [a, b] = sim.devices as [SyncDevice, SyncDevice, SyncDevice];
  let counter = 0;
  const next = (prefix: string) => `${prefix}${(counter += 1)}`;

  for (const id of MESSAGES) await a.repo.saveAiMessage(message(id));
  await a.repo.saveWeeklyObjective(objective("live", "Live"));
  await a.repo.saveWeeklyObjective(objective("doomed", "Doomed"));
  for (const week of WEEKS) {
    await a.repo.saveWeeklyObjectiveResult({
      weekStartDate: week,
      objectiveId: "doomed",
      achieved: false,
      updatedAt: "",
    });
  }
  await sim.syncAll("personal");

  const op = async (device: SyncDevice) => {
    device.clock.advance(1 + Math.floor(rand() * 90_000));
    switch (Math.floor(rand() * 14)) {
      case 0:
      case 1: {
        // A finished focus session, sometimes cancelled; sometimes a timer is left running.
        const started = await device.repo.startPomodoro({ kind: "focus", title: next("focus ") });
        const id = started.activeSession?.id;
        if (id && rand() < 0.8) {
          device.clock.advance(1_000);
          await device.repo.stopPomodoroSession(id, rand() < 0.75 ? "completed" : "cancelled");
        }
        break;
      }
      case 2: {
        // Finish whatever is running so the next start works.
        const active = (await device.repo.getPomodoroState()).activeSession;
        if (active) await device.repo.stopPomodoroSession(active.id, "completed");
        break;
      }
      case 3:
      case 4: {
        const type = pickOf(rand, TYPES);
        const proposal: AiProposal = {
          id: next(`p-${device.name}-`),
          messageId: pickOf(rand, MESSAGES),
          type,
          payloadJson: "{}",
          status: "pending",
          appliedEntityId: null,
          decidedAt: null,
          createdAt: "2026-10-04T12:00:00.000Z",
        };
        // The app never stores two pending rows of one natural key itself.
        await device.repo.saveAiProposal(proposal).catch(() => undefined);
        break;
      }
      case 5: {
        const pending = await device.db.select<{ id: string }[]>(
          "SELECT id FROM ai_proposals WHERE status = 'pending' ORDER BY id",
        );
        if (pending.length === 0) break;
        const target = pickOf(rand, pending).id;
        await device.repo.decideAiProposal(
          target,
          rand() < 0.5 ? "accepted" : "dismissed",
          rand() < 0.5 ? next("applied-") : undefined,
        );
        break;
      }
      case 6: {
        if (rand() < 0.5) await device.repo.clearPendingAiProposals(pickOf(rand, MESSAGES));
        break;
      }
      case 7:
        await device.repo.saveWeeklyObjective(
          objective("live", `Live ${device.name}${(counter += 1)}`),
        );
        break;
      case 8: {
        await device.repo
          .saveWeeklyObjectiveResult({
            weekStartDate: pickOf(rand, WEEKS),
            objectiveId: "live",
            achieved: false,
            updatedAt: "",
          })
          .catch(() => undefined);
        break;
      }
      case 9: {
        await device.db.execute(
          "UPDATE weekly_objective_results SET achieved = $1 WHERE objective_id = 'live' AND week_start_date = $2",
          [Math.floor(rand() * 2), pickOf(rand, WEEKS)],
        );
        await device.stamp();
        break;
      }
      case 10: {
        if (device === a && rand() < 0.4) await a.repo.deleteWeeklyObjective("doomed");
        break;
      }
      case 11: {
        if (device === b) {
          await b.db.execute(
            "UPDATE weekly_objective_results SET achieved = 1 - achieved WHERE objective_id = 'doomed' AND week_start_date = $1",
            [pickOf(rand, WEEKS)],
          );
          await b.stamp();
        }
        break;
      }
      case 12: {
        if (device === b && rand() < 0.5) {
          // After A's delete reaches B this is a result for a missing objective: the app refuses it.
          await b.repo
            .saveWeeklyObjectiveResult({
              weekStartDate: pickOf(rand, ["2026-10-25", "2026-11-01"]),
              objectiveId: "doomed",
              achieved: false,
              updatedAt: "",
            })
            .catch(() => undefined);
        }
        break;
      }
      default: {
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

const TABLES = [
  "pomodoro_sessions",
  "pomodoro_segments",
  "ai_proposals",
  "weekly_objectives",
  "weekly_objective_results",
];

/**
 * The rows of these tables that are published, with their clocks and snapshots. With
 * `maskTombstones` the clock of a tombstone is hidden: a tombstone a replica had to invent (a child
 * edited later than its parent's delete) carries a clock of THAT replica, so replicas hold different,
 * all valid, tombstone clocks until they exchange. `withProposals: false` leaves `ai_proposals`
 * out: which pending proposals a replica expired (and whether it did before or after a delete
 * arrived) can differ in a single pass, and the proposals are compared after the exchange only.
 */
const stateOf = async (
  sim: SyncHarness,
  device: SyncDevice,
  maskTombstones = false,
  withProposals = true,
): Promise<string> => {
  const parts: Record<string, unknown> = {};
  const terminal = new Set(
    (
      await device.db.select<{ id: string }[]>(
        "SELECT id FROM pomodoro_sessions WHERE status IN ('completed', 'cancelled')",
      )
    ).map((row) => row.id),
  );
  const published = (table: string, row: Record<string, unknown>): boolean =>
    table === "pomodoro_sessions"
      ? terminal.has(String(row.id))
      : table === "pomodoro_segments"
        ? terminal.has(String(row.session_id))
        : true;
  const segmentSession = new Map(
    (
      await device.db.select<{ id: string; session_id: string }[]>(
        "SELECT id, session_id FROM pomodoro_segments",
      )
    ).map((row) => [row.id, row.session_id] as const),
  );
  const entityPublished = (row: Record<string, unknown>): boolean => {
    const table = String(row.entity_type);
    if (!TABLES.includes(table)) return false;
    if (table === "ai_proposals" && !withProposals) return false;
    const id = String(row.entity_id);
    if (table === "pomodoro_sessions") return terminal.has(id);
    if (table === "pomodoro_segments") return terminal.has(segmentSession.get(id) ?? "");
    return true;
  };
  for (const domain of ["gtd", "personal"] as SyncDomain[]) {
    const dump = await sim.dump(device, domain, { snapshots: true, exact: true });
    for (const table of TABLES) {
      if (table === "ai_proposals" && !withProposals) continue;
      if (dump.tables[table]) {
        parts[table] = dump.tables[table].filter((row) => published(table, row));
      }
    }
    parts[`${domain}-meta`] = dump.meta
      .filter(entityPublished)
      .map((row) =>
        maskTombstones && row.deleted_at !== null
          ? { ...row, row_hlc: "<tombstone>", deleted_at: "<tombstone>" }
          : row,
      );
    parts[`${domain}-snapshots`] = (dump.snapshots ?? []).filter(entityPublished);
  }
  return JSON.stringify(parts);
};

const DOMAINS: SyncDomain[] = ["gtd", "personal"];

describe("pomodoro, proposals and objectives converge in any application order", () => {
  for (const seed of Array.from({ length: 20 }, (_, index) => index + 1)) {
    it(`seed ${seed}: shuffled orders, with repeats, on fresh replicas with foreign keys on`, async () => {
      const { sim, rand } = await runScenario(seed, 60);
      const bundles: { domain: SyncDomain; changeSet: SyncChangeSet }[] = [];
      for (const device of sim.devices) {
        for (const domain of DOMAINS) {
          bundles.push({
            domain,
            changeSet: jsonRoundTrip(await device.repo.listSyncChanges(domain)),
          });
        }
      }
      // Nothing of a running timer is in any bundle.
      const running = new Set<string>();
      for (const device of sim.devices) {
        for (const row of await device.db.select<{ id: string }[]>(
          "SELECT id FROM pomodoro_sessions WHERE status IN ('running', 'paused')",
        )) {
          running.add(row.id);
        }
      }
      for (const { changeSet } of bundles) {
        for (const id of running) expect(JSON.stringify(changeSet)).not.toContain(id);
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
        states.push(await stateOf(replicas, replica, true, false));
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
      expect(await first.repo.enableSyncCapture()).toEqual({ installed: false, backfilled: 0 });

      // Replicas converge exactly once they exchange: the tombstones they invented differ in
      // clock only, and tombstone against tombstone keeps the later.
      for (const domain of DOMAINS) await replicas.syncAll(domain);
      const settled = await stateOf(replicas, first);
      for (const replica of replicas.devices)
        expect(await stateOf(replicas, replica)).toBe(settled);

      // The laptops converge to the same state once they exchange everything.
      for (const domain of DOMAINS) {
        await sim.syncAll(domain);
      }
      // A laptop may hold a running timer nobody else has, so the gtd dumps are compared through
      // `stateOf`, which keeps only what is published; personal data has no such local-only rows.
      await sim.expectConverged("personal", { snapshots: true });
      for (const device of sim.devices) {
        expect(await stateOf(sim, device, true, false)).toBe(states[0]);
      }

      // Everything, proposals included: after a full exchange among ALL the laptops and the
      // replicas, every device holds exactly the same published state.
      const everyone = [...sim.devices, ...replicas.devices];
      for (let round = 0; round < 3; round += 1) {
        for (const domain of DOMAINS) {
          for (const from of everyone) {
            for (const to of everyone) {
              if (from !== to)
                await to.repo.applySyncBundle(domain, await from.repo.listSyncChanges(domain));
            }
          }
        }
      }
      const finalState = await stateOf(sim, everyone[0] as SyncDevice);
      for (const device of everyone) {
        expect(await stateOf(sim, device), device.name).toBe(finalState);
        expect(await device.db.select("PRAGMA foreign_key_check")).toEqual([]);
      }
    });
  }
});
