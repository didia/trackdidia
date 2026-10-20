import { assertHlc, maxHlc, maxHlcOf } from "./hlc";

/**
 * Per-field clock bookkeeping for the "field-clock" merge class. Pure and generic over plain JSON
 * records; the per-table registry (a later slice) supplies the {@link FieldClockSpec}.
 *
 * Clock keys:
 * - scalar field: `title`
 * - key of a JSON-map column: `metrics.<key>`, `milestones.<id>`
 * - element of an id-list (OR-set): `contextIds.<id>`
 *
 * Field names never contain `.`; map keys and element ids may, because only the part before the
 * first `.` is the field name.
 *
 * OR-set note: a per-element clock records the *latest membership event* of that element. Whether
 * that event was an add or a remove is read off the value (element present in the id-list = the
 * latest event was an add; absent but clocked = a remove). That is equivalent to the
 * `{ addedAt, removedAt }` pair used by `mergeOrSet`, because only the later of the two events
 * ever matters. The same applies to a removed map key: a clock without a value is a key tombstone.
 */
export type FieldClocks = Record<string, string>;

/** Which fields of a record take part in sync and how each one merges. Unlisted fields are ignored. */
export type FieldClockSpec = {
  /** Plain fields compared by deep equality and stamped as a whole. */
  scalars?: readonly string[];
  /**
   * JSON columns merged per key: an object `{ [key]: value }`, or an array of objects with a
   * string `id` (indexed by id, e.g. milestones). Any other shape throws `FieldClockShapeError`.
   */
  maps?: readonly string[];
  /** Id-list columns treated as OR-sets: `string[]`. */
  sets?: readonly string[];
};

export type FieldClockOptions = FieldClockSpec & {
  /** The clocks currently stored for this row. Defaults to none. */
  clocks?: FieldClocks;
};

export type JsonRecord = Record<string, unknown>;

export const fieldClockKey = (field: string, key: string): string => `${field}.${key}`;

/** Splits a clock key into its field and (for map/set entries) the nested key. */
export const splitFieldClockKey = (clockKey: string): { field: string; key: string | null } => {
  const dot = clockKey.indexOf(".");
  return dot < 0
    ? { field: clockKey, key: null }
    : { field: clockKey.slice(0, dot), key: clockKey.slice(dot + 1) };
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Own-property access for keyed maps. Keys come from synced JSON, so they may be `__proto__`,
 * `constructor`, `toString`...: reading `map[key]` for an absent key would return an inherited
 * value, and assigning `map["__proto__"] = x` would hit the prototype setter and silently drop
 * the key. Every read and write of a keyed map in the sync core goes through these two helpers.
 */
export const getOwn = <T>(map: Record<string, T>, key: string): T | undefined =>
  Object.hasOwn(map, key) ? map[key] : undefined;

/** Defines `key` as an own, enumerable data property (works for `__proto__`). Returns `map`. */
export const setOwn = <T>(map: Record<string, T>, key: string, value: T): Record<string, T> => {
  Object.defineProperty(map, key, { value, enumerable: true, writable: true, configurable: true });
  return map;
};

/**
 * Deep equality with JSON semantics, kept in lockstep with {@link canonicalJson} (two values are
 * equal here iff their canonical JSON text is identical): object key order is irrelevant,
 * `undefined` object properties count as absent, a top-level or array-item `undefined` equals
 * `null` (it serializes to `null`), array order matters.
 */
export const jsonDeepEqual = (left: unknown, right: unknown): boolean => {
  const a = left === undefined ? null : left;
  const b = right === undefined ? null : right;
  if (a === b) {
    return true;
  }
  if (Array.isArray(a)) {
    return (
      Array.isArray(b) && a.length === b.length && a.every((item, i) => jsonDeepEqual(item, b[i]))
    );
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a).filter((key) => getOwn(a, key) !== undefined);
    const keysB = Object.keys(b).filter((key) => getOwn(b, key) !== undefined);
    return (
      keysA.length === keysB.length &&
      keysA.every(
        (key) => getOwn(b, key) !== undefined && jsonDeepEqual(getOwn(a, key), getOwn(b, key)),
      )
    );
  }
  return false;
};

/** Canonical JSON text: object keys sorted, `undefined` properties dropped. Used for tie-breaks. */
export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  }
  if (isPlainObject(value)) {
    const entries = Object.keys(value)
      .filter((key) => getOwn(value, key) !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(getOwn(value, key))}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
};

/**
 * The canonical JSON form of a value (`undefined` becomes `null`, object keys sorted, `undefined`
 * properties dropped). Merges use it to return one deterministic representation when two sides
 * hold values that are equal under {@link jsonDeepEqual} but not identical, e.g. `undefined`
 * versus `null`, which keeps them commutative.
 */
export const jsonNormalize = <T>(value: T): T => JSON.parse(canonicalJson(value)) as T;

