import { defaultAppSettings, normalizeAppSettings } from "../../domain/settings";
import type { AppSettings } from "../../domain/types/settings";
import type { Database } from "../storage/sqlite-db";
import { quoteIdent } from "./capture-install";
import {
  dataSettingKeys,
  ENTITY_TYPED_SIDECARS,
  entityTypesOfDomain,
  KNOWN_ENTITY_TYPES,
  type ProfileDataInspection,
  type RawProfileData,
  SEEDED_FINANCE_CATEGORIES,
  summarizeProfileData,
} from "./profile-data";
import { SETTING_ENTITY_TYPE, SYNC_DOMAINS, type SyncDomain } from "./registry";

/**
 * The SQL half of the work-profile data guards: reads, never writes. Run it inside the repository's
 * writer slot (a consistent view), on an open database or transaction.
 *
 * Cost. `exact: false` is the startup check: every source is `SELECT 1 ... LIMIT 1`, so a database
 * with 130,000 finance transactions costs the same as an empty one (one index probe per table), and
 * the sidecar queries are prefix probes on the `(entity_type, entity_id)` primary key. `exact: true`
 * counts, and is for the moments a person is told how many rows block a profile.
 */

export interface InspectProfileDataOptions {
  /** Domains to look at (default: all three). A work device's re-check only asks for the other two. */
  domains?: readonly SyncDomain[];
  /** Count rows (default) instead of stopping at the first one of each source. */
  exact?: boolean;
}

/**
 * One look at one source: `exact` counts, otherwise it stops at the first row. Both forms run the SAME
 * `FROM ... WHERE`, so a row that counts is a row that flips the cheap probe. `prefix` is a `WITH` clause.
 */
const countWhere = async (
  db: Database,
  from: string,
  where: string,
  params: unknown[],
  exact: boolean,
  prefix = "",
): Promise<number> => {
  if (exact) {
    const rows = await db.select<{ n: number }[]>(
      `${prefix}SELECT COUNT(*) AS n FROM ${from} WHERE ${where}`,
      params,
    );
    return Number(rows[0]?.n ?? 0);
  }
  const rows = await db.select<{ n: number }[]>(
    `${prefix}SELECT 1 AS n FROM ${from} WHERE ${where} LIMIT 1`,
    params,
  );
  return rows.length > 0 ? 1 : 0;
};

const SEED_COLUMNS = 8;

/** The shipped seed categories as a CTE named `seed`, its parameters numbered from `offset + 1`. */
const seedCte = (offset: number): { sql: string; params: unknown[] } => {
  const params: unknown[] = [];
  const rows = SEEDED_FINANCE_CATEGORIES.map((category, row) => {
    params.push(
      category.id,
      category.name,
      category.parentId,
      category.kind,
      category.archived ? 1 : 0,
      category.isSystem ? 1 : 0,
      category.defersToNextMonth ? 1 : 0,
      category.sortOrder,
    );
    const first = offset + row * SEED_COLUMNS;
    return `(${Array.from({ length: SEED_COLUMNS }, (_, i) => `$${first + i + 1}`).join(", ")})`;
  });
  return {
    sql: `WITH seed(id, name, parent_id, kind, archived, is_system, defers, sort_order) AS (VALUES ${rows.join(", ")}) `,
    params,
  };
};

/**
 * Ids of the seeded categories whose stored row still equals the shipped seed (needs `seedCte`). A
 * deleted, renamed, re-parented, re-kinded, archived, re-flagged or reordered one is not in it.
 */
const PRISTINE_SEED_IDS = `SELECT c.id FROM finance_categories c JOIN seed s
  ON s.id = c.id AND s.name = c.name AND s.parent_id IS c.parent_id AND s.kind = c.kind
  AND s.archived = c.archived AND s.is_system = c.is_system
  AND s.defers = c.defers_to_next_month AND s.sort_order = c.sort_order`;

const bind = (values: readonly unknown[], offset: number): string =>
  values.map((_, index) => `$${offset + index + 1}`).join(", ");

const readStoredSettings = async (db: Database): Promise<AppSettings> => {
  const rows = await db.select<{ value: string }[]>("SELECT value FROM app_settings WHERE id = 1");
  const defaults = defaultAppSettings();
  return rows[0]
    ? normalizeAppSettings(JSON.parse(rows[0].value) as Partial<AppSettings>, defaults)
    : defaults;
};

