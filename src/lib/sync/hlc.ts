/**
 * Hybrid logical clock (HLC) for multi-laptop sync. Pure and I/O-free: every function takes the
 * current wall-clock time as an argument and returns new state instead of mutating anything, so
 * callers (and tests) fully control time.
 *
 * A clock value is `(physicalMs, counter, deviceId)` encoded as one lexicographically sortable
 * string:
 *
 *     PPPPPPPPPPPPPPP-CCCCCC-<deviceId>
 *     |<- 15 dec ->|  |6 hex|  rest of the string
 *
 * - `physicalMs`: 15 zero-padded decimal digits, max 999_999_999_999_999 ms (year ~33658) and
 *   still a safe JS integer, so it cannot overflow for any realistic date.
 * - `counter`: 6 zero-padded lowercase hex digits, max 0xffffff (16_777_215) events within one
 *   millisecond. On exhaustion the physical component is advanced by 1 ms and the counter resets
 *   to 0; the counter never wraps.
 * - `deviceId`: everything after the second `-`, so it may itself contain `-` and `:` (device ids
 *   look like `dev:<uuid>`). It must be non-empty.
 *
 * Because both numeric parts are fixed width, plain code-unit string comparison (`<`, `>`, default
 * `Array.prototype.sort`) equals logical order: physical time, then counter, then device id as a
 * deterministic tie-breaker. Never use `localeCompare` on these strings.
 */

/** Persisted HLC state of one device (later stored in `sync_identity`). */
export type HlcState = { physicalMs: number; counter: number };

/** A decoded clock value. */
export type ParsedHlc = { physicalMs: number; counter: number; deviceId: string };

export const HLC_MAX_PHYSICAL_MS = 999_999_999_999_999;
export const HLC_MAX_COUNTER = 0xffffff;
/** Default "peer clock is too far ahead" warning threshold: 5 minutes. */
export const HLC_SKEW_WARNING_MS = 5 * 60_000;

const PHYSICAL_WIDTH = 15;
const COUNTER_WIDTH = 6;
const DEVICE_OFFSET = PHYSICAL_WIDTH + 1 + COUNTER_WIDTH + 1;
const HLC_PATTERN = /^(\d{15})-([0-9a-f]{6})-([\s\S]+)$/;

/** The state of a device that has never issued or received a clock. */
export const INITIAL_HLC_STATE: HlcState = Object.freeze({ physicalMs: 0, counter: 0 });

const assertPhysical = (physicalMs: number): void => {
  if (!Number.isSafeInteger(physicalMs) || physicalMs < 0 || physicalMs > HLC_MAX_PHYSICAL_MS) {
    throw new RangeError(`hlc_physical_out_of_range: ${physicalMs}`);
  }
};

const assertCounter = (counter: number): void => {
  if (!Number.isSafeInteger(counter) || counter < 0 || counter > HLC_MAX_COUNTER) {
    throw new RangeError(`hlc_counter_out_of_range: ${counter}`);
  }
};

/** Encodes a clock. Throws `RangeError` for out-of-range parts or an empty device id. */
export const encodeHlc = (physicalMs: number, counter: number, deviceId: string): string => {
  assertPhysical(physicalMs);
  assertCounter(counter);
  if (deviceId.length === 0) {
    throw new RangeError("hlc_device_id_empty");
  }
  return `${String(physicalMs).padStart(PHYSICAL_WIDTH, "0")}-${counter
    .toString(16)
    .padStart(COUNTER_WIDTH, "0")}-${deviceId}`;
};

/**
 * Decodes a clock string. Returns `null` for anything that is not in the canonical encoding
 * (wrong widths, uppercase hex, missing device id, non-strings). It never throws, so a corrupt
 * value coming from a peer bundle can be rejected by the caller.
 */
export const parseHlc = (value: unknown): ParsedHlc | null => {
  if (typeof value !== "string") {
    return null;
  }
  const match = HLC_PATTERN.exec(value);
  if (!match) {
    return null;
  }
  const physicalMs = Number(match[1]);
  const counter = Number.parseInt(match[2] as string, 16);
  if (physicalMs > HLC_MAX_PHYSICAL_MS) {
    return null;
  }
  return { physicalMs, counter, deviceId: value.slice(DEVICE_OFFSET) };
};

/** True when `value` is a clock string in the canonical encoding (what {@link parseHlc} accepts). */
export const isValidHlc = (value: unknown): value is string => parseHlc(value) !== null;

/** Throws `Error("hlc_malformed")` unless `value` is a canonical clock string. */
export const assertHlc = (value: unknown): string => {
  if (!isValidHlc(value)) {
    throw new Error("hlc_malformed");
  }
  return value;
};

/**
 * Total order over encoded clocks. String order equals logical order (see module doc). Both
 * arguments must be canonical clocks: a malformed string (`"zzzz"`, `"9-000000-d"`, uppercase
 * hex) would otherwise sort above every real clock, so this throws `Error("hlc_malformed")`
 * instead of ordering it.
 */
export const compareHlc = (a: string, b: string): number => {
  assertHlc(a);
  assertHlc(b);
  return a < b ? -1 : a > b ? 1 : 0;
};

