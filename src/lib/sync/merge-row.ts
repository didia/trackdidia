import type { RawRow } from "./capture-decode";
import type { SyncEntity } from "./change-set";
import type { ExtraConflict } from "./conflicts";
import { canonicalJson, getOwn, jsonDeepEqual, setOwn } from "./field-clocks";
import { compareHlc, maxHlc, parseHlc } from "./hlc";
import {
  BOOKKEEPING_FIELDS,
  type EntityMergeOutcome,
  type EntityMeta,
  type LocalEntityState,
  type OverwrittenField,
  sameMeta,
} from "./merge-entity";

/**
 * Pure merge of ONE row-clock entity: a table captured as a whole row (`sync_entity_meta` holds one
 * `row_hlc` and a tombstone, no per-field clocks). No SQL, no clock issuance; the caller
 * (`apply-rows.ts`) feeds in what the database holds and writes what comes out.
 *
 * ## The order
 *
 * The state of an entity is either a LIVE version (the row and the clock of the write that made it)
 * or a TOMBSTONE (the clock of the delete). The merge keeps the greatest state of a total order, so
 * for plain rows it is commutative, associative and idempotent over the entity's own states (the
 * caveats are at the end of this comment):
 *
 * - a tombstone against a live version: the later clock wins, and an edit with a clock equal to the
 *   delete keeps the entity alive (edit wins over delete, as everywhere in the engine). A live row
 *   that has no clock yet (never stamped) loses to every delete. A rule may declare some live rows
 *   {@link RowRules.survivesDelete} (a decided proposal): such a row beats every tombstone whatever
 *   the clocks, which is still a total order (those rows on top, then the clock order above);
 * - two tombstones: the later clock;
 * - two live versions: the table's {@link RowRules.rank} first (a rule may rank a version
 *   above another whatever the clocks say), then the later clock, then the smaller canonical JSON
 *   of the shared columns. The winning version brings ALL its columns, because a row has no
 *   per-field history to split it by. {@link RowRules.absorb} is the one escape hatch: a
 *   grow-only column (a segment's `ended_at`) is joined across both versions instead, and kept out
 *   of the tie-break text, so the product of the two joins is still a join.
 *
 * Caveats: this is a join only for plain rows. A tombstone carries no row, so (as for field-clock
 * tables) the merge is not a join across a tombstone that is later resurrected: the resurrecting
 * version brings its own values only. And with an {@link RowRules.absorb} column (a segment's
 * `ended_at`) a tombstone in between loses the absorbed value, so three versions are not
 * guaranteed to give one result in one pass in every order; replicas converge once they exchange.
 *
 * Apply never issues a clock: the stored clock after a merge is always one that was issued by a
 * device, the winner's. A column the sender lacks (an older schema) keeps its local value.
 */

/** One live version of a row with the clock of the write that made it (`null`: never stamped). */
export interface LiveVersion {
  row: RawRow;
  clock: string | null;
}

export interface RowRules {
  /**
   * Positive when `a` must win, negative when `b` must, zero to defer to the clocks. Lets a table
   * rank versions by something other than time (a terminal status over a pending one).
   */
  rank?: (a: LiveVersion, b: LiveVersion) => number;
  /** Columns joined by {@link absorb}; left out of the tie-break text and of overwrite reports. */
  joined?: readonly string[];
  /** Folds the loser's grow-only columns into the winner's row. Must be a join per column. */
  absorb?: (winner: RawRow, loser: RawRow) => RawRow;
  /** Live rows that beat any tombstone whatever the clocks (a decided proposal). */
  survivesDelete?: (row: RawRow) => boolean;
  /** Log a remote version that replaced a different local one (an `overwritten_edit` of the row). */
  reportOverwrites?: boolean;
  /** Extra conflicts for two live versions that differ (for example two different terminals). */
  conflictsFor?: (local: RawRow, remote: RawRow) => ExtraConflict[];
}

