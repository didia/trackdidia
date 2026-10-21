// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { AiMessage, AiProposal } from "../../domain/types";
import { readMetaOf, syncState } from "./capture-test-utils";
import type { SyncChangeSet } from "./change-set";
import { encodeHlc } from "./hlc";
import {
  createSyncHarness,
  HARNESS_START_MS,
  jsonRoundTrip,
  readConflicts,
  type SyncDevice,
} from "./test-support/two-device-harness";

/**
 * `ai_proposals` (monotonic status, foreign key to `ai_messages`) through the real repository
 * methods of simulated laptops with foreign keys enforced.
 */

// biome-ignore lint/suspicious/noExplicitAny: fixtures edit untyped JSON change sets
type Draft = Record<string, any>;

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

const proposal = (
  id: string,
  messageId: string,
  overrides: Partial<AiProposal> = {},
): AiProposal => ({
  id,
  messageId,
  type: "intention_draft",
  payloadJson: "{}",
  status: "pending",
  appliedEntityId: null,
  decidedAt: null,
  createdAt: "2026-10-04T12:00:00.000Z",
  ...overrides,
});

const statusRows = async (device: SyncDevice) =>
  device.db.select<{ id: string; status: string }[]>(
    "SELECT id, status FROM ai_proposals ORDER BY id",
  );

const pendingOf = async (device: SyncDevice) =>
  (await statusRows(device)).filter((row) => row.status === "pending").map((row) => row.id);

/**
 * What must be identical on converged replicas: the proposals, their clocks and snapshots. (The
 * one-time setting stamps every fresh database makes at startup carry the replica's own device id,
 * so settings are left out.)
 */
const proposalState = async (
  sim: Awaited<ReturnType<typeof createSyncHarness>>,
  device: SyncDevice,
) => {
  const dump = await sim.dump(device, "personal", { snapshots: true, exact: true });
  return JSON.stringify({
    rows: dump.tables.ai_proposals,
    meta: dump.meta.filter((row) => row.entity_type === "ai_proposals"),
    snapshots: (dump.snapshots ?? []).filter((row) => row.entity_type === "ai_proposals"),
  });
};

const threeDevices = async () => {
  const sim = await createSyncHarness(["A", "B", "C"]);
  return { sim, a: sim.device("A"), b: sim.device("B"), c: sim.device("C") };
};

const shared = async () => {
  const sim = await createSyncHarness(["A", "B"]);
  const a = sim.device("A");
  const b = sim.device("B");
  await a.repo.saveAiMessage(message("m1"));
  await a.repo.saveAiProposal(proposal("p1", "m1"));
  await sim.syncAll("personal");
  return { sim, a, b };
};

