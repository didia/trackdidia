// Test-only: nothing in the app imports this file.
//
// SAFETY: every database here is an in-memory SQLite (`createNodeSqliteDatabase` with `:memory:`). Never point this harness at a real connection string or an app-data path.
import { expect } from "vitest";
import { createNodeSqliteDatabase } from "../../../test/mocks/node-sqlite-database";
import type { Database } from "../../storage/sqlite-db";
import { TauriSqliteRepository } from "../../storage/tauri-sqlite-repository";
import type { SyncApplyResult, SyncChangeSet } from "../change-set";
import { canonicalJson } from "../field-clocks";
import {
  getTableRegistration,
  isSidecarPublishable,
  SETTING_ENTITY_TYPE,
  type SyncDomain,
  settingsKeysInScope,
  tablesInDomain,
} from "../registry";

/**
 * A reusable N-laptop simulation: N independent `TauriSqliteRepository` instances, each over its own
 * real in-memory SQLite (so the real capture triggers fire), each with its own device id and its
 * own controllable clock. Later sync slices (transport, bundles, recurrences, finance, work profile)
 * build their scenarios on it.
 *
 * ```ts
 * const sim = await createSyncHarness(["A", "B"]);
 * const [a, b] = sim.devices;
 * await a.repo.createTask({ id: "t1", title: "Plan", bucket: "inbox" });
 * await sim.syncAll("gtd");                    // or sim.exchange(a, b, "gtd")
 * await sim.expectConverged("gtd");
 * ```
 *
 * Time: `device.clock` is the epoch-ms the device's sync clock (HLC) reads. It only moves when the
 * test moves it (`device.clock.advance(ms)`), so which edit is "later" is explicit and independent
 * of the real wall clock. Row timestamps such as `updated_at` still come from the real `Date`; the
 * merge treats them as ordinary fields.
 *
 * Transport: `exchange` serializes the change set to JSON and back by default, so what is applied
 * is exactly what a bundle file would deliver (no shared object references, no `undefined`).
 */

/** 2026-10-01T12:00:00Z. */
export const HARNESS_START_MS = Date.UTC(2026, 9, 1, 12, 0, 0);

export interface FakeClock {
  /** Current epoch milliseconds of this simulated laptop. */
  readonly now: number;
  set(ms: number): void;
  advance(ms?: number): void;
  /** Bound reader handed to the repository. */
  readonly read: () => number;
}

export const createFakeClock = (startMs = HARNESS_START_MS): FakeClock => {
  let current = startMs;
  return {
    get now() {
      return current;
    },
    set(ms) {
      current = ms;
    },
    advance(ms = 60_000) {
      current += ms;
    },
    read: () => current,
  };
};

export interface SyncDevice {
  name: string;
  /** Valid `dev:<uuid v4>`, distinct per device. */
  deviceId: string;
  db: Database;
  repo: TauriSqliteRepository;
  clock: FakeClock;
  /**
   * Runs capture's verifying scan, stamping edits that bypassed the repository writers (a raw
   * `db.execute("DELETE ...")` in a test). Idempotent.
   */
  stamp(): Promise<void>;
}

export interface HarnessOptions {
  startMs?: number;
  /**
   * Added to every device's index when deriving its device id, so a second harness can hold
   * replicas whose ids differ from the first harness's (default 0).
   */
  deviceIndexOffset?: number;
  /** Install change capture on every device (default true). */
  enableCapture?: boolean;
  /**
   * Enforce declared foreign keys, as production does (sqlx turns them on). Default true; every
   * sync scenario runs with it on, so a merge that would abort or cascade under enforcement fails
   * here instead of on a real database.
   */
  foreignKeys?: boolean;
}

export interface SyncHarness {
  devices: SyncDevice[];
  device(name: string): SyncDevice;
  /** `to.applySyncBundle(domain, await from.listSyncChanges(domain))`. */
  exchange(
    from: SyncDevice,
    to: SyncDevice,
    domain: SyncDomain,
    options?: { roundTrip?: boolean },
  ): Promise<SyncApplyResult>;
  /** Exchanges between every ordered pair, repeated until a full round changes nothing. */
  syncAll(domain: SyncDomain): Promise<SyncApplyResult[]>;
  /** Canonical comparable state of a domain on one device. */
  dump(device: SyncDevice, domain: SyncDomain, options?: DumpOptions): Promise<DomainDump>;
  /** Fails unless every device holds the same state for `domain`. */
  expectConverged(domain: SyncDomain, options?: DumpOptions): Promise<void>;
}

