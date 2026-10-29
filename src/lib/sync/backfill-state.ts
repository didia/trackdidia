import type { Database } from "../storage/sqlite-db";
import { capturedTables } from "./capture-install";

/**
 * Progress of the chunked change-capture backfill, persisted in the single-row device-local table
 * `sync_backfill_state` (migration 45). Pure types and small SQL helpers; the scan itself is in
 * `capture-backfill.ts`, the writer slots are taken by the repository.
 *
 * State model. `captureInstalled` (the `sync_capture_state` row and the triggers) and
 * `backfillComplete` are separate facts:
 * - no `sync_backfill_state` row: the backfill is complete (a database that enabled capture before
 *   the table existed ran the old single-transaction backfill, and a database that never enabled
 *   capture has nothing to backfill);
 * - `running`: a pass is in flight; `step` and `cursor_key` say where to resume;
 * - `complete`: the last pass finished. Calling `enableSyncCapture` again starts a new, verifying
 *   pass (it re-checks every row), which is how edits made while capture was off are picked up.
 *
 * While a pass is `running` the engine neither publishes nor applies (some entities still lack
 * clocks and snapshots); local edits keep being captured by the triggers as usual.
 */

export interface SyncBackfillProgress {
  /** 1 for the first pass of this database, +1 for every pass started later. */
  pass: number;
  /** Rows (and live clock rows) looked at so far in this pass. */
  scannedRows: number;
  /** Rows to look at, counted when the pass started; edits made meanwhile can exceed it. */
  totalRows: number;
  /** Entities stamped by this pass so far. */
  stamped: number;
  startedAt: string;
}

/** How big one backfill chunk (one writer slot) may be. */
export interface SyncBackfillLimits {
  /** Rows (plus live clock rows) one chunk looks at. */
  rowsPerChunk: number;
  /**
   * Statements the scan part of one chunk may issue before the chunk ends. Checked between slices of
   * a table, so a chunk can overshoot by one slice; the stamping that follows is bounded by the
   * rows marked.
   */
  statementsPerChunk: number;
}

/**
 * Defaults chosen from the measurements in `docs/storage-and-backups.md` ("Chunked backfill and
 * chunked apply: measurements"): about this many rows keep one writer slot below roughly a second
 * in process and a few seconds with the Tauri IPC cost of every statement.
 */
export const DEFAULT_BACKFILL_LIMITS: SyncBackfillLimits = {
  rowsPerChunk: 1_000,
  statementsPerChunk: 200,
};

export interface SyncBackfillOptions {
  limits?: Partial<SyncBackfillLimits>;
}

export const resolveBackfillLimits = (
  limits: Partial<SyncBackfillLimits> | undefined,
): SyncBackfillLimits => {
  const rows = limits?.rowsPerChunk ?? DEFAULT_BACKFILL_LIMITS.rowsPerChunk;
  const statements = limits?.statementsPerChunk ?? DEFAULT_BACKFILL_LIMITS.statementsPerChunk;
  if (!(rows >= 1) || !(statements >= 1)) {
    throw new Error(
      "Invalid backfill limits: rowsPerChunk and statementsPerChunk must be at least 1",
    );
  }
  return { rowsPerChunk: rows, statementsPerChunk: statements };
};

/** What `enableSyncCapture` reports: it installs, then runs at most the FIRST chunk. */
export interface SyncCaptureEnableResult {
  /** The trigger set was installed or reinstalled by this call. */
  installed: boolean;
  /** Entities stamped by this call (the first chunk). */
  backfilled: number;
  backfillComplete: boolean;
  /** Rows still to look at (an estimate); 0 once complete. */
  remaining: number;
  /** Statements the first chunk issued, to project the IPC cost of a slot. */
  maxChunkStatements: number;
}

export interface SyncBackfillOutcome {
  /** The pass is finished (also true when there was nothing to do). */
  complete: boolean;
  /** Chunks (writer slots) this call ran. */
  chunks: number;
  /** Entities stamped by this call. */
  stamped: number;
  /** Rows looked at by this call. */
  scanned: number;
  /** Statements issued by the longest chunk of this call. */
  maxChunkStatements: number;
  /** Rows still to look at (an estimate); 0 once complete. */
  remaining: number;
  /** Where the pass resumes (step and key), for stuck detection; `null` once complete. */
  cursor: string | null;
  progress: SyncBackfillProgress | null;
}

