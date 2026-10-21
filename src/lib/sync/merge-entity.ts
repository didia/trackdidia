import { hash128 } from "../finance/hash";
import type { FieldCodec, RawRow } from "./capture-decode";
import type { SyncEntity } from "./change-set";
import {
  asMap,
  canonicalJson,
  type FieldClocks,
  FieldClockShapeError,
  fieldClockKey,
  getOwn,
  jsonDeepEqual,
  type JsonRecord,
  mergeFieldClocks,
  rowHlc as maxFieldClock,
  setOwn,
  splitFieldClockKey,
} from "./field-clocks";
import { encodeHlc, maxHlc, parseHlc } from "./hlc";
import {
  type MapEntry,
  mergeJsonMapPerKey,
  mergeLww,
  mergeMonotonicMax,
  mergeNonEmptyWins,
  mergeOrSet,
  mergeTombstone,
  type OrSetElement,
  type OrSetElements,
} from "./merge-primitives";
import type { SettingRule } from "./registry";

/**
 * Pure merge of ONE field-clock entity, and of one synced setting. No SQL, no clock issuance: the
 * caller (`apply-bundle.ts`) feeds in what the database holds and writes what comes out.
 *
 * Everything is built from the slice-2 primitives, so the merge of two states is a join: merging the
 * same two states in either order, or re-merging a result with one of its inputs, gives the same
 * state. The one exception is a tombstone that is later resurrected (see the end of this comment).
 *
 * Rules, per column kind (kinds come from the registry through `fieldClockSpecFor`):
 * - scalar (including atomic `*_json` columns): last writer wins by field clock (`mergeLww`);
 * - JSON-map column: per key (`metrics_json.<key>`, `milestones_json.<id>`), a removed key is a
 *   clock without a value (`mergeJsonMapPerKey`). A map field is either ATOMIC (one bare clock
 *   `metrics_json`, written for a value that cannot be merged per key, or for a repaired one) or
 *   PER KEY (`metrics_json.<key>` clocks), never both. When the two sides disagree about the form,
 *   or either holds a bare clock, the field is merged as one scalar: the side with the newer field
 *   clock (a bare clock, or the newest key clock) wins the whole column and brings its own form of
 *   clocks along, the other side's clocks for that field are dropped. Not associative across three
 *   replicas that mix forms; only a corrupt map value gets there;
 * - OR-set column (`context_ids_json`): per element, add vs remove by clock (`mergeOrSet`). An
 *   element that is present but has no clock (a never-stamped row) is given {@link BASELINE_CLOCK}
 *   first, so it survives every merge except an explicit, clocked remove;
 * - whole entity: edit wins over delete (`mergeTombstone`). A later delete removes the row, a later
 *   edit resurrects it. Field clocks of a tombstone are kept so a delete can still be compared
 *   with an edit that arrives later.
 *
 * Known limit, documented rather than hidden: a tombstone carries no field VALUES, so the merge is
 * NOT a join across a tombstone that is later resurrected. When a delete and edits from two other
 * devices meet in different orders, the values of the side the tombstone swallowed cannot be
 * recovered, and the resurrected row holds the surviving side's values only. The loss is not silent:
 * when an entity is resurrected, every field the tombstone held a newer clock for is logged as an
 * overwritten edit whose local value is unknown. OPEN ITEM for a later slice: tombstones should
 * carry the last field values (in the change set and in the local meta), which would make the
 * resurrection a join as well.
 */

/**
 * The clock of a set element that was present before it was ever stamped. It sorts below every
 * real clock, so a clocked remote remove beats it and nothing else does.
 */
export const BASELINE_CLOCK = encodeHlc(0, 0, "baseline");

/**
 * Fields that are bookkeeping, not user edits. A difference in them is never worth a conflict row:
 * `updated_at` moves on every save (slice-5 decision) and `created_at` differs whenever two devices
 * independently create the same deterministic id.
 */
const BOOKKEEPING_FIELDS: ReadonlySet<string> = new Set(["created_at", "updated_at"]);

export interface LocalEntityState {
  /** The stored row, or `null` when the entity has no row here. */
  row: RawRow | null;
  /** Its `sync_entity_meta` row, or `null` when it never had one. */
  meta: { fieldClocks: FieldClocks; rowHlc: string; deletedAt: string | null } | null;
}

