import { entityIdOf, parseEntityId } from "./entity-id";
import { SyncApplyError, SyncChangeSetError, type SyncChangeSetErrorCode } from "./errors";
import { getOwn } from "./field-clocks";
import { compareHlc, isValidHlc } from "./hlc";
import {
  getTableRegistration,
  isRegisteredTable,
  isSettingPublishable,
  SYNC_DOMAINS,
  type SyncDomain,
} from "./registry";
import { isValidDeviceId } from "./status";

/**
 * The model of what travels between two devices: the FULL synced state of one domain, not a log.
 * Pure data and hand-written validation (no schema library, no I/O). A later slice wraps it in a
 * file (`bundle.ts`); the repository produces it (`listSyncChanges`) and consumes it
 * (`applySyncBundle`).
 *
 * Rows are keyed by DATABASE COLUMN NAME with the raw stored values (text, number or null; JSON
 * columns stay text), exactly what the capture stamper decodes. A reader ignores columns it does not
 * have and keeps its own value for columns the row lacks, which is what lets an older and a newer
 * schema exchange state (spec: "Schema and version skew").
 *
 * `validateChangeSet` is the gate every bundle passes before anything touches a database. It is
 * strict about shape and clock canonicality, and it enforces the privacy boundary on the receiving
 * side too: an entity must belong to the declared domain, a union table likewise, and a setting must
 * be synced, in that domain and not a secret.
 */

export const SYNC_FORMAT_VERSION = 1;

/** Entity ids are primary keys (ids, dates, small JSON arrays); anything longer is not one. */
export const MAX_ENTITY_ID_LENGTH = 512;

/** Nesting limit for a settings value, so a hostile bundle cannot exhaust the stack. */
const MAX_JSON_DEPTH = 32;

/** A raw column value as stored by SQLite and carried in JSON. */
export type SyncRowValue = string | number | null;
export type SyncRow = Record<string, unknown>;

export interface SyncEntity {
  table: string;
  /** Canonical primary key text (`entityIdOf`). */
  entityId: string;
  /** The row by column name, or `null` when the entity is tombstoned. */
  row: SyncRow | null;
  /** Clock per field / map key / set element; empty for entities without per-field clocks. */
  fieldClocks: Record<string, string>;
  /** Latest clock of the entity (its ship cursor): the newest field clock, or the delete clock. */
  rowHlc: string;
  /** The delete's clock; `null` when the entity is live. */
  deletedAt: string | null;
}

export interface SyncSettingEntry {
  key: string;
  value: unknown;
  rowHlc: string;
}

export interface SyncChangeSet {
  formatVersion: typeof SYNC_FORMAT_VERSION;
  deviceId: string;
  domain: SyncDomain;
  /** Highest migration id applied on the sending device. */
  schemaVersion: number;
  /** An upper bound of every clock in the change set; the receiver folds it into its own clock. */
  hlcHigh: string;
  entities: SyncEntity[];
  /** Full row sets of the grow-only-union tables, by table name. */
  unionRows: Record<string, SyncRow[]>;
  settings: SyncSettingEntry[];
}

export interface SyncApplyResult {
  /** Entities, union rows and settings whose stored state changed. */
  applied: number;
  /** Entities, union rows and settings that were already up to date. */
  skipped: number;
  /** Tombstones that removed a local row or were recorded without one. */
  tombstonesApplied: number;
  /** New `sync_conflicts` rows (overwritten edits). */
  conflictsLogged: number;
  /** Whether absorbing `hlcHigh` moved the local clock. */
  hlcAdvanced: boolean;
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

const fail = (code: SyncChangeSetErrorCode, path: string, message: string): never => {
  throw new SyncChangeSetError(code, path, message);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const expectRecord = (
  value: unknown,
  path: string,
  keys: readonly string[],
): Record<string, unknown> => {
  if (!isRecord(value)) {
    return fail("invalid_shape", path, "expected an object");
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      fail("invalid_shape", path, `unexpected key "${key}"`);
    }
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) {
      fail("invalid_shape", path, `missing key "${key}"`);
    }
  }
  return value;
};

