// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { Project, Task } from "../../domain/types";
import { syncState } from "./capture-test-utils";
import {
  createSyncHarness,
  readConflicts,
  type SyncDevice,
  type SyncHarness,
} from "./test-support/two-device-harness";

/**
 * Canonical identity for GTD through the real repository methods of simulated laptops (real SQLite
 * with foreign keys on, real capture triggers): tasks and projects that two laptops minted under
 * different ids for one `source_external_id`, with events, Pomodoro segments, subtasks and project
 * references that must follow the canonical id.
 */

const SOURCE = "relationship-draw:children:2026-10-04";

const findTask = async (device: SyncDevice, id: string): Promise<Task | undefined> =>
  (await device.repo.listTasks({ includeCompleted: true })).find((task) => task.id === id);

const aliasRows = (device: SyncDevice) =>
  device.db.select<{ entity_type: string; alias_id: string; canonical_id: string }[]>(
    "SELECT entity_type, alias_id, canonical_id FROM sync_id_aliases ORDER BY entity_type, alias_id",
  );

const expectNothingToStamp = async (device: SyncDevice): Promise<void> => {
  const before = await syncState(device.db);
  expect(await device.repo.enableSyncCapture()).toMatchObject({
    installed: false,
    backfilled: 0,
    backfillComplete: true,
  });
  expect(await syncState(device.db)).toEqual(before);
};

const project = (id: string, sourceExternalId: string | null): Project => ({
  id,
  title: `Project ${id}`,
  status: "active",
  statusChangedAt: "2026-10-01T00:00:00.000Z",
  notes: "",
  contextIds: [],
  source: "manual",
  sourceExternalId,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
});

const exchangeInOrder = async (sim: SyncHarness, order: string[], domain = "gtd" as const) => {
  for (const step of order) {
    const [from, to] = step.split(">");
    await sim.exchange(sim.device(from as string), sim.device(to as string), domain);
  }
};

const countOf = async (device: SyncDevice, sql: string, params: unknown[] = []) =>
  (await device.db.select<{ n: number }[]>(sql, params))[0]?.n;

