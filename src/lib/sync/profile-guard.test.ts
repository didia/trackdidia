// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createEmptyDailyEntry } from "../../domain/daily-entry";
import { MemoryRepository } from "../storage/memory-repository";
import type { SyncChangeSet } from "./change-set";
import { SyncApplyError } from "./errors";
import {
  assertChangeSetAllowedForProfile,
  assertDomainAllowedFor,
  profileOfStoredSettings,
  readStoredProfile,
} from "./profile-guard";
import { financeAccount } from "./test-support/finance-fixtures";
import { createSyncHarness, type SyncDevice } from "./test-support/two-device-harness";

// SAFETY: in-memory SQLite only (see the two-device harness).

const emptySet = (overrides: Partial<SyncChangeSet> = {}): SyncChangeSet => ({
  formatVersion: 2,
  deviceId: "dev:00000000-0000-4000-8000-000000000001",
  domain: "gtd",
  schemaVersion: 48,
  hlcHigh: "0000000000000-0000-dev:00000000-0000-4000-8000-000000000001",
  entities: [],
  unionRows: {},
  settings: [],
  recurrence: { occurrences: [], clears: [] },
  aliases: [],
  ...overrides,
});

const asWork = async (device: SyncDevice): Promise<void> => {
  await device.repo.updateSettings((current) => ({ ...current, syncProfile: "work" }));
};

const code = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
    return "resolved";
  } catch (error) {
    return error instanceof SyncApplyError ? error.code : `other:${String(error)}`;
  }
};

describe("profileOfStoredSettings", () => {
  it("reads the persisted profile", () => {
    expect(profileOfStoredSettings(JSON.stringify({ syncProfile: "work" }))).toBe("work");
    expect(profileOfStoredSettings(JSON.stringify({ syncProfile: "personal" }))).toBe("personal");
  });

  it("is personal for a settings row that predates the key, and for no row", () => {
    expect(profileOfStoredSettings(JSON.stringify({ language: "fr" }))).toBe("personal");
    expect(profileOfStoredSettings(undefined)).toBe("personal");
    expect(profileOfStoredSettings(null)).toBe("personal");
  });

  it("refuses a stored value that is not a profile instead of defaulting to the permissive one", () => {
    for (const value of ["admin", "", 7, null, true]) {
      expect(
        () => profileOfStoredSettings(JSON.stringify({ syncProfile: value })),
        String(value),
      ).toThrow(expect.objectContaining({ code: "profile_unknown" }));
    }
    expect(() => profileOfStoredSettings("{not json")).toThrow(
      expect.objectContaining({ code: "profile_unknown" }),
    );
  });
});

describe("assertDomainAllowedFor", () => {
  it("lets a personal device handle every domain and a work device only gtd", () => {
    for (const domain of ["gtd", "personal", "finance"] as const) {
      expect(() => assertDomainAllowedFor("personal", domain)).not.toThrow();
    }
    expect(() => assertDomainAllowedFor("work", "gtd")).not.toThrow();
    for (const domain of ["personal", "finance"] as const) {
      expect(() => assertDomainAllowedFor("work", domain)).toThrow(
        expect.objectContaining({ code: "domain_not_allowed" }),
      );
    }
  });
});

describe("assertChangeSetAllowedForProfile", () => {
  const row = { id: "x" };
  const entity = (table: string, withRow: boolean) => ({
    table,
    entityId: JSON.stringify(["x"]),
    row: withRow ? row : null,
    fieldClocks: {},
    rowHlc: "0",
    deletedAt: withRow ? null : "0",
  });

  it("passes an empty and a gtd-only change set on a work device", () => {
    expect(() => assertChangeSetAllowedForProfile(emptySet(), "work")).not.toThrow();
    expect(() =>
      assertChangeSetAllowedForProfile(
        emptySet({ entities: [entity("gtd_tasks", true), entity("gtd_projects", false)] as never }),
        "work",
      ),
    ).not.toThrow();
  });

  it("refuses a personal or finance label before looking at anything else", () => {
    for (const domain of ["personal", "finance"] as const) {
      expect(() => assertChangeSetAllowedForProfile(emptySet({ domain }), "work")).toThrow(
        expect.objectContaining({ code: "domain_not_allowed" }),
      );
      expect(() =>
        assertChangeSetAllowedForProfile(emptySet({ domain }), "personal"),
      ).not.toThrow();
    }
  });

  it("refuses a gtd-labelled set that carries a personal ROW, a finance TOMBSTONE, union rows, an alias or a setting", () => {
    const cases: [string, Partial<SyncChangeSet>][] = [
      ["a personal row", { entities: [entity("daily_entries", true)] as never }],
      ["a finance tombstone", { entities: [entity("finance_transactions", false)] as never }],
      ["union rows", { unionRows: { ai_messages: [{ id: "m" }] } as never }],
      [
        "an alias",
        {
          aliases: [
            {
              entity_type: "finance_accounts",
              alias_id: "b",
              canonical_id: "a",
              recorded_hlc: "0",
            },
          ],
        },
      ],
      ["a personal setting", { settings: [{ key: "aiModel", value: "x", clock: "0" }] as never }],
      [
        "a finance conflict",
        { conflicts: [{ entity_type: "finance_accounts", entity_id: "private" }] as never },
      ],
      ["a device table", { entities: [entity("sync_identity", true)] as never }],
    ];
    for (const [name, overrides] of cases) {
      expect(() => assertChangeSetAllowedForProfile(emptySet(overrides), "work"), name).toThrow(
        expect.objectContaining({ code: "domain_not_allowed" }),
      );
    }
  });

  it("lets a gtd-scope setting and a gtd alias through on a work device", () => {
    expect(() =>
      assertChangeSetAllowedForProfile(
        emptySet({
          settings: [{ key: "language", value: "fr", clock: "0" }] as never,
          aliases: [
            { entity_type: "gtd_tasks", alias_id: "b", canonical_id: "a", recorded_hlc: "0" },
          ],
        }),
        "work",
      ),
    ).not.toThrow();
  });
});

