// @vitest-environment node
import { type ChildProcess, spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
// SAFETY: in-memory SQLite only.
import { createNodeSqliteDatabase } from "../../test/mocks/node-sqlite-database";
import type { Database } from "../storage/sqlite-db";
import { TauriSqliteRepository } from "../storage/tauri-sqlite-repository";
import { applyChunked } from "./apply-chunked";
import { DEFAULT_BACKFILL_LIMITS } from "./backfill-state";
import { decodeBundle, encodeBundle } from "./bundle";
import { type SyncChangeSet, validateChangeSet } from "./change-set";
import { DEFAULT_APPLY_LIMITS } from "./split-change-set";
import {
  insertSyntheticAccount,
  insertSyntheticTransactions,
  SIZE_1X,
  SIZE_2X,
  seedSyntheticDatabase,
} from "./test-support/synthetic-db";

/**
 * Scale measurements for the chunked backfill and the chunked apply. NOT part of the normal run:
 *
 * ```bash
 * SYNC_SCALE_MEASURE=1 SYNC_SCALE_SIZE=1x SYNC_SCALE_DELAY_MS=0.3 NODE_OPTIONS=--expose-gc \
 *   npx vitest run src/lib/sync/scale-measure.test.ts
 * ```
 *
 * `SYNC_SCALE_STAGE=backfill|merge|memory` runs one part in a fresh process (the memory numbers are
 * only honest that way: a process that already ran the first merge has reserved the memory a later
 * stage then "does not need"). Add `--max-old-space-size=N` to `NODE_OPTIONS` to find the smallest
 * JS heap a stage fits in.
 *
 * `SYNC_SCALE_SIZE` is `1x` (71,100 entities) or `2x`; `SYNC_SCALE_DELAY_MS` adds that many
 * milliseconds of busy waiting to every SQL statement, standing in for the Tauri IPC round trip the
 * in-process adapter does not have (default 0). Results are printed as `[SCALE] {json}` lines; the
 * numbers recorded in `docs/storage-and-backups.md` come from this file.
 *
 * A slot is one writer slot of the repository: one backfill chunk or one `applySyncBundle` call. The
 * 15-second serial-queue watchdog rejects OTHER writes that wait longer than that behind a slot, so
 * the maximum slot is the number that matters.
 */

const enabled = process.env.SYNC_SCALE_MEASURE === "1";
const size = process.env.SYNC_SCALE_SIZE === "2x" ? SIZE_2X : SIZE_1X;
const delayMs = Number(process.env.SYNC_SCALE_DELAY_MS ?? "0") || 0;
/** `backfill`, `merge` (first merge of a big peer bundle), `memory` (the finance bundle) or `all`. */
const stage = process.env.SYNC_SCALE_STAGE ?? "all";
const runs = (name: string): boolean => stage === "all" || stage === name;
const PEER_ID = "dev:7d1e2c3b-4a5f-4e6d-8c7b-9a0b1c2d3e4f";
const SELF_ID = "dev:0b9c7c1e-6a3f-4b8e-9d2a-1f2e3d4c5b6a";

const report = (label: string, data: Record<string, unknown>) => {
  console.info(
    `[SCALE] ${JSON.stringify({ label, size: size === SIZE_2X ? "2x" : "1x", delayMs, ...data })}`,
  );
};

const busyWait = (ms: number) => {
  if (ms <= 0) return;
  const until = performance.now() + ms;
  while (performance.now() < until) {
    /* simulated IPC round trip */
  }
};

interface Counted {
  db: Database;
  statements: () => number;
}

const counted = (raw: Database): Counted => {
  let statements = 0;
  return {
    db: {
      execute: (query, values) => {
        statements += 1;
        busyWait(delayMs);
        return raw.execute(query, values);
      },
      select: <T>(query: string, values?: unknown[]) => {
        statements += 1;
        busyWait(delayMs);
        return raw.select<T>(query, values);
      },
    },
    statements: () => statements,
  };
};

const open = async (deviceId: string, name: string) => {
  const raw = createNodeSqliteDatabase(":memory:", { foreignKeys: true });
  const wrapped = counted(raw);
  const repo = new TauriSqliteRepository("sqlite::memory:", async () => wrapped.db);
  await repo.initialize();
  await repo.ensureSyncIdentity({ deviceId, deviceName: name });
  return { raw, ...wrapped, repo };
};

const stats = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return {
    count: sorted.length,
    total: Math.round(values.reduce((sum, value) => sum + value, 0)),
    max: Math.round(sorted[sorted.length - 1] ?? 0),
    p50: Math.round(at(0.5)),
    p95: Math.round(at(0.95)),
  };
};

