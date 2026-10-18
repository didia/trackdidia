import { describe, expect, it } from "vitest";
import {
  compareHlc,
  encodeHlc,
  HLC_MAX_COUNTER,
  HLC_MAX_PHYSICAL_MS,
  type HlcState,
  hlcSkewMs,
  INITIAL_HLC_STATE,
  isHlcAheadOfLocalTime,
  maxHlc,
  maxHlcOf,
  parseHlc,
  receiveHlc,
  tickHlc,
} from "./hlc";

const A = "dev:aaaaaaaa-0000-4000-8000-000000000001";
const B = "dev:bbbbbbbb-0000-4000-8000-000000000002";
const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);

const mulberry32 = (seed: number) => {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

describe("encodeHlc / parseHlc", () => {
  it("uses the documented fixed-width layout", () => {
    expect(encodeHlc(NOW, 255, A)).toBe(`${NOW.toString().padStart(15, "0")}-0000ff-${A}`);
    expect(encodeHlc(0, 0, "d")).toBe("000000000000000-000000-d");
  });

  it("round-trips, including device ids containing dashes and colons", () => {
    const encoded = encodeHlc(NOW, 1234, A);
    expect(parseHlc(encoded)).toEqual({ physicalMs: NOW, counter: 1234, deviceId: A });
    const extreme = encodeHlc(HLC_MAX_PHYSICAL_MS, HLC_MAX_COUNTER, "x-y-z");
    expect(parseHlc(extreme)).toEqual({
      physicalMs: HLC_MAX_PHYSICAL_MS,
      counter: HLC_MAX_COUNTER,
      deviceId: "x-y-z",
    });
  });

  it("rejects out-of-range parts and empty device ids when encoding", () => {
    expect(() => encodeHlc(-1, 0, A)).toThrow(RangeError);
    expect(() => encodeHlc(1.5, 0, A)).toThrow(RangeError);
    expect(() => encodeHlc(HLC_MAX_PHYSICAL_MS + 1, 0, A)).toThrow(RangeError);
    expect(() => encodeHlc(0, -1, A)).toThrow(RangeError);
    expect(() => encodeHlc(0, HLC_MAX_COUNTER + 1, A)).toThrow(RangeError);
    expect(() => encodeHlc(0, 0, "")).toThrow(RangeError);
    expect(() => encodeHlc(Number.NaN, 0, A)).toThrow(RangeError);
  });

  it("returns null (never throws) for malformed input", () => {
    const valid = encodeHlc(NOW, 1, A);
    const malformed: unknown[] = [
      "",
      "garbage",
      null,
      undefined,
      42,
      {},
      valid.slice(0, 22), // no device id
      `${valid.slice(0, 22)}-`, // empty device id
      valid.replace("-000001-", "-00001-"), // short counter
      valid.replace("-000001-", "-00000G-"), // non-hex counter
      valid.replace("-000001-", "-00000A-"), // uppercase hex is not canonical
      `0${valid}`, // wide physical
      valid.slice(1), // narrow physical
      valid.replace(/^\d/, "x"),
      valid.replace(/^(\d{15})-/, "$1_"),
    ];
    for (const value of malformed) {
      expect(parseHlc(value)).toBeNull();
    }
  });
});

describe("compareHlc / maxHlc", () => {
  it("string order equals logical order (physical, then counter, then device)", () => {
    const rand = mulberry32(7);
    const parts = Array.from({ length: 300 }, () => ({
      physicalMs: Math.floor(rand() * 4) * 1_000_000_000_000 + Math.floor(rand() * 3),
      counter: Math.floor(rand() * 3) * 0x10000 + Math.floor(rand() * 3),
      deviceId: ["dev:a", "dev:b", "dev:ab", "dev:b-1"][Math.floor(rand() * 4)] as string,
    }));
    const logical = (x: (typeof parts)[number], y: (typeof parts)[number]) =>
      x.physicalMs - y.physicalMs ||
      x.counter - y.counter ||
      (x.deviceId < y.deviceId ? -1 : x.deviceId > y.deviceId ? 1 : 0);
    for (const x of parts.slice(0, 60)) {
      for (const y of parts.slice(60, 120)) {
        const expected = Math.sign(logical(x, y));
        const actual = compareHlc(
          encodeHlc(x.physicalMs, x.counter, x.deviceId),
          encodeHlc(y.physicalMs, y.counter, y.deviceId),
        );
        expect(actual).toBe(expected);
      }
    }
  });

  it("orders digit-boundary values correctly where unpadded strings would not", () => {
    expect(compareHlc(encodeHlc(9, 0, A), encodeHlc(10, 0, A))).toBe(-1);
    expect(compareHlc(encodeHlc(5, 9, A), encodeHlc(5, 10, A))).toBe(-1);
    expect(compareHlc(encodeHlc(5, 0xff, A), encodeHlc(5, 0x100, A))).toBe(-1);
  });

  it("breaks ties between devices deterministically", () => {
    const fromA = encodeHlc(NOW, 3, A);
    const fromB = encodeHlc(NOW, 3, B);
    expect(compareHlc(fromA, fromB)).toBe(-1);
    expect(compareHlc(fromB, fromA)).toBe(1);
    expect(compareHlc(fromA, fromA)).toBe(0);
    expect(maxHlc(fromA, fromB)).toBe(fromB);
    expect(maxHlc(fromB, fromA)).toBe(fromB);
  });

  it("maxHlc treats null/undefined as no clock", () => {
    const clock = encodeHlc(NOW, 0, A);
    expect(maxHlc(null, undefined)).toBeNull();
    expect(maxHlc(clock, null)).toBe(clock);
    expect(maxHlc(undefined, clock)).toBe(clock);
    expect(maxHlcOf([])).toBeNull();
    expect(maxHlcOf([null, clock, encodeHlc(NOW - 1, 0, B), undefined])).toBe(clock);
  });
});

describe("tickHlc", () => {
  it("starts from the wall clock with counter 0", () => {
    const step = tickHlc(INITIAL_HLC_STATE, NOW, A);
    expect(step.state).toEqual({ physicalMs: NOW, counter: 0 });
    expect(step.hlc).toBe(encodeHlc(NOW, 0, A));
  });

  it("increments the counter for ticks within the same millisecond", () => {
    let state: HlcState = INITIAL_HLC_STATE;
    const issued: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const step = tickHlc(state, NOW, A);
      state = step.state;
      issued.push(step.hlc);
    }
    expect(state).toEqual({ physicalMs: NOW, counter: 4 });
    expect([...issued].sort()).toEqual(issued);
    expect(new Set(issued).size).toBe(5);
  });

  it("stays strictly monotonic when the wall clock goes backwards", () => {
    let state: HlcState = INITIAL_HLC_STATE;
    const times = [NOW, NOW + 10, NOW - 60_000, NOW - 60_000, NOW + 5, NOW + 11, NOW - 1];
    let previous = "";
    for (const time of times) {
      const step = tickHlc(state, time, A);
      expect(step.hlc > previous).toBe(true);
      previous = step.hlc;
      state = step.state;
    }
    // The clock never fell back below the highest physical component it had reached.
    expect(state.physicalMs).toBe(NOW + 11);
  });

  it("does not mutate its input state", () => {
    const state: HlcState = { physicalMs: NOW, counter: 2 };
    tickHlc(state, NOW, A);
    expect(state).toEqual({ physicalMs: NOW, counter: 2 });
  });

  it("moves to the next millisecond on counter overflow instead of wrapping", () => {
    const full: HlcState = { physicalMs: NOW, counter: HLC_MAX_COUNTER };
    const step = tickHlc(full, NOW, A);
    expect(step.state).toEqual({ physicalMs: NOW + 1, counter: 0 });
    expect(step.hlc > encodeHlc(NOW, HLC_MAX_COUNTER, A)).toBe(true);
    // Subsequent ticks in the same real millisecond keep increasing.
    const next = tickHlc(step.state, NOW, A);
    expect(next.hlc > step.hlc).toBe(true);
  });

  it("throws when the physical component would overflow", () => {
    const maxed: HlcState = { physicalMs: HLC_MAX_PHYSICAL_MS, counter: HLC_MAX_COUNTER };
    expect(() => tickHlc(maxed, 0, A)).toThrow(RangeError);
  });

  it("rejects invalid state and time", () => {
    expect(() => tickHlc({ physicalMs: -1, counter: 0 }, NOW, A)).toThrow(RangeError);
    expect(() => tickHlc({ physicalMs: 0, counter: HLC_MAX_COUNTER + 1 }, NOW, A)).toThrow(
      RangeError,
    );
    expect(() => tickHlc(INITIAL_HLC_STATE, Number.NaN, A)).toThrow(RangeError);
    expect(() => tickHlc(INITIAL_HLC_STATE, Number.POSITIVE_INFINITY, A)).toThrow(RangeError);
  });

  it("keeps every issued clock unique across devices that tick in the same millisecond", () => {
    const stepA = tickHlc(INITIAL_HLC_STATE, NOW, A);
    const stepB = tickHlc(INITIAL_HLC_STATE, NOW, B);
    expect(stepA.hlc).not.toBe(stepB.hlc);
    expect(compareHlc(stepA.hlc, stepB.hlc)).toBe(-1);
  });
});