export interface SyncBackfillContinueOptions extends SyncBackfillOptions {
  /** Chunks to run at most (default 1). Each chunk is its own writer slot. */
  maxChunks?: number;
  /** Stop starting chunks after this many milliseconds (the clock is `Date.now`). */
  deadlineMs?: number;
}

export interface BackfillStateRow {
  pass: number;
  status: "running" | "complete";
  step: string;
  cursor_key: string | null;
  total_rows: number;
  scanned_rows: number;
  stamped: number;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
}

const asCount = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;

export const readBackfillRow = async (db: Database): Promise<BackfillStateRow | null> => {
  const rows = await db.select<BackfillStateRow[]>(
    `SELECT pass, status, step, cursor_key, total_rows, scanned_rows, stamped, started_at,
            updated_at, completed_at
     FROM sync_backfill_state WHERE id = 1`,
  );
  return rows[0] ?? null;
};

export const encodeBackfillCursorKey = (key: readonly (string | number)[] | null): string | null =>
  key === null ? null : JSON.stringify(key);

/** A missing row counts as complete: see the state model above. */
export const isBackfillComplete = (row: BackfillStateRow | null): boolean =>
  row === null || row.status === "complete";

export const progressOf = (row: BackfillStateRow | null): SyncBackfillProgress | null =>
  row === null
    ? null
    : {
        pass: asCount(row.pass),
        scannedRows: asCount(row.scanned_rows),
        totalRows: asCount(row.total_rows),
        stamped: asCount(row.stamped),
        startedAt: String(row.started_at),
      };

export const remainingOf = (row: BackfillStateRow | null): number =>
  row === null || row.status === "complete"
    ? 0
    : Math.max(0, asCount(row.total_rows) - asCount(row.scanned_rows));

/**
 * Starts a new pass (pass number + 1, cursor at the start). Callers keep a running pass instead of
 * restarting it, so an interrupted backfill resumes.
 */
export const startBackfillPass = async (
  db: Database,
  nowIso: string,
  totalRows: number,
): Promise<void> => {
  await db.execute(
    `INSERT INTO sync_backfill_state
       (id, pass, status, step, cursor_key, total_rows, scanned_rows, stamped, started_at, updated_at, completed_at)
     VALUES (1, 1, 'running', '', NULL, $1, 0, 0, $2, $2, NULL)
     ON CONFLICT(id) DO UPDATE SET
       pass = sync_backfill_state.pass + 1, status = 'running', step = '', cursor_key = NULL,
       total_rows = excluded.total_rows, scanned_rows = 0, stamped = 0,
       started_at = excluded.started_at, updated_at = excluded.updated_at, completed_at = NULL`,
    [totalRows, nowIso],
  );
};

export interface BackfillProgressUpdate {
  step: string;
  cursorKey: string | null;
  scanned: number;
  stamped: number;
  complete: boolean;
  nowIso: string;
}

export const saveBackfillProgress = async (
  db: Database,
  update: BackfillProgressUpdate,
): Promise<void> => {
  await db.execute(
    `UPDATE sync_backfill_state SET
       status = $1, step = $2, cursor_key = $3,
       scanned_rows = scanned_rows + $4, stamped = stamped + $5,
       updated_at = $6, completed_at = $7
     WHERE id = 1`,
    [
      update.complete ? "complete" : "running",
      update.step,
      update.cursorKey,
      update.scanned,
      update.stamped,
      update.nowIso,
      update.complete ? update.nowIso : null,
    ],
  );
};

/**
 * Rows a pass will look at: every row of the captured tables, every live clock row, the settings
 * blob. One statement for the tables, one for the clock rows.
 */
export const countBackfillRows = async (db: Database): Promise<number> => {
  const tables = capturedTables().map((entry) => entry.table);
  const parts = tables.map((table) => `SELECT COUNT(*) AS n FROM "${table}"`);
  const rows = await db.select<{ n: number }[]>(parts.join(" UNION ALL "));
  const clocks = await db.select<{ n: number }[]>(
    "SELECT COUNT(*) AS n FROM sync_entity_meta WHERE deleted_at IS NULL",
  );
  return (
    rows.reduce((sum, row) => sum + asCount(row.n), 0) + asCount(clocks[0]?.n) + 1 /* settings */
  );
};
