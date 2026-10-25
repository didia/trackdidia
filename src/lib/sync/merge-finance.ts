import { hash128 } from "../finance/hash";
import type { RawRow } from "./capture-decode";
import type { SyncEntity } from "./change-set";
import { type ExtraConflict, terminalDivergenceId } from "./conflicts";
import { canonicalJson, getOwn, type JsonRecord, setOwn } from "./field-clocks";
import { compareHlc, parseHlc } from "./hlc";
import {
  type EntityMeta,
  type LocalEntityState,
  type OverwrittenField,
  sameMeta,
} from "./merge-entity";
import { mergeTerminalBeatsPending } from "./merge-primitives";
import { type LiveVersion, mergeRowEntity, type RowMergeOutcome, type RowRules } from "./merge-row";

/**
 * Merge rules of the finance tables (and `ai_memories`), layered on the whole-row merge of
 * `merge-row.ts`. Pure: no SQL, no clock issuance. `apply-rows.ts` / `apply-finance.ts` are the glue.
 *
 * Plain rows (people, accounts, categories, rules, merchant memory, budget entries and months,
 * recurring series, import profiles and batches, `ai_memories`, statement balance snapshots) use
 * the generic rule: whole-row last-writer-wins by row clock, the loser logged as an
 * `overwritten_edit` of the row, edit wins over delete. Only the tables below add anything.
 *
 * ## The categorization unit (`finance_transactions` + `finance_transaction_splits`)
 *
 * `{category_id, category_source, has_splits}` and the child splits form ONE unit with its own clocks
 * in `sync_entity_meta.field_clocks_json` (spec: "Finance categorization unit"). The three
 * descriptive columns written by the same decision (`category_confidence`, `categorized_at`) travel
 * with it, so a row never shows the confidence of a decision other than its category's. Every other
 * column of the transaction stays row-clock.
 *
 * Three clocks describe a unit write, all issued by the capturing device:
 * - `categorization`       the clock of the write (`c`);
 * - `categorization_base`  the unit clock this device held when it wrote (`base_hlc`): the write
 *                          provably saw every write at or before it (absent for a creation);
 * - `categorization_user`  the clock of the latest `user` decision in the write's history (`p`): a
 *                          `user` write sets it to its own clock, an automatic write inherits the one
 *                          of the unit it replaced.
 *
 * ## The order
 *
 * Units are compared by `(p, c)`, then by the smaller canonical JSON of the payload: a TOTAL order on
 * versions, so merging is a max, which is commutative, associative and idempotent, and replicas
 * converge in any arrival order. This is the spec's rule in a form that cannot cycle:
 *
 * - causally later wins: a device always writes with `c` above everything it holds and `p` at least
 *   the `p` of what it holds (it holds the maximum of everything it merged), so a write that saw
 *   another has a larger `(p, c)`. The spec example (B categorizes with splits as `user`, A removes
 *   the last split, which resets the parent to `default`) works because A's reset inherits `p` from
 *   B's write and has a later `c`: B's old children are not restored when B republishes;
 * - a peer republishing an unchanged row carries its old unit clocks and loses to any later write;
 * - concurrent writes: a `user` write has `p = c`, an automatic one only an inherited (older) `p`, so
 *   a stale automatic stage never overwrites a manual choice made elsewhere; two concurrent `user`
 *   writes compare by `c`, the later HLC wins and the loser is logged ({@link unitOverwrite}).
 *
 * A pairwise rule such as "if base >= the other's clock the writer saw it, else compare by source"
 * is NOT used for the order itself: it is not transitive (X saw a `user` write Y, a later automatic
 * Z saw neither, then X beats Y, Y beats Z, Z beats X), so merge results would depend on arrival
 * order. `base` is kept for the conflict log, which has to tell an ordinary later edit from a
 * concurrent one.
 *
 * The row-level winner and the unit winner may differ: the transaction merges its non-unit columns
 * by row clock and its unit columns by unit order, independently, and the children travel with the
 * winning unit as a set (never mixed). The product of two joins is a join. Like every row-clock
 * merge it is not a join across a tombstone that is later resurrected (replicas converge by
 * exchange).
 */