describe("terminal beats pending whatever the clocks say", () => {
  it("an accepted proposal wins over a LATER pending edit, on both laptops", async () => {
    const { sim, a, b } = await shared();
    a.clock.advance(1_000);
    await a.repo.decideAiProposal("p1", "accepted", "task-9");
    b.clock.advance(600_000); // B's pending row is stamped much later than A's decision
    await b.repo.saveAiProposal(proposal("p1", "m1", { payloadJson: '{"note":"edited"}' }));
    await sim.syncAll("personal");
    for (const device of [a, b]) {
      expect(await statusRows(device)).toEqual([{ id: "p1", status: "accepted" }]);
      const row = (
        await device.db.select<{ applied_entity_id: string }[]>(
          "SELECT applied_entity_id FROM ai_proposals",
        )
      )[0];
      expect(row?.applied_entity_id).toBe("task-9"); // the decision brings its whole row
    }
    await sim.expectConverged("personal", { snapshots: true });
    expect((await readConflicts(a)).filter((c) => c.kind === "terminal_divergence")).toEqual([]);
  });

  it("two laptops that both accept keep the later row and raise no conflict", async () => {
    const { sim, a, b } = await shared();
    a.clock.advance(1_000);
    await a.repo.decideAiProposal("p1", "accepted", "task-a");
    b.clock.advance(60_000);
    await b.repo.decideAiProposal("p1", "accepted", "task-b");
    await sim.syncAll("personal");
    for (const device of [a, b]) {
      expect(
        (
          await device.db.select<{ applied_entity_id: string }[]>(
            "SELECT applied_entity_id FROM ai_proposals",
          )
        )[0]?.applied_entity_id,
      ).toBe("task-b");
      expect((await readConflicts(device)).filter((c) => c.kind === "terminal_divergence")).toEqual(
        [],
      );
    }
    await sim.expectConverged("personal", { snapshots: true });
  });

  it.each([
    ["accepted", "dismissed", "accepted"],
    ["dismissed", "expired", "dismissed"],
    ["accepted", "expired", "accepted"],
  ] as const)(
    "%s on one laptop and %s on the other: %s wins on both, with one terminal_divergence conflict with the same id",
    async (onA, onB, winner) => {
      const { sim, a, b } = await shared();
      const decide = async (device: SyncDevice, status: "accepted" | "dismissed" | "expired") => {
        if (status === "expired") {
          await device.repo.saveAiProposal(proposal("p1", "m1", { status: "expired" }));
        } else {
          await device.repo.decideAiProposal("p1", status);
        }
      };
      // The LATER decision is the loser, so the winner is not "last writer".
      const winnerOnA = onA === winner;
      (winnerOnA ? a : b).clock.advance(1_000);
      (winnerOnA ? b : a).clock.advance(600_000);
      await decide(a, onA);
      await decide(b, onB);
      await sim.syncAll("personal");
      for (const device of [a, b]) {
        expect(await statusRows(device)).toEqual([{ id: "p1", status: winner }]);
      }
      await sim.expectConverged("personal", { snapshots: true });
      // The replica that first meets both rows logs it (here the loser's side, which adopts the
      // winner); conflicts are published later in the entity's domain bundle, and the id is the
      // same wherever it is found.
      const found = (
        await Promise.all(
          [a, b].map(async (device) =>
            (await readConflicts(device)).filter((row) => row.kind === "terminal_divergence"),
          ),
        )
      ).flat();
      expect(found.length).toBeGreaterThanOrEqual(1);
      expect(new Set(found.map((row) => row.id)).size).toBe(1);
      expect(found[0]).toMatchObject({
        entity_type: "ai_proposals",
        entity_id: "p1",
        resolved_at: null,
      });
      const sides = [found[0]?.local_json, found[0]?.remote_json].map((json) =>
        JSON.parse(String(json)),
      );
      expect(sides.map((side) => side.status).sort()).toEqual([onA, onB].sort());
    },
  );

  it("converges for every application order of three replicas (accepted, dismissed, pending)", async () => {
    const sim = await createSyncHarness(["A", "B", "C"]);
    const [a, b, c] = sim.devices as [SyncDevice, SyncDevice, SyncDevice];
    await a.repo.saveAiMessage(message("m1"));
    await a.repo.saveAiProposal(proposal("p1", "m1"));
    await sim.syncAll("personal");
    a.clock.advance(1_000);
    await a.repo.decideAiProposal("p1", "dismissed");
    b.clock.advance(5_000);
    await b.repo.decideAiProposal("p1", "accepted", "task-1");
    c.clock.advance(900_000);
    await c.repo.saveAiProposal(proposal("p1", "m1", { payloadJson: '{"late":true}' }));
    const bundles = await Promise.all(
      [a, b, c].map(async (device) => jsonRoundTrip(await device.repo.listSyncChanges("personal"))),
    );
    const orders = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    const replicas = await createSyncHarness(orders.length, { deviceIndexOffset: 10 });
    const dumps: string[] = [];
    for (const [index, order] of orders.entries()) {
      const replica = replicas.devices[index] as SyncDevice;
      for (const position of order) {
        await replica.repo.applySyncBundle("personal", bundles[position] as SyncChangeSet);
      }
      dumps.push(await proposalState(replicas, replica));
      expect(await statusRows(replica)).toEqual([{ id: "p1", status: "accepted" }]);
    }
    expect(new Set(dumps).size).toBe(1);
  });
});

