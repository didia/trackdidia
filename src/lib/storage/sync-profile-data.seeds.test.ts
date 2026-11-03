// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { FinanceCategory } from "../../domain/finance";
import {
  DEFAULT_FINANCE_CATEGORIES,
  defaultSeedAsCategory,
  SYSTEM_FINANCE_CATEGORIES,
} from "../finance/default-categories";
import {
  ENTITY_TYPED_SIDECARS,
  SEEDED_FINANCE_CATEGORIES,
  SEEDED_FINANCE_CATEGORY_IDS,
} from "../sync/profile-data";
import { getTableRegistration } from "../sync/registry";
import { createSyncDevice, enableCaptureFully } from "../sync/test-support/two-device-harness";
import type { SyncDevice } from "../sync/test-support/two-device-harness";
import { MemoryRepository } from "./memory-repository";

// SAFETY: every repository here is backed by an isolated `:memory:` SQLite database.

const PHARMACY = "fincat:sante.pharmacie";

/** A device that went through the app's own seeding, as `SettingsPage` and bootstrap do it. */
const seededDevice = async (options: { capture?: boolean } = {}): Promise<SyncDevice> => {
  const probe = await createSyncDevice("Probe", 0, { enableCapture: false });
  await probe.repo.updateSettings((current) => ({ ...current, financeEnabled: true }));
  await probe.repo.seedFinanceDefaultCategories();
  // Finance is switched off again (an enabled finance feature is itself a counted finance setting);
  // the seeding marker the app wrote stays, and is not counted.
  await probe.repo.updateSettings((current) => ({
    ...current,
    financeEnabled: false,
    financeCategoriesSeededAt: "2026-11-02T00:00:00.000Z",
  }));
  if (options.capture !== false) await enableCaptureFully(probe.repo);
  return probe;
};

const finance = async (probe: SyncDevice, exact = true): Promise<number> =>
  (await probe.repo.inspectSyncProfileData({ exact })).counts.finance;

const sourcesOfFinance = async (probe: SyncDevice) =>
  (await probe.repo.inspectSyncProfileData()).sources
    .filter((source) => source.domain === "finance")
    .map((source) => source.source);

const categoryOf = async (probe: SyncDevice, id: string): Promise<FinanceCategory> => {
  const found = (await probe.repo.listFinanceCategories(true)).find((c) => c.id === id);
  if (!found) throw new Error(`no category ${id}`);
  return found;
};