export const FINANCE_TRANSACTIONS = "finance_transactions";
export const FINANCE_SPLITS = "finance_transaction_splits";
export const FINANCE_SUGGESTIONS = "finance_category_suggestions";
export const FINANCE_SNAPSHOTS = "finance_account_balance_snapshots";

/** The columns that follow the unit when its winner is not the row winner. */
export const UNIT_COLUMNS = [
  "category_id",
  "category_source",
  "has_splits",
  "category_confidence",
  "categorized_at",
] as const;

/** The field name of the unit in `sync_conflicts` (`overwritten_edit`). */
export const UNIT_FIELD = "categorization";

/** Keys of the unit clocks in `sync_entity_meta.field_clocks_json`. */
export const UNIT_CLOCK_KEY = "categorization";
export const UNIT_BASE_KEY = "categorization_base";
export const UNIT_PROTECT_KEY = "categorization_user";
export const UNIT_CLOCK_KEYS: readonly string[] = [UNIT_CLOCK_KEY, UNIT_BASE_KEY, UNIT_PROTECT_KEY];

export const isUserSource = (source: unknown): boolean => source === "user";

const norm = (value: unknown): unknown =>
  typeof value === "bigint" ? Number(value) : (value ?? null);

// ---------------------------------------------------------------------------------------------
// Unit versions
// ---------------------------------------------------------------------------------------------

export interface UnitVersion {
  /** `c`: the clock of the write. */
  clock: string;
  /** `base_hlc`: the unit clock the writer held; `null` for a creation. */
  base: string | null;
  /** `p`: the clock of the latest `user` decision in the write's history; `null` when none. */
  protect: string | null;
}

/** The unit clocks present in a clock map (a row's meta carries nothing else besides these). */
export const pickUnitClocks = (clocks: Record<string, string>): Record<string, string> => {
  const picked: Record<string, string> = {};
  for (const key of UNIT_CLOCK_KEYS) {
    const value = getOwn(clocks, key);
    if (value !== undefined) setOwn(picked, key, value);
  }
  return picked;
};

export const hasUnitClock = (clocks: Record<string, string>): boolean =>
  getOwn(clocks, UNIT_CLOCK_KEY) !== undefined;

/**
 * The unit version of a stored or incoming transaction. A row stamped before the unit existed (no
 * unit clock) is read as a write at its own row clock with no base: `user` rows protect themselves.
 */
export const unitVersionOf = (
  clocks: Record<string, string>,
  rowHlc: string,
  row: RawRow,
): UnitVersion => {
  const clock = getOwn(clocks, UNIT_CLOCK_KEY);
  if (clock === undefined) {
    return {
      clock: rowHlc,
      base: null,
      protect: isUserSource(row.category_source) ? rowHlc : null,
    };
  }
  return {
    clock,
    base: getOwn(clocks, UNIT_BASE_KEY) ?? null,
    protect: getOwn(clocks, UNIT_PROTECT_KEY) ?? null,
  };
};

/** The clock map that stores a unit version (absent parts are absent keys). */
export const unitClocksOf = (version: UnitVersion): Record<string, string> => {
  const clocks: Record<string, string> = {};
  setOwn(clocks, UNIT_CLOCK_KEY, version.clock);
  if (version.base !== null) setOwn(clocks, UNIT_BASE_KEY, version.base);
  if (version.protect !== null) setOwn(clocks, UNIT_PROTECT_KEY, version.protect);
  return clocks;
};

/**
 * The version a device stamps when its categorization unit changes at `hlc`: `previous` is the unit
 * it held (`null` for a creation or a row without a live meta). A `user` write protects itself; an
 * automatic one inherits the protection of what it replaced.
 */
export const nextUnitVersion = (
  previous: UnitVersion | null,
  source: unknown,
  hlc: string,
): UnitVersion => ({
  clock: hlc,
  base: previous?.clock ?? null,
  protect: isUserSource(source) ? hlc : (previous?.protect ?? null),
});

/** The unit columns of a row, normalized (bigint -> number, missing -> null). */
export const unitPayloadOf = (row: RawRow): JsonRecord => {
  const payload: JsonRecord = {};
  for (const column of UNIT_COLUMNS) setOwn<unknown>(payload, column, norm(row[column]));
  return payload;
};

