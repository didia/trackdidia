// @vitest-environment node
import { describe, expect, it } from "vitest";
import { defaultAppSettings } from "../../domain/settings";
import { DEFAULT_FINANCE_CATEGORIES } from "../finance/default-categories";
import {
  APP_MANAGED_SETTING_KEYS,
  dataSettingKeys,
  domainOfEntityType,
  emptyProfileDataCounts,
  hasForeignToWorkData,
  isVerifiedEmptyDatabase,
  KNOWN_ENTITY_TYPES,
  type RawProfileData,
  SEEDED_FINANCE_CATEGORY_IDS,
  summarizeProfileData,
} from "./profile-data";
import { settingKeys, settingRule, SYNC_DOMAINS, TABLE_REGISTRY, tablesInDomain } from "./registry";

const raw = (overrides: Partial<RawProfileData> = {}): RawProfileData => ({
  tables: {},
  sidecars: [],
  settingSidecars: [],
  settingKeys: [],
  ...overrides,
});

describe("seed rows", () => {
  it("names the three finance system categories and the whole default taxonomy", () => {
    expect(SEEDED_FINANCE_CATEGORY_IDS).toEqual(
      expect.arrayContaining(["fincat:non-categorise", "fincat:transfert", "fincat:split"]),
    );
    for (const category of DEFAULT_FINANCE_CATEGORIES) {
      expect(SEEDED_FINANCE_CATEGORY_IDS).toContain(category.id);
    }
    expect(new Set(SEEDED_FINANCE_CATEGORY_IDS).size).toBe(SEEDED_FINANCE_CATEGORY_IDS.length);
  });

  it("only treats settings of the personal and finance scope as app-managed markers", () => {
    for (const key of APP_MANAGED_SETTING_KEYS) {
      expect(["personal", "finance"], key).toContain(settingRule(key).scope);
    }
  });
});

describe("domainOfEntityType", () => {
  it("routes a registered table to its domain", () => {
    expect(domainOfEntityType("gtd_tasks")).toBe("gtd");
    expect(domainOfEntityType("daily_entries")).toBe("personal");
    expect(domainOfEntityType("finance_transactions")).toBe("finance");
    expect(domainOfEntityType("pomodoro_sessions")).toBe("gtd");
  });

  it("routes a setting by its key, and device or secret settings nowhere", () => {
    expect(domainOfEntityType("setting", "language")).toBe("gtd");
    expect(domainOfEntityType("setting", "aiModel")).toBe("personal");
    expect(domainOfEntityType("setting", "financeEnabled")).toBe("finance");
    expect(domainOfEntityType("setting", "aiApiKey")).toBeNull();
    expect(domainOfEntityType("setting", "multiDeviceSyncEnabled")).toBeNull();
  });

  it("counts what it cannot classify as personal, the private side", () => {
    expect(domainOfEntityType("table_from_a_newer_build")).toBe("personal");
    expect(domainOfEntityType("setting", "keyFromANewerBuild")).toBe("personal");
    expect(domainOfEntityType("setting")).toBe("personal");
  });

  it("routes device-local entities and the settings blob's mark nowhere", () => {
    expect(domainOfEntityType("app_settings")).toBeNull();
    expect(domainOfEntityType("calendar_sync_links")).toBeNull();
    expect(domainOfEntityType("sync_entity_meta")).toBeNull();
  });

  it("knows every registered table, the settings and the settings blob", () => {
    for (const entry of TABLE_REGISTRY) expect(KNOWN_ENTITY_TYPES).toContain(entry.table);
    expect(KNOWN_ENTITY_TYPES).toContain("setting");
    expect(KNOWN_ENTITY_TYPES).toContain("app_settings");
  });
});

