import type { Database } from "../storage/sqlite-db";
import {
  HLC_MAX_COUNTER,
  HLC_MAX_PHYSICAL_MS,
  parseHlc,
  receiveHlc,
  tickHlc,
  type HlcState,
} from "./hlc";

/**
 * HLC issuance against the persisted state in `sync_identity` (one row, `id = 1`).
 *
 * The pure clock math lives in `hlc.ts`; this module only reads the row, applies it and writes the
 * new state back. Both functions take a `Database` and perform a read followed by a write, so
 * callers must run them inside an open write transaction (`TauriSqliteRepository.writeTransaction`
 * and the `...Internal(db, ...)` pattern) to keep issuance atomic with the change being stamped.
 * As a second line of defence the write is guarded on the state that was read, so a read-modify-write
 * that raced with another writer fails loudly instead of issuing the same clock twice.
 *
 * Nothing here is wired into startup or any write path yet; later slices (change capture, merge)
 * call it.
 */

/**
 * A remote clock whose physical component is more than this far ahead of local time is refused.
 * Without a cap, one corrupt or hostile bundle could drag the local clock decades ahead, and every
 * later local edit would sort as "newer than now" forever. 24 h is far above realistic laptop skew
 * (`HLC_SKEW_WARNING_MS` warns at 5 min) yet bounded.
 */
export const HLC_REMOTE_MAX_AHEAD_MS = 24 * 60 * 60_000;

export type SyncClockErrorCode =
  | "identity_missing"
  | "identity_corrupt"
  | "remote_malformed"
  | "remote_too_far_ahead"
  | "state_conflict";

/** Typed failure of clock issuance. Match on `code`, not on the message. */
export class SyncClockError extends Error {
  readonly code: SyncClockErrorCode;

  constructor(code: SyncClockErrorCode, message: string) {
    super(message);
    this.name = "SyncClockError";
    this.code = code;
  }
}

interface IdentityClockRow {
  device_id: string;
  physical_ms: number;
  counter: number;
}

interface LoadedClock {
  deviceId: string;
  state: HlcState;
}

const isStateNumber = (value: unknown, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max;

const loadClock = async (db: Database): Promise<LoadedClock> => {
  const rows = await db.select<IdentityClockRow[]>(
    "SELECT device_id, physical_ms, counter FROM sync_identity WHERE id = 1",
  );
  const row = rows[0];
  if (!row) {
    throw new SyncClockError(
      "identity_missing",
      "Multi-device sync identity has not been created on this device",
    );
  }
  if (
    typeof row.device_id !== "string" ||
    row.device_id.length === 0 ||
    !isStateNumber(row.physical_ms, HLC_MAX_PHYSICAL_MS) ||
    !isStateNumber(row.counter, HLC_MAX_COUNTER)
  ) {
    throw new SyncClockError("identity_corrupt", "The persisted sync clock state is invalid");
  }
  return { deviceId: row.device_id, state: { physicalMs: row.physical_ms, counter: row.counter } };
};

const saveClock = async (db: Database, previous: HlcState, next: HlcState): Promise<void> => {
  const result = await db.execute(
    "UPDATE sync_identity SET physical_ms = $1, counter = $2 WHERE id = 1 AND physical_ms = $3 AND counter = $4",
    [next.physicalMs, next.counter, previous.physicalMs, previous.counter],
  );
  if (result.rowsAffected !== 1) {
    throw new SyncClockError(
      "state_conflict",
      "The sync clock changed while it was being advanced; run clock updates inside one write transaction",
    );
  }
};

/**
 * Issues the next local clock: strictly greater than every clock this device issued or received,
 * even if the system clock stood still or went backwards. Persists the new state.
 */
export const issueHlc = async (db: Database, nowMs: number): Promise<string> => {
  const { deviceId, state } = await loadClock(db);
  const step = tickHlc(state, nowMs, deviceId);
  await saveClock(db, state, step.state);
  return step.hlc;
};

/**
 * Folds a clock received from a peer into the persisted state and returns the new local clock
 * (causally after `remote`). A malformed clock, or one more than `HLC_REMOTE_MAX_AHEAD_MS` ahead
 * of `nowMs`, is rejected with a `SyncClockError` before touching the state, so a corrupt bundle
 * can neither wedge the clock nor reach `receiveHlc` and crash it with a `RangeError`.
 */
export const receiveRemoteHlc = async (
  db: Database,
  remote: string,
  nowMs: number,
): Promise<string> => {
  const parsed = parseHlc(remote);
  if (!parsed) {
    throw new SyncClockError("remote_malformed", "The remote clock is not a valid HLC");
  }
  if (!Number.isFinite(nowMs)) {
    throw new RangeError(`hlc_now_invalid: ${nowMs}`);
  }
  if (parsed.physicalMs - nowMs > HLC_REMOTE_MAX_AHEAD_MS) {
    throw new SyncClockError(
      "remote_too_far_ahead",
      `The remote clock is more than ${HLC_REMOTE_MAX_AHEAD_MS / 3_600_000} hours ahead of local time`,
    );
  }
  const { deviceId, state } = await loadClock(db);
  const step = receiveHlc(state, remote, nowMs, deviceId);
  await saveClock(db, state, step.state);
  return step.hlc;
};
