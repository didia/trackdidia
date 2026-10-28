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

const listCalls = (device: { calls: { method: string }[] }) =>
  device.calls.filter((call) => call.method === "listSyncChanges").length;

describe("the engine while the capture backfill is unfinished", () => {
  it("publishes nothing and says why", async () => {
    const { a } = await interruptedPair();
    const report = await a.engine.publish();
    expect(report.issues).toMatchObject([{ severity: "warning", code: "backfill_incomplete" }]);
    expect(report.domains).toEqual([]);
    expect(report.counterAdvanced).toBe(false);
    expect(listCalls(a)).toBe(0);
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