export interface MergeEntityInput {
  codec: FieldCodec;
  /** Every local column of the table (key columns included). */
  columns: readonly string[];
  primaryKey: readonly string[];
  notNullColumns: ReadonlySet<string>;
  local: LocalEntityState;
  remote: SyncEntity;
}

export type RowAction = "none" | "insert" | "update" | "delete";

/** One side of an overwritten value. `deleted` marks a removed map key. */
export interface ConflictSide {
  value?: unknown;
  deleted?: true;
  /** The value is gone: only its clock survives (a tombstone keeps clocks, not values). */
  unknown?: true;
  clock: string | null;
}

/** A local value that a remote value replaced and that the sender may not have seen. */
export interface OverwrittenField {
  /** Clock key: `title`, `metrics_json.steps`. */
  field: string;
  local: ConflictSide;
  remote: ConflictSide;
}

export interface EntityMeta {
  fieldClocks: FieldClocks;
  rowHlc: string;
  deletedAt: string | null;
}

export interface EntityMergeOutcome {
  rowAction: RowAction;
  /**
   * Raw column values to write: every provided column for an insert (key columns included), only
   * the changed ones for an update, none otherwise.
   */
  columns: Record<string, unknown>;
  meta: EntityMeta;
  /** The stored meta row must be (re)written. */
  metaChanged: boolean;
  /** A tombstone removed a local row, or was recorded or advanced in the meta. */
  tombstoneApplied: boolean;
  overwritten: OverwrittenField[];
}

type Json = Record<string, unknown>;

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const clockAt = (clocks: FieldClocks, key: string): string | null => getOwn(clocks, key) ?? null;

const knownClocks = (clocks: FieldClocks, fields: ReadonlySet<string>): FieldClocks => {
  const kept: FieldClocks = {};
  for (const key of Object.keys(clocks)) {
    if (fields.has(splitFieldClockKey(key).field)) {
      setOwn(kept, key, clocks[key] as string);
    }
  }
  return kept;
};

const editClock = (clocks: FieldClocks, rowClock: string | null, live: boolean): string | null =>
  maxFieldClock(clocks) ?? (live ? rowClock : null);

const sameMeta = (a: EntityMeta | null, b: EntityMeta): boolean =>
  a !== null &&
  a.rowHlc === b.rowHlc &&
  a.deletedAt === b.deletedAt &&
  canonicalJson(a.fieldClocks) === canonicalJson(b.fieldClocks);

/**
 * Whether the SENDER had provably seen `clock`: it carries a clock of the same author that is at
 * least as late. Clocks of one device only grow and an entity travels whole, so such a clock proves
 * the sender received that device's state at or after `clock` was issued. The converse is not true
 * (a sender that overwrote every field of the entity left no evidence), so "not seen" means "may
 * have been concurrent". This is what separates an ordinary later edit from a lost one without any
 * extra field in the change set.
 */
const senderHasSeen = (clock: string | null, senderClocks: Record<string, string>): boolean => {
  if (clock === null) {
    return false;
  }
  const author = parseHlc(clock)?.deviceId;
  if (author === undefined) {
    return false;
  }
  return Object.keys(senderClocks).some((key) => {
    const other = getOwn(senderClocks, key);
    return other !== undefined && parseHlc(other)?.deviceId === author && other >= clock;
  });
};

const sideOf = (entry: MapEntry<unknown>): ConflictSide =>
  entry.deleted === true
    ? { deleted: true, clock: entry.clock }
    : { value: entry.value, clock: entry.clock };

const sameEntry = (a: MapEntry<unknown>, b: MapEntry<unknown>): boolean =>
  a.clock === b.clock &&
  (a.deleted === true) === (b.deleted === true) &&
  jsonDeepEqual(a.value, b.value);

const stringIds = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];

const sortedUnique = (ids: readonly string[]): string[] => [...new Set(ids)].sort();

/** The newest clock of a field in any form: its bare clock or any `field.<key>` clock. */
const fieldClockMax = (clocks: FieldClocks, field: string): string | null => {
  let max = clockAt(clocks, field);
  for (const key of Object.keys(clocks)) {
    const split = splitFieldClockKey(key);
    if (split.field === field && split.key !== null) {
      max = maxHlc(max, clocks[key]);
    }
  }
  return max;
};