const normalizedRow = (row: RawRow): JsonRecord => {
  const result: JsonRecord = {};
  for (const column of Object.keys(row)) setOwn<unknown>(result, column, norm(row[column]));
  return result;
};

const byId = (a: RawRow, b: RawRow): number => {
  const left = String(a.id ?? "");
  const right = String(b.id ?? "");
  return left < right ? -1 : left > right ? 1 : 0;
};

/** A child's columns that make up the decision; `created_at` is bookkeeping and is left out. */
const signatureRow = (row: RawRow): JsonRecord => {
  const result = normalizedRow(row);
  delete result.created_at;
  return result;
};

/**
 * The content of the unit: its payload and every child row (without `created_at`: re-saving the
 * same splits is not a new decision). Equal signatures mean the unit holds the
 * same decision and the same splits, so a stamper that sees the same signature stamps nothing.
 */
export const unitSignature = (row: RawRow, children: readonly RawRow[]): string =>
  hash128(
    canonicalJson({
      payload: unitPayloadOf(row),
      splits: [...children].sort(byId).map(signatureRow),
    }),
  );

export interface UnitSide {
  version: UnitVersion;
  payload: JsonRecord;
}

const compareMaybe = (a: string | null, b: string | null): number =>
  a === null ? (b === null ? 0 : -1) : b === null ? 1 : compareHlc(a, b);

/**
 * Positive when `a` wins, negative when `b` wins, zero for the same version. Symmetric, and a total
 * order (the module comment explains why it is `(p, c)` and not the pairwise causal rule).
 */
export const compareUnits = (a: UnitSide, b: UnitSide): number => {
  const byProtect = compareMaybe(a.version.protect, b.version.protect);
  if (byProtect !== 0) return byProtect;
  const byClock = compareHlc(a.version.clock, b.version.clock);
  if (byClock !== 0) return byClock;
  const left = canonicalJson(a.payload);
  const right = canonicalJson(b.payload);
  return left === right ? 0 : left < right ? 1 : -1;
};

export type UnitWinner = "local" | "remote" | "equal" | "gone";

/**
 * The set of children a transaction must hold after its merge, or `null` when its local children
 * stay: the winning unit's set, never a mix. A remote unit (or a fresh insert) installs the remote
 * set; a local unit, or the same write on both sides, keeps the local set; a deleted transaction
 * keeps none.
 */
export const wantedChildren = <R>(winner: UnitWinner, remote: readonly R[]): readonly R[] | null =>
  winner === "remote" ? remote : winner === "gone" ? [] : null;

// ---------------------------------------------------------------------------------------------
// The transaction merge
// ---------------------------------------------------------------------------------------------

export interface TransactionMergeInput {
  /** Every local column of `finance_transactions`. */
  columns: readonly string[];
  /** The local row and its meta, whose `fieldClocks` hold the unit clocks. */
  local: LocalEntityState;
  remote: SyncEntity;
  /** The applying device (see `RowMergeInput.localDeviceId`). */
  localDeviceId?: string;
}

export interface TransactionMergeOutcome extends RowMergeOutcome {
  unit: {
    winner: UnitWinner;
    /** The local unit before the merge; `null` without a live, stamped local row. */
    local: UnitVersion | null;
    /** The remote unit; `null` for a tombstone. */
    remote: UnitVersion | null;
  };
}

/** Everything but the unit is merged by row clock; the unit columns are joined (see the module). */
const TRANSACTION_ROW_RULES: RowRules = { reportOverwrites: true, joined: UNIT_COLUMNS };

/**
 * Merges one remote `finance_transactions` entity into the local state: the non-unit columns as a
 * plain row (`mergeRowEntity`), the unit columns by unit order, independently. The stored meta keeps
 * the row clock of the row winner and the unit clocks of the unit winner. The children are NOT
 * touched here: the caller replaces them according to `unit.winner` ({@link resolveChildren}).
 */