describe("a task minted under two ids for one source_external_id", () => {
  const setup = async (idA: string, idB: string) => {
    const sim = await createSyncHarness(["A", "B"]);
    const [a, b] = [sim.device("A"), sim.device("B")];
    await a.repo.createTask({
      id: idA,
      title: "Jouer",
      bucket: "next_action",
      sourceExternalId: SOURCE,
    });
    b.clock.advance(5_000);
    await b.repo.createTask({
      id: idB,
      title: "Jouer",
      bucket: "next_action",
      sourceExternalId: SOURCE,
    });
    return { sim, a, b };
  };

  it.each([
    ["the smaller id is local", "task-a", "task-b"],
    ["the larger id is local", "task-z", "task-b"],
  ])(
    "merges both copies under the smaller id (%s), completion and edits surviving",
    async (_name, idA, idB) => {
      const { sim, a, b } = await setup(idA, idB);
      const canonical = [idA, idB].sort()[0] as string;
      const alias = [idA, idB].sort()[1] as string;
      a.clock.advance(1_000);
      await a.repo.completeTask(idA, "2026-10-04T15:00:00.000Z");
      b.clock.advance(60_000);
      await b.repo.saveTask({ ...((await findTask(b, idB)) as Task), title: "Jouer dehors" });

      await sim.syncAll("gtd");

      for (const device of [a, b]) {
        const tasks = await device.repo.listTasks({ includeCompleted: true });
        expect(tasks.map((task) => task.id)).toEqual([canonical]);
        expect(tasks[0]).toMatchObject({
          status: "completed",
          title: "Jouer dehors",
          sourceExternalId: SOURCE,
        });
        expect(await aliasRows(device)).toEqual([
          { entity_type: "gtd_tasks", alias_id: alias, canonical_id: canonical },
        ]);
        // The alias leaves no trace: no meta, no snapshot, no event, no dirty mark.
        for (const sql of [
          "SELECT COUNT(*) AS n FROM sync_entity_meta WHERE entity_type = 'gtd_tasks' AND entity_id = $1",
          "SELECT COUNT(*) AS n FROM sync_entity_snapshot WHERE entity_type = 'gtd_tasks' AND entity_id = $1",
          "SELECT COUNT(*) AS n FROM gtd_task_events WHERE task_id = $1",
          "SELECT COUNT(*) AS n FROM sync_dirty WHERE entity_id = $1",
        ]) {
          expect(await countOf(device, sql, [alias]), sql).toBe(0);
        }
        await expectNothingToStamp(device);
      }
      await sim.expectConverged("gtd", { snapshots: true, exact: true });
    },
  );

  it("moves events, Pomodoro segments, subtasks and project references to the canonical id", async () => {
    const { sim, a, b } = await setup("task-z", "task-b");
    await a.repo.saveProject(project("proj-a", null));
    await a.repo.createTask({
      id: "child",
      title: "Sub",
      bucket: "next_action",
      parentTaskId: "task-z",
      projectId: "proj-a",
    });
    // A focus session on the task that will become an alias.
    const started = await a.repo.startPomodoro({ kind: "focus", taskId: "task-z" });
    a.clock.advance(1_000);
    await a.repo.stopPomodoroSession(started.activeSession?.id as string, "completed");
    const eventsBefore = await countOf(
      a,
      "SELECT COUNT(*) AS n FROM gtd_task_events WHERE task_id = 'task-z'",
    );
    expect(eventsBefore).toBeGreaterThan(0);

    await sim.syncAll("gtd");

    for (const device of [a, b]) {
      expect((await findTask(device, "child"))?.parentTaskId).toBe("task-b");
      expect(
        await countOf(
          device,
          "SELECT COUNT(*) AS n FROM pomodoro_segments WHERE task_id = 'task-b'",
        ),
      ).toBe(1);
      expect(
        await countOf(
          device,
          "SELECT COUNT(*) AS n FROM pomodoro_segments WHERE task_id = 'task-z'",
        ),
      ).toBe(0);
      // Both copies' creation events are kept, under the canonical id.
      expect(
        await countOf(device, "SELECT COUNT(*) AS n FROM gtd_task_events WHERE task_id = 'task-b'"),
      ).toBeGreaterThanOrEqual(eventsBefore as number);
      expect(
        await countOf(device, "SELECT COUNT(*) AS n FROM gtd_task_events WHERE task_id = 'task-z'"),
      ).toBe(0);
      await expectNothingToStamp(device);
    }
    await sim.expectConverged("gtd", { snapshots: true, exact: true });
  });

  it("applies the same bundle twice without issuing or changing anything", async () => {
    const { sim, a, b } = await setup("task-z", "task-b");
    await sim.syncAll("gtd");
    const before = await syncState(a.db);
    const result = await sim.exchange(b, a, "gtd");
    expect(result).toMatchObject({ applied: 0, tombstonesApplied: 0, conflictsLogged: 0 });
    expect(await syncState(a.db)).toEqual(before);
  });
});

describe("a project minted under two ids for one source_external_id", () => {
  it("merges them and re-points the tasks of both", async () => {
    const sim = await createSyncHarness(["A", "B"]);
    const [a, b] = [sim.device("A"), sim.device("B")];
    await a.repo.saveProject(project("proj-z", "legacy:42"));
    await a.repo.createTask({
      id: "t-a",
      title: "In z",
      bucket: "next_action",
      projectId: "proj-z",
    });
    b.clock.advance(5_000);
    await b.repo.saveProject(project("proj-b", "legacy:42"));
    await b.repo.createTask({
      id: "t-b",
      title: "In b",
      bucket: "next_action",
      projectId: "proj-b",
    });

    await sim.syncAll("gtd");

    for (const device of [a, b]) {
      expect((await device.repo.listProjects()).map((p) => p.id)).toEqual(["proj-b"]);
      const tasks = await device.repo.listTasks({ includeCompleted: true });
      expect(tasks.map((task) => [task.id, task.projectId]).sort()).toEqual([
        ["t-a", "proj-b"],
        ["t-b", "proj-b"],
      ]);
      await expectNothingToStamp(device);
    }
    await sim.expectConverged("gtd", { snapshots: true, exact: true });
    expect(await aliasRows(a)).toEqual([
      { entity_type: "gtd_projects", alias_id: "proj-z", canonical_id: "proj-b" },
    ]);
  });
});