/** Every clock of one field (bare and per key). */
const clocksOfField = (clocks: FieldClocks, field: string): FieldClocks => {
  const subset: FieldClocks = {};
  for (const key of Object.keys(clocks)) {
    if (splitFieldClockKey(key).field === field) {
      setOwn(subset, key, clocks[key] as string);
    }
  }
  return subset;
};

const hasBareClock = (clocks: FieldClocks, field: string): boolean =>
  clockAt(clocks, field) !== null;

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Picks the side whose clocks of a map field win a form disagreement: the newer field clock, ties
 * by the smaller canonical clock text, so the answer never depends on argument order. `null` when
 * both sides hold exactly the same clocks (the values then decide).
 */
const newerForm = (
  local: FieldClocks,
  remote: FieldClocks,
  field: string,
): "local" | "remote" | null => {
  const l = fieldClockMax(local, field);
  const r = fieldClockMax(remote, field);
  if (l !== r) {
    if (l === null) return "remote";
    if (r === null) return "local";
    return l > r ? "local" : "remote";
  }
  const byText = compareText(
    canonicalJson(clocksOfField(local, field)),
    canonicalJson(clocksOfField(remote, field)),
  );
  return byText === 0 ? null : byText < 0 ? "local" : "remote";
};

/**
 * Per-key maximum of two clock maps (`mergeFieldClocks`), except that a map field one side holds
 * as a bare clock and the other per key (or both mixed) keeps only the newer form's clocks, so the
 * result never mixes forms. Used for the clocks a tombstone keeps.
 */
const mergeClocksByForm = (
  local: FieldClocks,
  remote: FieldClocks,
  mapFields: readonly string[],
): FieldClocks => {
  const mixed = mapFields.filter((field) => {
    const l = clocksOfField(local, field);
    const r = clocksOfField(remote, field);
    const anyBare = hasBareClock(l, field) || hasBareClock(r, field);
    const anyKeyed =
      Object.keys(l).length + Object.keys(r).length >
      (hasBareClock(l, field) ? 1 : 0) + (hasBareClock(r, field) ? 1 : 0);
    return anyBare && anyKeyed;
  });
  if (mixed.length === 0) return mergeFieldClocks(local, remote);
  const trim = (clocks: FieldClocks, side: "local" | "remote"): FieldClocks => {
    const result = { ...clocks };
    for (const field of mixed) {
      if ((newerForm(local, remote, field) ?? side) !== side) {
        for (const key of Object.keys(clocksOfField(clocks, field))) delete result[key];
      }
    }
    return result;
  };
  return mergeFieldClocks(trim(local, "local"), trim(remote, "remote"));
};

// ---------------------------------------------------------------------------------------------
// JSON-map columns
// ---------------------------------------------------------------------------------------------

/**
 * Map entries of one side: live keys with their clocks, plus clock-only keys as removals. `null`
 * when the column's JSON has a shape that cannot be merged per key (it is then one atomic field).
 */
const mapEntriesOf = (
  value: unknown,
  field: string,
  clocks: FieldClocks,
): Record<string, MapEntry<unknown>> | null => {
  let live: Record<string, unknown>;
  try {
    live = asMap(value, field);
  } catch (error) {
    if (error instanceof FieldClockShapeError) {
      return null;
    }
    throw error;
  }
  const entries: Record<string, MapEntry<unknown>> = {};
  for (const key of Object.keys(live)) {
    setOwn(entries, key, {
      value: getOwn(live, key),
      clock: clockAt(clocks, fieldClockKey(field, key)),
    });
  }
  for (const clockKey of Object.keys(clocks)) {
    const split = splitFieldClockKey(clockKey);
    if (split.field === field && split.key !== null && !Object.hasOwn(entries, split.key)) {
      setOwn(entries, split.key, { value: null, clock: clocks[clockKey] as string, deleted: true });
    }
  }
  return entries;
};