/** Raw, seed-free counts of the requested domains. Throws on a database error; the caller decides. */
export const readRawProfileData = async (
  db: Database,
  options: InspectProfileDataOptions = {},
): Promise<RawProfileData> => {
  const exact = options.exact !== false;
  const domains = options.domains ?? SYNC_DOMAINS;
  const tables: Record<string, number> = {};
  const sidecars: RawProfileData["sidecars"][number][] = [];
  const settingSidecars: RawProfileData["settingSidecars"][number][] = [];

  // 1. The tables of the domains.
  for (const domain of domains) {
    for (const table of entityTypesOfDomain(domain)) {
      const seed = table === "finance_categories" ? seedCte(0) : null;
      const count = await countWhere(
        db,
        quoteIdent(table),
        seed === null ? "1 = 1" : `id NOT IN (${PRISTINE_SEED_IDS})`,
        seed === null ? [] : seed.params,
        exact,
        seed === null ? "" : seed.sql,
      );
      if (count > 0) tables[table] = count;
    }
  }

  // 2. Sidecar rows, routed by entity type. Per sidecar table and per domain one probe; unknown
  // entity types (counted as personal) and the settings (routed by key) are two more.
  for (const sidecar of ENTITY_TYPED_SIDECARS) {
    const from = quoteIdent(sidecar.table);
    for (const domain of domains) {
      const types = entityTypesOfDomain(domain);
      if (types.length === 0) continue;
      const params: unknown[] = [...types];
      let where = `entity_type IN (${bind(types, 0)})`;
      let prefix = "";
      if (sidecar.seedExemptWhenNoValues !== null && types.includes("finance_categories")) {
        // Exempt only the rows of a seeded category that is alive and unmodified, and that retain no value.
        const seed = seedCte(params.length);
        prefix = seed.sql;
        params.push(...seed.params);
        where += ` AND NOT (entity_type = 'finance_categories' AND ${quoteIdent(sidecar.idColumn)} IN (${PRISTINE_SEED_IDS}) AND ${sidecar.seedExemptWhenNoValues})`;
      }
      const count = await countWhere(db, from, where, params, exact, prefix);
      if (count > 0) {
        sidecars.push({ table: sidecar.table, domain, label: `${domain} entities`, count });
      }
    }
    if (domains.includes("personal")) {
      const unknown = await countWhere(
        db,
        from,
        `entity_type NOT IN (${bind(KNOWN_ENTITY_TYPES, 0)})`,
        [...KNOWN_ENTITY_TYPES],
        exact,
      );
      if (unknown > 0) {
        sidecars.push({
          table: sidecar.table,
          domain: "personal",
          label: "unknown entity type",
          count: unknown,
        });
      }
    }
    // Settings: a handful of keys at most; the key decides the domain.
    const settingRows = await db.select<{ entity_id: string; n: number }[]>(
      `SELECT ${quoteIdent(sidecar.idColumn)} AS entity_id, COUNT(*) AS n FROM ${from}
       WHERE entity_type = $1 GROUP BY ${quoteIdent(sidecar.idColumn)}`,
      [SETTING_ENTITY_TYPE],
    );
    for (const row of settingRows) {
      settingSidecars.push({ table: sidecar.table, key: row.entity_id, count: Number(row.n) });
    }
  }

  // 3. The settings that differ from their defaults (personal and finance scope).
  const wantsSettings = domains.includes("personal") || domains.includes("finance");
  const settingKeys = wantsSettings
    ? dataSettingKeys((await readStoredSettings(db)) as unknown as Record<string, unknown>)
    : [];
  return { tables, sidecars, settingSidecars, settingKeys };
};

/**
 * What the database holds, per domain, seed rows excluded. A domain outside `options.domains` is
 * reported as 0 (it was not looked at).
 */
export const inspectProfileData = async (
  db: Database,
  options: InspectProfileDataOptions = {},
): Promise<ProfileDataInspection> => {
  const domains = options.domains ?? SYNC_DOMAINS;
  const raw = await readRawProfileData(db, options);
  const inspection = summarizeProfileData(raw, options.exact !== false);
  // A setting key routes a sidecar row to its own domain; keep only what was asked for.
  for (const domain of SYNC_DOMAINS) {
    if (!domains.includes(domain)) {
      inspection.counts[domain] = 0;
    }
  }
  inspection.sources = inspection.sources.filter((source) => domains.includes(source.domain));
  return inspection;
};