describe("a seeded finance category is not data only while it is unmodified", () => {
  it("REGRESSION: a renamed default category makes the database a finance database", async () => {
    // Exactly the reported scenario: enable finance, seed, rename through the repository, disable finance,
    // enable capture.
    const probe = await seededDevice({ capture: false });
    const pharmacy = await categoryOf(probe, PHARMACY);
    await probe.repo.saveFinanceCategory({ ...pharmacy, name: "Antidépresseurs de Marie" });
    await probe.repo.updateSettings((current) => ({
      ...current,
      financeEnabled: false,
      financeCategoriesSeededAt: "",
    }));
    await enableCaptureFully(probe.repo);

    for (const exact of [true, false]) {
      const inspection = await probe.repo.inspectSyncProfileData({ exact });
      expect(inspection.counts.finance, `exact ${exact}`).toBeGreaterThan(0);
      expect(inspection.counts.personal).toBe(0);
    }
    const exactLook = await probe.repo.inspectSyncProfileData();
    // The row itself, and its clock and content hash (the sidecars of a modified seed count too).
    expect(exactLook.sources.map((s) => s.source)).toEqual(
      expect.arrayContaining([
        "finance_categories",
        "sync_entity_meta:finance entities",
        "sync_entity_snapshot:finance entities",
      ]),
    );
    expect(exactLook.counts.finance).toBe(3);
    // Only the renamed one: the other 50-odd seeds still do not count.
    const rows = await probe.db.select<{ id: string }[]>(
      "SELECT id FROM finance_categories WHERE name = 'Antidépresseurs de Marie'",
    );
    expect(rows).toEqual([{ id: PHARMACY }]);
  });

  it("a pristine database passes after app seeding, migrations, capture and a no-op save", async () => {
    const probe = await seededDevice();
    for (const exact of [true, false]) expect(await finance(probe, exact)).toBe(0);
    // A save that changes nothing rewrites updated_at (and the clock), not the content.
    for (const id of [PHARMACY, "fincat:transfert", "fincat:non-categorise"]) {
      await probe.repo.saveFinanceCategory(await categoryOf(probe, id));
    }
    for (const exact of [true, false]) {
      expect((await probe.repo.inspectSyncProfileData({ exact })).counts).toEqual({
        gtd: 0,
        personal: 0,
        finance: 0,
      });
    }
  });

  it("a really fresh migrated database (system categories only) passes, with and without capture", async () => {
    for (const enableCapture of [false, true]) {
      const probe = await createSyncDevice("Probe", 0, { enableCapture });
      expect(await finance(probe)).toBe(0);
      expect(await finance(probe, false)).toBe(0);
    }
  });

  const modifications: [string, string, string, unknown][] = [
    ["name", PHARMACY, "name", "Médicaments"],
    ["parent", PHARMACY, "parent_id", "fincat:logement"],
    ["parent cleared", "fincat:sante.pharmacie", "parent_id", null],
    ["kind", PHARMACY, "kind", "income"],
    ["archived", PHARMACY, "archived", 1],
    ["system flag", PHARMACY, "is_system", 1],
    ["defers to next month", PHARMACY, "defers_to_next_month", 1],
    ["sort order", PHARMACY, "sort_order", 99],
    ["a system category's name", "fincat:transfert", "name", "Virements privés"],
    ["a system category's sort order", "fincat:split", "sort_order", 7],
    ["a system category archived", "fincat:non-categorise", "archived", 1],
  ];
  for (const [label, id, column, value] of modifications) {
    it(`${label}: counted by the exact look AND by the cheap probe, and uncounted again once restored`, async () => {
      const probe = await seededDevice();
      const original = await probe.db.select<Record<string, unknown>[]>(
        "SELECT * FROM finance_categories WHERE id = $1",
        [id],
      );
      await probe.db.execute(`UPDATE finance_categories SET ${column} = $1 WHERE id = $2`, [
        value,
        id,
      ]);
      expect(await finance(probe), "exact").toBeGreaterThan(0);
      expect(await finance(probe, false), "cheap probe").toBeGreaterThan(0);
      await probe.db.execute(`UPDATE finance_categories SET ${column} = $1 WHERE id = $2`, [
        original[0]?.[column] ?? null,
        id,
      ]);
      // The capture triggers marked it dirty; a stamped, restored seed is the seed again, but the
      // clocks it picked up while modified are still only clocks and a hash.
      await probe.stamp();
      expect(await finance(probe), "after restore").toBe(0);
      expect(await finance(probe, false)).toBe(0);
    });
  }

  it("timestamps are the only columns left out: a changed updated_at or created_at does not count", async () => {
    const probe = await seededDevice();
    await probe.db.execute(
      "UPDATE finance_categories SET updated_at = '2030-01-01T00:00:00.000Z', created_at = '2001-01-01T00:00:00.000Z'",
    );
    await probe.stamp();
    expect(await finance(probe)).toBe(0);
  });

  it("a seeded category that was deleted counts through its tombstone, edited first or not", async () => {
    const pristineDelete = await seededDevice();
    await pristineDelete.db.execute("DELETE FROM finance_categories WHERE id = $1", [PHARMACY]);
    await pristineDelete.stamp();
    const tombstone = await pristineDelete.db.select<{ deleted_at: string | null }[]>(
      "SELECT deleted_at FROM sync_entity_meta WHERE entity_id = $1",
      [PHARMACY],
    );
    expect(tombstone[0]?.deleted_at).not.toBeNull();
    for (const exact of [true, false])
      expect(await finance(pristineDelete, exact)).toBeGreaterThan(0);

    const editedThenDeleted = await seededDevice();
    await editedThenDeleted.repo.saveFinanceCategory({
      ...(await categoryOf(editedThenDeleted, PHARMACY)),
      name: "Secret",
    });
    await editedThenDeleted.db.execute("DELETE FROM finance_categories WHERE id = $1", [PHARMACY]);
    await editedThenDeleted.stamp();
    for (const exact of [true, false]) {
      expect(await finance(editedThenDeleted, exact)).toBeGreaterThan(0);
    }
  });

  it("a seed row that is simply missing (never restored) has no live row to vouch for its sidecars", async () => {
    const probe = await seededDevice();
    // Remove the row behind the triggers' back: only its meta and snapshot remain.
    await probe.db.execute("DROP TRIGGER IF EXISTS trg_sync_cap_finance_categories_delete");
    const triggers = await probe.db.select<{ name: string }[]>(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE '%finance_categories%'",
    );
    for (const { name } of triggers) await probe.db.execute(`DROP TRIGGER IF EXISTS "${name}"`);
    await probe.db.execute("DELETE FROM finance_categories WHERE id = $1", [PHARMACY]);
    // Its clock and content hash remain, with nothing alive to vouch for them.
    expect(await finance(probe, false)).toBeGreaterThan(0);
    expect(await sourcesOfFinance(probe)).toEqual([
      "sync_entity_meta:finance entities",
      "sync_entity_snapshot:finance entities",
    ]);
  });
});