describe("three laptops, three ids", () => {
  const ids = ["task-m", "task-c", "task-x"]; // the smallest, "task-c", is on the middle laptop

  const world = async () => {
    const sim = await createSyncHarness(["A", "B", "C"]);
    for (const [index, device] of sim.devices.entries()) {
      device.clock.advance(1_000 * (index + 1));
      await device.repo.createTask({
        id: ids[index] as string,
        title: `Copy ${index}`,
        bucket: "next_action",
        sourceExternalId: SOURCE,
      });
    }
    return sim;
  };

  const orders = [
    ["A>B", "B>C", "C>A", "A>B", "B>C"],
    ["C>B", "B>A", "A>C", "C>B", "B>A"],
    ["A>C", "C>B", "B>A", "A>C", "C>B"],
    ["B>A", "B>C", "A>C", "C>A", "A>B"],
    ["C>A", "A>B", "B>C", "C>A", "A>B"],
    ["B>C", "C>A", "A>B", "B>C", "C>A"],
  ];

  it.each(orders.map((order) => [order.join(" ")]))(
    "converges to one task with one class in the order %s",
    async (label) => {
      const sim = await world();
      await exchangeInOrder(sim, (label as string).split(" "));
      await sim.syncAll("gtd");
      for (const device of sim.devices) {
        expect(
          (await device.repo.listTasks({ includeCompleted: true })).map((task) => task.id),
        ).toEqual(["task-c"]);
        expect(await aliasRows(device)).toEqual([
          { entity_type: "gtd_tasks", alias_id: "task-m", canonical_id: "task-c" },
          { entity_type: "gtd_tasks", alias_id: "task-x", canonical_id: "task-c" },
        ]);
        await expectNothingToStamp(device);
      }
      await sim.expectConverged("gtd", { snapshots: true, exact: true });
    },
  );
});

describe("rows that still carry an alias id after the alias is known", () => {
  it("a peer that never learned the alias keeps publishing it: its row merges into the canonical one", async () => {
    const sim = await createSyncHarness(["A", "B", "C"]);
    const [a, b, c] = sim.devices as [SyncDevice, SyncDevice, SyncDevice];
    await a.repo.createTask({
      id: "task-a",
      title: "At A",
      bucket: "next_action",
      sourceExternalId: SOURCE,
    });
    b.clock.advance(1_000);
    await b.repo.createTask({
      id: "task-z",
      title: "At B",
      bucket: "next_action",
      sourceExternalId: SOURCE,
    });
    await sim.exchange(b, a, "gtd");
    await sim.exchange(a, b, "gtd");
    expect(await aliasRows(a)).toHaveLength(1);

    // C knows only task-z and keeps editing it and referencing it.
    await sim.exchange(b, c, "gtd"); // C gets task-a (canonical) and the alias... so use an old copy instead:
    const stale = await createSyncHarness(["D"], { deviceIndexOffset: 5 });
    const d = stale.device("D");
    await d.repo.createTask({
      id: "task-z",
      title: "Old copy",
      bucket: "next_action",
      sourceExternalId: SOURCE,
    });
    d.clock.advance(120_000);
    await d.repo.saveTask({ ...((await findTask(d, "task-z")) as Task), title: "Edited by D" });
    await d.repo.createTask({
      id: "child-d",
      title: "Under z",
      bucket: "inbox",
      parentTaskId: "task-z",
    });
    await a.repo.applySyncBundle("gtd", await d.repo.listSyncChanges("gtd"));

    expect(
      (await a.repo.listTasks({ includeCompleted: true })).map((task) => task.id).sort(),
    ).toEqual(["child-d", "task-a"]);
    expect(await findTask(a, "task-a")).toMatchObject({ title: "Edited by D" });
    expect((await findTask(a, "child-d"))?.parentTaskId).toBe("task-a");
    await expectNothingToStamp(a);
  });
});