const compareMapItems = (a: unknown, b: unknown): number => {
  const rank = (item: unknown): number => {
    const order = (item as Json | null)?.sortOrder;
    return typeof order === "number" && Number.isFinite(order) ? order : Number.POSITIVE_INFINITY;
  };
  const byOrder = rank(a) === rank(b) ? 0 : rank(a) < rank(b) ? -1 : 1;
  if (byOrder !== 0) {
    return byOrder;
  }
  const idA = String(getOwn(a as Json, "id"));
  const idB = String(getOwn(b as Json, "id"));
  return idA < idB ? -1 : idA > idB ? 1 : 0;
};

/**
 * Serializes the live keys of a map column the way the repository does (compact JSON text:
 * `JSON.stringify` of an object, or of an array of `{ id, ... }` items), with two determinism
 * additions: object keys are sorted, and an array is ordered by the items' own `sortOrder` then id
 * (array position is not merged; see `asMap`). Two replicas that merged the same keys therefore
 * store the same text.
 */
const serializeMapColumn = (
  live: Record<string, unknown>,
  asArray: boolean,
  writeNull: boolean,
): string | null => {
  if (writeNull) {
    return null;
  }
  if (asArray) {
    return canonicalJson(
      Object.keys(live)
        .map((key) => getOwn(live, key))
        .sort(compareMapItems),
    );
  }
  return canonicalJson(live);
};

// ---------------------------------------------------------------------------------------------
// Whole-entity merge
// ---------------------------------------------------------------------------------------------

/** The values an insert writes: every column the sender provided that this table has. */
const insertColumns = (input: MergeEntityInput): Record<string, unknown> => {
  const { codec, columns, remote, notNullColumns } = input;
  const row = remote.row as Json;
  const decoded = codec.decode(row as RawRow);
  const maps = new Set(codec.spec.maps);
  const sets = new Set(codec.spec.sets);
  const out: Record<string, unknown> = {};
  for (const column of columns) {
    if (!Object.hasOwn(row, column)) {
      continue;
    }
    if (sets.has(column)) {
      setOwn(out, column, canonicalJson(sortedUnique(stringIds(decoded[column]))));
    } else if (maps.has(column)) {
      const entries = mapEntriesOf(decoded[column], column, {});
      if (entries === null) {
        setOwn(out, column, getOwn(row, column));
      } else {
        const live: Record<string, unknown> = {};
        for (const key of Object.keys(entries)) {
          setOwn(live, key, (getOwn(entries, key) as MapEntry<unknown>).value);
        }
        const empty = Object.keys(live).length === 0;
        setOwn(
          out,
          column,
          serializeMapColumn(
            live,
            Array.isArray(decoded[column]),
            empty && decoded[column] === null && !notNullColumns.has(column),
          ),
        );
      }
    } else {
      setOwn(out, column, getOwn(row, column));
    }
  }
  return out;
};

/**
 * Removal clocks for the memberships a tombstone knew about and a surviving row left out.
 *
 * When an edit later than a delete keeps (or brings back) an entity, the survivor's clocks replace
 * the tombstone's retained ones. A map key or OR-set id that the tombstone held and the survivor's
 * value does not, with no clock of its own on the survivor, would then look like "never heard of
 * it", and an older replica that still holds it would add it back unopposed (a missing clock is
 * not a removal). So each such key gets a removal clock: the tombstone's `deletedAt` (or, for a
 * tombstone without one, the key's own retained clock), or the survivor's existing clock for the
 * key if that is later. The delete is exactly what removed the key, `deletedAt` is later than every
 * clock the tombstone retained (it only wins over clocks that are earlier), and an add made after
 * the delete, by anyone, still beats it. The value comes only from the tombstone and the survivor,
 * never from local issuance, and is the same whichever of the two reached this device first.
 *
 * Not invented: keys the tombstone never had; keys the survivor holds; any key of an atomic field
 * (a bare clock on either side, or a value that cannot be merged per key) which has no per-key
 * removals to speak of; live-live merges (this runs for a resurrection, or for a live row meeting
 * an older tombstone, never for two live entities).
 */
