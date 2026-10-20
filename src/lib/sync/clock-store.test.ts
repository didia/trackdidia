// @vitest-environment node
import { describe, expect, it } from "vitest";
// SAFETY: in-memory SQLite only (`createNodeSqliteDatabase` defaults to `:memory:`).
import { createNodeSqliteDatabase } from "../../test/mocks/node-sqlite-database";
import { runMigrations } from "../storage/migrations";
import type { Database } from "../storage/sqlite-db";
import {
  absorbRemoteHlc,
  assertRemoteClockAcceptable,
  createHlcBatch,
  HLC_REMOTE_MAX_AHEAD_MS,
  issueHlc,
  receiveRemoteHlc,
  SyncClockError,
} from "./clock-store";
import { compareHlc, encodeHlc, HLC_MAX_COUNTER, parseHlc } from "./hlc";

const DEVICE = "dev:0b9c7c1e-6a3f-4b8e-9d2a-1f2e3d4c5b6a";
const PEER = "dev:7f3c1a2e-9d4b-4c5e-8a1f-2b3c4d5e6f70";
const NOW = 1_800_000_000_000;

const createDb = async (withIdentity = true): Promise<Database> => {
  const db = createNodeSqliteDatabase();
  await runMigrations(db);
  if (withIdentity) {
    await db.execute("INSERT INTO sync_identity (id, device_id, device_name) VALUES (1, $1, $2)", [
      DEVICE,
      "Test laptop",
    ]);
  }
  return db;
};

const readState = async (db: Database) =>
  (
    await db.select<{ physical_ms: number; counter: number }[]>(
      "SELECT physical_ms, counter FROM sync_identity WHERE id = 1",
    )
  )[0];

const clockCode = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SyncClockError);
    return (error as SyncClockError).code;
  }
  throw new Error("expected a SyncClockError");
};