describe("receiveHlc", () => {
  it("advances local state so the next local tick is causally after the remote clock", () => {
    const remote = encodeHlc(NOW + 1_000, 9, B);
    const received = receiveHlc({ physicalMs: NOW, counter: 0 }, remote, NOW, A);
    expect(received.hlc > remote).toBe(true);
    expect(received.state).toEqual({ physicalMs: NOW + 1_000, counter: 10 });
    const tick = tickHlc(received.state, NOW, A);
    expect(tick.hlc > remote).toBe(true);
    expect(tick.hlc > received.hlc).toBe(true);
  });

  it("is causally after the remote clock even when device ids would sort it lower", () => {
    // Same (physical, counter) pair; A < B, so a naive tie-break would let B win forever.
    const remote = encodeHlc(NOW, 5, B);
    const received = receiveHlc({ physicalMs: NOW, counter: 5 }, remote, NOW, A);
    expect(received.hlc > remote).toBe(true);
  });

  it("follows the standard HLC counter rules", () => {
    const local = (physicalMs: number, counter: number): HlcState => ({ physicalMs, counter });
    // Both equal and ahead of now: max counter + 1.
    expect(receiveHlc(local(NOW + 5, 3), encodeHlc(NOW + 5, 8, B), NOW, A).state).toEqual(
      local(NOW + 5, 9),
    );
    expect(receiveHlc(local(NOW + 5, 8), encodeHlc(NOW + 5, 3, B), NOW, A).state).toEqual(
      local(NOW + 5, 9),
    );
    // Only local ahead.
    expect(receiveHlc(local(NOW + 5, 3), encodeHlc(NOW + 1, 8, B), NOW, A).state).toEqual(
      local(NOW + 5, 4),
    );
    // Only remote ahead.
    expect(receiveHlc(local(NOW + 1, 3), encodeHlc(NOW + 5, 8, B), NOW, A).state).toEqual(
      local(NOW + 5, 9),
    );
    // Wall clock ahead of both.
    expect(receiveHlc(local(NOW - 9, 3), encodeHlc(NOW - 5, 8, B), NOW, A).state).toEqual(
      local(NOW, 0),
    );
  });

  it("does not let a device with a fast clock win ties forever", () => {
    // B's wall clock is one hour fast. A (correct clock) receives from B, then edits.
    const fast = NOW + 3_600_000;
    const fromB = tickHlc(INITIAL_HLC_STATE, fast, B);
    const afterReceive = receiveHlc(INITIAL_HLC_STATE, fromB.hlc, NOW, A);
    const editOnA = tickHlc(afterReceive.state, NOW + 1, A);
    expect(editOnA.hlc > fromB.hlc).toBe(true);
    // And B, after receiving A's later edit, also issues clocks past it.
    const afterB = receiveHlc(fromB.state, editOnA.hlc, fast, B);
    expect(afterB.hlc > editOnA.hlc).toBe(true);
    // A's edits keep beating B's older write even though A's wall clock is an hour behind.
    for (let i = 0; i < 20; i += 1) {
      expect(tickHlc(editOnA.state, NOW + 2 + i, A).hlc > fromB.hlc).toBe(true);
    }
  });

  it("handles a remote clock at counter overflow without wrapping", () => {
    const remote = encodeHlc(NOW, HLC_MAX_COUNTER, B);
    const received = receiveHlc({ physicalMs: NOW, counter: 0 }, remote, NOW, A);
    expect(received.state).toEqual({ physicalMs: NOW + 1, counter: 0 });
    expect(received.hlc > remote).toBe(true);
  });

  it("is monotonic over a randomized interleaving of ticks and receives on two devices", () => {
    const rand = mulberry32(2026);
    let stateA: HlcState = INITIAL_HLC_STATE;
    let stateB: HlcState = INITIAL_HLC_STATE;
    let lastA = "";
    let lastB = "";
    let skewB = 90_000;
    for (let i = 0; i < 500; i += 1) {
      const nowA = NOW + Math.floor(rand() * 2_000) - 500; // may go backwards
      const nowB = NOW + skewB + Math.floor(rand() * 2_000) - 500;
      const roll = rand();
      if (roll < 0.35) {
        const step = tickHlc(stateA, nowA, A);
        expect(step.hlc > lastA).toBe(true);
        stateA = step.state;
        lastA = step.hlc;
      } else if (roll < 0.7) {
        const step = tickHlc(stateB, nowB, B);
        expect(step.hlc > lastB).toBe(true);
        stateB = step.state;
        lastB = step.hlc;
      } else if (roll < 0.85 && lastB) {
        const step = receiveHlc(stateA, lastB, nowA, A);
        expect(step.hlc > lastB).toBe(true);
        expect(step.hlc > lastA).toBe(true);
        stateA = step.state;
        lastA = step.hlc;
      } else if (lastA) {
        const step = receiveHlc(stateB, lastA, nowB, B);
        expect(step.hlc > lastA).toBe(true);
        expect(step.hlc > lastB).toBe(true);
        stateB = step.state;
        lastB = step.hlc;
      }
      skewB += Math.floor(rand() * 21) - 10;
    }
  });

  it("throws on a malformed remote clock", () => {
    expect(() => receiveHlc(INITIAL_HLC_STATE, "nope", NOW, A)).toThrow("hlc_malformed");
    expect(() => receiveHlc(INITIAL_HLC_STATE, "", NOW, A)).toThrow("hlc_malformed");
  });

  it("does not mutate its input state", () => {
    const state: HlcState = { physicalMs: NOW, counter: 2 };
    receiveHlc(state, encodeHlc(NOW + 5, 1, B), NOW, A);
    expect(state).toEqual({ physicalMs: NOW, counter: 2 });
  });
});

describe("clock skew helpers", () => {
  it("reports skew relative to local time", () => {
    expect(hlcSkewMs(encodeHlc(NOW + 90_000, 0, B), NOW)).toBe(90_000);
    expect(hlcSkewMs(encodeHlc(NOW - 90_000, 0, B), NOW)).toBe(-90_000);
    expect(hlcSkewMs("bad", NOW)).toBeNull();
  });

  it("warns only when a peer is more than five minutes ahead", () => {
    const fiveMinutes = 5 * 60_000;
    expect(isHlcAheadOfLocalTime(encodeHlc(NOW + fiveMinutes, 0, B), NOW)).toBe(false);
    expect(isHlcAheadOfLocalTime(encodeHlc(NOW + fiveMinutes + 1, 0, B), NOW)).toBe(true);
    expect(isHlcAheadOfLocalTime(encodeHlc(NOW - fiveMinutes * 4, 0, B), NOW)).toBe(false);
    expect(isHlcAheadOfLocalTime(encodeHlc(NOW + 10_000, 0, B), NOW, 5_000)).toBe(true);
    expect(isHlcAheadOfLocalTime("bad", NOW)).toBe(false);
  });
});