const omittedKeyRemovals = (
  codec: FieldCodec,
  survivorRecord: JsonRecord,
  survivorClocks: FieldClocks,
  tombstoneClocks: FieldClocks,
  deletedAt: string | null,
): FieldClocks => {
  const added: FieldClocks = {};
  const fields = [...(codec.spec.maps ?? []), ...(codec.spec.sets ?? [])];
  const maps = new Set(codec.spec.maps);
  for (const field of fields) {
    if (hasBareClock(survivorClocks, field) || hasBareClock(tombstoneClocks, field)) continue;
    let held: Set<string>;
    if (maps.has(field)) {
      const entries = mapEntriesOf(survivorRecord[field], field, {});
      if (entries === null) continue;
      held = new Set(Object.keys(entries));
    } else {
      held = new Set(stringIds(survivorRecord[field]));
    }
    for (const key of Object.keys(tombstoneClocks)) {
      const split = splitFieldClockKey(key);
      if (split.field !== field || split.key === null || held.has(split.key)) continue;
      const removal = maxHlc(
        clockAt(survivorClocks, key),
        deletedAt ?? clockAt(tombstoneClocks, key),
      );
      if (removal !== null && removal !== clockAt(survivorClocks, key)) setOwn(added, key, removal);
    }
  }
  return added;
};

/**
 * A resurrection replaces the tombstone's retained clocks with the incoming entity's. A retained
 * clock NEWER than the incoming one for the same field, key or element is an edit the tombstone
 * swallowed and the resurrected row does not hold (the tombstone has no value to give back). Each
 * one is reported as an overwritten edit whose local value is unknown, so the loss is logged.
 */
const resurrectionLosses = (
  input: MergeEntityInput,
  remoteClocks: FieldClocks,
): OverwrittenField[] => {
  const { codec, local, remote } = input;
  const localClocks = local.meta?.fieldClocks ?? {};
  const remoteRow = remote.row as Json;
  const remoteRecord = codec.decode(remoteRow as RawRow);
  const spec = codec.spec;
  const maps = new Set(spec.maps);
  const sets = new Set(spec.sets);
  const losses: OverwrittenField[] = [];
  for (const key of Object.keys(localClocks).sort()) {
    const { field, key: nested } = splitFieldClockKey(key);
    const localClock = localClocks[key] as string;
    const remoteClock = clockAt(remoteClocks, key);
    if (
      BOOKKEEPING_FIELDS.has(field) ||
      !Object.hasOwn(remoteRow, field) ||
      (remoteClock !== null && localClock <= remoteClock)
    ) {
      continue;
    }
    let remoteSide: ConflictSide;
    if (nested === null) {
      remoteSide = { value: remoteRecord[field], clock: remoteClock };
    } else if (sets.has(field)) {
      remoteSide = stringIds(remoteRecord[field]).includes(nested)
        ? { value: nested, clock: remoteClock }
        : { deleted: true, clock: remoteClock };
    } else if (maps.has(field)) {
      const entries = mapEntriesOf(remoteRecord[field], field, {});
      const entry = entries === null ? undefined : getOwn(entries, nested);
      remoteSide = entry
        ? { value: entry.value, clock: remoteClock }
        : { deleted: true, clock: remoteClock };
    } else {
      continue;
    }
    losses.push({ field: key, local: { unknown: true, clock: localClock }, remote: remoteSide });
  }
  return losses;
};

/**
 * Merges the remote entity into the local state. See the module comment for the rules; the result
 * says which row operation to perform, which columns to write and what the meta row becomes.
 */
