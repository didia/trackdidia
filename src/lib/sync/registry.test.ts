// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest";
import { defaultAppSettings } from "../../domain/settings";
import { createNodeSqliteDatabase } from "../../test/mocks/node-sqlite-database";
import { runMigrations } from "../storage/migrations";
import { isTableSyncSupported } from "./merge-strategies";
import {
  aliasableTables,
  aliasableTablesInDomain,
  aliasKeysOf,
  assertSettingPublishable,
  assertSidecarPublishable,
  assertTablePublishable,
  BY_ENTITY_TYPE_DOMAIN,
  CLASSIFICATION_DOMAINS,
  domainOfTable,
  getTableRegistration,
  isAliasableTable,
  isEntityTypedSidecar,
  isSecretSetting,
  isSettingPublishable,
  isSidecarPublishable,
  isTablePublishable,
  MERGE_CLASSES,
  publishDomainOfEntityType,
  referencesTo,
  SETTING_ENTITY_TYPE,
  SETTINGS_REGISTRY,
  sidecarPublishDomain,
  settingKeys,
  settingScope,
  settingsKeysInScope,
  SYNC_DOMAINS,
  syncedTables,
  TABLE_REGISTRY,
  tablesInDomain,
  WORK_PROFILE_DOMAINS,
  type NaturalKey,
} from "./registry";

interface ColumnInfo {
  name: string;
  pk: number;
}
interface IndexListRow {
  name: string;
  unique: number;
  origin: string;
  partial: number;
}
interface IndexInfoRow {
  seqno: number;
  cid: number;
  name: string | null;
}
interface ForeignKeyRow {
  table: string;
  from: string;
  on_delete: string;
}

interface SchemaTable {
  columns: ColumnInfo[];
  foreignKeys: ForeignKeyRow[];
  uniqueIndexes: { name: string; origin: string; partial: boolean; columns: (string | null)[] }[];
  indexSql: Map<string, string>;
}

let schema: Map<string, SchemaTable>;

const squash = (text: string): string => text.replace(/\s+/g, " ").trim();
const isBareIdentifier = (column: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(column);

beforeAll(async () => {
  const db = createNodeSqliteDatabase();
  await runMigrations(db);
  const tables = await db.select<{ name: string }[]>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
  );
  const indexSqlRows = await db.select<{ name: string; sql: string | null }[]>(
    "SELECT name, sql FROM sqlite_master WHERE type = 'index'",
  );
  const indexSql = new Map(
    indexSqlRows.filter((row) => row.sql !== null).map((row) => [row.name, squash(row.sql ?? "")]),
  );
  schema = new Map();
  for (const { name } of tables) {
    const columns = await db.select<ColumnInfo[]>(`PRAGMA table_info(${name})`);
    const foreignKeys = await db.select<ForeignKeyRow[]>(`PRAGMA foreign_key_list(${name})`);
    const indexes = await db.select<IndexListRow[]>(`PRAGMA index_list(${name})`);
    const uniqueIndexes: SchemaTable["uniqueIndexes"] = [];
    for (const index of indexes) {
      if (index.unique !== 1 || index.origin === "pk") continue;
      const info = await db.select<IndexInfoRow[]>(`PRAGMA index_info(${index.name})`);
      uniqueIndexes.push({
        name: index.name,
        origin: index.origin,
        partial: index.partial === 1,
        columns: info.sort((a, b) => a.seqno - b.seqno).map((row) => row.name),
      });
    }
    schema.set(name, { columns, foreignKeys, uniqueIndexes, indexSql });
  }
});

const registration = (table: string) => getTableRegistration(table);