describe("two pending proposals for one natural key", () => {
  it("keeps the later row clock pending, expires the other, and never aborts the bundle", async () => {
    const sim = await createSyncHarness(["A", "B"]);
    const [a, b] = sim.devices as [SyncDevice, SyncDevice];
    await a.repo.saveAiMessage(message("m1"));
    await sim.syncAll("personal");
    a.clock.advance(1_000);
    await a.repo.saveAiProposal(proposal("p-a", "m1"));
    b.clock.advance(60_000);
    await b.repo.saveAiProposal(proposal("p-b", "m1"));
    await sim.syncAll("personal");

    for (const device of [a, b]) {
      expect(await pendingOf(device)).toEqual(["p-b"]);
      expect(await statusRows(device)).toEqual([
        { id: "p-a", status: "expired" },
        { id: "p-b", status: "pending" },
      ]);
    }
    await sim.expectConverged("personal", { snapshots: true });
    const logged = (await Promise.all([a, b].map(async (device) => readConflicts(device))))
      .flat()
      .filter((row) => row.kind === "pending_collision");
    expect(logged.length).toBeGreaterThanOrEqual(1);
    expect(new Set(logged.map((row) => row.id)).size).toBe(1);
    expect(logged[0]).toMatchObject({ entity_type: "ai_proposals", entity_id: "p-a" });
    // The expired loser keeps the clock it had: no clock is issued while applying.
    expect((await readMetaOf(a.db, "ai_proposals", "p-a"))?.row_hlc).toBe(
      (await readMetaOf(b.db, "ai_proposals", "p-a"))?.row_hlc,
    );
    expect(await a.repo.enableSyncCapture()).toEqual({ installed: false, backfilled: 0 });
  });

  it("breaks an exact clock tie by the greater id, whichever arrives first", async () => {
    const sim = await createSyncHarness(["A", "B"]);
    const [a, b] = sim.devices as [SyncDevice, SyncDevice];
    await a.repo.saveAiMessage(message("m1"));
    await sim.syncAll("personal");
    await a.repo.saveAiProposal(proposal("p-1", "m1"));
    await b.repo.saveAiProposal(proposal("p-2", "m1"));
    // Both devices stamp at the same fake instant; only the device id differs in the clock, and the
    // clocks are compared first. Force the tie by giving both proposals the same stored clock.
    const bundleA = jsonRoundTrip(await a.repo.listSyncChanges("personal"));
    const bundleB = jsonRoundTrip(await b.repo.listSyncChanges("personal"));
    const tied = (bundle: SyncChangeSet): SyncChangeSet => {
      const draft = jsonRoundTrip(bundle) as unknown as Draft;
      const clock = encodeHlc(
        HARNESS_START_MS + 5_000,
        0,
        "dev:00000000-0000-4000-8000-0000000000aa",
      );
      for (const entity of draft.entities) {
        if (entity.table === "ai_proposals") entity.rowHlc = clock;
      }
      draft.hlcHigh = clock;
      return draft as unknown as SyncChangeSet;
    };
    const replicas = await createSyncHarness(2, { deviceIndexOffset: 20 });
    const [r1, r2] = replicas.devices as [SyncDevice, SyncDevice];
    await r1.repo.applySyncBundle("personal", tied(bundleA));
    await r1.repo.applySyncBundle("personal", tied(bundleB));
    await r2.repo.applySyncBundle("personal", tied(bundleB));
    await r2.repo.applySyncBundle("personal", tied(bundleA));
    expect(await statusRows(r1)).toEqual([
      { id: "p-1", status: "expired" },
      { id: "p-2", status: "pending" },
    ]);
    expect(await statusRows(r2)).toEqual(await statusRows(r1));
  });

  it("converges for every application order of three replicas that each created one", async () => {
    const { sim, a, b, c } = await threeDevices();
    await a.repo.saveAiMessage(message("m1"));
    await sim.syncAll("personal");
    a.clock.advance(1_000);
    await a.repo.saveAiProposal(proposal("p-a", "m1"));
    b.clock.advance(30_000);
    await b.repo.saveAiProposal(proposal("p-b", "m1"));
    c.clock.advance(10_000);
    await c.repo.saveAiProposal(proposal("p-c", "m1"));
    const bundles = await Promise.all(
      [a, b, c].map(async (device) => jsonRoundTrip(await device.repo.listSyncChanges("personal"))),
    );
    const orders = [
      [0, 1, 2],
      [0, 2, 1],
      [1, 0, 2],
      [1, 2, 0],
      [2, 0, 1],
      [2, 1, 0],
    ];
    const replicas = await createSyncHarness(orders.length, { deviceIndexOffset: 10 });
    const dumps: string[] = [];
    for (const [index, order] of orders.entries()) {
      const replica = replicas.devices[index] as SyncDevice;
      for (const position of order) {
        await replica.repo.applySyncBundle("personal", bundles[position] as SyncChangeSet);
      }
      expect(await pendingOf(replica)).toEqual(["p-b"]);
      dumps.push(await proposalState(replicas, replica));
    }
    expect(new Set(dumps).size).toBe(1);
  });

  it("keeps one pending goal evaluation per message AND goal, and lets multi-proposal types coexist", async () => {
    const sim = await createSyncHarness(["A", "B"]);
    const [a, b] = sim.devices as [SyncDevice, SyncDevice];
    await a.repo.saveAiMessage(message("m1"));
    await sim.syncAll("personal");
    const goalEval = (id: string, goalId: string) =>
      proposal(id, "m1", { type: "goal_evaluation", payloadJson: JSON.stringify({ goalId }) });
    a.clock.advance(1_000);
    await a.repo.saveAiProposal(goalEval("g-a1", "goal-1"));
    await a.repo.saveAiProposal(goalEval("g-a2", "goal-2"));
    await a.repo.saveAiProposal(proposal("x-a", "m1", { type: "gtd_action" }));
    b.clock.advance(60_000);
    await b.repo.saveAiProposal(goalEval("g-b1", "goal-1"));
    await b.repo.saveAiProposal(proposal("x-b", "m1", { type: "gtd_action" }));
    await sim.syncAll("personal");
    for (const device of [a, b]) {
      expect(await pendingOf(device)).toEqual(["g-a2", "g-b1", "x-a", "x-b"]);
      expect((await statusRows(device)).find((row) => row.id === "g-a1")?.status).toBe("expired");
    }
    await sim.expectConverged("personal", { snapshots: true });
  });

  it("a new pending proposal that sorts BEFORE the one it replaced applies without a collision abort", async () => {
    // The old proposal is expired on A and a new pending one is created. B still holds the old one
    // pending. Applying A's bundle visits the new id first, while B's old row is still pending.
    const sim = await createSyncHarness(["A", "B"]);
    const [a, b] = sim.devices as [SyncDevice, SyncDevice];
    await a.repo.saveAiMessage(message("m1"));
    await a.repo.saveAiProposal(proposal("p-z-old", "m1"));
    await sim.syncAll("personal");
    a.clock.advance(1_000);
    await a.repo.saveAiProposal(proposal("p-z-old", "m1", { status: "expired" }));
    a.clock.advance(1_000);
    await a.repo.saveAiProposal(proposal("p-a-new", "m1"));
    await sim.syncAll("personal");
    for (const device of [a, b]) {
      expect(await statusRows(device)).toEqual([
        { id: "p-a-new", status: "pending" },
        { id: "p-z-old", status: "expired" },
      ]);
    }
    await sim.expectConverged("personal", { snapshots: true });
  });
});