export const mergeFieldClockEntity = (input: MergeEntityInput): EntityMergeOutcome => {
  const { codec, local, remote } = input;
  const spec = codec.spec;
  const scalars = spec.scalars ?? [];
  const maps = spec.maps ?? [];
  const sets = spec.sets ?? [];
  const fieldNames = new Set([...scalars, ...maps, ...sets]);

  const remoteClocks = knownClocks(remote.fieldClocks, fieldNames);
  const localClocks = local.meta?.fieldClocks ?? {};
  const localHasRow = local.row !== null;
  const localDeletedAt = local.meta?.deletedAt ?? null;

  const tombstone = mergeTombstone(
    editClock(localClocks, local.meta?.rowHlc ?? null, localDeletedAt === null),
    localDeletedAt,
    editClock(remoteClocks, remote.rowHlc, remote.deletedAt === null),
    remote.deletedAt,
  );

  // --- The latest delete beats every edit: the row goes, the tombstone and clocks stay. --------
  if (tombstone.deleted) {
    const deletedAt = tombstone.deletedAt as string;
    const meta: EntityMeta = {
      fieldClocks: mergeClocksByForm(localClocks, remoteClocks, maps),
      rowHlc: deletedAt,
      deletedAt,
    };
    const metaChanged = !sameMeta(local.meta, meta);
    return {
      rowAction: localHasRow ? "delete" : "none",
      columns: {},
      meta,
      metaChanged,
      tombstoneApplied: localHasRow || metaChanged,
      overwritten: [],
    };
  }

  // --- The entity is live from here on. ---------------------------------------------------------
  if (remote.row === null) {
    // A tombstone older than a local edit: the local row stands. The edit still survives the
    // delete, so the memberships the tombstone knew and the row left out get their removals,
    // exactly as if the tombstone had been here first (see `omittedKeyRemovals`).
    const removals =
      localHasRow && local.meta !== null
        ? omittedKeyRemovals(
            codec,
            codec.decode(local.row as RawRow),
            local.meta.fieldClocks,
            remoteClocks,
            remote.deletedAt,
          )
        : {};
    const meta: EntityMeta = local.meta
      ? { ...local.meta, fieldClocks: { ...local.meta.fieldClocks, ...removals } }
      : { fieldClocks: {}, rowHlc: remote.rowHlc, deletedAt: null };
    return {
      rowAction: "none",
      columns: {},
      meta,
      metaChanged: Object.keys(removals).length > 0,
      tombstoneApplied: false,
      overwritten: [],
    };
  }

  if (!localHasRow) {
    // New entity, or a resurrection: the remote values and clocks are the whole truth.
    const rowHlc = maxFieldClock(remoteClocks) ?? remote.rowHlc;
    // A resurrection (local tombstone, no row) also dates a removal for every membership the
    // tombstone knew and the incoming row omits; a brand-new entity has no tombstone to consult.
    const removals =
      local.meta !== null && local.meta.deletedAt !== null
        ? omittedKeyRemovals(
            codec,
            codec.decode(remote.row as RawRow),
            remoteClocks,
            local.meta.fieldClocks,
            local.meta.deletedAt,
          )
        : {};
    const meta: EntityMeta = {
      fieldClocks: { ...remoteClocks, ...removals },
      rowHlc,
      deletedAt: null,
    };
    return {
      rowAction: "insert",
      columns: insertColumns(input),
      meta,
      metaChanged: true,
      tombstoneApplied: false,
      overwritten: resurrectionLosses(input, remoteClocks),
    };
  }

  const localRecord = codec.decode(local.row as RawRow);
  const remoteRow = remote.row as Json;
  const remoteRecord = codec.decode(remoteRow as RawRow);
  const has = (column: string): boolean => Object.hasOwn(remoteRow, column);

  const columnsOut: Record<string, unknown> = {};
  const clocksOut: FieldClocks = {};
  const overwritten: OverwrittenField[] = [];

  const noteScalar = (
    field: string,
    localValue: unknown,
    localClock: string | null,
    remoteValue: unknown,
    remoteClock: string | null,
    won: "local" | "remote" | "equal",
  ): void => {
    if (
      won === "remote" &&
      !BOOKKEEPING_FIELDS.has(field) &&
      !jsonDeepEqual(localValue, remoteValue) &&
      !senderHasSeen(localClock, remote.fieldClocks)
    ) {
      overwritten.push({
        field,
        local: { value: localValue, clock: localClock },
        remote: { value: remoteValue, clock: remoteClock },
      });
    }
  };

  /**
   * Whole-column last-writer-wins. `chosen` normally follows the clocks (`equal` means the local
   * side); `forced` lets the caller break a tie between equal-looking states by something else.
   * The chosen side's stored text is what both replicas end up holding, so replicas that saw the
   * same writes in a different order store the same bytes even for values that are JSON-equal.
   */
  const lwwColumn = (
    column: string,
    localClock: string | null,
    remoteClock: string | null,
    forced?: "local" | "remote",
  ): { chosen: "local" | "remote"; clock: string | null } => {
    const result = mergeLww(localRecord[column], localClock, remoteRecord[column], remoteClock);
    const chosen = forced ?? (result.winner === "remote" ? "remote" : "local");
    if (chosen === "remote" && getOwn(remoteRow, column) !== (local.row as Json)[column]) {
      setOwn(columnsOut, column, getOwn(remoteRow, column));
    }
    noteScalar(column, localRecord[column], localClock, remoteRecord[column], remoteClock, chosen);
    return { chosen, clock: chosen === "remote" ? remoteClock : localClock };
  };

  for (const column of scalars) {
    if (!has(column)) {
      const kept = clockAt(localClocks, column);
      if (kept !== null) setOwn(clocksOut, column, kept);
      continue;
    }
    const { clock } = lwwColumn(
      column,
      clockAt(localClocks, column),
      clockAt(remoteClocks, column),
    );
    if (clock !== null) setOwn(clocksOut, column, clock);
  }

  for (const column of maps) {
    if (!has(column)) {
      for (const key of Object.keys(localClocks)) {
        if (splitFieldClockKey(key).field === column)
          setOwn(clocksOut, key, localClocks[key] as string);
      }
      continue;
    }
    const localEntries = mapEntriesOf(localRecord[column], column, localClocks);
    const remoteEntries = mapEntriesOf(remoteRecord[column], column, remoteClocks);
    if (
      localEntries === null ||
      remoteEntries === null ||
      hasBareClock(localClocks, column) ||
      hasBareClock(remoteClocks, column)
    ) {
      // An atomic field (a value that cannot be merged per key, or a repaired one), or sides that
      // disagree about the form: one scalar, the newer form wins the whole column and its clocks.
      const localField = clocksOfField(localClocks, column);
      const remoteField = clocksOfField(remoteClocks, column);
      const { chosen } = lwwColumn(
        column,
        fieldClockMax(localClocks, column),
        fieldClockMax(remoteClocks, column),
        newerForm(localClocks, remoteClocks, column) ?? undefined,
      );
      const winning = chosen === "remote" ? remoteField : localField;
      for (const key of Object.keys(winning)) setOwn(clocksOut, key, winning[key] as string);
      continue;
    }
    const merged = mergeJsonMapPerKey(localEntries, remoteEntries);
    const live: Record<string, unknown> = {};
    for (const key of Object.keys(merged.map)) {
      const entry = getOwn(merged.map, key) as MapEntry<unknown>;
      if (entry.clock !== null) setOwn(clocksOut, fieldClockKey(column, key), entry.clock);
      if (entry.deleted !== true) setOwn(live, key, entry.value);
    }
    const localLive: Record<string, unknown> = {};
    for (const key of Object.keys(localEntries)) {
      const entry = getOwn(localEntries, key) as MapEntry<unknown>;
      if (entry.deleted !== true) setOwn(localLive, key, entry.value);
    }
    if (!jsonDeepEqual(live, localLive)) {
      const empty = Object.keys(live).length === 0;
      setOwn(
        columnsOut,
        column,
        serializeMapColumn(
          live,
          Array.isArray(localRecord[column]) || Array.isArray(remoteRecord[column]),
          empty &&
            localRecord[column] === null &&
            remoteRecord[column] === null &&
            !input.notNullColumns.has(column),
        ),
      );
    }
    for (const item of merged.overwritten) {
      const l = getOwn(localEntries, item.key);
      const r = getOwn(remoteEntries, item.key);
      if (
        l !== undefined &&
        r !== undefined &&
        sameEntry(item.kept, r) &&
        !sameEntry(item.kept, l) &&
        !senderHasSeen(l.clock, remote.fieldClocks)
      ) {
        overwritten.push({
          field: fieldClockKey(column, item.key),
          local: sideOf(l),
          remote: sideOf(r),
        });
      }
    }
  }

  for (const column of sets) {
    if (!has(column)) {
      for (const key of Object.keys(localClocks)) {
        if (splitFieldClockKey(key).field === column)
          setOwn(clocksOut, key, localClocks[key] as string);
      }
      continue;
    }
    const localIds = stringIds(localRecord[column]);
    const merged = mergeOrSet(
      setElementsOf(localIds, column, localClocks),
      setElementsOf(stringIds(remoteRecord[column]), column, remoteClocks),
    );
    for (const id of Object.keys(merged.elements)) {
      const element = getOwn(merged.elements, id) as { addedAt?: string; removedAt?: string };
      const clock = maxHlc(element.addedAt, element.removedAt);
      if (clock !== null) setOwn(clocksOut, fieldClockKey(column, id), clock);
    }
    if (canonicalJson(sortedUnique(localIds)) !== canonicalJson(merged.ids)) {
      setOwn(columnsOut, column, canonicalJson(merged.ids));
    }
  }

  const rowHlc = maxFieldClock(clocksOut) ?? local.meta?.rowHlc ?? remote.rowHlc;
  const meta: EntityMeta = { fieldClocks: clocksOut, rowHlc, deletedAt: null };
  return {
    rowAction: Object.keys(columnsOut).length > 0 ? "update" : "none",
    columns: columnsOut,
    meta,
    metaChanged: !sameMeta(local.meta, meta),
    tombstoneApplied: false,
    overwritten,
  };
};

