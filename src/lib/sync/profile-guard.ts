import type { Database } from "../storage/sqlite-db";
import type { SyncChangeSet } from "./change-set";
import { SyncApplyError } from "./errors";
import { type DeviceProfile, domainsReadable, isDeviceProfile } from "./profile";
import { domainOfEntityType } from "./profile-data";
import {
  domainOfTable,
  isRegisteredSetting,
  SYNC_DOMAINS,
  type SyncDomain,
  settingRule,
} from "./registry";

/**
 * Layer 3 of the work-profile isolation, inside the repository (spec "Work profile": "What gets
 * applied"). The engine already refuses a domain the profile may not read; this is the check that
 * still holds when something else calls `applySyncBundle`, so it does not trust the caller: it reads the profile from the persisted device setting
 * (`syncProfile`, device-local, never merged from a peer) inside the same write slot and judges the
 * whole change set, not only its `domain` label.
 *
 * There is deliberately no parameter to pass a profile in. Unknown stored profiles refuse everything
 * (`profile_unknown`); a settings row that predates the key (no `syncProfile` at all) is `personal`,
 * which is what every database was before the key existed.
 */

/** The profile a stored settings blob names. Throws `SyncApplyError("profile_unknown")`. */
export const profileOfStoredSettings = (stored: string | null | undefined): DeviceProfile => {
  if (stored === null || stored === undefined) return "personal";
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    throw new SyncApplyError("profile_unknown", "The stored settings are not readable JSON");
  }
  const value =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>).syncProfile
      : undefined;
  if (value === undefined) return "personal";
  if (!isDeviceProfile(value)) {
    throw new SyncApplyError(
      "profile_unknown",
      `The stored sync profile "${String(value)}" is not a device profile; nothing is applied`,
    );
  }
  return value;
};

/** Reads the persisted device profile on an open database or transaction. */
export const readStoredProfile = async (db: Database): Promise<DeviceProfile> => {
  const rows = await db.select<{ value: string }[]>("SELECT value FROM app_settings WHERE id = 1");
  return profileOfStoredSettings(rows[0]?.value);
};

/** Refuses a domain this profile may not read, apply or publish. */
export const assertDomainAllowedFor = (profile: DeviceProfile, domain: SyncDomain): void => {
  const allowed = domainsReadable(profile);
  if (!allowed.includes(domain)) {
    throw new SyncApplyError(
      "domain_not_allowed",
      `The "${domain}" domain is not allowed on a ${profile} device (allowed: ${allowed.join(", ") || "none"})`,
    );
  }
};

/**
 * Refuses a change set that carries anything of a domain the profile may not hold: its label, and
 * then every entity and tombstone (by table), union row set, alias (by entity type) and setting (by
 * key). Independent of `validateChangeSet`, which already ties these to the label: a validator that
 * missed a case must not be the only thing between a personal row and a work database.
 */
export const assertChangeSetAllowedForProfile = (
  changeSet: SyncChangeSet,
  profile: DeviceProfile,
): void => {
  assertDomainAllowedFor(profile, changeSet.domain);
  const allowed = domainsReadable(profile);
  const refuse = (
    what: string,
    domain: string | null,
    table?: string,
    entityId?: string,
  ): never => {
    throw new SyncApplyError(
      "domain_not_allowed",
      `The change set carries ${what} of the "${domain ?? "unclassified"}" domain, which a ${profile} device never holds; the whole bundle is refused`,
      { table: table ?? null, entityId: entityId ?? null },
    );
  };
  const check = (domain: SyncDomain | null, what: string, table?: string, entityId?: string) => {
    if (domain === null || !allowed.includes(domain)) refuse(what, domain, table, entityId);
  };
  const tableDomain = (table: string): SyncDomain | null => {
    const domain = domainOfTable(table);
    return (SYNC_DOMAINS as readonly string[]).includes(domain) ? (domain as SyncDomain) : null;
  };
  for (const entity of changeSet.entities) {
    check(
      tableDomain(entity.table),
      entity.row === null ? "a tombstone" : "a row",
      entity.table,
      entity.entityId,
    );
  }
  for (const table of Object.keys(changeSet.unionRows)) {
    check(tableDomain(table), "rows", table);
  }
  for (const alias of changeSet.aliases) {
    check(domainOfEntityType(alias.entity_type), "an alias", alias.entity_type, alias.alias_id);
  }
  for (const entry of changeSet.settings) {
    const scope = isRegisteredSetting(entry.key) ? settingRule(entry.key).scope : "device";
    check(scope === "device" ? null : scope, "a setting", "app_settings", entry.key);
  }
};
