// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createSyncHarness, jsonRoundTrip } from "./test-support/two-device-harness";

describe("sync conflict decisions", () => {
  it("retains both overwritten values after a dismissal is replicated", async () => {
    const sim = await createSyncHarness(["A", "B", "C"]);
    const a = sim.device("A"),
      b = sim.device("B");
    await a.repo.createTask({ id: "edit", title: "Original", bucket: "next_action" });
    await sim.syncAll("gtd");
    const task = (await b.repo.listTasks()).find((item) => item.id === "edit")!;
    await a.repo.completeTask("edit", "2026-10-02T10:00:00.000Z");
    b.clock.advance(5_000);
    await b.repo.saveTask({ ...task, bucket: "waiting_for" });
    await sim.syncAll("gtd");
    const conflict = (await b.repo.listSyncConflicts()).find(
      (item) => item.kind === "overwritten_edit",
    )!;
    expect(conflict).toBeDefined();
    await b.repo.resolveSyncConflict(conflict.id, { action: "dismiss" });
    await sim.syncAll("gtd");
    for (const device of sim.devices) {
      const received = (await device.repo.listSyncConflicts()).find(
        (item) => item.id === conflict.id,
      )!;
      expect(received.resolvedAt).not.toBeNull();
      expect(received.local).toEqual(conflict.local);
      expect(received.remote).toEqual(conflict.remote);
    }
  });
  it("does not resolve an ambiguous recurring occurrence", async () => {
    const sim = await createSyncHarness(["A"]);
    const a = sim.device("A");
    const invalid = JSON.stringify({
      outcome: "completed",
      template_id: "template",
      due_date: "not-a-date",
    });
    await a.db.execute(
      "INSERT INTO sync_conflicts (id, entity_type, entity_id, kind, local_json, remote_json, detected_at) VALUES ('bad', 'gtd_tasks', 'recurring-task:template', 'terminal_divergence', $1, $1, 'now')",
      [invalid],
    );
    await expect(
      a.repo.resolveSyncConflict("bad", { action: "choose", side: "local" }),
    ).rejects.toThrow("Ambiguous");
    expect((await a.repo.listSyncConflicts())[0]?.resolvedAt).toBeNull();
  });

  it("refuses a forged decision without applying any of its bundle", async () => {
    const sim = await createSyncHarness(["A", "B"]);
    const a = sim.device("A"),
      b = sim.device("B");
    await a.repo.createTask({ id: "forged", title: "Original", bucket: "inbox" });
    await sim.syncAll("gtd");
    await a.repo.completeTask("forged", "2026-10-02T10:00:00.000Z");
    await b.repo.cancelTask("forged");
    await sim.exchange(b, a, "gtd");
    const conflict = (await a.repo.listSyncConflicts()).find(
      (item) => item.kind === "terminal_divergence",
    )!;
    await a.repo.resolveSyncConflict(conflict.id, { action: "choose", side: "local" });
    const bundle = jsonRoundTrip(await a.repo.listSyncChanges("gtd"));
    const encoded = bundle.conflicts!.find((item) => item.id === conflict.id)!;
    encoded.resolution = JSON.stringify({ action: "choose", value: { status: "active" } });
    const before = await sim.dump(b, "gtd", { snapshots: true, exact: true });
    await expect(b.repo.applySyncBundle("gtd", bundle)).rejects.toThrow(
      "Resolution does not match",
    );
    expect(await sim.dump(b, "gtd", { snapshots: true, exact: true })).toEqual(before);
    const forged = jsonRoundTrip(await a.repo.listSyncChanges("gtd"));
    const row = forged.conflicts!.find((item) => item.id === conflict.id)!;
    const decision = JSON.parse(row.resolution!) as {
      value: Record<string, unknown>;
      local: Record<string, unknown>;
      remote: Record<string, unknown>;
    };
    const selectedSide =
      JSON.stringify(decision.value) === JSON.stringify(decision.local) ? "local" : "remote";
    decision[selectedSide] = {
      ...decision[selectedSide],
      bucket: "reference",
      completed_at: "2040-01-01T00:00:00.000Z",
    };
    decision.value = decision[selectedSide];
    row.resolution = JSON.stringify(decision);
    await expect(b.repo.applySyncBundle("gtd", forged)).rejects.toThrow("Resolution evidence");
    expect(await sim.dump(b, "gtd", { snapshots: true, exact: true })).toEqual(before);
    const reversed = jsonRoundTrip(await a.repo.listSyncChanges("gtd"));
    const reversedRow = reversed.conflicts!.find((item) => item.id === conflict.id)!;
    [reversedRow.local_json, reversedRow.remote_json] = [
      reversedRow.remote_json,
      reversedRow.local_json,
    ];
    await expect(b.repo.applySyncBundle("gtd", reversed)).resolves.toBeDefined();
  });

  it("resolves a conflict that still names an aliased task", async () => {
    const sim = await createSyncHarness(["A", "B"]);
    const a = sim.device("A"),
      b = sim.device("B");
    await a.repo.createTask({ id: "task-a", title: "Same", sourceExternalId: "remote:1" });
    await b.repo.createTask({ id: "task-z", title: "Same", sourceExternalId: "remote:1" });
    await a.repo.completeTask("task-a", "2026-10-02T10:00:00.000Z");
    await b.repo.cancelTask("task-z");
    await sim.syncAll("gtd");
    const conflict = (await a.repo.listSyncConflicts()).find(
      (item) => item.kind === "terminal_divergence",
    );
    expect(conflict).toBeDefined();
    await a.db.execute("UPDATE sync_conflicts SET entity_id = 'task-z' WHERE id = $1", [
      conflict!.id,
    ]);
    const local = conflict!.local as { status: string };
    await a.repo.resolveSyncConflict(conflict!.id, {
      action: "choose",
      side: local.status === "completed" ? "local" : "remote",
    });
    expect(
      (await a.repo.listTasks({ includeCompleted: true })).find((item) => item.id === "task-a")
        ?.status,
    ).toBe("completed");
    await sim.syncAll("gtd");
    for (const device of sim.devices)
      expect(
        (await device.repo.listTasks({ includeCompleted: true })).find(
          (item) => item.id === "task-a",
        )?.status,
      ).toBe("completed");
  });

  it("republishes the selected evidence while retaining a different local observation", async () => {
    const sim = await createSyncHarness(["A", "B", "C"]);
    const a = sim.device("A"),
      b = sim.device("B"),
      c = sim.device("C");
    await a.repo.createTask({ id: "evidence", title: "Evidence", bucket: "inbox" });
    await sim.syncAll("gtd");
    await a.repo.completeTask("evidence", "2026-10-02T10:00:00.000Z");
    await b.repo.cancelTask("evidence");
    await sim.exchange(b, a, "gtd");
    const conflict = (await a.repo.listSyncConflicts()).find(
      (item) => item.kind === "terminal_divergence",
    )!;
    await a.repo.resolveSyncConflict(conflict.id, { action: "choose", side: "local" });
    const old = { ...(conflict.local as Record<string, unknown>), bucket: "reference" };
    await b.db.execute(
      "INSERT INTO sync_conflicts (id, entity_type, entity_id, kind, local_json, remote_json, detected_at) VALUES ($1, 'gtd_tasks', 'evidence', 'terminal_divergence', $2, $3, 'old')",
      [conflict.id, JSON.stringify(old), JSON.stringify(conflict.remote)],
    );
    await sim.exchange(a, b, "gtd");
    expect(
      (await b.repo.listSyncConflicts()).find((item) => item.id === conflict.id)?.local,
    ).toEqual(old);
    await expect(sim.exchange(b, c, "gtd")).resolves.toBeDefined();
    expect(
      (await c.repo.listTasks({ includeCompleted: true })).find((item) => item.id === "evidence")
        ?.status,
    ).toBe("completed");
  });
  it("restores a context blocked by a name collision and validates uniqueness", async () => {
    const sim = await createSyncHarness(["A", "B", "C"]);
    const a = sim.device("A"),
      b = sim.device("B");
    await a.repo.saveContext({
      id: "ctx-a",
      name: "Maison",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    await b.repo.saveContext({
      id: "ctx-b",
      name: "Maison",
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    await sim.exchange(b, a, "gtd");
    const conflict = (await a.repo.listSyncConflicts()).find(
      (item) => item.kind === "name_collision",
    );
    expect(conflict).toBeDefined();
    await expect(
      a.repo.resolveSyncConflict(conflict!.id, { action: "rename", name: "Maison" }),
    ).rejects.toThrow();
    expect(
      (await a.repo.listSyncConflicts()).find((item) => item.id === conflict!.id)?.resolvedAt,
    ).toBeNull();
    await a.repo.resolveSyncConflict(conflict!.id, { action: "rename", name: "Maison secondaire" });
    const forged = jsonRoundTrip(await a.repo.listSyncChanges("gtd"));
    const forgedRow = forged.conflicts!.find((item) => item.id === conflict!.id)!;
    const forgedDecision = JSON.parse(forgedRow.resolution!) as { row: Record<string, unknown> };
    forgedDecision.row.created_at = "2040-01-01T00:00:00.000Z";
    forgedRow.resolution = JSON.stringify(forgedDecision);
    const before = await sim.dump(b, "gtd", { snapshots: true, exact: true });
    await expect(b.repo.applySyncBundle("gtd", forged)).rejects.toThrow(
      "Invalid context resolution payload",
    );
    expect(await sim.dump(b, "gtd", { snapshots: true, exact: true })).toEqual(before);
    await sim.syncAll("gtd");
    for (const device of sim.devices) {
      expect((await device.repo.listContexts()).find((item) => item.id === "ctx-b")?.name).toBe(
        "Maison secondaire",
      );
    }
    const context = (await a.repo.listContexts()).find((item) => item.id === "ctx-b")!;
    a.clock.advance(60_000);
    await a.repo.saveContext({ ...context, name: "Maison renommée" });
    await sim.syncAll("gtd");
    for (const device of sim.devices) {
      expect((await device.repo.listContexts()).find((item) => item.id === "ctx-b")?.name).toBe(
        "Maison renommée",
      );
    }
    a.clock.advance(60_000);
    await a.db.execute("DELETE FROM gtd_contexts WHERE id = 'ctx-b'");
    await a.stamp();
    await sim.syncAll("gtd");
    for (const device of sim.devices) {
      expect(
        (await device.repo.listContexts()).find((item) => item.id === "ctx-b"),
      ).toBeUndefined();
    }
  });
  it("publishes the chosen terminal outcome to three devices and stays settled on stale replay", async () => {
    const sim = await createSyncHarness(["A", "B", "C"]);
    const a = sim.device("A"),
      b = sim.device("B"),
      c = sim.device("C");
    await a.repo.createTask({ id: "choice", title: "Choice", bucket: "inbox" });
    await sim.syncAll("gtd");
    a.clock.advance(1000);
    await a.repo.completeTask("choice", "2026-10-02T10:00:00.000Z");
    b.clock.advance(5000);
    await b.repo.cancelTask("choice");
    const stale = jsonRoundTrip(await b.repo.listSyncChanges("gtd"));
    await sim.exchange(b, a, "gtd");
    const conflict = (await a.repo.listSyncConflicts()).find(
      (item) => item.kind === "terminal_divergence",
    );
    expect(conflict).toBeDefined();
    const local = conflict?.local as { status: string };
    await a.repo.resolveSyncConflict(conflict!.id, {
      action: "choose",
      side: local.status === "completed" ? "local" : "remote",
    });
    await sim.syncAll("gtd");
    for (const device of [a, b, c]) {
      expect(
        (await device.repo.listTasks({ includeCompleted: true })).find(
          (task) => task.id === "choice",
        )?.status,
      ).toBe("completed");
      expect(
        (await device.repo.listSyncConflicts()).find((item) => item.id === conflict!.id)
          ?.resolvedAt,
      ).not.toBeNull();
    }
    const first = await c.repo.applySyncBundle("gtd", stale);
    const second = await c.repo.applySyncBundle("gtd", stale);
    expect(second.applied + second.tombstonesApplied + second.conflictsLogged).toBe(0);
    expect(
      (await c.repo.listTasks({ includeCompleted: true })).find((task) => task.id === "choice")
        ?.status,
    ).toBe("completed");
    expect(first).toBeDefined();
  });

  it("converges when two devices resolve the same conflict differently offline", async () => {
    const sim = await createSyncHarness(["A", "B", "C"]);
    const a = sim.device("A"),
      b = sim.device("B");
    await a.repo.createTask({ id: "race", title: "Race", bucket: "inbox" });
    await sim.syncAll("gtd");
    await a.repo.completeTask("race", "2026-10-02T10:00:00.000Z");
    b.clock.advance(1000);
    await b.repo.cancelTask("race");
    await sim.syncAll("gtd");
    const ca = (await a.repo.listSyncConflicts()).find(
      (item) => item.kind === "terminal_divergence",
    )!;
    const cb = (await b.repo.listSyncConflicts()).find(
      (item) => item.kind === "terminal_divergence",
    )!;
    await a.repo.resolveSyncConflict(ca.id, {
      action: "choose",
      side: (ca.local as { status: string }).status === "completed" ? "local" : "remote",
    });
    b.clock.advance(5000);
    await b.repo.resolveSyncConflict(cb.id, {
      action: "choose",
      side: (cb.local as { status: string }).status === "cancelled" ? "local" : "remote",
    });
    await sim.syncAll("gtd");
    for (const device of sim.devices)
      expect(
        (await device.repo.listTasks({ includeCompleted: true })).find((item) => item.id === "race")
          ?.status,
      ).toBe("cancelled");
    await sim.expectConverged("gtd", { snapshots: true });
  });
});
