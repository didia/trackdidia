import { defaultAppSettings } from "../../domain/settings";
import type { AppSettings } from "../../domain/types/settings";
import type { FinanceCategory } from "../../domain/finance";
import {
  DEFAULT_FINANCE_CATEGORIES,
  defaultSeedAsCategory,
  SYSTEM_FINANCE_CATEGORIES,
} from "../finance/default-categories";
import { canonicalJson } from "./field-clocks";
import {
  DEVICE_DOMAIN,
  getTableRegistration,
  isRegisteredSetting,
  isRegisteredTable,
  SETTING_ENTITY_TYPE,
  SYNC_DOMAINS,
  type SyncDomain,
  settingKeys,
  settingRule,
  TABLE_REGISTRY,
  tablesInDomain,
} from "./registry";

/**
 * What a database holds, per sync domain: the pure half of the work-profile data guards (spec "Work
 * profile": "A work device starts from a database with no personal or finance rows").
 *
 * `profile-data-sql.ts` reads raw counts from SQLite; everything that DECIDES (which tables belong to
 * which domain, what a seed row is, what a sidecar row says about its entity) is here and is tested
 * without a database.
 *
 * Two kinds of rows count, because a work laptop must not hold either:
 * - the rows of every table the registry classifies in a bundle domain (`gtd`, `personal`, `finance`),
 *   and the settings of those domains that differ from their defaults;
 * - SIDECAR rows that describe such an entity: `sync_entity_meta` (clocks and tombstones, which keep
 *   the deleted row's values), `sync_entity_snapshot` (a full copy of the row), `sync_id_aliases`,
 *   `sync_conflicts` (both versions of a value) and `sync_dirty` marks. A row of one of these is
 *   routed to a domain by its `entity_type` (the registry's `entityTypeColumn`), NOT by the sidecar
 *   table's own classification, so `tablesInDomain()` alone would never see it. An entity type this
 *   build does not know is counted as `personal`: the privacy side of any ambiguity.
 *
 * Seed rows are not data. A database that never held anything of the user's has the three finance
 * system categories (migration 37) and, once finance was enabled, the default category taxonomy; the
 * capture backfill gives each of them a clock and a snapshot, and the app stamps a few one-time
 * markers into the settings row by itself. None of that makes a database "personal" - as long as the
 * seed is still the seed: a seeded category the user edited (or deleted) is user data, see
 * {@link SEEDED_FINANCE_CATEGORIES}.
 */

/** Rows per domain, seed rows excluded. */
export type ProfileDataCounts = Record<SyncDomain, number>;

export const emptyProfileDataCounts = (): ProfileDataCounts => ({
  gtd: 0,
  personal: 0,
  finance: 0,
});

/** The two domains a work device must never hold. */
export const FOREIGN_TO_WORK_DOMAINS = [
  "personal",
  "finance",
] as const satisfies readonly SyncDomain[];

/**
 * The finance categories every database can hold without the user having done anything: the three
 * system categories migration 37 inserts (their ids are hard-referenced by the engine) and the default
 * taxonomy `seedFinanceDefaultCategories` inserts, both from `finance/default-categories.ts`.
 *
 * A seeded category is NOT data only while its stored content is the shipped content: the seed
 * definition's every user-editable column (name, parent, kind, archived, system and
 * defers-to-next-month flags, sort order) must be unchanged. Matching the id alone would let a
 * renamed category ("Pharmacie" -> a medication) through, since an edit never changes the id. Only
 * `created_at` and `updated_at` are left out: seeding stamps them with the time it ran, and every
 * save of the category (even one that changes nothing) rewrites `updated_at`, so they say when, not
 * what; no migration or startup step rewrites a seeded row. Nothing else of the row is excluded.
 */
export const SEEDED_FINANCE_CATEGORIES: readonly FinanceCategory[] = [
  ...SYSTEM_FINANCE_CATEGORIES,
  ...DEFAULT_FINANCE_CATEGORIES.map(defaultSeedAsCategory),
];

export const SEEDED_FINANCE_CATEGORY_IDS: readonly string[] = SEEDED_FINANCE_CATEGORIES.map(
  (category) => category.id,
);

/**
 * Settings the application writes itself, once, on every database (the startup normalizations and the
 * Dimanche-notes relocation) or as a side effect of its own generators. Their non-default value says
 * "the app started", not "the user keeps personal data here", so they are not counted. Every other
 * `personal` or `finance` setting that differs from its default is.
 */