describe("table registry completeness", () => {
  it("classifies every table in the fully migrated schema", () => {
    const unclassified = [...schema.keys()].filter(
      (table) => !TABLE_REGISTRY.some((entry) => entry.table === table),
    );
    expect(unclassified).toEqual([]);
  });

  it("has no stale entry for a table that does not exist", () => {
    const stale = TABLE_REGISTRY.map((entry) => entry.table).filter((table) => !schema.has(table));
    expect(stale).toEqual([]);
  });

  it("lists each table once, with a known domain and merge class", () => {
    const names = TABLE_REGISTRY.map((entry) => entry.table);
    expect(new Set(names).size).toBe(names.length);
    for (const entry of TABLE_REGISTRY) {
      expect(CLASSIFICATION_DOMAINS).toContain(entry.domain);
      expect(MERGE_CLASSES).toContain(entry.mergeClass);
    }
  });

  it("keeps domain and merge class consistent (device-local is exactly the device domain)", () => {
    for (const entry of TABLE_REGISTRY) {
      expect(entry.mergeClass === "device-local").toBe(entry.domain === "device");
    }
  });

  it("declares primary keys that match the schema", () => {
    for (const entry of TABLE_REGISTRY) {
      const columns = schema.get(entry.table)?.columns ?? [];
      const actual = columns
        .filter((column) => column.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((column) => column.name);
      expect({ table: entry.table, primaryKey: entry.primaryKey }).toEqual({
        table: entry.table,
        primaryKey: actual,
      });
    }
  });

  it("only names columns that exist", () => {
    for (const entry of TABLE_REGISTRY) {
      const columns = new Set(
        (schema.get(entry.table)?.columns ?? []).map((column) => column.name),
      );
      const named = [
        ...entry.references.map((reference) => reference.column),
        ...(entry.jsonMapColumns ?? []),
        ...(entry.orSetColumns ?? []),
        ...entry.naturalKeys.flatMap((key) => key.columns.filter(isBareIdentifier)),
      ];
      for (const column of named) {
        expect({ table: entry.table, column, exists: columns.has(column) }).toEqual({
          table: entry.table,
          column,
          exists: true,
        });
      }
    }
  });
});

describe("references", () => {
  it("only point at registered tables", () => {
    for (const entry of TABLE_REGISTRY) {
      for (const reference of entry.references) {
        expect({
          from: entry.table,
          to: reference.table,
          known: schema.has(reference.table),
        }).toEqual({
          from: entry.table,
          to: reference.table,
          known: true,
        });
      }
    }
  });

  it("declares every SQL foreign key of every table", () => {
    for (const entry of TABLE_REGISTRY) {
      for (const fk of schema.get(entry.table)?.foreignKeys ?? []) {
        const declared = entry.references.some(
          (reference) => reference.column === fk.from && reference.table === fk.table,
        );
        expect({ table: entry.table, column: fk.from, target: fk.table, declared }).toEqual({
          table: entry.table,
          column: fk.from,
          target: fk.table,
          declared: true,
        });
      }
    }
  });

  it("never lets a gtd table reference a non-gtd table (declared references)", () => {
    for (const table of tablesInDomain("gtd")) {
      for (const reference of registration(table).references) {
        expect({ table, target: reference.table, domain: domainOfTable(reference.table) }).toEqual({
          table,
          target: reference.table,
          domain: "gtd",
        });
      }
    }
  });

  it("never lets a gtd table reference a non-gtd table (PRAGMA foreign_key_list)", () => {
    const gtdTables = new Set(tablesInDomain("gtd"));
    expect(gtdTables.size).toBeGreaterThan(0);
    for (const table of gtdTables) {
      for (const fk of schema.get(table)?.foreignKeys ?? []) {
        expect({ table, target: fk.table, targetIsGtd: gtdTables.has(fk.table) }).toEqual({
          table,
          target: fk.table,
          targetIsGtd: true,
        });
      }
    }
  });

  // Reviewed *_id / *_ids columns on gtd tables that are NOT references to another table.
  const reviewedNonReferenceIdColumns: Record<string, string[]> = {
    // Own primary keys, external source ids and the opaque recurrence group label.
    gtd_tasks: ["id", "source_external_id", "recurrence_group_id"],
    gtd_projects: ["id", "source_external_id"],
    gtd_contexts: ["id"],
    gtd_task_events: ["id"],
    recurring_task_templates: ["id"],
    pomodoro_sessions: ["id"],
    pomodoro_segments: ["id"],
    // device_id names the device that produced the outcome, not a table row.
    sync_recurrence_occurrences: ["device_id"],
  };

  it("accounts for every id-looking column on gtd tables (catches undeclared references)", () => {
    for (const table of tablesInDomain("gtd")) {
      const declared = new Set(registration(table).references.map((reference) => reference.column));
      const reviewed = new Set(reviewedNonReferenceIdColumns[table] ?? []);
      const idColumns = (schema.get(table)?.columns ?? [])
        .map((column) => column.name)
        .filter((name) => /_ids?(_json)?$/.test(name) || name === "id");
      const unaccounted = idColumns.filter((name) => !declared.has(name) && !reviewed.has(name));
      expect({ table, unaccounted }).toEqual({ table, unaccounted: [] });
      // The allowlist itself must not rot: every entry names a real column.
      const columns = new Set((schema.get(table)?.columns ?? []).map((column) => column.name));
      for (const name of reviewed) {
        expect({ table, name, exists: columns.has(name) }).toEqual({ table, name, exists: true });
      }
    }
  });

  // Every id-looking column of every synced table is either a declared reference or reviewed here, so
  // a new column that points at an aliasable entity cannot be forgotten by the alias engine.
  const reviewedNonReferenceIdColumns2: Record<string, string[]> = {
    // The metric source name and the principle key, not rows of another table.
    annual_goals: ["source_id"],
  };

  it("accounts for every id-looking column on every synced table (catches undeclared references)", () => {
    for (const entry of TABLE_REGISTRY) {
      if (!(SYNC_DOMAINS as readonly string[]).includes(entry.domain)) continue;
      if (entry.mergeClass === "sidecar") continue;
      const declared = new Set(entry.references.map((reference) => reference.column));
      const reviewed = new Set([
        ...entry.primaryKey,
        ...(reviewedNonReferenceIdColumns[entry.table] ?? []),
        ...(reviewedNonReferenceIdColumns2[entry.table] ?? []),
      ]);
      const idColumns = (schema.get(entry.table)?.columns ?? [])
        .map((column) => column.name)
        .filter((name) => /_ids?(_json)?$/.test(name) || name === "id");
      const unaccounted = idColumns.filter((name) => !declared.has(name) && !reviewed.has(name));
      expect({ table: entry.table, unaccounted }).toEqual({ table: entry.table, unaccounted: [] });
    }
  });

  it("allows only the reviewed domain edges between synced tables", () => {
    const allowed = new Set(["gtd>gtd", "personal>personal", "personal>gtd", "finance>finance"]);
    for (const entry of TABLE_REGISTRY) {
      if (entry.domain === "device") continue;
      for (const reference of entry.references) {
        const edge = `${entry.domain}>${domainOfTable(reference.table)}`;
        expect({ from: entry.table, to: reference.table, allowed: allowed.has(edge) }).toEqual({
          from: entry.table,
          to: reference.table,
          allowed: true,
        });
      }
    }
  });
});

describe("natural keys", () => {
  // Reviewed differences between the registry and the schema's unique constraints. Empty today.
  const reviewedSchemaOnly: string[] = [];
  const reviewedRegistryOnly: string[] = [];

  const signature = (
    index: string | undefined,
    columns: readonly (string | null)[],
    partial: boolean,
  ): string =>
    [
      index ?? "inline",
      columns
        .map((column) => (column === null || !isBareIdentifier(column) ? "<expr>" : column))
        .join(","),
      partial ? "partial" : "full",
    ].join("|");

  const registrySignature = (key: NaturalKey): string =>
    signature(key.index, key.columns, key.where !== undefined);

  it("equals the schema's UNIQUE constraints and unique indexes for synced tables, both ways", () => {
    for (const table of syncedTables()) {
      const declared = registration(table).naturalKeys.map(registrySignature).sort();
      const actual = (schema.get(table)?.uniqueIndexes ?? [])
        .map((index) =>
          signature(index.origin === "c" ? index.name : undefined, index.columns, index.partial),
        )
        .sort();
      const missingFromRegistry = actual.filter(
        (item) => !declared.includes(item) && !reviewedSchemaOnly.includes(`${table}:${item}`),
      );
      const missingFromSchema = declared.filter(
        (item) => !actual.includes(item) && !reviewedRegistryOnly.includes(`${table}:${item}`),
      );
      expect({ table, missingFromRegistry, missingFromSchema }).toEqual({
        table,
        missingFromRegistry: [],
        missingFromSchema: [],
      });
    }
  });

  it("matches expression columns and partial predicates against the index SQL", () => {
    for (const table of syncedTables()) {
      for (const key of registration(table).naturalKeys) {
        if (key.index === undefined) {
          expect({ key: key.name, hasWhere: key.where !== undefined }).toEqual({
            key: key.name,
            hasWhere: false,
          });
          continue;
        }
        const sql = schema.get(table)?.indexSql.get(key.index);
        expect(sql, `${table}.${key.index}`).toBeDefined();
        for (const column of key.columns) {
          expect(sql).toContain(squash(column));
        }
        if (key.where !== undefined) {
          expect(sql?.endsWith(`WHERE ${squash(key.where)}`)).toBe(true);
        }
      }
    }
  });

  it("declares the natural keys named in the spec", () => {
    const names = (table: string) => registration(table).naturalKeys.map((key) => key.name);
    expect(registration("finance_transactions").naturalKeys[0]?.columns).toEqual([
      "account_id",
      "dedupe_hash",
    ]);
    expect(names("finance_accounts")).toEqual(["external_key"]);
    expect(names("finance_import_profiles")).toEqual(["signature"]);
    expect(registration("finance_category_suggestions").naturalKeys[0]).toMatchObject({
      columns: ["transaction_id"],
      where: "status = 'pending'",
    });
    expect(names("ai_proposals")).toHaveLength(2);
    expect(names("gtd_tasks")).toEqual(["source_external_id"]);
    expect(names("gtd_projects")).toEqual(["source_external_id"]);
    expect(names("gtd_contexts")).toEqual(["name"]);
    expect(names("gtd_task_events")).toEqual(["dedupe_key"]);
  });
});

describe("canonical identity metadata", () => {
  it("resolves every natural key one way", () => {
    for (const entry of TABLE_REGISTRY) {
      for (const key of entry.naturalKeys) {
        expect({ table: entry.table, key: key.name, resolution: key.resolution }).toEqual({
          table: entry.table,
          key: key.name,
          resolution: expect.stringMatching(/^(alias|pending-collision|union-dedupe|name-prompt)$/),
        });
      }
    }
  });

  it("assigns the resolutions of the spec's natural-key table", () => {
    const resolutions = (table: string) =>
      Object.fromEntries(registration(table).naturalKeys.map((key) => [key.name, key.resolution]));
    expect(resolutions("finance_transactions")).toEqual({ account_dedupe_hash: "alias" });
    expect(resolutions("finance_accounts")).toEqual({ external_key: "alias" });
    expect(resolutions("finance_import_profiles")).toEqual({ signature: "alias" });
    expect(resolutions("gtd_tasks")).toEqual({ source_external_id: "alias" });
    expect(resolutions("gtd_projects")).toEqual({ source_external_id: "alias" });
    expect(resolutions("gtd_contexts")).toEqual({ name: "name-prompt" });
    expect(resolutions("gtd_task_events")).toEqual({ dedupe_key: "union-dedupe" });
    expect(resolutions("finance_category_suggestions")).toEqual({
      pending_per_transaction: "pending-collision",
    });
    expect(Object.values(resolutions("ai_proposals"))).toEqual([
      "pending-collision",
      "pending-collision",
    ]);
  });

  it("only aliases bare-column keys of tables with a single-column primary key", () => {
    expect(aliasableTables().sort()).toEqual(
      [
        "finance_accounts",
        "finance_import_profiles",
        "finance_transactions",
        "gtd_projects",
        "gtd_tasks",
      ].sort(),
    );
    for (const table of aliasableTables()) {
      expect(registration(table).primaryKey).toHaveLength(1);
      for (const key of aliasKeysOf(table)) {
        expect(key.columns.every(isBareIdentifier)).toBe(true);
      }
    }
  });

  it("keeps pending keys partial, union keys on union tables and the name prompt on contexts", () => {
    for (const entry of TABLE_REGISTRY) {
      for (const key of entry.naturalKeys) {
        if (key.resolution === "pending-collision") {
          expect(key.where, `${entry.table}.${key.name}`).toBeDefined();
          expect(key.index, `${entry.table}.${key.name}`).toBeDefined();
          expect(entry.mergeClass).toBe("monotonic-status");
        }
        if (key.resolution === "union-dedupe") {
          expect(entry.mergeClass).toBe("grow-only-union");
        }
        if (key.resolution === "name-prompt") {
          expect(entry.table).toBe("gtd_contexts");
        }
      }
    }
  });

  it("splits the aliasable tables by domain, so aliases follow their entity type's bundle", () => {
    expect(aliasableTablesInDomain("gtd").sort()).toEqual(["gtd_projects", "gtd_tasks"]);
    expect(aliasableTablesInDomain("finance").sort()).toEqual([
      "finance_accounts",
      "finance_import_profiles",
      "finance_transactions",
    ]);
    expect(aliasableTablesInDomain("personal")).toEqual([]);
    for (const table of aliasableTables()) {
      expect(isAliasableTable(table)).toBe(true);
      expect(sidecarPublishDomain("sync_id_aliases", table)).toBe(domainOfTable(table));
    }
    expect(isAliasableTable("gtd_contexts")).toBe(false);
    expect(isAliasableTable("not_a_table")).toBe(false);
  });

  it("finds every declared reference to an aliasable table", () => {
    const refs = referencesTo("finance_accounts").map(
      (item) => `${item.table}.${item.reference.column}`,
    );
    expect(refs).toEqual(
      expect.arrayContaining([
        "finance_transactions.account_id",
        "finance_transactions.dedupe_hash",
        "finance_merchant_memory.account_id",
        "finance_account_balance_snapshots.account_id",
        "finance_rules.matcher_json",
      ]),
    );
  });
});

describe("domain and merge-class sanity", () => {
  it("puts exactly the spec's tables in the gtd, personal and finance domains", () => {
    expect(tablesInDomain("gtd").sort()).toEqual(
      [
        "gtd_tasks",
        "gtd_projects",
        "gtd_contexts",
        "gtd_task_events",
        "recurring_task_templates",
        "pomodoro_sessions",
        "pomodoro_segments",
        "sync_recurrence_occurrences",
        "sync_recurrence_clears",
      ].sort(),
    );
    expect(tablesInDomain("personal").sort()).toEqual(
      [
        "daily_entries",
        "weekly_reviews",
        "monthly_reviews",
        "mid_week_decisions",
        "annual_goals",
        "weekly_objectives",
        "weekly_objective_results",
        "ai_messages",
        "ai_proposals",
        "ai_memories",
      ].sort(),
    );
    for (const table of tablesInDomain("finance")) {
      expect(table.startsWith("finance_")).toBe(true);
    }
    // Every finance_* table is either finance domain or the reviewed device-local one.
    const financeNamed = TABLE_REGISTRY.filter((entry) => entry.table.startsWith("finance_"));
    expect(
      financeNamed.filter((entry) => entry.domain !== "finance").map((entry) => entry.table),
    ).toEqual(["finance_alert_notifications"]);
  });

  it("assigns the spec's merge classes", () => {
    expect(registration("pomodoro_sessions").mergeClass).toBe("pomodoro");
    expect(registration("pomodoro_segments").mergeClass).toBe("pomodoro");
    expect(registration("gtd_task_events").mergeClass).toBe("grow-only-union");
    expect(registration("ai_messages").mergeClass).toBe("grow-only-union");
    expect(registration("ai_proposals").mergeClass).toBe("monotonic-status");
    expect(registration("finance_category_suggestions").mergeClass).toBe("monotonic-status");
    expect(registration("finance_transaction_splits").mergeClass).toBe("child-set");
    expect(registration("ai_memories").mergeClass).toBe("row-clock");
    expect(registration("finance_transactions").mergeClass).toBe("row-clock");
    for (const table of [
      "gtd_tasks",
      "gtd_projects",
      "gtd_contexts",
      "recurring_task_templates",
      "daily_entries",
      "weekly_reviews",
      "monthly_reviews",
      "mid_week_decisions",
      "annual_goals",
      "weekly_objectives",
      "weekly_objective_results",
    ]) {
      expect(registration(table).mergeClass).toBe("field-clock");
    }
  });

  it("restricts the row-clock finance tables to the spec's list plus the statement snapshots", () => {
    const rowClockFinance = TABLE_REGISTRY.filter(
      (entry) => entry.domain === "finance" && entry.mergeClass === "row-clock",
    )
      .map((entry) => entry.table)
      .sort();
    expect(rowClockFinance).toEqual(
      [
        "finance_people",
        "finance_accounts",
        "finance_categories",
        "finance_transactions",
        "finance_rules",
        "finance_merchant_memory",
        "finance_budget_entries",
        "finance_budget_months",
        "finance_recurring_series",
        "finance_import_profiles",
        "finance_import_batches",
        "finance_account_balance_snapshots",
      ].sort(),
    );
  });

  it("models partial publication as row filters", () => {
    expect(registration("finance_account_balance_snapshots").rowFilter?.publishWhen).toBe(
      "source = 'statement'",
    );
    expect(registration("pomodoro_sessions").rowFilter?.publishWhen).toBe(
      "status IN ('completed', 'cancelled')",
    );
    // Real SQL over the segment's own columns, built from the session predicate.
    expect(registration("pomodoro_segments").rowFilter?.publishWhen).toBe(
      "session_id IN (SELECT id FROM pomodoro_sessions WHERE status IN ('completed', 'cancelled'))",
    );
    const filtered = TABLE_REGISTRY.filter((entry) => entry.rowFilter).map((entry) => entry.table);
    expect(filtered.sort()).toEqual(
      ["finance_account_balance_snapshots", "pomodoro_segments", "pomodoro_sessions"].sort(),
    );
  });

  it("has no lifecycle-pending table left: the GTD task and template merge by their own rules", () => {
    // The temporary `lifecycleMergePending` flag is gone; its replacement is a strategy rule
    // (merge-strategies.ts), pinned by merge-strategies.test.ts and merge-task.test.ts.
    for (const entry of TABLE_REGISTRY) {
      expect(Object.keys(entry), entry.table).not.toContain("lifecycleMergePending");
    }
    for (const table of ["gtd_tasks", "recurring_task_templates"]) {
      expect(registration(table).domain).toBe("gtd");
      expect(registration(table).mergeClass).toBe("field-clock");
    }
  });

  describe("declared foreign keys (production enforces them)", () => {
    // Every declared foreign key, as the migrated schema reports it. `apply-references.ts` derives
    // its ordering, cascade and orphan rules from the same pragma; this is the guard that a
    // migration adding a key it has no rule for fails here, not on a real database.
    const edges = (): { child: string; column: string; parent: string; onDelete: string }[] =>
      [...schema].flatMap(([child, info]) =>
        info.foreignKeys.map((fk) => ({
          child,
          column: fk.from,
          parent: fk.table,
          onDelete: fk.on_delete.toUpperCase(),
        })),
      );

    it("pins the two declared keys, both ON DELETE CASCADE", () => {
      expect(edges().sort((a, b) => a.child.localeCompare(b.child))).toEqual([
        {
          child: "ai_proposals",
          column: "message_id",
          parent: "ai_messages",
          onDelete: "CASCADE",
        },
        {
          child: "weekly_objective_results",
          column: "objective_id",
          parent: "weekly_objectives",
          onDelete: "CASCADE",
        },
      ]);
    });

    it("has no referencesMergePending flag left: every key is handled by apply-references.ts", () => {
      for (const entry of TABLE_REGISTRY) {
        expect(Object.keys(entry), entry.table).not.toContain("referencesMergePending");
      }
    });

    it("keeps every foreign key inside one domain, between supported tables, with a rule", () => {
      for (const edge of edges()) {
        const child = registration(edge.child);
        const parent = registration(edge.parent);
        // A key across domains would let a bundle of one domain depend on rows of another.
        expect(child.domain, `${edge.child} -> ${edge.parent}`).toBe(parent.domain);
        expect(isTableSyncSupported(edge.child), edge.child).toBe(true);
        expect(isTableSyncSupported(edge.parent), edge.parent).toBe(true);
        // The apply path has one delete rule: tombstone what the cascade removes.
        expect(edge.onDelete, `${edge.child}.${edge.column}`).toBe("CASCADE");
        // Parents are referenced by a single-column primary key (entity id = the value as text).
        expect(parent.primaryKey).toHaveLength(1);
        // The registry documents the key as a foreign-key reference of the child.
        expect(
          child.references.some(
            (reference) =>
              reference.column === edge.column &&
              reference.table === edge.parent &&
              reference.kind === "foreign-key",
          ),
          `${edge.child}.${edge.column} declared`,
        ).toBe(true);
      }
    });

    it("declares as foreign-key references exactly the keys the schema has", () => {
      const declared = TABLE_REGISTRY.flatMap((entry) =>
        entry.references
          .filter((reference) => reference.kind === "foreign-key")
          .map((reference) => `${entry.table}.${reference.column}->${reference.table}`),
      ).sort();
      expect(declared).toEqual(
        edges()
          .map((edge) => `${edge.child}.${edge.column}->${edge.parent}`)
          .sort(),
      );
    });
  });

  it("marks JSON-map and OR-set columns from the spec", () => {
    expect(registration("daily_entries").jsonMapColumns).toEqual([
      "metrics_json",
      "principles_json",
    ]);
    expect(registration("weekly_reviews").jsonMapColumns).toEqual(["notes_json"]);
    expect(registration("monthly_reviews").jsonMapColumns).toEqual(["notes_json"]);
    expect(registration("annual_goals").jsonMapColumns).toEqual([
      "evaluations_json",
      "progress_log_json",
      "milestones_json",
    ]);
    for (const table of ["gtd_tasks", "gtd_projects", "recurring_task_templates"]) {
      expect(registration(table).orSetColumns).toEqual(["context_ids_json"]);
    }
  });

  it("never lists device-local tables as synced", () => {
    const synced = new Set(syncedTables());
    for (const table of [
      "schema_migrations",
      "app_settings",
      "rescuetime_snapshot_cache",
      "finance_alert_notifications",
      "calendar_sync_settings",
      "calendar_sync_links",
      "sync_identity",
      "sync_peers",
      "sync_dirty",
      "sync_entity_snapshot",
      "sync_capture_state",
      "sync_backfill_state",
    ]) {
      expect(domainOfTable(table)).toBe("device");
      expect(synced.has(table)).toBe(false);
    }
    for (const table of schema.keys()) {
      if (table.startsWith("email_triage_")) {
        expect(domainOfTable(table)).toBe("device");
        expect(synced.has(table)).toBe(false);
      }
    }
    for (const domain of SYNC_DOMAINS) {
      for (const table of tablesInDomain(domain)) expect(synced.has(table)).toBe(true);
    }
    expect(synced.size).toBe(TABLE_REGISTRY.filter((entry) => entry.domain !== "device").length);
  });
});

describe("publish guards", () => {
  it("lets a table be published only in its own domain", () => {
    for (const domain of SYNC_DOMAINS) {
      for (const table of tablesInDomain(domain)) {
        expect(() => assertTablePublishable(table, domain)).not.toThrow();
        expect(isTablePublishable(table, domain)).toBe(true);
        for (const other of SYNC_DOMAINS.filter((candidate) => candidate !== domain)) {
          expect(() => assertTablePublishable(table, other)).toThrow(/cannot be published/);
          expect(isTablePublishable(table, other)).toBe(false);
        }
      }
    }
  });

  it("rejects cross-domain publishing of the privacy-critical cases", () => {
    expect(() => assertTablePublishable("daily_entries", "gtd")).toThrow();
    expect(() => assertTablePublishable("finance_transactions", "gtd")).toThrow();
    expect(() => assertTablePublishable("ai_proposals", "gtd")).toThrow();
    expect(() => assertTablePublishable("gtd_tasks", "personal")).toThrow();
  });

  it("keeps personal and finance data out of every work-profile domain", () => {
    expect(WORK_PROFILE_DOMAINS).toEqual(["gtd"]);
    for (const workDomain of WORK_PROFILE_DOMAINS) {
      for (const table of [...tablesInDomain("personal"), ...tablesInDomain("finance")]) {
        expect(isTablePublishable(table, workDomain)).toBe(false);
        expect(() => assertTablePublishable(table, workDomain)).toThrow();
      }
      for (const key of settingKeys()) {
        if (settingScope(key) === "personal" || settingScope(key) === "finance") {
          expect(isSettingPublishable(key, workDomain)).toBe(false);
        }
      }
    }
  });

  it("never publishes device-local tables, in any domain", () => {
    for (const table of tablesInDomain("device")) {
      for (const domain of SYNC_DOMAINS) {
        expect(() => assertTablePublishable(table, domain)).toThrow(/device-local/);
        expect(isTablePublishable(table, domain)).toBe(false);
      }
    }
  });

  it("refuses unclassified tables instead of letting them through", () => {
    expect(() => assertTablePublishable("sync_not_a_table", "gtd")).toThrow(/not classified/);
    expect(() => domainOfTable("nope")).toThrow(/not classified/);
    expect(isTablePublishable("nope", "gtd")).toBe(false);
  });
});

describe("sidecar tables", () => {
  const entityTyped = ["sync_conflicts", "sync_entity_meta", "sync_id_aliases"];
  const recurrence = ["sync_recurrence_clears", "sync_recurrence_occurrences"];
  const captureBookkeeping = [
    "sync_backfill_state",
    "sync_capture_state",
    "sync_dirty",
    "sync_entity_snapshot",
  ];

  it("classifies the change-capture bookkeeping as device-local, never published", () => {
    for (const table of captureBookkeeping) {
      expect(domainOfTable(table)).toBe("device");
      expect(registration(table).mergeClass).toBe("device-local");
      for (const domain of SYNC_DOMAINS) {
        expect(isTablePublishable(table, domain)).toBe(false);
        expect(isSidecarPublishable(table, domain, "gtd_tasks")).toBe(false);
      }
      expect(() => publishDomainOfEntityType(table)).toThrow(/device-local/);
    }
  });

  it("classifies every sync_* table", () => {
    const syncTables = [...schema.keys()].filter((table) => table.startsWith("sync_")).sort();
    expect(syncTables).toEqual(
      [...entityTyped, ...recurrence, "sync_identity", "sync_peers", ...captureBookkeeping].sort(),
    );
    expect(domainOfTable("sync_identity")).toBe("device");
    expect(domainOfTable("sync_peers")).toBe("device");
    expect(registration("sync_identity").mergeClass).toBe("device-local");
    expect(registration("sync_peers").mergeClass).toBe("device-local");
  });

  it("gives exactly the sidecars the sidecar merge class", () => {
    const sidecars = TABLE_REGISTRY.filter((entry) => entry.mergeClass === "sidecar")
      .map((entry) => entry.table)
      .sort();
    expect(sidecars).toEqual([...entityTyped, ...recurrence].sort());
  });

  it("routes the recurrence sidecars to gtd and the entity-typed ones by entity type", () => {
    for (const table of recurrence) expect(domainOfTable(table)).toBe("gtd");
    for (const table of entityTyped) {
      expect(domainOfTable(table)).toBe(BY_ENTITY_TYPE_DOMAIN);
      expect(isEntityTypedSidecar(table)).toBe(true);
      expect(registration(table).entityTypeColumn).toBe("entity_type");
      expect(schema.get(table)?.columns.map((column) => column.name)).toContain("entity_type");
    }
    expect(isEntityTypedSidecar("gtd_tasks")).toBe(false);
    expect(isEntityTypedSidecar("sync_recurrence_clears")).toBe(false);
    // Only the by-entity-type sidecars declare an entity type column.
    expect(
      TABLE_REGISTRY.filter((entry) => entry.entityTypeColumn !== undefined)
        .map((entry) => entry.table)
        .sort(),
    ).toEqual([...entityTyped].sort());
  });

  it("never lets a by-entity-type sidecar through the plain table guards, in any domain", () => {
    for (const table of entityTyped) {
      for (const domain of SYNC_DOMAINS) {
        expect(isTablePublishable(table, domain)).toBe(false);
        expect(() => assertTablePublishable(table, domain)).toThrow(/per entity type/);
      }
    }
  });

  it("keeps device-local sync tables out of every bundle, including the sidecar guards", () => {
    for (const table of ["sync_identity", "sync_peers"]) {
      for (const domain of SYNC_DOMAINS) {
        expect(isTablePublishable(table, domain)).toBe(false);
        expect(isSidecarPublishable(table, domain, "gtd_tasks")).toBe(false);
      }
      expect(() => sidecarPublishDomain(table, "gtd_tasks")).toThrow(/not a sync sidecar/);
    }
  });

  it("maps a sidecar row to the domain of its entity type", () => {
    for (const table of entityTyped) {
      for (const entry of TABLE_REGISTRY) {
        if (entry.domain === "device" || entry.mergeClass === "sidecar") continue;
        expect(sidecarPublishDomain(table, entry.table)).toBe(entry.domain);
      }
    }
    expect(sidecarPublishDomain("sync_entity_meta", "gtd_tasks")).toBe("gtd");
    expect(sidecarPublishDomain("sync_entity_meta", "daily_entries")).toBe("personal");
    expect(sidecarPublishDomain("sync_id_aliases", "finance_accounts")).toBe("finance");
    expect(sidecarPublishDomain("sync_conflicts", "ai_proposals")).toBe("personal");
    // Recurrence sidecars are gtd whatever the arguments.
    expect(sidecarPublishDomain("sync_recurrence_occurrences")).toBe("gtd");
    expect(sidecarPublishDomain("sync_recurrence_clears", "daily_entries")).toBe("gtd");
  });

  it("routes setting rows by the setting's scope and refuses device-scope keys and secrets", () => {
    expect(sidecarPublishDomain("sync_entity_meta", SETTING_ENTITY_TYPE, "language")).toBe("gtd");
    expect(sidecarPublishDomain("sync_entity_meta", SETTING_ENTITY_TYPE, "aiEnabled")).toBe(
      "personal",
    );
    expect(sidecarPublishDomain("sync_entity_meta", SETTING_ENTITY_TYPE, "financeEnabled")).toBe(
      "finance",
    );
    expect(() => sidecarPublishDomain("sync_entity_meta", SETTING_ENTITY_TYPE)).toThrow(
      /settings key/,
    );
    expect(() => sidecarPublishDomain("sync_entity_meta", SETTING_ENTITY_TYPE, "aiApiKey")).toThrow(
      /device-local/,
    );
    expect(() =>
      sidecarPublishDomain("sync_entity_meta", SETTING_ENTITY_TYPE, "storageMode"),
    ).toThrow(/device-local/);
    expect(() => sidecarPublishDomain("sync_entity_meta", SETTING_ENTITY_TYPE, "nope")).toThrow(
      /not classified/,
    );
    for (const key of settingKeys()) {
      const scope = settingScope(key);
      for (const domain of SYNC_DOMAINS) {
        expect(isSidecarPublishable("sync_entity_meta", domain, SETTING_ENTITY_TYPE, key)).toBe(
          scope === domain && !isSecretSetting(key),
        );
      }
    }
  });

  it("refuses entity types that are device-local, sidecar, unknown or missing", () => {
    for (const table of ["sync_entity_meta", "sync_id_aliases", "sync_conflicts"]) {
      expect(() => sidecarPublishDomain(table, "app_settings")).toThrow(/device-local/);
      expect(() => sidecarPublishDomain(table, "calendar_sync_links")).toThrow(/device-local/);
      expect(() => sidecarPublishDomain(table, "sync_peers")).toThrow(/device-local/);
      expect(() => sidecarPublishDomain(table, "sync_entity_meta")).toThrow(/not an entity type/);
      expect(() => sidecarPublishDomain(table, "sync_recurrence_clears")).toThrow(
        /not an entity type/,
      );
      expect(() => sidecarPublishDomain(table, "no_such_table")).toThrow(/not classified/);
      expect(() => sidecarPublishDomain(table)).toThrow(/needs an entity type/);
      expect(() => sidecarPublishDomain(table, "")).toThrow(/not classified/);
      expect(() => publishDomainOfEntityType("toString")).toThrow(/not classified/);
    }
    expect(() => sidecarPublishDomain("gtd_tasks", "gtd_tasks")).toThrow(/not a sync sidecar/);
    expect(() => sidecarPublishDomain("nope", "gtd_tasks")).toThrow(/not classified/);
  });

  it("can never place a personal or finance entity's sidecar row in a gtd bundle", () => {
    for (const table of entityTyped) {
      for (const entry of TABLE_REGISTRY) {
        const owner = entry.domain;
        if (owner !== "personal" && owner !== "finance") continue;
        for (const workDomain of WORK_PROFILE_DOMAINS) {
          expect(isSidecarPublishable(table, workDomain, entry.table)).toBe(false);
          expect(() => assertSidecarPublishable(table, workDomain, entry.table)).toThrow(
            /cannot be published/,
          );
        }
        expect(() => assertSidecarPublishable(table, owner, entry.table)).not.toThrow();
      }
      for (const key of settingKeys()) {
        const scope = settingScope(key);
        if (scope === "personal" || scope === "finance") {
          expect(isSidecarPublishable(table, "gtd", SETTING_ENTITY_TYPE, key)).toBe(false);
        }
      }
    }
    // The same holds for the gtd direction: a gtd entity's row never lands in a personal bundle.
    expect(isSidecarPublishable("sync_entity_meta", "personal", "gtd_tasks")).toBe(false);
  });

  it("publishes a recurrence sidecar only in the gtd bundle", () => {
    for (const table of recurrence) {
      expect(isSidecarPublishable(table, "gtd")).toBe(true);
      expect(isTablePublishable(table, "gtd")).toBe(true);
      expect(isSidecarPublishable(table, "personal")).toBe(false);
      expect(isSidecarPublishable(table, "finance")).toBe(false);
    }
  });

  it("matches the migrated schema for the recurrence sidecars' keys", () => {
    expect(registration("sync_recurrence_occurrences").primaryKey).toEqual([
      "template_id",
      "due_date",
    ]);
    expect(registration("sync_recurrence_clears").primaryKey).toEqual(["template_id"]);
  });
});

describe("settings registry", () => {
  it("classifies exactly the keys of AppSettings (runtime check against the default settings)", () => {
    expect(settingKeys().sort()).toEqual(Object.keys(defaultAppSettings()).sort());
  });

  it("gives device-scope keys the device merge and synced keys a real merge rule", () => {
    for (const key of settingKeys()) {
      const rule = SETTINGS_REGISTRY[key];
      expect({ key, deviceMerge: rule.merge === "device" }).toEqual({
        key,
        deviceMerge: rule.scope === "device",
      });
    }
  });

  it("keeps the audited secrets device-scoped and out of every bundle", () => {
    const secrets = settingKeys()
      .filter((key) => isSecretSetting(key))
      .sort();
    expect(secrets).toEqual(["aiApiKey", "llmBridgeToken", "rescuetimeApiKey"]);
    for (const key of secrets) {
      expect(settingScope(key)).toBe("device");
      for (const domain of SYNC_DOMAINS) {
        expect(isSettingPublishable(key, domain)).toBe(false);
        expect(() => assertSettingPublishable(key, domain)).toThrow(/secret/);
      }
    }
    // Name audit: anything that looks like a credential must be a flagged secret.
    const credentialLooking = settingKeys().filter((key) =>
      /(key|token|secret|password|credential)$/i.test(key),
    );
    expect(credentialLooking.sort()).toEqual(secrets);
  });

  it("keeps the gtd scope to the reviewed allowlist", () => {
    expect(settingsKeysInScope("gtd").sort()).toEqual(
      [
        "gtdImportDoneAt",
        "gtdRecurringCollapseDoneAt",
        "gtdReferencesMigrationDoneAt",
        "gtdScheduledNormalizationDoneAt",
        "language",
      ].sort(),
    );
    for (const key of [
      "gtdImportDoneAt",
      "gtdReferencesMigrationDoneAt",
      "gtdScheduledNormalizationDoneAt",
      "gtdRecurringCollapseDoneAt",
    ] as const) {
      expect(SETTINGS_REGISTRY[key].merge).toBe("non-empty-wins");
    }
  });

  it("keeps the device scope to the reviewed list", () => {
    expect(settingsKeysInScope("device").sort()).toEqual(
      [
        "aiApiKey",
        "aiBaseUrl",
        "aiPulseFirstOpenAt",
        "autoBackupEnabled",
        "autoBackupIntervalHours",
        "backupDestinationDir",
        "lastBackupAt",
        "lastBackupPath",
        "launchAtLogin",
        "llmBridgeEnabled",
        "llmBridgePort",
        "llmBridgeToken",
        "rescuetimeApiKey",
        "runInTray",
        "storageMode",
        "multiDeviceSyncEnabled",
        "syncDeviceName",
        "syncGtdFolderDir",
        "syncProfile",
      ].sort(),
    );
  });

  it("puts every finance key, and only finance keys, in the finance scope", () => {
    const financeNamed = settingKeys().filter((key) => key.startsWith("finance"));
    expect(financeNamed.length).toBeGreaterThan(0);
    expect(settingsKeysInScope("finance").sort()).toEqual(financeNamed.sort());
  });

  it("uses monotonic max for dates that only move forward and non-empty-wins for markers", () => {
    expect(
      settingKeys()
        .filter((key) => SETTINGS_REGISTRY[key].merge === "monotonic-max")
        .sort(),
    ).toEqual(
      [
        "previousDayReviewDoneDate",
        "relationshipDrawChildrenProcessedDate",
        "relationshipDrawSpouseProcessedDate",
      ].sort(),
    );
    expect(
      settingKeys()
        .filter((key) => SETTINGS_REGISTRY[key].merge === "non-empty-wins")
        .sort(),
    ).toEqual(
      [
        "aiMaxTokensUpgradeDoneAt",
        "dimancheNotesRelocatedAt",
        "financeCategoriesSeededAt",
        "gtdImportDoneAt",
        "gtdRecurringCollapseDoneAt",
        "gtdReferencesMigrationDoneAt",
        "gtdScheduledNormalizationDoneAt",
      ].sort(),
    );
  });

  it("only publishes a synced key in its own domain", () => {
    for (const key of settingKeys()) {
      const scope = settingScope(key);
      for (const domain of SYNC_DOMAINS) {
        expect(isSettingPublishable(key, domain)).toBe(scope === domain);
      }
    }
    expect(() => assertSettingPublishable("aiEnabled", "gtd")).toThrow(/cannot be published/);
    expect(() => assertSettingPublishable("language", "personal")).toThrow(/cannot be published/);
    expect(() => assertSettingPublishable("language", "gtd")).not.toThrow();
    expect(() => assertSettingPublishable("storageMode", "gtd")).toThrow(/device-local/);
  });

  it("rejects unknown keys instead of letting them through", () => {
    expect(() => settingScope("notAKey")).toThrow(/not classified/);
    expect(() => assertSettingPublishable("notAKey", "gtd")).toThrow(/not classified/);
    expect(isSettingPublishable("notAKey", "gtd")).toBe(false);
    expect(() => settingScope("toString")).toThrow(/not classified/);
  });
});