export interface RowMergeInput {
  /** Every local column of the table (key columns included). */
  columns: readonly string[];
  local: LocalEntityState;
  remote: SyncEntity;
  rules?: RowRules;
  /**
   * The device applying the bundle. When given, a replaced local version is reported as an
   * overwritten edit only if its clock was ISSUED by this device: a version that itself arrived from
   * a peer and is now replaced by a later edit of that peer is ordinary propagation, not a lost
   * local edit (without this, whole-row last-writer-wins would log every propagated edit).
   */
  localDeviceId?: string;
}

export interface RowMergeOutcome extends EntityMergeOutcome {
  /** The row stored after the merge; `null` when the entity has no row. */
  finalRow: RawRow | null;
  conflicts: ExtraConflict[];
}

/** The `field` an overwritten whole row is reported under in `sync_conflicts`. */
export const ROW_CONFLICT_FIELD = "(row)";

const num = (value: unknown): unknown => (typeof value === "bigint" ? Number(value) : value);

const sameCell = (a: unknown, b: unknown): boolean => jsonDeepEqual(num(a), num(b));

const compareMaybe = (a: string | null, b: string | null): number =>
  a === null ? (b === null ? 0 : -1) : b === null ? 1 : compareHlc(a, b);

/** The text that breaks a tie between two versions with the same clock: shared columns only. */
const tieText = (row: RawRow, shared: readonly string[]): string => {
  const picked: Record<string, unknown> = {};
  for (const column of shared) setOwn(picked, column, num(row[column] ?? null));
  return canonicalJson(picked);
};

/**
 * Positive when `a` beats `b`, negative when `b` beats `a`, zero for identical versions. Pure and
 * symmetric (`compare(a, b) === -compare(b, a)`), which is what makes the merge order independent.
 */
export const compareVersions = (a: LiveVersion, b: LiveVersion, rules: RowRules = {}): number => {
  const ranked = rules.rank?.(a, b) ?? 0;
  if (ranked !== 0) return Math.sign(ranked);
  const byClock = compareMaybe(a.clock, b.clock);
  if (byClock !== 0) return byClock;
  const joined = new Set(rules.joined ?? []);
  const shared = Object.keys(a.row)
    .filter((column) => Object.hasOwn(b.row, column) && !joined.has(column))
    .sort();
  const left = tieText(a.row, shared);
  const right = tieText(b.row, shared);
  return left === right ? 0 : left < right ? 1 : -1;
};

const liveClockOf = (local: LocalEntityState): string | null =>
  local.meta !== null && local.meta.deletedAt === null ? local.meta.rowHlc : null;

const unchanged = (local: LocalEntityState, remote: SyncEntity): RowMergeOutcome => ({
  rowAction: "none",
  columns: {},
  meta: local.meta ?? { fieldClocks: {}, rowHlc: remote.rowHlc, deletedAt: null },
  metaChanged: false,
  tombstoneApplied: false,
  overwritten: [],
  conflicts: [],
  finalRow: local.row,
});

const tombstoneMeta = (deletedAt: string): EntityMeta => ({
  fieldClocks: {},
  rowHlc: deletedAt,
  deletedAt,
});

const liveMeta = (rowHlc: string): EntityMeta => ({ fieldClocks: {}, rowHlc, deletedAt: null });

