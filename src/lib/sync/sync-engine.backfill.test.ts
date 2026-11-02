// @vitest-environment node
import { describe, expect, it } from "vitest";
import { runSyncCaptureBackfill } from "./backfill-driver";
import { createEngineWorld } from "./test-support/engine-harness";

/**
 * An unfinished capture backfill (an enable that was interrupted) leaves some entities without clocks
 * and snapshots. The engine then publishes nothing (the peers would read the gap as deletions) and
 * applies nothing (the merge would compare against missing history), reports why with a typed issue,
 * and carries on as soon as the pass has finished.
 */

const SMALL = { rowsPerChunk: 8, statementsPerChunk: 10_000 };

const interruptedPair = async () => {
  const world = await createEngineWorld([{ name: "A" }, { name: "B" }], { enableCapture: false });
  const a = world.device("A");
  const b = world.device("B");
  for (let i = 0; i < 40; i += 1) {
    await a.repo.createTask({ id: `a-${i}`, title: `A${i}`, bucket: "inbox" });
  }
  await b.repo.enableSyncCapture();
  await b.repo.createTask({ id: "from-b", title: "From B", bucket: "inbox" });
  await b.engine.publish();
  // A's enable stops after its first chunk.
  const first = await a.repo.enableSyncCapture({ limits: SMALL });
  expect(first.backfillComplete).toBe(false);
  return { world, a, b };
};

const snapshotCalls = (device: { calls: { method: string }[] }) =>
  device.calls.filter((call) => call.method === "readSyncSnapshot").length;

describe("the engine while the capture backfill is unfinished", () => {
  it("publishes nothing and says why", async () => {
    const { a } = await interruptedPair();
    const report = await a.engine.publish();
    expect(report.issues).toMatchObject([{ severity: "warning", code: "backfill_incomplete" }]);
    expect(report.domains).toEqual([]);
    expect(report.counterAdvanced).toBe(false);
    expect(snapshotCalls(a)).toBe(0);
  });

  it("publishes nothing when the final chunk's COMMIT fails after the engine saw the pass as finished", async () => {
    const { a, b } = await interruptedPair();
    // The final chunk runs to its COMMIT (status read OUTSIDE the writer queue now says "complete"),
    // then the COMMIT fails and the chunk rolls back: the stored pass is still running.
    let armed = false;
    let reachCommit!: () => void;
    const atCommit = new Promise<void>((resolve) => {
      reachCommit = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = a.db.execute.bind(a.db);
    a.db.execute = async (query, values) => {
      if (armed && query.trim().toUpperCase() === "COMMIT") {
        armed = false;
        reachCommit();
        await gate;
        throw new Error("disk I/O error");
      }
      return execute(query, values);
    };
    armed = true;
    const finalChunk = a.repo
      .continueSyncCaptureBackfill({
        limits: { rowsPerChunk: 100_000, statementsPerChunk: 100_000 },
        maxChunks: 1,
      })
      .catch((error: unknown) => error);
    await atCommit;
    const publishing = a.engine.publish();
    // Let the publisher pass its status read and queue behind the chunk.
    for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    expect(await finalChunk).toBeInstanceOf(Error);

    const report = await publishing;
    expect(report.counterAdvanced).toBe(false);
    expect(report.domains.some((domain) => domain.outcome === "published")).toBe(false);
    expect(report.issues.some((issue) => issue.code === "backfill_incomplete")).toBe(true);
    expect((await a.engine.getStatus()).backfill.complete).toBe(false);
    // Nothing partial reached the peer.
    await b.engine.pull();
    const ids = (await b.repo.listTasks({ includeCompleted: true })).map((task) => task.id);
    expect(ids.filter((id) => id.startsWith("a-"))).toEqual([]);

    // After the pass really finishes, the same peer receives everything.
    await runSyncCaptureBackfill(a.repo, {
      limits: SMALL,
      yieldBetweenChunks: async () => undefined,
    });
    await a.engine.publish();
    await b.engine.pull();
    expect(
      (await b.repo.listTasks({ includeCompleted: true })).filter((task) =>
        task.id.startsWith("a-"),
      ),
    ).toHaveLength(40);
  });

  it("applies nothing and says why, then merges once the pass has finished", async () => {
    const { a } = await interruptedPair();
    const blocked = await a.engine.pull();
    expect(blocked.issues).toMatchObject([{ severity: "warning", code: "backfill_incomplete" }]);
    expect(blocked.totals.bundlesApplied).toBe(0);
    expect(a.calls.filter((call) => call.method === "applySyncBundle")).toEqual([]);
    expect((await a.repo.listTasks({ includeCompleted: true })).map((t) => t.id)).not.toContain(
      "from-b",
    );

    await runSyncCaptureBackfill(a.repo, {
      limits: SMALL,
      yieldBetweenChunks: async () => undefined,
    });
    const merged = await a.engine.syncNow();
    expect(merged.pull.issues.filter((issue) => issue.severity !== "info")).toEqual([]);
    expect(merged.pull.totals.bundlesApplied).toBeGreaterThan(0);
    expect(merged.publish.domains.some((domain) => domain.outcome === "published")).toBe(true);
    expect((await a.repo.listTasks({ includeCompleted: true })).map((t) => t.id)).toContain(
      "from-b",
    );
  });

  it("is not ready, and exposes the progress for the page", async () => {
    const { a } = await interruptedPair();
    const status = await a.engine.getStatus();
    expect(status.ready).toBe(false);
    expect(status.backfill.complete).toBe(false);
    expect(status.backfill.progress).toMatchObject({ pass: 1 });
    expect(status.backfill.progress?.scannedRows).toBeGreaterThan(0);

    await runSyncCaptureBackfill(a.repo, {
      limits: SMALL,
      yieldBetweenChunks: async () => undefined,
    });
    const done = await a.engine.getStatus();
    expect(done.ready).toBe(true);
    expect(done.backfill.complete).toBe(true);
  });

  it("keeps capturing local edits meanwhile, and publishes them afterwards", async () => {
    const { a, b } = await interruptedPair();
    await a.repo.createTask({ id: "during", title: "During", bucket: "inbox" });
    await runSyncCaptureBackfill(a.repo, {
      limits: SMALL,
      yieldBetweenChunks: async () => undefined,
    });
    await a.engine.syncNow();
    await b.engine.syncNow();
    const ids = (await b.repo.listTasks({ includeCompleted: true })).map((task) => task.id);
    expect(ids).toContain("during");
    expect(ids).toContain("a-0");
    expect(ids).toContain("a-39");
  });
});