describe("tombstones of aliased entities", () => {
  // A learns the alias first (B's copy arrives), then B deletes ITS copy before hearing back: B's
  // tombstone names the alias id, which A rewrites to the canonical one.
  const setup = async () => {
    const sim = await createSyncHarness(["A", "B"]);
    const [a, b] = [sim.device("A"), sim.device("B")];
    await a.repo.createTask({
      id: "task-a",
      title: "At A",
      bucket: "next_action",
      sourceExternalId: SOURCE,
    });
    b.clock.advance(1_000);
    await b.repo.createTask({
      id: "task-z",
      title: "At B",
      bucket: "next_action",
      sourceExternalId: SOURCE,
    });
    await sim.exchange(b, a, "gtd");
    expect(await aliasRows(a)).toHaveLength(1);
    return { sim, a, b };
  };

  it("a delete of the alias copy against a later edit of the canonical one keeps the entity (edit wins)", async () => {
    const { sim, a, b } = await setup();
    b.clock.advance(2_000);
    await b.db.execute("DELETE FROM gtd_tasks WHERE id = 'task-z'");
    await b.stamp();
    a.clock.advance(600_000);
    await a.repo.saveTask({ ...((await findTask(a, "task-a")) as Task), title: "Kept by A" });

    await sim.syncAll("gtd");

    for (const device of [a, b]) {
      expect(
        (await device.repo.listTasks({ includeCompleted: true })).map((task) => task.title),
      ).toEqual(["Kept by A"]);
      await expectNothingToStamp(device);
    }
    await sim.expectConverged("gtd", { snapshots: true, exact: true });
  });

  it("a later delete of the alias copy removes the entity everywhere", async () => {
    const { sim, a, b } = await setup();
    b.clock.advance(600_000);
    await b.db.execute("DELETE FROM gtd_tasks WHERE id = 'task-z'");
    await b.stamp();

    await sim.syncAll("gtd");

    for (const device of [a, b]) {
      expect(await device.repo.listTasks({ includeCompleted: true })).toEqual([]);
      // The tombstone belongs to the canonical id; the alias id has no meta left.
      expect(
        await countOf(
          device,
          "SELECT COUNT(*) AS n FROM sync_entity_meta WHERE entity_id = 'task-z'",
        ),
      ).toBe(0);
      await expectNothingToStamp(device);
    }
    await sim.expectConverged("gtd", { snapshots: true, exact: true });
  });

  it("a delete that happened before either laptop knew the copies are one cannot be tied to the other copy", async () => {
    // Documented limit: a tombstone carries no natural key, so it names only the id that was deleted.
    const sim = await createSyncHarness(["A", "B"]);
    const [a, b] = [sim.device("A"), sim.device("B")];
    await a.repo.createTask({
      id: "task-a",
      title: "At A",
      bucket: "next_action",
      sourceExternalId: SOURCE,
    });
    b.clock.advance(1_000);
    await b.repo.createTask({
      id: "task-z",
      title: "At B",
      bucket: "next_action",
      sourceExternalId: SOURCE,
    });
    a.clock.advance(600_000);
    await a.db.execute("DELETE FROM gtd_tasks WHERE id = 'task-a'");
    await a.stamp();
    await sim.syncAll("gtd");
    for (const device of [a, b]) {
      expect(
        (await device.repo.listTasks({ includeCompleted: true })).map((task) => task.id),
      ).toEqual(["task-z"]);
    }
    await sim.expectConverged("gtd", { snapshots: true, exact: true });
  });
});