/** Per-element add / remove clocks of an id list. See {@link BASELINE_CLOCK}. */
const setElementsOf = (
  ids: readonly string[],
  field: string,
  clocks: FieldClocks,
): OrSetElements => {
  const elements: OrSetElements = {};
  const present = new Set(ids);
  for (const id of present) {
    setOwn<OrSetElement>(elements, id, {
      addedAt: clockAt(clocks, fieldClockKey(field, id)) ?? BASELINE_CLOCK,
    });
  }
  for (const clockKey of Object.keys(clocks)) {
    const split = splitFieldClockKey(clockKey);
    if (split.field === field && split.key !== null && !present.has(split.key)) {
      setOwn<OrSetElement>(elements, split.key, { removedAt: clocks[clockKey] as string });
    }
  }
  return elements;
};

// ---------------------------------------------------------------------------------------------
// Conflict rows
// ---------------------------------------------------------------------------------------------

/**
 * Deterministic id of an overwritten-edit conflict: the same overwrite found again (the bundle is
 * applied twice, or a peer republishes) maps to the same row and is never logged twice.
 */
export const overwrittenConflictId = (
  table: string,
  entityId: string,
  field: string,
  localClock: string | null,
  remoteClock: string | null,
): string =>
  `overwritten:${hash128(JSON.stringify([table, entityId, field, localClock, remoteClock]))}`;