/** A map-field value that is neither null/undefined, an object, nor an array of `{ id }` items. */
export class FieldClockShapeError extends Error {
  readonly field: string;
  readonly reason: string;
  constructor(field: string, reason: string) {
    super(`field_clock_map_invalid: ${field}: ${reason}`);
    this.name = "FieldClockShapeError";
    this.field = field;
    this.reason = reason;
  }
}

/**
 * Reads a map-class field as `{ key: value }` without ever coercing a bad shape to `{}`:
 * - `null`/`undefined` is an empty map;
 * - a plain object is copied (own properties, `undefined` values dropped);
 * - an array of objects that each carry a string `id` (e.g. `milestones_json`) is indexed by that
 *   id, the whole item being the value. Array order is deliberately not part of the result: order
 *   travels in the items' own fields (`sortOrder`). Duplicate ids throw;
 * - anything else throws {@link FieldClockShapeError}.
 */
export const asMap = (value: unknown, field: string): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  if (value === null || value === undefined) {
    return result;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!isPlainObject(item) || typeof getOwn(item, "id") !== "string") {
        throw new FieldClockShapeError(field, "array items must be objects with a string id");
      }
      const id = getOwn(item, "id") as string;
      if (Object.hasOwn(result, id)) {
        throw new FieldClockShapeError(field, `duplicate id "${id}"`);
      }
      setOwn(result, id, item);
    }
    return result;
  }
  if (!isPlainObject(value)) {
    throw new FieldClockShapeError(field, `expected an object or an array, got ${typeof value}`);
  }
  for (const key of Object.keys(value)) {
    const entry = getOwn(value, key);
    if (entry !== undefined) {
      setOwn(result, key, entry);
    }
  }
  return result;
};

const asSet = (value: unknown): Set<string> =>
  new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : []);

/**
 * Computes the clocks after a write of `next` over `previous`, stamping `hlc` on exactly the
 * fields that changed:
 *
 * - scalar: stamped when the value changed (deep equality, `undefined` == `null`);
 * - map: every key that was added, changed or removed gets `field.key` stamped (a removal leaves
 *   a clock without a value, i.e. a key tombstone);
 * - set: every element added or removed gets `field.id` stamped; reordering is not a change.
 *
 * With `previous === null` (creation) every listed scalar and every present map key / set element
 * is stamped. When nothing changed, the `options.clocks` object is returned **as is** (same
 * reference), so an idle write can be detected with `result === clocks` and does not dirty sync
 * state. Otherwise a new object is returned; the input is never mutated.
 */
export const buildFieldClockUpdates = (
  previous: JsonRecord | null,
  next: JsonRecord,
  hlc: string,
  options: FieldClockOptions = {},
): FieldClocks => {
  assertHlc(hlc);
  const existing = options.clocks ?? {};
  const stamps: string[] = [];
  const creating = previous === null;

  for (const field of options.scalars ?? []) {
    const before = creating ? undefined : (getOwn(previous, field) ?? null);
    const after = getOwn(next, field) ?? null;
    if (creating || !jsonDeepEqual(before, after)) {
      stamps.push(field);
    }
  }

  for (const field of options.maps ?? []) {
    const before = creating ? {} : asMap(getOwn(previous, field), field);
    const after = asMap(getOwn(next, field), field);
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const had = Object.hasOwn(before, key);
      const has = Object.hasOwn(after, key);
      if (had !== has || (has && !jsonDeepEqual(getOwn(before, key), getOwn(after, key)))) {
        stamps.push(fieldClockKey(field, key));
      }
    }
  }

  for (const field of options.sets ?? []) {
    const before = creating ? new Set<string>() : asSet(getOwn(previous, field));
    const after = asSet(getOwn(next, field));
    for (const id of before) {
      if (!after.has(id)) {
        stamps.push(fieldClockKey(field, id));
      }
    }
    for (const id of after) {
      if (!before.has(id)) {
        stamps.push(fieldClockKey(field, id));
      }
    }
  }

  const needed = stamps.filter((key) => getOwn(existing, key) !== hlc);
  if (needed.length === 0) {
    return existing;
  }
  const updated: FieldClocks = { ...existing };
  for (const key of needed) {
    setOwn(updated, key, hlc);
  }
  return updated;
};

/** The ship cursor: the largest clock of a row, or `null` when the row has no clocks. */
export const rowHlc = (clocks: FieldClocks): string | null => maxHlcOf(Object.values(clocks));

/** Per-key maximum of two clock maps. Commutative, associative and idempotent. */
export const mergeFieldClocks = (a: FieldClocks, b: FieldClocks): FieldClocks => {
  const merged: FieldClocks = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const clock = maxHlc(getOwn(a, key), getOwn(b, key));
    if (clock !== null) {
      setOwn(merged, key, clock);
    }
  }
  return merged;
};
