import { canonicalJson, jsonDeepEqual, jsonNormalize } from "./field-clocks";
import { compareHlc, maxHlc } from "./hlc";

/**
 * Pure merge building blocks. Later slices compose them into per-table merges; nothing here knows
 * about a table, a task lifecycle or storage.
 *
 * Every primitive is a join over a semilattice: commutative (`merge(a, b)` equals `merge(b, a)`),
 * idempotent (`merge(a, a)` equals `a`) and, where noted, associative. That is what lets peers
 * converge whatever order bundles arrive in. Where two *different* values carry the *same* clock
 * (impossible for clocks issued by distinct devices, but possible with corrupt or hand-edited
 * data), the tie is broken by canonical JSON text, never by argument position, so commutativity
 * holds even then.
 */

/** A nullable clock: `null`/`undefined` means "never stamped" and loses to any clock. */
export type MaybeClock = string | null | undefined;

const compareMaybeClock = (a: MaybeClock, b: MaybeClock): number => {
  if (a === null || a === undefined) {
    return b === null || b === undefined ? 0 : -1;
  }
  if (b === null || b === undefined) {
    return 1;
  }
  return compareHlc(a, b);
};

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const isPresent = (value: string | null | undefined): value is string =>
  value !== null && value !== undefined && value !== "";

// ---------------------------------------------------------------------------------------------
// Last-writer-wins
// ---------------------------------------------------------------------------------------------

export type ClockedValue<T> = { value: T; clock: string | null };

export type LwwResult<T> = ClockedValue<T> & {
  winner: "local" | "remote" | "equal";
  /**
   * The discarded side whenever the two values differ. This includes an ordinary later edit by a
   * peer that had already seen the old value: clocks alone cannot tell a concurrent write from a
   * causally later one, so deciding whether the edits were really concurrent (before logging to
   * `sync_conflicts`) is the caller's job. `null` when the values are equal (a later clock
   * carrying the same value is not an overwrite).
   */
  overwritten: ClockedValue<T> | null;
};

/**
 * Last-writer-wins by clock. The later clock wins; `winner: "equal"` means identical clocks and
 * values (a no-op). Equal clocks with different values are resolved by smaller canonical JSON.
 * Associative, commutative (the result's `winner` flips sides, everything else is identical) and
 * idempotent.
 */
export const mergeLww = <T>(
  localValue: T,
  localClock: MaybeClock,
  remoteValue: T,
  remoteClock: MaybeClock,
): LwwResult<T> => {
  const local: ClockedValue<T> = { value: localValue, clock: localClock ?? null };
  const remote: ClockedValue<T> = { value: remoteValue, clock: remoteClock ?? null };
  const sameValue = jsonDeepEqual(localValue, remoteValue);
  const byClock = compareMaybeClock(local.clock, remote.clock);

  if (byClock === 0 && sameValue) {
    // Equal under JSON semantics but possibly a different representation (`undefined` vs `null`,
    // key order): return one canonical form so the result does not depend on argument order.
    const value = Object.is(localValue, remoteValue) ? localValue : jsonNormalize(localValue);
    return { value, clock: local.clock, winner: "equal", overwritten: null };
  }
  const localWins =
    byClock !== 0
      ? byClock > 0
      : compareText(canonicalJson(localValue), canonicalJson(remoteValue)) < 0;
  const winner = localWins ? local : remote;
  const loser = localWins ? remote : local;
  return {
    value: winner.value,
    clock: winner.clock,
    winner: localWins ? "local" : "remote",
    overwritten: sameValue ? null : loser,
  };
};

// ---------------------------------------------------------------------------------------------
// OR-set
// ---------------------------------------------------------------------------------------------

/** Latest add and latest remove event of one element. */
export type OrSetElement = { addedAt?: string | null; removedAt?: string | null };
export type OrSetElements = Record<string, OrSetElement>;

export type OrSetResult = {
  /** Merged per-element clocks (per-side maxima), `undefined`/`null` clocks omitted. */
  elements: Record<string, { addedAt?: string; removedAt?: string }>;
  /** Ids of the elements that are present, sorted ascending (code-unit order). */
  ids: string[];
};