describe("a bundle that decides one proposal and adds a pending one for the same key", () => {
  it.each([
    ["the new pending id sorts after the old one", "p-1", "p-2"],
    ["the new pending id sorts BEFORE the old one", "p-z", "p-a"],
  ])(
    "(%s) the old one is decided, the new one stays pending, on a replica holding the old one pending and on one that never had it",
    async (_label, oldId, newId) => {
      const sim = await createSyncHarness(["A", "B", "C"]);
      const [a, b, c] = sim.devices as [SyncDevice, SyncDevice, SyncDevice];
      await a.repo.saveAiMessage(message("m1"));
      await a.repo.saveAiProposal(proposal(oldId, "m1"));
      await sim.exchange(a, b, "personal"); // B holds the old proposal pending; C has nothing yet
      a.clock.advance(1_000);
      await a.repo.decideAiProposal(oldId, "accepted", "task-1");
      a.clock.advance(1_000);
      await a.repo.saveAiProposal(proposal(newId, "m1"));
      const bundle = jsonRoundTrip(await a.repo.listSyncChanges("personal"));
      await b.repo.applySyncBundle("personal", bundle);
      await c.repo.applySyncBundle("personal", bundle);
      for (const device of [b, c]) {
        expect(await statusRows(device)).toEqual(
          [
            { id: newId, status: "pending" },
            { id: oldId, status: "accepted" },
          ].sort((x, y) => (x.id < y.id ? -1 : 1)),
        );
        expect(
          (await readConflicts(device)).filter((row) => row.kind === "pending_collision"),
        ).toEqual([]);
      }
      expect(await proposalState(sim, b)).toBe(await proposalState(sim, c));
    },
  );
});