// ---------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------

export interface SettingSide {
  value: unknown;
  /** `null` when the key was never stamped on this device. */
  clock: string | null;
}

export interface SettingMergeResult {
  value: unknown;
  clock: string | null;
  valueChanged: boolean;
  clockChanged: boolean;
}

const isTextOrNull = (value: unknown): value is string | null | undefined =>
  value === null || value === undefined || typeof value === "string";

/**
 * Per-key merge by the settings registry rule: `lww` by clock; `monotonic-max` (dates that only
 * move forward) and `non-empty-wins` (one-time markers) by value, with the key clock moving to the
 * later of the two so replicas also agree on the clock. Throws `TypeError` when a value-merged key
 * does not hold text.
 */
export const mergeSettingEntry = (
  rule: Exclude<SettingRule, { merge: "device" }>,
  local: SettingSide,
  remote: { value: unknown; rowHlc: string },
): SettingMergeResult => {
  let value: unknown;
  let clock: string | null;
  if (rule.merge === "lww") {
    const result = mergeLww(local.value, local.clock, remote.value, remote.rowHlc);
    value = result.value;
    clock = result.clock;
  } else {
    if (!isTextOrNull(local.value) || !isTextOrNull(remote.value)) {
      throw new TypeError(`A "${rule.merge}" setting must hold text or null`);
    }
    const merged =
      rule.merge === "monotonic-max"
        ? mergeMonotonicMax(local.value, remote.value)
        : mergeNonEmptyWins(local.value, remote.value);
    // Both missing: keep the local representation ("" or null) instead of normalizing it.
    value = merged === null ? local.value : merged;
    clock = maxHlc(local.clock, remote.rowHlc);
  }
  return {
    value,
    clock,
    valueChanged: !jsonDeepEqual(local.value, value),
    clockChanged: clock !== local.clock,
  };
};