describe("the repository applies the PERSISTED profile, whatever the caller passes", () => {
  it("a work device refuses a personal and a finance bundle and keeps its database untouched", async () => {
    const sim = await createSyncHarness(["A", "W"]);
    const [a, w] = sim.devices as [SyncDevice, SyncDevice];
    await a.repo.saveDailyEntry(createEmptyDailyEntry("2026-10-01"));
    await a.repo.saveFinanceAccount(financeAccount({ id: "account-1" }));
    await asWork(w);
    const personal = await a.repo.listSyncChanges("personal");
    const finance = await a.repo.listSyncChanges("finance");
    const before = JSON.stringify(
      await w.db.select("SELECT * FROM sync_entity_meta ORDER BY entity_type, entity_id"),
    );

    expect(await code(w.repo.applySyncBundle("personal", personal))).toBe("domain_not_allowed");
    expect(await code(w.repo.applySyncBundle("finance", finance))).toBe("domain_not_allowed");
    // Also with the options a republishing engine passes.
    expect(await code(w.repo.applySyncBundle("personal", personal, { republish: true }))).toBe(
      "domain_not_allowed",
    );

    const rows = await w.db.select<{ n: number }[]>("SELECT COUNT(*) AS n FROM daily_entries");
    expect(Number(rows[0]?.n)).toBe(0);
    expect(
      JSON.stringify(
        await w.db.select("SELECT * FROM sync_entity_meta ORDER BY entity_type, entity_id"),
      ),
    ).toBe(before);
    expect((await w.repo.inspectSyncProfileData()).counts).toEqual({
      gtd: 0,
      personal: 0,
      finance: 0,
    });
  });

  it("a work device still applies a gtd bundle, and a personal device still applies all three", async () => {
    const sim = await createSyncHarness(["A", "W", "B"]);
    const [a, w, b] = sim.devices as [SyncDevice, SyncDevice, SyncDevice];
    await asWork(w);
    await a.repo.createTask({ id: "t1", title: "Plan", bucket: "inbox" });
    await a.repo.saveDailyEntry(createEmptyDailyEntry("2026-10-01"));
    await a.repo.saveFinanceAccount(financeAccount({ id: "account-1" }));

    await sim.exchange(a, w, "gtd");
    expect((await w.repo.listTasks({ includeCompleted: true })).map((task) => task.id)).toContain(
      "t1",
    );
    for (const domain of ["gtd", "personal", "finance"] as const) await sim.exchange(a, b, domain);
    expect(await b.repo.getDailyEntry("2026-10-01")).not.toBeNull();
  });

  it("a stored profile that is not a profile refuses the apply", async () => {
    const sim = await createSyncHarness(["A", "W"]);
    const [a, w] = sim.devices as [SyncDevice, SyncDevice];
    await a.repo.createTask({ id: "t1", title: "Plan", bucket: "inbox" });
    const gtd = await a.repo.listSyncChanges("gtd");
    const stored = await w.db.select<{ value: string }[]>(
      "SELECT value FROM app_settings WHERE id = 1",
    );
    await w.db.execute("UPDATE app_settings SET value = $1 WHERE id = 1", [
      JSON.stringify({ ...JSON.parse(stored[0]?.value ?? "{}"), syncProfile: "everything" }),
    ]);
    expect(await code(w.repo.applySyncBundle("gtd", gtd))).toBe("profile_unknown");
    expect(await readStoredProfile(w.db).catch((e: SyncApplyError) => e.code)).toBe(
      "profile_unknown",
    );
  });

  it("the check reads the profile at apply time: switching the setting changes the verdict", async () => {
    const sim = await createSyncHarness(["A", "W"]);
    const [a, w] = sim.devices as [SyncDevice, SyncDevice];
    await a.repo.saveDailyEntry(createEmptyDailyEntry("2026-10-01"));
    const personal = await a.repo.listSyncChanges("personal");
    await asWork(w);
    expect(await code(w.repo.applySyncBundle("personal", personal))).toBe("domain_not_allowed");
    await w.repo.updateSettings((current) => ({ ...current, syncProfile: "personal" }));
    expect(await code(w.repo.applySyncBundle("personal", personal))).toBe("resolved");
  });

  it("browser preview follows the sync-unavailable convention for every sync entry point", async () => {
    const memory = new MemoryRepository();
    await memory.initialize();
    await expect(memory.applySyncBundle("gtd", emptySet())).rejects.toThrow();
    await expect(memory.listSyncChanges("gtd")).rejects.toThrow();
    await expect(memory.inspectSyncProfileData()).rejects.toThrow();
  });
});