describe("the sidecars of a seeded category are exempt only while its live row is pristine and they retain nothing", () => {
  const sourcesOf = async (probe: SyncDevice) =>
    (await probe.repo.inspectSyncProfileData()).sources
      .filter((source) => source.domain === "finance")
      .map((source) => source.source);

  it("a retained deleted value on a live pristine row is not the shipped seed: counted (meta)", async () => {
    const probe = await seededDevice();
    const seed = JSON.stringify(SEEDED_FINANCE_CATEGORIES.find((c) => c.id === PHARMACY));
    await probe.db.execute(
      "UPDATE sync_entity_meta SET deleted_row_json = $1 WHERE entity_type = 'finance_categories' AND entity_id = $2",
      [seed, PHARMACY],
    );
    expect(await sourcesOf(probe)).toEqual(["sync_entity_meta:finance entities"]);
    expect(await finance(probe, false)).toBe(1);
  });

  it("a tombstone mark on a live pristine row (deleted_at set) is counted", async () => {
    const probe = await seededDevice();
    await probe.db.execute(
      "UPDATE sync_entity_meta SET deleted_at = '0000000000001-0000-x' WHERE entity_type = 'finance_categories' AND entity_id = $1",
      [PHARMACY],
    );
    expect(await sourcesOf(probe)).toEqual(["sync_entity_meta:finance entities"]);
  });

  it("a snapshot that keeps a value is counted", async () => {
    const probe = await seededDevice();
    await probe.db.execute(
      "UPDATE sync_entity_snapshot SET snapshot_json = '{\"name\":\"Pharmacie\"}' WHERE entity_type = 'finance_categories' AND entity_id = $1",
      [PHARMACY],
    );
    expect(await sourcesOf(probe)).toEqual(["sync_entity_snapshot:finance entities"]);
  });

  it("a delete mark that kept the deleted row is counted", async () => {
    const probe = await seededDevice();
    await probe.db.execute(
      "INSERT INTO sync_dirty (entity_type, entity_id, op, old_row) VALUES ('finance_categories', $1, 'upsert', '{}')",
      [PHARMACY],
    );
    expect(await sourcesOf(probe)).toEqual(["sync_dirty:finance entities"]);
    await probe.db.execute("DELETE FROM sync_dirty");
    // ... while a plain mark of a pristine seed (no retained value) is not.
    await probe.db.execute(
      "INSERT INTO sync_dirty (entity_type, entity_id, op) VALUES ('finance_categories', $1, 'upsert')",
      [PHARMACY],
    );
    expect(await finance(probe)).toBe(0);
  });

  it("a conflict or an alias about a seeded category is always counted (a conflict keeps both versions)", async () => {
    const probe = await seededDevice();
    await probe.db.execute(
      `INSERT INTO sync_conflicts (id, entity_type, entity_id, kind, local_json, remote_json, detected_at)
       VALUES ('c1', 'finance_categories', $1, 'overwritten_edit', '{"name":"Pharmacie"}', '{"name":"Médicaments"}', 'x')`,
      [PHARMACY],
    );
    expect(await sourcesOf(probe)).toEqual(["sync_conflicts:finance entities"]);
    await probe.db.execute("DELETE FROM sync_conflicts");
    await probe.db.execute(
      `INSERT INTO sync_id_aliases (entity_type, alias_id, canonical_id, recorded_hlc)
       VALUES ('finance_categories', $1, 'fincat:aaa', '0000000000001-0000-x')`,
      [PHARMACY],
    );
    expect(await sourcesOf(probe)).toEqual(["sync_id_aliases:finance entities"]);
  });

  it("the sidecars of a MODIFIED seed count with it, and stop counting when the row is restored", async () => {
    const probe = await seededDevice();
    await probe.repo.saveFinanceCategory({
      ...(await categoryOf(probe, PHARMACY)),
      name: "Secret",
    });
    expect(await sourcesOf(probe)).toEqual(
      expect.arrayContaining([
        "finance_categories",
        "sync_entity_meta:finance entities",
        "sync_entity_snapshot:finance entities",
      ]),
    );
    await probe.repo.saveFinanceCategory({
      ...(await categoryOf(probe, PHARMACY)),
      name: DEFAULT_FINANCE_CATEGORIES.find((c) => c.id === PHARMACY)?.name as string,
    });
    expect(await finance(probe)).toBe(0);
  });

  it("a non-seed category id is never exempt, whatever else holds", async () => {
    const probe = await seededDevice();
    await probe.db.execute(
      `INSERT INTO sync_entity_meta (entity_type, entity_id, field_clocks_json, row_hlc)
       VALUES ('finance_categories', 'fincat:mine', '{}', '0000000000001-0000-x')`,
    );
    expect(await finance(probe, false)).toBe(1);
  });

  it("finance categories merge as whole rows, which is why no retained value is expected", () => {
    expect(getTableRegistration("finance_categories").mergeClass).toBe("row-clock");
    // Only the three tables that can keep values get the "no retained value" exemption.
    expect(
      ENTITY_TYPED_SIDECARS.filter((s) => s.seedExemptWhenNoValues !== null).map((s) => s.table),
    ).toEqual(["sync_entity_meta", "sync_entity_snapshot", "sync_dirty"]);
  });
});