/** Merges the remote entity into the local state; see the module comment. */
export const mergeRowEntity = (input: RowMergeInput): RowMergeOutcome => {
  const { columns, local, remote } = input;
  const rules = input.rules ?? {};
  const localHasRow = local.row !== null;
  const localDeletedAt = local.meta?.deletedAt ?? null;

  // --- A remote tombstone. ----------------------------------------------------------------------
  if (remote.row === null) {
    const deletedAt = remote.deletedAt as string;
    if (localHasRow) {
      const liveClock = liveClockOf(local);
      if (
        rules.survivesDelete?.(local.row as RawRow) === true ||
        (liveClock !== null && compareHlc(deletedAt, liveClock) <= 0)
      ) {
        return unchanged(local, remote); // an edit as late as the delete keeps the row
      }
      return {
        rowAction: "delete",
        columns: {},
        meta: tombstoneMeta(deletedAt),
        metaChanged: true,
        tombstoneApplied: true,
        overwritten: [],
        conflicts: [],
        finalRow: null,
      };
    }
    const best = maxHlc(localDeletedAt, deletedAt) as string;
    const meta = tombstoneMeta(best);
    const metaChanged = !sameMeta(local.meta, meta);
    return {
      rowAction: "none",
      columns: {},
      meta,
      metaChanged,
      tombstoneApplied: metaChanged,
      overwritten: [],
      conflicts: [],
      finalRow: null,
    };
  }

  // --- A remote live version. -------------------------------------------------------------------
  const remoteRow = remote.row;
  const remoteVersion: LiveVersion = { row: remoteRow, clock: remote.rowHlc };

  if (!localHasRow) {
    if (
      localDeletedAt !== null &&
      compareHlc(remote.rowHlc, localDeletedAt) < 0 &&
      rules.survivesDelete?.(remoteRow) !== true
    ) {
      return unchanged(local, remote); // the delete is later than this version
    }
    const inserted: RawRow = {};
    for (const column of columns) {
      if (Object.hasOwn(remoteRow, column)) setOwn(inserted, column, getOwn(remoteRow, column));
    }
    return {
      rowAction: "insert",
      columns: inserted,
      meta: liveMeta(remote.rowHlc),
      metaChanged: true,
      tombstoneApplied: false,
      overwritten: [],
      conflicts: [],
      finalRow: inserted,
    };
  }

  const localRow = local.row as RawRow;
  const localVersion: LiveVersion = { row: localRow, clock: liveClockOf(local) };
  const verdict = compareVersions(localVersion, remoteVersion, rules);
  const remoteWins = verdict < 0;

  // The winning version's columns, then the grow-only columns of both.
  let finalRow: RawRow = { ...localRow };
  if (remoteWins) {
    for (const column of columns) {
      if (Object.hasOwn(remoteRow, column)) setOwn(finalRow, column, getOwn(remoteRow, column));
    }
  }
  if (rules.absorb) {
    finalRow = rules.absorb(finalRow, remoteWins ? localRow : remoteRow);
  }

  const changed: Record<string, unknown> = {};
  for (const column of columns) {
    if (!sameCell(finalRow[column], localRow[column])) setOwn(changed, column, finalRow[column]);
  }

  // A local row that was never stamped and wins keeps having no meta row (the capture scan stamps
  // it): `metaChanged` stays false, so the placeholder below is never written.
  const meta: EntityMeta = remoteWins
    ? liveMeta(remote.rowHlc)
    : (local.meta ?? liveMeta(remote.rowHlc));
  const metaChanged = remoteWins && !sameMeta(local.meta, meta);

  const joined = new Set(rules.joined ?? []);
  const differs = columns.some(
    (column) =>
      !BOOKKEEPING_FIELDS.has(column) &&
      !joined.has(column) &&
      Object.hasOwn(remoteRow, column) &&
      !sameCell(localRow[column], remoteRow[column]),
  );
  const authoredHere =
    input.localDeviceId === undefined ||
    localVersion.clock === null ||
    parseHlc(localVersion.clock)?.deviceId === input.localDeviceId;
  const overwritten: OverwrittenField[] =
    rules.reportOverwrites === true && remoteWins && differs && authoredHere
      ? [
          {
            field: ROW_CONFLICT_FIELD,
            local: { value: localRow, clock: localVersion.clock },
            remote: { value: remoteRow, clock: remote.rowHlc },
          },
        ]
      : [];

  return {
    rowAction: Object.keys(changed).length > 0 ? "update" : "none",
    columns: changed,
    meta,
    metaChanged,
    tombstoneApplied: false,
    overwritten,
    conflicts: rules.conflictsFor?.(localRow, remoteRow) ?? [],
    finalRow,
  };
};