describe("a delete racing a decision", () => {
  it("a decided proposal survives a LATER delete of the pending row, on both laptops", async () => {
    const { sim, a, b } = await shared();
    b.clock.advance(1_000);
    await b.repo.decideAiProposal("p1", "accepted", "task-1");
    a.clock.advance(600_000);
    await a.repo.clearPendingAiProposals("m1"); // A's delete is the later write
    await sim.syncAll("personal");
    for (const device of [a, b]) {
      expect(await statusRows(device)).toEqual([{ id: "p1", status: "accepted" }]);
    }
    await sim.expectConverged("personal", { snapshots: true });
  });
});

describe("the message a proposal belongs to", () => {
  it("applies the message before its proposals in one bundle, with foreign keys enforced", async () => {
    const { sim, a, b } = await twoDevicesWithMessages();
    await sim.exchange(a, b, "personal");
    expect(await statusRows(b)).toEqual([{ id: "p1", status: "pending" }]);
    expect(await b.db.select("SELECT 1 FROM ai_messages WHERE id = 'm1'")).toHaveLength(1);
  });

  it("skips a proposal whose message is not here, logs it, applies the rest, and applies it later", async () => {
    const { sim, a, b } = await twoDevicesWithMessages();
    await a.repo.createTask({ id: "t1", title: "Would have applied", bucket: "inbox" });
    const full = jsonRoundTrip(await a.repo.listSyncChanges("personal"));
    const withoutMessage = jsonRoundTrip(full) as unknown as Draft;
    withoutMessage.unionRows.ai_messages = [];
    const before = await syncState(b.db);

    const result = await b.repo.applySyncBundle(
      "personal",
      withoutMessage as unknown as SyncChangeSet,
    );
    expect(result.conflictsLogged).toBeGreaterThan(0);
    expect(await statusRows(b)).toEqual([]); // nothing written for the orphan
    const orphan = (await readConflicts(b)).filter((row) => row.kind === "orphaned_child");
    expect(orphan).toHaveLength(1);
    expect(orphan[0]).toMatchObject({
      entity_type: "ai_proposals",
      entity_id: "p1",
      resolved_at: null,
    });
    expect(await syncState(b.db)).not.toEqual(before); // the bundle's other content did apply

    // The bundle that brings the message lets the proposal apply; re-applying is a no-op.
    await b.repo.applySyncBundle("personal", full);
    expect(await statusRows(b)).toEqual([{ id: "p1", status: "pending" }]);
    expect(await b.repo.applySyncBundle("personal", full)).toMatchObject({ applied: 0 });
    await sim.syncAll("personal");
    await sim.expectConverged("personal", { snapshots: true });
  });
});

describe("deleting a pending proposal", () => {
  it("a later edit resurrects it, a later delete removes it, and both laptops converge", async () => {
    const { sim, a, b } = await shared();
    a.clock.advance(1_000);
    await a.repo.clearPendingAiProposals("m1"); // A's delete
    b.clock.advance(60_000);
    await b.repo.decideAiProposal("p1", "accepted"); // B's later decision
    await sim.syncAll("personal");
    for (const device of [a, b])
      expect(await statusRows(device)).toEqual([{ id: "p1", status: "accepted" }]);
    await sim.expectConverged("personal", { snapshots: true });

    // A later delete of a still-pending proposal removes it everywhere.
    await a.repo.saveAiProposal(proposal("p3", "m1", { type: "gtd_action" }));
    await sim.syncAll("personal");
    a.clock.advance(60_000);
    await a.repo.clearPendingAiProposals("m1");
    await sim.syncAll("personal");
    for (const device of [a, b]) {
      expect((await statusRows(device)).map((row) => row.id)).toEqual(["p1"]);
    }
    await sim.expectConverged("personal", { snapshots: true });
  });
});

async function twoDevicesWithMessages() {
  const sim = await createSyncHarness(["A", "B"]);
  const a = sim.device("A");
  const b = sim.device("B");
  await a.repo.saveAiMessage(message("m1"));
  await a.repo.saveAiProposal(proposal("p1", "m1"));
  return { sim, a, b };
}