export const APP_MANAGED_SETTING_KEYS = [
  "dimancheNotesRelocatedAt",
  "aiMaxTokensUpgradeDoneAt",
  "financeCategoriesSeededAt",
  "relationshipDrawChildrenProcessedDate",
  "relationshipDrawSpouseProcessedDate",
] as const satisfies readonly (keyof AppSettings)[];

const MANAGED_SETTINGS: ReadonlySet<string> = new Set(APP_MANAGED_SETTING_KEYS);

/**
 * The tables whose rows are routed by an `entity_type` column, with the column that names the row's
 * entity. `profile-data.test.ts` fails when the migrated schema has another table with an
 * `entity_type` column.
 *
 * `seedExemptWhenNoValues`: the SQL condition "this row retains no value of the entity" that, together
 * with a live seeded category that is still unmodified, exempts the row of a seeded finance category
 * (state about an unmodified seed; nothing of the user's). A row that retains a value (a snapshot, a
 * tombstone's deleted values, a delete mark's old row) or describes a deleted category is counted:
 * `finance_categories` merges as whole rows, so none of those is ever written for it in this build, and
 * a value that is there anyway is not provably the shipped seed. Aliases and conflicts have no such
 * condition and are always counted: a conflict holds both versions of an edited value, so it can keep
 * what a rename was even after the row was changed back.
 */
export const ENTITY_TYPED_SIDECARS: readonly {
  table: string;
  idColumn: string;
  seedExemptWhenNoValues: string | null;
}[] = [
  {
    table: "sync_entity_meta",
    idColumn: "entity_id",
    seedExemptWhenNoValues: "deleted_at IS NULL AND deleted_row_json IS NULL",
  },
  {
    table: "sync_entity_snapshot",
    idColumn: "entity_id",
    seedExemptWhenNoValues: "snapshot_json IS NULL",
  },
  { table: "sync_dirty", idColumn: "entity_id", seedExemptWhenNoValues: "old_row IS NULL" },
  { table: "sync_id_aliases", idColumn: "alias_id", seedExemptWhenNoValues: null },
  { table: "sync_conflicts", idColumn: "entity_id", seedExemptWhenNoValues: null },
];

/** Entity types that never belong to a domain: the settings blob's dirty mark. */
const UNROUTED_ENTITY_TYPES: ReadonlySet<string> = new Set(["app_settings"]);

/** Every entity type the registry (or the settings) can name; anything else is unknown. */
export const KNOWN_ENTITY_TYPES: readonly string[] = [
  ...TABLE_REGISTRY.map((entry) => entry.table),
  SETTING_ENTITY_TYPE,
  ...UNROUTED_ENTITY_TYPES,
];

/**
 * The domain a sidecar row belongs to, or `null` when it belongs to none (a device-local entity, a
 * device or secret setting, the settings blob's dirty mark). `entityId` is needed for `setting`.
 * Unknown entity types and unknown setting keys are `personal`.
 */
export const domainOfEntityType = (entityType: string, entityId?: string): SyncDomain | null => {
  if (entityType === SETTING_ENTITY_TYPE) {
    if (entityId === undefined || !isRegisteredSetting(entityId)) return "personal";
    const rule = settingRule(entityId);
    return rule.scope === "device" ? null : rule.scope;
  }
  if (UNROUTED_ENTITY_TYPES.has(entityType)) return null;
  if (!isRegisteredTable(entityType)) return "personal";
  const domain = getTableRegistration(entityType).domain;
  return (SYNC_DOMAINS as readonly string[]).includes(domain) ? (domain as SyncDomain) : null;
};

/** The entity types a sidecar row can carry for `domain` (registered tables only). */
export const entityTypesOfDomain = (domain: SyncDomain): string[] => tablesInDomain(domain);

/**
 * Keys of the settings of `personal` and `finance` scope that differ from their defaults, the
 * app-managed markers aside. `current` is the normalized settings object.
 */
export const dataSettingKeys = (
  current: Readonly<Record<string, unknown>>,
  defaults: Readonly<Record<string, unknown>> = defaultAppSettings() as unknown as Record<
    string,
    unknown
  >,
): string[] =>
  settingKeys().filter((key) => {
    if (MANAGED_SETTINGS.has(key)) return false;
    const rule = settingRule(key);
    if (rule.scope === "device" || rule.scope === "gtd") return false;
    return canonicalJson(current[key] ?? null) !== canonicalJson(defaults[key] ?? null);
  });

