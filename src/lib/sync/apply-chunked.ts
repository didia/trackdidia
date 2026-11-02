import type { SyncApplyOptions, SyncApplyResult, SyncChangeSet } from "./change-set";
import type { AppRepository } from "../storage/repository";
import type { SyncDomain } from "./registry";
import { type ApplyLimits, planChangeSet } from "./split-change-set";

/**
 * Applies a (possibly large) change set as an ordered list of smaller ones, each through the
 * repository's own `applySyncBundle`, which stays ONE atomic write transaction per call.
 *
 * What the caller can rely on.
 * - EQUIVALENCE. The pieces come from `planChangeSet`: applied in order they leave the same rows,
 *   clocks, snapshots, aliases and conflicts as the whole set would (up to the value of clocks the
 *   applying device invents for cascade tombstones; see `docs/storage-and-backups.md`). A set that
 *   fits the limits is applied in a single call, exactly as before.
 * - EVERY PREFIX IS VALID. Each piece is a complete, valid change set merged by the same joins, so
 *   a failure, a stop or a quit after any piece leaves a database a smaller bundle could have
 *   produced (foreign keys intact, nothing half applied). Applying the pieces again is idempotent;
 *   the caller records the peer's hash only after the LAST piece succeeded, so an interrupted run is
 *   simply repeated (already-applied pieces merge to no-ops).
 * - BOUNDED SLOTS. Each piece is its own writer slot; between pieces this awaits
 *   `yieldBetweenChunks` and the writer queue serves whatever was queued meanwhile.
 * - STOPPING IS CLEAN. `shouldStop` is asked BETWEEN pieces, never inside one, and not before the
 *   first piece of a call, so every call makes progress. A stopped run reports `nextChunk`; passing
 *   it back as `startAt` resumes there (valid only for the same set and limits: the plan is a pure
 *   function of both). Without it the run restarts from the first piece, which is correct and cheap.
 * - SAFETY BACKUP and `republish` are the caller's: the backup must precede the first piece (the
 *   engine takes it before calling), `republish` is passed to every piece so each one that changed
 *   anything bumps the change counter in its own transaction.
 */

export type ChunkedApplyRepository = Pick<AppRepository, "applySyncBundle">;

export interface ChunkProgress {
  /** 0-based index of the piece that just finished. */
  chunk: number;
  chunks: number;
  /** Wall time of that piece (one writer slot plus validation). */
  ms: number;
  result: SyncApplyResult;
}

export interface ApplyChunkedOptions {
  limits?: Partial<ApplyLimits>;
  republish?: boolean;
  /** Called after every piece. */
  onProgress?: (progress: ChunkProgress) => void;
  /** Asked between pieces (not before the first of this call); true stops the run cleanly. */
  shouldStop?: () => boolean;
  /** Awaited between pieces. Default: a `setTimeout(0)` macrotask. */
  yieldBetweenChunks?: () => Promise<void>;
  /** First piece to apply (resuming a stopped run of the same set and limits). Default 0. */
  startAt?: number;
  /** Milliseconds clock for the per-piece timings. */
  now?: () => number;
}

export interface ChunkedApplyResult extends SyncApplyResult {
  /** Pieces the set was split into (1 when it fits the limits). */
  chunks: number;
  /** Pieces applied by this call. */
  chunksApplied: number;
  /** Index to resume at; `null` once the last piece was applied. */
  nextChunk: number | null;
  /** The run ended early because `shouldStop` said so. */
  stopped: boolean;
  /** Duration of the slowest piece of this call. */
  maxChunkMs: number;
  chunkMs: number[];
  /** Entities of the largest group, which is never cut (see `planChangeSet`). */
  largestGroup: number;
  oversizedGroups: number;
}

/** A piece failed. Earlier pieces stay applied (a valid state); the original error is the cause. */
export class ChunkedApplyError extends Error {
  readonly chunk: number;
  readonly chunks: number;
  /** What the pieces before the failing one did. */
  readonly partial: ChunkedApplyResult;

  constructor(cause: unknown, chunk: number, chunks: number, partial: ChunkedApplyResult) {
    super(
      `${cause instanceof Error ? cause.message : String(cause)} (while applying part ${chunk + 1} of ${chunks}; the ${chunk} earlier part(s) were kept)`,
      { cause },
    );
    this.name = "ChunkedApplyError";
    this.chunk = chunk;
    this.chunks = chunks;
    this.partial = partial;
  }
}

const macrotask = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export const applyChunked = async (
  repository: ChunkedApplyRepository,
  domain: SyncDomain,
  changeSet: SyncChangeSet,
  options: ApplyChunkedOptions = {},
): Promise<ChunkedApplyResult> => {
  const plan = planChangeSet(changeSet, options.limits);
  const clock = options.now ?? (() => performance.now());
  const startAt = Math.max(0, options.startAt ?? 0);
  const applyOptions: SyncApplyOptions = options.republish === true ? { republish: true } : {};
  const yieldNow = options.yieldBetweenChunks ?? macrotask;

  const total: ChunkedApplyResult = {
    applied: 0,
    skipped: 0,
    tombstonesApplied: 0,
    conflictsLogged: 0,
    hlcAdvanced: false,
    chunks: plan.chunks.length,
    chunksApplied: 0,
    nextChunk: startAt >= plan.chunks.length ? null : startAt,
    stopped: false,
    maxChunkMs: 0,
    chunkMs: [],
    largestGroup: plan.largestGroup,
    oversizedGroups: plan.oversizedGroups,
  };

  for (let index = startAt; index < plan.chunks.length; index += 1) {
    if (index > startAt) {
      if (options.shouldStop?.() === true) {
        total.stopped = true;
        total.nextChunk = index;
        return total;
      }
      await yieldNow();
    }
    const started = clock();
    let result: SyncApplyResult;
    try {
      result = await repository.applySyncBundle(
        domain,
        plan.chunks[index] as SyncChangeSet,
        applyOptions,
      );
    } catch (error) {
      total.nextChunk = index;
      throw new ChunkedApplyError(error, index, plan.chunks.length, total);
    }
    const ms = clock() - started;
    total.applied += result.applied;
    total.skipped += result.skipped;
    total.tombstonesApplied += result.tombstonesApplied;
    total.conflictsLogged += result.conflictsLogged;
    total.hlcAdvanced = total.hlcAdvanced || result.hlcAdvanced;
    total.chunksApplied += 1;
    total.maxChunkMs = Math.max(total.maxChunkMs, ms);
    total.chunkMs.push(ms);
    total.nextChunk = index + 1 >= plan.chunks.length ? null : index + 1;
    options.onProgress?.({ chunk: index, chunks: plan.chunks.length, ms, result });
  }
  return total;
};