const expectClock = (value: unknown, path: string): string => {
  if (!isValidHlc(value)) {
    return fail("invalid_clock", path, "not a canonical HLC");
  }
  return value;
};

export const isJsonValue = (value: unknown, depth = 0): boolean => {
  if (depth > MAX_JSON_DEPTH) {
    return false;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item, depth + 1));
  }
  if (isRecord(value)) {
    return Object.keys(value).every((key) => isJsonValue(getOwn(value, key), depth + 1));
  }
  return false;
};

const expectRow = (value: unknown, path: string): SyncRow => {
  if (!isRecord(value)) {
    return fail("invalid_row", path, "expected an object keyed by column name");
  }
  for (const key of Object.keys(value)) {
    const cell = getOwn(value, key);
    const ok =
      cell === null ||
      typeof cell === "string" ||
      (typeof cell === "number" && Number.isFinite(cell));
    if (!ok) {
      fail("invalid_row", `${path}.${key}`, "a column value must be text, a finite number or null");
    }
  }
  return value;
};

/** The primary-key values of a row in registry order, or `null` if a key column is unusable. */
const primaryKeyValues = (table: string, row: SyncRow): (string | number)[] | null => {
  const values: (string | number)[] = [];
  for (const column of getTableRegistration(table).primaryKey) {
    const cell = getOwn(row, column);
    if (typeof cell === "string" ? cell.length === 0 : typeof cell !== "number") {
      return null;
    }
    values.push(cell as string | number);
  }
  return values;
};

const expectEntityTable = (table: unknown, domain: SyncDomain, path: string): string => {
  if (typeof table !== "string" || !isRegisteredTable(table)) {
    return fail("unknown_table", path, `"${String(table)}" is not a registered sync table`);
  }
  const registration = getTableRegistration(table);
  if (registration.domain !== domain) {
    fail(
      "table_not_in_domain",
      path,
      `"${table}" belongs to "${registration.domain}", not to a "${domain}" change set`,
    );
  }
  return table;
};