describe("references from the personal domain to an aliased task", () => {
  const message = (id: string) => ({
    id,
    surface: "coach_pulse" as const,
    scopeKey: "2026-10-04",
    stance: null,
    kind: "pulse",
    inputHash: `hash-${id}`,
    promptVersion: "v1",
    model: "vendor/model",
    status: "ok" as const,
    bodyJson: null,
    bodyText: "body",
    deltaClass: null,
    notified: false,
    tokensPrompt: null,
    tokensCompletion: null,
    latencyMs: null,
    createdAt: "2026-10-04T12:00:00.000Z",
  });

  const setup = async () => {
    const sim = await createSyncHarness(["A", "B"]);
    const [a, b] = [sim.device("A"), sim.device("B")];
    await a.repo.createTask({
      id: "task-a",
      title: "At A",
      bucket: "next_action",
      sourceExternalId: SOURCE,
    });
    b.clock.advance(1_000);
    await b.repo.createTask({
      id: "task-z",
      title: "At B",
      bucket: "next_action",
      sourceExternalId: SOURCE,
    });
    await b.repo.saveAiMessage(message("m1"));
    await b.repo.saveAiProposal({
      id: "p-pending",
      messageId: "m1",
      type: "gtd_action",
      payloadJson: JSON.stringify({
        taskId: "task-z",
        taskTitle: "At B",
        action: "drop",
        reason: "stale",
      }),
      status: "pending",
      appliedEntityId: null,
      decidedAt: null,
      createdAt: "2026-10-04T12:00:00.000Z",
    });
    await b.repo.saveAiProposal({
      id: "p-done",
      messageId: "m1",
      type: "gtd_action",
      payloadJson: JSON.stringify({
        taskId: "task-z",
        taskTitle: "At B",
        action: "drop",
        reason: "ok",
      }),
      status: "pending",
      appliedEntityId: null,
      decidedAt: null,
      createdAt: "2026-10-04T12:00:00.000Z",
    });
    await b.repo.decideAiProposal("p-done", "accepted", "task-z");
    return { sim, a, b };
  };

  const proposals = (device: SyncDevice) =>
    device.db.select<{ id: string; payload_json: string; applied_entity_id: string | null }[]>(
      "SELECT id, payload_json, applied_entity_id FROM ai_proposals ORDER BY id",
    );

  it.each([
    ["personal first, then the alias arrives", ["personal", "gtd"]],
    ["the alias first, then the stale personal rows", ["gtd", "personal"]],
  ] as const)("rewrites the payload and the applied entity (%s)", async (_name, domains) => {
    const { sim, a, b } = await setup();
    for (const domain of domains) {
      await sim.exchange(b, a, domain);
      await sim.exchange(a, b, domain);
    }
    await sim.syncAll("gtd");
    await sim.syncAll("personal");

    for (const device of [a, b]) {
      const rows = await proposals(device);
      expect(
        rows.map((row) => [row.id, JSON.parse(row.payload_json).taskId, row.applied_entity_id]),
      ).toEqual([
        ["p-done", "task-a", "task-a"],
        ["p-pending", "task-a", null],
      ]);
      // The proposal keeps everything else it said.
      expect(JSON.parse(rows[1]?.payload_json ?? "{}")).toMatchObject({
        reason: "stale",
        action: "drop",
      });
      await expectNothingToStamp(device);
    }
    await sim.expectConverged("personal", { snapshots: true, exact: true });
    await sim.expectConverged("gtd", { snapshots: true, exact: true });
  });

  it("resolveAlias follows the alias table for an id read from an older payload", async () => {
    const { sim, a } = await setup();
    await sim.syncAll("gtd");
    const { resolveAlias } = await import("./alias-store");
    expect(await resolveAlias(a.db, "gtd_tasks", "task-z")).toBe("task-a");
    expect(await resolveAlias(a.db, "gtd_tasks", "task-a")).toBe("task-a");
    expect(await resolveAlias(a.db, "gtd_tasks", "never-heard-of")).toBe("never-heard-of");
    expect(await resolveAlias(a.db, "gtd_projects", "task-z")).toBe("task-z");
  });
});