export const mergeTransactionEntity = (input: TransactionMergeInput): TransactionMergeOutcome => {
  const { columns, local, remote, localDeviceId } = input;
  const localLive = local.row !== null && local.meta !== null && local.meta.deletedAt === null;
  const localUnit =
    localLive && local.row !== null && local.meta !== null
      ? unitVersionOf(local.meta.fieldClocks, local.meta.rowHlc, local.row)
      : null;
  const remoteUnit =
    remote.row === null ? null : unitVersionOf(remote.fieldClocks, remote.rowHlc, remote.row);

  let order = 0;
  if (localUnit !== null && remoteUnit !== null && local.row !== null && remote.row !== null) {
    order = compareUnits(
      { version: remoteUnit, payload: unitPayloadOf(remote.row) },
      { version: localUnit, payload: unitPayloadOf(local.row) },
    );
  }
  // A local row without a stamped meta has never been published: any remote unit replaces it.
  const remoteUnitWins = remoteUnit !== null && (localUnit === null || order > 0);

  const inner = mergeRowEntity({
    columns,
    local,
    remote,
    ...(localDeviceId === undefined ? {} : { localDeviceId }),
    rules: {
      ...TRANSACTION_ROW_RULES,
      absorb: (winner) => {
        const source = remoteUnitWins ? remote.row : local.row;
        if (source === null) return winner;
        const row: RawRow = { ...winner };
        for (const column of UNIT_COLUMNS) {
          if (Object.hasOwn(source, column)) setOwn(row, column, source[column]);
        }
        return row;
      },
    },
  });

  if (inner.finalRow === null) {
    // A tombstone (new or kept): the unit clocks mean nothing without the row.
    return { ...inner, unit: { winner: "gone", local: localUnit, remote: remoteUnit } };
  }
  if (remote.row === null) {
    // A delete that lost to a later local edit: nothing changes.
    return { ...inner, unit: { winner: "local", local: localUnit, remote: remoteUnit } };
  }
  if (inner.rowAction === "insert") {
    const meta: EntityMeta = {
      fieldClocks: unitClocksOf(remoteUnit as UnitVersion),
      rowHlc: inner.meta.rowHlc,
      deletedAt: null,
    };
    return {
      ...inner,
      meta,
      metaChanged: true,
      unit: { winner: "remote", local: null, remote: remoteUnit },
    };
  }

  const winnerUnit = (remoteUnitWins ? remoteUnit : localUnit) as UnitVersion;
  const meta: EntityMeta = {
    fieldClocks: unitClocksOf(winnerUnit),
    rowHlc: inner.meta.rowHlc,
    deletedAt: null,
  };
  const winner: UnitWinner = remoteUnitWins ? "remote" : order === 0 ? "equal" : "local";
  return {
    ...inner,
    meta,
    metaChanged: !sameMeta(local.meta, meta),
    unit: { winner, local: localUnit, remote: remoteUnit },
  };
};

export interface UnitContent {
  version: UnitVersion;
  row: RawRow;
  signature: string;
}

/**
 * The `overwritten_edit` for a remote unit that replaced a local one, or `null` when nothing the
 * user decided was lost: the local unit must be a `user` decision, the remote write must not have
 * seen it (its `base` is before the local clock) and the content must differ. Only the replica
 * whose value was replaced logs it.
 */
export const unitOverwrite = (
  local: UnitContent,
  remote: UnitContent,
  splits: { local: readonly RawRow[]; remote: readonly RawRow[] },
  localDeviceId?: string,
): OverwrittenField | null => {
  if (!isUserSource(local.row.category_source)) return null;
  // A decision that came from a peer and is replaced by that peer's later write is propagation.
  if (localDeviceId !== undefined && parseHlc(local.version.clock)?.deviceId !== localDeviceId) {
    return null;
  }
  if (remote.version.base !== null && compareHlc(remote.version.base, local.version.clock) >= 0) {
    return null;
  }
  if (local.signature === remote.signature) return null;
  const describe = (content: UnitContent, children: readonly RawRow[]) => ({
    value: {
      ...unitPayloadOf(content.row),
      splits: [...children].sort(byId).map(normalizedRow),
    },
    clock: content.version.clock,
  });
  return {
    field: UNIT_FIELD,
    local: describe(local, splits.local),
    remote: describe(remote, splits.remote),
  };
};

// ---------------------------------------------------------------------------------------------
// Generic rows, splits, snapshots
// ---------------------------------------------------------------------------------------------

/** Whole-row last-writer-wins, the loser logged as an overwritten edit of the row. */
export const GENERIC_ROW_RULES: RowRules = { reportOverwrites: true };