/** Peak resident memory of this process per named window, sampled by a helper process. */
const startSampler = () => {
  const child: ChildProcess = spawn(
    "node",
    [
      "-e",
      `const {execFileSync}=require("node:child_process");const pid=process.argv[1];
       setInterval(()=>{try{const rss=execFileSync("ps",["-o","rss=","-p",pid]).toString().trim();
       process.stdout.write(Date.now()+" "+rss+"\\n")}catch{}},20);`,
      String(process.pid),
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  const samples: { at: number; kb: number }[] = [];
  let tail = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    const lines = (tail + chunk.toString()).split("\n");
    tail = lines.pop() ?? "";
    for (const line of lines) {
      const [at, kb] = line.split(" ").map(Number);
      if (at && kb) samples.push({ at, kb });
    }
  });
  return {
    window: async <T>(label: string, work: () => Promise<T>) => {
      (globalThis as { gc?: () => void }).gc?.();
      await new Promise((resolve) => setTimeout(resolve, 80));
      const baseline = process.memoryUsage();
      let heapPeak = baseline.heapUsed;
      const timer = setInterval(() => {
        heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed);
      }, 4);
      const from = Date.now();
      const value = await work();
      const to = Date.now();
      clearInterval(timer);
      await new Promise((resolve) => setTimeout(resolve, 80));
      const inside = samples.filter((sample) => sample.at >= from && sample.at <= to + 40);
      const peakKb = Math.max(0, ...inside.map((sample) => sample.kb));
      (globalThis as { gc?: () => void }).gc?.();
      const after = process.memoryUsage();
      report(`memory ${label}`, {
        baselineRssMb: Math.round(baseline.rss / 1048576),
        peakRssMb: Math.round(peakKb / 1024),
        peakAboveBaselineMb: Math.max(0, Math.round(peakKb / 1024 - baseline.rss / 1048576)),
        retainedHeapMb: Math.round(after.heapUsed / 1048576),
        baselineHeapMb: Math.round(baseline.heapUsed / 1048576),
        sampledPeakHeapMb: Math.round(heapPeak / 1048576),
        sampled: inside.length,
        ms: to - from,
      });
      return value;
    },
    stop: () => child.kill(),
  };
};

