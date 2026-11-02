import type { Database } from "../storage/sqlite-db";
import {
  type BackfillStateRow,
  countBackfillRows,
  encodeBackfillCursorKey,
  isBackfillComplete,
  progressOf,
  readBackfillRow,
  remainingOf,
  type SyncBackfillLimits,
  type SyncBackfillProgress,
  saveBackfillProgress,
  startBackfillPass,
} from "./backfill-state";
import { decodeCursor, runBackfillSlice } from "./capture-backfill";
import { SyncApplyError } from "./errors";

/**
 * The two database operations behind the chunked backfill, each meant to run inside ONE write
 * transaction taken by the repository (so each is one writer slot): starting or resuming a pass, and
 * running one chunk of it. The orchestration (slots, loops, deadlines) lives in the repository and
 * in `backfill-driver.ts`.
 */

/**
 * Starts a verifying pass unless one is already running, in which case it is kept so an interrupted
 * backfill resumes where it stopped. Counts the rows once, for the progress display.
 */
export const startOrResumeBackfill = async (
  db: Database,
  nowIso: string,
): Promise<BackfillStateRow> => {
  const existing = await readBackfillRow(db);
  if (existing !== null && existing.status === "running") return existing;
  await startBackfillPass(db, nowIso, await countBackfillRows(db));
  return (await readBackfillRow(db)) as BackfillStateRow;
};

export interface BackfillChunkResult {
  /** A slice of a running pass was run (false when no pass was running). */
  ran: boolean;
  /** The pass is finished (or none was running). */
  complete: boolean;
  scanned: number;
  stamped: number;
  /** Statements this chunk issued, stamping and the progress write included. */
  statements: number;
  remaining: number;
  cursor: string | null;
  progress: SyncBackfillProgress | null;
}

/** One bounded slice of the running pass, with its cursor and counters saved in the same transaction. */
export const runBackfillChunk = async (
  db: Database,
  nowMs: number,
  limits: SyncBackfillLimits,
): Promise<BackfillChunkResult> => {
  const row = await readBackfillRow(db);
  if (row === null || isBackfillComplete(row)) {
    return {
      ran: false,
      complete: true,
      scanned: 0,
      stamped: 0,
      statements: 1,
      remaining: 0,
      cursor: null,
      progress: progressOf(row),
    };
  }
  const slice = await runBackfillSlice(db, nowMs, decodeCursor(row.step, row.cursor_key), {
    verify: true,
    limits,
  });
  await saveBackfillProgress(db, {
    step: slice.next?.step ?? row.step,
    cursorKey: slice.next === null ? null : encodeBackfillCursorKey(slice.next.key),
    scanned: slice.scanned,
    stamped: slice.stamped,
    complete: slice.next === null,
    nowIso: new Date(nowMs).toISOString(),
  });
  const saved = await readBackfillRow(db);
  return {
    ran: true,
    complete: slice.next === null,
    scanned: slice.scanned,
    stamped: slice.stamped,
    statements: slice.statements + 2,
    remaining: remainingOf(saved),
    cursor:
      slice.next === null
        ? null
        : `${slice.next.step}\u0000${encodeBackfillCursorKey(slice.next.key)}`,
    progress: progressOf(saved),
  };
};

/**
 * Throws `backfill_incomplete` unless the database may sync: no pass running. Capture itself being
 * installed is checked by the callers (`capture_disabled`).
 */
export const assertBackfillComplete = async (db: Database): Promise<void> => {
  if (!isBackfillComplete(await readBackfillRow(db))) {
    throw new SyncApplyError(
      "backfill_incomplete",
      "Change tracking is still being initialized on this device (the first pass over the database has not finished); sync resumes when it has",
    );
  }
};