describe("dataSettingKeys", () => {
  const defaults = defaultAppSettings() as unknown as Record<string, unknown>;
  const withValues = (values: Record<string, unknown>) => ({ ...defaults, ...values });

  it("is empty for the defaults", () => {
    expect(dataSettingKeys(defaults)).toEqual([]);
  });

  it("ignores the markers the application writes itself", () => {
    const managed = Object.fromEntries(
      APP_MANAGED_SETTING_KEYS.map((key) => [key, "2026-11-02T00:00:00.000Z"]),
    );
    expect(dataSettingKeys(withValues(managed))).toEqual([]);
  });

  it("counts a personal or finance setting that was changed", () => {
    expect(
      dataSettingKeys(
        withValues({ aiEnabled: true, financeEnabled: true, aiPulseSlots: [1, 2], aiModel: "x/y" }),
      ).sort(),
    ).toEqual(["aiEnabled", "aiModel", "aiPulseSlots", "financeEnabled"]);
  });

  it("ignores gtd-scope and device-scope settings, whatever their value", () => {
    expect(
      dataSettingKeys(
        withValues({
          language: "en",
          gtdImportDoneAt: "x",
          aiApiKey: "sk-secret",
          backupDestinationDir: "/somewhere",
          syncProfile: "work",
          multiDeviceSyncEnabled: true,
        }),
      ),
    ).toEqual([]);
  });

  it("covers every personal and finance key the registry knows", () => {
    const expected = settingKeys().filter((key) => {
      const scope = settingRule(key).scope;
      return (
        (scope === "personal" || scope === "finance") &&
        !APP_MANAGED_SETTING_KEYS.includes(key as never)
      );
    });
    const different = Object.fromEntries(expected.map((key) => [key, "__changed__"]));
    expect(dataSettingKeys(withValues(different)).sort()).toEqual([...expected].sort());
  });
});

describe("summarizeProfileData", () => {
  it("is all zero for nothing", () => {
    const inspection = summarizeProfileData(raw(), true);
    expect(inspection).toEqual({ counts: emptyProfileDataCounts(), exact: true, sources: [] });
    expect(isVerifiedEmptyDatabase(inspection)).toBe(true);
    expect(hasForeignToWorkData(inspection)).toBe(false);
  });

  it("adds tables, sidecars and settings up per domain", () => {
    const inspection = summarizeProfileData(
      raw({
        tables: { gtd_tasks: 4, daily_entries: 2, finance_transactions: 7 },
        sidecars: [
          { table: "sync_entity_meta", domain: "personal", label: "personal entities", count: 3 },
          { table: "sync_conflicts", domain: "finance", label: "finance entities", count: 1 },
        ],
        settingSidecars: [
          { table: "sync_entity_meta", key: "aiModel", count: 1 },
          { table: "sync_entity_meta", key: "language", count: 1 },
          { table: "sync_entity_meta", key: "aiApiKey", count: 1 },
        ],
        settingKeys: ["aiEnabled", "financeEnabled"],
      }),
      true,
    );
    expect(inspection.counts).toEqual({ gtd: 5, personal: 2 + 3 + 1 + 1, finance: 7 + 1 + 1 });
    expect(hasForeignToWorkData(inspection)).toBe(true);
    expect(isVerifiedEmptyDatabase(inspection)).toBe(false);
    expect(inspection.sources.map((source) => source.source)).toContain("daily_entries");
    expect(inspection.sources.map((source) => source.source)).toContain(
      "sync_entity_meta:setting:aiModel",
    );
  });

  it("does not count a managed setting's clock row, nor a device setting's", () => {
    const inspection = summarizeProfileData(
      raw({
        settingSidecars: [
          { table: "sync_entity_meta", key: "dimancheNotesRelocatedAt", count: 1 },
          { table: "sync_entity_snapshot", key: "dimancheNotesRelocatedAt", count: 1 },
          { table: "sync_entity_meta", key: "backupDestinationDir", count: 1 },
        ],
      }),
      true,
    );
    expect(inspection.counts).toEqual(emptyProfileDataCounts());
  });

  it("lists sources in domain order, then by name, so reports are stable", () => {
    const inspection = summarizeProfileData(
      raw({ tables: { finance_rules: 1, daily_entries: 1, gtd_projects: 1, annual_goals: 1 } }),
      false,
    );
    expect(inspection.sources.map((source) => source.source)).toEqual([
      "gtd_projects",
      "annual_goals",
      "daily_entries",
      "finance_rules",
    ]);
    expect(inspection.exact).toBe(false);
  });

  it("only reads data tables of the bundle domains from the raw tables", () => {
    const counted = summarizeProfileData(
      raw({ tables: Object.fromEntries(tablesInDomain("personal").map((t) => [t, 1])) }),
      true,
    );
    expect(counted.counts.personal).toBe(tablesInDomain("personal").length);
    expect(SYNC_DOMAINS.filter((domain) => counted.counts[domain] > 0)).toEqual(["personal"]);
  });
});