describe("issueHlc", () => {
  it("issues a clock for this device and persists the state", async () => {
    const db = await createDb();
    const hlc = await issueHlc(db, NOW);
    expect(parseHlc(hlc)).toEqual({ physicalMs: NOW, counter: 0, deviceId: DEVICE });
    expect(await readState(db)).toEqual({ physical_ms: NOW, counter: 0 });
  });

  it("is strictly monotonic across many calls, with a frozen clock and in sorted string order", async () => {
    const db = await createDb();
    const issued: string[] = [];
    for (let i = 0; i < 500; i += 1) issued.push(await issueHlc(db, NOW));
    for (let i = 1; i < issued.length; i += 1) {
      expect(compareHlc(issued[i - 1] as string, issued[i] as string)).toBe(-1);
    }
    expect(new Set(issued).size).toBe(issued.length);
    expect(await readState(db)).toEqual({ physical_ms: NOW, counter: 499 });
    // String sort equals issue order.
    expect([...issued].sort()).toEqual(issued);
  });

  it("stays monotonic when the system clock goes backwards", async () => {
    const db = await createDb();
    const first = await issueHlc(db, NOW);
    const second = await issueHlc(db, NOW - 60 * 60_000);
    const third = await issueHlc(db, NOW - 1);
    expect(compareHlc(first, second)).toBe(-1);
    expect(compareHlc(second, third)).toBe(-1);
    expect(parseHlc(third)).toMatchObject({ physicalMs: NOW, counter: 2 });
    const fourth = await issueHlc(db, NOW + 5);
    expect(parseHlc(fourth)).toMatchObject({ physicalMs: NOW + 5, counter: 0 });
  });

  it("resumes from the persisted row after a restart (state re-read from the table)", async () => {
    const db = await createDb();
    const before = await issueHlc(db, NOW);
    await issueHlc(db, NOW);
    // "Restart": no in-memory state exists anywhere; the next call only has the table.
    const after = await issueHlc(db, NOW - 1_000);
    expect(compareHlc(before, after)).toBe(-1);
    expect(parseHlc(after)).toMatchObject({ physicalMs: NOW, counter: 2 });
  });

  it("rolls the counter into the next millisecond on exhaustion instead of wrapping", async () => {
    const db = await createDb();
    await db.execute("UPDATE sync_identity SET physical_ms = $1, counter = $2 WHERE id = 1", [
      NOW,
      HLC_MAX_COUNTER,
    ]);
    const hlc = await issueHlc(db, NOW);
    expect(parseHlc(hlc)).toMatchObject({ physicalMs: NOW + 1, counter: 0 });
    expect(compareHlc(encodeHlc(NOW, HLC_MAX_COUNTER, DEVICE), hlc)).toBe(-1);
  });

  it("does not change the state or any other column except physical_ms and counter", async () => {
    const db = await createDb();
    await issueHlc(db, NOW);
    expect(
      await db.select(
        "SELECT device_id, device_name, change_counter, last_publish_counter, applying FROM sync_identity",
      ),
    ).toEqual([
      {
        device_id: DEVICE,
        device_name: "Test laptop",
        change_counter: 0,
        last_publish_counter: 0,
        applying: 0,
      },
    ]);
  });

  it("throws a typed error when no identity row exists, and writes nothing", async () => {
    const db = await createDb(false);
    expect(await clockCode(issueHlc(db, NOW))).toBe("identity_missing");
    expect(await db.select("SELECT * FROM sync_identity")).toEqual([]);
  });

  it("throws a typed error for a corrupt persisted state", async () => {
    const db = await createDb();
    await db.execute("UPDATE sync_identity SET physical_ms = -5 WHERE id = 1");
    expect(await clockCode(issueHlc(db, NOW))).toBe("identity_corrupt");
    await db.execute("UPDATE sync_identity SET physical_ms = 0, counter = 99999999 WHERE id = 1");
    expect(await clockCode(issueHlc(db, NOW))).toBe("identity_corrupt");
    await db.execute("UPDATE sync_identity SET counter = 0, device_id = '' WHERE id = 1");
    expect(await clockCode(issueHlc(db, NOW))).toBe("identity_corrupt");
  });

  it("fails loudly instead of double-issuing when the state moved between read and write", async () => {
    const db = await createDb();
    const select = db.select.bind(db);
    let tampered = false;
    const racing: Database = {
      execute: db.execute.bind(db),
      select: async <T>(query: string, values?: unknown[]) => {
        const rows = await select<T>(query, values);
        if (!tampered && query.startsWith("SELECT device_id, physical_ms")) {
          tampered = true;
          await db.execute("UPDATE sync_identity SET counter = counter + 1 WHERE id = 1");
        }
        return rows;
      },
    };
    expect(await clockCode(issueHlc(racing, NOW))).toBe("state_conflict");
  });

  it("is atomic with an enclosing transaction (rollback discards the advance)", async () => {
    const db = await createDb();
    await issueHlc(db, NOW);
    await db.execute("BEGIN IMMEDIATE");
    await issueHlc(db, NOW);
    await issueHlc(db, NOW);
    await db.execute("ROLLBACK");
    expect(await readState(db)).toEqual({ physical_ms: NOW, counter: 0 });
  });
});