/** `dev:` ids are lowercase UUID v4s; the harness derives them from the device index. */
export const harnessDeviceId = (index: number): string =>
  `dev:00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`;

export const jsonRoundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export const createSyncDevice = async (
  name: string,
  index: number,
  options: HarnessOptions = {},
): Promise<SyncDevice> => {
  const db = createNodeSqliteDatabase(":memory:", { foreignKeys: options.foreignKeys !== false });
  const clock = createFakeClock(options.startMs);
  const repo = new TauriSqliteRepository("sqlite::memory:", async () => db, clock.read);
  await repo.initialize();
  const deviceId = harnessDeviceId(index);
  await repo.ensureSyncIdentity({ deviceId, deviceName: name });
  if (options.enableCapture !== false) {
    await repo.enableSyncCapture();
  }
  return {
    name,
    deviceId,
    db,
    repo,
    clock,
    stamp: async () => {
      await repo.enableSyncCapture();
    },
  };
};

export interface DumpOptions {
  /** Also compare `sync_entity_snapshot` (default false). */
  snapshots?: boolean;
  /**
   * Compare stored text byte for byte. By default the content of every `*_json` column is compared
   * as JSON (parsed and canonically re-serialized, id lists sorted), because a laptop that merged
   * nothing new into a column keeps its own formatting and list order while a laptop that did
   * merge stores the canonical text: same state, different bytes. Convergence tests that start
   * from empty replicas use `exact: true`.
   */
  exact?: boolean;
}

export interface DomainDump {
  /** Every row of every table of the domain, ordered by primary key. */
  tables: Record<string, Record<string, unknown>[]>;
  /** `sync_entity_meta` rows of the domain's tables and of its synced settings. */
  meta: Record<string, unknown>[];
  /** Current value of every synced setting of the domain. */
  settings: Record<string, unknown>;
  /** `sync_id_aliases` rows of the domain's entity types (canonical identity). */
  aliases: Record<string, unknown>[];
  snapshots?: Record<string, unknown>[];
}

const placeholders = (count: number): string =>
  Array.from({ length: count }, (_, index) => `$${index + 1}`).join(", ");

const normalizeJsonText = (value: unknown, sortArrays: boolean): unknown => {
  if (typeof value !== "string") return value;
  try {
    const parsed: unknown = JSON.parse(value);
    if (sortArrays && Array.isArray(parsed)) {
      return canonicalJson([...parsed].sort());
    }
    return canonicalJson(parsed);
  } catch {
    return value;
  }
};

const normalizeRow = (table: string, row: Record<string, unknown>): Record<string, unknown> => {
  const sets = new Set(getTableRegistration(table).orSetColumns);
  const result: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(row)) {
    result[column] = column.endsWith("_json") ? normalizeJsonText(value, sets.has(column)) : value;
  }
  return result;
};

/** A snapshot's `snapshot_json` holds decoded columns: parsed JSON columns, id lists as arrays. */
const normalizeSnapshot = (row: Record<string, unknown>): Record<string, unknown> => {
  if (typeof row.snapshot_json !== "string" || row.entity_type === SETTING_ENTITY_TYPE) return row;
  const sets = new Set(getTableRegistration(String(row.entity_type)).orSetColumns);
  const record = JSON.parse(row.snapshot_json) as Record<string, unknown>;
  for (const column of sets) {
    if (Array.isArray(record[column])) record[column] = [...(record[column] as string[])].sort();
  }
  return { ...row, snapshot_json: canonicalJson(record) };
};

/**
 * Canonical comparison state of one domain: rows and clock metadata of the domain's tables and of
 * its synced settings, ignoring every device-local table (identity, peers, marks, conflicts). Two
 * converged replicas dump equal.
 */