/** What SQLite said, before any decision. Counts exclude seed rows. */
export interface RawProfileData {
  /** Rows of each data table (a table with none may be left out). */
  tables: Readonly<Record<string, number>>;
  /**
   * Sidecar rows found by a probe of one domain's entity types (`label` names the probe, for the
   * explanation). Entity types this build does not know are reported as `personal`.
   */
  sidecars: readonly { table: string; domain: SyncDomain; label: string; count: number }[];
  /** Sidecar rows about settings: the key decides the domain. */
  settingSidecars: readonly { table: string; key: string; count: number }[];
  /** `dataSettingKeys` of the stored settings. */
  settingKeys: readonly string[];
}

export interface ProfileDataSource {
  domain: SyncDomain;
  /** A table name, `table:entityType` for a sidecar, or `setting:key`. */
  source: string;
  count: number;
}

export interface ProfileDataInspection {
  /** Rows per domain, seed rows excluded. */
  counts: ProfileDataCounts;
  /**
   * False when the inspection stopped at the first row of each source (the cheap startup check): a
   * non-zero count then means "at least one", not "exactly this many".
   */
  exact: boolean;
  /** Every non-empty source, in a stable order, for the explanation. */
  sources: ProfileDataSource[];
}

/** Turns raw counts into the per-domain inspection. Pure. */
export const summarizeProfileData = (
  raw: RawProfileData,
  exact: boolean,
): ProfileDataInspection => {
  const counts = emptyProfileDataCounts();
  const sources: ProfileDataSource[] = [];
  const add = (domain: SyncDomain, source: string, count: number) => {
    if (count <= 0) return;
    counts[domain] += count;
    sources.push({ domain, source, count });
  };
  for (const [table, count] of Object.entries(raw.tables)) {
    const registration = getTableRegistration(table);
    if (registration.domain === DEVICE_DOMAIN) continue;
    const domain = registration.domain as SyncDomain;
    if ((SYNC_DOMAINS as readonly string[]).includes(domain)) add(domain, table, count);
  }
  for (const row of raw.sidecars) add(row.domain, `${row.table}:${row.label}`, row.count);
  for (const row of raw.settingSidecars) {
    if (MANAGED_SETTINGS.has(row.key)) continue;
    const domain = domainOfEntityType(SETTING_ENTITY_TYPE, row.key);
    if (domain !== null) add(domain, `${row.table}:setting:${row.key}`, row.count);
  }
  for (const key of raw.settingKeys) {
    const domain = domainOfEntityType(SETTING_ENTITY_TYPE, key);
    if (domain !== null) add(domain, `app_settings:${key}`, 1);
  }
  sources.sort((a, b) =>
    a.domain === b.domain
      ? a.source < b.source
        ? -1
        : a.source > b.source
          ? 1
          : 0
      : SYNC_DOMAINS.indexOf(a.domain) - SYNC_DOMAINS.indexOf(b.domain),
  );
  return { counts, exact, sources };
};

/** The personal and finance counts of an inspection: what a work device must not hold. */
export const foreignToWorkCounts = (
  inspection: Pick<ProfileDataInspection, "counts">,
): { personal: number; finance: number } => ({
  personal: inspection.counts.personal,
  finance: inspection.counts.finance,
});

/** True when the inspection found any personal or finance row (a work database must have none). */
export const hasForeignToWorkData = (inspection: Pick<ProfileDataInspection, "counts">): boolean =>
  FOREIGN_TO_WORK_DOMAINS.some((domain) => inspection.counts[domain] > 0);

/**
 * True when the database holds nothing but migration and seed rows in every domain (the "verified
 * empty joiner" of the spec, which skips the safety backup). Needs an exact-or-not inspection of all
 * three domains. `gtd` rows count: this build has no seeded GTD rows, so any task, project or context
 * (including those the relationship-draw generator creates on a first start) is data.
 */
export const isVerifiedEmptyDatabase = (
  inspection: Pick<ProfileDataInspection, "counts">,
): boolean => SYNC_DOMAINS.every((domain) => inspection.counts[domain] === 0);