/**
 * Merges two OR-sets stored as per-element add/remove clocks. Each clock keeps its per-side
 * maximum; an element is present iff its latest add is strictly later than its latest remove.
 *
 * Tie rule: equal add and remove clocks mean the element is absent (remove wins). Distinct devices
 * never issue equal clocks, so this only fixes a deterministic answer for degenerate data.
 * Concurrent adds of different elements both survive, which is the point of using a set rather
 * than last-writer-wins on the whole list. Associative, commutative, idempotent.
 */
export const mergeOrSet = (local: OrSetElements, remote: OrSetElements): OrSetResult => {
  const elements: OrSetResult["elements"] = {};
  const ids: string[] = [];
  for (const id of new Set([...Object.keys(local), ...Object.keys(remote)])) {
    const addedAt = maxHlc(local[id]?.addedAt, remote[id]?.addedAt);
    const removedAt = maxHlc(local[id]?.removedAt, remote[id]?.removedAt);
    if (addedAt === null && removedAt === null) {
      continue;
    }
    const merged: { addedAt?: string; removedAt?: string } = {};
    if (addedAt !== null) {
      merged.addedAt = addedAt;
    }
    if (removedAt !== null) {
      merged.removedAt = removedAt;
    }
    elements[id] = merged;
    if (addedAt !== null && (removedAt === null || compareHlc(addedAt, removedAt) > 0)) {
      ids.push(id);
    }
  }
  ids.sort(compareText);
  return { elements, ids };
};

// ---------------------------------------------------------------------------------------------
// JSON map, per key
// ---------------------------------------------------------------------------------------------

/** One key of a JSON-map column. `deleted: true` is a key-level tombstone. */
export type MapEntry<V> = { value: V; clock: string | null; deleted?: boolean };

export type MapOverwrite<V> = { key: string; kept: MapEntry<V>; discarded: MapEntry<V> };

export type JsonMapMergeResult<V> = {
  map: Record<string, MapEntry<V>>;
  /**
   * Every key where the two sides held effectively different entries, with the discarded one. This
   * includes an ordinary later edit by a peer that had already seen the old value: clocks alone
   * cannot tell a concurrent write from a causally later one, so deciding whether the edits were
   * really concurrent (before logging to `sync_conflicts`) is the caller's job.
   */
  overwritten: Array<MapOverwrite<V>>;
};

const normalizeEntry = <V>(entry: MapEntry<V>): MapEntry<V> => {
  const normalized: MapEntry<V> = { value: entry.value, clock: entry.clock ?? null };
  if (entry.deleted === true) {
    normalized.deleted = true;
  }
  return normalized;
};

const entryShape = <V>(entry: MapEntry<V>) => ({
  value: entry.value,
  deleted: entry.deleted === true,
});

/** Whether two entries mean the same thing: both removed, or both live with equal values. */
const sameEffect = <V>(a: MapEntry<V>, b: MapEntry<V>): boolean => {
  const deletedA = a.deleted === true;
  const deletedB = b.deleted === true;
  return deletedA || deletedB ? deletedA === deletedB : jsonDeepEqual(a.value, b.value);
};

/**
 * Merges two JSON maps key by key: per key the later clock wins, tombstones included (a later
 * live write resurrects a removed key, a later removal beats an older write). Keys present on
 * one side only are kept as they are. Equal clocks with different entries are resolved by smaller
 * canonical JSON of `{ value, deleted }`. Associative, commutative, idempotent.
 */
export const mergeJsonMapPerKey = <V>(
  local: Record<string, MapEntry<V>>,
  remote: Record<string, MapEntry<V>>,
): JsonMapMergeResult<V> => {
  const map: Record<string, MapEntry<V>> = {};
  const overwritten: Array<MapOverwrite<V>> = [];
  for (const key of new Set([...Object.keys(local), ...Object.keys(remote)])) {
    const l = local[key];
    const r = remote[key];
    if (l === undefined || r === undefined) {
      map[key] = normalizeEntry((l ?? r) as MapEntry<V>);
      continue;
    }
    const a = normalizeEntry(l);
    const b = normalizeEntry(r);
    const byClock = compareMaybeClock(a.clock, b.clock);
    const aWins =
      byClock !== 0
        ? byClock > 0
        : compareText(canonicalJson(entryShape(a)), canonicalJson(entryShape(b))) <= 0;
    const [winning, discarded] = aWins ? [a, b] : [b, a];
    // Entries that are equal under JSON semantics but not identical (`undefined` vs `null`) must
    // merge to one representation whichever side is `a`.
    const kept =
      byClock === 0 && !Object.is(a.value, b.value) && sameEffect(a, b)
        ? { ...winning, value: jsonNormalize(winning.value) }
        : winning;
    map[key] = kept;
    if (!sameEffect(a, b)) {
      overwritten.push({ key, kept, discarded });
    }
  }
  overwritten.sort((x, y) => compareText(x.key, y.key));
  return { map, overwritten };
};

