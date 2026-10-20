import type { Database } from "../storage/sqlite-db";
import { capturedSettingKeys, fetchMeta, parseClocks } from "./capture-stamp";
import { SyncClockError } from "./clock-store";
import {
  clocksOfChangeSet,
  SYNC_FORMAT_VERSION,
  type SyncChangeSet,
  type SyncEntity,
  type SyncRow,
  type SyncSettingEntry,
  validateChangeSet,
} from "./change-set";
import { entityIdOf } from "./entity-id";
import { getOwn } from "./field-clocks";
import { encodeHlc, maxHlcOf } from "./hlc";
import { supportedEntityTables, supportedUnionTables, tableOrder } from "./merge-strategies";
import {
  assertTablePublishable,
  isSettingPublishable,
  SETTING_ENTITY_TYPE,
  type SyncDomain,
} from "./registry";
import type { SyncSettingsAccess } from "./apply-bundle";
import { quoteIdent } from "./capture-install";
import { readTableInfo, toSyncRow } from "./table-info";

/**
 * Reading the full synced state of one domain: the read side of multi-device sync.
 *
 * Only SELECTs. The caller runs it inside the repository's writer slot, which is what makes it a
 * consistent read: on the single connection no write transaction can interleave between the
 * statements below.
 *
 * What is published is decided by the registry and by `merge-strategies.ts`, never re-derived here:
 * each table goes through `assertTablePublishable` for the requested domain, tables this build
 * cannot merge are not read at all, and the finished change set is passed through
 * `validateChangeSet` so a classification mistake fails loudly instead of leaking a row. Rows
 * without a `sync_entity_meta` row (never stamped) are not published; `enableSyncCapture`'s
 * verifying backfill stamps them.
 */

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface IdentityRow {
  device_id: string;
  physical_ms: number;
  counter: number;
}

const readEntities = async (db: Database, domain: SyncDomain): Promise<SyncEntity[]> => {
  const entities: SyncEntity[] = [];
  for (const table of supportedEntityTables(domain)) {
    assertTablePublishable(table, domain);
    const info = await readTableInfo(db, table);
    const rows = await db.select<Record<string, unknown>[]>(`SELECT * FROM ${quoteIdent(table)}`);
    const byId = new Map<string, Record<string, unknown>>();
    for (const row of rows) {
      try {
        byId.set(
          entityIdOf(
            table,
            info.primaryKey.map((column) => row[column]),
          ),
          row,
        );
      } catch {
        /* a row with a NULL key cannot be addressed */
      }
    }
    const metas = await db.select<
      { entity_id: string; field_clocks_json: string; row_hlc: string; deleted_at: string | null }[]
    >(
      "SELECT entity_id, field_clocks_json, row_hlc, deleted_at FROM sync_entity_meta WHERE entity_type = $1",
      [table],
    );
    for (const meta of metas) {
      const fieldClocks = parseClocks(meta.field_clocks_json);
      if (meta.deleted_at !== null) {
        entities.push({
          table,
          entityId: meta.entity_id,
          row: null,
          fieldClocks,
          rowHlc: meta.row_hlc,
          deletedAt: meta.deleted_at,
        });
        continue;
      }
      const row = byId.get(meta.entity_id);
      if (row === undefined) {
        continue; // a delete the stamper has not seen yet: nothing truthful to publish
      }
      entities.push({
        table,
        entityId: meta.entity_id,
        row: toSyncRow(row),
        fieldClocks,
        rowHlc: meta.row_hlc,
        deletedAt: null,
      });
    }
  }
  return entities.sort(
    (a, b) => tableOrder(a.table) - tableOrder(b.table) || byText(a.entityId, b.entityId),
  );
};

const readUnionRows = async (
  db: Database,
  domain: SyncDomain,
): Promise<Record<string, SyncRow[]>> => {
  const result: Record<string, SyncRow[]> = {};
  for (const table of supportedUnionTables(domain)) {
    assertTablePublishable(table, domain);
    const info = await readTableInfo(db, table);
    const rows = await db.select<Record<string, unknown>[]>(
      `SELECT * FROM ${quoteIdent(table)} ORDER BY ${info.primaryKey.map(quoteIdent).join(", ")}`,
    );
    Object.defineProperty(result, table, {
      value: rows.map(toSyncRow),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
};

const readSettings = async (
  db: Database,
  domain: SyncDomain,
  access: SyncSettingsAccess,
): Promise<SyncSettingEntry[]> => {
  const keys = capturedSettingKeys().filter((key) => isSettingPublishable(key, domain));
  if (keys.length === 0) {
    return [];
  }
  const metas = await fetchMeta(db, SETTING_ENTITY_TYPE, keys);
  const settings = (await access.read(db)) as unknown as Record<string, unknown>;
  return keys.sort(byText).flatMap((key) => {
    const meta = metas.get(key);
    return meta ? [{ key, value: getOwn(settings, key) ?? null, rowHlc: meta.row_hlc }] : [];
  });
};

/**
 * The full synced state of `domain` as a validated {@link SyncChangeSet}. Requires the sync
 * identity (the change set names its device and the clock it has reached).
 */
export const readChangeSet = async (
  db: Database,
  domain: SyncDomain,
  settings: SyncSettingsAccess,
): Promise<SyncChangeSet> => {
  const identity = (
    await db.select<IdentityRow[]>(
      "SELECT device_id, physical_ms, counter FROM sync_identity WHERE id = 1",
    )
  )[0];
  if (!identity) {
    throw new SyncClockError(
      "identity_missing",
      "Multi-device sync identity has not been created on this device",
    );
  }
  const schema = await db.select<{ version: number | null }[]>(
    "SELECT MAX(id) AS version FROM schema_migrations",
  );

  const draft: SyncChangeSet = {
    formatVersion: SYNC_FORMAT_VERSION,
    deviceId: identity.device_id,
    domain,
    schemaVersion: Number(schema[0]?.version ?? 0),
    hlcHigh: "",
    entities: await readEntities(db, domain),
    unionRows: await readUnionRows(db, domain),
    settings: await readSettings(db, domain, settings),
  };
  // The newest clock included; an empty change set reports the clock the device itself has reached.
  draft.hlcHigh =
    maxHlcOf(clocksOfChangeSet(draft)) ??
    encodeHlc(identity.physical_ms, identity.counter, identity.device_id);
  return validateChangeSet(draft);
};