describe.skipIf(!enabled)("scale measurements (SYNC_SCALE_MEASURE=1)", () => {
  it("measures the chunked backfill, the chunked first merge and the bundle memory", async () => {
    const sampler = startSampler();
    try {
      const a = await open(SELF_ID, "A");
      const seededAt = performance.now();
      const seeded = await seedSyntheticDatabase(a.raw, size);
      report("seed", { entities: seeded.entities, ms: Math.round(performance.now() - seededAt) });

      // ---- (i) chunked backfill -------------------------------------------------------------
      const slotMs: number[] = [];
      const slotStatements: number[] = [];
      let before = a.statements();
      const backfillStart = performance.now();
      let started = performance.now();
      const first = await a.repo.enableSyncCapture();
      slotMs.push(performance.now() - started);
      slotStatements.push(a.statements() - before);
      let complete = first.backfillComplete;
      await sampler.window("backfill", async () => {
        while (!complete) {
          before = a.statements();
          started = performance.now();
          const step = await a.repo.continueSyncCaptureBackfill({ maxChunks: 1 });
          slotMs.push(performance.now() - started);
          slotStatements.push(a.statements() - before);
          complete = step.complete;
        }
      });
      report("backfill", {
        limits: DEFAULT_BACKFILL_LIMITS,
        totalMs: Math.round(performance.now() - backfillStart),
        slotMs: stats(slotMs),
        slotStatements: stats(slotStatements),
        totalStatements: slotStatements.reduce((sum, value) => sum + value, 0),
      });
      expect(complete).toBe(true);

      // ---- (ii) chunked first merge of a big peer bundle ------------------------------------
      for (const [collisions, hashFrom] of runs("merge")
        ? ([
            [5_000, 0],
            [20_000, 5_000],
          ] as const)
        : []) {
        const peer = await open(PEER_ID, "Peer");
        await peer.raw.execute("BEGIN");
        await insertSyntheticAccount(peer.raw);
        await insertSyntheticTransactions(peer.raw, {
          prefix: `peer${collisions}`,
          count: collisions,
          hashFrom,
        });
        await peer.raw.execute("COMMIT");
        await peer.repo.enableSyncCapture({
          limits: { rowsPerChunk: 1_000_000, statementsPerChunk: 1_000_000 },
        });
        const bundle = JSON.parse(
          JSON.stringify(await peer.repo.listSyncChanges("finance")),
        ) as SyncChangeSet;
        const ms: number[] = [];
        const statements: number[] = [];
        let mark = a.statements();
        const start = performance.now();
        const result = await sampler.window(`first merge ${collisions}`, () =>
          applyChunked(a.repo, "finance", bundle, {
            limits: DEFAULT_APPLY_LIMITS,
            republish: true,
            yieldBetweenChunks: async () => undefined,
            onProgress: (progress) => {
              ms.push(progress.ms);
              statements.push(a.statements() - mark);
              mark = a.statements();
            },
          }),
        );
        report(`first merge ${collisions} collisions`, {
          limits: DEFAULT_APPLY_LIMITS,
          bundleEntities: bundle.entities.length,
          totalMs: Math.round(performance.now() - start),
          chunks: result.chunks,
          slotMs: stats(ms),
          slotStatements: stats(statements),
          totalStatements: statements.reduce((sum, value) => sum + value, 0),
          largestGroup: result.largestGroup,
          applied: result.applied,
          aliases: (
            await a.raw.select<{ n: number }[]>("SELECT COUNT(*) AS n FROM sync_id_aliases")
          )[0]?.n,
        });
        expect(result.nextChunk).toBeNull();
      }

      // ---- (iii) memory of the big finance bundle: encode, decode + validate, apply ----------
      if (!runs("memory")) return;
      // Each stage keeps only what the next one needs, so a stage's baseline is its own input.
      let listed: SyncChangeSet | undefined = await sampler.window("listSyncChanges finance", () =>
        a.repo.listSyncChanges("finance"),
      );
      const entityCount = listed.entities.length;
      let encoded: Awaited<ReturnType<typeof encodeBundle>> | undefined = await sampler.window(
        "encode finance",
        () => encodeBundle(listed as SyncChangeSet),
      );
      listed = undefined;
      report("bundle size", {
        entities: entityCount,
        records: encoded.records,
        encodedMb: Number((encoded.bytes.length / 1048576).toFixed(1)),
        uncompressedMb: Number((encoded.uncompressedBytes / 1048576).toFixed(1)),
      });
      const decoded = await sampler.window("decode + validate finance", async () =>
        validateChangeSet(await decodeBundle((encoded as { bytes: Uint8Array }).bytes)),
      );
      encoded = undefined;
      const joiner = await open("dev:11111111-2222-4333-8444-555555555555", "Joiner");
      await joiner.repo.enableSyncCapture();
      const joinMs: number[] = [];
      const joinStatements: number[] = [];
      let joinMark = joiner.statements();
      const joinStart = performance.now();
      const joined = await sampler.window("apply finance into an empty database", () =>
        applyChunked(joiner.repo, "finance", decoded, {
          limits: DEFAULT_APPLY_LIMITS,
          republish: true,
          yieldBetweenChunks: async () => undefined,
          onProgress: (progress) => {
            joinMs.push(progress.ms);
            joinStatements.push(joiner.statements() - joinMark);
            joinMark = joiner.statements();
          },
        }),
      );
      report("joiner apply of the whole finance domain", {
        limits: DEFAULT_APPLY_LIMITS,
        totalMs: Math.round(performance.now() - joinStart),
        chunks: joined.chunks,
        slotMs: stats(joinMs),
        slotStatements: stats(joinStatements),
        totalStatements: joinStatements.reduce((sum, value) => sum + value, 0),
        applied: joined.applied,
      });
      // Re-applying the same bundle: how cheap are the pieces of an interrupted run that repeats?
      const repeatMs: number[] = [];
      const repeat = await applyChunked(joiner.repo, "finance", decoded, {
        limits: DEFAULT_APPLY_LIMITS,
        yieldBetweenChunks: async () => undefined,
        onProgress: (progress) => repeatMs.push(progress.ms),
      });
      report("re-apply of an applied bundle", {
        chunks: repeat.chunks,
        slotMs: stats(repeatMs),
        applied: repeat.applied,
      });
      expect(repeat.applied).toBe(0);
    } finally {
      sampler.stop();
    }
  }, 3_600_000);
});