describe("the seed definition is the one the app seeds from", () => {
  const content = (c: FinanceCategory) => ({
    id: c.id,
    name: c.name,
    parentId: c.parentId,
    kind: c.kind,
    archived: c.archived,
    isSystem: c.isSystem,
    defersToNextMonth: c.defersToNextMonth,
    sortOrder: c.sortOrder,
  });

  it("a migrated database holds exactly SYSTEM_FINANCE_CATEGORIES (migration 37), timestamps included", async () => {
    const probe = await createSyncDevice("Probe", 0, { enableCapture: false });
    const stored = await probe.repo.listFinanceCategories(true);
    expect(stored.map(content)).toEqual(
      expect.arrayContaining(SYSTEM_FINANCE_CATEGORIES.map(content)),
    );
    for (const system of SYSTEM_FINANCE_CATEGORIES) {
      expect(stored.find((c) => c.id === system.id)).toEqual(system);
    }
    expect(stored).toHaveLength(SYSTEM_FINANCE_CATEGORIES.length);
  });

  it("seedFinanceDefaultCategories stores exactly the default taxonomy, on both repositories", async () => {
    const probe = await seededDevice({ capture: false });
    const memory = new MemoryRepository();
    await memory.initialize();
    await memory.seedFinanceDefaultCategories();
    for (const repo of [probe.repo, memory]) {
      const stored = await repo.listFinanceCategories(true);
      for (const seed of DEFAULT_FINANCE_CATEGORIES) {
        expect(content(stored.find((c) => c.id === seed.id) as FinanceCategory)).toEqual(
          content(defaultSeedAsCategory(seed)),
        );
      }
      expect(stored.map((c) => c.id).sort()).toEqual([...SEEDED_FINANCE_CATEGORY_IDS].sort());
    }
  });

  it("the memory store starts from the same system categories", async () => {
    const memory = new MemoryRepository();
    await memory.initialize();
    expect((await memory.listFinanceCategories(true)).map(content)).toEqual(
      SYSTEM_FINANCE_CATEGORIES.map(content),
    );
  });
});