// ---------------------------------------------------------------------------------------------
// Tombstones
// ---------------------------------------------------------------------------------------------

export type TombstoneResult = {
  deleted: boolean;
  /** Clock of the winning delete, or `null` when the row is live. */
  deletedAt: string | null;
  /** Latest edit clock seen on either side; carry it forward so further merges stay associative. */
  rowClock: string | null;
};

/**
 * Edit wins over delete. `rowClock*` is the latest **edit** clock of each side (not counting the
 * delete itself) and `deletedAt*` the side's tombstone clock, `null` when live. The row stays
 * deleted only when the latest delete is strictly later than the latest edit: an edit made
 * causally after (or concurrently-later than) a delete resurrects the row; an edit with an equal
 * clock cannot exist for distinct devices and also keeps the row alive. Associative, commutative,
 * idempotent when the result's `rowClock`/`deletedAt` are fed back in.
 */
export const mergeTombstone = (
  rowClockLocal: MaybeClock,
  deletedAtLocal: MaybeClock,
  rowClockRemote: MaybeClock,
  deletedAtRemote: MaybeClock,
): TombstoneResult => {
  const rowClock = maxHlc(rowClockLocal, rowClockRemote);
  const latestDelete = maxHlc(deletedAtLocal, deletedAtRemote);
  const deleted =
    latestDelete !== null && (rowClock === null || compareHlc(latestDelete, rowClock) > 0);
  return { deleted, deletedAt: deleted ? latestDelete : null, rowClock };
};

// ---------------------------------------------------------------------------------------------
// Monotonic and one-time values
// ---------------------------------------------------------------------------------------------

/**
 * For dates that only move forward (`YYYY-MM-DD`, compared as strings, which is chronological for
 * that format). Missing (`null`, `undefined`, `""`) loses to any date; both missing gives `null`.
 * Associative, commutative, idempotent.
 */
export const mergeMonotonicMax = (
  a: string | null | undefined,
  b: string | null | undefined,
): string | null => {
  if (!isPresent(a)) {
    return isPresent(b) ? b : null;
  }
  if (!isPresent(b)) {
    return a;
  }
  return a >= b ? a : b;
};

/**
 * For one-time markers (e.g. `gtdImportDoneAt`): any non-empty value beats a missing one, and if
 * both are non-empty the lexicographically smaller wins (for ISO timestamps, the earlier
 * completion). Associative, commutative, idempotent.
 */
export const mergeNonEmptyWins = (
  a: string | null | undefined,
  b: string | null | undefined,
): string | null => {
  if (!isPresent(a)) {
    return isPresent(b) ? b : null;
  }
  if (!isPresent(b)) {
    return a;
  }
  return a <= b ? a : b;
};

// ---------------------------------------------------------------------------------------------
// Monotonic status
// ---------------------------------------------------------------------------------------------

export type StatusMergeResult = {
  status: string;
  /**
   * True when both sides are terminal with *different* statuses (e.g. `accepted` vs `dismissed`).
   * No rule picks the right one, so a deterministic answer (the smaller status string) is
   * returned and the caller decides whether to raise a conflict.
   */
  conflict: boolean;
};

/**
 * Generic "monotonic status" merge: a terminal status beats a non-terminal (pending) one. Two
 * different terminal statuses are a `conflict`; two different non-terminal statuses resolve to the
 * smaller string. Both fallbacks pick by string order, never by argument position. Associative,
 * commutative, idempotent.
 */
export const mergeTerminalBeatsPending = (
  localStatus: string,
  remoteStatus: string,
  terminalStatuses: readonly string[],
): StatusMergeResult => {
  const localTerminal = terminalStatuses.includes(localStatus);
  const remoteTerminal = terminalStatuses.includes(remoteStatus);
  if (localTerminal !== remoteTerminal) {
    return { status: localTerminal ? localStatus : remoteStatus, conflict: false };
  }
  return {
    status: localStatus <= remoteStatus ? localStatus : remoteStatus,
    conflict: localTerminal && localStatus !== remoteStatus,
  };
};