const validateEntity = (raw: unknown, index: number, domain: SyncDomain): SyncEntity => {
  const path = `entities[${index}]`;
  const entity = expectRecord(raw, path, [
    "table",
    "entityId",
    "row",
    "fieldClocks",
    "rowHlc",
    "deletedAt",
  ]);
  const table = expectEntityTable(entity.table, domain, `${path}.table`);
  if (getTableRegistration(table).mergeClass === "grow-only-union") {
    fail("invalid_entity", `${path}.table`, `"${table}" travels in unionRows, not as an entity`);
  }

  const entityId = entity.entityId;
  if (typeof entityId !== "string" || entityId.length === 0) {
    fail("invalid_entity_id", `${path}.entityId`, "expected a non-empty string");
  }
  if ((entityId as string).length > MAX_ENTITY_ID_LENGTH) {
    fail(
      "entity_id_too_long",
      `${path}.entityId`,
      `longer than ${MAX_ENTITY_ID_LENGTH} characters`,
    );
  }
  const key = parseEntityId(table, entityId);
  let canonical: string | null = null;
  try {
    canonical = key === null ? null : entityIdOf(table, key);
  } catch {
    canonical = null;
  }
  if (canonical !== entityId) {
    fail("invalid_entity_id", `${path}.entityId`, `not a canonical id of "${table}"`);
  }

  const clocksRaw = entity.fieldClocks;
  if (!isRecord(clocksRaw)) {
    return fail("invalid_shape", `${path}.fieldClocks`, "expected an object");
  }
  const fieldClocks: Record<string, string> = {};
  for (const clockKey of Object.keys(clocksRaw)) {
    if (clockKey.length === 0) {
      fail("invalid_shape", `${path}.fieldClocks`, "empty clock key");
    }
    Object.defineProperty(fieldClocks, clockKey, {
      value: expectClock(getOwn(clocksRaw, clockKey), `${path}.fieldClocks.${clockKey}`),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  const rowHlc = expectClock(entity.rowHlc, `${path}.rowHlc`);
  const deletedAt =
    entity.deletedAt === null ? null : expectClock(entity.deletedAt, `${path}.deletedAt`);

  let row: SyncRow | null = null;
  if (entity.row === null) {
    if (deletedAt === null) {
      fail("invalid_entity", path, "a tombstoned entity (row null) needs deletedAt");
    }
  } else {
    if (deletedAt !== null) {
      fail("invalid_entity", path, "a live entity (row present) must not carry deletedAt");
    }
    row = expectRow(entity.row, `${path}.row`);
    const pk = primaryKeyValues(table, row);
    let rowId: string | null = null;
    try {
      rowId = pk === null ? null : entityIdOf(table, pk);
    } catch {
      rowId = null;
    }
    if (rowId !== entityId) {
      fail("invalid_row", `${path}.row`, "primary key columns do not match entityId");
    }
  }

  return { table, entityId: entityId as string, row, fieldClocks, rowHlc, deletedAt };
};

const validateUnionRows = (raw: unknown, domain: SyncDomain): Record<string, SyncRow[]> => {
  if (!isRecord(raw)) {
    return fail("invalid_shape", "unionRows", "expected an object keyed by table name");
  }
  const result: Record<string, SyncRow[]> = {};
  for (const name of Object.keys(raw)) {
    const path = `unionRows.${name}`;
    const table = expectEntityTable(name, domain, path);
    if (getTableRegistration(table).mergeClass !== "grow-only-union") {
      fail("invalid_entity", path, `"${table}" is not a grow-only-union table`);
    }
    const list = getOwn(raw, name);
    if (!Array.isArray(list)) {
      return fail("invalid_shape", path, "expected an array of rows");
    }
    const seen = new Set<string>();
    const rows = list.map((item, index) => {
      const row = expectRow(item, `${path}[${index}]`);
      const pk = primaryKeyValues(table, row);
      if (pk === null) {
        fail("invalid_row", `${path}[${index}]`, "primary key column missing or empty");
      }
      const id = entityIdOf(table, pk as (string | number)[]);
      if (id.length > MAX_ENTITY_ID_LENGTH) {
        fail("entity_id_too_long", `${path}[${index}]`, "primary key too long");
      }
      if (seen.has(id)) {
        fail("duplicate_entity", `${path}[${index}]`, `duplicate row "${id}"`);
      }
      seen.add(id);
      return row;
    });
    Object.defineProperty(result, table, {
      value: rows,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
};

const validateSettings = (raw: unknown, domain: SyncDomain): SyncSettingEntry[] => {
  if (!Array.isArray(raw)) {
    return fail("invalid_shape", "settings", "expected an array");
  }
  const seen = new Set<string>();
  return raw.map((item, index) => {
    const path = `settings[${index}]`;
    const entry = expectRecord(item, path, ["key", "value", "rowHlc"]);
    const key = entry.key;
    if (typeof key !== "string" || !isSettingPublishable(key, domain)) {
      fail(
        "setting_not_syncable",
        `${path}.key`,
        `"${String(key)}" is not a synced setting of the "${domain}" domain`,
      );
    }
    if (seen.has(key as string)) {
      fail("duplicate_entity", `${path}.key`, `duplicate setting "${key as string}"`);
    }
    seen.add(key as string);
    if (!isJsonValue(entry.value)) {
      fail("invalid_setting_value", `${path}.value`, "expected a JSON value");
    }
    return {
      key: key as string,
      value: entry.value,
      rowHlc: expectClock(entry.rowHlc, `${path}.rowHlc`),
    };
  });
};

/** Every clock a change set carries, `hlcHigh` excluded. */
export const clocksOfChangeSet = (changeSet: SyncChangeSet): string[] => {
  const clocks: string[] = [];
  for (const entity of changeSet.entities) {
    clocks.push(entity.rowHlc, ...Object.values(entity.fieldClocks));
    if (entity.deletedAt !== null) {
      clocks.push(entity.deletedAt);
    }
  }
  for (const setting of changeSet.settings) {
    clocks.push(setting.rowHlc);
  }
  return clocks;
};

/**
 * Validates an untrusted value as a {@link SyncChangeSet} and returns it typed. Throws a
 * {@link SyncChangeSetError} for the first problem found; never returns a partially valid set.
 *
 * Rejected: a wrong shape or unknown key; a `formatVersion` this build does not know; any clock that
 * is not a canonical HLC; a `hlcHigh` below a carried clock; a table that is unknown, device-local,
 * a by-entity-type sidecar or outside the declared domain; a non-canonical, empty or oversized
 * entity id; duplicate entities, union rows or settings; a row whose key columns disagree with its
 * entity id; a setting that is unknown, device-scoped, secret, or of another domain.
 *
 * Tolerated: extra columns in a row (ignored on apply) and missing columns (the local value is
 * kept).
 */
export const validateChangeSet = (input: unknown): SyncChangeSet => {
  const root = expectRecord(input, "changeSet", [
    "formatVersion",
    "deviceId",
    "domain",
    "schemaVersion",
    "hlcHigh",
    "entities",
    "unionRows",
    "settings",
  ]);
  if (root.formatVersion !== SYNC_FORMAT_VERSION) {
    fail(
      "unsupported_format_version",
      "formatVersion",
      `expected ${SYNC_FORMAT_VERSION}, got ${String(root.formatVersion)}`,
    );
  }
  if (!isValidDeviceId(root.deviceId)) {
    fail("invalid_shape", "deviceId", "expected dev:<uuid v4>");
  }
  if (
    typeof root.domain !== "string" ||
    !(SYNC_DOMAINS as readonly string[]).includes(root.domain)
  ) {
    fail("invalid_shape", "domain", "expected gtd, personal or finance");
  }
  const domain = root.domain as SyncDomain;
  if (
    typeof root.schemaVersion !== "number" ||
    !Number.isSafeInteger(root.schemaVersion) ||
    root.schemaVersion < 1
  ) {
    fail("invalid_shape", "schemaVersion", "expected a positive integer");
  }
  const hlcHigh = expectClock(root.hlcHigh, "hlcHigh");
  if (!Array.isArray(root.entities)) {
    fail("invalid_shape", "entities", "expected an array");
  }

  const seen = new Set<string>();
  const entities = (root.entities as unknown[]).map((item, index) => {
    const entity = validateEntity(item, index, domain);
    const identity = `${entity.table}\u0000${entity.entityId}`;
    if (seen.has(identity)) {
      fail(
        "duplicate_entity",
        `entities[${index}]`,
        `duplicate ${entity.table} ${entity.entityId}`,
      );
    }
    seen.add(identity);
    return entity;
  });

  const changeSet: SyncChangeSet = {
    formatVersion: SYNC_FORMAT_VERSION,
    deviceId: root.deviceId as string,
    domain,
    schemaVersion: root.schemaVersion as number,
    hlcHigh,
    entities,
    unionRows: validateUnionRows(root.unionRows, domain),
    settings: validateSettings(root.settings, domain),
  };

  for (const clock of clocksOfChangeSet(changeSet)) {
    if (compareHlc(clock, hlcHigh) > 0) {
      fail("hlc_high_too_low", "hlcHigh", `a carried clock (${clock}) is above hlcHigh`);
    }
  }
  return changeSet;
};

// ---------------------------------------------------------------------------------------------
// Domain allow-list
// ---------------------------------------------------------------------------------------------

/**
 * Pure guard for the device profile: a work device applies and publishes only
 * `WORK_PROFILE_DOMAINS`. Throws `SyncApplyError("domain_not_allowed")` for anything else. The
 * profile itself is a later slice; this is the check it will call.
 */
export const assertDomainAllowed = (
  domain: SyncDomain,
  allowedDomains: readonly SyncDomain[],
): void => {
  if (!allowedDomains.includes(domain)) {
    throw new SyncApplyError(
      "domain_not_allowed",
      `The "${domain}" domain is not allowed on this device (allowed: ${allowedDomains.join(", ") || "none"})`,
    );
  }
};