/**
 * Statement snapshots: whole row, except that a `statement` row beats a `derived` one at the same
 * key whatever the clocks (the app's own daily job never overwrites a statement either:
 * `ON CONFLICT ... WHERE source <> 'statement'`). Only statement rows are ever published, so the
 * derived side is always a local row. The standing-anchor rule is in `apply-finance.ts`.
 */
export const SNAPSHOT_RULES: RowRules = {
  reportOverwrites: true,
  rank: (a: LiveVersion, b: LiveVersion): number => {
    const left = a.row.source === "statement";
    const right = b.row.source === "statement";
    return left === right ? 0 : left ? 1 : -1;
  },
};

/**
 * The order of the statement anchors of one account: the later row clock, then the later statement
 * date. A total order on distinct anchors, so every replica keeps the same one.
 */
export const compareAnchors = (
  a: { clock: string | null; asOfDate: string },
  b: { clock: string | null; asOfDate: string },
): number => {
  const byClock = compareMaybe(a.clock, b.clock);
  if (byClock !== 0) return byClock;
  return a.asOfDate === b.asOfDate ? 0 : a.asOfDate > b.asOfDate ? 1 : -1;
};

// ---------------------------------------------------------------------------------------------
// Category suggestions (monotonic status)
// ---------------------------------------------------------------------------------------------

/**
 * `expired` is not a status the app writes: the apply step stores a pending suggestion that lost its
 * natural key (one pending per transaction) as `expired`, exactly as for AI proposals.
 */
export const SUGGESTION_TERMINAL_STATUSES = [
  "accepted",
  "corrected",
  "dismissed",
  "expired",
] as const;

export const isTerminalSuggestionStatus = (status: unknown): boolean =>
  typeof status === "string" &&
  (SUGGESTION_TERMINAL_STATUSES as readonly string[]).includes(status);

const statusOf = (row: RawRow): string => String(row.status ?? "");

/**
 * - a TERMINAL status beats `pending` whatever the clocks say, and brings its whole row;
 * - two DIFFERENT terminal statuses keep the smaller string (`accepted` < `corrected` < `dismissed`
 *   < `expired`, which is also the order of consequence) and, when both are user decisions, write an
 *   unresolved `terminal_divergence` conflict; an `expired` row is the engine's, not a decision, so
 *   a user decision silently beats it;
 * - the same status, or two pending rows: the later clock, then the smaller JSON;
 * - a terminal row beats any tombstone (`survivesDelete`): the app deletes pending suggestions when a
 *   transaction is categorized, so a delete racing a decision means the deleter had not seen it.
 *   Consequence: the suggestions of a transaction removed by an import undo stay on a laptop that
 *   decided them (harmless: a decided suggestion is only read as a dismissal memory by merchant and
 *   category, never joined to its transaction).
 */
export const SUGGESTION_RULES: RowRules = {
  survivesDelete: (row) => isTerminalSuggestionStatus(row.status),
  rank: (a: LiveVersion, b: LiveVersion): number => {
    const left = statusOf(a.row);
    const right = statusOf(b.row);
    const leftTerminal = isTerminalSuggestionStatus(left);
    const rightTerminal = isTerminalSuggestionStatus(right);
    if (leftTerminal !== rightTerminal) return leftTerminal ? 1 : -1;
    if (leftTerminal && left !== right) {
      const merged = mergeTerminalBeatsPending(left, right, SUGGESTION_TERMINAL_STATUSES);
      return merged.status === left ? 1 : -1;
    }
    return 0;
  },
  conflictsFor: (local, remote): ExtraConflict[] => {
    const left = statusOf(local);
    const right = statusOf(remote);
    if (
      !isTerminalSuggestionStatus(left) ||
      !isTerminalSuggestionStatus(right) ||
      left === right ||
      left === "expired" ||
      right === "expired"
    ) {
      return [];
    }
    const id = String(local.id ?? remote.id ?? "");
    return [
      {
        id: terminalDivergenceId(FINANCE_SUGGESTIONS, id, null),
        kind: "terminal_divergence",
        entityType: FINANCE_SUGGESTIONS,
        entityId: id,
        local,
        remote,
      },
    ];
  },
};