export const dumpDomain = async (
  device: SyncDevice,
  domain: SyncDomain,
  options: DumpOptions = {},
): Promise<DomainDump> => {
  const tables: Record<string, Record<string, unknown>[]> = {};
  for (const table of tablesInDomain(domain)) {
    const order = getTableRegistration(table)
      .primaryKey.map((column) => `"${column}"`)
      .join(", ");
    const rows = await device.db.select<Record<string, unknown>[]>(
      `SELECT * FROM "${table}" ORDER BY ${order}`,
    );
    tables[table] = options.exact ? rows : rows.map((row) => normalizeRow(table, row));
  }

  const keys = settingsKeysInScope(domain);
  const scope = `(entity_type IN (${placeholders(Object.keys(tables).length)}) OR (entity_type = '${SETTING_ENTITY_TYPE}' AND entity_id IN (${keys.map((_, i) => `$${Object.keys(tables).length + i + 1}`).join(", ") || "''"})))`;
  const params = [...Object.keys(tables), ...keys];
  const meta = await device.db.select<Record<string, unknown>[]>(
    `SELECT * FROM sync_entity_meta WHERE ${scope} ORDER BY entity_type, entity_id`,
    params,
  );

  const current = (await device.repo.getSettings()) as unknown as Record<string, unknown>;
  const settings: Record<string, unknown> = {};
  for (const key of keys) {
    settings[key] = current[key] ?? null;
  }

  const aliases = (
    await device.db.select<Record<string, unknown>[]>(
      "SELECT * FROM sync_id_aliases ORDER BY entity_type, alias_id",
    )
  ).filter((row) => isSidecarPublishable("sync_id_aliases", domain, String(row.entity_type)));

  const dump: DomainDump = { tables, meta, settings, aliases };
  if (options.snapshots) {
    const snapshots = await device.db.select<Record<string, unknown>[]>(
      `SELECT * FROM sync_entity_snapshot WHERE ${scope} ORDER BY entity_type, entity_id`,
      params,
    );
    dump.snapshots = options.exact ? snapshots : snapshots.map(normalizeSnapshot);
  }
  return dump;
};

/** Every `sync_conflicts` row of a device, oldest id first. */
export const readConflicts = (device: SyncDevice): Promise<Record<string, unknown>[]> =>
  device.db.select("SELECT * FROM sync_conflicts ORDER BY id");

export const createSyncHarness = async (
  devices: readonly string[] | number,
  options: HarnessOptions = {},
): Promise<SyncHarness> => {
  const names =
    typeof devices === "number"
      ? Array.from({ length: devices }, (_, index) => String.fromCharCode(65 + index))
      : devices;
  const list = await Promise.all(
    names.map((name, index) =>
      createSyncDevice(name, index + (options.deviceIndexOffset ?? 0), options),
    ),
  );

  const exchange: SyncHarness["exchange"] = async (from, to, domain, exchangeOptions = {}) => {
    const changeSet: SyncChangeSet = await from.repo.listSyncChanges(domain);
    return to.repo.applySyncBundle(
      domain,
      exchangeOptions.roundTrip === false ? changeSet : jsonRoundTrip(changeSet),
    );
  };

  const dump: SyncHarness["dump"] = (device, domain, dumpOptions) =>
    dumpDomain(device, domain, dumpOptions);

  return {
    devices: list,
    device(name) {
      const found = list.find((device) => device.name === name);
      if (!found) {
        throw new Error(`No simulated device named "${name}"`);
      }
      return found;
    },
    exchange,
    dump,
    async syncAll(domain) {
      const results: SyncApplyResult[] = [];
      for (let round = 0; round <= list.length; round += 1) {
        let changed = 0;
        for (const from of list) {
          for (const to of list) {
            if (from === to) continue;
            const result = await exchange(from, to, domain);
            results.push(result);
            changed += result.applied;
          }
        }
        if (changed === 0) break;
      }
      return results;
    },
    async expectConverged(domain, dumpOptions) {
      const [first, ...rest] = list;
      if (!first) return;
      const reference = await dumpDomain(first, domain, dumpOptions);
      for (const other of rest) {
        expect(
          await dumpDomain(other, domain, dumpOptions),
          `${other.name} vs ${first.name}`,
        ).toEqual(reference);
      }
    },
  };
};