describe("receiveRemoteHlc", () => {
  it("returns a clock causally after the remote one and persists the state", async () => {
    const db = await createDb();
    await issueHlc(db, NOW);
    const remote = encodeHlc(NOW + 10_000, 7, PEER);
    const next = await receiveRemoteHlc(db, remote, NOW + 1);
    expect(compareHlc(remote, next)).toBe(-1);
    expect(parseHlc(next)).toEqual({ physicalMs: NOW + 10_000, counter: 8, deviceId: DEVICE });
    expect(await readState(db)).toEqual({ physical_ms: NOW + 10_000, counter: 8 });
    // Later local ticks stay past the remote clock even when wall time is behind it.
    const later = await issueHlc(db, NOW + 2);
    expect(compareHlc(next, later)).toBe(-1);
  });

  it("keeps the local state when the remote clock is behind", async () => {
    const db = await createDb();
    await issueHlc(db, NOW);
    const next = await receiveRemoteHlc(db, encodeHlc(NOW - 5_000, 3, PEER), NOW);
    expect(parseHlc(next)).toMatchObject({ physicalMs: NOW, counter: 1 });
  });

  it("accepts a remote clock exactly at the 24 h cap and rejects one ms beyond it", async () => {
    const db = await createDb();
    const edge = encodeHlc(NOW + HLC_REMOTE_MAX_AHEAD_MS, 0, PEER);
    await expect(receiveRemoteHlc(db, edge, NOW)).resolves.toMatch(/^\d{15}-/);
    const db2 = await createDb();
    const beyond = encodeHlc(NOW + HLC_REMOTE_MAX_AHEAD_MS + 1, 0, PEER);
    expect(await clockCode(receiveRemoteHlc(db2, beyond, NOW))).toBe("remote_too_far_ahead");
  });

  it("rejects a far-future clock without touching the persisted state", async () => {
    const db = await createDb();
    await issueHlc(db, NOW);
    const before = await readState(db);
    for (const remote of [
      encodeHlc(NOW + 365 * 24 * 60 * 60_000, 0, PEER),
      encodeHlc(999_999_999_999_999, HLC_MAX_COUNTER, PEER),
    ]) {
      expect(await clockCode(receiveRemoteHlc(db, remote, NOW))).toBe("remote_too_far_ahead");
    }
    expect(await readState(db)).toEqual(before);
    // The clock is not wedged: local issuance continues from wall time.
    expect(parseHlc(await issueHlc(db, NOW + 1))).toMatchObject({ physicalMs: NOW + 1 });
  });

  it("rejects malformed remote clocks with a typed error, never a RangeError", async () => {
    const db = await createDb();
    const before = await readState(db);
    const malformed: unknown[] = [
      "",
      "garbage",
      "2026-10-18T00:00:00.000Z",
      "000000000000001-000000",
      "000000000000001-00000G-dev:x",
      "000000000000001-0000AA-dev:x",
      "00000000000001-000000-dev:x",
      "1000000000000000-000000-dev:x",
      null,
      undefined,
      42,
      {},
    ];
    for (const remote of malformed) {
      expect(await clockCode(receiveRemoteHlc(db, remote as string, NOW))).toBe("remote_malformed");
    }
    expect(await readState(db)).toEqual(before);
  });

  it("throws a typed error when no identity row exists", async () => {
    const db = await createDb(false);
    expect(await clockCode(receiveRemoteHlc(db, encodeHlc(NOW, 0, PEER), NOW))).toBe(
      "identity_missing",
    );
  });

  it("is monotonic across interleaved issue and receive calls", async () => {
    const db = await createDb();
    let previous = await issueHlc(db, NOW);
    for (let i = 0; i < 100; i += 1) {
      const next =
        i % 3 === 0
          ? await receiveRemoteHlc(db, encodeHlc(NOW + i * 1_000, i % 5, PEER), NOW)
          : await issueHlc(db, NOW - i);
      expect(compareHlc(previous, next)).toBe(-1);
      previous = next;
    }
  });
});

describe("createHlcBatch", () => {
  it("issues strictly increasing clocks from one read and one write", async () => {
    const db = await createDb();
    const selects: string[] = [];
    const executes: string[] = [];
    const select = db.select.bind(db);
    const execute = db.execute.bind(db);
    db.select = ((query: string, values?: unknown[]) => {
      selects.push(query);
      return select(query, values);
    }) as typeof db.select;
    db.execute = ((query: string, values?: unknown[]) => {
      executes.push(query);
      return execute(query, values);
    }) as typeof db.execute;

    const batch = createHlcBatch(db, NOW);
    const issued: string[] = [];
    for (let i = 0; i < 50; i += 1) issued.push(await batch.next());
    expect(executes.filter((query) => query.startsWith("UPDATE sync_identity"))).toHaveLength(0);
    expect(await batch.flush()).toBe(50);
    const identityReads = selects.filter((query) => query.includes("sync_identity")).length;

    for (let i = 1; i < issued.length; i += 1) {
      expect(compareHlc(issued[i - 1] as string, issued[i] as string)).toBe(-1);
    }
    expect(parseHlc(issued[0] as string)).toEqual({
      physicalMs: NOW,
      counter: 0,
      deviceId: DEVICE,
    });
    expect(await readState(db)).toEqual({ physical_ms: NOW, counter: 49 });
    expect(identityReads).toBe(1);
    expect(executes.filter((query) => query.startsWith("UPDATE sync_identity"))).toHaveLength(1);
  });

  it("continues past clocks issued before it, and later single issues continue past the batch", async () => {
    const db = await createDb();
    const first = await issueHlc(db, NOW);
    const batch = createHlcBatch(db, NOW);
    const second = await batch.next();
    await batch.flush();
    const third = await issueHlc(db, NOW);
    expect(compareHlc(first, second)).toBe(-1);
    expect(compareHlc(second, third)).toBe(-1);
  });

  it("touches nothing when no clock was issued", async () => {
    const db = await createDb();
    const batch = createHlcBatch(db, NOW);
    expect(await batch.flush()).toBe(0);
    expect(await readState(db)).toEqual({ physical_ms: 0, counter: 0 });
    // Not even a read happens before the first next(), so a missing identity is not an error here.
    const noIdentity = await createDb(false);
    expect(await createHlcBatch(noIdentity, NOW).flush()).toBe(0);
  });

  it("throws the typed identity error on first use", async () => {
    const db = await createDb(false);
    expect(await clockCode(createHlcBatch(db, NOW).next())).toBe("identity_missing");
  });

  it("can flush in several rounds", async () => {
    const db = await createDb();
    const batch = createHlcBatch(db, NOW);
    await batch.next();
    expect(await batch.flush()).toBe(1);
    await batch.next();
    await batch.next();
    expect(await batch.flush()).toBe(2);
    expect(await readState(db)).toEqual({ physical_ms: NOW, counter: 2 });
  });
});