describe("gtd_task_events with a declared natural key (dedupe_key)", () => {
  const carryover = (id: string, taskId: string) => ({
    id,
    task_id: taskId,
    type: "weekly_carryover",
    event_date: "2026-04-19",
    event_at: "2026-04-19T00:00:00.000Z",
    created_at: "2026-04-19T00:00:00.000Z",
    dedupe_key: `weekly_carryover:2026-04-19:${taskId}`,
    metadata_json: '{"bucket":"next_action"}',
  });
  const insertEvent = (device: SyncDevice, event: ReturnType<typeof carryover>) =>
    device.db.execute(
      `INSERT INTO gtd_task_events (id, task_id, type, event_date, event_at, created_at, dedupe_key, metadata_json)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        event.id,
        event.task_id,
        event.type,
        event.event_date,
        event.event_at,
        event.created_at,
        event.dedupe_key,
        event.metadata_json,
      ],
    );

  it("the union keeps one event per key when two laptops write the same weekly carryover", async () => {
    const sim = await createSyncHarness(["A", "B"]);
    const [a, b] = [sim.device("A"), sim.device("B")];
    await a.repo.createTask({ id: "task-shared", title: "Shared", bucket: "next_action" });
    await sim.syncAll("gtd");
    await insertEvent(a, carryover("event-from-a", "task-shared"));
    await insertEvent(b, carryover("event-from-b", "task-shared"));

    await sim.syncAll("gtd");

    for (const device of [a, b]) {
      const events = await device.db.select<{ id: string }[]>(
        "SELECT id FROM gtd_task_events WHERE type = 'weekly_carryover'",
      );
      expect(events).toHaveLength(1);
      expect(await aliasRows(device)).toEqual([]);
    }
  });

  it("rewrites the task id embedded in the key when a task becomes an alias, keeping one event per week", async () => {
    const sim = await createSyncHarness(["A", "B"]);
    const [a, b] = [sim.device("A"), sim.device("B")];
    await a.repo.createTask({
      id: "task-a",
      title: "At A",
      bucket: "next_action",
      sourceExternalId: SOURCE,
    });
    b.clock.advance(1_000);
    await b.repo.createTask({
      id: "task-z",
      title: "At B",
      bucket: "next_action",
      sourceExternalId: SOURCE,
    });
    await insertEvent(a, carryover("event-a", "task-a"));
    await insertEvent(b, carryover("event-z", "task-z"));
    await insertEvent(b, {
      ...carryover("event-z2", "task-z"),
      event_date: "2026-04-26",
      dedupe_key: "weekly_carryover:2026-04-26:task-z",
    });

    await sim.syncAll("gtd");

    for (const device of [a, b]) {
      const events = await device.db.select<{ id: string; task_id: string; dedupe_key: string }[]>(
        "SELECT id, task_id, dedupe_key FROM gtd_task_events WHERE type = 'weekly_carryover' ORDER BY dedupe_key",
      );
      expect(events.map((event) => [event.task_id, event.dedupe_key])).toEqual([
        ["task-a", "weekly_carryover:2026-04-19:task-a"],
        ["task-a", "weekly_carryover:2026-04-26:task-a"],
      ]);
      // One event per week and task. (Which of two events with one key survives is a union matter:
      // the first one a replica holds stays, so replicas may keep different ids for the same key.)
    }
  });
});

describe("a name collision on contexts", () => {
  it("a rename onto a taken name keeps the local name and asks, without aborting", async () => {
    const sim = await createSyncHarness(["A", "B"]);
    const [a, b] = [sim.device("A"), sim.device("B")];
    await a.repo.saveContext({
      id: "context:bureau",
      name: "Bureau",
      createdAt: "",
      updatedAt: "",
    });
    await sim.syncAll("gtd");
    // Meanwhile A creates "Maison" and B renames "Bureau" to the same name.
    await a.repo.saveContext({
      id: "context:maison",
      name: "Maison",
      createdAt: "",
      updatedAt: "",
    });
    b.clock.advance(60_000);
    await b.repo.saveContext({
      id: "context:bureau",
      name: "Maison",
      createdAt: "",
      updatedAt: "",
    });
    await b.repo.createTask({
      id: "t-b",
      title: "Rides along",
      bucket: "inbox",
      contextIds: ["context:bureau"],
    });

    const result = await sim.exchange(b, a, "gtd");

    expect(result.conflictsLogged).toBe(1);
    expect(
      (await a.repo.listContexts()).map((context) => [context.id, context.name]).sort(),
    ).toEqual([
      ["context:bureau", "Bureau"],
      ["context:maison", "Maison"],
    ]);
    expect((await a.repo.listTasks({})).map((task) => task.id)).toEqual(["t-b"]);
    expect((await readConflicts(a)).filter((row) => row.kind === "name_collision")).toEqual([
      expect.objectContaining({
        entity_type: "gtd_contexts",
        entity_id: "context:bureau",
        resolved_at: null,
      }),
    ]);
    // Exchanging again neither aborts nor duplicates the question.
    await sim.exchange(b, a, "gtd");
    await sim.exchange(a, b, "gtd");
    expect((await readConflicts(a)).filter((row) => row.kind === "name_collision")).toHaveLength(1);
    // Nothing was stamped for the discarded rename: A still says "Bureau" with its own clock.
    await expectNothingToStamp(a);
  });

  it("a context created under a taken name is not inserted, and asks", async () => {
    const sim = await createSyncHarness(["A", "B"]);
    const [a, b] = [sim.device("A"), sim.device("B")];
    await a.repo.saveContext({
      id: "context:maison",
      name: "Maison",
      createdAt: "",
      updatedAt: "",
    });
    b.clock.advance(5_000);
    await b.repo.saveContext({ id: "context:home", name: "Maison", createdAt: "", updatedAt: "" });
    await sim.exchange(b, a, "gtd");
    expect((await a.repo.listContexts()).map((context) => context.id)).toEqual(["context:maison"]);
    expect((await readConflicts(a)).filter((row) => row.kind === "name_collision")).toHaveLength(1);
    await expectNothingToStamp(a);
  });
});
