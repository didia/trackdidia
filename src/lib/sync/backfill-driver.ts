import type { AppRepository } from "../storage/repository";
import type {
  SyncBackfillLimits,
  SyncBackfillOutcome,
  SyncBackfillProgress,
} from "./backfill-state";

/**
 * Runs the capture backfill chunk after chunk, yielding between chunks, for the enable flow and for
 * whatever continues an interrupted backfill later. Each chunk is one writer slot of the repository
 * (`continueSyncCaptureBackfill`); between two chunks this awaits `yieldBetweenChunks` (a macrotask
 * by default), so the UI can paint and writes queued meanwhile are served before the next chunk
 * joins the queue.
 */

export type BackfillDriverRepository = Pick<AppRepository, "continueSyncCaptureBackfill">;

export interface BackfillTick extends SyncBackfillOutcome {
  /** Chunks run so far by this driver call. */
  chunksSoFar: number;
}

export interface RunBackfillOptions {
  limits?: Partial<SyncBackfillLimits>;
  /** Called after every chunk, with the latest progress. */
  onProgress?: (tick: BackfillTick) => void;
  /** Checked before every chunk; the driver stops cleanly (the pass stays resumable). */
  shouldStop?: () => boolean;
  /** Awaited between chunks. Default: a `setTimeout(0)` macrotask. */
  yieldBetweenChunks?: () => Promise<void>;
  /** Safety bound on the chunks one call runs (default: no bound). */
  maxChunks?: number;
}

export interface RunBackfillResult {
  complete: boolean;
  /** `shouldStop` ended the run before the pass finished. */
  stopped: boolean;
  chunks: number;
  stamped: number;
  scanned: number;
  /** Most statements issued by one chunk. */
  maxChunkStatements: number;
  progress: SyncBackfillProgress | null;
}

/** Chunks that end at the very same cursor in a row before the driver gives up. */
const MAX_REPEATED_CURSORS = 3;

const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export const runSyncCaptureBackfill = async (
  repository: BackfillDriverRepository,
  options: RunBackfillOptions = {},
): Promise<RunBackfillResult> => {
  const result: RunBackfillResult = {
    complete: false,
    stopped: false,
    chunks: 0,
    stamped: 0,
    scanned: 0,
    maxChunkStatements: 0,
    progress: null,
  };
  const yieldNow = options.yieldBetweenChunks ?? macrotask;
  let repeats = 0;
  let lastCursor: string | null = null;
  for (;;) {
    if (options.shouldStop?.() === true) {
      result.stopped = true;
      return result;
    }
    if (options.maxChunks !== undefined && result.chunks >= options.maxChunks) return result;
    const step = await repository.continueSyncCaptureBackfill({
      maxChunks: 1,
      ...(options.limits === undefined ? {} : { limits: options.limits }),
    });
    result.chunks += step.chunks;
    result.stamped += step.stamped;
    result.scanned += step.scanned;
    result.maxChunkStatements = Math.max(result.maxChunkStatements, step.maxChunkStatements);
    result.progress = step.progress;
    result.complete = step.complete;
    options.onProgress?.({ ...step, chunksSoFar: result.chunks });
    if (step.complete) return result;
    // A cursor that does not move would repeat the same chunk forever: say so instead.
    repeats = step.cursor === lastCursor ? repeats + 1 : 0;
    lastCursor = step.cursor;
    if (repeats >= MAX_REPEATED_CURSORS) {
      throw new Error("The capture backfill is not making progress (its cursor does not advance)");
    }
    await yieldNow();
  }
};

/** Whole percent (0-100) for a progress display; 100 only when the pass is complete. */
export const backfillPercent = (
  progress: Pick<SyncBackfillProgress, "scannedRows" | "totalRows"> | null,
  complete: boolean,
): number => {
  if (complete) return 100;
  if (progress === null || progress.totalRows <= 0) return 0;
  return Math.min(99, Math.floor((progress.scannedRows / progress.totalRows) * 100));
};