describe("assertRemoteClockAcceptable", () => {
  it("accepts a clock within the window, ahead or behind", () => {
    expect(() => assertRemoteClockAcceptable(encodeHlc(NOW, 0, PEER), NOW)).not.toThrow();
    expect(() =>
      assertRemoteClockAcceptable(encodeHlc(NOW + HLC_REMOTE_MAX_AHEAD_MS, 0, PEER), NOW),
    ).not.toThrow();
    expect(() => assertRemoteClockAcceptable(encodeHlc(1, 0, PEER), NOW)).not.toThrow();
  });

  it("rejects a malformed clock and one too far ahead, with typed codes", () => {
    expect(() => assertRemoteClockAcceptable("zzz", NOW)).toThrow(
      expect.objectContaining({ code: "remote_malformed" }),
    );
    expect(() =>
      assertRemoteClockAcceptable(encodeHlc(NOW + HLC_REMOTE_MAX_AHEAD_MS + 1, 0, PEER), NOW),
    ).toThrow(expect.objectContaining({ code: "remote_too_far_ahead" }));
  });
});

describe("absorbRemoteHlc", () => {
  it("folds a clock ahead of the local state in, and reports it", async () => {
    const db = await createDb();
    await issueHlc(db, NOW);
    const remote = encodeHlc(NOW + 5_000, 3, PEER);
    await expect(absorbRemoteHlc(db, remote, NOW)).resolves.toBe(true);
    const next = await issueHlc(db, NOW);
    expect(compareHlc(next, remote)).toBe(1);
  });

  it("leaves the state alone when it is already past the remote clock", async () => {
    const db = await createDb();
    await issueHlc(db, NOW + 10_000);
    const before = await readState(db);
    await expect(absorbRemoteHlc(db, encodeHlc(NOW, 9, PEER), NOW)).resolves.toBe(false);
    await expect(absorbRemoteHlc(db, encodeHlc(NOW + 10_000, 0, PEER), NOW)).resolves.toBe(false);
    expect(await readState(db)).toEqual(before);
  });

  it("still validates a clock it would not need to absorb", async () => {
    const db = await createDb();
    await issueHlc(db, NOW);
    expect(await clockCode(absorbRemoteHlc(db, "nope", NOW))).toBe("remote_malformed");
    expect(
      await clockCode(
        absorbRemoteHlc(db, encodeHlc(NOW + HLC_REMOTE_MAX_AHEAD_MS + 1, 0, PEER), NOW),
      ),
    ).toBe("remote_too_far_ahead");
  });

  it("needs an identity row", async () => {
    const db = await createDb(false);
    expect(await clockCode(absorbRemoteHlc(db, encodeHlc(NOW, 0, PEER), NOW))).toBe(
      "identity_missing",
    );
  });
});