/**
 * Larger of two clocks; `null`/`undefined` count as "no clock" and lose to any clock. Every
 * non-null argument must be a canonical clock, otherwise this throws `Error("hlc_malformed")`
 * (even when the other argument is missing).
 */
export const maxHlc = (
  a: string | null | undefined,
  b: string | null | undefined,
): string | null => {
  if (a === null || a === undefined) {
    return b === null || b === undefined ? null : assertHlc(b);
  }
  if (b === null || b === undefined) {
    return assertHlc(a);
  }
  return compareHlc(a, b) >= 0 ? a : b;
};

/** Largest clock of a collection, or `null` when it is empty. Throws on a malformed clock. */
export const maxHlcOf = (values: Iterable<string | null | undefined>): string | null => {
  let max: string | null = null;
  for (const value of values) {
    max = maxHlc(max, value);
  }
  return max;
};

export type HlcStep = {
  /** State to persist. */
  state: HlcState;
  /** The clock issued for this event. */
  hlc: string;
};

const assertNow = (nowMs: number): number => {
  if (!Number.isFinite(nowMs)) {
    throw new RangeError(`hlc_now_invalid: ${nowMs}`);
  }
  return Math.max(0, Math.floor(nowMs));
};

const assertState = (state: HlcState): void => {
  assertPhysical(state.physicalMs);
  assertCounter(state.counter);
};

/**
 * Builds the step for `(physicalMs, counter)`, resolving counter exhaustion by moving to the next
 * millisecond with counter 0. That value is still strictly greater than `(physicalMs, MAX)`.
 */
const finishStep = (physicalMs: number, counter: number, deviceId: string): HlcStep => {
  const next =
    counter > HLC_MAX_COUNTER
      ? { physicalMs: physicalMs + 1, counter: 0 }
      : { physicalMs, counter };
  return { state: next, hlc: encodeHlc(next.physicalMs, next.counter, deviceId) };
};

/**
 * Local event. The issued clock is strictly greater (by `(physicalMs, counter)`) than every clock
 * previously issued or received through `state`, even if the wall clock stood still or went
 * backwards.
 */
export const tickHlc = (state: HlcState, nowMs: number, deviceId: string): HlcStep => {
  assertState(state);
  const now = assertNow(nowMs);
  if (now > state.physicalMs) {
    return finishStep(now, 0, deviceId);
  }
  return finishStep(state.physicalMs, state.counter + 1, deviceId);
};

/**
 * The clock immediately after `clock` in the same author's sequence (counter + 1; on exhaustion the
 * next millisecond with counter 0). Pure and issues nothing: the sync apply path uses it to date a
 * delete it has to derive (a cascade it performs itself, a child kept off a deleted parent) just
 * after the newest clock the deleted row carries, so the tombstone is later than every edit it
 * retains and a derived delete is a function of the row's own state. Throws `Error("hlc_malformed")`
 * for a non-canonical clock.
 */
export const successorHlc = (clock: string): string => {
  const parsed = parseHlc(clock);
  if (!parsed) {
    throw new Error("hlc_malformed");
  }
  return finishStep(parsed.physicalMs, parsed.counter + 1, parsed.deviceId).hlc;
};

/**
 * Merges a remote clock. The returned state is strictly past the remote `(physicalMs, counter)`
 * and past the previous local state, so the next local tick is causally after the remote event
 * whatever the device ids are. A remote clock far ahead of local time pulls this device's clock
 * forward instead of letting the remote device win ties forever: after receiving, local ticks
 * exceed it. Throws `Error("hlc_malformed")` when `remote` is not a valid clock string.
 */
export const receiveHlc = (
  state: HlcState,
  remote: string,
  nowMs: number,
  deviceId: string,
): HlcStep => {
  assertState(state);
  const parsed = parseHlc(remote);
  if (!parsed) {
    throw new Error("hlc_malformed");
  }
  const now = assertNow(nowMs);
  const physicalMs = Math.max(state.physicalMs, parsed.physicalMs, now);
  let counter: number;
  if (physicalMs === state.physicalMs && physicalMs === parsed.physicalMs) {
    counter = Math.max(state.counter, parsed.counter) + 1;
  } else if (physicalMs === state.physicalMs) {
    counter = state.counter + 1;
  } else if (physicalMs === parsed.physicalMs) {
    counter = parsed.counter + 1;
  } else {
    counter = 0;
  }
  return finishStep(physicalMs, counter, deviceId);
};

/**
 * Milliseconds by which the remote clock's physical component is ahead of `nowMs` (negative when
 * behind). `null` when the clock is malformed.
 */
export const hlcSkewMs = (remote: string, nowMs: number): number | null => {
  const parsed = parseHlc(remote);
  return parsed ? parsed.physicalMs - nowMs : null;
};

/** True when a peer's clock is more than `thresholdMs` (default 5 min) ahead of local time. */
export const isHlcAheadOfLocalTime = (
  remote: string,
  nowMs: number,
  thresholdMs: number = HLC_SKEW_WARNING_MS,
): boolean => {
  const skew = hlcSkewMs(remote, nowMs);
  return skew !== null && skew > thresholdMs;
};
